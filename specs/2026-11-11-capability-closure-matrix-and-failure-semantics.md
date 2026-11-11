# Spec: Capability Closure Matrix, Residual Ledger, and Integrated Failure Semantics

Status: Shipped
Type: Feature

## Summary

Add a machine-verifiable **Capability Closure Matrix**, **Frozen Residual Ledger**, and **Integrated Failure-Semantics Verification Harness** to `@loopwright/cli` (and expose `loopwright closure` on the public command-line interface) so operators and automated gates can audit every architectural capability and residual boundary across the Loopwright workspace (`@loopwright/core`, `@loopwright/state`, `@loopwright/agent-pi`, `@loopwright/controller`, `@loopwright/cli`, `@loopwright/taskpack-runner`, `@loopwright/memory`, `@loopwright/github-app`, and `@loopwright/decisions`), execute all 14 cross-package failure-semantics probes deterministically offline, and guarantee that unprovisioned external, hardware, or deployment gates are never falsely reported as passed.

## Motivation

### Goals

- Provide a canonical, schema-validated **Capability Closure Ledger** (`CLOSURE_CAPABILITY_LEDGER`, 23 entries) covering every core software capability (`18` `closed_local` entries) and every external/deferred operational boundary (`5` `deferred_owned` or `blocked_external` entries: `external-build-and-accelerator-matrix`, `remote-host-loss-and-durable-wake`, `interactive-mcp-oauth-browser-flow`, `deployed-github-app-and-webhook-ingress`, and `live-provider-billing-and-effort-attestation`).
- Enforce a strict **Non-Falsification Invariant** (`CLOSURE_FALSIFICATION_FORBIDDEN`): any capability with `evidenceLevel: 'unprovisioned_external'` must remain `'blocked_external'` or `'deferred_owned'` (with `verificationStatus: 'blocked'` or `'not_run'` and a non-empty `unlockPrerequisite`) unless an authenticated, hash-bound `ExternalQualificationReceipt` is explicitly supplied and verified. Local unit, mock, or container fixture tests must never upgrade an unprovisioned external gate to `'closed_local'` or `'passed'`.
- Verify repository evidence integrity (`verifyClosureLedgerIntegrity`): every `evidencePaths` reference in the ledger must resolve to a committed, regular file inside the repository root without symlink traversal, absolute host paths, or `.github/workflows` files.
- Provide an **Integrated Failure-Semantics Verification Harness** (`runIntegratedFailureMatrix`) that exercises all **14 canonical cross-package failure scenarios** deterministically against the real public APIs of `@loopwright/core`, `@loopwright/state`, `@loopwright/agent-pi`, `@loopwright/controller`, `@loopwright/taskpack-runner`, `@loopwright/memory`, `@loopwright/github-app`, and `@loopwright/decisions`, proving that each failure mode triggers its exact refusal/diagnostic code while preserving state, budget, disclosure, and publication invariants.
- Expose a deterministic, zero-Docker `loopwright closure [--repo DIR] [--verify-failures] [--json] [--output FILE]` CLI command in [main.ts](../packages/cli/src/main.ts) and [arguments.ts](../packages/cli/src/arguments.ts) that emits a versioned `Envelope` (`kind: 'closure'`) and maps closure outcomes to stable exit codes (`0` when all local capabilities pass and external gates remain honestly classified, `3` on capability/falsification refusal, `4` on failure-scenario regression, `2` on usage error, and `8` on I/O or repository unavailability).

### Non-Goals

- Provisioning live cloud infrastructure, external multi-architecture image builders, physical GPU/NPU accelerators (`CUDA`, `CANN`, `ROCm`, `RDMA`), or deployed GitHub App webhook receivers.
- Implementing interactive browser-based MCP OAuth login or token-refresh flows (`auth.mode: 'oauth'` remains explicitly refused pre-admission via `MCP_OAUTH_UNSUPPORTED`).
- Modifying existing runtime semantics in `@loopwright/core`, `@loopwright/state`, `@loopwright/agent-pi`, or `@loopwright/controller`.
- Deleting `packages/taskpack-runner/vendor/runner-auto-sync` in this specification (the frozen offline parity corpus remains pinned and verified here; target-repository declarative preset migration is tracked as a separate follow-on).
- Creating `.github/workflows/` CI/CD files or performing any remote `git push` or package publication.

## Proposal

Extend `@loopwright/cli` at the top of the workspace build graph so it can inspect and exercise all workspace packages, and add two cohesive modules plus CLI wiring and documentation:

1. **Frozen Capability & Residual Closure Ledger (`packages/cli/src/closure.ts`)**:
   - Defines `ClosureCapabilityId` (23 canonical IDs), `ClosureDisposition` (`'closed_local' | 'deferred_owned' | 'blocked_external'`), `ClosureEvidenceLevel` (`'unit_and_integration' | 'controlled_local_qualification' | 'frozen_offline_parity' | 'unprovisioned_external'`), `ClosureSubsystem`, `ClosureOwnerPackage`, `ClosureCapabilityEntry`, `ExternalQualificationReceipt`, `ClosureEvaluationOptions`, and `ClosureMatrixReport`.
   - Exports the frozen `CLOSURE_CAPABILITY_LEDGER` constant and `evaluateClosureMatrix(options?)` / `verifyClosureLedgerIntegrity(repoRoot, entries?)`.
