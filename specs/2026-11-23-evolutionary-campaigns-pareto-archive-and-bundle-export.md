# Spec: Evolutionary campaigns, Pareto archive, and bundle export

Status: Building
Type: Feature

## Summary

Deliver evolutionary optimization across Loopwright for hardware kernels, continual compilation graphs, and speculative or runtime engine policies. Add `@loopwright/evolution` as the twelfth workspace package with an isolated `campaign.sqlite` archive (`islands`, MAP-Elites niches, lineage DAGs, `team_configs`, stepping-stone parent crossover, UCB1 model bandit routing, plateau-triggered bounded role and team-topology synthesis via `team-patch.v1`, and two-stage guarded portfolio synthesis) while keeping per-run `@loopwright/state` DDL and `D <= 256` controller checkpoints untouched. Add `evolve-block-guard.v1` mutable-region verification, Stage A static symbol and spill audits, Stage B bucketed multi-objective metrics and supervisor-distilled Roofline diagnostics, post-crash accelerator quarantine, three System-One advisory inner-loop filters in `@loopwright/decisions`, hardware-scoped memory in `@loopwright/memory`, and deterministic `evolution-bundle.v1` artifact exports.

## Motivation

### Goals

Loopwright ships two-stage blind GPU/NPU verification (`benchmark-gate.v1` and `@loopwright/hardware-runner` in [`2026-11-21-hardware-execution-benchmark-gate-and-remote-runner.md`](2026-11-21-hardware-execution-benchmark-gate-and-remote-runner.md)) and deterministic section handoffs, conditional rules, and `RunEval` health telemetry ([`2026-11-21-phase2-suite-handoff-and-run-eval.md`](2026-11-21-phase2-suite-handoff-and-run-eval.md)). Seven architectural gaps still prevent Loopwright from driving non-convex evolutionary search for an evolving LLM inference engine:

1. **Single-lineage pass/fail loops discard stepping stones**:
   - [`packages/state/src/schema.ts`](../packages/state/src/schema.ts) models a singleton `run` row, and [`packages/controller/src/progress.ts`](../packages/controller/src/progress.ts) caps per-run checkpoints at `D <= 256`.
   - Linear `implementationRepair` in [`packages/controller/src/controller.ts`](../packages/controller/src/controller.ts) overwrites or discards slower intermediate candidates that introduce necessary structural primitives (such as asynchronous tensor-memory pipelines or double-buffered unified-buffer tiling) before tile sizes are tuned.
   - Single-run loops also cannot evolve per-shape specialists first and then synthesize a guarded multi-shape portfolio dispatcher verified on held-out workloads.

2. **Fixed role topologies stall on cognitive and measurement plateaus**:
   - [`packages/controller/src/compile.ts`](../packages/controller/src/compile.ts) freezes `roles[]` and `orderedDAG` inside each single-run `CompiledPlan`. Across generations, feeding different parent code into the same generic `optimizer` role still stalls when that role repeats a flawed micro-timing assumption, couples root-cause diagnosis with code rewriting, or hits `pingPong` / `toolRepeats` pathologies reported by [`packages/controller/src/run-eval.ts`](../packages/controller/src/run-eval.ts).
   - Conversely, letting an unconstrained supervisor spawn arbitrary roles with unrestricted tools or shared mutable directories would violate Loopwright's non-delegable host authority model.

3. **No mutable code-block fence or pre-GPU static spill/fallback gate**:
   - `scope.v1` and `line-section-guard.v1` in [`packages/taskpack/src/types.ts`](../packages/taskpack/src/types.ts) guard whole files or static line headers, not inline mutable kernel blocks (`EVOLVE-BLOCK-START` / `EVOLVE-BLOCK-END`).
   - [`packages/hardware-runner/src/evaluator.ts`](../packages/hardware-runner/src/evaluator.ts) seals Stage A binaries without auditing exported/imported ELF or PTX/SASS symbols for unauthorized high-level library fallbacks (`cublas`, `rocblas`, `aclnn`, `at::native`) or excessive register spills before spending Stage B GPU leases.

4. **Flat scalar Stage B metrics lack bucketed Pareto objectives, Roofline diagnostics, and sticky-fault quarantine**:
   - `parseEnvelopeMetrics` and `checkMetricThresholds` in [`evaluator.ts`](../packages/hardware-runner/src/evaluator.ts) validate flat `MetricsMap` scalars (`bounds` and `comparative`) without `(islBucket, batchBucket)` multi-objective matrices (`latencyUs`, `ttftP95Ms`, `itlP95Ms`, `goodputRps`, `peakMemBytes`, `maxUlp`, `tokenForceMaxDelta`).
   - Stage B returns generic pass/deny findings without bounded, workload-redacted Roofline bottleneck summaries (`boundPipeline`, `rooflineHeadroom`, occupancy, L2 hit rate, bank conflicts, or warp/pipe stalls).
   - [`packages/hardware-runner/src/worker.ts`](../packages/hardware-runner/src/worker.ts) lacks post-crash accelerator health probes to quarantine workers after sticky GPU/NPU faults (`Xid`, ECC errors, or HBM hangs).

5. **System-One routing (`@loopwright/decisions`) cannot filter inner-loop mutations**:
   - [`packages/decisions/src/nodes.ts`](../packages/decisions/src/nodes.ts) supports capability tiering, cycle alignment, soft compaction, and post-diff rule triage. It lacks pre-compile AST/token novelty rejection, bottleneck-driven DSL track routing, and smoke-to-full benchmark cascade escalation.

6. **Memory drops accelerator micro-architecture scope and lacks an in-campaign scratchpad**:
   - [`packages/memory/src/schema.ts`](../packages/memory/src/schema.ts), [`packages/taskpack/src/turnkey-memory.ts`](../packages/taskpack/src/turnkey-memory.ts), and [`packages/github-app/src/turnkey-memory.ts`](../packages/github-app/src/turnkey-memory.ts) project `target.matrix` down to `{ id, platform, variant }`, discarding `accelerator` and `driverConstraint`. Hardware-specific lessons (such as `sm_100a` tensor memory vs `sm_89` shared memory, or Ascend core-count tiling rules) risk cross-architecture misapplication, while mid-campaign discoveries have no ephemeral scratchpad between generations.

7. **Publication supports pull requests only, not signed evolution artifact bundles**:
   - `TaskpackPublicationDeclaration` in [`packages/taskpack/src/types.ts`](../packages/taskpack/src/types.ts) supports only `'pull_request' | 'disabled'`. Operators cannot export a deterministic bundle pairing sealed `.loopwright-verifier/<slotId>/*` binaries, guarded dispatch predicates (`dispatch-manifest.json`), and HMAC-signed `hardwareProvenance` + Pareto tables for downstream inference serving engines.

Target users are kernel engineers, compiler and inference systems researchers, verification owners, and cluster operators. Success criteria:

- Run multi-generation evolutionary campaigns in `@loopwright/evolution` using an isolated `campaign.sqlite` store while preserving byte-identical `@loopwright/state` `schema_digest` and `D <= 256` per-run `LocalRunStore` invariants.
- Retain stepping-stone individuals across islands and MAP-Elites niches, track multi-parent lineage DAGs, enforce `evolve-block-guard.v1` outside mutable blocks, and synthesize guarded multi-shape portfolios verified on held-out shards.
- Detect island plateaus (`stallGenerations`) and `RunEval` loop pathologies, invoke a read-only supervisor to synthesize `team-patch.v1` role DAGs strictly bounded by approved host archetype envelopes (`tools` subset, pinned models/resources, immutable scope and gates, `D <= 256`), and roll back unproductive `team_configs` automatically after `trialGenerations`.
- Enforce Stage A symbol/spill static audits, Stage B bucketed correctness and Token-Forcing losslessness gates, supervisor-sanitized Roofline diagnostic summaries, NSGA-II Pareto ranking, and worker GPU/NPU sticky-fault quarantine.
- Cut wasted hardware leases via advisory System-One novelty rejection, DSL track routing, and cascade budget escalation while keeping `verificationCertified: false`.
- Scope slow-loop `@loopwright/memory` entries to `{ accelerator, driverConstraint?, operatorFamily?, boundPipeline? }` backed by passing `hardware_execution` evidence, maintain fast-loop in-campaign scratchpads, and export deterministic `evolution-bundle.v1` artifacts (`dir` and `oci-layout`).

### Non-Goals

- Modifying the five-table per-run SQLite `DDL` (`format_version = 1`) in [`packages/state/src/schema.ts`](../packages/state/src/schema.ts) or altering `phaseSchedule` (`D <= 256`) in [`packages/controller/src/progress.ts`](../packages/controller/src/progress.ts).
- Mutating `roles[]` or `orderedDAG` mid-run inside an active `LocalRunStore`, or allowing the plateau supervisor to write candidate code, widen `tools` beyond host archetype profiles, relax `scope.writable` / `evolve-block-guard.v1`, or drop required acceptance checks.
- Introducing external database servers (PostgreSQL, Redis), multi-host distributed consensus, or web dashboards.
- Allowing `@loopwright/decisions` (`typesafe-jev` or other providers) to approve verification gates, override `metricThresholds`, or certify `Evidence`.
- Mounting `held_out_workloads` during Stage A compilation, exporting raw profiler databases (`*.ncu-rep`, `msprof` SQLite) or files from Stage B, or weakening socket-denying seccomp/seatbelt profiles.
- Injecting unverified human-written static optimization cookbooks into prompts without passing `hardware_execution` receipts.
- Adding any third-party runtime npm dependency across the workspace or changing the 23-row closure split (`18` `closedLocal`, `5` `unprovisionedExternal`) in [`packages/cli/src/closure.ts`](../packages/cli/src/closure.ts) without an `ExternalQualificationReceipt`.

## Proposal

Add `@loopwright/evolution` as the twelfth workspace package and extend `@loopwright/core`, `@loopwright/controller`, `@loopwright/hardware-runner`, `@loopwright/decisions`, `@loopwright/memory`, `@loopwright/taskpack`, `@loopwright/github-app`, and `@loopwright/cli`. Coordinate multi-generation island and MAP-Elites campaigns in an isolated `campaign.sqlite` database that dispatches standard fenced `LocalRunStore` runs per candidate evaluation. When an island stalls or hits `RunEval` loop pathologies, run a read-only supervisor to emit a capability-bounded `team-patch.v1` role DAG compiled into subsequent child `TaskContract` runs under a bounded `trialGenerations` rollback window. Guard mutable code regions and static binary invariants before Stage B benchmarking, collect bucketed multi-objective metrics and sanitized Roofline bottleneck diagnostics, maintain NSGA-II Pareto frontiers and hardware-scoped memories, and export verified `evolution-bundle.v1` packages with guarded dispatch manifests and signed provenance receipts.

