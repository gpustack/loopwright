# Spec: Hardware execution, benchmark-gate.v1, and outbound remote runner

Status: Building
Type: Feature

## Summary

Unlock verified `hardware_execution` workflows across Loopwright. Preserve sandbox containment, lease fencing, and local closure honesty. Extend `target.matrix` cells and `TaskContract` checks in `@loopwright/core` and `@loopwright/taskpack` with accelerator metadata, `hardwareProvenance`, and `metricThresholds`. Add `benchmark-gate.v1` in `@loopwright/controller` for HMAC-signed remote compilation, blind correctness checks, performance gating, preemption-safe requeue, and streamed CAS artifacts. Introduce `@loopwright/hardware-runner` and `loopwright runner` CLI commands to run an outbound-only pull-lease relay and two-stage zero-trust GPU/NPU worker.

## Motivation

### Goals

Loopwright already defines `MetricsMap` and `StructuredFinding` in [`contracts.ts`](../packages/core/src/contracts.ts) and [`evidence.ts`](../packages/core/src/evidence.ts). It also verifies HMAC-signed `gate.v1` verdicts in [`gate.ts`](../packages/controller/src/gate.ts) and streams `1 MiB` CAS blobs up to `16 GiB` ([`2026-11-20-decouple-taskpack-and-cas-blob-pointers.md`](2026-11-20-decouple-taskpack-and-cas-blob-pointers.md)). Four gaps still block heterogeneous kernel and hardware optimization tasks:

1. **Hard `hardware_execution` blocks**: [`compile.ts`](../packages/controller/src/compile.ts) refuses every `'hardware_execution'` check (`CAPABILITY_UNSUPPORTED`). [`refusal-record.ts`](../packages/controller/src/refusal-record.ts) also refuses `hardware_execution` subjects during recovery (`RECOVERY_REQUIRED`), and `target.matrix` in [`contracts.ts`](../packages/core/src/contracts.ts) stores only `{ id, platform, variant }`.
2. **No core hardware provenance or metric bounds**: [`acceptance.ts`](../packages/core/src/acceptance.ts) carries raw `MetricsMap` values without Roofline/latency/speedup/error rules or physical hardware fingerprint checks.
3. **No preemption-safe requeue**: [`gate.ts`](../packages/controller/src/gate.ts) parses `retryablePreemption`, but no queue requeues evicted read-only GPU jobs or suppresses false LLM repairs.
4. **No outbound-only blind worker**: Private intranet and Kubernetes GPU/NPU clusters forbid inbound ports and require two-stage blind isolation for `held_out_workloads`.

Target users are kernel engineers, ML systems developers, verification owners, and GPU/NPU cluster operators. Success criteria:

- Compile and verify `hardware_execution` checks end-to-end when bound to a host-owned `benchmark-gate.v1` endpoint and hardware `target.matrix` cell.
- If a `hardware_execution` check lacks a hardware cell or `benchmark-gate.v1` handler, refuse compilation (`CAPABILITY_UNSUPPORTED` or `CONFIG_SCHEMA`).
- Enforce `hardwareProvenance`, `metricThresholds` (`bounds` and `comparative`), and SHA-256 CAS blobs in both `benchmark-gate.v1` and `@loopwright/core` `evaluateAcceptance`.
- Requeue preempted read-only worker leases (`leased/running -> preempted -> queued`) at the Relay under a monotonic `leaseEpoch` fence.
- If the preemption budget is exhausted, settle the check as `blocked` (`BENCHMARK_PREEMPTED`) rather than `failed`.
- Keep the 23-row closure split (`18` `closedLocal`, `5` `unprovisionedExternal`) intact in [`closure.ts`](../packages/cli/src/closure.ts) without an `ExternalQualificationReceipt`.

### Non-Goals

- Multi-generation evolutionary search, lineage trees, MCTS, or MAP-Elites campaign stores (deferred to Phase 3.3).
- Benchmark suite manifests (`suite.yaml`), compact agent handoff formats, or local deterministic evaluation harnesses.
- Centralized external databases, multi-node consensus stores, or web dashboards.
- Built-in RFC 6455 WebSocket server framing or any new third-party runtime npm dependency.
- Hardware TEE or TPM remote attestation of compromised worker host kernels (the Relay trusts enrolled worker supervisors via scoped worker credentials).
- Relaxing sandbox or authority guards: no default `/var/run/docker.sock` passthrough, no unapproved `.github/workflows/**` writes, and no silent `external_write` retries.

## Proposal

Extend `@loopwright/core`, `@loopwright/controller`, `@loopwright/taskpack`, `@loopwright/github-app`, and `@loopwright/cli`, and add `@loopwright/hardware-runner` as the eleventh workspace package. Bind hardware targets in contracts, enforce `benchmark-gate.v1` provenance and quantitative thresholds, and requeue preempted read-only GPU leases safely. Compile candidate overlays in Stage A without private workloads, then run Stage B blind benchmarks against read-only `held_out_workloads` with `networkMode: 'none'` and zero file exports.

### User Stories

#### Story 1

As a kernel or systems engineer, I want to declare accelerator architecture, isolation mode, and driver or topology constraints in `target.matrix` and unlock `hardware_execution` checks only when a host-owned `benchmark-gate.v1` verifier is bound, so that hardware tasks compile deterministically and fail closed when hardware verification is unconfigured.

#### Story 2

As a verification owner, I want `benchmark-gate.v1` to require an HMAC-signed physical hardware fingerprint, quantitative Roofline/latency/speedup/error bounds, and SHA-256-verified CAS binary artifacts (`.cubin`, `.o`, `.sass`), so that candidates cannot spoof speedups, weaken numerical accuracy, or pass on synthetic or mismatched hardware.

#### Story 3

As a cluster operator running low-priority GPU workloads under schedulers such as Kubernetes Kueue, I want read-only hardware evaluation preemptions to requeue within a bounded budget and fenced lease epoch while keeping uncertain `external_write` effects in `reconcile_required`, so that spot or preemptible GPU eviction does not fail valid candidates or violate side-effect safety.

#### Story 4

As an infrastructure security engineer operating private intranet GPU/NPU clusters with zero inbound ports, I want an outbound-only runner worker that pulls leased jobs, compiles candidate artifacts before mounting private `held_out_workloads` read-only inside an OS or Docker sandbox, exports zero Stage B files, and streams back signed `Evidence` and Stage A CAS blobs, so that private workloads, agent sessions, and controller credentials never leak.

### Core Features & Acceptance Criteria

#### 1. Hardware `target.matrix`, Quantitative Thresholds, and Core Provenance (`@loopwright/core`, `@loopwright/taskpack`, `@loopwright/github-app`)

