# Evolution Campaign

`EvolutionCampaign` (`<= 64 KiB`) defines a bounded multi-generation search over a repository `Taskpack`, an isolated `campaign.sqlite` Pareto archive, and signed `evolution-bundle.v1` exports. Loopwright binds each candidate to an isolated child `LocalRunStore` and never lets models self-certify hardware results.

For an end-to-end setup walkthrough, follow [Evolutionary Campaigns](/loopwright/latest/docs/walkthroughs/evolutionary-campaigns/index.md). For `TaskContract` hardware target cells and threshold rules, see [Task Contract](/loopwright/latest/docs/configuration/task-contract/index.md#hardware-target-cells).

## Contents

- [EvolutionCampaign](#evolutioncampaign)
- [Stages and population](#stages-and-population)
- [Sampling and objectives](#sampling-and-objectives)
- [Plateau team evolution](#plateau-team-evolution)
- [Bundle export contract](#bundle-export-contract)

## EvolutionCampaign

```yaml
apiVersion: loopwright.dev/v1alpha1
kind: EvolutionCampaign
metadata:
  name: flash-decode-sm90a
spec:
  taskpack: .loopwright/taskpack.yaml
  targetCellId: cuda-h100-whole
  tracks: [triton, cute, cuda_raw] # Optional
  stages: # Optional
    mode: specialist-then-portfolio # Optional
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
    modelBandit: ucb1 # Optional
    maxCrossoversPerPrompt: 2
  teamEvolution: # Optional
    enabled: true
    supervisorRoleId: supervisor
    allowedArchetypeRoles: [probe-readonly, mutator-sandboxed, reviewer]
    stallGenerations: 4 # Optional
    minHypervolumeDelta: 0.001 # Optional
    triggerOnRunEvalPathology: true # Optional
    trialGenerations: 2 # Optional
    maxTeamSize: 3 # Optional
    maxTeamSteps: 4 # Optional
  objectives:
    - metric: latency_us_p50
      direction: minimize
    - metric: goodput_rps
      direction: maximize
  budgets:
    maxGenerations: 40
    maxEvaluations: 160
    maxConcurrentEvaluations: 4
    targetRooflineHeadroom: 1.08 # Optional
    scratchpadIntervalGenerations: 5 # Optional
  export: # Optional
    format: oci-layout # Optional
    outputDir: .loopwright-out/bundles/flash-decode-sm90a
```

## Stages and population

Campaigns optimize either one target workload (`single-target`) or bucket-specialized kernels merged into a verified dispatcher (`specialist-then-portfolio`):

- **Taskpack and cell binding**: `spec.taskpack` must point to a repository taskpack whose `target.matrix` declares `spec.targetCellId`.
- **Holdout isolation**: In `specialist-then-portfolio`, `portfolioHeldOutWorkloadId` must differ from every specialist bucket `heldOutWorkloadId` and never enters specialist prompts.
- **Ring-topology islands**: Islands maintain independent MAP-Elites archives and migrate rank-1 elites clockwise every `migrationIntervalGenerations`.
- **Niche projection**: Each `nicheAxes[]` entry maps a metric or hardware diagnostic key into discrete MAP-Elites cells.

| Field path | Required | Bounds and defaults | Behavior |
| --- | --- | --- | --- |
| `spec.taskpack` | Yes | Relative repo path | Taskpack manifest compiled for every child run |
| `spec.targetCellId` | Yes | Identifier (`1..64`) | Hardware cell ID matched against `taskpack` `target.matrix` |
| `spec.heldOutWorkloadId` | No | Identifier (`1..64`) | Optional workload override for `single-target` mode |
| `spec.tracks` | No | `1..32` unique IDs | Candidate implementation tracks (`triton`, `cute`, `cuda_raw`) |
| `spec.stages.mode` | No | `single-target` (default) \| `specialist-then-portfolio` | Selects single workload search or specialist plus portfolio synthesis |
| `stages.specialistBuckets` | No | `1..64` `{ id, heldOutWorkloadId }` | Required when `mode` is `specialist-then-portfolio` |
| `stages.portfolioHeldOutWorkloadId` | No | Identifier (`1..64`) | Holdout workload certifying final portfolio dispatch |
| `spec.population.islands` | Yes | Integer (`1..16`) | Number of isolated ring-topology evolution islands |
| `population.migrationIntervalGenerations` | Yes | Integer (`1..1024`) | Generation cadence between clockwise elite migrations |
| `population.maxMigrationElites` | Yes | Integer (`0..16`) | Maximum rank-1 elites migrated per island step |
| `population.nicheAxes[]` | Yes | `1..4` axes (`enum` \| `numeric_bins`) | `enum`: `1..32` values; `numeric_bins`: `2..32` sorted edges; optional `field` |

## Sampling and objectives

Loopwright selects parents with novelty decay, screens clones before hardware dispatch, and ranks passing candidates via NSGA-II:

- **Pre-dispatch novelty gate**: Normalized token-shingle clones (`Jaccard === 1.0`) fail fast with `NOVELTY_CLONE_REJECTED` and zero hardware calls.
- **Advisory System-One nodes**: Optional novelty, strategy, and cascade nodes (`@loopwright/decisions`) advise sampling and never certify verification.
- **Preemption accounting**: Hardware `BENCHMARK_PREEMPTED` outcomes never consume `maxEvaluations` and never poison bandit rewards.
- **Roofline early stop**: Optional `targetRooflineHeadroom` stops search once observed hardware headroom reaches the declared bound.

| Field path | Required | Bounds and defaults | Behavior |
| --- | --- | --- | --- |
| `sampling.noveltyDecayLambda` | Yes | Finite number in `(0, 100]` | Exponential decay weighting parent offspring counts |
| `sampling.mutationWeights` | Yes | `diff_tune`, `full_rewrite`, `crossover` in `[0, 1000]` | Deterministic per-slot operator selection (sum `> 0`) |
| `sampling.modelBandit` | No | `deterministic-round-robin` (default) \| `ucb1` | Model pool routing across declared `taskpack` models |
| `sampling.maxCrossoversPerPrompt` | Yes | Integer (`0..4`) | Maximum staged parent JSON snapshots per child prompt |
| `spec.objectives[]` | Yes | `1..8` unique `{ metric, direction }` | `minimize` or `maximize` metrics for NSGA-II Pareto ranking |
| `budgets.maxGenerations` | Yes | Integer (`1..10000`) | Maximum campaign generations across active stages |
| `budgets.maxEvaluations` | Yes | Integer (`1..100000`) | Hard ceiling on non-preempted child evaluations |
| `budgets.maxConcurrentEvaluations` | Yes | Integer (`1..64`, `<= maxEvaluations`) | Parallel child evaluation slots per generation |
| `budgets.targetRooflineHeadroom` | No | Finite number (`>= 1.0`) | Optional Roofline headroom early-stop target |
| `budgets.scratchpadIntervalGenerations` | No | Integer (`1..32`, default `5`) | Generation interval for read-only scratchpad synthesis |

## Plateau team evolution

Optional `spec.teamEvolution` invokes a read-only supervisor role only when an island stalls or hits `RunEval` loop pathology:

- **Archetype capability ceiling**: Supervisor `TeamPatch` outputs may only recompose roles within `allowedArchetypeRoles` tool and network ceilings.
- **Zero-mutation supervisor**: The supervisor runs in an isolated read-only `LocalRunStore` (`no_change` verified) with zero repo write tools.
- **Trial rollback safety**: Trial teams auto-rollback to the incumbent after `trialGenerations` without Pareto or niche gain; malformed patches keep the incumbent active.

| Field path | Required | Bounds and defaults | Behavior |
| --- | --- | --- | --- |
| `teamEvolution.enabled` | Yes | Boolean | Enables plateau and pathology supervisor turns |
| `teamEvolution.supervisorRoleId` | Yes | Identifier (`1..64`) | Read-only supervisor role identifier |
| `teamEvolution.allowedArchetypeRoles` | Yes | `1..16` role IDs | Declared archetype roles bounding synthesized teams |
| `teamEvolution.stallGenerations` | No | Integer (`1..32`, default `4`) | Consecutive low-gain generations before supervisor trigger |
| `teamEvolution.minHypervolumeDelta` | No | Number (`>= 0`, default `0.001`) | Minimum hypervolume gain required to reset stall counter |
| `teamEvolution.triggerOnRunEvalPathology` | No | Boolean (default `true`) | Triggers supervisor on repeated `RunEval` tool-loop pathology |
| `teamEvolution.trialGenerations` | No | Integer (`1..8`, default `2`) | Trial evaluation window before automatic incumbent rollback |
| `teamEvolution.maxTeamSize` | No | Integer (`1..4`, default `4`) | Maximum roles permitted in a synthesized `TeamPatch` |
| `teamEvolution.maxTeamSteps` | No | Integer (`1..6`, default `6`) | Maximum DAG steps permitted in a synthesized `TeamPatch` |

## Bundle export contract

Optional `spec.export` (or `loopwright evolve export`) writes deterministic, content-addressed `evolution-bundle.v1` directories or OCI 1.1 layouts:

- **Fail-closed receipt verification**: Export refuses missing HMAC secrets, tampered CAS blobs, incompatible hardware provenance, or unopted `synthetic_fixture` receipts (`EXPORT_UNVERIFIED_FORBIDDEN`).
- **Atomic staging**: Bundles stage into a sibling non-symlink directory and rename atomically; existing destinations fail with `EVOLUTION_CONFLICT` unless `--overwrite` is passed.

| Field or member | Value or format | Role |
| --- | --- | --- |
| `spec.export.format` | `dir` (default) \| `oci-layout` | Plain directory or OCI 1.1 image layout (`oci-layout` + `index.json`) |
| `spec.export.outputDir` | Relative path | Target directory for auto-export upon completion |
| `manifest.json` | `kind: EvolutionBundle`, `version: 1` | Hardware `compatibility`, `paretoSummary`, `lineage`, and member SHA-256 digests |
| `dispatch-manifest.json` | `version: 1`, `fallback: baseline` | Bucket routing rules (`dimensionBounds`, `dtypes`, `alignmentBytes`, `blobDigest`, `entrypoint`) |
| `receipts/<id>.verdict.json` | Signed `benchmark_verdict` JSON | Verbatim HMAC-signed hardware verdict receipts per exported individual |
| `blobs/sha256/<hex>` | Verified Stage A CAS blobs | Compiled `.cubin`, `.so`, `.o`, or `.ptx` artifacts referenced by dispatch rules |

---

**See also** — [Evolutionary Campaigns](/loopwright/latest/docs/walkthroughs/evolutionary-campaigns/index.md) (end-to-end setup and `loopwright evolve` walkthrough) · [Task Contract](/loopwright/latest/docs/configuration/task-contract/index.md#hardware-target-cells) (hardware target cells, thresholds, and provenance) · [CLI](/loopwright/latest/docs/operations/cli/index.md#evolution-campaigns) (`runner` and `evolve` subcommands)

**Next** → [Evolutionary Campaigns](/loopwright/latest/docs/walkthroughs/evolutionary-campaigns/index.md) — mark `EVOLVE-BLOCK` spans, run a hardware relay, and export signed bundles.
