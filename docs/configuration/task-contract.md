# Task Contract

`TaskContract` defines **what** bounded work is requested, **where** files may change, **how much** time and model budget a run may spend, and **which** independent checks must pass. Declarative Taskpack mode compiles `TaskContract` automatically; Managed Controller mode embeds it inside `ControllerConfig` while keeping credentials and handler digests in `TrustedRegistry` (see [Configuration relationships](../walkthroughs/managed-controller.md#configuration-relationships)).

## Contents

- [TaskContract](#taskcontract)
- [Scope and context](#scope-and-context)
- [Roles and steps](#roles-and-steps)
- [Budgets and enforcement](#budgets-and-enforcement)
- [Acceptance and evidence](#acceptance-and-evidence)
- [Hardware target cells](#hardware-target-cells)

## TaskContract

```yaml
apiVersion: loopwright.dev/v1alpha1
kind: TaskContract
spec:
  goal: Update packages/app/manifest.json release metadata and pass verification.
  taskpack: app-manifest
  target:
    repository: acme/example-app
    baseRevision: 67a4938
    sourceRevision: v1.4.0
    matrix: null # Optional matrix cell list (use null for controller runs)
  scope:
    writable:
      - "packages/app/**"
    protected:
      - "packages/app/policy/**"
  roles:
    - id: builder
      adapter: pi
      provider: zai
      model: glm-5.3
      thinking: high
      tools:
        - read
        - write
        - edit
  trustedContext:
    revision: rev-2026-11
    discovery: disabled
    resources: # Optional pinned context files (use [] when unused)
      - id: release-guide
        kind: instruction
        path: context/release-guide.md
        digest:
          algorithm: sha256
          hex: <hash>
        when: # Optional deterministic activation predicates
          changedPaths: # Optional
            - "packages/app/**"
          phases: # Optional
            - author
            - repair
  budgets:
    wallTimeMs: 300000
    totalTokens: 64000
    perCallOutputTokens: 1024
    maxModelCalls: 8
    maxConcurrency: 1
    maxFormatRepairs: 1
    maxImplementationRepairs: 2
    maxTransportRetries: 1
    enforcement:
      wallTime: hard_admission
      tokens: soft_accounting
      modelCalls: hard_admission
      concurrency: hard_admission
      formatRepairs: hard_admission
      implementationRepairs: hard_admission
      transportRetries: hard_admission
  steps:
    - id: author-change
      kind: agent
      uses: pi-author
      roleId: builder
      dependsOn: []
    - id: review-change
      kind: agent
      uses: pi-review
      roleId: builder
      dependsOn:
        - author-change
      handoffs: # Optional 1..16 compact ancestor extracts
        - id: author-summary # Optional
          fromStep: author-change
          source:
            kind: submission
          select:
            kind: json_pointer
            pointers:
              - /summary
          maxBytes: 8192 # Optional
          required: true # Optional
    - id: verify-manifest
      kind: check
      uses: check-manifest-json
      roleId: null # Optional on schema; null for check steps
      dependsOn:
        - review-change
  acceptance:
    required:
      - manifest-json
    checks:
      - id: manifest-json
        allowedEvidenceLevels:
          - local_execution
```

- **Zero embedded authority**: `TaskContract` cannot approve handler code, environment variables, network endpoints, or credentials.
- **Strict schema (`<= 1 MiB`)**: Every required `spec` key must appear explicitly (`null` or `[]` when empty); unknown keys fail `FIELD_UNKNOWN`.
- **Canonical identity**: Loopwright hashes `TaskContract` via RFC 8785 JCS (`taskByteDigest`), so any edit changes run identity.

## Scope and context

- **Writable vs protected**: `scope.writable` (`1..128` globs) allows edits; `scope.protected` (`0..128` globs) always overrides `writable`.
- **Pinned context**: `trustedContext.discovery` is fixed to `'disabled'`; every `resources[]` entry (`0..128`, `<= 1 MiB` total) pins a SHA-256 digest matching `TrustedRegistry`.

### Conditional activation rules

`resources[].when` filters pre-hashed context per dispatch without runtime discovery. Specified fields combine with `AND`, and values inside each list combine with `OR`:

| Predicate field | Values and matching |
| --- | --- |
| `changedPaths` | `1..128` globs matching candidate diffs or initial `watchedPaths` |
| `extensions` | `1..64` lowercase `.ext` suffixes matching changed files |
| `phases` | `author`, `review`, `repair`, `rework` (`format` mounts zero conditional rules) |
| `failedChecks` / `failureCodes` | `1..64` failed check IDs or verifier failure reason codes |

## Roles and steps

- **Roles (`1..64`)**: Bind `adapter` (`pi` or `delegated`), `provider`, `model`, `thinking`, `tools`, and optional `resourceIds` (see [Model configuration](taskpack.md#model-configuration)).
- **Steps (`1..256` acyclic nodes)**: `agent` steps bind a `roleId`; `check` steps set `roleId: null`. Optional `onRework: { rejectTo, maxReworks }` resets an ancestor (`1..8` times).

### Handoff selectors

`steps[].handoffs[]` (`1..16` entries, `<= 65536` bytes per step) mounts read-only (`0o400`) extracts with `sourceSha256` and `extractSha256` provenance from a strict DAG ancestor `fromStep`:

| Selector field | Values and behavior |
| --- | --- |
| `fromStep` | Strict DAG ancestor `steps[].id` (`GRAPH_CYCLE` / `REFERENCE_UNKNOWN` otherwise) |
| `source.kind` | `'artifact'` (`<= 1 MiB` epoch file), `'submission'`, or `'verdict'` |
| `select.kind` | `'markdown_heading'` (fence-aware), `'json_pointer'` (`1..32` RFC 6901 pointers), or `'full'` |
| `maxBytes` / `required` | `64..65536` bytes (default `8192`); fails closed when `required: true` (default) |

## Budgets and enforcement

Every retry and repair draws from one parent `budgets` envelope (`wallTimeMs` must exceed `controls.drainReserveMs`; child caps exceeding parent ceilings fail `BUDGET_INCONSISTENT`). Optional `budgets.overlay` raises candidate overlay limits from `128` files / `4 MiB` up to `16,384` files / `16 GiB`.

| Enforcement mode | Admission behavior | Dimensions |
| --- | --- | --- |
| `hard_admission` | Pre-reserves quota in SQLite before dispatch; refuses insufficient allowance | `wallTime`, `modelCalls`, `concurrency`, `formatRepairs`, `implementationRepairs`, `transportRetries` |
| `soft_accounting` | Records actual post-call usage and halts further calls once reached | `tokens` (exact output count is known post-generation) |

## Acceptance and evidence

`spec.acceptance.required` lists every check ID that must pass. Admission selects classic `{ entries }` `ArtifactManifest` only for small baselines (`<= 128` files / `<= 4 MiB`); otherwise it uses `tree_overlay` (`<= 65,536` baseline files, CAS blob pointers) with a separate verifier output budget for `.loopwright-verifier/<slotId>/*`.

| Evidence level | Observation source | Qualification boundary |
| --- | --- | --- |
| `static_inspection` | Deterministic byte or AST parser | Inert file inspection only; executes no target code |
| `synthetic_fixture` | Controlled local test fixture | Proves harness logic only; never qualifies live systems |
| `local_execution` | Isolated host verifier worker | Scoped to current host (`json-artifact.v1`, `scope.v1`, `command.v1`) |
| `external_service` | Signed `gate.v1` remote receipt | Requires trusted `gateEndpoints[]` URL and HMAC secret |
| `hardware_execution` | Dedicated physical target runner | Must appear alone as `['hardware_execution']` with `benchmark-gate.v1` |

## Hardware target cells

Each `spec.target.matrix[]` cell accepts an optional `hardware` block (`accelerator`, `isolationMode: 'whole_device' | 'sliced'`, optional `deviceCount`, `driverConstraint`, `topology`, and Stage A static audit limits `forbiddenSymbolPatterns`, `maxRegisterCount`, `maxLocalSpillBytes`).

- **Metric thresholds**: `metricThresholds[]` (`0..32`) enforces `bounds` or `comparative` (`min_ratio`/`max_ratio`/`max_delta`) rules across optional `bucketScope`.
- **Physical provenance**: `hardware_execution` requires `hardwareProvenance` with `probeKind: 'physical'` unless `allowSyntheticHardwareProbe: true`, failing closed on mismatch (`hardware_provenance_mismatch`, `metric_threshold_failed`).

---

**See also** — [Managed Controller](../walkthroughs/managed-controller.md) (CLI setup and relationship diagram) · [Taskpack](taskpack.md) (single-file automated mode) · [Evolution Campaign](evolution-campaign.md) (multi-generation search and bundle export)

**Next** → [Controller and Registry](controller-and-registry.md) — bind `TaskContract` roles, steps, and credentials in `TrustedRegistry` and `ControllerConfig`.