- **Backward-compatible hardware `target.matrix` cells**:
  - Add an optional `hardware` object to `target.matrix[]` in [`contracts.ts`](../packages/core/src/contracts.ts) and [`types.ts`](../packages/taskpack/src/types.ts) alongside `{ id, platform, variant }`:
    - `accelerator`: non-empty label (`1..64` chars, such as `sm_89`, `sm_90a`, `sm_100a`, `ascend_910b`, or `gfx1101`).
    - `isolationMode`: `'whole_device' | 'sliced'`.
    - `deviceCount`: optional safe integer (`1..64`).
    - `driverConstraint`: optional printable constraint (`1..128` chars, supporting exact match or `>=<dotted-version>`).
    - `topology`: optional label (`1..128` chars).
  - Omit unset optional fields from canonical JSON so `hashDomain('target-matrix', target.matrix)` in [`identity.ts`](../packages/core/src/identity.ts) stays unchanged for existing contracts.
  - Preserve full hardware cells, `targetCellId`, and `metricThresholds` through [`taskpack.ts`](../packages/taskpack/src/taskpack.ts) compilation. Project `{ id, platform, variant }` only at [`turnkey-memory.ts`](../packages/taskpack/src/turnkey-memory.ts) and [`packages/github-app/src/turnkey-memory.ts`](../packages/github-app/src/turnkey-memory.ts) so [`packages/memory/src/schema.ts`](../packages/memory/src/schema.ts) stays unchanged.
- **Check hardware bindings and `metricThresholds` in `TaskContract` and `Taskpack`**:
  - Add optional `targetCellId`, `allowSyntheticHardwareProbe` (optional boolean, default `false`), and `metricThresholds` (`0..32` entries) to `TaskContract.spec.acceptance.checks[]` in [`contracts.ts`](../packages/core/src/contracts.ts) and `spec.verification.externalGates[]` in [`schema.ts`](../packages/taskpack/src/schema.ts).
  - If `allowedEvidenceLevels` includes `'hardware_execution'`, require unmixed `allowedEvidenceLevels: ['hardware_execution']` and verify that `targetCellId` matches a `target.matrix` cell with `hardware`.
  - Support `kind: 'bounds'` rules (`{ kind: 'bounds', metric, min?, max? }`) requiring at least one endpoint (`min <= max`, finite numbers, `-0` normalized to `0` in `@loopwright/core`).
  - Support `kind: 'comparative'` rules (`{ kind: 'comparative', metric, baselineMetric, operator: 'min_ratio' | 'max_ratio' | 'max_delta', threshold }`). Require finite numeric metrics (`baseline > 0` for ratios; `candidate - baseline <= threshold` for `max_delta`).
- **`hardwareProvenance`, verifier CAS budget, and independent core verification**:
  - Add optional `hardwareProvenance` to `Evidence.spec` in [`evidence.ts`](../packages/core/src/evidence.ts): `{ targetCellId, probeKind: 'physical' | 'synthetic_fixture', vendor, deviceModel, accelerator, isolationMode, deviceCount, driverVersion, runtimeVersion, topology?, workloadDigest, clockLockMode: 'locked' | 'unlocked' | 'unknown' }`.
  - If `Evidence.spec.level === 'hardware_execution'` and `observedStatus === 'passed'`, require `hardwareProvenance`.
  - Add `HARDWARE_PROVENANCE_MISMATCH` and `METRIC_THRESHOLD_FAILED` to [`diagnostics.ts`](../packages/core/src/diagnostics.ts). Update both `reasonSchema` and `verificationSchema` in [`acceptance.ts`](../packages/core/src/acceptance.ts) for `'hardware_provenance_mismatch'` and `'metric_threshold_failed'`.
  - In `evaluateValidated` ([`acceptance.ts`](../packages/core/src/acceptance.ts)), verify `probeKind` (`'physical'` required unless `allowSyntheticHardwareProbe === true`), `targetCellId`, `accelerator`, `isolationMode`, exact `deviceCount`, `topology`, and `driverConstraint`.
  - Evaluate every `metricThresholds` rule against `evidence.spec.metrics`. If a `passed` claim violates a threshold or misses numeric metrics, downgrade the row to `blocked` (`metric_threshold_failed`).
  - Account verifier-namespaced descriptors (`.loopwright-verifier/<slotId>/...`) under a dedicated verifier output budget in [`artifacts.ts`](../packages/core/src/artifacts.ts) so `.cubin`/`.o`/`.sass` outputs never consume candidate `overlay.maxBytes`.
- **Acceptance criteria**:
  - Existing `{ id, platform, variant }` `TaskContract` and `TaskLock` fixtures keep identical `contractHash`, `lockHash`, and `targetMatrixDigest` values.
  - If passing `hardware_execution` `Evidence` uses `probeKind: 'synthetic_fixture'` without opt-in, mismatches hardware, or violates a threshold, `evaluateAcceptance` and `constructRunResult` refuse completion.

#### 2. Host-Owned `benchmark-gate.v1`, CAS Streaming, and Preemption-Safe Requeue (`@loopwright/controller`, `@loopwright/taskpack`, `@loopwright/cli`)

- **Bidirectional `hardware_execution` unlock and host-owned endpoint authority**:
  - Register `'benchmark-gate.v1'` in [`types.ts`](../packages/controller/src/types.ts), [`handlers.ts`](../packages/controller/src/handlers.ts), and [`registry.ts`](../packages/controller/src/registry.ts) with `kind: 'check'` and `capabilities: ['hardware_execution', 'read_only']`.
  - Enforce a bidirectional rule in [`compile.ts`](../packages/controller/src/compile.ts). Every `'hardware_execution'` check must use `'benchmark-gate.v1'` with a valid hardware `targetCellId` and host `gateEndpoints` binding, and every `'benchmark-gate.v1'` slot must target `'hardware_execution'`. Refuse violations with `CAPABILITY_UNSUPPORTED` or `CONFIG_SCHEMA`.
  - In [`schema.ts`](../packages/taskpack/src/schema.ts) and [`taskpack.ts`](../packages/taskpack/src/taskpack.ts), forbid manifest-level `url`, `signingCredentialRef`, and `authCredentialRef` overrides on `benchmark-gate.v1` gates. Resolve URLs and credentials strictly from host `gateEndpoints` bindings.
  - Update `checkedRefusalSubject` in [`refusal-record.ts`](../packages/controller/src/refusal-record.ts) to remove only the blanket `hardware_execution` throw while preserving `bindSubject` `targetMatrixDigest` verification.