2. **Integrated Cross-Package Failure-Semantics Matrix (`packages/cli/src/failure-matrix.ts`)**:
   - Defines `IntegratedFailureScenarioId` (14 canonical scenario IDs), `IntegratedFailureScenarioResult`, and `IntegratedFailureMatrixReport`.
   - Exports `INTEGRATED_FAILURE_SCENARIO_IDS` and `runIntegratedFailureMatrix(options?)`, which runs all 14 cross-package failure probes and returns per-scenario diagnostic codes, assertions verified, elapsed milliseconds, and aggregate pass/fail counts.
3. **CLI Subcommand & Public Package Barrel (`packages/cli/src/arguments.ts`, `packages/cli/src/main.ts`, `packages/cli/src/index.ts`, `docs/closure-matrix.md`)**:
   - Adds `closure` to `parseArguments` (`values: ['repo', 'output']`, `flags: ['json', 'verify-failures']`, `required: []`).
   - Extends `Envelope['kind']` in [main.ts](../packages/cli/src/main.ts) with `'closure'`.
   - Exports all public CLI, closure-matrix, and failure-matrix symbols from `packages/cli/src/index.ts`.

### User Stories

#### Story 1
As a Loopwright release engineer, I want a deterministic `loopwright closure --verify-failures --json` command that audits all 23 capability and residual ledger rows against committed repository evidence and executes all 14 cross-package failure scenarios, so that I can verify harness readiness from a single machine-readable receipt without conflating local fixture passes with unprovisioned external gates.

#### Story 2
As a security and reliability auditor, I want any attempt to mark an `unprovisioned_external` capability (`external-build-and-accelerator-matrix`, `remote-host-loss-and-durable-wake`, `interactive-mcp-oauth-browser-flow`, `deployed-github-app-and-webhook-ingress`, `live-provider-billing-and-effort-attestation`) as `closed_local` or `passed` without a hash-bound `ExternalQualificationReceipt` to fail closed with `CLOSURE_FALSIFICATION_FORBIDDEN`, so that missing hardware, cloud, or deployment proof can never be silently waived.

#### Story 3
As a harness maintainer integrating `@loopwright/core`, `@loopwright/state`, `@loopwright/agent-pi`, `@loopwright/controller`, `@loopwright/taskpack-runner`, `@loopwright/memory`, `@loopwright/github-app`, and `@loopwright/decisions`, I want an automated 14-scenario failure-semantics suite that tests malformed JSON, forged test passes, missing usage retention, nested tool accounting, provider/decision timeouts, duplicate owner fencing, signal cancellation, unknown external effect reconciliation, expired gate tokens, mutated PR heads, stale memory exclusion, pending-operation compaction preservation, untrusted taskpack/OAuth refusal, and decision authority escalation, so that cross-package safety boundaries cannot regress.

### Core Features & Acceptance Criteria

