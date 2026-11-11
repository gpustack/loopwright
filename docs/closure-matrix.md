# Capability Closure Matrix and Failure Semantics

`@loopwright/cli` sits at the top of the workspace build graph, so it is the one package that can audit
every other package. The closure matrix turns that position into a machine-verifiable receipt:
a frozen 23-row capability ledger, a repository evidence audit, a non-falsification guard for
unprovisioned external gates, and a deterministic 14-scenario cross-package failure harness. Operators
and automated gates run one command, `loopwright closure`, and read one versioned `Envelope`.

## Contents

- [Frozen capability ledger](#frozen-capability-ledger)
- [Non-falsification invariant](#non-falsification-invariant)
- [Repository evidence integrity](#repository-evidence-integrity)
- [Integrated failure matrix](#integrated-failure-matrix)
- [Closure command](#closure-command)
- [Cost and environment](#cost-and-environment)

## Frozen capability ledger

`CLOSURE_CAPABILITY_LEDGER` is a deeply frozen array of exactly 23 `ClosureCapabilityEntry` rows with
distinct ids, one primary owner per workspace package. Eighteen rows are `closed_local` with
`verificationStatus: 'passed'`; they carry an `evidenceLevel` of `unit_and_integration`,
`controlled_local_qualification`, or `frozen_offline_parity`. Five rows carry
`evidenceLevel: 'unprovisioned_external'` and stay honestly blocked:

| Capability | Owner | Disposition | Status |
| --- | --- | --- | --- |
| `external-build-and-accelerator-matrix` | `@loopwright/controller` | `blocked_external` | `blocked` |
| `remote-host-loss-and-durable-wake` | `@loopwright/state` | `blocked_external` | `not_run` |
| `interactive-mcp-oauth-browser-flow` | `@loopwright/github-app` | `deferred_owned` | `blocked` |
| `deployed-github-app-and-webhook-ingress` | `@loopwright/github-app` | `blocked_external` | `not_run` |
| `live-provider-billing-and-effort-attestation` | `@loopwright/agent-pi` | `deferred_owned` | `not_run` |

Every row names a closure criterion, a residual boundary, and at least one `evidencePaths` entry that
resolves to a committed regular file in the repository. Non-passed rows must carry a non-empty
`unlockPrerequisite`; passed rows must not.

## Non-falsification invariant

Local unit tests, mocks, or container fixtures can never upgrade an unprovisioned external gate. Any
supplied entry with `evidenceLevel: 'unprovisioned_external'` that claims `disposition: 'closed_local'`
or `verificationStatus: 'passed'` fails closed with `CLOSURE_FALSIFICATION_FORBIDDEN` unless a matching
`ExternalQualificationReceipt` is supplied and verified. A valid receipt carries the capability id, a
non-empty `targetEnvironment`, an `artifactSha256` matching `^[0-9a-f]{64}$`, a `verifierSignature`
matching `^[0-9a-f]{64,}$`, and a positive integer `issuedAtMs`. Nothing else counts as proof.

## Repository evidence integrity

With a repository root supplied, `verifyClosureLedgerIntegrity` audits every evidence path with `lstat`
and `realpath`: paths must be relative without `..` segments, resolve inside the real repository root,
and be regular files without symbolic links. Missing evidence fails with `CLOSURE_EVIDENCE_MISSING`;
traversal, symlinks, escapes, or the presence of `.github/workflows` in the audited root fail with
`CLOSURE_EVIDENCE_UNTRUSTED`.

## Integrated failure matrix

`runIntegratedFailureMatrix` executes 14 deterministic scenarios in-process against the real public APIs
of `@loopwright/core`, `@loopwright/state`, `@loopwright/agent-pi` (`describePiAdapterFiles` adapter
inventory and `decodePiCapture` binding refusal), `@loopwright/controller`, `@loopwright/taskpack-runner`,
`@loopwright/memory`, `@loopwright/github-app`, and `@loopwright/decisions`. Every scenario asserts the
exact refusal code and
the preserved invariant; `options.scenarioOverrides` lets negative tests force a single failure and prove
the report and exit-code contract.

1. `malformed_or_conflicting_json_submission` — `JSON_DUPLICATE_MEMBER`, `CONFIG_SYNTAX`,
   `CONFIG_DUPLICATE_KEY`; zero state mutation.
2. `forged_test_pass_without_verifier_evidence` — `EVIDENCE_CONTRADICTORY`, `EVIDENCE_MISSING`,
   `RUN_ACCEPTANCE_REQUIRED`; a claimed pass never survives failed or missing verifier evidence.
3. `missing_provider_usage_retained_reservation` — an unresolved dispatch (`timeout`) keeps its
   reservation charged; `DecisionBudgetTracker.retainUnknown()` records `unknownUsageRetained`.
4. `nested_tool_double_debit_prevention` — protected-path tool writes are blocked before execution and
   dispatch fencing re-issues the same permit, so the parent reservation charges exactly once; the frozen
   `describePiAdapterFiles()` inventory resolves and `decodePiCapture` refuses a capture bound to a
   foreign resource identity with `BINDING_MISMATCH`.
5. `provider_and_decision_deadline_timeout` — a hanging transport routes to the deterministic fallback
   with `DECISION_DEADLINE_EXCEEDED`, one transport call, and retained unknown usage.
6. `concurrent_owner_and_budget_exhaustion` — `OWNER_HELD` refuses the takeover and `BUDGET_EXHAUSTED`
   refuses over-budget admission; the ledger stays untouched.
7. `signal_interruption_and_workspace_loss` — cancelled cycles exit `130`/`143`, a missing run root
   reports the unavailable source without creating it, and `STATE_UNAVAILABLE` maps to exit `8`.
8. `unknown_external_effect_reconcile_gate` — missing or mismatched receipts refuse reconciliation with
   `EVIDENCE_UNAVAILABLE` before any replay; `RECEIPT_CONFLICT` maps to the stable exit `7`.
9. `expired_or_stale_gate_token_rejection` — HMAC gate tokens fail closed on tampering, rotation, or
   malformed signatures; `AUTHORITY_REFUSED` maps to exit `7`.
10. `mutated_pr_head_publication_abort` — the loopback runner service refuses publication with
    `revise_head_changed` when the pull-request head moves past the registered `prHeadSha` pin; no
    force-push exists.
11. `stale_memory_source_exclusion` — `selectActiveMemory` excludes expired and fingerprint-stale
    entries deterministically from active context.
12. `compaction_pending_operation_preservation` — `COMPACTION_UNSAFE_BOUNDARY` refuses unsafe
    boundaries; `buildCompactionSummary` pins the unsettled operations in the digest-stamped summary and
    `restoreFromCompactionLedger` replays them, refusing a dropped pending operation with
    `COMPACTION_AUTHORITY_VIOLATION`.
13. `untrusted_taskpack_and_oauth_boundary_refusal` — `TASKPACK_SCOPE_VIOLATION` refuses protected-path
    escalation; `MCP_OAUTH_UNSUPPORTED` and `MCP_AUTHENTICATION_REQUIRED` refuse interactive OAuth.
14. `decision_authority_escalation_refusal` — `DECISION_AUTHORITY_VIOLATION` refuses non-delegable
    intents; `DECISION_DISCLOSURE_VIOLATION` stops secret-bearing state with zero transport calls.

## Closure command

```sh
loopwright closure [--repo DIR] [--output FILE] [--json] [--verify-failures]
```

The command evaluates the frozen ledger against `--repo DIR` (default: the working directory), and with
`--verify-failures` also runs the failure matrix. `--output FILE` writes the encoded report atomically
and refuses to overwrite an existing file. `--json` emits one `Envelope` (`kind: 'closure'`,
`sequence: 1`, `runId: null`, `data`: the `ClosureMatrixReport`); the default mode prints a concise
summary.

Exit codes: `0` when integrity holds, no falsification is detected, the summary counts stay at
18 closed local and 5 unprovisioned external, and (under `--verify-failures`) all 14 scenarios pass;
`3` on falsification or a capability invariant violation; `4` when `--verify-failures` observes a failed
scenario; `8` on missing or untrusted evidence; `2` on usage errors.

## Cost and environment

The command is offline, credential-free, and Docker-free. Thirteen scenarios finish in well under a
second combined; the runner loopback publication probe spends roughly two to three seconds on its git
fixture and frozen validators, so a full `--verify-failures` audit takes about three seconds on a
qualified workstation. Local Node `26.x` with the installed workspace graph is the only requirement.

**See also**: [Documentation index](README.md)

**Next**: [Architecture](getting-started/architecture.md)