- **`benchmark-gate.v1` request, CAS staging/retrieval, and verdict ingestion**:
  - Stage candidate overlay and base-tree blobs to the Relay over HMAC-authenticated `PUT /v1/benchmark/jobs/:operationId/blobs/:sha256` (`redirect: 'error'`), separate from worker lease credentials.
  - Send HMAC-SHA256-signed `benchmark_request` payloads (`64 KiB` cap) containing dispatch bindings, `targetCellId`, `targetHardware`, `heldOutWorkloadId`, `metricThresholds`, `maxPreemptions` (`0..16`, default `3`), and candidate overlay CAS descriptors (including deletions).
  - Verify HMAC-SHA256-signed `benchmark_verdict` payloads via `crypto.timingSafeEqual` with `status`, `reason`, `expiresAtMs`, `metrics`, `findings`, `retryablePreemption`, `preemptionCount`, `hardwareProvenance`, and Stage A `outputArtifacts` (`0..64` entries).
  - Pull each `outputArtifacts` blob via `GET /v1/benchmark/jobs/:operationId/blobs/:sha256` into `<artifactsDir>/blobs/sha256/<hex>` through [`storage.ts`](../packages/controller/src/storage.ts) (`1 MiB` max buffer, `O_NOFOLLOW`, `nlink === 1`, `0o400` `fsync`, SHA-256/`byteLength` check). Scan binary outputs with `SecretScrubber` and reject secret-bearing blobs (`ARTIFACT_INVALID`) without mutating bytes.
  - Namespace output refs under `.loopwright-verifier/<slotId>/<name>` (`cas://sha256/<hex>`) and push locally verified `{ name, byteLength, digest }` descriptors in [`packages/controller/src/acceptance.ts`](../packages/controller/src/acceptance.ts).
  - Record genuine measured threshold misses as `VerifiedCheck.status = 'failed'` (allowing `implementationRepair` / `onRework`), and record provenance, secret, or CAS validation failures as `status = 'blocked'`.
- **Single-owner Relay preemption requeue and recovery/reconcile parity**:
  - Record `benchmark-gate.v1` in `LocalRunStore` as one `read_only` `OperationIntent` per `(slot, generation)`, keeping `phaseSchedule` (`D <= 256`) in [`progress.ts`](../packages/controller/src/progress.ts) unchanged.
  - Keep `preemptionCount` exclusively at the Relay (`one` idempotent job per `(operationId, dispatchId, requestDigest)`). Controller `POST` polls remain idempotent within `pollDeadlineMono` and renew the SQLite store lease via [`retained.ts`](../packages/controller/src/retained.ts).
  - When Relay evictions exceed `maxPreemptions` or `pollDeadlineMono` expires on a preempted job, settle `VerifiedCheck.status = 'blocked'` (`reason: 'BENCHMARK_PREEMPTED'`, `retryablePreemption: true`), never `'failed'`. Keep `BENCHMARK_PREEMPTED` out of `prepareImplementationRepair()` and `onRework` in [`controller.ts`](../packages/controller/src/controller.ts).
  - Extend [`recovery.ts`](../packages/controller/src/recovery.ts), [`retained.ts`](../packages/controller/src/retained.ts), [`packages/controller/src/acceptance.ts`](../packages/controller/src/acceptance.ts), and [`reconcile.ts`](../packages/controller/src/reconcile.ts) for `'benchmark-gate.v1'`. Allow `loopwright reconcile` to settle a signed `benchmark_verdict` receipt (after verifying local/pulled CAS blobs) only before `resumeCycle` settles timeout (`blocked`), while uncertain `external_write` operations stay `reconcile_required`.
- **Honest capability closure ledger (`@loopwright/cli`)**:
  - Add `'@loopwright/hardware-runner'` to `OWNER_PACKAGES` in [`closure.ts`](../packages/cli/src/closure.ts) and update `evidencePaths` on `external-build-and-accelerator-matrix`.
  - Keep `external-build-and-accelerator-matrix` as `blocked_external` / `blocked` / `unprovisioned_external` (`18` `closedLocal`, `5` `unprovisionedExternal`). Refuse promotion without an `ExternalQualificationReceipt` (`CLOSURE_FALSIFICATION_FORBIDDEN`).
- **Acceptance criteria**:
  - `compilePlan` refuses `hardware_execution` on `gate.v1` or byte verifiers, refuses manifest `url` overrides on `benchmark-gate.v1`, and succeeds on a host-bound `benchmark-gate.v1` slot.
  - Three worker preemptions under `maxPreemptions: 3` requeue (`leaseEpoch = 1..4`) and succeed on the fourth worker; a fourth preemption settles `blocked` (`BENCHMARK_PREEMPTED`) with zero implementation repairs.
  - `loopwright closure --verify-failures` passes with `18` `closedLocal` and `5` `unprovisionedExternal` rows.

#### 3. `@loopwright/hardware-runner` Outbound Pull-Lease Relay and Two-Stage Blind Worker (`packages/hardware-runner`, `@loopwright/cli`, `scripts/`)

- **Dedicated workspace package and CLI surface**:
  - Create `packages/hardware-runner` (`@loopwright/hardware-runner`) depending only on `@loopwright/core` and `@loopwright/taskpack` (reusing `parseYamlDocument` and `readBoundedRegularFile` from [`packages/taskpack/src/index.ts`](../packages/taskpack/src/index.ts) with zero direct `yaml` dependency).
  - Register `packages/hardware-runner` in [`package.json`](../package.json), [`tsconfig.test.json`](../tsconfig.test.json), [`.opencodereview/rule.json`](../.opencodereview/rule.json), [`packages/cli/package.json`](../packages/cli/package.json), [`packages/cli/tsconfig.json`](../packages/cli/tsconfig.json), [`scripts/build.mjs`](../scripts/build.mjs), [`scripts/run-tests.mjs`](../scripts/run-tests.mjs), [`scripts/pack-npm.mjs`](../scripts/pack-npm.mjs), and `UNMANAGED_WORKSPACES` in [`scripts/prepare-self-upgrade.mjs`](../scripts/prepare-self-upgrade.mjs) and [`.auto-sync/checks/verify.sh`](../.auto-sync/checks/verify.sh).
  - Add `loopwright runner relay --config <FILE>` and `loopwright runner worker --config <FILE> [--once]` in [`arguments.ts`](../packages/cli/src/arguments.ts) and [`main.ts`](../packages/cli/src/main.ts).