#### Feature 1: Frozen 23-Row Capability Closure Ledger & Non-Falsification Guard (`AC-1`)
- `CLOSURE_CAPABILITY_LEDGER` contains exactly **23** frozen entries with distinct `ClosureCapabilityId` values across two groups, with every workspace package (`core`, `state`, `agent-pi`, `controller`, `cli`, `taskpack-runner`, `memory`, `github-app`, `decisions`) as a primary owner:
  - **18 Locally Closed Capabilities (`disposition: 'closed_local'`, `verificationStatus: 'passed'`):
    1. `'exclusive-owner-and-unknown-usage'` (`@loopwright/controller`, `evidenceLevel: 'controlled_local_qualification'`)
    2. `'frozen-runner-parity-corpus'` (`@loopwright/taskpack-runner`, `evidenceLevel: 'frozen_offline_parity'`)
    3. `'frozen-sdk-and-resource-inventory'` (`@loopwright/agent-pi`, `evidenceLevel: 'controlled_local_qualification'`)
    4. `'external-name-and-repair-cap-controls'` (`@loopwright/core`, `evidenceLevel: 'unit_and_integration'`)
    5. `'contract-adversarial-review-coverage'` (`@loopwright/core`, `evidenceLevel: 'unit_and_integration'`)
    6. `'duplicate-json-pointer-rejection'` (`@loopwright/core`, `evidenceLevel: 'unit_and_integration'`)
    7. `'immutable-elapsed-clock-basis'` (`@loopwright/state`, `evidenceLevel: 'unit_and_integration'`)
    8. `'qualified-host-clock-and-storage-profile'` (`@loopwright/github-app`, `evidenceLevel: 'unit_and_integration'`)
    9. `'state-interface-and-sqlite-limits'` (`@loopwright/state`, `evidenceLevel: 'unit_and_integration'`)
    10. `'admission-error-precedence'` (`@loopwright/state`, `evidenceLevel: 'unit_and_integration'`)
    11. `'pre-send-context-bound-and-estimated-guard'` (`@loopwright/agent-pi`, `evidenceLevel: 'controlled_local_qualification'`)
    12. `'digest-pinned-runtime-image-availability'` (`@loopwright/agent-pi`, `evidenceLevel: 'controlled_local_qualification'`)
    13. `'trusted-config-interpolation-and-mcp-token'` (`@loopwright/controller`, `evidenceLevel: 'controlled_local_qualification'`)
    14. `'mcp-nested-deadline-and-limits-accounting'` (`@loopwright/agent-pi`, `evidenceLevel: 'controlled_local_qualification'`)
    15. `'retained-store-clock-drift-and-reopen-guard'` (`@loopwright/state`, `evidenceLevel: 'unit_and_integration'`)
    16. `'controller-recovery-cancellation-and-cli-surface'` (`@loopwright/cli`, `evidenceLevel: 'controlled_local_qualification'`)
    17. `'reviewed-memory-and-cas-compaction'` (`@loopwright/memory`, `evidenceLevel: 'unit_and_integration'`)
    18. `'system-one-decision-routing-and-benchmark'` (`@loopwright/decisions`, `evidenceLevel: 'unit_and_integration'`)
  - **5 Explicit External / Deferred Capability Gates (`evidenceLevel: 'unprovisioned_external'`)**:
    19. `'external-build-and-accelerator-matrix'` (`@loopwright/controller`, `disposition: 'blocked_external'`, `verificationStatus: 'blocked'`)
    20. `'remote-host-loss-and-durable-wake'` (`@loopwright/state`, `disposition: 'blocked_external'`, `verificationStatus: 'not_run'`)
    21. `'interactive-mcp-oauth-browser-flow'` (`@loopwright/github-app`, `disposition: 'deferred_owned'`, `verificationStatus: 'blocked'`)
    22. `'deployed-github-app-and-webhook-ingress'` (`@loopwright/github-app`, `disposition: 'blocked_external'`, `verificationStatus: 'not_run'`)
    23. `'live-provider-billing-and-effort-attestation'` (`@loopwright/agent-pi`, `disposition: 'deferred_owned'`, `verificationStatus: 'not_run'`)
- Every entry in `CLOSURE_CAPABILITY_LEDGER` is deeply frozen (`Object.freeze`) and validated for:
  - Non-empty `title`, `closureCriterion`, `residualBoundary`, and `evidencePaths` (`>= 1` relative path).
  - Non-empty `unlockPrerequisite` whenever `disposition !== 'closed_local'` or `verificationStatus !== 'passed'`.
  - **Non-Falsification Guard**: If any entry with `evidenceLevel === 'unprovisioned_external'` is supplied or overridden with `disposition === 'closed_local'` or `verificationStatus === 'passed'` without a valid matching `ExternalQualificationReceipt` (`capabilityId`, `targetEnvironment`, `artifactSha256` matching `/^[0-9a-f]{64}$/`, `verifierSignature` matching `/^[0-9a-f]{64,}$/`, `issuedAtMs > 0`), `evaluateClosureMatrix` fails closed with `CLOSURE_FALSIFICATION_FORBIDDEN`.
  - **Repository Evidence Integrity**: When `repoRoot` is provided, `verifyClosureLedgerIntegrity(repoRoot, entries)` verifies via `lstat` and `realpath` that every path in `evidencePaths` is a relative path without `..` or leading `/`, resolves inside `realpath(repoRoot)`, is a regular file (`isFile() && !isSymbolicLink()`), and that `.github/workflows` does not exist in `repoRoot`. Missing or symlinked evidence files fail closed with `CLOSURE_EVIDENCE_MISSING` or `CLOSURE_EVIDENCE_UNTRUSTED`.