```yaml
apiVersion: loopwright.dev/v1alpha1
kind: EvolutionCampaign
metadata:
  name: flash-decode-sm90a
spec:
  taskpack: .loopwright/taskpack.yaml
  targetCellId: cuda-h100-whole
  stages:
    mode: specialist-then-portfolio # Optional single-target or specialist-then-portfolio
    specialistBuckets:
      - id: bs1-isl4k
        heldOutWorkloadId: decode-bs1-4k
      - id: bs16-isl8k
        heldOutWorkloadId: decode-bs16-8k
    portfolioHeldOutWorkloadId: decode-portfolio-holdout
  population:
    islands: 4
    migrationIntervalGenerations: 8
    maxMigrationElites: 1
    nicheAxes:
      - id: bound_pipeline
        kind: enum
        values: [hbm, l2, smem_lds_ub, tensor_cube, vector_valu]
      - id: occupancy_band
        kind: numeric_bins
        edges: [0, 25, 50, 75, 100]
  sampling:
    noveltyDecayLambda: 1.0
    mutationWeights:
      diff_tune: 0.5
      full_rewrite: 0.3
      crossover: 0.2
    modelBandit: ucb1 # Optional deterministic-round-robin or ucb1
    maxCrossoversPerPrompt: 2
  teamEvolution: # Optional plateau-triggered bounded role and team synthesis
    enabled: true
    supervisorRoleId: supervisor
    allowedArchetypeRoles: [probe-readonly, mutator-sandboxed, reviewer]
    stallGenerations: 4
    minHypervolumeDelta: 0.001
    triggerOnRunEvalPathology: true
    trialGenerations: 2
    maxTeamSize: 3
    maxTeamSteps: 4
  objectives:
    - metric: latency_us_p50
      direction: minimize
    - metric: goodput_rps
      direction: maximize
    - metric: peak_mem_bytes
      direction: minimize
  budgets:
    maxGenerations: 40
    maxEvaluations: 160
    maxConcurrentEvaluations: 4
    targetRooflineHeadroom: 1.08 # Optional early-stop ratio >= 1.0
    scratchpadIntervalGenerations: 5
  export:
    format: oci-layout # Optional dir or oci-layout
    outputDir: .loopwright-out/bundles/flash-decode-sm90a
```

### User Stories

#### Story 1

As a kernel and inference engine engineer, I want to run budget-bounded multi-generation evolutionary campaigns with isolated islands, hardware-behavior MAP-Elites grids, lineage DAGs, multi-parent crossover, and `evolve-block-guard.v1` region protection, so that slower structural stepping-stone mutations survive and synthesize into a guarded multi-shape operator portfolio.

#### Story 2

As a verification owner, I want Stage A and Stage B hardware evaluation to enforce symbol/spill anti-cheat checks, bucketed multi-objective correctness and Token-Forcing bounds, supervisor-distilled Roofline bottleneck summaries, and post-crash accelerator quarantine, so that evolution receives actionable hardware guidance while library fallbacks, accuracy drift, and sticky GPU/NPU faults are blocked.

#### Story 3

As a systems optimization engineer, I want campaigns to maintain an NSGA-II Pareto frontier over latency, Goodput, peak memory, and compile time while consulting `@loopwright/decisions` to reject cosmetic AST edits, route DSL tracks, and escalate smoke-tested candidates, so that GPU/NPU lease budgets focus on structurally novel improvements.

#### Story 4

As a multi-silicon platform maintainer, I want campaigns to maintain an ephemeral in-campaign scratchpad every few generations while scoping committed `@loopwright/memory` facts and anti-patterns to exact accelerator micro-architectures and passing `hardware_execution` receipts, so that hardware-verified rules transfer cleanly without poisoning other chip generations.

#### Story 5

As an inference serving operator, I want to export campaign winners as deterministic `evolution-bundle.v1` packages containing sealed binaries, a `dispatch-manifest.json` guarded routing table with baseline fallback, and HMAC-signed `hardwareProvenance` + Pareto receipts, so that downstream serving clusters verify compatibility tuples and hot-load specialized artifacts safely.

#### Story 6

As a kernel and systems optimization engineer, I want stalled islands to invoke a read-only supervisor that diagnoses cognitive or measurement plateaus, synthesizes a capability-bounded multi-role team DAG (`team-patch.v1`) from approved host archetypes, and automatically rolls back unproductive teams after a bounded trial window, so that campaigns break through stagnation plateaus without privilege escalation or checkpoint overflow.

### Core Features & Acceptance Criteria

#### 1. `@loopwright/evolution` Campaign Store, Island + MAP-Elites Search, and Portfolio Synthesis (`packages/evolution`, `@loopwright/cli`, `scripts/`)

- **Dedicated 12th workspace package and isolated `campaign.sqlite` authority**:
  - Create `packages/evolution` (`@loopwright/evolution`) using built-in `node:sqlite` (`Node 26.x`) with zero new third-party runtime npm dependencies.
  - Register `packages/evolution` across [`package.json`](../package.json), [`package-lock.json`](../package-lock.json), [`tsconfig.test.json`](../tsconfig.test.json), [`.opencodereview/rule.json`](../.opencodereview/rule.json), [`packages/cli/package.json`](../packages/cli/package.json), [`packages/cli/tsconfig.json`](../packages/cli/tsconfig.json), [`scripts/build.mjs`](../scripts/build.mjs), [`scripts/run-tests.mjs`](../scripts/run-tests.mjs), [`scripts/pack-npm.mjs`](../scripts/pack-npm.mjs), and `UNMANAGED_WORKSPACES` in [`scripts/prepare-self-upgrade.mjs`](../scripts/prepare-self-upgrade.mjs), [`.auto-sync/checks/verify.sh`](../.auto-sync/checks/verify.sh), [`.auto-sync/digests.lock.json`](../.auto-sync/digests.lock.json), and [`packages/github-app/test/self-upgrade-fixtures.ts`](../packages/github-app/test/self-upgrade-fixtures.ts).
  - Persist campaign state in `<campaignRoot>/campaign.sqlite` (`journal_mode = DELETE`, `synchronous = FULL`, `busy_timeout = 250`, `STRICT` tables, `O_NOFOLLOW` non-symlink directory/file checks, monotonic `ClockSource` lease fencing, and `<= 1,000ms` clock-drift guard) with six tables (`campaign_meta`, `campaigns`, `islands`, `team_configs`, `individuals` carrying foreign key `team_config_id`, and `lineage_edges`) plus CAS-backed `scratchpad_snapshots`. Serialize all `campaign.sqlite` reads and writes through a single in-process coordinator queue inside `packages/evolution/src/store.ts` when `maxConcurrentEvaluations > 1` runs concurrent isolated child `<campaignRoot>/runs/<individualId>/` `LocalRunStore` instances.
  - Keep [`packages/state/src/schema.ts`](../packages/state/src/schema.ts) (`DDL`, `format_version = 1`, `expectedSchema()`) and [`packages/controller/src/progress.ts`](../packages/controller/src/progress.ts) (`phaseSchedule`, `D <= 256`) completely unchanged. Each candidate evaluation executes inside its own fresh, fenced child `LocalRunStore` under `<campaignRoot>/runs/<individualId>/` and records only verified `ArtifactRef` / `Evidence` digests in `campaign.sqlite`.
- **Island isolation, hardware MAP-Elites niches, stepping-stone sampling, and UCB1 model bandit**:
  - Parse and validate `kind: EvolutionCampaign` (`apiVersion: loopwright.dev/v1alpha1`, `<= 65,536` bytes) via null-prototype-safe YAML 1.2 core helpers from `@loopwright/taskpack`.
  - Partition the population into `1..16` islands. Every `migrationIntervalGenerations`, copy up to `maxMigrationElites` non-rank-1 niche elites across ring neighbors as `role: 'inspiration'` references while keeping each island's rank-1 leader local (**Island Elitism**) to prevent premature convergence.
  - Map each passing or soft-threshold individual into a deterministic MAP-Elites `nicheKey` over `1..4` declared `nicheAxes` (`enum` or `numeric_bins` derived from `hardwareDiagnostics` or `metrics`). Retain the Pareto-dominant or highest-scalarized individual per `(islandId, nicheKey)` alongside an append-only `individuals` history and `lineage_edges` DAG (`primary`, `crossover_donor`, `inspiration`, `portfolio_member`).
  - Sample parents using novelty-decayed performance weights $w_i = \sigma(\lambda(F(P_i) - \alpha_0)) \cdot (1 + N(P_i))^{-1}$, where $\alpha_0$ is the island median scalarized fitness and $N(P_i)$ is `offspring_count`. Stage `1` primary parent plus up to `maxCrossoversPerPrompt` (`0..4`) donor/inspiration snapshots as read-only (`0o400`) `contextFiles` containing bounded code slices, `bucketMetrics`, and `hardwareDiagnostics`.
  - Support deterministic round-robin or **UCB1 bandit** model selection across declared `Taskpack.spec.models[]` (`1..16` candidates), updating model rewards from truncated parent-relative improvement $r_u = \exp(\max(r - r_{\text{parent}}, 0)) - 1$ persisted in `campaign.sqlite`.
- **Two-stage `specialist-then-portfolio` orchestration and CLI commands**:
  - Under `stages.mode: 'specialist-then-portfolio'`, run specialist campaigns per declared `specialistBuckets[]` entry first, then run a portfolio synthesis stage that mounts the winning specialist implementations and synthesizes a guarded portfolio entrypoint (`dispatch-manifest.json` + router glue) verified against `portfolioHeldOutWorkloadId` (which is never exposed during the specialist stage).
  - Add `loopwright evolve check|run|resume|status|inspect|export` in [`packages/cli/src/arguments.ts`](../packages/cli/src/arguments.ts) and [`packages/cli/src/main.ts`](../packages/cli/src/main.ts) via lazy `await import('@loopwright/evolution')` (preserving zero top-level heavy runtime imports in `main.ts` and existing CLI exit codes `0`, `2..8`, `130/143`).
- **Acceptance criteria**:
  - `@loopwright/state` `expectedSchema()` and all existing 11-package `TaskContract`/`TaskLock` digests remain unchanged.
  - A slower structural stepping-stone individual occupying a distinct `(islandId, nicheKey)` (for example `bound_pipeline = tensor_cube`) is retained, sampled for crossover, and traced in `lineage_edges` to a Pareto-dominant descendant.
  - Interrupted campaigns (`SIGTERM` or fenced child run preemption `BENCHMARK_PREEMPTED`) resume cleanly from `campaign.sqlite` without corrupting island archives or double-counting `maxEvaluations`.

#### 2. Capability-Bounded Plateau Role and Team Synthesis (`@loopwright/evolution`, `@loopwright/core`)

- **Event-driven plateau and `RunEval` pathology detection (zero steady-state overhead)**:
  - Evaluate plateau triggers per island between generations only when `teamEvolution?.enabled === true` and remaining `maxEvaluations` / `maxGenerations` budgets cover at least `1` supervisor turn plus `1` child evaluation.
  - Trigger a supervisor diagnosis turn when either condition holds on an island whose best `rooflineHeadroom` has not yet reached `targetRooflineHeadroom`:
    1. **Pareto stagnation**: `consecutiveNoGainGenerations >= stallGenerations` (`1..32`, default `4`), where per-generation island hypervolume delta stays `< minHypervolumeDelta` (`>= 0`, default `0.001`) and zero new MAP-Elites niches open.
    2. **Loop pathology**: `triggerOnRunEvalPathology === true` and `>= 2` consecutive child `RunEvalReport` artifacts ([`packages/controller/src/run-eval.ts`](../packages/controller/src/run-eval.ts)) record `pingPong` cycles or `toolRepeats` circuit-breaker trips (`consecutive_tool_errors` or `no_progress`).
