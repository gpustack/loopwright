# Spec: Persistent state and bounded admission

Status: Shipped
Type: Feature

## Summary

Add a local persistent state package for admitted task runs, request budgets, operation journals, and recovery records.
A restarted host process must retain the same run identity, deadline, spent budget, and uncertain operations.
Concurrent callers must not overspend a shared allowance or mutate a run with a stale ownership token.
This package supplies storage and admission primitives for a later controller and adapter. It does not execute agents or external effects.

## Motivation

### Goals

- Give the task host one authoritative local record for each admitted run.
- Preserve reservations and unresolved outcomes across process exits and reopen operations.
- Make model-call admission atomic with shared counters, request identity, and current ownership.
- Record intent before a host may initiate an operation, and bind receipts to that exact intent.
- Separate durable facts, unknown outcomes, and instructions that a future executor may perform.
- Prove supported local process-crash and contention behavior with real storage and independent processes.

### Non-Goals

- Execute Pi, tools, task graphs, shell validators, publishers, or external reconciliation queries.
- Implement the full controller lifecycle, CLI, GitHub App, taskpacks, or memory curator.
- Deploy a remote RunStore, object store, wake service, or cross-host coordination system.
- Recover from loss of the authoritative store or prove host power-loss/filesystem durability on untested storage.
- Provide OS containment, stop an old process, or fence an external service that does not check authority.
- Adopt pi-durable, add CI/CD workflows, publish a package, or make live model calls.
- Change the merged core contract vocabulary or weaken its evidence rules.

## Proposal

Provide a private TypeScript storage boundary that consumes validated core TaskLock values and persists versioned state.
Run creation, reopening, request admission, settlement, ownership changes, operation receipts, and checkpoints have explicit contracts.
The same run keeps its original immutable identity and finite deadline. Reopening does not create a fresh allowance.
Every mutating operation must be atomic and reject stale authority or incompatible identity.
Uncertain requests retain a conservative charge and uncertain effects require reconciliation before dependent work continues.
The caller remains responsible for authentication, actual provider execution, and external receipt verification.

### User Stories

#### Story 1
As a controller developer, I want to reopen an admitted run after a process crash, so that its budget and pending work do not reset.

#### Story 2
As an operator, I want parallel workers to share one admission ledger, so that each worker cannot spend the entire parent allowance.

#### Story 3
As an adapter developer, I want a durable request record before provider dispatch, so that an interrupted response remains accountable.

#### Story 4
As a publisher developer, I want stable operation identities and receipt checks, so that an unknown result cannot trigger blind replay.

#### Story 5
As a maintainer, I want explicit storage and recovery limits, so that local crash tests are not presented as remote recovery qualification.

### Core Features & Acceptance Criteria

#### A01: Versioned local RunStore and immutable admission identity

- Add a private package that reuses the public core boundary for TaskLock and usage values.
- Explicitly create a new store/run or reopen an existing store/run. Reopen must never silently initialize missing data.
- Persist the admitted lock identity, original start/deadline, storage format version, and relevant host/adapter compatibility identity.
- Reusing a run ID with different lock or policy bytes fails. An identical creation retry is idempotent and does not reset state.
- A run's additional storage/admission policy is versioned and frozen with its identity. It cannot silently replace core budget limits.
- Reject unknown format versions, incompatible bindings, corrupt records, and missing authoritative state without resetting balances.
- Document supported local filesystem/database assumptions and actual transaction/durability settings.
- Only successful committed mutations may be acknowledged as durable. A failed or ambiguous commit must not return permission to dispatch.
- Choose and justify the transactional backend in the implementation plan. An in-memory implementation alone cannot satisfy this spec.

#### A02: Atomic ownership and stale-writer rejection

- Define explicit owner identity, a monotonic fencing generation, and a compare-and-swap revision or equivalent transactional guard.
- Claim, renew, release, and takeover operations must state their preconditions and expiry behavior.
- Two independent processes competing for the same run cannot both acquire current write authority.
- Every mutation, including request settlement, operation receipts and checkpoint writes, checks the current generation transactionally.
- A stale handle fails even when the original process remains alive and can still call the API.
- Reopening or replacing an owner must not erase pending requests, operations, deadline, or accounted usage.
- Ownership expiry is not proof that a provider request or external process stopped. Preserve associated uncertainty.
- State clearly that these guards fence this store only. Future adapters and external sinks must enforce their own dispatch/write boundary.
- Define the trusted clock source and behavior on rollback/discontinuity; do not extend a deadline or revive expired authority silently.
- Bound lock contention and report a stable retryable result instead of an unbounded wait loop.

#### A03: Shared request admission and budget accounting

- Use the TaskLock's finite total-token, per-call output, model-call, concurrency, repair and transport retry limits.
- Every provider request attempt needs a stable request identity and an atomic admission record before dispatch authorization.
- Count retries, format repairs, implementation repairs, judge/reviewer calls, compaction and child-role calls against the same run allowance.
- Record the applicable purpose/counter without allowing a purpose label to create a fresh parent budget.
- Independent zero repair/retry caps disable that class. Each child limit and the shared parent are enforced together.
- Reserve a caller-supplied conservative total-token upper bound before authorizing hard admission; retain separate input/output bounds as needed.
- Hard admission requires an explicit caller capability declaration sufficient for the requested bounds. Reject unsupported or unknown capability.
- This is a trusted-host declaration, not proof of provider-internal accounting or enforcement.
- Preserve reported, estimated and unknown usage/cost provenance. Do not convert unknown prices or usage to zero.
- If a cost cap is supported, it must be an explicit frozen policy with conservative reservation. Unknown price cannot satisfy a hard cost cap.
- Admission across processes must serialize the check and charge. Remaining allowance cannot be independently oversubscribed.
- Identical admission retries return the existing state without charging twice; conflicting reuse of a request ID fails.
- Distinguish a newly granted dispatch from an idempotent lookup. Reopening an already dispatched request never grants another dispatch.
- The implementation plan must freeze the transitions between reserved, dispatch-authorized, observed and unresolved states.
- Preserve safe-integer arithmetic and reject overflow before committing any partial change.

#### A04: Idempotent settlement with conservative unknowns

- Bind settlement to the same run, request, ownership and admitted identity. No unrelated receipt may release a reservation.
- Repeated identical settlement is idempotent. Conflicting settlement is an explicit error, not last-writer-wins replacement.
- A known terminal usage receipt replaces its reservation exactly once under the documented policy.
- If actual usage exceeds the reservation, retain the actual observation, block further unsafe admission, and surface the bound violation.
  Do not clamp the observation, hide overage, or acknowledge an uncommitted update.
- Missing usage, timeout, cancellation intent, connection loss and owner expiry do not prove non-execution or zero cost.
- Persist unresolved charges across reopen and takeover. Do not release unknown outstanding concurrency merely because a local handle disappeared.
- Distinguish known usage from known request termination: a stopped request with unknown usage can remain charged without occupying a live slot.
- Release a never-dispatched reservation only through a guarded transition that cannot race dispatch authorization.
- A trusted reconciliation update may resolve uncertainty only with bound evidence and explicit transition rules.
- Run inspection shows settled, reserved/unresolved, remaining and any exceeded/blocked state without hiding partial totals.
- Missing-request discovery and provider normalization remain adapter obligations; the ledger must not claim completeness it cannot establish.

#### A05: Intent and receipt journal

- Persist an operation intent with run/node/attempt/operation identity, effect classification, request digest and relevant target identity before a caller can act.
- Treat a request digest as identity, not producer authentication. Trusted callers authenticate external receipts before recording them.
- Identical intent submission is idempotent; reusing an identity for another request or target fails.
- Define explicit intent, dispatch uncertainty, confirmed outcome and reconciliation transitions.
- A receipt binds to the exact operation and generation under the current-owner/reconciliation policy.
- Duplicate matching receipts are idempotent. Conflicting or stale receipts must not silently alter a settled outcome.
- Crash after possible external effect but before receipt leaves an unresolved operation. Never label it confirmed failed or safe to replay.
- Reopening may expose read-only recovery facts; it must not automatically execute or replay any operation.
- A new owner can reconcile an old operation through an explicit guarded operation; merely supplying an old owner token is insufficient.
- Persist ledger and operation changes that represent one admission in the same transaction, or define an equivalent protocol without an unsafe gap.
- The future controller owns policy for retrying read-only operations and for external deduplication. This package cannot prove external exactly-once execution.

#### A06: Bounded checkpoints and local recovery

- A checkpoint binds the run/lock, store generation/revision, source/base/candidate identity, adapter/resource versions and artifact references needed to resume.
- Checkpoints include or consistently reference the authoritative budget and unresolved-operation state. A conversation pointer alone is insufficient.
- Record references and digests for workspace bundles/diffs and optional private session state; do not implement their capture, upload or restoration here.
- Checkpoint publication must expose one committed consistent view. Reject stale writes and changed compatibility identities.
- Reopen the same authoritative local store after process termination and preserve all committed admissions, deadlines, journal entries and reservations.
- Never resume an old checkpoint by resetting the live ledger to its historical balances.
- Missing or corrupt store, missing required checkpoint reference, or incompatible version produces an explicit blocked/reconciliation result.
- Define storage closure and resource cleanup. Reads and returned objects must not allow mutation of persistent state by alias.
- Bound record sizes, collection counts and inspection/page sizes. Reject oversized requests before expensive serialization or persistence.
- Set a finite per-run journal/request limit or retention policy that never prunes live uncertainty. Do not silently discard charges at the limit.
- No remote host-loss continuation, checkpoint import into a new authority, or automatic schema migration is qualified by S02.

#### A07: Real local failure and contention evidence

- Preserve the existing core test suite and exercise the new package through its public boundary.
- Use real on-disk storage for reopen, transaction rollback, corruption/version rejection and contention acceptance.
- Use independent child processes with deterministic IPC barriers for competing owners and competing reservations.
- Prove the last available call/token/concurrency slot cannot be granted twice under a measured contention attempt.
- Keep an old process alive after takeover and show its store mutation fails with the stale generation.
- Terminate an owned child at recorded transaction/dispatch boundaries and reopen the same store in another process.
- Cover crash before commit, after committed reservation, after dispatch marker, after simulated effect but before receipt, and after settlement.
- A local effect marker fixture may demonstrate the unknown-effect window, but is not a production external-service or exactly-once proof.
- Preserve a behavioral RED regression or bounded mutation of the real admission/ownership path, then restore and measure GREEN.
- Verify restart does not reset elapsed wall budget or admitted call counts, release unknown reservations, or replay effects.
- Collect commands, environment, exit codes, process termination receipts, database/revision identities and measured assertions.
- Fake clocks and fake stores may cover deterministic unit boundaries but cannot replace the independent-process storage cases.
- Keep process/storage failures distinct from a genuinely exhausted budget, invalid request or stale owner.

### Notes / Constraints / Caveats

- Build on the existing private ESM TypeScript workspace and strict compiler configuration, with Node 26 and npm 11.
- The core package remains pure and compatible. Add storage capability in a separate package; do not change its closed alpha records casually.
- Exact storage engine/version, transaction policy, method signatures and error taxonomy belong in the approved implementation plan.
- Prefer a small transactional dependency surface; justify any native dependency, new runtime requirement or database migration burden.
- A prior local experiment with another agent runtime allowed duplicate writable owners and lost final usage after interruption.
  Those observations motivate the acceptance cases; they are not evidence that this package already provides recovery.