#### Feature 2: 14-Scenario Integrated Cross-Package Failure-Semantics Matrix (`AC-2`)
- `runIntegratedFailureMatrix(options?)` executes **14 deterministic failure scenarios** across the workspace packages and returns an `IntegratedFailureMatrixReport` (`version: 1`, `total: 14`, `passed: number`, `failed: number`, `allPassed: boolean`, `scenarios: readonly IntegratedFailureScenarioResult[]`):
  1. `'malformed_or_conflicting_json_submission'`: Exercises `@loopwright/core` contract/JSON duplicate-pointer validation and `@loopwright/controller` parser refusal on non-JSON and duplicate-key JSON payloads, confirming `JSON_DUPLICATE_MEMBER` (core `validateDocument`), `CONFIG_SYNTAX` / `CONFIG_DUPLICATE_KEY` (controller `loadTrustedConfiguration` parser), and zero state mutation.
  2. `'forged_test_pass_without_verifier_evidence'`: Exercises `@loopwright/core` acceptance evaluation (`evaluateAcceptance` and `constructRunResult`) when an agent claims `'completed'` while required verification evidence is `'failed'`, `'blocked'`, `'not_run'`, or missing, confirming refusal of `'completed'` status.
  3. `'missing_provider_usage_retained_reservation'`: Exercises `@loopwright/state` admission reservation and `@loopwright/decisions` `DecisionBudgetTracker` when a dispatch completes or aborts with missing/unknown usage, confirming unrefunded reservation accounting (`markRequestUnresolved` with unresolved reason `'timeout'` in `@loopwright/state`; `DecisionBudgetTracker.retainUnknown()` recording `unknownUsageRetained: true` in `@loopwright/decisions`).
  4. `'nested_tool_double_debit_prevention'`: Exercises the `@loopwright/core` writable-path scope guard and `@loopwright/state` dispatch fencing to verify that a denied protected-path tool write is blocked before execution and an authorized request re-issues the same dispatch permit, so the parent model-send reservation never double-debits and the tool allowlist holds.
  5. `'provider_and_decision_deadline_timeout'`: Exercises `@loopwright/decisions` `DecisionClient` + `evaluateDecision` when a transport hangs past `hardDeadlineMs`, confirming `AbortController` cancellation, `unknown_retained` budget accounting, and deterministic fallback routing (`DECISION_DEADLINE_EXCEEDED`).
  6. `'concurrent_owner_and_budget_exhaustion'`: Exercises `@loopwright/state` single-writer lease acquisition and budget admission when a second owner attempts concurrent takeover or when token/cost budget is exhausted, confirming `OWNER_HELD` refusal (`OWNER_BUSY` as the mapped controller diagnostic), `BUDGET_EXHAUSTED` budget refusal, and zero duplicate execution.
  7. `'signal_interruption_and_workspace_loss'`: Exercises `@loopwright/cli` `executionExit` / `diagnosticExit` and `readStatus` on `SIGINT` (`130`), `SIGTERM` (`143`), and missing `runRoot` (the unavailable source report, `STATE_UNAVAILABLE` mapping to exit `8`) without creating or mutating the missing directory.
  8. `'unknown_external_effect_reconcile_gate'`: Exercises `@loopwright/controller` publication/reconcile boundary when an external publication receipt is missing or mismatched, confirming refusal before any replay (`EVIDENCE_UNAVAILABLE`) plus the `RECEIPT_CONFLICT` (`exit 7`) mapping, and refusal of blind replay.
  9. `'expired_or_stale_gate_token_rejection'`: Exercises `@loopwright/controller` authenticated gate verification when a gate token is expired, tampered, or bound to a stale generation/digest, confirming `AUTHORITY_REFUSED` refusal.
  10. `'mutated_pr_head_publication_abort'`: Exercises the `@loopwright/taskpack-runner` loopback publication service (`startRunnerTaskpackService`) when the PR head moves past the registered `prHeadSha` pin or the candidate diverges from the registered `candidateDigest` (forced via `fakeHumanCommit` / `headMutation`), confirming publication refusal without force-pushing.
  11. `'stale_memory_source_exclusion'`: Exercises `@loopwright/memory` prompt assembly and staleness validation when a reviewed memory record's source commit/digest or TTL is stale, confirming deterministic exclusion from active context.
  12. `'compaction_pending_operation_preservation'`: Exercises `@loopwright/memory` compaction policy (`evaluateCompactionPolicy`, `buildCompactionSummary`) when the compaction checkpoint reference is invalid, tool calls are unpaired, or external operations remain unsettled (`COMMIT_UNKNOWN` / pending receipt), confirming `COMPACTION_UNSAFE_BOUNDARY` refusal and that `pendingExternalOperations` stay pinned in the compaction checkpoint summary (`restoreFromCompactionLedger` replays them).
  13. `'untrusted_taskpack_and_oauth_boundary_refusal'`: Exercises `@loopwright/github-app` `parseTaskpackDocument` / `validateTaskpackManifest` on protected-path escalation (`.github/workflows/ci.yml`) and `validateMcpAuthConfiguration` on interactive OAuth (`auth.mode: 'oauth'`), confirming `TASKPACK_SCOPE_VIOLATION` and `MCP_OAUTH_UNSUPPORTED` (plus `MCP_AUTHENTICATION_REQUIRED` on a 401/403 `WWW-Authenticate` transport challenge).
  14. `'decision_authority_escalation_refusal'`: Exercises `@loopwright/decisions` `assertDecisionAuthorityBoundary` on non-delegable intents from `DECISION_FORBIDDEN_AUTHORITY_INTENTS` (`certify_verification_evidence`, `approve_external_gate`) and `evaluateDecision` on secret-bearing state (refused via `sanitizeDecisionState`), confirming `DECISION_AUTHORITY_VIOLATION` and `DECISION_DISCLOSURE_VIOLATION` with zero transport calls.
- Supports injecting a custom scenario fault override in tests (`options.scenarioOverrides`) so negative tests can prove that a single failing scenario flips `report.allPassed` to `false`, increments `report.failed`, and causes `loopwright closure --verify-failures` to exit with code `4`.