- **Relay-authoritative pull-lease state machine and streaming HTTP CAS plane**:
  - Generate a random `relayBootId` at Relay startup. Enforce Relay-side monotonic `ClockSource` TTLs and `1,000ms` drift checks (matching [`tenant-queue.ts`](../packages/github-app/src/tenant-queue.ts)), and separate controller HMAC keys from worker bearer tokens:
    1. `POST /v1/runner/leases:acquire`: verify worker bearer token, match `queued` `targetHardware` against worker capabilities, and grant `{ relayBootId, jobId, leaseEpoch, leaseToken, leaseTtlMs }` or return `204` after long-poll (`waitMs <= 25_000`).
    2. `POST /v1/runner/leases/:jobId:heartbeat`: verify `(relayBootId, leaseEpoch, leaseToken)` and Relay clock health, renew expiry, and return `{ desiredState: 'running' | 'cancel', leaseTtlMs }` (plus optional `GET /v1/runner/leases/:jobId/events` `text/event-stream` cancel watch).
    3. `POST /v1/runner/leases/:jobId:preempt`: on `SIGTERM` or Kubernetes Kueue eviction, count each evicted `leaseEpoch` at most once. If `preemptionCount + 1 <= maxPreemptions`, increment `preemptionCount` and requeue (`leased/running -> preempted -> queued`), else settle `preempted_exhausted` (`BENCHMARK_PREEMPTED`).
    4. **Expired lease sweep**: run periodic and on-request Relay timer sweeps. Fence dead workers whose `notAfterMonotonicMs` elapsed and requeue or settle the job without waiting for new acquisitions.
    5. `GET` and `PUT /v1/runner/leases/:jobId/blobs/:sha256`: authorize job-scoped input reads and Stage A output writes in `1 MiB` max buffers. Re-verify `(relayBootId, leaseEpoch, leaseToken)` before streaming and atomically at blob commit (`O_NOFOLLOW`, `nlink === 1`, `0o400`, `SecretScrubber` reject).
    6. `POST /v1/runner/leases/:jobId:complete`: verify `(relayBootId, leaseEpoch, leaseToken)` and job-bound CAS commits for all Stage A `outputArtifacts`. Persist the signed `benchmark_verdict` receipt in Relay `<casDir>` for `reconcile` retention and wake waiting controller polls (`409 QUEUE_LEASE_FENCED` on stale epochs or boot IDs).
- **Two-stage zero-trust blind evaluation (`native_os` and `docker`)**:
  - Exclude all agent sessions, scratch paths, and controller/provider secrets from Relay job payloads.
  - Execute every leased job in two isolated stages via [`sandbox.ts`](../packages/taskpack/src/sandbox.ts) (`native_os` `seatbelt`/`bwrap` or `docker` with `--network none`, `--read-only`, zero `/var/run/docker.sock`, and explicit GPU device flags such as `--gpus` or `/dev/kfd` + `/dev/dri`; fail closed if the requested backend or device isolation is unavailable):
    - **Stage A (Candidate Compile)**: mount only the frozen candidate tree and toolchain (`networkMode: 'none'`, **no `held_out_workloads` mount**). Hash and seal Stage A `.cubin`/`.o`/`.sass` outputs read-only before Stage B starts.
    - **Stage B (Blind Correctness & Benchmark)**: mount sealed Stage A artifacts and worker-local `held_out_workloads/<id>` read-only (`O_NOFOLLOW` across all ancestors and entries, `networkMode: 'none'`). Export **zero** files from Stage B, and parse only bounded numeric `metrics` and sanitized status/findings in the trusted worker supervisor.
  - Collect hardware provenance from trusted host binaries (`nvidia-smi`, `rocm-smi`, `npu-smi`) as `probeKind: 'physical'`, and mark test probes as `probeKind: 'synthetic_fixture'`.
- **Acceptance criteria**:
  - An outbound-only worker pulls a lease, compiles Stage A `.cubin`/`.sass` outputs without `held_out_workloads`, runs Stage B blind scoring against read-only `held_out_workloads` (`networkMode: 'none'`), uploads Stage A blobs, and settles a `completed` `RunResult`.
  - If a stale worker (`leaseEpoch = 1` or old `relayBootId`) calls `PUT .../blobs/:sha256` or `POST ...:complete`, the Relay rejects it with `409 QUEUE_LEASE_FENCED`.
  - Candidate code cannot read `held_out_workloads` during Stage A, cannot export files or open sockets during Stage B, and cannot read worker or Relay credentials.

### Notes / Constraints / Caveats

- Target Node.js `26.x` (`v26.13.1`), strict ESM (`NodeNext`), explicit public types, and zero `any` across all 11 workspace packages.
- Add **zero** new third-party runtime npm dependencies; reuse `@loopwright/taskpack` YAML helpers (`parseYamlDocument`, `readBoundedRegularFile`) in `@loopwright/hardware-runner` so `.auto-sync/proposal.json` and `.auto-sync/taskpack.yaml` need no `yaml` ledger changes.
- Validate untrusted JSON and YAML into `Object.create(null)` records using `Object.hasOwn`, reject lone UTF-16 surrogates, normalize `-0` to `0` in `@loopwright/core` while rejecting `-0` in controller/runner config parsers, and enforce early `64 KiB` control-body caps before buffering.
- Keep [`handlers.ts`](../packages/controller/src/handlers.ts) well below its `256`-file / `8 MiB` ceiling by placing relay and worker modules in `@loopwright/hardware-runner`.
- Keep all specs, code, docs, and commits tool-neutral and free of private hostnames or off-repo paths.

### Boundaries

- **Always:**
  - Verify `hardwareProvenance` (`probeKind`), `targetCellId`, `metricThresholds`, and locally sealed SHA-256 CAS blobs in both `benchmark-gate.v1` and `@loopwright/core` `evaluateAcceptance`.
  - Resolve `benchmark-gate.v1` URLs and credentials exclusively from host `gateEndpoints` bindings, never from untrusted `taskpack.yaml` overrides.
  - Separate Stage A compilation (artifact export permitted, no `held_out_workloads`) from Stage B blind benchmarking (`held_out_workloads` read-only, `networkMode: 'none'`, zero file exports).
  - Fence every worker lease and CAS commit with `(relayBootId, jobId, leaseEpoch, leaseToken)`, `O_NOFOLLOW`, `nlink === 1`, `0o400` sealing, and `SecretScrubber` binary rejection.
  - Settle exhausted read-only preemption budgets as `status: 'blocked'` (`reason: 'BENCHMARK_PREEMPTED'`), never `'failed'`, and preserve `reconcile_required` for uncertain `external_write` effects.
  - Preserve the 23-row closure split (`18` `closedLocal`, `5` `unprovisionedExternal`) in [`closure.ts`](../packages/cli/src/closure.ts).
- **Ask first:**
  - Before adding any third-party runtime npm dependency to any package.
  - Before modifying SQLite DDL in `@loopwright/state` or changing [`progress.ts`](../packages/controller/src/progress.ts) `phaseSchedule` checkpoint formulas.
  - Before changing the 23-row closure split or promoting `external-build-and-accelerator-matrix` without an `ExternalQualificationReceipt`.
- **Never:**
  - Never allow `taskpack.yaml` to redirect `benchmark-gate.v1` traffic or share controller-relay HMAC signing keys with workers.
  - Never mount `held_out_workloads` during Stage A compilation or export candidate-written files from Stage B blind evaluation.
  - Never silently retry uncertain `external_write` operations or let `BENCHMARK_PREEMPTED` trigger LLM implementation repairs.
  - Never pass `/var/run/docker.sock` into candidate sandboxes or claim physical accelerator closure from `synthetic_fixture` probes.

### Risks and Mitigations

