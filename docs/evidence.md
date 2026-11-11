# Verification Evidence and Authority

The trusted host supplies `expectedLock`, `candidateManifest`, and `eligibleEvidence`
in a separate `trusted` input. Actor submissions are `claims` for evaluation, or
`candidate.checks` for run construction.
The host must authenticate producers and collect/select their observations before calling.
Passing actor data as trusted evidence violates this caller contract.
A valid schema, producer name, hash, or serialized type brand cannot make evidence eligible.

## Contents

- [Boundary](#boundary)

## Boundary

An observation binds one acceptance check and its observed status to the exact lock,
contract, repository, destination base, source, candidate manifest, and target matrix.
It records producer, method, evidence level, artifact references, and a reason for non-passes.
A passed observation requires at least one original-byte artifact reference.
Static inspection, synthetic fixture, local execution, external service, and hardware execution
are distinct levels. Each check has an explicit allowed set; there is no universal ordering.

Supply already-loaded bytes as `[{name,bytes}]` to the evaluator.
Names are inventory keys, not paths to open. The library does not fetch URLs or run a resolver callback.
Candidate entries and evidence references are checked against the inventory's byte length and SHA-256.
All inventory byte bounds are checked before copying/hashing; bytes are hashed once per inventory entry.

Every required check produces exactly one row in contract-required order.
Missing submission means `not_run`. Missing eligible pass evidence or invalid bytes means `blocked`.
Failed, blocked, and explicit not_run submissions retain their status and reason.
Optional rows follow declared-check order and cannot cover required checks.
API success with `satisfied:false` is an honest verification outcome, not malformed input.

Duplicate claims/observations, contradictory outcomes, cross-check references, unknown checks,
and stale supplied evidence are malformed. The initial policy permits one eligible observation per check.
Compare a claim to the eligible observation for its check even if its evidence reference is null or unresolved.
Conflicting statuses produce `EVIDENCE_CONTRADICTORY` at the claim's status field.
Failed/blocked claims may omit evidence with null; a non-null dangling reference produces `REFERENCE_UNKNOWN`.
A pass with a null or unresolved reference stays blocked with `EVIDENCE_MISSING`.
Unused stale evidence is rejected. A receipt without a submission does not invent a passed row.

Error precedence is bounded-input scanning, closed schema validation, contract relationships,
recomputed identity, evidence consistency, inventory validation, coverage, then run consistency.
Across all observations, complete evidence-duplicate checks first, unknown-check checks second,
and subject comparisons third. Within the unknown-check phase, visit claims before eligible observations.
Claim/observation status and reference consistency follows the completed subject phase.
Each validator visits its closed fields in the specification's order.
Nested documents validate their internal invariants when visited; a bad nested lock hash
precedes a malformed later claims field.
Run construction aggregates valid usage control data before evidence evaluation and artifact inventory processing.
JSON scanning follows source order; object snapshots use sorted keys and ordered array indexes.
Structural property descriptors are checked before child schema validation.
For a claimed pass: missing evidence precedes disallowed level, candidate artifact failure,
then evidence artifact failure. For an artifact: missing, wrong length, then wrong digest.
See the [complete precedence rules](../specs/2026-11-05-task-contracts-and-evidence.md) for field comparison order.

`constructRunResult` recomputes acceptance for the same current expected lock.
`completed` needs every required row passed. `no_change` also needs a trusted no-change reason,
a passed required check, and its matching `verify_no_change` observation.
The method is checked before overall acceptance satisfaction, after unknown-effect/status handling.
Verification diagnostics retain locations in the public input that produced them; construction uses
`/candidate/checks`, while direct evaluation uses `/claims`.
Unknown external effects require `reconcile_required`; cancellation does not prove non-execution.
Memory pending/unavailable does not rewrite primary verification.

Usage retains reported/estimated/unknown components per request.
Aggregates contain `knownSubtotal`, `unknownCount`, and `complete`/`partial` completeness.
All-unknown observations have unknown provenance; an empty trusted inventory is explicit complete zero.
The host must include every admitted request and normalize overlapping provider token categories.
The library cannot discover omitted calls or certify provider billing. It does not settle a budget ledger.

**See also**: [Documentation index](README.md)

**Next**: [Architecture](getting-started/architecture.md)