- **Read-only, non-solving Supervisor isolation**:
  - Execute `supervisorRoleId` inside an isolated read-only `LocalRunStore` run whose role permits `tools: ['read']` only (`write`, `edit`, `delete`, and `bash` forbidden; `scope.writable` untouched; zero `held_out_workloads` mounts).
  - Stage only `SecretScrubber`-clean, read-only (`0o400`) diagnostic context artifacts: island score/hypervolume trajectory, bounded child `run-eval.json` summaries, sanitized `hardwareDiagnostics` + `findings`, latest `scratchpad` snapshot, and prior `team_configs` history (including `rolled_back` team diagnoses so failed team topologies are not repeated).
  - Instruct and enforce that the supervisor diagnoses organizational or measurement blind spots and designs a specialist role workflow rather than authoring candidate kernel code.
- **Strict `team-patch.v1` schema and fail-closed Archetype Capability Envelope (`TEAM_ENVELOPE_VIOLATION`)**:
  - Require the supervisor submission to parse strictly as JSON/YAML `kind: 'TeamPatch'` (`schemaVersion: 'team-patch.v1'`, `<= 32,768` bytes, null-prototype validation, zero free-form Markdown regex scraping):
    - `diagnosis`: `{ readonly summary: string; readonly plateauCategory: 'measurement_mismatch' | 'coupled_responsibilities' | 'local_optimum_anchor' | 'resource_spill_trap' | 'correctness_ping_pong' | 'other'; readonly rationale: string }` (`<= 4,096` bytes total).
    - `roles[]` (`1..maxTeamSize`, where `maxTeamSize` is capped at `1..4`): `{ readonly id: string; readonly archetypeRoleId: string; readonly purpose: 'task' | 'review'; readonly prompt: string; readonly model?: string; readonly thinking?: string; readonly tools: readonly string[]; readonly resourceIds?: readonly string[]; readonly timeoutSeconds?: number }`.
    - `steps[]` (`1..maxTeamSteps`, where `maxTeamSteps` is capped at `1..6`, strict acyclic DAG): `{ readonly id: string; readonly roleId: string; readonly dependsOn: readonly string[]; readonly handoffs?: readonly StepHandoffSelector[]; readonly onRework?: ReworkPolicy }`.
  - Validate every `team-patch.v1` against the **Archetype Capability Envelope** before compiling the child `TaskContract`, rejecting any violation fail-closed with `TEAM_ENVELOPE_VIOLATION` (retaining the incumbent `team_config_id` without crashing the campaign):
    1. **Approved archetype inheritance**: `role.archetypeRoleId` must appear in `teamEvolution.allowedArchetypeRoles[]` and resolve to a pre-approved role in the base `Taskpack` / host `TrustedRegistry.spec.roleProfiles`.
    2. **Monotonic tool narrowing (`tools <= archetype.tools`)**: every tool in `role.tools` must exist in `archetype.tools` (`write`, `edit`, `delete`, and `bash` are rejected on `purpose: 'review'` or read-only archetypes). No synthesized role can gain network, mount, MCP, or credential privileges beyond its host archetype.
    3. **Pinned models, resources, and timeouts**: optional `role.model` must match a declared entry in `Taskpack.spec.models[]`; optional `role.resourceIds` must be a subset of pre-hashed `TaskContract.spec.trustedContext.resources` (`discovery: 'disabled'` preserved); `timeoutSeconds` must not exceed the archetype's ceiling.
    4. **Isolated `StepHandoffSelector` relay and immutable gates**: parallel or sequential team roles exchange findings exclusively through deterministic SHA-256 `StepHandoffSelector` extracts (`handoffs` in [`packages/controller/src/handoff.ts`](../packages/controller/src/handoff.ts)), never through unisolated shared mutable directories. The compiler appends and locks the base `scope.writable`, `scope.protected`, `evolve-block-guard.v1`, and all required `acceptance.checks` (`benchmark-gate.v1`), and pre-verifies `checkpointCapacity(...)` (`D <= 256` in [`packages/controller/src/compile.ts`](../packages/controller/src/compile.ts)) before launching any child run.
- **`team_configs` credit assignment and automatic `trialGenerations` rollback (`campaign.sqlite`)**:
  - Persist validated team topologies in `team_configs` (`team_config_id`, `island_id`, `parent_team_config_id`, `created_generation`, `status: 'baseline' | 'trial' | 'promoted' | 'rolled_back'`, `trial_budget_generations`, `trial_used_generations`, `diagnosis_json`, `patch_cas_digest`, `pareto_advances`, `niche_discoveries`) and bind `individuals.team_config_id` on every evaluated candidate.
  - Admit newly synthesized teams in `status = 'trial'` with `trial_budget_generations = teamEvolution.trialGenerations` (`1..8`, default `2`).
  - If any child evaluation under a `'trial'` `team_config_id` advances the island's Pareto hypervolume (`>= minHypervolumeDelta`) or discovers a higher-scoring MAP-Elites niche elite, transition `status -> 'promoted'` as the island's active team.
  - If `trial_used_generations` reaches `trial_budget_generations` with zero Pareto or niche advance (not counting `BENCHMARK_PREEMPTED` runs), transition `status -> 'rolled_back'`, automatically restore `parent_team_config_id` (the prior promoted or baseline solo topology), and record the failed `team_config_id` in supervisor history to prevent re-proposing unproductive multi-agent overhead.
- **Acceptance criteria**:
  - Islands that advance Pareto hypervolume within `stallGenerations` execute `0` supervisor runs.
  - Any `team-patch.v1` requesting tools outside `archetype.tools`, referencing an undeclared model or unpinned resource, altering `scope`/`acceptance.required`, or exceeding `D <= 256` fails closed with `TEAM_ENVELOPE_VIOLATION` and keeps the incumbent team active.
  - On a stalled island, the read-only supervisor emits a valid `probe-readonly -> mutator-sandboxed` `team-patch.v1` wired via `StepHandoffSelector`; `campaign.sqlite` promotes the team on a Pareto advance and automatically rolls back to the incumbent `team_config_id` when `trialGenerations` expire with zero improvement.

#### 3. `evolve-block-guard.v1` Region Protection and Stage A Static Binary/Source Audits (`@loopwright/core`, `@loopwright/controller`, `@loopwright/taskpack`, `@loopwright/hardware-runner`)

- **Deterministic mutable block check (`evolve-block-guard.v1`)**:
  - Register `'evolve-block-guard.v1'` in `@loopwright/controller` (`handlers.ts`, `registry.ts`, `verifier-protocol.ts`) and `TaskpackV2CheckImplementation` in [`packages/taskpack/src/types.ts`](../packages/taskpack/src/types.ts).
  - Parse paired `EVOLVE-BLOCK-START: <blockId>` and `EVOLVE-BLOCK-END: <blockId>` markers (`//`, `#`, or `/* ... */` single-line comments; `1..32` blocks per file; nested, duplicate, reordered, or unclosed markers fail closed).
  - Verify that every byte outside matched mutable block interiors in guarded files matches the `baseRevision` (or carry-aligned baseline) SHA-256 digest exactly, locking function signatures, PyTorch/C++ registration bindings, and evaluation harness files while enforcing optional `maxBlockBytes` and `allowedBlockIds`.
- **Stage A static symbol denylist and register/spill ceiling audit (`@loopwright/hardware-runner`)**:
  - Extend `HardwareTargetSpec` / `BenchmarkRequest` (optional fields omitted when unset so legacy canonical hashes stay unchanged) and `sealStageAOutputs` in [`packages/hardware-runner/src/evaluator.ts`](../packages/hardware-runner/src/evaluator.ts) with optional deterministic Stage A static audit rules:
    - `forbiddenSymbolPatterns` (`0..64` exact prefixes or glob-free substrings, such as `cublas`, `cudnn`, `rocblas`, `miopen`, `aclnn`, `at::native::`, `torch_cuda`): inspect Stage A `.so`, `.o`, `.cubin`, `.ptx`, and `.sass` outputs using bounded binary symbol/section parsers or verified root-owned toolchain `nm`/`cuobjdump` binaries (`O_NOFOLLOW`, `1 MiB` output cap) before Stage B starts.
    - `maxRegisterCount` and `maxLocalSpillBytes`: parse compiler/assembler resource reports or `.sass`/`.ptx` metadata emitted in Stage A and reject candidates exceeding hardware ceilings with `status: 'denied'`, `reason: 'STAGE_A_STATIC_AUDIT_FAILED'`, and structured line/symbol `findings` — consuming zero Stage B GPU runtime.
- **Acceptance criteria**:
  - Mutating a single character outside `EVOLVE-BLOCK-START/END` markers, deleting a marker, or reordering block IDs fails `evolve-block-guard.v1` deterministically.
  - A Stage A `.so`/`.cubin` linking `cublasGemmEx` or exceeding `maxLocalSpillBytes: 0` fails in Stage A with `STAGE_A_STATIC_AUDIT_FAILED` before Stage B mounts `held_out_workloads`.

#### 4. Bucketed Multi-Objective Metrics, Roofline Diagnostic Distillation, and Device Quarantine (`@loopwright/core`, `@loopwright/controller`, `@loopwright/hardware-runner`, `@loopwright/evolution`)

- **Backward-compatible `bucketMetrics` and `hardwareDiagnostics` on `Evidence` and Stage B envelopes**:
  - Extend `Evidence.spec` in [`packages/core/src/evidence.ts`](../packages/core/src/evidence.ts) and `StageBResultEnvelope` in [`packages/hardware-runner/src/evaluator.ts`](../packages/hardware-runner/src/evaluator.ts) (keeping total Stage B stdout `<= 49,152` bytes and Relay `:complete` body `<= 65,536` bytes) with two optional, strictly typed structures:
    - `bucketMetrics`: `1..64` entries `{ bucketId, dimensions?: Readonly<Record<string, number | string>>, metrics: MetricsMap }` (capped at `<= 16` numeric metrics and `<= 8` dimension keys per bucket so 64-bucket Stage B envelopes remain well below `49,152` bytes), supporting per-shape/per-load measurements (`latency_us_p50`, `latency_us_p95`, `ttft_ms_p95`, `itl_ms_p95`, `goodput_rps`, `peak_mem_bytes`, `compile_ms`, `max_ulp`, `token_force_max_delta`, `token_force_outlier_ratio`).
    - `hardwareDiagnostics`: `{ boundPipeline: 'hbm' | 'l2' | 'smem_lds_ub' | 'tensor_cube' | 'vector_valu' | 'host_launch' | 'comm' | 'unknown', rooflineHeadroom?: number, achievedSolPct?: number, arithmeticIntensity?: number, occupancyPct?: number, registerCount?: number, sharedMemBytes?: number, localSpillBytes?: number, l2HitPct?: number, bankConflictPct?: number, topStallReasons?: readonly { readonly reason: string; readonly pct: number }[] }`.
  - Validate every key and string with null-prototype guards, `PRINTABLE_ASCII_RE` enums/identifiers (preventing exfiltration of free-text `held_out_workloads` content through diagnostic fields), finite non-`-0` numbers, and `SecretScrubber` checks. Zero files may be exported from Stage B.
  - Extend `metricThresholds` in [`packages/core/src/contracts.ts`](../packages/core/src/contracts.ts) and [`acceptance.ts`](../packages/core/src/acceptance.ts) with optional `bucketScope?: 'aggregate' | 'all_buckets' | { readonly bucketId: string }` so correctness bounds (such as `max_ulp <= 1` and `token_force_max_delta <= 0.02`) apply across every evaluated shape bucket before any candidate can pass.