#### Feature 3: Public CLI `closure` Subcommand & Envelope Contract (`AC-3`)
- `parseArguments` in [arguments.ts](../packages/cli/src/arguments.ts) accepts `closure` with optional `--repo DIR`, `--output FILE`, `--json`, and `--verify-failures`, and rejects unknown flags, duplicate flags, or positional extras with `UsageError` (`exit 2`).
- `main` in [main.ts](../packages/cli/src/main.ts) handles `args.command === 'closure'`:
  - Resolves `repoRoot` from `--repo` when supplied (or defaults to `process.cwd()`).
  - Evaluates the closure matrix against `repoRoot` (`evaluateClosureMatrix({ repoRoot, verifyFailures: args.flags.has('verify-failures') })`).
  - If `--output FILE` is supplied, writes the encoded JSON report atomically via `writeOutput`.
  - Emits an `Envelope` (`version: 1`, `kind: 'closure'`, `sequence: 1`, `runId: null`, `data: report`) to `stdout` in `--json` mode or a concise human summary in default mode.
  - Returns exit code:
    - `0` when `report.integrity.ok === true`, `report.falsificationDetected === false`, `report.summary.closedLocal === 18`, `report.summary.unprovisionedExternal === 5`, and (when `--verify-failures` is set) `report.failureMatrix.allPassed === true`.
    - `3` when `report.falsificationDetected === true` or a capability invariant is violated (`CAPABILITY_UNSUPPORTED` / `CLOSURE_FALSIFICATION_FORBIDDEN`).
    - `4` when `--verify-failures` is set and any failure scenario fails (`report.failureMatrix.allPassed === false`).
    - `8` when `repoRoot` or a required evidence file is missing/untrusted (`CLOSURE_EVIDENCE_MISSING` / `CLOSURE_EVIDENCE_UNTRUSTED`).

#### Feature 4: Workspace Build Order & Documentation (`AC-4`)
- Root [package.json](../package.json) builds `packages/cli/tsconfig.json` after all library packages (`core`, `state`, `agent-pi`, `controller`, `taskpack-runner`, `memory`, `decisions`, `github-app`) so `@loopwright/cli` can import directly from every workspace package without circular dependencies.
- `packages/cli/package.json` declares workspace dependencies on `@loopwright/core`, `@loopwright/state`, `@loopwright/agent-pi`, `@loopwright/controller`, `@loopwright/taskpack-runner`, `@loopwright/memory`, `@loopwright/github-app`, and `@loopwright/decisions`, and exports both `.` (`./dist/index.js`) and `./main` (`./dist/main.js`).
- `docs/closure-matrix.md` documents the 23-row Capability Closure Matrix, the Non-Falsification Invariant, the 14 Integrated Failure-Semantics scenarios, and the `loopwright closure` CLI usage.

### Notes / Constraints / Caveats

- All 8 existing CLI commands (`--help`, `--version`, `init`, `check`, `run`, `resume`, `reconcile`, `status`, `inspect`) and their exact exit codes and envelope formats in [main.ts](../packages/cli/src/main.ts) and [arguments.test.ts](../packages/cli/test/arguments.test.ts) must remain 100% backwards-compatible.
- Do not modify any files in `packages/core/`, `packages/state/`, `packages/agent-pi/`, or `packages/controller/` so that all frozen native qualification hashes in `packages/controller/qualification/` remain untouched.
- Every file in `packages/cli/src/`, `packages/cli/test/`, `docs/closure-matrix.md`, and `specs/` must remain free of private host filesystem paths, local scratch report directories, prototype directories, and internal program shorthand identifiers.

### Boundaries

- **Always:**
  - Freeze all exported ledger constants (`CLOSURE_CAPABILITY_LEDGER`, `INTEGRATED_FAILURE_SCENARIO_IDS`).
  - Keep `unprovisioned_external` rows in `'blocked_external'` or `'deferred_owned'` status unless a verified `ExternalQualificationReceipt` is supplied.
  - Verify `lstat` / `realpath` containment on all `evidencePaths` when auditing a repository root.
- **Ask first:**
  - Any change to the 23 canonical `ClosureCapabilityId` identifiers or 14 `IntegratedFailureScenarioId` identifiers.
  - Any modification to `@loopwright/core`, `@loopwright/state`, `@loopwright/agent-pi`, or `@loopwright/controller`.
- **Never:**
  - Mark `external-build-and-accelerator-matrix`, `remote-host-loss-and-durable-wake`, `interactive-mcp-oauth-browser-flow`, `deployed-github-app-and-webhook-ingress`, or `live-provider-billing-and-effort-attestation` as `'closed_local'` or `'passed'` from local software tests.
  - Create `.github/workflows/` files or perform network/Docker calls inside `loopwright closure`.

### Risks and Mitigations

- **Risk:** Adding workspace dependencies to `@loopwright/cli` could alter the build order or break `packages/controller/qualification/native-bridge.test.mjs` if `core`, `state`, `agent-pi`, or `controller` are touched.
  - **Mitigation:** Keep `core`, `state`, `agent-pi`, and `controller` completely untouched, and place `tsc -p packages/cli/tsconfig.json` last in the root `build` script in [package.json](../package.json).