- **Untrusted `taskpack.yaml` redirecting `benchmark-gate.v1` source overlays or bearer tokens** -> Mitigation: forbid manifest `url` and credential overrides on `benchmark-gate.v1`, resolving endpoints solely from host `gateEndpoints` bindings and isolating worker bearer tokens from Relay HMAC keys.
- **Candidate exfiltrating private `held_out_workloads` via exported `.cubin`/`.sass` binaries** -> Mitigation: run two-stage isolation where Stage A compiles and seals binaries without `held_out_workloads`, and Stage B mounts `held_out_workloads` read-only (`networkMode: 'none'`) with zero file exports.
- **Forged speedups, synthetic probes, or wrong-GPU execution passing core verification** -> Mitigation: require `probeKind: 'physical'` by default, bind `targetCellId`/`topology`/`driverConstraint`/`workloadDigest` in signed verdicts, and re-verify thresholds and provenance in `@loopwright/core` `evaluateValidated`.
- **Verifier `.cubin` outputs colliding with candidate paths or exhausting `overlay.maxBytes`** -> Mitigation: namespace verifier outputs under `.loopwright-verifier/<slotId>/`, verify local CAS files in [`packages/controller/src/acceptance.ts`](../packages/controller/src/acceptance.ts), and track verifier output bytes under a dedicated budget in [`artifacts.ts`](../packages/core/src/artifacts.ts).
- **Preemption multiplying retries across Controller and Relay or triggering destructive LLM repairs** -> Mitigation: keep `preemptionCount` exclusively at the Relay under one `OperationIntent`, fence Relay restarts via `relayBootId`, and settle exhausted budgets as `blocked` (`BENCHMARK_PREEMPTED`).
- **Zombie worker overwriting CAS blobs or verdicts after lease expiry** -> Mitigation: run periodic Relay expiry sweeps and recheck `(relayBootId, jobId, leaseEpoch, leaseToken)` before streaming and atomically at blob/verdict commit (`409 QUEUE_LEASE_FENCED`).
- **`@loopwright/memory` or `.auto-sync` breaking on hardware cells or the 11th workspace package** -> Mitigation: project `{ id, platform, variant }` at memory boundaries and reuse `@loopwright/taskpack` YAML helpers so `packages/hardware-runner` enters `UNMANAGED_WORKSPACES` cleanly.

## Design Details

### Commands

Primary build, lint, unit, and loopback integration suites run locally on macOS/Linux (`Node v26.13.1`, `npm 11.20.0`) with zero external network or physical GPU dependencies. Optional live multi-architecture smoke verification runs over SSH against Docker-enabled Linux CUDA (`nvidia-smi`) and ROCm (`rocm-smi` / `hipcc`) hosts when `LOOPWRIGHT_CUDA_SSH_HOST` or `LOOPWRIGHT_ROCM_SSH_HOST` is set (`node:26` container runtime when host Node differs from `26.x`).

```bash
# Sync workspace links for packages/hardware-runner and install cleanly
npm install --package-lock-only && npm ci

# Build all 11 workspace packages, typecheck, and lint
npm run build
npm run typecheck
npm run lint

# Validate connected docs and rebuild the Hugo site
npm run lint:docs
npm run site

# Compile tests and run targeted package suites (local deterministic offline/loopback)
npx tsc -p tsconfig.test.json
node scripts/run-tests.mjs --pkg core
node scripts/run-tests.mjs --pkg controller
node scripts/run-tests.mjs --pkg taskpack
node scripts/run-tests.mjs --pkg hardware-runner
node scripts/run-tests.mjs --pkg cli

# Full workspace test suite and 23-row closure audit
npm test
node packages/cli/dist/main.js closure --verify-failures --json

# Optional live SSH smoke verification against Linux CUDA / ROCm Docker hosts (on demand)
LOOPWRIGHT_CUDA_SSH_HOST="<user@cuda-host>" LOOPWRIGHT_ROCM_SSH_HOST="<user@rocm-host>" \
  node --test .test-build/packages/hardware-runner/test/live-ssh-smoke.test.js
```

### Project Structure

```text
packages/
  core/src/
    contracts.ts          # Hardware target.matrix cell metadata, unmixed hardware_execution, targetCellId, metricThresholds
    evidence.ts           # hardwareProvenance schema (+ probeKind, topology, workloadDigest)
    artifacts.ts          # Dedicated verifier output count/byte budget for .loopwright-verifier/<slotId>/* CAS refs
    diagnostics.ts        # + HARDWARE_PROVENANCE_MISMATCH, METRIC_THRESHOLD_FAILED
    acceptance.ts         # Independent provenance, driver/topology, and metricThresholds enforcement in evaluateValidated
    index.ts              # Export HardwareTargetSpec, MetricThresholdRule, HardwareProvenance types
  controller/src/
    types.ts              # + 'benchmark-gate.v1' Implementation and benchmark gate types
    handlers.ts           # Register 'benchmark-gate.v1' in installedHandlerDigests()
    registry.ts           # Validate 'benchmark-gate.v1' handler parameters and ['hardware_execution', 'read_only'] capabilities
    compile.ts            # Bidirectional hardware_execution <-> benchmark-gate.v1 fail-closed gate
    benchmark-gate.ts     # HMAC benchmark_request / verdict client, controller CAS stage/pull, BENCHMARK_PREEMPTED handling
    controller.ts         # Dispatch benchmark-gate.v1 slots; keep BENCHMARK_PREEMPTED out of implementationRepair/onRework
    recovery.ts           # Restore interrupted benchmark-gate.v1 slots and delegated repair checks
    retained.ts           # Extend resolveStoreLeaseMs for benchmark-gate.v1 endpoint timeouts
    acceptance.ts         # Authenticate benchmark-gate.v1 receipts and verify local .loopwright-verifier/* CAS descriptors
    reconcile.ts          # Operator reconciliation for signed benchmark_verdict receipts prior to timeout settlement
    refusal-record.ts     # Allow valid hardware_execution targetMatrixDigest in checkedRefusalSubject
  taskpack/src/
    types.ts              # Extend TargetMatrixCell (+ hardware) and TaskpackExternalGateDeclaration (+ benchmark-gate.v1)
    schema.ts             # Validate hardware cells, thresholds, maxPreemptions; forbid manifest url/cred overrides on benchmark-gate.v1
    taskpack.ts           # Preserve hardware cells/thresholds and compile host-bound benchmark-gate.v1 checks
    turnkey-memory.ts     # Project { id, platform, variant } for @loopwright/memory compatibility
  github-app/src/
    turnkey-memory.ts     # Project { id, platform, variant } for separate-pull-request memory compatibility
  hardware-runner/        # NEW 11th workspace package (@loopwright/hardware-runner)
    package.json          # Depends only on @loopwright/core and @loopwright/taskpack (zero direct yaml dependency)
    tsconfig.json         # Composite NodeNext build config
    src/
      index.ts            # Public relay, worker, queue, evaluator, and hardware probe exports
      types.ts            # Pull-lease state machine, RelayConfig, WorkerConfig, LeaseGrant, and wire schemas
      config.ts           # Bounded YAML/JSON loader via @loopwright/taskpack helpers (O_NOFOLLOW, null-prototype guards)
      queue.ts            # Relay-authoritative pull-lease queue (relayBootId, leaseEpoch, 1,000ms drift, expiry sweep)
      relay-server.ts     # Controller /v1/benchmark/jobs/* + worker /v1/runner/leases* + SSE watch + 1 MiB CAS routes
      worker.ts           # Outbound long-poll loop, heartbeat/cancel handler, SIGTERM preemption hook, and CAS streamer
      evaluator.ts        # Two-stage blind runner (Stage A compile -> Stage B read-only held_out_workloads, native_os/docker)
      provenance.ts       # Trusted accelerator probes (nvidia-smi, rocm-smi, npu-smi, and synthetic_fixture test probes)
  cli/src/
    arguments.ts          # + loopwright runner relay|worker CLI grammar
    main.ts               # Wire runner relay/worker commands
    closure.ts            # Add '@loopwright/hardware-runner' to OWNER_PACKAGES; keep 18/5 closure split honest
docs/ & site/             # Update module map, task-contract, taskpack, controller-and-registry, cli, and closure guides
```

