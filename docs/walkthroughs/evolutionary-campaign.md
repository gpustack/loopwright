# Evolutionary Campaign

Evolutionary campaign mode coordinates bounded multi-generation optimization over mutable `EVOLVE-BLOCK` source regions, isolated child `LocalRunStore` runs, and hardware-verified `benchmark-gate.v1` receipts. Loopwright maintains a fenced `campaign.sqlite` Pareto archive and exports signed `evolution-bundle.v1` packages without delegating verification authority to models.

For single-run repository automation, follow [Declarative Taskpack](declarative-taskpack.md). For manual out-of-repo controller governance, follow [Managed Controller](managed-controller.md).

## Contents

- [Overview](#overview)
- [Prompt bootstrap](#prompt-bootstrap)
- [Step 1: Mark evolve blocks](#step-1-mark-evolve-blocks)
- [Step 2: Author taskpack](#step-2-author-taskpack)
- [Step 3: Author campaign](#step-3-author-campaign)
- [Step 4: Start runner](#step-4-start-runner)
- [Step 5: Run and export](#step-5-run-and-export)

## Overview

![Hardware relay and outbound worker topology](../assets/diagrams/hardware-relay-flow.svg)

<!-- flowchart LR
  Control["Zone 1: Control Plane (CLI or GitHub Actions, Outbound HTTPS)"] -> DMZ["Zone 2: Relay DMZ (HTTPS Gate, HMAC Auth, Lease Fence, CAS)"] -> Firewall["Cluster Firewall (Zero Inbound Ports)"] -> Worker["Zone 3: Private GPU Cluster (Outbound Pull)"] -> Sandbox["Offline Zero-Network Docker (Stage A Build + Stage B Bench)"] -> Receipt["Signed Verdict Receipt"]
-->

Evolutionary campaign mode separates candidate authoring from blind hardware evaluation across three zones:

| Responsibility | Authored files | Runtime invariant |
| --- | --- | --- |
| Mutable span guard | `EVOLVE-BLOCK` markers and `evolve-block-guard.v1` | Outside bytes must match baseline SHA-256 exactly |
| Hardware contract | `target.matrix[].hardware` and `benchmark-gate.v1` | Stage A static audit blocks forbidden symbols and excess spills |
| Blind evaluation | Outbound `runner relay` and `runner worker` | Zero inbound GPU cluster ports; offline Stage B holdout data |
| Archive and export | `.loopwright/campaign.yaml` and `loopwright evolve` | Fenced `campaign.sqlite` outside `--repo`; signed HMAC export |

## Prompt bootstrap

To configure an evolutionary campaign through an interview-first flow before writing YAML files, paste this prompt into your coding agent inside the target repository:

```text
Read https://docs.gpustack.ai/loopwright/llms.txt and its Bootstrap Interview Reference (https://docs.gpustack.ai/loopwright/references/bootstrap-interview.md). Inspect this repository first WITHOUT editing any files yet, then follow Evolutionary campaign mode (Mode 3) to interview me one question at a time with repository-grounded defaults on EVOLVE-BLOCK guarded files, target hardware cell and Stage A static audit limits, held-out benchmark-gate.v1 workloads and runner relay/worker topology, objectives, island/niche budgets, optional teamEvolution, and bundle export. Wait for my approval on the design summary before generating .loopwright/taskpack.yaml and .loopwright/campaign.yaml and validating with loopwright evolve check.
```

## Step 1: Mark evolve blocks

Wrap only editable spans in guarded source files with matching `EVOLVE-BLOCK-START: <id>` and `EVOLVE-BLOCK-END: <id>` comments (`//`, `#`, or `/* */`):

```cpp
__global__ void flash_decode(float* out, const float* q, int n) {
  // EVOLVE-BLOCK-START: tile_loop
  for (int i = threadIdx.x; i < n; i += blockDim.x) {
    out[i] = q[i];
  }
  // EVOLVE-BLOCK-END: tile_loop
}
```

Keep block IDs unique per file and bounded to printable ASCII. Any byte change outside marked spans fails `evolve-block-guard.v1` before hardware dispatch.

## Step 2: Author taskpack

Create `.loopwright/taskpack.yaml` declaring guarded files, the hardware target cell, Stage A static audit ceilings, and `benchmark-gate.v1` (see [Taskpack](../configuration/taskpack.md) and [Task Contract](../configuration/task-contract.md#hardware-target-cells)):

```yaml
apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: kernel-evolve-tp
spec:
  goal:
    candidate: Optimize guarded kernel blocks and pass hardware benchmark thresholds.
    noChange: Confirm no further optimization is needed and settle cleanly.
  target:
    matrix:
      - id: cuda-h100-whole
        platform: linux/amd64
        variant: cuda12
        hardware:
          accelerator: sm_90a
          isolationMode: whole_device
          deviceCount: 1
          driverConstraint: ">=550.0"
          forbiddenSymbolPatterns:
            - cublas
            - cudnn
          maxRegisterCount: 128 # Optional
          maxLocalSpillBytes: 0 # Optional
  scope:
    writable:
      - src/kernels/**
    protected:
      - .loopwright/**
      - scripts/**
  models:
    - provider: openai
      id: gpt-5
      apiKeyEnv: LOOPWRIGHT_PROVIDER_TOKEN
  roles:
    - id: mutator
      provider: openai
      model: gpt-5
      purpose: task
      tools:
        - read
        - write
        - edit
      prompt: Edit guarded EVOLVE-BLOCK spans in src/kernels/flash_decode.cu only.
  verification:
    localChecks:
      - id: evolve-guard
        implementation: evolve-block-guard.v1
        parameters:
          files:
            - src/kernels/flash_decode.cu
          allowedBlockIds: # Optional
            - tile_loop
          maxBlockBytes: 8192 # Optional
    externalGates:
      - id: gpu-bench
        implementation: benchmark-gate.v1
        endpointId: hw-relay
        gateId: flash-decode-bench
        required: true
        targetCellId: cuda-h100-whole
        heldOutWorkloadId: decode-bs1-4k
        metricThresholds:
          - kind: bounds
            metric: max_ulp
            max: 2
            bucketScope: all_buckets
  publication:
    mode: disabled
```

## Step 3: Author campaign

Create `.loopwright/campaign.yaml` referencing the taskpack and target cell (see [Evolution Campaign](../configuration/evolution-campaign.md)):

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
    mode: single-target # Optional
  population:
    islands: 2
    migrationIntervalGenerations: 6
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
  sampling:
    noveltyDecayLambda: 1.0
    mutationWeights:
      diff_tune: 0.5
      full_rewrite: 0.3
      crossover: 0.2
    modelBandit: deterministic-round-robin # Optional
    maxCrossoversPerPrompt: 2
  objectives:
    - metric: latency_us_p50
      direction: minimize
    - metric: goodput_rps
      direction: maximize
  budgets:
    maxGenerations: 20
    maxEvaluations: 40
    maxConcurrentEvaluations: 2
    scratchpadIntervalGenerations: 5 # Optional
  export: # Optional
    format: oci-layout # Optional
    outputDir: .loopwright-out/bundles/flash-decode-sm90a
```

Validate both manifests and guarded files offline before starting any worker:

```sh
loopwright evolve check --campaign .loopwright/campaign.yaml --repo . --json
```

## Step 4: Start runner

Start the relay in a reachable DMZ or loopback host, then start outbound workers on private GPU hosts:

```sh
loopwright runner relay --config "$HOME/loopwright-ops/relay.yaml" --json
loopwright runner worker --config "$HOME/loopwright-ops/worker.yaml" --json
```

For offline smoke tests without GPUs, set `probeMode: synthetic_fixture` on the worker and pass `--allow-synthetic-probe` to `evolve run`. Omit `--allow-synthetic-probe` on real hardware so synthetic receipts fail closed (`HARDWARE_PROVENANCE_MISMATCH`).

## Step 5: Run and export

Export required secrets and point `--state` strictly outside `--repo`:

```sh
export LOOPWRIGHT_PROVIDER_TOKEN="<provider-token>"
export LOOPWRIGHT_BENCHMARK_GATE_URL="https://relay.example.internal/v1/benchmark/jobs"
export LOOPWRIGHT_GATE_SIGNING_SECRET="<hmac-secret>"

loopwright evolve run --campaign .loopwright/campaign.yaml --state "$HOME/evo-state/flash-decode" --repo . --json
```

Monitor progress, pause cleanly on `SIGINT` (exit `130`), resume later, and export signed `evolution-bundle.v1` packages (`EXPORT_UNVERIFIED_FORBIDDEN`, exit `3` when receipts or secrets are unverified):

```sh
loopwright evolve status --campaign "$HOME/evo-state/flash-decode" --json
loopwright evolve inspect --campaign "$HOME/evo-state/flash-decode" --island 0 --json
loopwright evolve resume --campaign "$HOME/evo-state/flash-decode" --repo . --json
loopwright evolve export --campaign "$HOME/evo-state/flash-decode" --out "$HOME/evo-out/bundle" --format oci-layout --json
```

---

**See also** — [Evolution Campaign](../configuration/evolution-campaign.md) (`EvolutionCampaign` schema and bundle contract) · [CLI](../operations/cli.md#evolution-campaigns) (`runner` and `evolve` subcommands) · [Taskpack](../configuration/taskpack.md) (`evolve-block-guard.v1` and `benchmark-gate.v1` declarations)

**Next** → [Evolution Campaign](../configuration/evolution-campaign.md) — review `EvolutionCampaign` fields, stages, and bundle export rules.