- **Risk:** Cross-package failure scenarios in `runIntegratedFailureMatrix` could be slow if they spawn subprocesses or wait on long wall-clock timers.
  - **Mitigation:** Drive all 14 scenarios in-process against the public TypeScript APIs with the 100ms `hardDeadlineMs` policy floor as the longest injected wait, and temp directories cleaned up in `finally` blocks; the 13 in-process probes finish in under 300ms combined and the loopback publication probe adds roughly two to three seconds, so the full matrix completes in under five seconds on a qualified workstation.

## Design Details

### Commands

Environment: local only (developer workstation, POSIX shell). Node `26.x` and npm `11.x` per the root `engines` fields. Build and test need no Docker, credentials, network, or accelerator. Shared controller cycle fixtures append to a scratch registry under the gitignored root `.claude` directory; a fresh checkout creates the expected directory and empty file before running CLI subprocess tests.

```bash
npm run build
npm run typecheck
npm run lint
npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-build/packages/cli/test/*.test.js
npm test
```

### Project Structure

```text
packages/cli/
  package.json                              # Workspace dependencies + "." and "./main" exports
  tsconfig.json                             # Strict TypeScript config for @loopwright/cli
  src/
    arguments.ts                            # CLI argument parser (adds "closure" subcommand)
    closure.ts                              # 23-row Capability Closure Ledger, integrity audit, and non-falsification guard
    draft.ts                                # Existing credential-free draft initializer
    failure-matrix.ts                       # 14-scenario cross-package Integrated Failure-Semantics harness
    index.ts                                # Public programmatic barrel for @loopwright/cli
    main.ts                                 # CLI entrypoint (adds "closure" command and HELP line)
  test/
    arguments.test.ts                       # Existing + extended CLI argument & subprocess tests
    closure-and-failure-matrix.test.ts      # Unit, negative/falsification, and subprocess tests for closure & failure matrix
docs/
  closure-matrix.md                         # Architecture & operator documentation for the closure matrix and failure harness
```

### Code Style

Follow strict ESM TypeScript (`NodeNext`, no `any`, explicit `readonly` properties, deterministic error codes) matching [main.ts](../packages/cli/src/main.ts) and [types.ts](../packages/decisions/src/types.ts):

```typescript
export type ClosureDisposition = 'closed_local' | 'deferred_owned' | 'blocked_external';

export type ClosureEvidenceLevel =
  | 'unit_and_integration'
  | 'controlled_local_qualification'
  | 'frozen_offline_parity'
  | 'unprovisioned_external';

export interface ClosureCapabilityEntry {
  readonly id: ClosureCapabilityId;
  readonly title: string;
  readonly subsystem: ClosureSubsystem;
  readonly ownerPackage: ClosureOwnerPackage;
  readonly disposition: ClosureDisposition;
  readonly verificationStatus: 'passed' | 'failed' | 'blocked' | 'not_run';
  readonly evidenceLevel: ClosureEvidenceLevel;
  readonly closureCriterion: string;
  readonly residualBoundary: string;
  readonly unlockPrerequisite: string | null;
  readonly evidencePaths: readonly string[];
}
```

### Implementation Plan

Four tasks form a clean DAG. T1 is the prefactor (make the workspace graph ready, then the easy change). T2 and T3 are pure additive modules; the CLI runtime behavior is unchanged until T4 wires them. Every symbol and error code named below was verified against the current workspace exports (no invented APIs). `packages/core/`, `packages/state/`, `packages/agent-pi/`, and `packages/controller/` are never touched.

- [x] **T1 · Workspace build order, CLI dependencies/exports, and `closure` argument parser (prefactor)**
      Blocked by: None
      Owns: `package.json` (root `build` script order only), `packages/cli/package.json`, `packages/cli/src/arguments.ts`, `packages/cli/test/arguments.test.ts`
      Gate: review
      Acceptance: Root `build` compiles `packages/cli/tsconfig.json` last, after `core`, `state`, `agent-pi`, `controller`, `taskpack-runner`, `memory`, `decisions`, and `github-app`. `packages/cli/package.json` declares workspace dependencies on all eight library packages and exports `.` (`./dist/index.js`) and `./main` (`./dist/main.js`). `parseArguments` accepts exactly `closure [--repo DIR] [--output FILE] [--json] [--verify-failures]` (`values: ['repo', 'output']`, `flags: ['json', 'verify-failures']`, `required: []`) and rejects unknown/duplicate flags and positional extras with `UsageError`. All existing 8 command shapes and their tests stay unchanged and green. T4 wires execution later; this task only widens the parser and the graph.
      Verify: `npm run build && npm run typecheck && npm run lint && npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-build/packages/cli/test/*.test.js`