### Code Style

```ts
// Independent core hardware provenance check in packages/core/src/acceptance.ts
export interface HardwareTargetSpec {
  readonly accelerator: string;
  readonly isolationMode: 'whole_device' | 'sliced';
  readonly deviceCount?: number;
  readonly driverConstraint?: string;
  readonly topology?: string;
}

export function matchesHardwareTarget(
  expected: HardwareTargetSpec,
  expectedCellId: string,
  allowSyntheticProbe: boolean,
  observed: Evidence['spec']['hardwareProvenance'],
): boolean {
  if (observed === undefined) return false;
  if (!allowSyntheticProbe && observed.probeKind !== 'physical') return false;
  if (observed.targetCellId !== expectedCellId) return false;
  if (observed.accelerator !== expected.accelerator) return false;
  if (observed.isolationMode !== expected.isolationMode) return false;
  if (expected.deviceCount !== undefined && observed.deviceCount !== expected.deviceCount) return false;
  if (expected.topology !== undefined && observed.topology !== expected.topology) return false;
  if (expected.driverConstraint !== undefined && !matchesDriverConstraint(expected.driverConstraint, observed.driverVersion)) {
    return false;
  }
  return true;
}
```

Key conventions:
- Validate every untrusted boundary into `Object.create(null)` records using `Object.hasOwn`, rejecting unknown keys and `NaN` / `Infinity` (`-0` normalized to `0` in `@loopwright/core`, rejected in controller/runner config parsers).
- Compare HMAC-SHA256 digests and lease tokens exclusively with `crypto.timingSafeEqual`.
- Stream CAS blobs from single verified `O_NOFOLLOW` file descriptors (`nlink === 1`) in `1 MiB` (`1_048_576`-byte) max application buffers, rejecting secret-bearing binaries via `SecretScrubber` without modifying bytes.

### Implementation Plan

- [x] **T1 · 11-package workspace prefactor and `@loopwright/hardware-runner` scaffold**
      Blocked by: None
      Owns: `package.json`, `package-lock.json`, `tsconfig.test.json`, `.opencodereview/rule.json`, `scripts/build.mjs`, `scripts/run-tests.mjs`, `scripts/pack-npm.mjs`, `scripts/prepare-self-upgrade.mjs`, `.auto-sync/checks/verify.sh`, `.auto-sync/digests.lock.json`, `packages/hardware-runner/package.json`, `packages/hardware-runner/tsconfig.json`, `packages/hardware-runner/src/index.ts`, `packages/hardware-runner/test/scaffold.test.ts`, `packages/cli/package.json`, `packages/cli/tsconfig.json`, `packages/cli/test/build-incremental.test.ts`, `packages/cli/test/npm-pack.test.ts`, `packages/github-app/test/self-upgrade-fixtures.ts`
      Gate: review
      Acceptance: `packages/hardware-runner` builds as the 11th workspace package depending only on `@loopwright/core` and `@loopwright/taskpack`, is bundled by `pack-npm.mjs`, is registered in `UNMANAGED_WORKSPACES` without `.auto-sync/proposal.json` churn, and passes incremental build and tarball install tests.
      Verify: `npm install --package-lock-only && npm ci && npm run build && npm run typecheck && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg hardware-runner && node --test .test-build/packages/cli/test/build-incremental.test.js .test-build/packages/cli/test/npm-pack.test.js`

- [x] **T2 · Core hardware `target.matrix`, `metricThresholds`, `hardwareProvenance`, and verifier CAS budget**
      Blocked by: T1
      Owns: `packages/core/src/**`, `packages/core/test/**`
      Gate: review
      Acceptance: `@loopwright/core` preserves legacy `{ id, platform, variant }` digests, enforces unmixed `['hardware_execution']` checks with hardware `targetCellId`, validates `bounds`/`comparative` `metricThresholds` and `hardwareProvenance` (`probeKind`, `topology`, `driverConstraint`, exact `deviceCount`), budgets `.loopwright-verifier/*` CAS descriptors separately from `overlay.maxBytes`, and blocks forged or mismatched `passed` claims in `evaluateAcceptance` and `constructRunResult`.
      Verify: `npm run build && npm run typecheck && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg core`

- [x] **T3 · Controller `benchmark-gate.v1`, CAS staging/ingestion, preemption settlement, and recovery/reconcile**
      Blocked by: T2
      Owns: `packages/controller/src/**`, `packages/controller/test/**`
      Gate: review
      Acceptance: `compile.ts` enforces bidirectional `hardware_execution` <-> `benchmark-gate.v1` binding; `benchmark-gate.ts` stages candidate CAS blobs, verifies HMAC verdicts, pulls `.loopwright-verifier/<slotId>/*` blobs (`O_NOFOLLOW`, `nlink === 1`, `0o400`, `SecretScrubber` binary reject), maps threshold misses to `failed` and `BENCHMARK_PREEMPTED` to `blocked` (zero `implementationRepair`/`onRework`), and preserves crash recovery, `refusal-record.ts`, and `loopwright reconcile` parity within `D <= 256` checkpoints.
      Verify: `npm run build && npm run typecheck && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg controller`

