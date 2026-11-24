# Verification Evidence and Authority

The trusted host supplies `expectedLock`, `candidateManifest`, and `eligibleEvidence` in a separate `trusted` input. Actor submissions are `claims` for evaluation, or `candidate.checks` for run construction. The host must authenticate producers and collect/select their observations before calling. Passing actor data as trusted evidence violates this caller contract.

A valid schema, producer name, hash, or serialized type brand cannot make evidence eligible.

## Contents

- [Boundary](#boundary)
- [Block guards](#block-guards)
- [Hardware bundles](#hardware-bundles)

## Boundary

A model can claim success, but it cannot grant authority to its own claim. The host selects independent observations for the exact candidate and lock.

| Stage | Authority |
| --- | --- |
| Submit | The actor supplies claims about checks. |
| Observe | A trusted verifier records status and evidence for the bound candidate. |
| Evaluate | Core checks bindings, allowed levels, and artifact bytes. |
| Settle | Unknown external effects remain `reconcile_required` until authenticated reconciliation. |

A `gate.v1` handler signs requests with HMAC-SHA256 and verifies signed verdict bindings and expiry. Publication receipts bind the dispatch and idempotency key; invalid or missing receipts cannot prove an effect. See [gates and reconciliation](../configuration/controller-and-registry.md#gates-and-reconciliation).

An observation binds one acceptance check and its observed status to the exact lock, contract, repository, destination base, source, candidate manifest, and target matrix. It records producer, method, evidence level, artifact references, and a reason for non-passes. A passed observation requires at least one original-byte artifact reference.

Static inspection, synthetic fixture, local execution, external service, and hardware execution are distinct levels. Each check has an explicit allowed set; there is no universal ordering.

Supply either in-memory bytes (`{ name, bytes }`) or trusted host-verified CAS descriptors (`VerifiedArtifactDescriptor`: `{ name, byteLength, digest }` via `digestArtifactFromMetadata`) to `resolveInventory`, `evaluateAcceptance`, and `constructRunResult`.

Raw `Uint8Array` buffers enforce `64 MiB` per file and `128 MiB` total, while verified CAS descriptors backed by `<artifactsDir>/blobs/sha256/<hex>` scale up to `16,384` entries and `16 GiB` without RAM buffering. `ArtifactManifest.spec.entries` omits `uri` so canonical JCS `candidateDigest` hashes stay identical across v1 and v2 captures.

The `tree_overlay` inventory uses binary framing with magic `0x4c574f56` (`LWOV`) or `delegated-capture.v2` CAS pointers.
It carries the tree anchor, modified or added `entries`, and `deleted` paths.
`no-change.v1` and `scope.v1` validate pointer metadata with zero file reads; structured JSON/section guards read only their single targeted file (`<= 1,032,184` bytes).

For untouched baseline JSON, `json-artifact.v1` authenticates the blob through a Git Merkle tree-path proof.
The proof contains at most 16 trees and 256 KiB of raw tree bytes.
The worker verifies the tree chain and blob OID before parsing JSON.
A deleted target fails as a missing file.

Every required check produces exactly one row in contract-required order.
Missing submission means `not_run`. Missing eligible pass evidence or invalid bytes means `blocked`.
Failed, blocked, and explicit not_run submissions retain their status and reason.
Optional rows follow declared-check order and cannot cover required checks.
API success with `satisfied:false` is an honest verification outcome, not malformed input.

Duplicate claims/observations, contradictory outcomes, cross-check references, unknown checks, and stale supplied evidence are malformed. The initial policy permits one eligible observation per check. Compare a claim to the eligible observation for its check even if its evidence reference is null or unresolved. Conflicting statuses produce `EVIDENCE_CONTRADICTORY` at the claim's status field.

Failed/blocked claims may omit evidence with null; a non-null dangling reference produces `REFERENCE_UNKNOWN`. A pass with a null or unresolved reference stays blocked with `EVIDENCE_MISSING`. Unused stale evidence is rejected. A receipt without a submission does not invent a passed row.

Error precedence is bounded-input scanning, closed schema validation, contract relationships, recomputed identity, evidence consistency, inventory validation, coverage, then run consistency. Across all observations, complete evidence-duplicate checks first, unknown-check checks second, and subject comparisons third. Within the unknown-check phase, visit claims before eligible observations.

Claim/observation status and reference consistency follows the completed subject phase. Each validator visits its closed fields in the specification's order. Nested documents validate their internal invariants when visited; a bad nested lock hash precedes a malformed later claims field. Run construction aggregates valid usage control data before evidence evaluation and artifact inventory processing.

JSON scanning follows source order; object snapshots use sorted keys and ordered array indexes. Structural property descriptors are checked before child schema validation. For a claimed pass: missing evidence precedes disallowed level, candidate artifact failure, then evidence artifact failure. For an artifact: missing, wrong length, then wrong digest.

The core validators define the complete field comparison order.

`constructRunResult` recomputes acceptance for the same current expected lock. `completed` needs every required row passed. `no_change` also needs a trusted no-change reason, a passed required check, and its matching `verify_no_change` observation. The method is checked before overall acceptance satisfaction, after unknown-effect/status handling.

Verification diagnostics retain locations in the public input that produced them; construction uses `/candidate/checks`, while direct evaluation uses `/claims`. Unknown external effects require `reconcile_required`; cancellation does not prove non-execution. Memory pending/unavailable does not rewrite primary verification.

Usage retains reported/estimated/unknown components per request.
Aggregates contain `knownSubtotal`, `unknownCount`, and `complete`/`partial` completeness.
All-unknown observations have unknown provenance; an empty trusted inventory is explicit complete zero.
The host must include every admitted request and normalize overlapping provider token categories.
The library cannot discover omitted calls or certify provider billing. It does not settle a budget ledger.

## Block guards

- **`evolve-block-guard.v1`**: Parses `1..32` `EVOLVE-BLOCK-START: <id>` / `EVOLVE-BLOCK-END: <id>` pairs per file (`//`, `#`, or `/* */`) and rejects nested, duplicate, reordered, or unclosed markers. Every byte outside mutable blocks must match `baseRevision` SHA-256 while optional `allowedBlockIds` and `maxBlockBytes` constrain mutable regions.
- **Stage A static audits**: `evaluator.ts` inspects sealed Stage A `.so`, `.o`, `.cubin`, `.ptx`, and `.sass` binaries (`O_NOFOLLOW`, `1 MiB` symbol cap) against `forbiddenSymbolPatterns` (`0..64` literal substrings) and `maxRegisterCount`/`maxLocalSpillBytes` before Stage B starts, denying breaches with `STAGE_A_STATIC_AUDIT_FAILED`.

## Hardware bundles

- **Bucketed Stage B diagnostics**: Stage B envelopes (`<= 49,152` bytes stdout, zero exported files) carry optional `bucketMetrics` (`1..64` buckets, `<= 16` numeric metrics, `<= 8` dimensions) and closed-enum `hardwareDiagnostics`. `evaluateAcceptance` enforces `bucketScope` (`aggregate`, `all_buckets`, or `{ bucketId }`) across buckets.
- **Post-crash quarantine**: After any Stage B timeout or crash, `worker.ts` runs host accelerator probes via `provenance.ts` (`Xid`, uncorrectable ECC, hang) and transitions wedged workers to `WORKER_DEVICE_QUARANTINED` (exit `3`) before polling `/v1/runner/leases:acquire`.
- **Bundle export (`evolution-bundle.v1`)**: `exportEvolutionBundle` verifies CAS blobs (`O_NOFOLLOW`, `nlink === 1`, SHA-256, `SecretScrubber`), emits `manifest.json`, `dispatch-manifest.json` (`fallback: 'baseline'`), unmodified HMAC-signed `receipts/*.verdict.json`, and `blobs/sha256/<hex>` (`dir` or `oci-layout`), and refuses unverified or `synthetic_fixture` receipts with `EXPORT_UNVERIFIED_FORBIDDEN` unless `--allow-synthetic-probe` is set.


---

**See also** — [Canonical Identity and Digests](identity.md) (canonical identities and digests)

**Next** → [Persistent Local State Store](state.md) — inspect fenced authority and recovery state.