- [x] **T2 · 23-row frozen `CLOSURE_CAPABILITY_LEDGER` with integrity audit and non-falsification guard**
      Blocked by: None
      Owns: `packages/cli/src/closure.ts`
      Acceptance: New self-contained module (only `node:` builtins; no workspace imports). Defines the exact 23 frozen entries from Feature 1 (18 `closed_local` including `reviewed-memory-and-cas-compaction` and `system-one-decision-routing-and-benchmark`; 5 `unprovisioned_external`), all exported types from Feature 1, a deeply frozen `CLOSURE_CAPABILITY_LEDGER`, `verifyClosureLedgerIntegrity(repoRoot, entries?)` with `lstat`/`realpath` containment (relative paths, no `..`, regular files, no symlinked evidence, `.github/workflows` absence; `CLOSURE_EVIDENCE_MISSING` / `CLOSURE_EVIDENCE_UNTRUSTED` refusals), `evaluateClosureMatrix(options?)` with the fail-closed `CLOSURE_FALSIFICATION_FORBIDDEN` guard including full `ExternalQualificationReceipt` validation (`capabilityId` match, `targetEnvironment`, `artifactSha256` `/^[0-9a-f]{64}$/`, `verifierSignature` `/^[0-9a-f]{64,}$/`, `issuedAtMs > 0`), and `ClosureMatrixReport` exposing `integrity`, `falsificationDetected`, and `summary` counts (`closedLocal: 18`, `unprovisionedExternal: 5`).
      Verify: `npm run build && npm run typecheck && npm run lint`
- [x] **T3 · 14-scenario cross-package `runIntegratedFailureMatrix`**
      Blocked by: T1
      Owns: `packages/cli/src/failure-matrix.ts`, `packages/taskpack-runner/src/index.ts` (one-line additive barrel export of `computeRunnerCandidateDigest`)
      Acceptance: New module importing only public APIs of the eight library packages. Exports frozen `INTEGRATED_FAILURE_SCENARIO_IDS` (14 canonical IDs from Feature 2) and `runIntegratedFailureMatrix(options?)` returning `IntegratedFailureMatrixReport` (`version: 1`, `total: 14`, `passed`, `failed`, `allPassed`, per-scenario `IntegratedFailureScenarioResult` with diagnostic code, assertions verified, elapsed milliseconds). Runs all 14 scenarios in-process with the exact verified refusals: `JSON_DUPLICATE_MEMBER` / `CONFIG_SYNTAX` / `CONFIG_DUPLICATE_KEY` (scenario 1), `evaluateAcceptance` + `constructRunResult` refusal of forged `completed` (scenario 2), `markRequestUnresolved('timeout')` + `DecisionBudgetTracker.retainUnknown()` (scenario 3), `TOOL_DENIED`-class allowlist enforcement without double debit: protected-path tool writes are blocked before execution, single-permit dispatch fencing charges the parent reservation exactly once, `describePiAdapterFiles()` resolves the frozen adapter inventory, and `decodePiCapture` refuses a capture bound to a foreign resource identity with `BINDING_MISMATCH` (scenario 4), `DECISION_DEADLINE_EXCEEDED` fallback at the `hardDeadlineMs` policy floor of 100ms (scenario 5), `OWNER_HELD` / `BUDGET_EXHAUSTED` (scenario 6), `executionExit` / `diagnosticExit` on SIGINT 130 / SIGTERM 143 / `STATE_UNAVAILABLE` 8 without touching a missing `runRoot` (scenario 7), `reconcileCycle` refusing a missing or mismatched receipt before any replay, with the `RECEIPT_CONFLICT` exit-7 mapping (scenario 8), `signPayload` / `verifySignedPayload` gate tamper and staleness to `AUTHORITY_REFUSED` (scenario 9), `startRunnerTaskpackService` publication refusal on mutated `prHeadSha` (scenario 10), `selectActiveMemory` staleness exclusion reasons (scenario 11), `evaluateCompactionPolicy` `COMPACTION_UNSAFE_BOUNDARY` with `pendingExternalOperations` pinned, `buildCompactionSummary` pinning them in the digest-stamped summary, and `restoreFromCompactionLedger` replaying them and refusing a dropped pending operation with `COMPACTION_AUTHORITY_VIOLATION` (scenario 12), `validateTaskpackManifest` `TASKPACK_SCOPE_VIOLATION` + `validateMcpAuthConfiguration` `MCP_OAUTH_UNSUPPORTED` / `MCP_AUTHENTICATION_REQUIRED` (scenario 13), and `assertDecisionAuthorityBoundary` `DECISION_AUTHORITY_VIOLATION` + `sanitizeDecisionState` `DECISION_DISCLOSURE_VIOLATION` with zero transport calls (scenario 14). Honors `options.scenarioOverrides` fault injection for negative tests. Temp directories cleaned in `finally`; the 13 in-process probes complete in under 300ms combined and the runner loopback publication probe adds roughly two to three seconds, so the full matrix completes in under five seconds; deterministic offline (no network, Docker, or wall-clock waits beyond the injected deadlines).
      Verify: `npm run build && npm run typecheck && npm run lint`