- [x] **T5 · Hardware-runner config, Relay-authoritative pull-lease queue, and HTTP/CAS relay server**
      Blocked by: T2
      Owns: `packages/hardware-runner/src/types.ts`, `packages/hardware-runner/src/config.ts`, `packages/hardware-runner/src/queue.ts`, `packages/hardware-runner/src/relay-server.ts`, `packages/hardware-runner/test/config.test.ts`, `packages/hardware-runner/test/queue.test.ts`, `packages/hardware-runner/test/relay-server.test.ts`
      Gate: review
      Acceptance: `config.ts` loads bounded YAML/JSON via `@loopwright/taskpack` helpers; `queue.ts` enforces `(relayBootId, jobId, leaseEpoch, leaseToken)` fencing, `1,000ms` Relay clock drift guards, timer expiry sweeps, and single-owner `preemptionCount`; `relay-server.ts` serves controller `/v1/benchmark/jobs/*`, worker `/v1/runner/leases*`, SSE cancel watch, `1 MiB` CAS streaming, `409 QUEUE_LEASE_FENCED` stale-epoch rejection, and `<casDir>` receipt retention.
      Verify: `npm run build && npm run typecheck && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg hardware-runner`

- [x] **T4 · Taskpack and GitHub App host-owned `benchmark-gate.v1` compilation and memory projection**
      Blocked by: T3
      Owns: `packages/taskpack/src/**`, `packages/taskpack/test/**`, `packages/github-app/src/turnkey-memory.ts`, `packages/github-app/test/turnkey-memory*.test.ts`
      Gate: review
      Acceptance: `@loopwright/taskpack` compiles hardware `target.matrix` cells, `targetCellId`, `metricThresholds`, and `maxPreemptions` into `benchmark-gate.v1` checks, rejects manifest-level `url`/credential overrides on `benchmark-gate.v1`, and projects `{ id, platform, variant }` cleanly in both `taskpack` and `github-app` memory finalizers.
      Verify: `npm run build && npm run typecheck && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg taskpack && node scripts/run-tests.mjs --pkg github-app`

- [ ] **T6 · Outbound worker loop, trusted GPU probes, two-stage blind sandbox evaluator, and loopback/SSH smoke tests**
      Blocked by: T3, T5
      Owns: `packages/hardware-runner/src/provenance.ts`, `packages/hardware-runner/src/evaluator.ts`, `packages/hardware-runner/src/worker.ts`, `packages/hardware-runner/src/index.ts`, `packages/hardware-runner/test/provenance.test.ts`, `packages/hardware-runner/test/evaluator.test.ts`, `packages/hardware-runner/test/worker.test.ts`, `packages/hardware-runner/test/e2e-nat-loopback.test.ts`, `packages/hardware-runner/test/live-ssh-smoke.test.ts`
      Gate: review
      Acceptance: Outbound worker handles long-poll acquisition, heartbeats, `SIGTERM`/Kueue preemption, CUDA/ROCm/Ascend + `synthetic_fixture` provenance probes, and two-stage blind execution (`native_os` and `docker`, Stage A `.cubin`/`.sass` seal without `held_out_workloads`, Stage B read-only `held_out_workloads` with `networkMode: 'none'` and zero file exports), passing full `Controller -> Relay -> Worker` loopback e2e and optional `$LOOPWRIGHT_CUDA_SSH_HOST` / `$LOOPWRIGHT_ROCM_SSH_HOST` smoke verification.
      Verify: `npm run build && npm run typecheck && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg hardware-runner`

- [ ] **T7 · CLI `loopwright runner relay|worker` subcommands and honest 23-row closure ledger**
      Blocked by: T4, T6
      Owns: `packages/cli/src/**`, `packages/cli/test/arguments.test.ts`, `packages/cli/test/closure-and-failure-matrix.test.ts`, `packages/cli/test/runner-cli.test.ts`
      Gate: review
      Acceptance: `loopwright runner relay --config <FILE>` and `loopwright runner worker --config <FILE> [--once]` parse and execute cleanly, `closure.ts` includes `'@loopwright/hardware-runner'` in `OWNER_PACKAGES` and `external-build-and-accelerator-matrix` `evidencePaths`, and `closure --verify-failures` preserves `18` `closedLocal` and `5` `unprovisionedExternal` rows while rejecting falsified promotion (`CLOSURE_FALSIFICATION_FORBIDDEN`).
      Verify: `npm run build && npm run typecheck && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg cli && node packages/cli/dist/main.js closure --verify-failures --json`

- [ ] **T8 · Connected documentation, Hugo site, skill references, and full 11-package verification**
      Blocked by: T7
      Owns: `docs/**`, `site/**`, `README.md`, `AGENTS.md`, `.agents/skills/**`, `packages/cli/test/check-docs-rules.test.ts`, `packages/cli/test/docs-and-site.test.ts`
      Acceptance: Module map (`docs/README.md` under existing module IDs), `task-contract.md`, `taskpack.md`, `controller-and-registry.md`, `cli.md`, `closure-matrix.md`, `AGENTS.md`, and Hugo `site/` document hardware `target.matrix`, `benchmark-gate.v1`, and `loopwright runner`, passing all build, lint, docs, site, test, and closure gates.
      Verify: `npm run build && npm run typecheck && npm run lint && npm run lint:docs && npm run site && npm test && node packages/cli/dist/main.js closure --verify-failures --json`

### Test Plan

[ ] I/we understand the owners of the involved components may require updates to existing tests to make this code solid enough prior to committing the changes necessary to implement this enhancement.

#### Prerequisite testing updates

- Update [`build-incremental.test.ts`](../packages/cli/test/build-incremental.test.ts) (`PACKAGES` `10 -> 11`) and [`npm-pack.test.ts`](../packages/cli/test/npm-pack.test.ts) (`bundledDependencies.length` `10 -> 11` including `@loopwright/hardware-runner`) in `T1`.
- Update `UNMANAGED_WORKSPACES` in [`self-upgrade-fixtures.ts`](../packages/github-app/test/self-upgrade-fixtures.ts) in `T1` so offline self-upgrade parity suites recognize `packages/hardware-runner`.
- Update [`compile.test.ts`](../packages/controller/test/compile.test.ts) in `T3`. Cover both `TaskContract` rejection on missing hardware `targetCellId` (`CONFIG_SCHEMA`) and `compilePlan` rejection when a hardware check binds `json-artifact.v1` or `gate.v1` (`CAPABILITY_UNSUPPORTED`).

#### Unit tests