- No deployed remote store or wake service is available for qualification. Remote host-loss claims remain blocked pending separate work and resources.
- Process-crash recovery on a retained local store does not establish power-loss or complete-machine-loss recovery.
- The trusted host chooses authentic locks, bounds, receipts, times and policy. A same-process TypeScript API cannot authenticate a hostile caller.

### Boundaries

- **Always:** Preserve identity, deadline, budget and uncertainty; use transactionally checked ownership for every mutation.
- **Always:** Report known, unknown and unsupported outcomes separately; keep evidence at its measured level.
- **Ask first:** Changes to core stored schemas, weaker ownership/accounting guarantees, remote deployment or unbounded retention.
- **Never:** Reset a run on reopen, free unknown charges by timeout alone, replay uncertain effects, publish or add CI/CD configuration.

### Risks and Mitigations

- Separate check/write races → admission and ownership checks share an atomic persistence boundary.
- Crash between provider dispatch and receipt → persist authorization first and preserve unknown charge on reopen.
- Lease expiry mistaken for process death → reject stale store writes while retaining unsettled work for reconciliation.
- Caller retry spends or executes twice → bind idempotency to exact identity and distinguish lookup from a new dispatch grant.
- Local database mistaken for remote durable authority → expose a named local capability boundary and refuse unsupported recovery.
- Corrupt or missing state treated as new → explicit create/reopen APIs with fail-closed recovery.
- Clock rollback adds budget → persistent deadline and defined discontinuity behavior; tests with deterministic clock controls.
- Checkpoint restores stale balances → checkpoint never supersedes the current authoritative ledger.
- Growth becomes unbounded → fixed admission/record/page limits and no pruning of unresolved authority.

## Design Details

### Commands and environment

Use the approved local macOS arm64 environment, Node v26.13.0, npm 11.20.0 and SQLite 3.54.1.
All dependency installs and checks run in this repository worktree.
No credentials, live models, remote resources, Docker, native addons or CI/CD are required.
The root and focused commands, cleanup rules and evidence boundaries are defined below.

### Project Structure

- `packages/core/`: existing public core API; preserve all bytes, schema and behavior.
- `packages/state/src/`: local store, closed boundary, ownership, ledger, journal and checkpoint behavior.
- `packages/state/test/`: public API tests, real SQLite, private clock fixtures and owned process cases.
- `docs/state.md`: supported authority, accounting and recovery profile.
- Root workspace/config/lockfile: include state and preserve core acceptance.

### Code Style

Use strict ESM TypeScript, named exports, readonly public records and stable result/error unions.
Do not expose SQL handles, test observers, global switches or fake-store selection in the public package.
Keep private clock/transaction observers constructor-injected for real-path tests.

### Backend, support profile and maintenance

- Use the documented compatibility export `DatabaseSync` from `node:sqlite`, imported locally as `Database`.
- Current pinned @types/node 26.6.6 declares DatabaseSync and its required controls, but does not declare the renamed Database export.
- Runtime measurement confirms DatabaseSync === Database. This uses the same locally qualified Node v26.13.0 / SQLite 3.54.1 engine.
- State package engines metadata pins Node 26.13.0. Runtime allowlist is exactly darwin/arm64, Node v26.13.0, SQLite 3.54.1 and the required API features.
- Do not infer portable cross-process hrtime comparability from Node's arbitrary-origin clock documentation.
  The current local profile and trusted same-boot clockEpoch are explicit support assumptions. Other platforms/versions require new qualification.
- Reject an unqualified engine with RUNTIME_UNSUPPORTED. Changing this allowlist requires storage and subprocess requalification.
- Keep the existing exactly pinned TypeScript, ESLint and Node type tooling.
- Accept the documented deprecated alias until a separately reviewed tooling update supplies the renamed public declaration.
  This is a small maintenance debt, with no new third-party runtime or type dependency.
- Add private package `@loopwright/state` at version 0.0.0, with only workspace dependency `@loopwright/core: 0.0.0`.
- No SQLite npm binding, node-gyp, compiler toolchain, daemon or global installation is needed.
- SQLite security and behavior updates now follow Node upgrades. The maintainer must retest this supported pair before expanding it.
- Each store is a private directory containing one `state.sqlite` and its SQLite rollback journal when present.
- One store holds one run, its shared parent ledger and all its child-role attempts. This bounds scans and isolates storage capacity.
- Different store directories do not coordinate one parent allowance. The trusted host selects and pins the single authoritative path/storeId.
  Never treat a database copy as a second authority for the same admitted run.
- Support a retained local filesystem on the same host and boot, with working SQLite file locks, directory operations and sync calls.
- Require a trusted directory without concurrent unlink, replacement, copy restore, external writers or symlink substitution.
- Do not qualify network filesystems, concurrent copied authorities, reboot, power loss, filesystem rollback or host loss.
- The host must retain the expected store ID, lock, policy and compatibility binding outside accidental path selection.
  Losing those anchors is not permission to initialize a replacement authority.
- No automatic migration, checkpoint import, compaction, deletion, backup copying, ATTACH, SQL extension loading or remote backend is exposed.

Connection configuration:

```text
page_size=4096                         create only; verify on reopen
journal_mode=DELETE                    create only; require existing DELETE on reopen
synchronous=EXTRA (3)
fullfsync=ON                           macOS F_FULLFSYNC request, not tested power-loss proof
checkpoint_fullfsync=ON
locking_mode=NORMAL
foreign_keys=ON
busy_timeout=250                       no internal retry loop
trusted_schema=OFF
cache_size=-2048
mmap_size=0
max_page_count=65536                    256 MiB main-database ceiling
Database options: timeout=250, defensive=true, allowExtension=false,
                  enableForeignKeyConstraints=true, enableDoubleQuotedStringLiterals=false
SQLite limits: length=2097152, sqlLength=65536, attach=0
```

Read settings back on every open. Fail instead of silently accepting a different profile.
SQLite owns the rollback journal; never delete it to bypass recovery.
DELETE mode avoids WAL reader/checkpoint growth and needs no WAL maintenance service.
Its cost is that readers can delay commit and all writers serialize. Keep reads and writes short and bounded.
Validate exact schema plus PRAGMA quick_check(1) on open; read all bounded records inside a single snapshot for ledger verification.
Return STORE_BUSY after the configured engine wait; callers may retry with the same immutable request identity.
No production transaction waits for a provider, filesystem artifact capture, IPC reply, user callback or network operation.
Private crash fixtures may park at a constructor-injected boundary solely to let their parent kill the child.

Official sources, consulted 2026-11-05:

- [Node SQLite](https://nodejs.org/api/sqlite.html): current page identifies v26.13.0, synchronous Database API, constructor controls and SQLite limits.
- [SQLite transaction control](https://www.sqlite.org/lang_transaction.html): BEGIN IMMEDIATE takes the write transaction before reads; a competing writer can return BUSY.
- [SQLite PRAGMAs](https://www.sqlite.org/pragma.html): EXTRA adds a directory sync after DELETE journal removal; max_page_count bounds database pages.
- [SQLite atomic commit](https://www.sqlite.org/atomiccommit.html): rollback journals protect pre-commit state and support recovery after application failure.
- [SQLite limits](https://www.sqlite.org/limits.html): SQLite supports application-selected runtime limits.
- [SQLite WAL](https://www.sqlite.org/wal.html): WAL adds sidecars and checkpoint management; it is a rejected alternative for this small local profile.
- [Node process clocks](https://nodejs.org/api/process.html#processhrtimebigint): high-resolution monotonic intervals are independent of civil time.

### Schema and immutable identity

Use SQLite STRICT tables and bound SQL parameters. SQL text is static.
Set application_id to 1280791363 and user_version to 1.
Require the exact schema fingerprint; reject unknown tables, columns, indexes, missing singletons or unsupported versions.

| Table | Key and content |
| --- | --- |
| store_meta | Singleton: formatVersion 1, storeId, engine/profile identity and schema digest. |
| run | Singleton: runId, full validated TaskLock, immutable identity digest, full frozen policy/binding, original civil start/deadline, immutable creation clock basis/monotonic task deadline, revision, generation, owner identity/nonce/mode/monotonic grant/expiry, latest committed clock sample, counters, exact ledger totals, sticky violations and ledger root. |
| requests | requestId primary key, unique insertion sequence, immutable admission body/digest, linked operationId unique, admission generation, lifecycle state, dispatch generation/ID/revision, held-slot flag, charged amount, initial observation and optional definitive reconciliation. |
| operations | operationId primary key, unique insertion sequence, immutable intent/digest, optional linked requestId unique, intent generation, dispatch generation/ID/revision, lifecycle state, initial receipt and optional definitive reconciliation. |
| checkpoints | checkpointId primary key, unique insertion sequence, immutable input digest, captured subject/artifact refs, publication generation/revision, ledger snapshot/root, compatibility and clock bindings. |

The storage column contract is fixed as follows. All tables are STRICT.
`JSON(N)` below means TEXT NOT NULL with CHECK(length(CAST(column AS BLOB)) <= N), containing canonical owned JSON.
`HASH` means TEXT NOT NULL with a lowercase 64-character SHA256 hex check.
`SAFE` means INTEGER NOT NULL with CHECK(value BETWEEN 0 AND 9007199254740991).
`ID` means TEXT NOT NULL validated with the public Id grammar and bound above.
These are schema-definition abbreviations, not SQLite type names.

```text
store_meta(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  format_version INTEGER NOT NULL CHECK(format_version=1),
  store_id ID UNIQUE, engine_identity JSON(1024),
  profile_json JSON(4096), schema_digest HASH
)
run(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), run_id ID UNIQUE,
  identity_json JSON(1114112), identity_digest HASH,
  started_at_ms SAFE, deadline_ms SAFE, revision SAFE, generation SAFE,
  owner_id TEXT NULL, owner_nonce TEXT NULL, owner_mode TEXT NULL,
  lease_until_ms INTEGER NULL,
  lease_granted_monotonic_ms TEXT NULL, lease_until_monotonic_ms TEXT NULL,
  clock_basis_json JSON(2048), clock_json JSON(1024), ledger_json JSON(16384),
  ledger_root HASH, record_counts_json JSON(1024), record_digest HASH
)
requests(
  request_id ID PRIMARY KEY,
  sequence INTEGER NOT NULL UNIQUE CHECK(sequence BETWEEN 1 AND 1024),
  admission_json JSON(16384), admission_digest HASH, admission_generation SAFE,
  operation_id ID UNIQUE, state_json JSON(16384),
  FOREIGN KEY(operation_id) REFERENCES operations(operation_id)
    DEFERRABLE INITIALLY DEFERRED
)
operations(
  operation_id ID PRIMARY KEY,
  sequence INTEGER NOT NULL UNIQUE CHECK(sequence BETWEEN 1 AND 2048),
  intent_json JSON(16384), intent_digest HASH, intent_generation SAFE,
  linked_request_id TEXT NULL UNIQUE, state_json JSON(16384),
  FOREIGN KEY(linked_request_id) REFERENCES requests(request_id)
    DEFERRABLE INITIALLY DEFERRED
)
checkpoints(
  checkpoint_id ID PRIMARY KEY,
  sequence INTEGER NOT NULL UNIQUE CHECK(sequence BETWEEN 1 AND 64),
  input_json JSON(65536), input_digest HASH, checkpoint_json JSON(65536),
  checkpoint_digest HASH
)
```

`identity_json` contains exactly {storeId, lock, policy, binding}; directory path is an authority-selection input, not portable identity.
`clock_basis_json` stores ClockBasis once at creation. It is immutable across every later mutation/open/checkpoint/takeover.
`clock_json` contains {wallMs, monotonicMs, status:'trusted'} from the latest successfully committed mutation.
The latest sample supports rollback/decrease detection; it never replaces the creation basis.
Lease monotonic text columns use the canonical MonotonicMs domain. lease_until_ms is its display-only civil projection.
Stored validation checks taskDeadlineMonotonicMs = created.monotonicMs + admitted wallTimeMs.
It also checks startedAtMs = created.wallMs, deadlineMs = startedAtMs + wallTimeMs, matching clockEpoch,
latest monotonic sample >= creation.monotonicMs, latest civil sample >= creation.wallMs, and abs(cumulative drift) <= 1000 ms.
For a present owner, require leaseUntilMonotonicMs = leaseGrantedMonotonicMs + policy.leaseMs.
Require creation.monotonicMs <= leaseGrantedMonotonicMs <= latest committed monotonic sample.
Validate the display projection against the immutable basis and the all-present/all-NULL owner tuple.
Any stored mismatch is STORE_CORRUPT; a new live sample outside continuity is CLOCK_UNTRUSTED.
`ledger_json` and record_counts_json follow LedgerView and RecordCounts, excluding the derived handle clock block.
Request state_json contains the RequestRecord fields other than sequence/admission/admissionDigest/admissionGeneration.
Operation state_json contains the OperationRecord fields other than sequence/intent/intentDigest/intentGeneration/linkedRequestId.
Checkpoint input_json retains the exact canonical validated CheckpointInput for duplicate-byte comparison.
Checkpoint JSON stores the complete CheckpointRecord; checkpoint_digest covers its complete canonical content.
Run record_digest covers every run column except record_digest itself, including ownership and clock samples.
This detects accidental changes outside the ledger root as well as within it.
Schema checks require all owner fields NULL together or all present with valid mode, nonce and safe expiry.
Domain state checks happen in closed application validators before writes and during bounded store verification.
Only the primary-key and unique indexes above exist; include their normalized definitions in the schema fingerprint.
There is one run per file, so request/operation keys are unambiguous without an extra run_id column.
Open verifies both singleton rows and that run_id/store_id match identity_json.

Use deferred foreign keys for linked request/operation records. Insert linked pairs in one transaction.
Use CHECK constraints for scalar storage sizes, finite integer domains, owner tuples, singleton keys and format version.
Closed application validators check JSON states and booleans before writing and when verifying stored records.
Run generation and revision are nonnegative safe integers, initialized to 0.
Sequences are bounded safe integers. A mutation that would overflow generation/revision fails before any write.

The immutable identity is canonical validated JSON for the full TaskLock, StatePolicy, CompatibilityBinding and storeId.
Use sorted-object-key serialization and domain-separated SHA256.
Domains are `loopwright.dev/state/v1/` + kind + NUL.
The closed kind set is identity, run-record, request-input, operation-intent, receipt, checkpoint-input, checkpoint-record and ledger.
Compare canonical bytes as well as digests when resolving duplicate identities.
Persist record digests and a ledger root over immutable identity, request/operation states and exact counters/totals.
These hashes detect accidental change. They do not authenticate a caller or defeat a hostile disk writer.
Validate bounded stored records and recompute the ledger/root on reopen and in mutation transactions.
Do not trust a saved counter that disagrees with its records.
Malformed JSON, checksum mismatch, missing records, inconsistent counters and broken references yield STORE_CORRUPT.

`createLocalRun` exclusively creates its directory with mode 0700 and the database with mode 0600.
Create the database file exclusively at mode 0600 before SQLite opens it inside the new owned directory.
It creates schema, immutable run identity, immutable creation clock basis/task deadline, latest sample and initial zero ledger in one transaction.
An existing complete matching store returns its existing run, without reset or dispatch permission.
A different identity returns IDENTITY_CONFLICT. An existing empty/partial directory returns STORE_INCOMPLETE.
A crash during first initialization therefore needs explicit operator disposition; a retry cannot erase ambiguous authority.
`reopenLocalRun` requires an existing directory/file and exact expected storeId, lock, policy and compatibility binding.
It never runs schema creation or initialization. Missing data returns STORE_MISSING or STORE_INCOMPLETE.
Only an explicit fresh create on a new authoritative path can start a new run.
The trusted-directory assumption excludes a concurrent unlink between existence checks and SQLite open.
Even if such a race produces an empty file, reopen rejects it and never initializes a ledger.

At initial creation, sample the trusted clock once inside the initialization transaction.
Persist its civil wallMs as startedAtMs and its monotonicMs as the immutable task basis.
Persist deadlineMs = checked-add(startedAtMs, admitted wallTimeMs) for display/identity.
Persist taskDeadlineMonotonicMs = creation.monotonicMs + admitted wallTimeMs for authoritative elapsed-time enforcement.
Civil timestamps never substitute for the monotonic task/lease gates.
An identical creation retry uses the original basis and deadlines. Reopen and all ownership changes retain them.

### Exact public boundary

Export named types and these functions from `@loopwright/state`.
All record properties are readonly; every returned record is a deep owned frozen snapshot.
No public method exposes the SQLite handle, mutable buffers, caller aliases, raw SQL, test hooks or a fake-store selector.
Inputs use closed runtime validation. TypeScript types are not authority.
Public factories and methods return StateResult; expected failures do not throw.
Use core `validateDocument(input, 'TaskLock')` for locks. Validate RequestUsage against the public closed shape.
Reuse core aggregateUsage for each Quantity in isolation, placing the other metrics at reported zero in the validation input.
This checks public Quantity semantics without losing individually valid values whose combined total exceeds the core aggregate's number range.
These isolated validation inputs are never persisted or counted as usage. Compute actual state totals with bigint.
Validate ArtifactRef values by constructing a bounded ArtifactManifest and passing it through public identifyManifest.
Preserve core diagnostics when validation fails. Do not import or change core private schemas.

Definitions use `Id = string` with grammar `^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$` and a 64-character cap.
`Text` is a nonempty valid-Unicode string of at most 128 characters; target identities allow 1024 characters.
`RevisionText` follows core's revision validation when part of Subject.
Digest, TaskLock, Subject, ArtifactRef, RequestUsage and Diagnostic are the existing public core types.
No new field is added to a core document.

```ts
type ExactTotal = { readonly decimal: string; readonly safeValue: number | null };
type StatePolicy = {
  readonly version: 1;
  readonly leaseMs: number; // integer 1000..60000
  readonly cost: 'observe_only';
};
type CompatibilityBinding = {
  readonly coreApiVersion: 'loopwright.dev/v1alpha1';
  readonly hostVersion: string;
  readonly adapters: readonly { readonly id: string; readonly version: string }[];
  readonly resourceVersion: string;
  readonly clockEpoch: string; // trusted host identity for this boot/clock domain
};
type Authority = {
  readonly storeId: string; readonly runId: string; readonly lockHash: Digest;
  readonly ownerId: string; readonly generation: number; readonly nonce: string;
};
type OwnerView = {
  readonly authority: Authority; readonly revision: number;
  readonly leaseUntilMs: number; // display-only projection
  readonly leaseGrantedMonotonicMs: MonotonicMs;
  readonly leaseUntilMonotonicMs: MonotonicMs; readonly clockEpoch: string;
  readonly mode: 'active' | 'recovery';
};
type MonotonicMs = string; // canonical nonnegative decimal, 1..20 digits
type ClockSample = { readonly wallMs: number; readonly monotonicMs: MonotonicMs };
type ClockBasis = {
  readonly clockEpoch: string; readonly created: ClockSample;
  readonly taskDeadlineMonotonicMs: MonotonicMs;
};
type ClockView = {
  readonly basis: ClockBasis; readonly lastCommittedSample: ClockSample;
  readonly sampledNow: ClockSample; readonly elapsedTaskMs: ExactTotal;
  readonly remainingTaskMs: ExactTotal;
};
type LocalRunIdentity = {
  readonly directory: string; readonly storeId: string;
  readonly lock: TaskLock; readonly policy: StatePolicy;
  readonly binding: CompatibilityBinding;
};
type StateResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: StateError };
type StateError = {
  readonly code: StateErrorCode; readonly path: string;
  readonly retryable: boolean; readonly commit: 'not_committed' | 'unknown';
  readonly diagnostics: readonly Diagnostic[];
};
type Mutation<T> = {
  readonly kind: 'created' | 'applied' | 'existing';
  readonly revision: number; readonly record: T;
};
type Purpose = 'task' | 'judge' | 'reviewer' | 'compaction' | 'child';
type Capability = {
  readonly adapterId: string; readonly adapterVersion: string;
  readonly provider: string; readonly model: string;
  readonly kind: 'hard_bound' | 'soft_only' | 'unknown';
  readonly coversAllBillableTokens: boolean;
  readonly enforcesOutputBound: boolean;
};
type RequestAdmission = {
  readonly requestId: string; readonly roleId: string;
  readonly nodeId: string; readonly attemptId: string;
  readonly purpose: Purpose;
  readonly repair: 'none' | 'format' | 'implementation';
  readonly transportRetryOf: string | null;
  readonly requestDigest: Digest;
  readonly inputUpperBound: number; readonly outputUpperBound: number;
  readonly totalUpperBound: number;
  readonly capability: Capability;
  readonly operationId: string; readonly targetIdentity: string;
};
type OperationIntent = {
  readonly operationId: string; readonly nodeId: string; readonly attemptId: string;
  readonly effect: 'read_only' | 'local_write' | 'external_write';
  readonly requestDigest: Digest; readonly targetIdentity: string;
};
type ReceiptSubject = {
  readonly storeId: string; readonly runId: string; readonly lockHash: Digest;
  readonly operationId: string; readonly requestId: string | null;
  readonly intentDigest: Digest; readonly dispatchGeneration: number;
  readonly dispatchId: string;
};
type TrustedEvidence = {
  readonly evidenceId: string; readonly producerId: string; readonly method: string;
  readonly subject: ReceiptSubject; readonly artifact: ArtifactRef;
};
type RequestObservation = {
  readonly receiptId: string; readonly evidence: TrustedEvidence;
  readonly termination: 'confirmed' | 'unknown';
  readonly outcome: 'succeeded' | 'failed' | null;
  readonly usage: RequestUsage;
};
type RequestResolution =
  | { readonly kind: 'terminal_usage'; readonly observation: RequestObservation }
  | { readonly kind: 'not_executed'; readonly receiptId: string;
      readonly evidence: TrustedEvidence };
type OperationReceipt = {
  readonly receiptId: string; readonly evidence: TrustedEvidence;
  readonly outcome: 'succeeded' | 'failed' | 'not_executed';
};
type UnresolvedReason = 'timeout' | 'cancellation' | 'connection_lost' | 'owner_lost';
type DispatchPermit = {
  readonly storeId: string; readonly runId: string; readonly lockHash: Digest;
  readonly operationId: string; readonly requestId: string | null;
  readonly generation: number; readonly dispatchId: string;
  readonly authorizedRevision: number;
  readonly clockEpoch: string; readonly notAfterMonotonicMs: MonotonicMs;
  readonly notAfterMs: number; // display-only projection, never an authorization clock
};
type DispatchResult<T> =
  | { readonly kind: 'new_dispatch'; readonly revision: number;
      readonly permit: DispatchPermit; readonly record: T }
  | { readonly kind: 'existing'; readonly revision: number; readonly record: T };
type CheckpointInput = {
  readonly checkpointId: string; readonly expectedRevision: number;
  readonly candidateManifest: unknown; // validated through core bindSubject
  readonly workspace: ArtifactRef;
  readonly privateSession: ArtifactRef | null;
  readonly additionalArtifacts: readonly ArtifactRef[];
};
type PageCursor = {
  readonly storeId: string; readonly runId: string;
  readonly collection: 'requests' | 'operations' | 'checkpoints';
  readonly revision: number; readonly afterSequence: number;
};
type Page<T> = {
  readonly revision: number; readonly items: readonly T[];
  readonly next: PageCursor | null;
};
```

All quantities and bounds supplied as numbers are nonnegative safe integers; positive bounds cannot be zero.
MonotonicMs strings match `^(0|[1-9][0-9]{0,19})$`; arithmetic uses bigint and rejects a result outside that domain before writing.
No monotonic interval is converted to an unsafe number.
Receipt evidence method is Text; producer/evidence/receipt IDs are Id.
Adapter IDs and versions must match the frozen binding and the lock role's adapter/provider/model.
Host/resource/version strings are Text; clockEpoch is Text. Adapter entries are sorted by ID and unique.
The binding contains exactly the adapters referenced by lock roles, at most 64.
RoleId and nodeId must reference admitted roles and steps; each request uses the same parent ledger.
Transport retries reference a prior dispatch-authorized, observed or unresolved request from this run, with matching role/node.
A retry always has a new requestId, operationId and attemptId. It never reuses a prior permit.
Input/output bounds are positive and totalUpperBound >= inputUpperBound + outputUpperBound using checked arithmetic.
Output bound must not exceed perCallOutputTokens.
Hard token admission requires hard_bound, coversAllBillableTokens=true and enforcesOutputBound=true.
For soft-accounting locks, soft_only/unknown capability remains visible; it does not bypass local reservation checks.
The package enforces all numeric admission caps locally, including soft-accounting caps, as a conservative additional policy.
It does not turn a core soft provider capability into a hard provider guarantee.
S02 does not support a hard monetary cap. Unknown cost stays unknown; no extra cost-cap field is accepted.

Factory signatures:

```ts
createLocalRun(input: LocalRunIdentity): StateResult<LocalRunStore>
reopenLocalRun(input: LocalRunIdentity): StateResult<LocalRunStore>
```

LocalRunStore methods:

| Signature | Result and preconditions |
| --- | --- |
| inspect(): StateResult<RunView> | Consistent current summary; no permission or authority nonce. |
| claim(input: {ownerId: Id; expectedGeneration: number; expectedRevision: number; mode: 'active' \| 'recovery'}): StateResult<OwnerView> | CAS on observed generation/revision; owner absent/released/monotonically expired; increment generation and generate a nonce. |
| renew(authority: Authority): StateResult<OwnerView> | Exact live owner, same generation/nonce; extend lease from current time. |
| release(authority: Authority): StateResult<Mutation<OwnerStatus>> | Exact live owner; clear owner and increment generation. No charge/slot changes. |
| reserveRequest(authority: Authority, input: RequestAdmission): StateResult<Mutation<RequestRecord>> | Check/charge parent and child counters and insert linked model intent atomically; never return a permit. |
| authorizeRequestDispatch(authority: Authority, requestId: Id): StateResult<DispatchResult<RequestRecord>> | One guarded reserved-to-dispatch transition, paired operation marker in same commit. |
| releaseReservation(authority: Authority, requestId: Id): StateResult<Mutation<RequestRecord>> | Reserved only; release charge/slot, keep lifetime counters. Fixed reason is caller_cancelled_before_dispatch. |
| markRequestUnresolved(authority: Authority, requestId: Id, reason: UnresolvedReason): StateResult<Mutation<RequestRecord>> | Dispatched only; preserve charge/slot and mark linked operation unresolved. |
| observeRequest(authority: Authority, requestId: Id, observation: RequestObservation): StateResult<Mutation<RequestRecord>> | Dispatch generation must equal current authority generation. Commit the initial receipt and paired operation state. |
| reconcileRequest(authority: Authority, requestId: Id, resolution: RequestResolution): StateResult<Mutation<RequestRecord>> | Explicit reconciliation under current authority, including an older dispatch generation bound in evidence. Definitive resolution only. |
| putIntent(authority: Authority, intent: OperationIntent): StateResult<Mutation<OperationRecord>> | New standalone intent only; model-call intents are created solely with reservations. |
| authorizeOperationDispatch(authority: Authority, operationId: Id): StateResult<DispatchResult<OperationRecord>> | Standalone intent only, one-shot marker. |
| markOperationUnresolved(authority: Authority, operationId: Id, reason: UnresolvedReason): StateResult<Mutation<OperationRecord>> | Standalone dispatched operation; no safe-replay declaration. |
| recordOperationReceipt(authority: Authority, operationId: Id, receipt: OperationReceipt): StateResult<Mutation<OperationRecord>> | Standalone current-generation dispatch only. |
| reconcileOperation(authority: Authority, operationId: Id, receipt: OperationReceipt): StateResult<Mutation<OperationRecord>> | Standalone unresolved/dispatch-uncertain operation; current owner and explicitly bound old dispatch accepted. |
| writeCheckpoint(authority: Authority, input: CheckpointInput): StateResult<Mutation<CheckpointRecord>> | Exact expected revision; capture the current ledger/journal view in this transaction. |
| getRequest(requestId: Id): StateResult<RequestRecord> | Read only; never includes a dispatch permit. |
| getOperation(operationId: Id): StateResult<OperationRecord> | Read only; never includes a dispatch permit. |
| getCheckpoint(checkpointId: Id): StateResult<CheckpointRecord> | Historical facts only. |
| listRequests(input: {limit: number; cursor: PageCursor \| null}): StateResult<Page<RequestRecord>> | 1..100 rows and 128 KiB response ceiling. |
| listOperations(input: {limit: number; cursor: PageCursor \| null}): StateResult<Page<OperationRecord>> | Same pagination rules. |
| listCheckpoints(input: {limit: number; cursor: PageCursor \| null}): StateResult<Page<CheckpointRecord>> | Same pagination rules. |
| recoveryView(authority: Authority, input: {checkpointId: Id; availableArtifacts: readonly ArtifactRef[]}): StateResult<RecoveryView> | Read current authority and ledger consistently; verify required references; return facts, never execution instructions. |
| close(): StateResult<{closed: true}> | Idempotent; close this connection only. Never releases ownership, reservations or uncertainty. |

Freeze output records as follows:

- `OwnerStatus = {generation, ownerId: Id|null, mode: 'active'|'recovery'|null, leaseUntilMs: number|null, leaseGrantedMonotonicMs: MonotonicMs|null, leaseUntilMonotonicMs: MonotonicMs|null}`. It excludes nonce; civil expiry is display-only.
- `Violation = 'reservation_exceeded'|'budget_exceeded'|'usage_overflow'|'clock_untrusted'`.
- `LedgerView = {admittedCalls, formatRepairs, implementationRepairs, transportRetries, heldSlots, reportedTokens: ExactTotal, estimatedTokens: ExactTotal, unknownTokenRequests, reservedCharge: ExactTotal, chargedTokens: ExactTotal, remainingTokens: ExactTotal, reportedCostMicrousd: ExactTotal, estimatedCostMicrousd: ExactTotal, unknownCostRequests, violations: readonly Violation[]}`.
- `RecordCounts = {requests, operations, checkpoints, reservedRequests, dispatchedRequests, observedRequests, unresolvedRequests, releasedRequests, unresolvedOperations}`.
- `RunView = {storeId, runId, lockHash, identityDigest, startedAtMs, deadlineMs, revision, owner: OwnerStatus, policy: StatePolicy, binding: CompatibilityBinding, clockStatus: 'trusted'|'blocked', clock: ClockView, ledger: LedgerView, counts: RecordCounts}`.
- `RequestRecord = {sequence, admission: RequestAdmission, admissionDigest: Digest, admissionGeneration, state: 'reserved'|'dispatch_authorized'|'observed'|'unresolved'|'released', dispatch: {generation, dispatchId, revision}|null, holdsSlot: boolean, chargedTokens: ExactTotal, initialObservation: RequestObservation|null, resolution: RequestResolution|null, unresolvedReason: UnresolvedReason|null, violations: readonly Violation[]}`.
- `OperationRecord = {sequence, intent: OperationIntent|ModelIntent, intentDigest: Digest, intentGeneration, linkedRequestId: Id|null, state: 'intent'|'dispatch_uncertain'|'confirmed'|'unresolved'|'abandoned', dispatch: {generation, dispatchId, revision}|null, initialReceipt: OperationReceipt|null, reconciliation: OperationReceipt|null, unresolvedReason: UnresolvedReason|null}`.
- `ModelIntent` has the same identity fields as OperationIntent with `effect: 'model_call'`. It derives its node/attempt/digest/target/operationId from RequestAdmission.
- `CheckpointRecord = {sequence, checkpointId, inputDigest: Digest, subject: Subject, workspace: ArtifactRef, privateSession: ArtifactRef|null, additionalArtifacts: readonly ArtifactRef[], storeId, runId, lockHash, binding: CompatibilityBinding, formatVersion: 1, generation, publishedRevision, startedAtMs, deadlineMs, clockBasis: ClockBasis, clockSample: ClockSample, ledger: LedgerView, ledgerRoot: Digest, counts: RecordCounts}`.
- `RecoveryView = {checkpoint: CheckpointRecord, current: RunView, ledgerAdvanced: boolean, requiresReconciliation: boolean}`.

Bare numeric output fields are nonnegative safe integers. ExactTotal may represent signed remaining amounts.
ClockView elapsed/remaining uses sampledNow.monotonicMs and the immutable creation basis/deadline, never civil-time subtraction.
If an invalid sample precedes creation, the exact elapsed value may be negative and clockStatus is blocked.
That view grants no authority. Id, Digest and exact union types retain their definitions above.
`requiresReconciliation` is true for current dispatched/unresolved work or sticky violations; it is not a claim of adapter completeness.
Record counts describe rows known to this store, not undiscovered provider calls.

### Error taxonomy and precedence

| Code | Meaning |
| --- | --- |
| INVALID_INPUT | Closed shape, scalar or core validation failure; attach core diagnostics when applicable. |
| LIMIT_EXCEEDED | Record, collection, page or fixed lifetime storage limit. |
| RUNTIME_UNSUPPORTED | Unqualified platform/architecture/Node/SQLite/API combination. |
| STORE_MISSING | Reopen path/database absent. |
| STORE_INCOMPLETE | Directory exists without a committed complete store/run. |
| STORE_CORRUPT | Integrity, schema structure, record/digest/reference or recomputed-ledger failure. |
| FORMAT_UNSUPPORTED | Unknown application/format version; never auto-migrate. |
| BINDING_MISMATCH | Host/adapter/resource/clock binding differs. |
| IDENTITY_CONFLICT | Store/run/lock/policy mismatch, or reused request/intent/checkpoint ID with different canonical input. |
| RECORD_NOT_FOUND | Requested durable row does not exist. |
| STORE_BUSY | SQLite BUSY/LOCKED after engine wait. Retryable only after confirmed rollback/no transaction. |
| STORE_UNAVAILABLE | Filesystem/SQLite I/O failure with known absent commit and successful rollback. |
| STORE_FULL | SQLite FULL or fixed database capacity reached, with confirmed rollback. |
| COMMIT_UNKNOWN | Commit or rollback acknowledgement is ambiguous; no permit; poison and close handle. |
| STORE_CLOSED | Operation on a closed/poisoned handle. |
| REVISION_CONFLICT | CAS or continuation-page revision no longer matches. |
| OWNER_HELD | Claim found another live owner. |
| OWNER_EXPIRED | Matching token exists but now.monotonicMs >= saved leaseUntilMonotonicMs; renewal cannot revive it. |
| STALE_OWNER | Wrong store/run/lock, owner, generation or nonce for a mutation. |
| CLOCK_UNTRUSTED | Rollback or discontinuity within the declared clock domain prevents safe lease/deadline decisions. |
| DEADLINE_EXCEEDED | New active work attempted with now.monotonicMs >= immutable taskDeadlineMonotonicMs. |
| BUDGET_EXHAUSTED | A named parent/child numeric cap would be exceeded; path names that cap. |
| CAPABILITY_UNSUPPORTED | Hard token declaration absent, unknown or insufficient. |
| TRANSITION_INVALID | Illegal lifecycle step, linked-operation bypass, or replay attempt. |
| RECEIPT_CONFLICT | Different receipt/observation reuses an already recorded receipt slot/outcome. |
| EVIDENCE_INSUFFICIENT | Receipt subject mismatch, malformed evidence or nondefinitive reconciliation. |
| CHECKPOINT_STALE | New checkpoint expectedRevision differs from current committed revision. |
| ARTIFACT_REQUIRED | Recovery reference set omits or changes a required artifact. |
| ARITHMETIC_OVERFLOW | An input/new-reservation/revision operation cannot fit the required safe-integer domain. |
| RUN_BLOCKED | Sticky violation prevents new admission/dispatch. Inspect explains the violation. |

Only STORE_BUSY and REVISION_CONFLICT set retryable=true, and only with commit=not_committed.
Every other error sets retryable=false. COMMIT_UNKNOWN sets commit=unknown; all other returned errors assert confirmed no commit.
Over-bound observations commit successfully with violations in their returned record and RunView.
They are successes that record a blocked state, not errors claiming an absent commit.

If a clock sample is bad, rollback the requested mutation and return CLOCK_UNTRUSTED with commit=not_committed.
Do not write a hidden marker as part of that error.
The immutable creation basis plus persisted latest trusted sample keep the run blocked while cumulative or adjacent continuity is bad.
A private handle latches clockBlocked permanently after detection. Subsequent writes on that handle reject; inspection reports blocked.
On reopen, evaluate the persisted sample again. Return a readable handle with clockBlocked latched if continuity fails.
That handle permits inspection/getters/close and rejects every mutation, including claims.
No authority revives unless a later independent open passes immutable-basis continuity and the unchanged monotonic lease checks.
Reopening never makes an expired monotonic lease live or moves the task deadline.
No automatic clock repair or time rebasing API exists in S02.
Thus the `clock_untrusted` violation is an inspection/handle condition, not a hidden unfenced database write.
The stored clock_json.status field describes the last successfully validated committed sample. Failed calls never rewrite it.

Validation order: closed handle/runtime; input shape/size; BEGIN IMMEDIATE; stored integrity/identity;
owner generation/identity/nonce (or claim CAS); immutable-basis plus adjacent clock continuity; monotonic owner expiry; duplicate identity lookup;
new-transition monotonic task deadline/mode/capability; lifecycle/counters/limits/arithmetic; writes; COMMIT.
Within parent cap checks, use order: calls, tokens, concurrency, format repairs, implementation repairs, transport retries.
Identical no-op retries after expiry still require a live current authority; read-only lookup is separate.
Duplicate reserve/intent lookups under live authority may succeed after deadline because they grant no new work.

On any pre-commit failure, explicitly rollback. A confirmed rollback returns no partial state.
If COMMIT throws, return no dispatch permit even if later inspection finds the marker committed.
Conservatively classify ambiguous errors as COMMIT_UNKNOWN; close the handle and require reopen/inspection.
Never internally retry COMMIT and accidentally return a second dispatch grant.

### Ownership and trusted clock

The database is the store's sole write authority. The caller authenticates who may request a token.
Claim uses expectedGeneration and expectedRevision, then increments generation and draws a cryptographic random nonce.
An owner with now.monotonicMs < leaseUntilMonotonicMs blocks another claim, regardless of the displayed civil expiry.
An absent/released owner or now.monotonicMs >= leaseUntilMonotonicMs permits a guarded claim/takeover after clock validation.
At equality the old lease is expired. Takeover is allowed, and renewal of the old lease is forbidden.
Even the same ownerId receives a new generation and nonce after expiry. An old live process remains stale.

A successful claim records leaseGrantedMonotonicMs = now.monotonicMs and leaseUntilMonotonicMs = grant + frozen leaseMs.
Renew requires the current live token and now.monotonicMs < the stored lease expiry.
It keeps generation/nonce and explicitly replaces the lease grant/expiry with now.monotonicMs and now.monotonicMs + leaseMs.
Only claim/renew changes that grant basis. Other mutations, reads, checkpoints and reopen never slide a lease.
Renewal does not change the task basis, task deadline or the expiry inside an already issued permit.
Release checks the same live token, increments generation and clears every owner/lease field.
A repeated old-token release returns STALE_OWNER.
An owner snapshot is not an idempotency key; repeat renew is another renewal only while still authorized.
A claim retry after an ambiguous commit must inspect; it cannot recover a new token by guessing ownerId.
The trusted host may securely retain the original Authority. Lost nonce requires monotonic lease expiry and a new generation.

Every data mutation uses one shared transaction helper and validates current authority inside BEGIN IMMEDIATE.
This includes release, renewal, reservation release, observations, reconciliation, unresolved markers, intents, receipts and checkpoints.
Only initial store creation and claim/takeover use their initialization/CAS guards instead of an existing owner token.
All successful changes increment run revision with a transactional revision CAS; identical duplicates do not increment it.
The same owner token may be delegated to trusted local processes for admission; serialization still protects counters.
This is how last-slot contention tests isolate the ledger invariant from competing-owner exclusion.

The production ClockSource samples Date.now() and process.hrtime.bigint() / 1000000n.
MonotonicMs is an absolute reading in the qualified same-boot clock domain, never a stopwatch restarted by a process.
Node documents an arbitrary hrtime origin and elapsed intervals; it does not promise portable cross-process/boot identity.
Support is bounded to the measured darwin/arm64, Node v26.13.0 / SQLite 3.54.1 profile on one retained host boot.
The original local probe observed matching parent/child civil-minus-monotonic offsets on that profile.
Build acceptance must add bracketed independent-process clock samples and preserve actual clock/domain identities.
This does not generalize to Linux, Windows, another Node build, reboot or a clock domain reconstructed from a checkpoint.
Require unchanged trusted binding.clockEpoch, and require basis.clockEpoch == binding.clockEpoch.
The trusted host identifies its boot/domain. A mismatch is BINDING_MISMATCH; a missing trustworthy domain blocks use.

Persist two distinct clock records:

1. Immutable ClockBasis, containing creation sample and taskDeadlineMonotonicMs = creation.monotonicMs + admitted wallTimeMs.
2. Latest committed ClockSample, used only for adjacent rollback/decrease and latest-known-time checks.

At each mutation, take the sample after acquiring the transaction. Do not commit a stale pre-lock sample.
Use the following exact checks, in order, with bigint arithmetic:

```text
basis = immutable ClockBasis
B = basis.created
L = latest committed sample
N = freshly sampled time in binding.clockEpoch
if N.monotonicMs < L.monotonicMs: CLOCK_UNTRUSTED
if N.wallMs < L.wallMs: CLOCK_UNTRUSTED
adjacentDrift = (N.wallMs - L.wallMs) - (N.monotonicMs - L.monotonicMs)
cumulativeDrift = (N.wallMs - B.wallMs) - (N.monotonicMs - B.monotonicMs)
if abs(adjacentDrift) > 1000 or abs(cumulativeDrift) > 1000: CLOCK_UNTRUSTED
if mutation requires live owner and N.monotonicMs >= leaseUntilMonotonicMs: OWNER_EXPIRED
if new active work and N.monotonicMs >= basis.taskDeadlineMonotonicMs: DEADLINE_EXCEEDED
```

Only a successful actual mutation updates L. It never updates B or the task deadline.
Duplicate no-op lookups leave L and revision unchanged; their time checks still use both B and L.
The 1000 ms cumulative tolerance is one fixed envelope around creation. It cannot be spent again on each call.
Adjacent checks remain useful for a decrease even if the net cumulative difference is small.
A valid small civil offset never changes the monotonic time available for the task or the lease.
Once monotonic task elapsed time reaches admitted wallTimeMs, new work fails even with a civil clock lag inside tolerance.
A civil clock advance within tolerance cannot independently expire a live monotonic lease or enable takeover.
A larger cumulative advance/lag fails CLOCK_UNTRUSTED before takeover, renewal or admission decisions.
Clock errors roll back the requested operation with no hidden committed marker, as defined in Error taxonomy.
No clock rebase/repair/reset API exists. Keep charges and slots when time is untrusted.
A later explicitly reopened readable store must still use the original basis and remaining monotonic time.
Host suspend or clock-domain behavior outside the qualified profile is not silently treated as additional task time.
An observed civil/monotonic discontinuity blocks use; no OS-suspend or reboot recovery qualification is claimed.

Civil startedAtMs/deadlineMs remain immutable display/identity facts from creation.
Project a monotonic expiry E to civil display using B.wallMs + (E - B.monotonicMs), with checked safe conversion.
Use that projection for leaseUntilMs and permit.notAfterMs. Those civil fields never decide authorization.
The monotonic fields plus matching clockEpoch and current store fence are authoritative for consumers.
A future adapter must use its verified same-domain monotonic source at the actual send boundary.
If it cannot compare that domain or fence the attempt, the permit is unusable; a civil timestamp is not a fallback.

Active claim and all new reservation/dispatch/intent creation require now.monotonicMs < immutable taskDeadlineMonotonicMs.
Recovery-mode ownership may be acquired after that deadline to settle, reconcile, release never-dispatched work and publish checkpoints.
Lease duration is independent of task deadline so authorized accounting can finish after new-work authorization ends.
Recovery mode never authorizes a new request, operation intent or external dispatch.
An active owner also cannot admit/dispatch after the monotonic task deadline, even if its lease remains live.
Task expiry, lease expiry, mode changes and owner loss never assert provider termination or refund charge/slots.
Close affects only the local connection; it has no ownership/accounting effect.

### Atomic admission, dispatch and retry semantics

A single BEGIN IMMEDIATE transaction performs:

1. Validate stored identity/integrity, current fence and trusted time.
2. Match request identity, or reject conflicting reuse.
3. Check deadline/mode/capability and all lifetime/parent/child/slot/storage limits.
4. Reserve totalUpperBound and one slot; increment lifetime call and applicable repair/retry counters.
5. Insert the request and its linked model_call operation intent.
6. Recompute ledger/root; increment revision and COMMIT.

No caller may dispatch from the result of reservation.
A second transaction authorizes dispatch only if the request remains reserved, current authority is live and the run allows new work.
It changes request to dispatch_authorized and linked operation to dispatch_uncertain atomically.
Only that successful first transition returns kind=new_dispatch and a permit.
Set permit.notAfterMonotonicMs = min(current leaseUntilMonotonicMs, immutable taskDeadlineMonotonicMs).
The permit also binds clockEpoch, store/run/lock, operation/request and generation.
The strict execution window is now.monotonicMs < notAfterMonotonicMs with a current fence and an unconsumed bound attempt.
notAfterMs is only the immutable-basis civil projection of that exact expiry; it grants no authority.
An explicit lease renewal never extends a previously returned permit.
If commit/response latency crosses the saved monotonic expiry, the durable marker remains but the permit is already unusable.
The actual-send check must reject it; there is no replacement permit or automatic reservation refund.
A duplicate dispatch authorization returns kind=existing without a permit, regardless of owner reopen or process restart.
An ambiguous or lost dispatch authorization response leaves possible dispatch; it never yields a replacement permit.
Read-only getters, creation retries, reserve retries, checkpoints and recovery views never return permits.
The future adapter must fence and deduplicate at its actual send/write boundary; S02 cannot stop a suspended old process from external action.
A saved permit is not a general replay credential. The trusted adapter must consume the exact bound attempt once.

Request identities freeze the complete RequestAdmission, including bounds, purpose, repair/retry classification, role and capability.
Identical reserve retries return the saved record without another charge, counter or operation intent.
Different reuse returns IDENTITY_CONFLICT before any new charge.
All purpose classes share the one parent allowance. Repair and transport labels add their own counters, never a new allowance.
A retry of a format/implementation repair can consume both its repair counter and the transport counter.
Zero repair/retry caps reject that class independently.
Lifetime call/repair/retry counters count admitted attempts, including released never-dispatched reservations.
They never decrease. This deliberately charges abandoned admission slots against the finite attempt budget.
Only token charge and live/reserved concurrency can be released.

| Request transition | Charge | Slot | Permit |
| --- | --- | --- | --- |
| absent -> reserved | totalUpperBound | Held | None |
| reserved -> dispatch_authorized | Retain | Held | First committed transition only |
| reserved -> released | Zero | Released | None; linked intent becomes abandoned |
| dispatch_authorized -> unresolved | Retain | Held | None |
| dispatched/unresolved -> observed, terminal complete reported usage | Actual total | Released | None |
| dispatched/unresolved -> unresolved, terminal unknown/estimated usage | Conservative charge | Released because termination is confirmed | None |
| dispatched/unresolved -> unresolved, termination unknown | Conservative charge | Held even with known usage | None |
| dispatch_authorized/unresolved -> observed, definitive reconciliation | Actual or confirmed zero | Released | None |

There is no released -> reserved, observed -> dispatched, or unresolved -> dispatch transition.
Release and authorization compete under the same lock, so only one can win.
A new owner may explicitly authorize a previously reserved attempt because no permit was ever committed for it.
A new owner cannot authorize an already marked attempt.
Takeover preserves rows, counters, deadline, existing generation bindings and uncertainty; it need not rewrite every row to expose uncertainty.
Inspect classifies dispatch_authorized as possible execution even without an unresolved marker.

### Observations, reconciliation and arithmetic

The trusted caller authenticates evidence before invoking the API. Receipt hashes are identity, not authentication.
Every evidence subject binds storeId, runId, lockHash, operationId, optional requestId, exact intentDigest, dispatchId and dispatchGeneration.
An ordinary observation/receipt requires current generation == dispatchGeneration.
After takeover, use the explicit reconciliation method with current authority and evidence bound to the old dispatch.
An old owner token always fails, including on identical receipts and checkpoints.

An initial observation may contain reported, estimated or unknown quantities in the core RequestUsage shape.
Its usage.requestId must equal the admitted request.
Confirmed termination requires outcome succeeded or failed; unknown termination requires outcome=null.
Each request stores one immutable initial observation and at most one definitive reconciliation.
A matching repeated initial observation returns existing, even after later reconciliation.
If complete terminal reported usage already settled the request, an exactly matching explicit terminal_usage resolution is an existing lookup.
Any different resolution against that observed record is RECEIPT_CONFLICT.
A different initial observation or repeated different final resolution returns RECEIPT_CONFLICT.
A definitive reconciliation may fill unknown values and replace estimates with reports.
It cannot change a previously reported quantity, confirmed termination or known outcome; that returns RECEIPT_CONFLICT.
A not_executed resolution cannot contradict prior positive reported usage or a confirmed succeeded/failed outcome.
A fresh initial receipt after the state was marked unresolved is permitted under the current-generation rule.
An identical unresolved marker is idempotent only with the same saved reason. A changed reason or terminal-state marker fails TRANSITION_INVALID.
An identical releaseReservation retry returns the released record under current authority. It never decrements counters twice.
Reconciliation accepts only confirmed termination with both token quantities reported, or trusted confirmed not_executed evidence.
An estimate or merely timed-out/cancelled request is insufficient reconciliation.
Cost may remain unknown even after token accounting resolves.
Already observed/released work cannot be rewritten by a conflicting reconciliation.

Let R be the original total reservation and K the sum of all currently known input/output token observations.
When termination and both reported token quantities are known, charge exactly K and release the slot.
Otherwise, charge max(R, K); retain unknown/estimated provenance separately.
Known termination releases the slot even when the charge remains unresolved.
Unknown termination retains the slot even when usage appears complete.
Provider success and zero usage are separate facts. A failed request may have positive usage.
Deadline, cancellation, missing handle, connection loss and owner expiry never imply either fact.

A bound violation is observed input > inputUpperBound, output > outputUpperBound, total > totalUpperBound, or charged total > the parent budget.
Persist the full admissible observation, actual exact charge and a sticky violation in the same transaction.
Block subsequent new admission/dispatch; allow authorized accounting/reconciliation and never-dispatched release.
Do not clamp usage or turn a committed blocked observation into an apparent rollback error.
S02 does not clear sticky over-bound/overflow violations automatically, even if later accounting reduces a conservative charge.

Use bigint internally for arithmetic; persist aggregate amounts as canonical decimal strings.
Core individual quantities remain safe integers. Reject an unsafe supplied quantity before mutation.
If individually valid observations sum beyond Number.MAX_SAFE_INTEGER, preserve their exact sum and set usage_overflow.
ExactTotal.safeValue is null when the exact value is outside the safe signed-number range; decimal always preserves it.
Remaining may be negative. Never present a clamped zero balance in place of the actual deficit.
Admission arithmetic cannot overflow or partially increment counters; reject before writing.
Store cost totals as separate reported/estimated exact subtotals with an unknown-request count.
S02 has no monetary authorization decision, so unknown prices never turn into affordable hard-cost admission.

### Operation journal

Standalone putIntent is an immutable identity submission and never a dispatch permit.
Its operationId/nodeId/attemptId/effect/requestDigest/targetIdentity form the frozen input.
Matching retries return existing; changed request, target or classification returns IDENTITY_CONFLICT.
The namespace is shared with linked model operations, so collisions cannot bypass their ledger rules.
Standalone receipt/dispatch APIs reject linked model operations. Only request APIs can mutate those paired records.

| Operation transition | Meaning |
| --- | --- |
| absent -> intent | Durable intent; no permission to act yet. |
| intent -> dispatch_uncertain | First committed authorization may return a permit; thereafter execution is possible. |
| dispatch_uncertain -> unresolved | No authenticated final outcome. Never safe to replay. |
| dispatch_uncertain/unresolved -> confirmed | Bound authenticated final receipt or explicit reconciliation. |
| linked intent -> abandoned | Guarded never-dispatched request release only. |

A standalone normal receipt requires the current dispatch generation. An explicit reconciliation may bind an older generation.
A matching repeated final receipt is idempotent; a changed outcome/evidence is RECEIPT_CONFLICT.
An identical reconciliation retry matches the separately saved reconciliation record.
A confirmed standalone operation never reopens for dispatch.
An identical unresolved marker with the same reason is a no-op; another reason or a marker after confirmation is TRANSITION_INVALID.
A repeated explicit reconciliation matching an already saved ordinary receipt may return existing without changing the confirmed outcome.
Different evidence/outcome against a confirmed record is RECEIPT_CONFLICT.
The model operation's terminal outcome follows confirmed request termination even when token usage remains unresolved.
A request with unknown termination keeps its operation uncertain.
Request observation and linked operation receipt are one transaction, including the budget/slot update.
Unknown execution is not confirmed failed or not_executed.
The future controller decides whether a new read-only attempt is permitted and how an external sink deduplicates effects.
No API executes effects or interprets an arbitrary digest as proof that they happened.

### Checkpoints, reads and finite storage

Checkpoint candidateManifest is validated with core bindSubject(current lock, manifest).
Persist the resulting Subject, including admitted repository/base/source and candidate/target-matrix digests.
The workspace reference identifies a bundle or diff. Private session is optional and referenced only.
At most 16 additional artifacts are accepted. Names must be unique across all checkpoint refs.
Do not store artifact bytes, session transcripts, credentials or captured workspaces.

For a new checkpoint, check current authority, expectedRevision and compatibility inside the transaction.
Capture ledger, counts, ledgerRoot, original civil times, immutable ClockBasis, current clock sample and generation at publication revision = current revision + 1.
Checkpoint publication updates only the latest committed sample, never the immutable basis or task/lease deadlines.
The ledger root covers request/operation state and counters, not checkpoint rows or clock/lease housekeeping.
Capture checkpoint count including the new row, and publish all fields in the same commit.
An exact retry uses the same complete CheckpointInput, including original expectedRevision, and returns existing before reapplying freshness checks.
Changed checkpoint input under the same ID fails. A new ID with stale expectedRevision fails CHECKPOINT_STALE.
Old authority fails before duplicate lookup.

A checkpoint records historical balances; it does not become an authority or a restoration source for those balances.
RecoveryView always reads the current run ledger/journal from this same authoritative store.
It rejects incompatible store/lock/binding, corrupt state, missing checkpoint or missing required artifact refs.
Require checkpoint.clockBasis to equal the current immutable run basis byte-for-byte.
Recovery reads current monotonic lease/task time against that basis; historical clock samples never rebase it.
Caller-supplied availableArtifacts attests exact names/digests/lengths after trusted artifact validation.
S02 validates reference identity and completeness only; fetching, content verification, restoration and secrecy remain later host obligations.
All required workspace/private-session/additional refs must be present, with no conflicting name binding.
If current revision is newer, ledgerAdvanced=true; the view keeps current usage, deadline, owner and unresolved operations.
An older checkpoint cannot decrease call counters, reconstruct a new run or authorize replay.

| Fixed limit | Value and behavior |
| --- | --- |
| Runs per database | 1; all roles share its parent ledger. |
| Requests per run | 1024 lifetime attempts; compatible with core's usage record count. |
| Operations per run | 2048 lifetime intents, including model-call intents. |
| Checkpoints per run | 64 lifetime entries. |
| Initial/final receipt storage | At most one immutable initial and one definitive reconciliation per request/operation. |
| Full lock input | Core's 1 MiB and structural limits. |
| Other public call input | 64 KiB, depth 32, 8192 nodes, 128 properties/object, 128 array elements except page/reference collections with smaller limits. |
| Request/operation persisted JSON body | Each immutable body and mutable state at most 16 KiB. |
| Checkpoint persisted JSON | At most 64 KiB. |
| Evidence reference | At most 8 KiB; no artifact bytes. |
| Ordinary strings | 128 characters; target identity/path/ref names at most 1024. |
| Page | 1..100 items; at most 128 KiB encoded response; stop before adding an item over the page budget. |
| Available checkpoint refs | At most 18; one workspace, optional private session, at most 16 additional. |
| Database | 256 MiB main file; rollback sidecar bounded by modified database pages plus journal overhead. |
| Clock discrepancy tolerance | 1000 ms cumulative against immutable creation and adjacent against latest committed sample; never renew the cumulative envelope. |
| Immutable task clock | Creation basis/task deadline never reset on reopen, mutation, renewal, takeover or checkpoint. MonotonicMs uses at most 20 decimal digits. |
| Renewable lease | Only successful claim/renewal sets lease grant/expiry. An already issued permit never extends. |
| Busy handler | 250 ms engine wait, no hidden retry loop. |

Check input structure and size before canonical serialization, hashing or SQL persistence.
For calls containing a TaskLock, validate that field under core's 1 MiB cap separately from the bounded surrounding identity fields.
Use descriptor-based owned snapshots; reject ordinary accessors, cycles, unsupported prototypes and unsafe numbers without invoking getters/toJSON.
Huge collections fail before recursive traversal/serialization. Proxy failures become INVALID_INPUT.
Validate stored byte lengths before parsing and enforce the same structural bounds on stored records.

Never prune an unresolved request/operation or forget its identity to make capacity.
S02 performs no retention deletion at all, including for resolved records.
At a lifetime limit, reject new rows. Matching duplicates and updates to existing records remain possible.
A capacity failure never refunds charge or resets authority.
Database FULL may still prevent a settlement commit; return STORE_FULL and retain prior conservative accounting.
Logical limits do not constitute a performance SLA or an OS disk quota.
Main database plus rollback journal can approach roughly twice the main-file ceiling; budget 600 MiB per production store directory.
The root test runner executes one file at a time, with at most two application fixture children plus its current test worker.
Tests use small stores and at most four owned child processes concurrently; reserve 1 GiB temporary scratch for validation.
No external resource, credential, model, Docker daemon or native build tool is needed.

Each page binds a collection, revision, store/run and insertion sequence.
If a continuation sees another committed revision, fail REVISION_CONFLICT; the caller restarts inspection.
Read transactions end before return. They never pin a snapshot between pages.
Each getter and inspect result is deep copied/frozen. Mutating caller input or a result cannot change durable state.
close is idempotent and closes only owned statements/connection. Tests await exact child exits before deleting their own temporary stores.

### Implementation plan

All tasks run in this worktree and on this branch. No core stored shape or public interface changes are planned.
No prefactor of core is required: its public validateDocument, bindSubject and aggregateUsage APIs supply the needed boundary.
Shared state implementation files make these tasks serial; the edges below reflect schema/behavior dependencies and overlapping ownership.
Each task adds public behavior and its tests before proceeding. Do not create helper workers.
`Gate: review` denotes a required ship review of that frozen scope, not permission to dispatch a plan/build reviewer.

- [x] **T0 · Create and reopen one bounded authoritative store**
      Blocked by: None
      Owns: `packages/state/**`, `package.json`, `package-lock.json`, `tsconfig.test.json`, required build config, this spec.
      Gate: review
      Acceptance: private package/workspace builds; create/reopen identity, exact runtime/config, missing/incomplete/corrupt/version rejection and immutable original deadline work against real SQLite. No core bytes change. Add source schema/error/boundary modules and create/inspect/close path only.
      Verify: `npm ci`; `npm run build`; `npm run typecheck`; `npm run lint`; `npm test`; focused `node --test .test-build/packages/state/test/store.test.js`.

- [x] **T1 · Claim, renew and fence a live competing owner**
      Blocked by: T0
      Owns: `packages/state/src/**`, `packages/state/test/ownership.test.ts`, `packages/state/test/clock.test.ts`, shared state fixtures, this spec.
      Gate: review
      Acceptance: shared transaction helper fences mutations; exact claim CAS, release, renewal, expired takeover and recovery mode work. Real child remains alive after takeover and fails a write. Clock rollback and cumulative drift block authority decisions without reset. Immutable monotonic task/lease limits enforce equality boundaries. Within-tolerance civil advance cannot cause early takeover; renewal never revives an expired lease.
      Verify: `npm test`; focused `node --test .test-build/packages/state/test/ownership.test.js .test-build/packages/state/test/clock.test.js`.

- [x] **T2 · Reserve a shared attempt and model intent atomically**
      Blocked by: T1
      Owns: `packages/state/src/**`, `packages/state/test/admission.test.ts`, shared state fixtures, this spec.
      Gate: review
      Acceptance: reserve/inspect/release forms a complete path; all parent/repair/retry counters, zero caps, capability/bounds and identity rules hold. Real transaction rollback leaves neither a charge nor an orphan intent. Duplicate lookup grants no dispatch. Release retains lifetime attempt counters.
      Verify: `npm test`; focused `node --test .test-build/packages/state/test/admission.test.js`.

- [x] **T3 · Authorize once, settle, and reconcile unknown usage**
      Blocked by: T2
      Owns: `packages/state/src/**`, `packages/state/test/settlement.test.ts`, shared state fixtures, this spec.
      Gate: review
      Acceptance: dispatch versus release is atomic; only one new_dispatch result exists. Observation and paired operation state settle together. All termination/usage combinations, unknown charge/slot policy, takeover reconciliation, duplicate/conflicting receipts, actual overage and exact aggregate overflow are measured.
      Verify: `npm test`; focused `node --test .test-build/packages/state/test/settlement.test.js`.

- [x] **T4 · Journal a standalone effect through receipt and recovery**
      Blocked by: T3
      Owns: `packages/state/src/**`, `packages/state/test/journal.test.ts`, shared state fixtures, this spec.
      Gate: review
      Acceptance: public standalone intent/one-shot authorization/receipt/reconcile path works. Model-link bypass fails. A retained local effect marker with no receipt stays unresolved after kill/reopen; getters do not execute it again.
      Verify: `npm test`; focused `node --test .test-build/packages/state/test/journal.test.js`.

- [x] **T5 · Publish bounded checkpoints and inspect current authority**
      Blocked by: T4
      Owns: `packages/state/src/**`, `packages/state/test/checkpoint.test.ts`, `packages/state/test/limits.test.ts`, shared state fixtures, this spec.
      Gate: review
      Acceptance: checkpoint publication is consistent; expected revision and subject/binding/ref checks work. Historical checkpoint recovery returns the current ledger and retains uncertainty/deadline. Record/count/page/database limits reject safely without pruning; returned aliases cannot mutate storage.
      Verify: `npm test`; focused `node --test .test-build/packages/state/test/checkpoint.test.js .test-build/packages/state/test/limits.test.js`.

- [x] **T6 · Close the real-process crash/contention matrix and behavioral RED**
      Blocked by: T5
      Owns: `packages/state/test/process.test.ts`, `packages/state/test/fixtures/**`, related corrective `packages/state/src/**`, this spec.
      Gate: review
      Acceptance: deterministic child barriers cover all A07 windows, claim/contention and stale-owner mutation families. A real admission or fence mutation makes an existing behavioral assertion fail, then exact source restoration and GREEN are recorded. All child exits and owned temporary-store cleanup have receipts.
      Verify: `npm test`; `node --test .test-build/packages/state/test/process.test.js`; mutation commands and source restoration hashes recorded in local evidence.

- [x] **T7 · Document and ship the frozen local package**
      Blocked by: T6
      Owns: `README.md`, `docs/state.md`, `docs/development.md`, `docs/adr/0001-local-state-authority.md`, related `examples/**`, this spec; scoped fixes from review in assigned state/config ownership.
      Gate: review
      Acceptance: self-contained support/accounting/recovery docs match code and A01-A07 evidence. Run the five required root commands on the final frozen head. Use up to four effective independent Pi feedback rounds via coordinator root adoption. Stop when clean and all findings are resolved. Deliver local ship handback with fingerprints and cleanup. Never merge/push/publish.
      Verify: `npm ci`; `npm run build`; `npm run typecheck`; `npm run lint`; `npm test`; final spec-content audit and exact-head review reproductions.

Root scripts after T0:

```text
build:     tsc -p packages/core/tsconfig.json && tsc -p packages/state/tsconfig.json
typecheck: tsc -p tsconfig.test.json --noEmit
lint:      eslint .
test:      tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-build/packages/core/test/*.test.js .test-build/packages/state/test/*.test.js
```

The test tsconfig includes both packages' src/test trees and child fixture sources.
State source imports the public workspace package `@loopwright/core`; state build emits to packages/state/dist.
To make `npm test` and typecheck work after a fresh npm ci, the root prepare/build dependency must first make core declarations/exports available.
Use an explicit shared precheck script `build:core` and root `pretypecheck`/`pretest` hooks calling it; do not require an undocumented prior build.
Core tests keep their existing direct public-index import convention. State tests import the state public root index.
Process fixtures run the same compiled state methods and actual SQLite path used in production.
Check tests do not accidentally import stale dist modules; fingerprint both source, compiled test modules and referenced workspace dist modules.

### Test plan

[x] I understand that owners may require updates to existing tests before committing this enhancement.

#### Prerequisite testing updates

Extend workspace build/typecheck/test discovery to include state and compiled child fixtures.
Preserve every current core test file and acceptance family; compare their bytes against the base.
Add a real-store fixture with unique owned directories, complete error assertions, child PID tracking and finally cleanup.
Add deterministic IPC barriers with bounded deadlines; no sleeps used as proof that a race reached a boundary.
Private constructor-injected transaction observers may report named boundaries to tests.
They are absent from package exports, public factory inputs, process environment and production configuration.
Observers run synchronously at real transaction boundaries; child fixture may emit IPC then park for parent kill using Atomics.wait.
The fixture uses the real implementation and database, not a fake transaction or store.
Admission/receipt calls still use the public LocalRunStore method boundary.
The only private test seam observes/parks at a boundary; it does not skip fencing, change commit results or fabricate state.
Unit clock tests may inject ClockSource through the private internal constructor while using the real database.
Public factories always select the production Date.now/hrtime clock.

#### Unit tests

- `packages/core`: preserve the existing suite without weakening tests; inherited coordinator result was 81 tests.
- `packages/state`: add exported method/error/state transition tests in T0-T5; measure coverage after implementation on 2026-11-05.
  Coverage percentage is not measured at planning time. No target percentage substitutes for the matrix below.
- Test exact limits and one-over-limit values, closed fields, getters/aliases/cycles, all stable error codes and deterministic precedence.
- Test normal and recovery ownership, adjacent rollback/decrease, cumulative drift and monotonic task/lease equality, plus generation/revision overflow.
- Real-store/private-clock cases are mandatory, with each committed/opened store retaining the original basis:
  use a 5000 ms task and a 10000 ms live lease, with enough request/counter capacity to isolate time decisions;
  repeated wall+100/monotonic+1000 and wall+1900/monotonic+1000 steps reject at the second step;
  repeated wall+900/monotonic+1000 steps stop at monotonic elapsed 5000 even while civil lag remains within 1000;
  reopen after the first tolerated step does not reset the drift envelope or task budget.
- With leaseMs=1000, wall+1500/monotonic+900 keeps the owner live and takeover returns OWNER_HELD.
  Renewal at monotonic+999 succeeds; at monotonic+1000 it returns OWNER_EXPIRED and takeover is allowed.
  A renewed lease has a new explicit grant basis, while the task basis and already issued permit expiry are unchanged.
- Test a permit whose lease ends first and one whose task ends first; exact equality denies use in both cases.
  Vary civil display independently within tolerance and verify it never extends/shortens the monotonic lease or acts as a fallback permit.
- Accepted controls use positive adjacent samples with +/-2 ms bounded cumulative sampling jitter; test cumulative 1000 accepted and 1001 rejected.
  Checkpoint, reservation, settlement, renew, takeover and reopen preserve creation anchor/task deadline bytes and their digest binding.
- Test each purpose and independent repair/retry zero cap, unknown capability and bounds overrun.
- Test all reported/estimated/unknown token combinations against known/unknown termination, cost provenance and exact aggregate overflow.
- Test duplicate/conflicting create, reserve, dispatch, release, observation, reconciliation, intent, receipt and checkpoint paths.
- Test a stale token against renew/release/reserve/releaseReservation/dispatch/unresolved/settlement/reconciliation/intent/receipt/checkpoint mutations.
- Verify no failed mutation changes ledger root, revision, counters, request state or journal rows.

#### Integration tests and A01-A07 matrix

| Acceptance | Required real-store scenarios and assertions | Later boundary |
| --- | --- | --- |
| A01 | create/reopen original identity and times; identical create retry; changed lock/policy/binding; missing file/run; partial initialization; corrupt JSON/root/schema/rows; unknown version; failed transaction rollback; no permit on commit ambiguity. | Store copies/rollback, remote or host-loss restore are unqualified. |
| A02 | Two independent claimants start behind an IPC barrier, exactly one wins current authority. Old process remains alive after real lease expiry/takeover and attempts every data mutation family. All fail STALE_OWNER. renew cannot revive expiry; bounded BUSY is distinct. Real SQLite/private-clock tests cover repeated tolerated drift, immutable-basis reopen, exact task/lease boundaries and jitter controls. Do not change the host civil clock. Independent real-clock processes bracket child monotonic samples and check the same qualified clock domain. | Store fencing cannot stop an external write from an old process; adapter/sink enforcement belongs to S03/S05. |
| A03 | Independent workers share current token, rendezvous before admission and compete for the final call, final token allowance and final slot in three separate stores. Exactly one reservation commits per scenario. Barrier-based same-ID retries charge once; conflicting IDs/bounds roll back. Paired intent and reservation never split. | Capability declaration and complete interception/normalization require S03/S04; no provider-internal billing proof. |
| A04 | Kill/reopen after reservation, dispatch, initial unknown observation, known termination/unknown usage and exact settlement. Verify call/deadline counters, charge/slot distinction, no double refund, conflict refusal, over-reservation blocking and persisted exact overflow totals. | Authentic provider final-usage/termination discovery requires later adapter integration. |
| A05 | Commit intent and marker, write a local fixture effect file, rendezvous before receipt, SIGKILL and reopen. Effect count stays one, operation unresolved, getters/recovery do not replay. Normal stale receipt fails, explicit current-owner reconciliation succeeds, conflicting outcome fails. Paired model receipt updates ledger/operation atomically. | Marker proves a local uncertainty window only; actual publisher authentication/dedup/reconcile belongs to S05. |
| A06 | Current checkpoint publication, stale revision, current/new owner, compatibility and missing ref cases. Write more admissions after checkpoint, reopen old checkpoint and assert current charges/deadline/unknowns remain. Check collection/row/page bounds and immutable results. | Workspace/session capture, fetch, content verification, restore and remote upload belong to later adapter/controller/service work. |
| A07 | Run every crash window and contention case below with child PID/IPC/exit and actual database identities. Preserve behavioral RED and restored GREEN on production code. | SIGKILL is process-crash evidence; no power loss, host loss, containment or external exactly-once claim. |

Crash barriers use a fresh retained store per case:

1. **Before mutation commit:** park after request/intent/counter writes but before COMMIT; kill; reopen and assert none committed.
2. **After reservation commit, before acknowledgement:** private observer parks immediately after COMMIT but before return; kill; reopen request reserved, charged once, no permit issued.
3. **After dispatch marker commit, before acknowledgement:** park immediately after marker COMMIT; kill; reopen possible dispatch; duplicate authorization returns existing without permit.
4. **After simulated effect, before receipt:** child appends an operation-bound marker, reports IPC, parks; kill; reopen unresolved, no replay.
5. **Before settlement commit:** park after ledger/receipt/journal writes; kill; reopen original outstanding charge with no partial receipt/refund.
6. **After settlement commit, before acknowledgement:** park after COMMIT; kill; reopen exact settled charge, zero held slot; identical receipt retry is a no-op.
7. **After checkpoint commit:** kill; reopen same checkpoint/current ledger binding, no historical reset.

Each child barrier message includes case, PID, storeId/runId, generation, revision and reached phase.
The parent waits for that exact message with a deadline before sending SIGKILL.
Record the kill return and exit event; wait for all owned children before cleanup.
For contention, children report ready before the parent releases start to both; no elapsed-time race is assumed.
If engine BUSY obscures the losing cap result, allow one explicit bounded same-ID retry after the winner commits.
Require the eventual loser to observe the exhausted cap; BUSY alone does not prove no oversubscription.
For real-clock/domain tests, record parent monotonic readings before fork and after the child ready message.
Require the child sample inside that bracket and civil-minus-monotonic offsets inside the frozen cumulative tolerance.
Record exact darwin/arm64 Node/SQLite versions and the same trusted clockEpoch.
This validates the current local process profile only; an arbitrary-origin API description is not portable proof.
For stale-owner tests, the old child confirms it is alive and its writes return STALE_OWNER after takeover.
The parent separately observes its controlled exit; taking a new lease is not proof the old child stopped.

Inject commit-acknowledgement failure through a private transaction observer that throws after real COMMIT.
That proves the API returns no permit on an acknowledged ambiguity and that reopen exposes the durable marker.
It is synthetic error-path evidence over real committed storage, separate from the actual SIGKILL cases.
Simulate SQLite FULL on an actual bounded file and validate retained prior rows/charge; do not substitute a fake store.

RED evidence uses one bounded mutation in the real reserve/fence helper after positive public tests exist.
Choose a mutation that removes the live token generation comparison or the shared remaining-budget check.
Run the existing stale-owner or final-slot assertion and require an assertion failure, not a compiler/import failure.
Restore the exact source file bytes/hash, rebuild the affected modules and rerun the same case GREEN.
Record exact diff, source head, argv/cwd/runtime, return codes and restoration hashes outside tracked files.
Do not leave a production test switch or weaken a test to obtain GREEN.

#### e2e tests

S02 has no agent executor, controller CLI or deployed service, so it has no product-level e2e flow.
The owned-process acceptance suite is its complete local public-API system test.
Do not claim S03 adapter, S04 controller or S05 external-effect e2e acceptance from it.
Those later stages must call these same admission/journal/checkpoint boundaries and prove their own integration.

### Risks and mitigations

- **Reliability: copied/missing authority →** require explicit create versus reopen, pinned store identity, trusted path, no initialization during reopen.
- **Reliability: stale live caller →** fence every mutation in the same SQLite transaction; retain live old child in acceptance.
- **Reliability: charged request escapes before intent →** reserve counters and insert model intent in one transaction; no dispatch permission from reserve.
- **Reliability: duplicate retry becomes replay →** one-shot marker transition, existing result without permit, no permit recovery from ambiguous response.
- **Reliability: unknown execution/usage →** retain conservative charge and slot unless termination is known; require definitive trusted reconciliation.
- **Reliability: clock discontinuity →** pinned measured same-boot clock domain, immutable creation anchor, cumulative/adjacent continuity and explicit monotonic task/lease/permit bounds; no time rebase.
- **Reliability: usage exceeds bound or number range →** record exact observation/decimal totals, sticky block, preserve provenance; never clamp.
- **Reliability: storage capacity →** fixed counts/bytes/database cap, no pruning, explicit FULL; settlement may remain blocked if the physical store cannot commit.
- **Compatibility: first stored format →** version 1, explicit exact binding, reject unknown formats, no silent migration. Core bytes/API remain unchanged.
- **Maintenance: bundled native engine →** no addon compiler burden; Node upgrade owns SQLite changes and full local requalification.
- **Performance: synchronous database work →** finite rows/input/pages, short transactions, explicit busy result; no throughput/latency SLA claimed.
- **Evidence: private barrier hooks →** constructor-only observation on real production methods; no exported toggle or fake store; identify synthetic acknowledgements separately.

### Alternatives

- **better-sqlite3 or sqlite3 npm binding:** adds addon binaries/ABI and compiler maintenance while Node already has the required transactional API.
- **WAL with FULL:** valid possible engine mode, but introduces WAL/shared-memory/checkpoint capacity policy and long-reader concerns without a current throughput need.
- **Multi-run database:** defers extra namespace/tenant/retention accounting. One parent ledger per store is enough for concurrent S02 callers.
- **File JSON journal:** would require a new locking/recovery/atomicity protocol instead of the tested database protocol.
- **Refund admitted-call counters before dispatch:** rejected; lifetime admitted attempts remain finite and cannot recycle request identities/counter space.
- **Release unknown charge on cancellation/lease expiry:** rejected; neither proves remote non-execution or final usage.
- **Reconstruct authority from checkpoint:** rejected; the retained live store is authoritative and historical balances are never restored.
- **Clock repair/rebase on open:** deferred; an unsafe rebase could extend deadlines or revive leases.

## Open Questions

None for local implementation. The backend, schema, API, error/transaction rules, clock policy,
accounting, reconciliation, storage limits, resource profile and task/test DAG are fixed above.
Later adapters must qualify actual send fencing, provider usage/termination and complete interception.
Later controllers/services must qualify artifact capture/restore, remote state and host-loss recovery.
The matrix keeps these later boundaries separate from the required local software acceptance.


## Local ship record

Three independent review rounds completed. The final reviewed implementation passed both Standards and Spec
with no remaining findings. Earlier corrections narrowed the runtime export surface, verified effective SQLite
limits, aligned the documented database alias and fixed two mixed-error precedence cases. The test-update
acknowledgement above remains accepted. Production behavior and tests remain frozen after that review.

The local suite preserves all 81 core tests and adds 138 state tests. Its seven required crash windows use
retained local stores and recorded child exits. The final-cap cases coordinate independent callers with
ready/start messages; they do not attest call overlap. A separate parked-writer case measures actual lock
contention, bounded STORE_BUSY, rollback and retry. Deterministic private-clock cases and bracketed real-process
samples cover their stated scope; no long-duration real-clock drift qualification was performed. Native-limit
tests check effective settings and enforcement on real SQLite; no synthetic mismatch case was measured.

Behavioral regression evidence includes a compiled production-fence mutation that made the live-stale-owner
assertion fail, exact source restoration and the same assertion passing. Two later public mixed-error tests
also failed against the pre-fix implementation and passed unchanged after the scoped reorder. Independent
review inspected the mutation evidence without rerunning it. Coverage measurement is diagnostic and does not
replace the individual A01-A07 assertions.

Local ship does not qualify provider authenticity/billing, external exactly-once execution, remote state,
host/power-loss recovery, OS containment or deployment. Actual send-boundary enforcement, usage discovery,
artifact capture/restore and service integration remain with the later adapters, controller, publisher and
service work described in the acceptance matrix. Repository integration and merge-tree acceptance remain
separate from this local package workflow.