- **NSGA-II Pareto frontier and hypervolume ranking (`@loopwright/evolution`)**:
  - Gate admission into the fertile population on passing hard correctness rules; optionally retain compile-valid correctness-passing slow stepping stones in non-rank-1 niches while keeping correctness-failing candidates strictly as negative parent error feedback.
  - Compute deterministic **NSGA-II non-dominated fronts (`paretoRank = 1..k`)**, crowding distance, and exact 2D/3D or Monte-Carlo-free bounded reference-point hypervolume contributions over declared campaign `objectives[]` (`minimize` / `maximize`). Break ties deterministically by lexicographic objective vector and `individualId`.
- **Post-crash accelerator health probe and worker quarantine (`@loopwright/hardware-runner`)**:
  - After any Stage B timeout, signal kill (`SIGSEGV`, `SIGABRT`, `SIGBUS`), or non-zero exit in [`packages/hardware-runner/src/worker.ts`](../packages/hardware-runner/src/worker.ts), execute a trusted host health check via [`provenance.ts`](../packages/hardware-runner/src/provenance.ts) (`nvidia-smi`, `rocm-smi`, `npu-smi` query for fatal `Xid`, uncorrectable ECC, or unresponsive device state) **before** reporting completion or polling `/v1/runner/leases:acquire`.
  - If the accelerator is wedged or degraded after a faulty candidate kernel, report candidate denial (or preempt if caused by external host loss) and transition the worker into local fail-closed quarantine (`WORKER_DEVICE_QUARANTINED`, exit code `3`) so subsequent healthy candidates in the Relay queue are never poisoned by a corrupted GPU/NPU context.
- **Acceptance criteria**:
  - If any single bucket in `bucketMetrics` violates `max_ulp <= 1` under `bucketScope: 'all_buckets'`, both `evaluator.ts` and `@loopwright/core` `evaluateAcceptance` reject passing completion (`METRIC_THRESHOLD_FAILED`).
  - Free-form or secret-bearing strings injected into `hardwareDiagnostics` fail Stage B envelope validation (`ARTIFACT_INVALID`), preserving blind Stage B non-exfiltration.
  - A simulated sticky GPU fault after Stage B crash quarantines the unhealthy worker before it can pull another job from the Relay.

#### 5. System-One (`@loopwright/decisions`) Inner-Loop Novelty Filter, Track Router, and Cascade Escalation (`@loopwright/decisions`, `@loopwright/evolution`)

- **Three bounded advisory intents with deterministic fallbacks**:
  - Add `'advise_mutation_novelty'`, `'route_evolution_strategy'`, and `'advise_cascade_escalation'` to `DECISION_ALLOWED_AUTHORITY_INTENTS` in [`packages/decisions/src/types.ts`](../packages/decisions/src/types.ts) while keeping all six `DECISION_FORBIDDEN_AUTHORITY_INTENTS` (`approve_gate`, `mint_evidence`, `bypass_sandbox`, `override_scope`, `publish_unverified`, `mutate_protected_workflow`) strictly forbidden (`DECISION_AUTHORITY_VIOLATION`):
    1. **`evaluateMutationNovelty`**: compute deterministic whitespace/comment-stripped token-shingle Jaccard similarity across `EVOLVE-BLOCK` slices against island history first. If similarity `=== 1.0`, reject immediately with `0` transport calls (`source: 'deterministic_heuristic'`, `action: 'reject_resample'`). In the soft high-similarity band (`[noveltyThreshold, 1.0)`), query System-One (`noul`) under configured `disclosurePolicy` to detect cosmetic variable renames or constant-folding clones before Stage A/B dispatch.
    2. **`routeEvolutionStrategy`**: accept sanitized structural metadata (operator kind, tensor rank, dtype, reduction/causal flags) and prior `hardwareDiagnostics` (`boundPipeline`, `rooflineHeadroom`, `occupancyPct`, `localSpillBytes`) to select `(trackId, mutationKind)` among campaign-declared tracks (for example `triton`, `cute`, `cuda_raw`, `ascend_tile`, `ascend_regbase`, `ascend_simt`), falling back to deterministic Roofline rules when System-One is disabled or low-confidence.
    3. **`evaluateCascadeEscalation`**: after a smoke-bucket check passes correctness, classify whether a candidate should `prune`, `confirm`, or `escalate` to the full multi-bucket / end-to-end engine benchmark gate, never bypassing full verification required for final publication or bundle export.
- **Acceptance criteria**:
  - Byte-equivalent or whitespace/comment-only `EVOLVE-BLOCK` edits are rejected with `0` `benchmark-gate.v1` dispatches and `0` System-One network calls.
  - Calling any decision helper with a forbidden authority intent throws `DecisionError('DECISION_AUTHORITY_VIOLATION')` with `authorityViolation: true`, and every new result stamps `advisoryOnly: true` and `verificationCertified: false`.

#### 6. Fast-Loop Campaign Scratchpad and Hardware-Scoped Reviewed Memory (`@loopwright/evolution`, `@loopwright/memory`, `@loopwright/taskpack`, `@loopwright/github-app`)

- **Deterministic in-campaign meta-scratchpad (`@loopwright/evolution`)**:
  - Every `scratchpadIntervalGenerations` (`1..32`), synthesize a bounded (`<= 16 KiB`), `SecretScrubber`-clean Markdown/JSON scratchpad artifact in CAS (`scratchpad_snapshots`) from verified `campaign.sqlite` lineage deltas: top Pareto gains per niche (with exact speedup deltas and `boundPipeline` shifts) and top recurring failure/regression patterns (`STAGE_A_STATIC_AUDIT_FAILED`, ULP drift, spill regressions).
  - Mount the latest scratchpad snapshot read-only (`0o400`) into subsequent child runs without mutating repository Git state or opening memory PRs mid-campaign.
- **Backward-compatible `hardwareScope` and `hardware_execution` evidence gate in `@loopwright/memory`**:
  - Add optional `hardwareScope?: { readonly accelerator: string; readonly driverConstraint?: string; readonly operatorFamily?: string; readonly boundPipeline?: string }` to `MemoryEntry.scope` in [`packages/memory/src/schema.ts`](../packages/memory/src/schema.ts) and add `'MEMORY_HARDWARE_EVIDENCE_REQUIRED'` to `MemoryErrorCode` in [`packages/memory/src/types.ts`](../packages/memory/src/types.ts).
  - Omit `hardwareScope` when undefined so every existing v1 `MemoryEntry`, `index.json`, `storeDigest`, and `proposalDigest` stays byte-for-byte identical.
  - Enforce a 6th verification gate in `@loopwright/memory` proposal verification: any `upsert` of `kind: 'fact'` or `'invariant'` carrying `hardwareScope` **must** reference at least one `evidenceRef` with `level: 'hardware_execution'` and `observedStatus: 'passed'` (`MEMORY_HARDWARE_EVIDENCE_REQUIRED`), blocking unverified static lore. Verified regressions and dead-end traps (such as cross-core-count tiling mismatches or split-K atomic regressions) admit cleanly as `kind: 'failure_observation'`.
  - Update [`packages/taskpack/src/turnkey-memory.ts`](../packages/taskpack/src/turnkey-memory.ts), [`packages/github-app/src/turnkey-memory.ts`](../packages/github-app/src/turnkey-memory.ts), and memory prompt selection (`selector.ts`) to preserve optional `hardwareScope` and filter active prompt entries by matching `target.matrix[].hardware.accelerator` and `driverConstraint` (preventing `sm_100a` entries from mounting on `sm_89` or `ascend_910b` runs).
- **Acceptance criteria**:
  - Existing v1 memory stores load and hash to identical `storeDigest` values; a `hardwareScope` `fact` lacking a passing `hardware_execution` `evidenceRef` is rejected with `MEMORY_HARDWARE_EVIDENCE_REQUIRED`.
  - Memory selection for `target.matrix` cell `sm_89` excludes `hardwareScope.accelerator = 'sm_100a'` entries while admitting unscoped repository entries and matching `sm_89` entries.

#### 7. Deterministic `evolution-bundle.v1` Export and Guarded Dispatch Manifest (`@loopwright/evolution`, `@loopwright/taskpack`, `@loopwright/cli`)

- **Signed, compatibility-pinned artifact bundle (`dir` and `oci-layout`)**:
  - Implement `exportEvolutionBundle` in `@loopwright/evolution` and wire `loopwright evolve export --campaign <DIR> --out <DIR> [--format dir|oci-layout]` (plus `EvolutionCampaign.spec.export` auto-export on completion).
  - Verify every exported binary and receipt from CAS (`O_NOFOLLOW`, `nlink === 1`, SHA-256 + `byteLength` match, `SecretScrubber` clean) before atomic directory staging:
    1. **`manifest.json` (`kind: EvolutionBundle`, `version: 1`)**: canonical compatibility tuple (`accelerator`, `isolationMode`, `deviceCount`, `driverVersion`, `driverConstraint`, `runtimeVersion`, `topology`, `workloadDigest`, optional `modelDigest` and parallelism tags), Pareto frontier summary across `(islBucket, batchBucket)`, lineage provenance (`campaignId`, `individualIds`, `baseRevision`, `lockHash`), and SHA-256 digests of all bundle members.
    2. **`dispatch-manifest.json` (`version: 1`)**: ordered guarded portfolio routing rules (`1..64` rules specifying `bucketId`, dimension min/max bounds, dtype/alignment predicates, target binary `blobs/sha256/<hex>` + entrypoint symbol, and mandatory `fallback: 'baseline'` semantics for uncovered shapes).
    3. **`receipts/<individualId>.verdict.json`**: unmodified HMAC-signed `SignedBenchmarkVerdictReceipt`(s) binding `hardwareProvenance`, `bucketMetrics`, and Stage A `outputArtifacts` digests so downstream serving control planes can independently verify authenticity and ULP/Token-Forcing compliance before mounting.
    4. **`blobs/sha256/<hex>`** (and standard OCI Image Layout `oci-layout` + `index.json` when `--format oci-layout` is selected): sealed `.cubin`, `.so`, `.o` + host tiling libraries, compiled graph caches, and tuned runtime/speculative policy JSONs.
  - Refuse bundle export (`EXPORT_UNVERIFIED_FORBIDDEN`) if any selected individual lacks a passing `hardware_execution` receipt (`probeKind: 'physical'` unless `--allow-synthetic-probe` is explicitly passed for offline testing) or if `portfolioHeldOutWorkloadId` failed under `specialist-then-portfolio` mode.
