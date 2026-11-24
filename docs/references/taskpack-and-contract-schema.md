# Taskpack and Contract Reference

Evidence: contract.

Machine-readable field, bound, enum, and schema dictionary for `Taskpack`, `TaskpackSuite`, `TaskContract`, `VerificationProfile`, `AttemptReceipt`, `ArtifactManifest`, and `EvolutionCampaign` documents (`apiVersion: loopwright.dev/v1alpha1`).

## Contents

- [Taskpack bounds](#taskpack-bounds)
- [Verifiers and mounts](#verifiers-and-mounts)
- [TaskpackSuite bounds](#taskpacksuite-bounds)
- [TaskContract bounds](#taskcontract-bounds)
- [Receipts and evidence](#receipts-and-evidence)
- [Hardware and provenance](#hardware-and-provenance)
- [EvolutionCampaign bounds](#evolutioncampaign-bounds)

## Taskpack bounds

### Execution and capabilities

`spec.execution` enforces dual-key host authority. Under `mode: strict`, enabling any privileged capability requires `allow-privileged-execution: 'true'` (`--allow-privileged`).

`allowWorkflowWrites: true` independently requires `allow-workflow-writes: 'true'` (`--allow-workflow-writes`), and `command.v1` `parameters.mounts[]` requires privileged authority plus an explicit `allow-host-mounts` entry per `source`. Multi-tenant webhook runs refuse self-granted privileges (`TASKPACK_HOST_BINDING_INVALID` / `TASKPACK_SCOPE_VIOLATION`).

| Field path | Strict / privileged | Runtime scope |
| --- | --- | --- |
| `execution.mode` | `'strict'` | `'strict'` or `'privileged'`; `privileged` sets first four capabilities `true` |
| `capabilities.allowHostEnv` | `false` / `true` | Inherits host env for `preflight` and `command.v1` while stripping Loopwright/provider/GitHub secrets |
| `capabilities.allowHostPath` | `false` / `true` | Inherits host `PATH` for `preflight` and `command.v1` checks |
| `capabilities.mountReadOnlyGit` | `false` / `true` | Stages sanitized `.git` skeleton (`hooksPath=/dev/null`, config stripped) plus read-only `.git/objects` |
| `capabilities.allowCheckNetwork` | `false` / `true` | Grants outbound network for `command.v1` checks; avoids nested macOS Seatbelt `EPERM` |
| `capabilities.allowWorkflowWrites` | `false` / `false` | Dual-key unlock permitting agent edits under `.github/workflows/**` on GitHub policy runs |
| `capabilities.allowAgentNetwork` | `false` / `false` | Governs `resolveEffectiveTaskpackSandboxPolicy`; turnkey `agent-pi` `bash` stays offline-isolated |
| `digests.pinDigests` / `lockfile` | `false` / `<controlRoot>/digests.lock.json` | Runtime SHA-256 digests freeze runs when `false`; `true` enforces lockfile parity |

### Manifest fields and limits

| Field path | Required | Type and bounds | Behavior |
| --- | --- | --- | --- |
| `apiVersion` / `kind` | Yes | `'loopwright.dev/v1alpha1'` / `'Taskpack'` | Schema version and manifest kind (`<= 64 KiB` file) |
| `metadata.name` | Yes | Slug (`1..64` chars) | Lowercase identifier (`[a-z][a-z0-9._-]*`) |
| `spec.goal.candidate` / `noChange` | Yes | Strings (`1..1024` chars) | Role objectives for candidate and `no_change` runs |
| `spec.vars` | No | `0..64` strings (`[A-Z][A-Z0-9_]*`, `<= 512` chars) | Single-pass `${VAR}` interpolation in allowlisted fields (`TASKPACK_UNTRUSTED_INTERPOLATION` on undeclared/secret) |
| `spec.preflight` | No | `{ script, timeoutSeconds: 1..3600, env? }` | Runs post-auth, pre-compilation; writes JSON to `$LOOPWRIGHT_PREFLIGHT_OUT`, uses `$LOOPWRIGHT_STAGING_DIR` |
| `spec.scope.writable` / `protected` | No | `1..128` / `0..128` patterns | Explicit `dir/**`, exact paths, or single-segment `*`/`?` globs; protected overrides writable |
| `spec.instructions` / `skills` | No | `1..16` paths or `{ path, when }` (`<= 256 KiB` total) | Pre-hashed at compile time under `discovery: 'disabled'`; conflicting `when` fails `TASKPACK_MANIFEST_INVALID` |
| `spec.upstreams[]` | No | `github-release`, `git-tag`, `git-commit`, `http-json`, `custom-table` | `watchedPaths` (`0..64`), `allowPrerelease`, `http-json` `versionPath` + `monotonicSemver` (default `true`) |
| `spec.upstreamGroups[]` | No | `{ id, policy: 'lockstep' \| 'independent', members }` | `lockstep` marks whole group `'held_back'` atomically on mismatch or unavailability |
| `spec.proposal` / `submission` | No | `.yaml`/`.yml`/`.json` / `.json` writable paths | `proposal`: `{ path, requiredFields, schemaVersion }`; `submission`: `{ path, required? }` |
| `spec.roles[]` | No | `1..16` roles (`task \| review`) | `tools`: `read \| write \| edit \| bash \| delete`; review defaults `tools: ['read']`, `mcpServers: []` |
| `spec.steps[]` | No | `1..16` acyclic nodes (`agent \| check \| compact`) | Supports `dependsOn`, `handoffs` (`1..16`), `onRework: { rejectTo, maxReworks: 1..8 }` |
| `spec.models[]` | No | `1..8` items (default `zai` / `glm-5.3` / `high`) | `provider` (`1..64`), `id` (`1..128`), `thinking` (`off..max`), `api`, `apiKeyEnv`, `baseUrl`, `cost`, `compat` |
| `spec.mcp.servers[]` | No | `0..16` (`stdio` or `http`, `timeoutSeconds: 1..600`) | `stdio`: `command`, `args`, `env`, `envFrom`, `readOnly`; `http`: `url`, `headers`, `headersFrom`, `bearerTokenEnv`, `includeTools` |
| `spec.limits` | No | Action `with:` > `spec.limits` > `LOOPWRIGHT_*` | `wallTimeSeconds: 60..21600`, `totalTokens: 1000..1e9`, `maxOutputTokens: 256..262144`, `maxModelCalls: 1..1024`, `maxAttempts: 1..16` |
| `spec.limits.overlay` | No | `maxFiles: 1..16384`, `maxBytes: 1024..17179869184` | Default `128` files / `4 MiB`, up to `16,384` files / `16 GiB` via `1 MiB` CAS streaming |
| `spec.limits.maxTurns` / `maxRepairTurns` | No | Integer (`1..1024`) | Per-dispatch turn caps; `LOOPWRIGHT_MAX_TURNS` / `LOOPWRIGHT_MAX_REPAIR_TURNS` override at runtime |
| `spec.baselineAlignment` | No | `{ policy, maxConflictFiles: 1..64, maxConflictBytes: 1024..262144 }` | `policy`: `'off' \| 'fail-fast' \| 'extract-context'`; defaults `16` files / `65536` bytes |
| `spec.memory` | No | `directory`, `apply`, `onNoModelBudget`, GC fields | `ttlDays: 15`, `maxEntries: 128`, `maxPromptEntries: 32`, `checkCodeFingerprint: false`, `checkUpstreamVersions: false`, `publishOnFailure: false`, `skipCi: true` |
| `spec.publication` / `triggers` | No | Optional in local mode; enforced on GitHub | `mode: 'pull_request' \| 'disabled'`; `commentCommands: ['retry', 'revise', 'status']`, `commentPrefixes: ['/loopwright']` |

### Preflight staged resources

- **Prompt mount (`mount: 'prompt'`)**: Default for `instruction` and `skill` (`<= 64 KiB` UTF-8 per file, `<= 256 KiB` total); loads into `TaskContract.spec.trustedContext.resources`.
- **Workspace mount (`mount: 'workspace'`)**: Default for `document` (`<= 128 MiB` per file, `<= 256 MiB` total); projects read-only files via single-descriptor `1 MiB` streaming (`O_NOFOLLOW`, `nlink === 1`) into workspace and `exposeToChecks: true` (`$LOOPWRIGHT_STAGED_DIR`) trees without prompt decoding.
- **Single-link files**: Pack directories such as `npm-cache` into a `.tgz` archive; multi-link files and symlinks fail closed.
- **Allowlisted `spec.vars` targets**: `${VAR}` expands in `goal.*`, `publication.titleTemplate`/`bodyTemplate`, `roles[].prompt`, `preflight.env[]`, and `localChecks[].parameters` (`args[]`, `env`, `startMarker`, `endMarker`, `allowedPointers[]`).

## Verifiers and mounts

`spec.verification.localChecks` (`0..32`) and `externalGates` (`0..32`) run inside isolated verifiers:

| Implementation | Key parameters | Security rules |
| --- | --- | --- |
| `json-artifact.v1` | Scalar expectations (binds `spec.proposal`) | Validates JSON/YAML keys and scalar equality |
| `json-keys-guard.v1` | `path`, `allowedPointers` (`/json/pointer`) | Fails if any JSON key outside `allowedPointers` changed vs baseline |
| `line-section-guard.v1` | `path`, `startMarker`, `endMarker` | Fails if any line outside delimited markers changed vs baseline |
| `evolve-block-guard.v1` | `files`, `allowedBlockIds?`, `maxBlockBytes?` | Verifies bytes outside `EVOLVE-BLOCK-START/END` match baseline SHA-256 |
| `scope.v1` / `no-change.v1` | `checkId` (plus implicit guards) | Verifies writable/protected scope or untouched tree parity |
| `command.v1` | `script`, `args`, `env`, `toolchainPaths`, `mountReadOnlyGit`, `preserveRepoDirName`, `allowReadOnlyGitHubToken`, `mounts` | Mounts script parent directory read-only with whole-tree SHA-256 digest; default `PATH` is `/usr/local/bin:/usr/bin:/bin` |
| `gate.v1` | `gateId`, `endpointId`, `required`, optional `signingCredentialRef`, `authCredentialRef`, `url` | Remote signed HMAC verdict gate |
| `benchmark-gate.v1` | `gateId`, `endpointId`, `required`, `targetCellId`, `heldOutWorkloadId`, `maxPreemptions` (`0..16`), `allowSyntheticHardwareProbe`, `metricThresholds` | Forbids manifest `url`, `signingCredentialRef`, and `authCredentialRef` overrides; uses host `gateEndpoints` bindings |

- **Mounted `command.v1` environment**: Disposable `$LOOPWRIGHT_CANDIDATE_DIR` mounts writable (discarded after exit; `.git/objects` stays `--ro-bind` when `mountReadOnlyGit: true`), while `$LOOPWRIGHT_BASE_DIR`, script directory, and `$LOOPWRIGHT_STAGED_DIR` stay read-only. Existing host directories passed via `parameters.env` (and safe direct child symlink targets) mount read-only; `/etc`, `/tmp`, `repoRoot`, `runRoot`, and `$HOME` secrets remain denied.
- **Explicit host mounts (`parameters.mounts[]`)**: Declare `0..16` `{ source, target?, mode?: 'ro' | 'rw' }` entries (`target` defaults to `source`; `mode` defaults to `'ro'`). Every `source` requires dual-key `--allow-privileged` (`allow-privileged-execution: 'true'`) plus an entry in `--allow-host-mounts` (`allow-host-mounts`). Broad roots, `/etc`, `/proc`, `/sys`, `/dev`, `/var/lib`, control-plane directories, and `$HOME` secrets are always refused; under `/run` and `/var/run`, only Unix domain sockets are permitted. Missing sources, or socket, `rw`, and remapped mounts without Linux `bwrap`, fail closed (`SANDBOX_CAPABILITY_INSUFFICIENT`).
- **Structured check output (`$LOOPWRIGHT_CHECK_OUT`)**: Bounded JSON (`{ metrics?, findings?, detail? }`, `<= 64 KiB`; unknown keys such as `passed` or `summary` fail closed) propagates through HMAC-signed `gate.v1` verdicts (`metrics`, `findings`, `detail`, `retryablePreemption`) even on exit `0`.

## TaskpackSuite bounds

`TaskpackSuite` (default `.loopwright/suite.yaml`, `<= 64 KiB`) coordinates `1..32` domain `Taskpack`s and `0..16` acyclic promotion stages with zero suite state in Git:

| Field path | Required | Bounds | Invariant |
| --- | --- | --- | --- |
| `metadata.name` | Yes | Slug (`1..64` chars) | Unique suite identifier |
| `spec.domains[]` | Yes | `1..32` items | `{ id, taskpack, enabled?, schedules?, stage?, matrix? }` |
| `spec.stages[]` | No | `0..16` acyclic nodes | `{ id, dependsOn?, readiness? }` |
| `readiness[]` | No | `github-release`, `http-json`, `git-tag`, `git-commit` | Optional `versionFrom: { domain, path, jsonPointer }` reading `<= 1 MiB` blobs from `baseRevision` |

- **Suite protection & prefix disjointness**: Action (`suite-path`) and App (`suitePath`) runs enforce the suite-wide protected union across `.loopwright/suite.yaml` and peer control paths (`<= 128` patterns). Domains targeting the same `targetBranch` require pairwise prefix-disjoint `headBranchPrefix` values (`TASKPACK_MANIFEST_INVALID` on collision).

## TaskContract bounds

Strict `contractSchema` validation (`<= 1 MiB` input) requires `apiVersion`, `kind: 'TaskContract'`, and every declared `spec` key below explicitly (`null` or `[]` when empty; unknown or omitted keys fail `FIELD_REQUIRED` or `FIELD_UNKNOWN`):

| Field path | Required | Type and bounds | Meaning |
| --- | --- | --- | --- |
| `spec.goal` / `spec.taskpack` | Yes | `1..4096` chars / `1..64` chars | Plain-language objective and logical `Taskpack` name |
| `spec.target.repository` | Yes | `1..256` chars (`[A-Za-z0-9._/-]+`) | Target `owner/repo` slug |
| `spec.target.baseRevision` / `sourceRevision` | Yes | `1..128` chars each | Base commit/ref and upstream trigger revision |
| `spec.target.matrix` | Yes | `null` or `1..64` cells | `{ id, platform, variant, hardware? }` |
| `spec.scope.writable` / `protected` | Yes | `1..128` / `0..128` globs | Relative path globs; protected overrides writable |
| `trustedContext.revision` / `discovery` | Yes | `1..128` chars / `'disabled'` | Pinned context revision with runtime prompt discovery disabled |
| `trustedContext.resources[]` | Yes | `0..128` items (`<= 1 MiB` total) | `{ id, kind: 'instruction'\|'skill'\|'document', path, digest: { algorithm: 'sha256', hex }, when? }` |
| `spec.roles[]` | Yes | `1..64` roles | `{ id, adapter: 'pi'\|'delegated', provider, model, thinking, tools (0..128), resourceIds? (0..128) }` |
| `spec.steps[]` | Yes | `1..256` nodes (`<= 2048` edges, `<= 256` checkpoints) | `{ id, kind: 'agent'\|'check', uses, roleId, dependsOn, onRework?, handoffs? }` |
| `spec.budgets.*` | Yes | Positive ints (`<= parent`) | `wallTimeMs`, `totalTokens`, `perCallOutputTokens` (`<= 262144`), `maxModelCalls`, `maxConcurrency`, repair/retry caps, `enforcement.*` (7 keys) |
| `spec.budgets.overlay` | No | `maxFiles: 1..16384`, `maxBytes: 1024..16 GiB` | Optional candidate overlay limits (default `128` files / `4 MiB`) |
| `spec.acceptance.required` / `checks` | Yes | `1..256` IDs / `1..256` check objects | `{ id, allowedEvidenceLevels (1..5), targetCellId?, allowSyntheticHardwareProbe?, metricThresholds? (0..32) }` |

### Activation and handoff selectors

- **Conditional `resources[].when` (`>= 1` field; fields `AND`, values `OR`)**: `changedPaths` (`1..128` globs), `extensions` (`1..64` lowercase `.ext`, `2..33` chars), `phases` (`1..4`: `author`, `review`, `repair`, `rework`; `format` mounts zero conditional rules), `failedChecks` (`1..64` IDs), `failureCodes` (`1..64` codes, `1..128` chars).
- **Handoff selectors (`steps[].handoffs[]`, `1..16` items, non-compaction `agent` steps only, `<= 65536` bytes per step)**: `id?` (`1..64`), `fromStep` (strict DAG ancestor; `GRAPH_CYCLE`/`REFERENCE_UNKNOWN` otherwise), `source.kind` (`'artifact' | 'submission' | 'verdict'`, `<= 1 MiB` epoch artifact), `select.kind` (`'markdown_heading'` with `includeSubheadings`, `'json_pointer'` with `1..32` RFC 6901 pointers decoding `~1`/`~0` and rejecting `__proto__`/`constructor`/`prototype`, or `'full'`), `maxBytes` (`64..65536`, default `8192`), `required` (default `true`). Mounts read-only (`0o400`) with `sourceSha256` and `extractSha256` provenance.

## Receipts and evidence

- **`ArtifactManifest` shapes**: Mutually exclusive `spec` shapes. Classic `{ entries }` supports `<= 256` entries and is selected only when baseline has `<= 128` files and `<= 4 MiB` total bytes (`<= 32 KiB` canonical manifest JSON, `<= 256 KiB` inventory JSON). Otherwise admission selects `tree_overlay` (`{ baseTree, entries, deleted }`, `<= 256` checkpoints, baseline `<= 65,536` regular files, overlay `<= 16,384` files / `16 GiB` via CAS pointers).
- **Verifier output budget**: `.loopwright-verifier/<slotId>/*` descriptors use a dedicated budget (`64` files per slot, `256` total files, `16 GiB` total bytes) separate from candidate `budgets.overlay.maxBytes`.
- **`ArtifactRef`, `VerificationProfile`, and `AttemptReceipt`**: `ArtifactRef` accepts optional `uri` (`<= 2048` chars) and `mediaType` (`<= 128` chars), omitted from canonical JCS when unset. `VerificationProfile` binds approved `checks[]` and `allowedEvidenceLevels`; `AttemptReceipt` binds `lockHash`, attempt number, `ArtifactManifest` digest, `Evidence[]`, and terminal disposition.
- **`Evidence.spec` extensions**: Optional `metrics`, `findings`, `detail`, `bucketMetrics` (`1..64` buckets, `<= 16` numeric metrics and `<= 8` dimensions per bucket), and closed-enum `hardwareDiagnostics` (`boundPipeline`: `hbm | l2 | smem_lds_ub | tensor_cube | vector_valu | host_launch | comm | unknown`, optional counters/percentages/stalls).

## Hardware and provenance

| Field path | Required | Bounds and values | Purpose |
| --- | --- | --- | --- |
| `hardware.accelerator` | Yes | Printable ASCII (`1..64`) | Accelerator label (`sm_89`, `sm_90a`, `ascend_910b`, `gfx1101`) |
| `hardware.isolationMode` | Yes | `'whole_device'` \| `'sliced'` | Whole-device exclusivity or sliced partition mode |
| `hardware.deviceCount` | No | Safe integer (`1..64`) | Verified against observed `hardwareProvenance` |
| `hardware.driverConstraint` / `topology` | No | Printable string (`1..128`) | Exact driver or `>=<dotted-version>`; optional interconnect topology |
| `hardware.forbiddenSymbolPatterns` | No | `0..64` ASCII substrings (`<= 128`) | Glob-free Stage A symbol denylist (`cublas`, `rocblas`, `aclnn`) |
| `hardware.maxRegisterCount` / `maxLocalSpillBytes` | No | Safe integer (`>= 0`) | Stage A register and local spill ceilings (`STAGE_A_STATIC_AUDIT_FAILED`) |
| `metricThresholds[]` | No | `0..32` `bounds` or `comparative` | `bounds`: `{ metric, min?, max? }`; `comparative`: `min_ratio\|max_ratio\|max_delta`; optional `bucketScope` |

- **`hardwareProvenance` fields**: Passing `hardware_execution` `Evidence` requires `targetCellId`, `probeKind: 'physical' | 'synthetic_fixture'`, `vendor`, `deviceModel`, `accelerator`, `isolationMode`, `deviceCount`, `driverVersion`, `runtimeVersion`, `topology?`, `workloadDigest`, and `clockLockMode: 'locked' | 'unlocked' | 'unknown'`. `evaluateAcceptance` requires `probeKind: 'physical'` unless `allowSyntheticHardwareProbe: true` (`hardware_provenance_mismatch`, `metric_threshold_failed`).

## EvolutionCampaign bounds

`EvolutionCampaign` (`<= 64 KiB`, `metadata.name`) defines bounded multi-generation optimization over a repository `Taskpack`:

| Field path | Required | Bounds and defaults | Behavior |
| --- | --- | --- | --- |
| `spec.taskpack` / `spec.targetCellId` | Yes | Repo path / ID (`1..64`) | Taskpack and matching `target.matrix` hardware cell |
| `spec.heldOutWorkloadId` / `spec.tracks` | No | ID (`1..64`) / `1..32` unique IDs | Single-target workload override and implementation tracks |
| `spec.stages.mode` | No | `single-target` (default) \| `specialist-then-portfolio` | Requires `specialistBuckets` (`1..64`) + distinct `portfolioHeldOutWorkloadId` in portfolio mode |
| `spec.population.*` | Yes | `islands: 1..16`, `migrationIntervalGenerations: 1..1024`, `maxMigrationElites: 0..16`, `nicheAxes: 1..4` | `enum` (`1..32` values) or `numeric_bins` (`2..32` sorted edges), optional `field` |
| `spec.sampling.*` | Yes | `noveltyDecayLambda: (0, 100]`, `mutationWeights` in `[0, 1000]` (sum `> 0`), `modelBandit: deterministic-round-robin \| ucb1`, `maxCrossoversPerPrompt: 0..4` | Parent selection, clone gate (`Jaccard === 1.0` -> `NOVELTY_CLONE_REJECTED`), and NSGA-II ranking |
| `spec.objectives[]` | Yes | `1..8` unique `{ metric, direction: 'minimize'\|'maximize' }` | Multi-objective Pareto frontier targets |
| `spec.budgets.*` | Yes | `maxGenerations: 1..10000`, `maxEvaluations: 1..100000`, `maxConcurrentEvaluations: 1..64` (`<= maxEvaluations`) | Optional `targetRooflineHeadroom >= 1.0`, `scratchpadIntervalGenerations: 1..32` (default `5`) |
| `spec.teamEvolution.*` | No | `enabled`, `supervisorRoleId`, `allowedArchetypeRoles` (`1..16`) | `stallGenerations: 1..32` (`4`), `minHypervolumeDelta` (`0.001`), `trialGenerations: 1..8` (`2`), `maxTeamSize: 1..4`, `maxTeamSteps: 1..6` |
| `spec.export` | No | `format: 'dir' \| 'oci-layout'` (`'dir'`), `outputDir` | Writes `manifest.json` (`EvolutionBundle` v1), `dispatch-manifest.json` (`fallback: baseline`), `receipts/<id>.verdict.json`, `blobs/sha256/<hex>` |

---

**See also** — [Reference Hub](README.md) (flat reference routing and exact aliases) · [Taskpack](../configuration/taskpack.md) (human-first `Taskpack` configuration guide) · [Task Contract](../configuration/task-contract.md) (`TaskContract` overview and budget semantics) · [Evolution Campaign](../configuration/evolution-campaign.md) (`EvolutionCampaign` overview and workflows)
