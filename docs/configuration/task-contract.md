# Task Contract

`TaskContract` defines **what** bounded work is requested, **where** files may change, **how much** time and model budget a run may spend, and **which** independent checks must pass. In Declarative Taskpack mode, Loopwright compiles `TaskContract` automatically; in Managed Controller mode, you embed `TaskContract` inside `ControllerConfig` (`controller.yaml`) while keeping credentials and handler digests in `TrustedRegistry` (see [Configuration relationships](../walkthroughs/managed-controller.md#configuration-relationships)).

## Contents

- [TaskContract](#taskcontract)
- [Envelope and target](#envelope-and-target)
- [Scope and context](#scope-and-context)
- [Roles and steps](#roles-and-steps)
- [Budgets and enforcement](#budgets-and-enforcement)
- [Acceptance and evidence](#acceptance-and-evidence)

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
    - id: verify-manifest
      kind: check
      uses: check-manifest-json
      roleId: null # Optional on schema; null for check steps
      dependsOn:
        - author-change
  acceptance:
    required:
      - manifest-json
    checks:
      - id: manifest-json
        allowedEvidenceLevels:
          - local_execution
```

- **Zero embedded authority**: `TaskContract` cannot approve handler code, environment variables, network endpoints, or credentials.
- **Deterministic canonicalization**: Loopwright hashes `TaskContract` via RFC 8785 JCS (`taskByteDigest`) so any field edit produces a distinct run identity.

## Envelope and target

Strict `contractSchema` validation requires `apiVersion`, `kind`, and `spec` and requires every declared `spec` key below to appear explicitly (`null` or `[]` where empty; unknown or omitted keys fail with `FIELD_REQUIRED` or `FIELD_UNKNOWN`):

| Field path | Required | Type and bounds | Meaning |
| --- | --- | --- | --- |
| `apiVersion` | Yes | `'loopwright.dev/v1alpha1'` | Unified Loopwright document version |
| `kind` | Yes | `'TaskContract'` | Selects strict `contractSchema` validation (`<= 1 MiB` input) |
| `spec.goal` | Yes | String (`1..4096` chars) | Plain-language objective evaluated by roles and recorded in receipts |
| `spec.taskpack` | Yes | Identifier (`1..64` chars) | Logical taskpack or workflow identifier (`Taskpack.metadata.name`) |
| `spec.target.repository` | Yes | Repo slug (`1..256` chars) | Target `owner/repo` path (`[A-Za-z0-9._/-]+`) |
| `spec.target.baseRevision` | Yes | Revision (`1..128` chars) | Base commit SHA, tag, or branch checked out before agent execution |
| `spec.target.sourceRevision` | Yes | Revision (`1..128` chars) | Upstream release, tag, or commit revision that triggered the work |
| `spec.target.matrix` | Yes (`null` allowed) | `null` or cell list (`1..64`) | Target matrix (`{ id, platform, variant }`); set `null` for controller runs |

## Scope and context

| Field path | Required | Type and bounds | Meaning |
| --- | --- | --- | --- |
| `spec.scope.writable` | Yes | Glob list (`1..128` patterns) | Relative path globs where candidate edits are permitted |
| `spec.scope.protected` | Yes | Glob list (`0..128` patterns) | Read-only globs overriding `writable` (pass `[]` if none) |
| `trustedContext.revision` | Yes | Revision (`1..128` chars) | Version label for pinned supplementary context files |
| `trustedContext.discovery` | Yes | `'disabled'` | Disables unpinned workspace prompt discovery so all context is hash-bound |
| `trustedContext.resources` | Yes | Object list (`0..128` items) | Read-only context files (`<= 1 MiB` total; pass `[]` when unused) |
| `resources[].id` | Conditional | Identifier (`1..64` chars) | **Required** per item; matches `TrustedRegistry.spec.resources[].id` |
| `resources[].kind` | Conditional | `'instruction'` \| `'skill'` \| `'document'` | **Required** per item; declares how runtime mounts the context file |
| `resources[].path` | Conditional | Relative path (`1..1024` chars) | **Required** per item; path resolved under `TrustedRegistry` directory |
| `resources[].digest` | Conditional | `{ algorithm: 'sha256', hex }` | **Required** per item; 64-char lowercase SHA-256 hex digest |

Turnkey taskpacks protect `.github`, `.claude`, `.codex`, `.agents`, `.loopwright/policies`, `AGENTS.md`, and `CLAUDE.md` by default.

## Roles and steps

### Role and step fields

| Field path | Required | Type and bounds | Meaning |
| --- | --- | --- | --- |
| `spec.roles` | Yes | Object list (`1..64` roles) | Named model personas available to `agent` steps |
| `roles[].id` | Yes | Identifier (`1..64` chars) | Unique role ID bound via `ControllerConfig.spec.profiles.roles` |
| `roles[].adapter` | Yes | Label (`'pi'`) | Isolated agent runtime adapter |
| `roles[].provider` | Yes | Label (`1..128` chars) | Token-based Pi provider or custom provider ID (matches `RoleProfile.selection.provider`) |
| `roles[].model` | Yes | Label (`1..128` chars) | Coding model ID (for example `glm-5.3`; see [Model configuration](taskpack.md#model-configuration)) |
| `roles[].thinking` | Yes | Label (`1..128` chars) | Pi reasoning level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) |
| `roles[].tools` | Yes | Tool list (`0..128` unique) | Allowed tools include `read`, `write`, `edit`, `bash`, `delete`, `mcp`, `codemode`, and `mcp__workspace__read_file` |
| `spec.steps` | Yes | Object list (`1..256` nodes) | Acyclic execution graph (`<= 2048` edges) of authoring and check steps |
| `steps[].id` | Yes | Identifier (`1..64` chars) | Unique step node ID bound via `ControllerConfig.spec.profiles.steps` |
| `steps[].kind` | Yes | `'agent'` or `'check'` | Selects isolated role execution or independent verification |
| `steps[].uses` | Yes | Identifier (`1..64` chars) | Logical operation label mapped to an approved `TrustedRegistry` handler |
| `steps[].roleId` | Yes (`null` for check) | Identifier or `null` | Non-null `roles[].id` when `kind: agent`; must be `null` when `kind: check` |
| `steps[].dependsOn` | Yes | Identifier list | Upstream `steps[].id` nodes that must succeed first (pass `[]` for roots) |

The Pi adapter restricts its runtime tool names further.
For MCP access, it accepts `mcp__workspace__read_file`, not the generic `mcp` name.

### Step kinds

| Kind | `roleId` rule | Runtime behavior |
| --- | --- | --- |
| `agent` | Non-null `roles[].id` | Launches an isolated Pi session under sandbox containment to author or repair changes |
| `check` | `null` | Runs an independent deterministic verifier worker or polls a remote `gate.v1` service |

## Budgets and enforcement

### Budget fields

Every retry and repair attempt draws from the same parent `budgets` envelope. Validation fails with `BUDGET_INCONSISTENT` if any per-call or retry cap exceeds its parent ceiling:

| Field path | Required | Type and constraint | Meaning |
| --- | --- | --- | --- |
| `budgets.wallTimeMs` | Yes | Integer (`>= 1` ms) | Total wall-clock timeout; must exceed `ControllerConfig.spec.controls.drainReserveMs` |
| `budgets.totalTokens` | Yes | Integer (`>= 1`) | Cumulative prompt + completion token ceiling across the entire run |
| `budgets.perCallOutputTokens` | Yes | Integer (`1 .. totalTokens`) | Maximum completion tokens per model call (`<= 1024` in Pi profiles) |
| `budgets.maxModelCalls` | Yes | Integer (`>= 1`) | Maximum total model API invocations across authoring, compaction, and repairs |
| `budgets.maxConcurrency` | Yes | Integer (`1 .. maxModelCalls`) | Maximum steps dispatched concurrently by the scheduler |
| `budgets.maxFormatRepairs` | Yes | Integer (`0 .. maxModelCalls`) | Allowed repair turns when agent output fails structured submission parsing |
| `budgets.maxImplementationRepairs` | Yes | Integer (`0 .. maxModelCalls`) | Allowed repair turns after an independent check or gate reports failure |
| `budgets.maxTransportRetries` | Yes | Integer (`0 .. maxModelCalls`) | Allowed retries on transient network/provider transport failures |
| `budgets.enforcement.*` | Yes | All 7 dimension keys | Enforcement mode for `wallTime`, `tokens`, `modelCalls`, `concurrency`, `formatRepairs`, `implementationRepairs`, `transportRetries` |

### Enforcement modes

Configure `spec.budgets.enforcement.<dimension>` for each of the seven dimensions (`wallTime`, `tokens`, `modelCalls`, `concurrency`, `formatRepairs`, `implementationRepairs`, `transportRetries`):

| Mode | Admission behavior | Controller usage |
| --- | --- | --- |
| `hard_admission` | Pre-reserves quota in SQLite before dispatch; refuses dispatch if remaining allowance is insufficient | Required for `wallTime`, `modelCalls`, `concurrency`, `formatRepairs`, `implementationRepairs`, and `transportRetries` |
| `soft_accounting` | Records actual post-call usage and halts subsequent calls once ceiling is reached | Used for `tokens` because exact output token counts are only known after model generation |

## Acceptance and evidence

### Artifact manifests

An `ArtifactManifest` uses one of two mutually exclusive `spec` shapes.
Classic `{ entries }` supports up to 256 entries.
Admission selects it only if the baseline has at most 128 files and 4 MiB total bytes.
Its canonical manifest JSON must fit 32 KiB and its inventory JSON must fit 256 KiB.

Otherwise, admission selects `tree_overlay` with `{ baseTree, entries, deleted }`.
The baseline supports up to 65,536 regular files.
The overlay supports up to 128 added or modified entries, 128 deleted paths, and 4 MiB of aggregate entry bytes.

### Acceptance fields

| Field path | Required | Type and bounds | Meaning |
| --- | --- | --- | --- |
| `acceptance.required` | Yes | Identifier list (`1..256`) | Check IDs that must all report `passed` before a candidate can complete |
| `acceptance.checks` | Yes | Object list (`1..256` items) | Declares every check ID referenced in `required` (plus any optional checks) |
| `checks[].id` | Yes | Identifier (`1..64` chars) | Check ID matching the verifier handler's `checkId` parameter |
| `checks[].allowedEvidenceLevels` | Yes | Enum list (`1..5` unique) | Acceptable provenance tiers for receipts certifying `checks[].id` |

### Evidence levels

| Level | Observation source | Qualification boundary |
| --- | --- | --- |
| `static_inspection` | Deterministic byte or AST parser | Inert file inspection only; executes no target code |
| `synthetic_fixture` | Controlled local test fixture | Proves harness logic only; never qualifies live external systems |
| `local_execution` | Isolated verifier worker on current host | Scoped to current OS/host environment (`json-artifact.v1`, `scope.v1`, `no-change.v1`) |
| `external_service` | Signed `gate.v1` receipt from remote gate | Requires trusted `gateEndpoints[]` URL and HMAC signing credential |
| `hardware_execution` | Dedicated physical target hardware runner | Reserved for provisioned hardware-in-the-loop gates |

---

**See also** — [Managed Controller](../walkthroughs/managed-controller.md) (end-to-end CLI setup and relationship diagram) · [Taskpack](taskpack.md) (single-file automated mode)

**Next** → [Controller and Registry](controller-and-registry.md) — bind `TaskContract` roles, steps, and credentials in `TrustedRegistry` and `ControllerConfig`.