- **Acceptance criteria**:
  - Exporting the same completed campaign twice produces byte-identical `manifest.json`, `dispatch-manifest.json`, and OCI `index.json` digests.
  - Tampering with one byte of a Stage A `.cubin` blob or trying to export a `synthetic_fixture` receipt without `--allow-synthetic-probe` fails closed (`ARTIFACT_INVALID` or `EXPORT_UNVERIFIED_FORBIDDEN`).

### Notes / Constraints / Caveats

- Target Node.js `26.x` (`node:sqlite` built-in), strict ESM (`NodeNext`), explicit public parameter/return types, and zero `any` across all 12 workspace packages.
- Add **zero** new third-party runtime npm dependencies; reuse `@loopwright/taskpack` strict YAML 1.2 core helpers (`parseYamlDocument`, `readBoundedRegularFile`) in `@loopwright/evolution`.
- Validate all untrusted JSON, YAML, and SQLite JSON columns into `Object.create(null)` records with `Object.hasOwn`, rejecting lone UTF-16 surrogates, prototype keys, `NaN`, and `Infinity` (`-0` normalized to `0` only in `@loopwright/core`, rejected in campaign/runner config parsers).
- Maintain strict package layering: `@loopwright/evolution` may depend on `@loopwright/core`, `@loopwright/state`, `@loopwright/controller`, `@loopwright/decisions`, `@loopwright/memory`, `@loopwright/taskpack`, and `@loopwright/hardware-runner`, with zero imports from `@loopwright/github-app` or `@loopwright/cli`.
- Keep all specifications, code, documentation, and tests tool-neutral and free of off-repo filesystem paths or private hostnames.

### Boundaries

- **Always:**
  - Isolate multi-generation campaign state in `<campaignRoot>/campaign.sqlite` inside `@loopwright/evolution`, keeping [`packages/state/src/schema.ts`](../packages/state/src/schema.ts) (`DDL`, `format_version = 1`) and [`packages/controller/src/progress.ts`](../packages/controller/src/progress.ts) (`D <= 256`) unchanged.
  - Restrict the `teamEvolution` supervisor role to `tools: ['read']` only, enforce `team-patch.v1` archetype inheritance (`tools <= archetype.tools`, pinned models/resources, immutable scope/gates, `D <= 256` precheck), and automatically roll back `'trial'` `team_configs` that fail to advance within `trialGenerations`.
  - Enforce `evolve-block-guard.v1` SHA-256 outside-block invariance and Stage A static symbol/spill audits before launching Stage B blind benchmarks.
  - Require passing correctness bounds (`max_ulp`, `token_force_max_delta`, `metricThresholds`) across all configured buckets before admitting an individual into the fertile Pareto archive or `evolution-bundle.v1` export.
  - Keep Stage B blind isolation intact (`held_out_workloads` read-only, `networkMode: 'none'`, socket-denying seccomp/seatbelt, zero exported files, and strict enum/numeric validation on `hardwareDiagnostics`).
  - Quarantine workers (`WORKER_DEVICE_QUARANTINED`) if post-Stage-B accelerator health probes detect sticky GPU/NPU faults.
  - Keep `@loopwright/decisions` strictly advisory (`advisoryOnly: true`, `verificationCertified: false`) with deterministic fallbacks when disabled or offline.
  - Preserve the 23-row capability closure split (`18` `closedLocal`, `5` `unprovisionedExternal`) in [`packages/cli/src/closure.ts`](../packages/cli/src/closure.ts).
- **Ask first:**
  - Before adding any third-party runtime npm dependency to any workspace package.
  - Before altering per-run SQLite `DDL` in `@loopwright/state`, `storeDigest` canonicalization in `@loopwright/memory` for legacy v1 entries, or `phaseSchedule` in `@loopwright/controller`.
  - Before changing the 23-row closure ledger dispositions or promoting `external-build-and-accelerator-matrix` without an `ExternalQualificationReceipt`.
- **Never:**
  - Never allow candidate code to modify lines outside `EVOLVE-BLOCK` markers in guarded files or link forbidden fallback libraries (`cublas`, `rocblas`, `aclnn`, `at::native`) when `forbiddenSymbolPatterns` is active.
  - Never allow the plateau supervisor to write candidate files, grant tools outside `archetype.tools`, share unisolated mutable directories across parallel roles, or weaken `scope.writable` / `acceptance.required`.
  - Never export files or free-text `held_out_workloads` strings from Stage B through `hardwareDiagnostics` or `bucketMetrics`.
  - Never admit a `hardwareScope` positive performance `fact` into `@loopwright/memory` without a passing `hardware_execution` `evidenceRef`.
  - Never let `BENCHMARK_PREEMPTED` count as candidate fitness failure or `team_configs` trial consumption, and never export `synthetic_fixture` bundles without explicit `--allow-synthetic-probe` opt-in.

### Risks and Mitigations

- **Single fast local-optimum kernel dominating prompts and collapsing search diversity** -> Mitigation: partition archives into isolated islands with **Island Elitism** (rank-1 leaders stay local during migration), hardware MAP-Elites niches, and novelty-decayed parent sampling $w_i = s_i \cdot (1 + N(P_i))^{-1}$.
- **Supervisor-minted roles escalating privileges, clobbering shared workspaces, or burning budget on bloated teams** -> Mitigation: trigger supervisor turns only on deterministic plateaus/pathologies, validate `team-patch.v1` against host archetype envelopes (`TEAM_ENVELOPE_VIOLATION`, `maxTeamSize <= 4`, `D <= 256`), wire inter-role handoffs strictly via `StepHandoffSelector`, and auto-rollback `'trial'` teams after `trialGenerations` without gain.
- **Per-shape evolution overfitting target benchmarks and regressing 5x-3,000x on unseen shapes** -> Mitigation: support two-stage `specialist-then-portfolio` synthesis emitting explicit `dispatch-manifest.json` shape predicates with mandatory `baseline` fallback, gated on frozen `portfolioHeldOutWorkloadId` shards.
- **Reward hacking via library fallbacks, precision truncation, or single-step KV cache corruption** -> Mitigation: combine Stage A ELF/PTX/SASS symbol denylists with Stage B `all_buckets` ULP and `token_force_max_delta` checks.
- **Faulty TMA/async kernel triggering GPU `Xid` sticky errors and poisoning subsequent candidates** -> Mitigation: run out-of-band host accelerator health probes in `worker.ts` after every Stage B crash/timeout and quarantine unhealthy workers (`WORKER_DEVICE_QUARANTINED`) before acquiring new leases.
- **Exfiltrating private `held_out_workloads` via profiler outputs** -> Mitigation: forbid raw profiler file exports from Stage B and restrict `hardwareDiagnostics` to closed pipeline enums, bounded stall reason identifiers, and finite numeric percentages/counts validated by the supervisor.
- **Cross-architecture memory pollution (such as applying `sm_100a` TMEM idioms on `sm_89` or `ascend_910b`)** -> Mitigation: bind optional `hardwareScope` on `@loopwright/memory` entries, require passing `hardware_execution` receipts on positive facts, and filter active prompt memories by matching target cell hardware.
- **Static recipe lock-in degrading evolutionary ceiling** -> Mitigation: keep mid-campaign guidance in a dynamic CAS `scratchpad_snapshots` artifact computed strictly from measured in-campaign lineage deltas rather than unverified static prose.
- **Adding `'evolve-block-guard.v1'` updates `installedHandlerDigests()` across `@loopwright/controller` and invalidates hardcoded digest fixtures** -> Mitigation: resolve handler digests via `installedHandlerDigests()` in controller and taskpack tests while asserting byte-identical `TaskContract` and `TaskLock` digests on existing workflows that omit `evolve-block-guard.v1`.
- **Concurrent child evaluations (`maxConcurrentEvaluations > 1`) contending on `<campaignRoot>/campaign.sqlite` under `journal_mode = DELETE` and `synchronous = FULL`** -> Mitigation: serialize all `campaign.sqlite` mutations and queries through a single in-process coordinator queue in `packages/evolution/src/store.ts` while child runs write only to isolated `<campaignRoot>/runs/<individualId>/` stores, and execute `--pkg evolution` SQLite lock tests with `--concurrency 1`.
- **Wide `bucketMetrics` payloads (`64` buckets) overflowing the `49,152`-byte `MAX_STAGE_B_RESULT_BYTES` Stage B stdout envelope** -> Mitigation: cap each `bucketMetrics` entry at `<= 16` numeric metrics and `<= 8` dimension keys in both `@loopwright/core` and `@loopwright/hardware-runner` parsers so worst-case 64-bucket envelopes remain well below `49,152` bytes.
- **Registering a 12th workspace package breaking static CLI import guards (`runner-cli.test.ts`), `.opencodereview/rule.json` coverage checks (`docs-and-site.test.ts`), `npm-pack.test.ts` bundled counts, or self-upgrade unmanaged-workspace digests** -> Mitigation: land an atomic `T1` workspace prefactor updating all 12-package manifests and `.auto-sync/digests.lock.json` together, and load `@loopwright/evolution` strictly via lazy `await import('@loopwright/evolution')` inside `packages/cli/src/main.ts`.

## Design Details

### Commands

Confirmed build and verification environment:
- **Primary mode**: Local deterministic offline and loopback execution on `macOS Darwin arm64` (`Darwin 25.6.0 arm64` verified) and `Linux x86_64/arm64`, using `Node.js v26.13.1` (built-in `node:sqlite`), `npm 11.20.0`, and `git 2.50+`. Automated suites run offline with `allowSyntheticHardwareProbe: true` and require zero external network calls or physical GPUs.
- **Optional live hardware smoke**: On-demand remote SSH checks when `LOOPWRIGHT_CUDA_SSH_HOST` or `LOOPWRIGHT_ROCM_SSH_HOST` is explicitly provisioned (`probeKind: 'physical'`).

```bash
# Sync workspace links for the 12th package (@loopwright/evolution) and install cleanly
npm install --package-lock-only && npm ci

# Build all 12 workspace packages, typecheck, and lint
npm run build
npm run typecheck
npm run lint

# Validate connected docs and rebuild the Hugo site
npm run lint:docs
npm run site

# Compile tests and run targeted package test suites
npx tsc -p tsconfig.test.json
node scripts/run-tests.mjs --pkg core
node scripts/run-tests.mjs --pkg controller
node scripts/run-tests.mjs --pkg decisions
node scripts/run-tests.mjs --pkg memory
node scripts/run-tests.mjs --pkg taskpack
node scripts/run-tests.mjs --pkg github-app
node scripts/run-tests.mjs --pkg hardware-runner
node scripts/run-tests.mjs --pkg evolution --concurrency 1
node scripts/run-tests.mjs --pkg cli

# Full 12-package test suite, tarball bundling check, and 23-row closure verification
npm test
node packages/cli/dist/main.js closure --verify-failures --json
```

