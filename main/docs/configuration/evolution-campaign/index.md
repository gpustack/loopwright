# Evolution Campaign

`EvolutionCampaign` (`<= 64 KiB`) defines a bounded multi-generation search over a repository `Taskpack`, an isolated `campaign.sqlite` Pareto archive, and signed `evolution-bundle.v1` exports. Loopwright binds each candidate to an isolated child `LocalRunStore` and never lets models self-certify hardware results.

For an end-to-end setup walkthrough, follow [Evolutionary Campaign](/loopwright/main/docs/walkthroughs/evolutionary-campaign/index.md). For `TaskContract` hardware target cells and threshold rules, see [Task Contract](/loopwright/main/docs/configuration/task-contract/index.md#hardware-target-cells).

## Contents

- [EvolutionCampaign](#evolutioncampaign)
- [Stages and population](#stages-and-population)
- [Sampling and budgets](#sampling-and-budgets)
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
  tracks: # Optional
    - triton
    - cute
    - cuda_raw
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
        values:
          - hbm
          - l2
          - smem_lds_ub
          - tensor_cube
          - vector_valu
      - id: occupancy_band
        kind: numeric_bins
        edges:
          - 0
          - 25
          - 50
          - 75
          - 100
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
    allowedArchetypeRoles:
      - probe-readonly
      - mutator-sandboxed
      - reviewer
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

- **Taskpack & cell binding**: `spec.taskpack` must point to a repository taskpack whose `target.matrix` declares `spec.targetCellId`.
- **Holdout isolation**: In `specialist-then-portfolio`, `portfolioHeldOutWorkloadId` must differ from every specialist `heldOutWorkloadId` and never enters specialist prompts.
- **Ring-topology islands**: `1..16` islands maintain independent MAP-Elites archives and migrate rank-1 elites clockwise every `migrationIntervalGenerations`.
- **Niche projection**: `1..4` `nicheAxes[]` (`enum` or `numeric_bins`) map observed metrics or hardware diagnostics into discrete cells.

## Sampling and budgets

Loopwright selects parents with novelty decay, screens clones before hardware dispatch, and ranks passing candidates via NSGA-II:

- **Pre-dispatch novelty gate**: Normalized token-shingle clones (`Jaccard === 1.0`) fail fast with `NOVELTY_CLONE_REJECTED` and zero hardware calls.
- **Model routing**: `sampling.modelBandit` selects `deterministic-round-robin` (default) or `ucb1` across declared `taskpack` models.
- **Preemption accounting**: Hardware `BENCHMARK_PREEMPTED` outcomes never consume `maxEvaluations` and never poison bandit rewards.
- **Roofline early stop**: Optional `targetRooflineHeadroom` (`>= 1.0`) stops search once observed hardware headroom reaches the declared bound.

## Plateau team evolution

Optional `spec.teamEvolution` invokes a read-only supervisor role only when an island stalls (`stallGenerations`, `minHypervolumeDelta`) or hits `RunEval` loop pathology:

- **Archetype ceiling**: Supervisor `TeamPatch` outputs may only recompose roles within `allowedArchetypeRoles` tool and network ceilings (`maxTeamSize: 1..4`, `maxTeamSteps: 1..6`).
- **Zero-mutation supervisor**: Runs in an isolated read-only `LocalRunStore` (`no_change` verified) with zero repo write tools.
- **Trial rollback**: Trial teams auto-rollback after `trialGenerations` without Pareto or niche gain; malformed patches keep the incumbent active.

## Bundle export contract

Optional `spec.export` (or `loopwright evolve export`) writes deterministic, content-addressed `evolution-bundle.v1` directories or OCI 1.1 layouts:

- **Fail-closed verification**: Export refuses missing HMAC secrets, tampered CAS blobs, incompatible hardware provenance, or unopted `synthetic_fixture` receipts (`EXPORT_UNVERIFIED_FORBIDDEN`).
- **Atomic staging**: Bundles stage into a sibling non-symlink directory and rename atomically (`EVOLUTION_CONFLICT` on collision without `--overwrite`).

| Bundle member | Format | Role |
| --- | --- | --- |
| `manifest.json` | `kind: EvolutionBundle`, `version: 1` | Hardware compatibility, Pareto summary, lineage, and member digests |
| `dispatch-manifest.json` | `version: 1`, `fallback: baseline` | Bucket routing rules (`dimensionBounds`, `dtypes`, `blobDigest`, `entrypoint`) |
| `receipts/<id>.verdict.json` | Signed `benchmark_verdict` JSON | Verbatim HMAC-signed hardware verdict receipts |
| `blobs/sha256/<hex>` | Verified Stage A CAS blobs | Compiled `.cubin`, `.so`, `.o`, or `.ptx` artifacts |

---

**See also** — [Evolutionary Campaign](/loopwright/main/docs/walkthroughs/evolutionary-campaign/index.md) (end-to-end setup and `loopwright evolve` walkthrough) · [Task Contract](/loopwright/main/docs/configuration/task-contract/index.md#hardware-target-cells) (hardware target cells, thresholds, and provenance) · [CLI](/loopwright/main/docs/operations/cli/index.md#evolution-campaigns) (`runner` and `evolve` subcommands)

**Next** → [Evolutionary Campaign](/loopwright/main/docs/walkthroughs/evolutionary-campaign/index.md) — mark `EVOLVE-BLOCK` spans, run a hardware relay, and export signed bundles.