Every added unit of code has unit-test coverage with the following per-package targets:
- `@loopwright/core`: `2026-11-21` - `>= 90%` line coverage. Cover canonical hashing, unmixed `['hardware_execution']` checks, `metricThresholds` (`-0`, `NaN`, non-positive denominators, boundary equality), `hardwareProvenance` (`probeKind`, `topology`, `driverConstraint`), and `.loopwright-verifier/*` budgets.
- `@loopwright/controller`: `2026-11-21` - `>= 90%` line coverage. Cover bidirectional `compile.ts` gates, `D = 256` vs `D = 257` checkpoint limits, `benchmark-gate.ts` HMAC verification, `SecretScrubber` binary rejection, `BENCHMARK_PREEMPTED` blocking, and `refusal-record.ts`.
- `@loopwright/taskpack` and `@loopwright/github-app`: `2026-11-21` - `>= 90%` line coverage. Cover hardware matrix and threshold schemas, rejection of manifest `url`/credential overrides on `benchmark-gate.v1`, and `{ id, platform, variant }` memory projection.
- `@loopwright/hardware-runner`: `2026-11-21` - `>= 90%` line coverage. Cover `config.ts` symlink guards, `queue.ts` `(relayBootId, leaseEpoch, leaseToken)` fencing, `1,000ms`/`1,001ms` clock drift, expiry sweeps, `provenance.ts` parsers, and two-stage `evaluator.ts` builders.
- `@loopwright/cli`: `2026-11-21` - `>= 90%` line coverage. Cover `loopwright runner relay|worker` CLI flag parsing and `closure.ts` 23-row ledger invariants (`CLOSURE_FALSIFICATION_FORBIDDEN` without `ExternalQualificationReceipt`).

#### Integration tests

- **Controller <-> Relay CAS and Preemption (`packages/controller/test/benchmark-gate.test.ts`, `packages/hardware-runner/test/relay-server.test.ts`)**: verify candidate overlay staging with file deletions, uneven HTTP chunks above `1 MiB`, and cross-chunk secret rejection. Verify idempotent controller polls, `maxPreemptions = 0` and `3` (`3` requeues succeeding on `leaseEpoch = 4`, `4th` eviction settling `blocked` `BENCHMARK_PREEMPTED`), and `409 QUEUE_LEASE_FENCED` on stale epochs. Verify that unrelated uncertain `external_write` publication stays `reconcile_required`.
- **Crash Recovery and Reconcile (`packages/controller/test/benchmark-reconcile.test.ts`)**: inject controller interruption before binding, during CAS pull, and before proof. Verify that `loopwright reconcile` settles a signed `benchmark_verdict` with verified CAS blobs before timeout, rejects late receipts after timeout, and sends zero replacement `POST`s on `resumeCycle`.
- **Two-Stage Blind Sandbox Containment (`packages/hardware-runner/test/evaluator.test.ts`)**: verify that a sentinel secret inside `held_out_workloads` is unreachable during Stage A compile. Verify Stage B read-only enforcement, socket denial (`networkMode: 'none'`), zero exported Stage B files, and fail-closed refusal on missing backend or GPU isolation.
- **Packaging and Self-Upgrade Parity (`packages/cli/test/npm-pack.test.ts`, `packages/github-app/test/self-upgrade.test.ts`)**: verify that the packed `@gpustack/loopwright` tarball installs offline with all 11 bundled packages, exposes `loopwright runner --help`, and passes `.auto-sync/checks/verify.sh`.

#### e2e tests

- **Deterministic Loopback Outbound Worker E2E (`packages/hardware-runner/test/e2e-nat-loopback.test.ts`)**: start `loopwright runner relay` and outbound `loopwright runner worker --once` (zero inbound worker ports) over real HTTP streaming with `allowSyntheticHardwareProbe: true`. Simulate `SIGTERM` eviction on worker 1, complete two-stage compile and blind benchmark on worker 2, ingest `.cubin` + `.sass` CAS blobs, and verify a `completed` `RunResult` while production policy rejects `synthetic_fixture` probes.
- **Optional Live SSH Multi-GPU Smoke (`packages/hardware-runner/test/live-ssh-smoke.test.ts`)**: skip cleanly when `LOOPWRIGHT_CUDA_SSH_HOST` and `LOOPWRIGHT_ROCM_SSH_HOST` are unset. When configured, run an outbound Docker-sandboxed worker against live Linux NVIDIA (`nvidia-smi`, `sm_89`) and AMD ROCm (`rocm-smi` / `hipcc`, `gfx1101`) hosts to verify physical provenance (`probeKind: 'physical'`) without altering the committed `18` `closedLocal` / `5` `unprovisionedExternal` closure ledger.

## Alternatives

1. **Place the runner worker and pull-lease relay inside `@loopwright/taskpack` or `@loopwright/controller` instead of `@loopwright/hardware-runner`**:
   - Rejected. `@loopwright/controller` cannot import `@loopwright/taskpack` (`SandboxReadOnlyBindMount`) without a package cycle. Adding worker modules to `controller` would also churn `installedHandlerDigests()` ([`handlers.ts`](../packages/controller/src/handlers.ts)) on every edit. Putting cluster daemons into `@loopwright/taskpack` (~18k LOC) would recreate the monolith split in [`2026-11-20-decouple-taskpack-and-cas-blob-pointers.md`](2026-11-20-decouple-taskpack-and-cas-blob-pointers.md) and force a breaking extraction in Phase 3.3.
2. **Mint new controller `OperationIntent`s and `verify.<gen>.<slot>.<attempt>` checkpoints across `resumeCycle` on preemption**:
   - Rejected. Multiplying verifier slots by `(1 + maxPreemptions)` in [`compile.ts`](../packages/controller/src/compile.ts) overflows the `D <= 256` checkpoint limit on multi-step and `onRework` DAGs. It also requires rewriting [`progress.ts`](../packages/controller/src/progress.ts) and overturning the single-request crash rule in [`gate.ts`](../packages/controller/src/gate.ts). Relay-owned requeue (`leaseEpoch + 1`) covers worker eviction, while `loopwright reconcile` covers controller restarts.
3. **Require a built-in WebSocket (`wss://`) server control stream alongside HTTPS long-poll**:
   - Rejected. Node `v26.13.1` lacks a built-in WebSocket server parser, and workspace rules forbid unapproved npm dependencies (`ws`). Hand-rolling an RFC 6455 server adds ~500 lines of framing code, doubles transport tests, and fails behind proxies that block `Upgrade: websocket`. Standard HTTPS long-poll + heartbeat (with optional `text/event-stream` watch) and `1 MiB` HTTP `GET`/`PUT` CAS streaming use built-in HTTP primitives with zero head-of-line blocking.
4. **Enforce `hardwareProvenance` and `metricThresholds` only in `@loopwright/controller` handler parameters**:
   - Rejected. Leaving `@loopwright/core` blind to hardware mismatch and threshold violations weakens `evaluateAcceptance` / `constructRunResult` anti-cheating guarantees. It also duplicates parsers across three packages and forces Phase 3.3 search to parse private `gate-output` blobs instead of typed `Evidence`.
5. **Compile and benchmark candidate code inside one sandbox mount with `held_out_workloads` present**:
   - Rejected. A single stage that both reads `held_out_workloads` and exports `.cubin`/`.sass` binaries lets malicious candidate code embed private test inputs or reference answers into returned artifacts. Two-stage isolation seals Stage A binaries before mounting `held_out_workloads` in Stage B with zero file exports.

## Open Questions

None. All package boundaries, host-owned endpoint rules, two-stage blind evaluation invariants, Relay preemption fencing rules, and `@loopwright/core` schemas are resolved.