### Project Structure

```text
packages/
  core/src/
    contracts.ts          # + bucketScope on MetricThresholdRule, Stage A static audit fields on HardwareTargetSpec
    evidence.ts           # + optional bucketMetrics (<= 64 buckets, <= 16 metrics/bucket) and hardwareDiagnostics on Evidence.spec
    diagnostics.ts        # + STAGE_A_STATIC_AUDIT_FAILED, TEAM_ENVELOPE_VIOLATION, EXPORT_UNVERIFIED_FORBIDDEN
    acceptance.ts         # Enforce bucketScope ('aggregate' | 'all_buckets' | { bucketId }) across bucketMetrics
  controller/src/
    handlers.ts           # Register 'evolve-block-guard.v1' in installedHandlerDigests()
    registry.ts           # Validate 'evolve-block-guard.v1' parameters (files, allowedBlockIds, maxBlockBytes)
    verifier-protocol.ts  # Execute deterministic EVOLVE-BLOCK-START/END outside-byte SHA-256 invariance check
    benchmark-gate.ts     # Forward Stage A static audit rules, bucketMetrics, and hardwareDiagnostics in receipts
  decisions/src/
    types.ts              # + advise_mutation_novelty, route_evolution_strategy, advise_cascade_escalation intents & types
    nodes.ts              # evaluateMutationNovelty (token-shingle + Jev), routeEvolutionStrategy, evaluateCascadeEscalation
  memory/src/
    types.ts              # + optional HardwareMemoryScope on MemoryEntry['scope'] and MEMORY_HARDWARE_EVIDENCE_REQUIRED
    schema.ts             # Validate optional hardwareScope (omitted when unset for v1 storeDigest parity)
    verifier.ts           # Enforce passing hardware_execution evidenceRef on hardwareScope fact/invariant upserts
    selector.ts           # Filter active prompt memories against target cell accelerator & driverConstraint
  taskpack/src/
    types.ts              # + 'evolve-block-guard.v1' check kind and optional hardwareScope projection plumbing
    schema.ts             # Validate evolve-block-guard.v1 and Stage A static audit declarations
    turnkey-memory.ts     # Preserve optional hardwareScope from matched hardware target.matrix cells
  github-app/src/
    turnkey-memory.ts     # Preserve optional hardwareScope on separate-pull-request memory proposals
  hardware-runner/src/
    types.ts              # + StageAStaticAuditSpec, BucketMetricEntry, HardwareDiagnosticsSummary, WORKER_DEVICE_QUARANTINED
    evaluator.ts          # Stage A forbidden-symbol/spill audit; Stage B bucketMetrics + sanitized hardwareDiagnostics parser
    provenance.ts         # Post-crash accelerator health check (Xid / ECC / unresponsive device detection)
    worker.ts             # Out-of-band post-crash health check and fail-closed worker quarantine before next lease poll
  evolution/              # NEW 12th workspace package (@loopwright/evolution)
    package.json          # Built-in node:sqlite + workspace deps only (zero new third-party npm dependencies)
    tsconfig.json         # Composite NodeNext build config
    src/
      index.ts            # Public campaign runner, archive store, team supervisor, Pareto, sampler, and bundle APIs
      types.ts            # EvolutionCampaignManifest, TeamPatchV1, TeamConfigRecord, NicheKey, EvolutionBundle types
      schema.ts           # Strict null-prototype parser for EvolutionCampaign, team-patch.v1, and dispatch-manifest.json
      store.ts            # Single-writer fenced campaign.sqlite store (1,000ms clock guard, islands, team_configs, lineage_edges)
      team-supervisor.ts  # Plateau/RunEval trigger, read-only supervisor runner, archetype envelope compiler, trial rollback
      pareto.ts           # Deterministic NSGA-II non-dominated sorting, crowding distance, and hypervolume contribution
      sampler.ts          # Stepping-stone novelty-decayed parent sampler, multi-parent 0o400 context builder, UCB1 bandit
      scratchpad.ts       # Periodic deterministic CAS meta-scratchpad synthesizer (gains + dead-end anti-patterns)
      campaign.ts         # Async Proposal <-> Child LocalRunStore / benchmark-gate.v1 orchestrator + specialist/portfolio stages
      bundle.ts           # O_NOFOLLOW CAS-verified evolution-bundle.v1 exporter (dir and oci-layout + dispatch-manifest.json)
  cli/src/
    arguments.ts          # + loopwright evolve check|run|resume|status|inspect|export CLI grammar
    main.ts               # Lazy await import('@loopwright/evolution') subcommand handlers and deterministic exit codes
    closure.ts            # Add '@loopwright/evolution' to OWNER_PACKAGES; keep 18/5 closure split intact
docs/ & site/             # Update module map, configuration/operations/contribute guides, and Hugo site during build
```

### Code Style

```ts
// Stepping-stone novelty-decayed parent weight and deterministic NSGA-II dominance in packages/evolution/src/pareto.ts
export interface ObjectiveDirectionSpec {
  readonly metric: string;
  readonly direction: 'minimize' | 'maximize';
}

export function dominatesObjectives(
  candidate: Readonly<Record<string, number>>,
  incumbent: Readonly<Record<string, number>>,
  objectives: readonly ObjectiveDirectionSpec[],
): boolean {
  if (objectives.length === 0) return false;
  let strictlyBetterInAtLeastOne = false;
  for (const obj of objectives) {
    const a = candidate[obj.metric];
    const b = incumbent[obj.metric];
    if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) {
      return false;
    }
    if (obj.direction === 'minimize') {
      if (a > b) return false;
      if (a < b) strictlyBetterInAtLeastOne = true;
    } else {
      if (a < b) return false;
      if (a > b) strictlyBetterInAtLeastOne = true;
    }
  }
  return strictlyBetterInAtLeastOne;
}

export function computeSteppingStoneSamplingWeight(
  fitness: number,
  islandMedianFitness: number,
  offspringCount: number,
  noveltyDecayLambda: number,
): number {
  const scaled = Math.max(-60, Math.min(60, noveltyDecayLambda * (fitness - islandMedianFitness)));
  const performanceScore = 1 / (1 + Math.exp(-scaled));
  const noveltyFactor = 1 / (1 + Math.max(0, offspringCount));
  return performanceScore * noveltyFactor;
}
```

Key conventions:
- Validate every untrusted YAML, JSON, and SQLite payload into `Object.create(null)` records with `Object.hasOwn`, zero `any`, and explicit collection/byte ceilings.
- Keep campaign SQLite storage isolated in `packages/evolution/src/store.ts` (`campaign.sqlite`) with single-writer coordinator serialization so single-run `LocalRunStore` invariants and `D <= 256` checkpoints remain unchanged.
- Verify `O_NOFOLLOW`, `nlink === 1`, SHA-256 digests, and `SecretScrubber` cleanliness on every parent handoff slice, `team-patch.v1` artifact, scratchpad snapshot, and exported `evolution-bundle.v1` blob.

### Implementation Plan

Parallel execution waves (`my-build evolutionary-campaigns-pareto-archive-and-bundle-export team`):
- **Wave 1 (Foundation Prefactor)**: `T1`
- **Wave 2 (Disjoint Leaf Packages)**: `T2` (`core`) || `T3` (`decisions`) || `T4` (`memory`)
- **Wave 3 (Runtime Gates & Evolution Core)**: `T5` (`controller`) || `T6` (`hardware-runner`) || `T7` (`evolution` store/pareto/sampler/scratchpad)
- **Wave 4 (Taskpack/App Wiring & Bundle Exporter)**: `T8` (`taskpack` + `github-app`) || `T9` (`evolution` bundle)
- **Wave 5 (Campaign & Plateau Supervisor Orchestration)**: `T10` (`evolution` supervisor + campaign)
- **Wave 6 (CLI Integration & Closure Matrix)**: `T11` (`cli` + `taskpack-runner` parity)
- **Wave 7 (Docs, Hugo Site & Full Verification)**: `T12`

- [x] **T1 · 12-package workspace prefactor and `@loopwright/evolution` scaffold**
      Blocked by: None
      Owns: `package.json`, `package-lock.json`, `tsconfig.test.json`, `.opencodereview/rule.json`, `scripts/build.mjs`, `scripts/run-tests.mjs`, `scripts/pack-npm.mjs`, `scripts/prepare-self-upgrade.mjs`, `.auto-sync/checks/verify.sh`, `.auto-sync/digests.lock.json`, `packages/evolution/package.json`, `packages/evolution/tsconfig.json`, `packages/evolution/src/index.ts`, `packages/evolution/test/scaffold.test.ts`, `packages/cli/package.json`, `packages/cli/tsconfig.json`, `packages/cli/test/build-incremental.test.ts`, `packages/cli/test/npm-pack.test.ts`, `packages/cli/test/docs-and-site.test.ts`, `packages/github-app/test/self-upgrade-fixtures.ts`
      Gate: review
      Acceptance: `@loopwright/evolution` builds, typechecks, lints, packs as the 12th bundled workspace package with zero new third-party runtime dependencies, passes `.opencodereview/rule.json` coverage assertions, updates self-upgrade `UNMANAGED_WORKSPACES` and `.auto-sync/digests.lock.json`, and keeps `@loopwright/state` `expectedSchema()` byte-identical.
      Verify: `npm run build && npm run typecheck && npm run lint && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg evolution --concurrency 1 && node --test build-test/packages/cli/test/build-incremental.test.js build-test/packages/cli/test/npm-pack.test.js build-test/packages/cli/test/docs-and-site.test.js build-test/packages/github-app/test/self-upgrade.test.js`

- [ ] **T2 · Core Stage A static audit contracts, `bucketScope` thresholds, `bucketMetrics`, and `hardwareDiagnostics`**
      Blocked by: T1
      Owns: `packages/core/src/**`, `packages/core/test/**`
      Gate: review
      Acceptance: `HardwareTargetSpec` accepts optional `forbiddenSymbolPatterns` (`0..64`), `maxRegisterCount`, and `maxLocalSpillBytes` without altering legacy canonical digests when omitted; `Evidence.spec` validates bounded `bucketMetrics` (`1..64` buckets, `<= 16` numeric metrics and `<= 8` dimension keys per bucket) and closed-enum `hardwareDiagnostics` (rejecting free-text strings, `-0`/`NaN`/`Infinity`, prototype keys, and secrets); `evaluateAcceptance` enforces `bucketScope` (`'aggregate' | 'all_buckets' | { bucketId }`); `diagnostics.ts` exports `STAGE_A_STATIC_AUDIT_FAILED`, `TEAM_ENVELOPE_VIOLATION`, and `EXPORT_UNVERIFIED_FORBIDDEN`.
      Verify: `npm run build && npm run typecheck && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg core`