- [x] **T4 · `loopwright closure` CLI wiring, barrel, docs, and behavioral tests**
      Blocked by: T1, T2, T3
      Owns: `packages/cli/src/main.ts`, `packages/cli/src/index.ts`, `docs/closure-matrix.md`, `packages/cli/test/closure-and-failure-matrix.test.ts`
      Acceptance: `main` handles `args.command === 'closure'` per Feature 3 (`repoRoot` from `--repo` or `process.cwd()`; `evaluateClosureMatrix`; `--output` written via `writeOutput`; `Envelope` with `kind: 'closure'`, `sequence: 1`, `runId: null`; `--json` envelope vs concise human summary; HELP line extended). Exit mapping: `0` only when `integrity.ok` and no falsification and summary counts 18/5 and (`--verify-failures` implies `failureMatrix.allPassed`); `3` on `CLOSURE_FALSIFICATION_FORBIDDEN` / `CAPABILITY_UNSUPPORTED`; `4` on any failed failure scenario under `--verify-failures`; `8` on `CLOSURE_EVIDENCE_MISSING` / `CLOSURE_EVIDENCE_UNTRUSTED`; `2` on usage error. `packages/cli/src/index.ts` barrels all public CLI, closure, and failure-matrix symbols. `docs/closure-matrix.md` documents the 23-row matrix, the Non-Falsification Invariant, the 14 scenarios, and CLI usage. `closure-and-failure-matrix.test.ts` covers unit, negative/falsification (fake receipt rejected; override flips `allPassed` and exit to 4), evidence-integrity (missing/symlinked evidence to 8), parser-usage (unknown flag to 2), and real subprocess happy-path (exit 0, counts 18/5) cases in the existing `arguments.test.ts` subprocess style. All pre-existing CLI tests stay unchanged and green; every new file stays free of forbidden host/scratch/program-shorthand strings.
      Verify: `npm run build && npm run typecheck && npm run lint && npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-build/packages/cli/test/*.test.js && npm test`

Order and parallelism: T1 and T2 have disjoint `Owns:` and can start together; T3 follows T1; T4 integrates everything and stays last so every intermediate state builds, lints, and passes the existing suites. T1 carries `Gate: review` because a wrong root build order silently breaks every later task's build (see Risks and Mitigations). No PoC task: the environment was smoke-checked (build, typecheck, lint, CLI test subset all green on this workstation).

### Test Plan
[ ] I/we understand the owners of the involved components may require updates to existing tests to make this
code solid enough prior to committing the changes necessary to implement this enhancement.

#### Prerequisite testing updates
- None in other packages: `core`, `state`, `agent-pi`, and `controller` stay untouched; their suites remain the regression baseline and must pass unchanged (`npm test`).
- Environment prerequisite: the existing controller cycle-fixture helper appends to a scratch registry under the gitignored root `.claude` directory; create the expected directory and empty file before running CLI subprocess tests on a fresh checkout.
- Backward compatibility: every existing `arguments.test.ts` case (8 command shapes, exit mappings, encoding, subprocess behavior) must stay green; T1 only adds `closure` cases to the same file.

#### Unit tests
- `@loopwright/cli`: `2026-11-11` - full branch coverage of `closure.ts` and `failure-matrix.ts` (no coverage reporter is configured in this repo, so coverage is enforced by assertion suites enumerating every ledger validation rule, falsification-guard branch, receipt-validation branch, evidence-integrity branch, each of the 14 scenarios, and the `scenarioOverrides` flip). `arguments.ts` closure shapes are covered in `arguments.test.ts`.

#### Integration tests
- The 14-scenario matrix itself is the cross-package integration suite, run in-process against the real public APIs of all eight library packages with the exact diagnostic codes listed in T3.
- Subprocess integration against the built `main.js`: `loopwright closure --json` happy path (exit `0`, counts 18/5, envelope `kind: 'closure'`), `--verify-failures` with an injected failing scenario (exit `4`), falsification attempt (exit `3`), missing/untrusted evidence (exit `8`), unknown flag (exit `2`) — mirroring the existing `arguments.test.ts` subprocess style.

#### e2e tests
- Not needed: the subprocess integration above drives the real `loopwright closure` entrypoint end-to-end on the local host. The spec's non-goals exclude any deployed surface, so no deployed e2e environment exists to test against.

## Alternatives

- **Markdown-only closure table without executable verification:** Rejected because a static prose table cannot verify that referenced evidence files still exist in the repository, cannot enforce the `CLOSURE_FALSIFICATION_FORBIDDEN` guard programmatically, and cannot run the 14 cross-package failure scenarios as an automated regression gate.
- **Placing the closure matrix inside `@loopwright/core`:** Rejected because `@loopwright/core` is the leaf package of the dependency graph and cannot import `@loopwright/state`, `@loopwright/agent-pi`, `@loopwright/controller`, `@loopwright/taskpack-runner`, `@loopwright/memory`, `@loopwright/github-app`, or `@loopwright/decisions` to run the integrated failure-semantics harness.

## Open Questions

None.