- [x] **T3 · System-One (`@loopwright/decisions`) novelty filter, strategy track router, and cascade escalation nodes**
      Blocked by: T1
      Owns: `packages/decisions/src/**`, `packages/decisions/test/**`
      Gate: review
      Acceptance: `DECISION_ALLOWED_AUTHORITY_INTENTS` includes `'advise_mutation_novelty'`, `'route_evolution_strategy'`, and `'advise_cascade_escalation'` while all six `DECISION_FORBIDDEN_AUTHORITY_INTENTS` still throw `DecisionError('DECISION_AUTHORITY_VIOLATION')`; `evaluateMutationNovelty` rejects exact whitespace/comment-normalized token-shingle clones (`Jaccard === 1.0`) with `0` network calls and queries Jev `noul` in `[noveltyThreshold, 1.0)` under `disclosurePolicy`; `routeEvolutionStrategy` and `evaluateCascadeEscalation` stamp `advisoryOnly: true` and `verificationCertified: false` with deterministic offline fallbacks.
      Verify: `npm run build && npm run typecheck && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg decisions`

- [ ] **T4 · Hardware-scoped reviewed memory (`hardwareScope`) and `hardware_execution` evidence gate**
      Blocked by: T1
      Owns: `packages/memory/src/**`, `packages/memory/test/**`
      Gate: review
      Acceptance: `MemoryEntry.scope` supports optional `hardwareScope` (`accelerator`, optional `driverConstraint`, `operatorFamily`, `boundPipeline`) omitted when undefined so all legacy v1 `storeDigest` and `proposalDigest` fixtures remain byte-for-byte identical; `verifier.ts` enforces a 6th gate rejecting `hardwareScope` `fact`/`invariant` upserts that lack a passing `hardware_execution` `evidenceRef` (`MEMORY_HARDWARE_EVIDENCE_REQUIRED` in `packages/memory/src/types.ts`) while admitting `failure_observation`; `selector.ts` filters active prompt memories by matching target cell `accelerator` and `driverConstraint`.
      Verify: `npm run build && npm run typecheck && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg memory`

- [ ] **T5 · Controller `evolve-block-guard.v1` verifier and `benchmark-gate.v1` Stage A/B receipt forwarding**
      Blocked by: T2
      Owns: `packages/controller/src/**`, `packages/controller/test/**`
      Gate: review
      Acceptance: `handlers.ts`, `registry.ts`, and `verifier-protocol.ts` implement deterministic `'evolve-block-guard.v1'` (`1..32` `EVOLVE-BLOCK-START/END` pairs per file, rejecting nested/duplicate/reordered/unclosed markers, `maxBlockBytes` overflow, `allowedBlockIds` violations, or any single-byte mutation outside mutable blocks against `baseRevision` SHA-256); `benchmark-gate.ts` forwards Stage A static audit fields, `bucketMetrics`, and `hardwareDiagnostics` onto recorded `Evidence` while keeping `D <= 256` `phaseSchedule` untouched and resolving handler digests cleanly via `installedHandlerDigests()`.
      Verify: `npm run build && npm run typecheck && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg controller`

- [ ] **T6 · Hardware-runner Stage A symbol/spill static audits, Stage B bucket/Roofline parser, and post-crash GPU quarantine**
      Blocked by: T2
      Owns: `packages/hardware-runner/src/**`, `packages/hardware-runner/test/**`
      Gate: review
      Acceptance: `evaluator.ts` audits sealed Stage A `.so`/`.o`/`.cubin`/`.ptx`/`.sass` outputs (`O_NOFOLLOW`, `1 MiB` cap) and denies `forbiddenSymbolPatterns` (`cublas`, `rocblas`, `aclnn`, `at::native`) or `maxRegisterCount`/`maxLocalSpillBytes` breaches with `STAGE_A_STATIC_AUDIT_FAILED` before Stage B starts; Stage B parses bounded `bucketMetrics` + sanitized `hardwareDiagnostics` (`<= 49,152` bytes, zero exported files, `all_buckets` threshold enforcement); `provenance.ts` and `worker.ts` run post-crash/timeout accelerator health probes (`Xid`/ECC/hang) and fail closed into `WORKER_DEVICE_QUARANTINED` (exit code `3`) before polling `/v1/runner/leases:acquire`.
      Verify: `npm run build && npm run typecheck && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg hardware-runner`

- [ ] **T7 · `@loopwright/evolution` schemas, fenced `campaign.sqlite` store, NSGA-II Pareto engine, UCB1 sampler, and CAS scratchpad**
      Blocked by: T2
      Owns: `packages/evolution/src/types.ts`, `packages/evolution/src/schema.ts`, `packages/evolution/src/store.ts`, `packages/evolution/src/pareto.ts`, `packages/evolution/src/sampler.ts`, `packages/evolution/src/scratchpad.ts`, `packages/evolution/test/schema-and-store.test.ts`, `packages/evolution/test/pareto-and-sampler.test.ts`, `packages/evolution/test/scratchpad.test.ts`
      Gate: review
      Acceptance: Null-prototype parsers validate `EvolutionCampaign` (`<= 65,536` bytes), `team-patch.v1` (`<= 32,768` bytes), and `dispatch-manifest.json`; `store.ts` manages `<campaignRoot>/campaign.sqlite` (`journal_mode = DELETE`, `synchronous = FULL`, `STRICT` tables `campaign_meta`, `campaigns`, `islands`, `team_configs`, `individuals`, `lineage_edges`, `O_NOFOLLOW`, `1,000ms` clock-drift guard, and single-writer in-process coordinator serialization); `pareto.ts` computes deterministic NSGA-II ranks, crowding distances, and hypervolume deltas; `sampler.ts` implements **Island Elitism** ring migration, novelty-decayed stepping-stone parent weights, `0o400` multi-parent `contextFiles`, and UCB1 model bandit updates; `scratchpad.ts` writes `SecretScrubber`-clean `<= 16 KiB` CAS snapshots.
      Verify: `npm run build && npm run typecheck && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg evolution --concurrency 1`

- [ ] **T8 · Taskpack and GitHub App `evolve-block-guard.v1` compilation, Stage A audit schema, and `hardwareScope` memory projection**
      Blocked by: T4, T5
      Owns: `packages/taskpack/src/**`, `packages/taskpack/test/**`, `packages/github-app/src/turnkey-memory.ts`, `packages/github-app/test/turnkey-memory*.test.ts`
      Gate: review
      Acceptance: `Taskpack` schema and compiler accept `'evolve-block-guard.v1'` checks and optional Stage A static audit fields without changing `TaskContract` or `TaskLock` digests on existing v2 taskpacks that omit them; `turnkey-memory.ts` in both `@loopwright/taskpack` and `@loopwright/github-app` projects optional `hardwareScope` (`accelerator`, `driverConstraint`) from matched hardware `target.matrix` cells onto reviewed memory proposals and active memory selection.
      Verify: `npm run build && npm run typecheck && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg taskpack && node scripts/run-tests.mjs --pkg github-app`

- [ ] **T9 · `@loopwright/evolution` deterministic `evolution-bundle.v1` exporter (`dir` and `oci-layout`)**
      Blocked by: T7
      Owns: `packages/evolution/src/bundle.ts`, `packages/evolution/test/bundle.test.ts`
      Gate: review
      Acceptance: `exportEvolutionBundle` stages deterministic `dir` and `oci-layout` (`oci-layout` + `index.json` + `blobs/sha256/<hex>`) bundles containing `manifest.json` (`kind: EvolutionBundle`, `version: 1`), `dispatch-manifest.json` (`fallback: 'baseline'`), and unmodified HMAC-signed `receipts/<individualId>.verdict.json` files after `O_NOFOLLOW`, `nlink === 1`, SHA-256/`byteLength`, and `SecretScrubber` checks; refuses unverified or `synthetic_fixture` receipts (`EXPORT_UNVERIFIED_FORBIDDEN`) unless `allowSyntheticProbe: true` is explicitly set; repeated exports produce byte-identical digests.
      Verify: `npm run build && npm run typecheck && npx tsc -p tsconfig.test.json && node --test build-test/packages/evolution/test/bundle.test.js`

- [ ] **T10 · `@loopwright/evolution` plateau `team-supervisor.ts`, `specialist-then-portfolio` synthesis, and `campaign.ts` orchestrator**
      Blocked by: T3, T6, T7, T8, T9
      Owns: `packages/evolution/src/team-supervisor.ts`, `packages/evolution/src/campaign.ts`, `packages/evolution/src/index.ts`, `packages/evolution/test/team-supervisor.test.ts`, `packages/evolution/test/campaign-e2e.test.ts`
      Gate: review
      Acceptance: `campaign.ts` orchestrates async multi-island generations over fenced child `LocalRunStore` runs (`<campaignRoot>/runs/<individualId>/`), integrating `@loopwright/decisions` pre-filters, periodic `scratchpad` mounts, graceful `SIGTERM` / `BENCHMARK_PREEMPTED` resume without double-counting `maxEvaluations`, and two-stage `specialist-then-portfolio` dispatch verification on `portfolioHeldOutWorkloadId`; `team-supervisor.ts` triggers `tools: ['read']` supervisor runs only on `stallGenerations` or consecutive `RunEval` `pingPong`/`toolRepeats` pathologies, enforces the fail-closed Archetype Capability Envelope (`TEAM_ENVELOPE_VIOLATION`, `tools <= archetype.tools`, `StepHandoffSelector` relays, `D <= 256` precheck), promotes advancing `'trial'` `team_configs`, and auto-rolls back stalled trials after `trialGenerations`.
      Verify: `npm run build && npm run typecheck && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg evolution --concurrency 1`

- [ ] **T11 · CLI lazy-loaded `loopwright evolve` subcommands, offline parity check, and honest 23-row closure ledger**
      Blocked by: T10
      Owns: `packages/cli/src/**`, `packages/cli/test/arguments.test.ts`, `packages/cli/test/closure-and-failure-matrix.test.ts`, `packages/cli/test/evolve-cli.test.ts`, `packages/taskpack-runner/test/**`
      Gate: review
      Acceptance: `loopwright evolve check|run|resume|status|inspect|export` parses cleanly in `arguments.ts` and executes via lazy `await import('@loopwright/evolution')` in `main.ts` (preserving `runner-cli.test.ts` zero-static-import invariant and exit codes `0`, `2..8`, `130/143`); `closure.ts` registers `'@loopwright/evolution'` in `OWNER_PACKAGES` while preserving the exact `18` `closedLocal` / `5` `unprovisionedExternal` split and `CLOSURE_FALSIFICATION_FORBIDDEN` guard.
      Verify: `npm run build && npm run typecheck && npx tsc -p tsconfig.test.json && node scripts/run-tests.mjs --pkg cli && node scripts/run-tests.mjs --pkg taskpack-runner && node packages/cli/dist/main.js closure --verify-failures --json`

- [ ] **T12 · Connected documentation, Hugo site sync, skill references, and full 12-package verification**
      Blocked by: T11
      Owns: `docs/**`, `site/**`, `README.md`, `AGENTS.md`, `.agents/skills/**`, `packages/cli/test/check-docs-rules.test.ts`
      Acceptance: Connected user/contributor docs (`docs/getting-started/architecture.md`, `docs/contribute/internals.md`, configuration/operations guides, `README.md`, `AGENTS.md`, `.agents/skills/loopwright-overview/SKILL.md`), Pretty YAML examples, and Hugo `site/` pages document `@loopwright/evolution`, `EvolutionCampaign`, `evolve-block-guard.v1`, `teamEvolution`, `hardwareScope`, and `evolution-bundle.v1` with zero banned filler words, zero broken links, and green full-workspace CI checks.
      Verify: `npm run lint:docs && npm run site && npm run lint && npm test`

### Test Plan

[ ] I/we understand the owners of the involved components may require updates to existing tests to make this code solid enough prior to committing the changes necessary to implement this enhancement.

#### Prerequisite testing updates

- Update hardcoded workspace package count assertions (`11 -> 12`) in [`packages/cli/test/build-incremental.test.ts`](../packages/cli/test/build-incremental.test.ts) and [`packages/cli/test/npm-pack.test.ts`](../packages/cli/test/npm-pack.test.ts), add `packages/evolution/**/*.ts` to [`.opencodereview/rule.json`](../.opencodereview/rule.json) for [`packages/cli/test/docs-and-site.test.ts`](../packages/cli/test/docs-and-site.test.ts), and sync `UNMANAGED_WORKSPACES` + [`.auto-sync/digests.lock.json`](../.auto-sync/digests.lock.json) in [`packages/github-app/test/self-upgrade-fixtures.ts`](../packages/github-app/test/self-upgrade-fixtures.ts) (`T1`).
- Ensure controller and taskpack test suites resolve handler digests dynamically through `installedHandlerDigests()` when `'evolve-block-guard.v1'` is registered (`T5`, `T8`).

#### Unit tests

- `@loopwright/core`: `2026-11-23` - `>= 90%` (`bucketMetrics` per-bucket `<= 16` metric / `<= 8` dimension bounds, `hardwareDiagnostics` enum/ASCII/secret rejection, `bucketScope` `'aggregate' | 'all_buckets' | { bucketId }` threshold enforcement, Stage A static audit optional hash invariance).
- `@loopwright/decisions`: `2026-11-23` - `>= 90%` (`evaluateMutationNovelty` zero-network `Jaccard === 1.0` reject and Jev soft-band `noul` triage, `routeEvolutionStrategy`, `evaluateCascadeEscalation`, `DECISION_AUTHORITY_VIOLATION` enforcement, `verificationCertified: false` invariant).
- `@loopwright/memory`: `2026-11-23` - `>= 90%` (`hardwareScope` v1 `storeDigest` backward parity, `MEMORY_HARDWARE_EVIDENCE_REQUIRED` 6th verification gate on `fact`/`invariant` vs `failure_observation` admission, `selector.ts` `accelerator`/`driverConstraint` filtering).
- `@loopwright/controller`: `2026-11-23` - `>= 90%` (`evolve-block-guard.v1` outside-byte SHA-256 invariance, nested/duplicate/reordered/unclosed marker rejection, `maxBlockBytes` and `allowedBlockIds`, `benchmark-gate.v1` receipt forwarding).
- `@loopwright/hardware-runner`: `2026-11-23` - `>= 90%` (Stage A `forbiddenSymbolPatterns` and `maxRegisterCount`/`maxLocalSpillBytes` `STAGE_A_STATIC_AUDIT_FAILED` denial prior to Stage B, `49,152`-byte Stage B `bucketMetrics` + `hardwareDiagnostics` parser, post-crash `WORKER_DEVICE_QUARANTINED` probe).
- `@loopwright/evolution`: `2026-11-23` - `>= 90%` (`EvolutionCampaign` and `team-patch.v1` null-prototype schemas, fenced single-writer `campaign.sqlite` store and `1,000ms` clock-drift guard, NSGA-II rank/crowding/hypervolume determinism, Island Elitism migration, novelty-decayed parent sampling + UCB1 bandit, `TEAM_ENVELOPE_VIOLATION` capability-envelope checks, `trialGenerations` promotion/auto-rollback, CAS `scratchpad`, `dir`/`oci-layout` `evolution-bundle.v1` byte-identical export and tamper rejection).
- `@loopwright/taskpack` & `@loopwright/github-app`: `2026-11-23` - `>= 90%` (`evolve-block-guard.v1` compilation, legacy `TaskLock` digest stability, `turnkey-memory.ts` `hardwareScope` projection).
- `@loopwright/cli`: `2026-11-23` - `>= 90%` (`loopwright evolve` argument grammar, lazy import compliance in `runner-cli.test.ts`, exit codes, 23-row `closure.ts` `18/5` ledger invariance).

#### Integration tests

- **Child `LocalRunStore` + `benchmark-gate.v1` + `evolve-block-guard.v1` loopback**: verify an outside-block edit fails `evolve-block-guard.v1` before hardware lease acquisition, a `cublasGemmEx` symbol fails Stage A with `STAGE_A_STATIC_AUDIT_FAILED` with zero Stage B runtime, and a single-bucket `max_ulp` breach fails `bucketScope: 'all_buckets'` (`METRIC_THRESHOLD_FAILED`).
- **Stepping-stone MAP-Elites crossover & preemption recovery**: verify a slower structural stepping stone in a distinct `bound_pipeline` niche survives, feeds a multi-parent crossover child to rank-1 Pareto dominance, and `BENCHMARK_PREEMPTED` / `SIGTERM` resumes cleanly without consuming `maxEvaluations` or `@loopwright/state` `D <= 256` checkpoints.
- **Plateau `team-patch.v1` synthesis, envelope denial, and `trialGenerations` rollback**: verify steady-progress islands run `0` supervisor turns; stalled or `pingPong` islands run a `tools: ['read']` supervisor, reject tool-widening patches with `TEAM_ENVELOPE_VIOLATION`, execute a valid `probe-readonly -> mutator-sandboxed` `StepHandoffSelector` relay, promote on Pareto gain, and roll back to `parent_team_config_id` when `trialGenerations` expire with zero advance.
- **Cross-silicon `hardwareScope` memory isolation**: verify an `sm_100a` `hardware_execution`-backed memory entry is selected for `sm_100a` runs and excluded from `sm_89` and `ascend_910b` runs.
- **Post-crash worker device quarantine**: verify a simulated sticky `Xid` fault after Stage B crash transitions `worker.ts` into `WORKER_DEVICE_QUARANTINED` before acquiring a second Relay lease.

#### e2e tests

- **Local loopback `specialist-then-portfolio` campaign to `evolution-bundle.v1` OCI export (`packages/evolution/test/campaign-e2e.test.ts` and `packages/cli/test/evolve-cli.test.ts`)**: run `loopwright evolve check`, `loopwright evolve run`, `loopwright evolve status`, `loopwright evolve inspect`, and `loopwright evolve export --format oci-layout --allow-synthetic-probe` end-to-end over a two-bucket specialist campaign plus `portfolioHeldOutWorkloadId` synthesis, asserting verified `manifest.json`, `dispatch-manifest.json` (`fallback: 'baseline'`), HMAC-signed `receipts/*.verdict.json`, and tampered-blob fail-closed rejection (`ARTIFACT_INVALID` / `EXPORT_UNVERIFIED_FORBIDDEN`).
- **Optional live accelerator SSH smoke (on-demand)**: when `LOOPWRIGHT_CUDA_SSH_HOST` or `LOOPWRIGHT_ROCM_SSH_HOST` is set, run a 2-generation physical-probe campaign and export an `evolution-bundle.v1` bundle without `--allow-synthetic-probe`.

## Alternatives

1. **Extend [`packages/state/src/schema.ts`](../packages/state/src/schema.ts) (`format_version = 2`) and [`packages/controller/src/progress.ts`](../packages/controller/src/progress.ts) to store multi-generation populations inside one `LocalRunStore`**:
   - Rejected. Mutating the 5-table `DDL` breaks `expectedSchema()` across existing retained stores and requires lifting the `checkpoints <= 256` and `operations <= 2,048` single-run bounds that underpin deterministic crash-recovery audits. Storing campaign lineage in `<campaignRoot>/campaign.sqlite` while delegating each candidate evaluation to an unmodified child `LocalRunStore` preserves every existing single-run safety proof.
2. **Use greedy single-lineage hill-climbing instead of Island + MAP-Elites + stepping-stone parent decay**:
   - Rejected. Kernel and compiler evolution landscapes are sharply non-convex; structural transitions (such as switching memory layouts or introducing warp specialization) often degrade latency for one generation before tile and barrier parameters are tuned. Greedy selection discards those stepping stones and collapses prompt diversity.
3. **Run an unconditional per-iteration supervisor emitting free-form Markdown `TEAM_CONFIG` over a shared mutable workspace or mutating `CompiledPlan` mid-run**:
   - Rejected. Invoking a supervisor on every generation wastes tokens when the active role is still advancing, regex-scraped Markdown fails unpredictably on nested headings, shared working directories risk cross-agent file clobbering, and unrestricted role tools violate host authority boundaries. Triggering a read-only supervisor only on plateaus/pathologies, enforcing `team-patch.v1` archetype envelopes (`tools <= archetype.tools`), relaying outputs via `StepHandoffSelector`, and auto-rolling back unproductive `team_configs` after `trialGenerations` achieves plateau-breaking specialization safely.
4. **Export raw `ncu` / `rocprof` / `msprof` profiler files directly from Stage B to guide next-generation prompts**:
   - Rejected. Multi-megabyte raw profiler archives bloat LLM context windows and create a covert exfiltration channel for private `held_out_workloads` tensor values and shapes. Distilling bounded numeric counters and closed pipeline/stall enums in the trusted supervisor preserves Stage B zero-file-export isolation.
5. **Seed prompts with large human-authored static optimization cookbooks instead of `hardware_execution`-verified memories and live campaign scratchpads**:
   - Rejected. Empirical continual-compilation ablations show that generic static cookbooks anchor coding agents onto suboptimal templates and risk cross-architecture errors. Admitting only `hardware_execution`-backed `hardwareScope` facts, anti-pattern `failure_observation` entries, and live campaign delta scratchpads keeps guidance grounded in measured silicon behavior.
6. **Allow `@loopwright/decisions` (`typesafe-jev`) to score candidate fitness or approve `evolution-bundle.v1` exports without `benchmark-gate.v1`**:
   - Rejected. Violates Loopwright's non-delegable verification invariant. System-One models can cheaply pre-filter cosmetic clones and route tracks, but only signed `hardware_execution` receipts may admit Pareto elites, hardware memories, or exported bundles.

## Open Questions

None. All user stories, isolated `campaign.sqlite` storage boundaries, plateau-triggered `team-patch.v1` archetype envelopes and `team_configs` trial rollback rules, anti-cheating Stage A/B rules, System-One advisory boundaries, hardware memory scopes, `evolution-bundle.v1` export contracts, and the 12-task `T1`-`T12` implementation and KEP test plans are confirmed.
