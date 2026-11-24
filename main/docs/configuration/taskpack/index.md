# Taskpack

`Taskpack` powers Loopwright's automated mode in a bounded YAML document (`<= 64 KiB`, `.loopwright/taskpack.yaml`). For out-of-repo `TrustedRegistry` governance or CLI controller files, see [Task Contract](/loopwright/main/docs/configuration/task-contract/index.md) and [Controller and Registry](/loopwright/main/docs/configuration/controller-and-registry/index.md).

## Contents

- [Compilation model](#compilation-model)
- [Taskpack](#taskpack)
- [Execution and scope](#execution-and-scope)
- [Preflight and upstreams](#preflight-and-upstreams)
- [Roles and steps](#roles-and-steps)
- [Model configuration](#model-configuration)
- [Verification and publication](#verification-and-publication)
- [TaskpackSuite](#taskpacksuite)

## Compilation model

When `loopwright run --taskpack`, `loopwright step`, the GitHub Action, or the GitHub App runs a taskpack, the compiler generates three runtime artifacts:

| Generated artifact | Manifest inputs | Compiler defaults |
| --- | --- | --- |
| `TaskContract` | `metadata.name`, `goal`, `scope`, `steps`, `verification`, `limits` | Policy-profile masks, `wallTimeMs: 3600000`, `maxModelCalls: 256` |
| `TrustedRegistry` | `preflight`, `proposal`, `verification`, `publication`, `mcp` | Runtime SHA-256 digests for handlers, check dirs, and instructions |
| `ControllerConfig` | Compiled `TaskContract`, `TrustedRegistry` SHA-256, `decisions` | `drainReserveMs: 120000`, `maxAttempts: 5`, `${ENV}` templates (`0600`) |

## Taskpack

```yaml
apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: catalog-sync
spec:
  goal:
    candidate: Update catalog manifests from upstream releases and pass checks.
    noChange: Confirm upstream versions match current manifests and settle cleanly.
  execution: # Optional trust mode and digest pinning
    mode: strict # Optional (strict or privileged)
    digests: # Optional SHA-256 lockfile policy
      pinDigests: false
      lockfile: .loopwright/digests.lock.json # Optional
  vars: # Optional static non-secret interpolation vars
    RELEASE_CHANNEL: stable
  preflight: # Optional post-auth host preflight hook
    script: scripts/preflight.mjs
    timeoutSeconds: 60 # Optional
  scope: # Optional writable and protected paths
    writable:
      - manifests/**
      - docs/versions.md
    protected:
      - manifests/frozen-policy.yaml
      - scripts/**
  instructions: # Optional protected UTF-8 instructions
    - .loopwright/instructions.md
    - path: .loopwright/docs-rules.md # Optional conditional rule
      when:
        changedPaths:
          - docs/**
        phases:
          - author
          - repair
  roles: # Optional 1..16 delegated or Pi roles
    - id: author
      purpose: task # Optional
      provider: example
      model: author-model
      tools: # Optional
        - read
        - write
        - edit
        - bash
    - id: review
      purpose: review # Optional
      provider: example
      model: review-model
      tools: # Optional
        - read
  steps: # Optional 1..16 DAG steps (agent, check, compact)
    - id: author-step
      kind: agent
      role: author
      dependsOn: []
    - id: static-step
      kind: check
      check: static-check
      dependsOn:
        - author-step
    - id: review-step
      kind: agent
      role: review
      dependsOn:
        - static-step
      handoffs: # Optional 1..16 compact ancestor extracts
        - fromStep: author-step
          source:
            kind: submission
          select:
            kind: json_pointer
            pointers:
              - /summary
      onRework: # Optional bounded rework edge
        rejectTo: author-step
        maxReworks: 2
  upstreams:
    - id: engine-release
      kind: http-json
      source: https://releases.example.invalid/engine.json
      watchedPaths:
        - docs
      versionPath: version # Optional for http-json
      monotonicSemver: true # Optional (defaults true on SemVer)
  proposal: # Optional structured proposal artifact
    path: manifests/proposal.yaml
    requiredFields:
      - schema_version
      - candidates
    schemaVersion: 1
  verification:
    localChecks:
      - id: proposal-schema
        implementation: json-artifact.v1
      - id: static-check
        implementation: command.v1
        parameters:
          script: .loopwright/checks/verify.sh
          args: # Optional
            - --channel
            - "${RELEASE_CHANNEL}"
          timeoutSeconds: 30 # Optional
    externalGates: [] # Optional remote gate checks
  publication: # Optional in local mode (defaults to disabled)
    mode: pull_request
    targetBranch: main # Optional when mode is disabled
    headBranchPrefix: loopwright-catalog-sync- # Optional when mode is disabled
    titleTemplate: "chore(${RELEASE_CHANNEL}) - sync upstream release metadata" # Optional
  memory: # Optional in local mode (defaults to disabled under controlRoot)
    directory: .loopwright/memory/catalog-sync
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only # Optional when apply is disabled
    ttlDays: 15 # Optional (defaults to 15)
    maxEntries: 128 # Optional (defaults to 128)
    maxPromptEntries: 32 # Optional (defaults to 32)
    checkCodeFingerprint: false # Optional (defaults to false)
    checkUpstreamVersions: false # Optional (defaults to false)
    publishOnFailure: false # Optional (defaults to false)
    skipCi: true # Optional (defaults to true)
  triggers: # Optional in local mode (enforced pre-preflight on GitHub)
    schedule: true
    workflowDispatch: true
    releasePublished: false
    commentCommands:
      - retry
      - revise
      - status
  baselineAlignment: # Optional isolated 3-way conflict check
    policy: off # Optional (off, fail-fast, or extract-context)
  models: # Optional ordered model pool
    - provider: zai
      id: glm-5.3
      thinking: high # Optional
      apiKeyEnv: ZAI_API_KEY # Optional
  limits: # Optional execution ceilings
    wallTimeSeconds: 3600 # Optional
    maxAttempts: 5 # Optional
    overlay: # Optional
      maxFiles: 512
      maxBytes: 16777216
  sandbox: # Optional host isolation policy
    networkMode: none # Optional (defaults to none)
  decisions: # Optional System-One triage policy
    enabled: true
    provider: typesafe-jev # Optional
```

## Execution and scope

`spec.execution` enforces dual-key host authority. Under `mode: strict`, enabling privileged capabilities (`allowHostEnv`, `allowHostPath`, `mountReadOnlyGit`, `allowCheckNetwork`, `allowAgentNetwork`) requires `allow-privileged-execution: 'true'` (`--allow-privileged`).

- **Workflow & mount unlocks**: `allowWorkflowWrites` requires `--allow-workflow-writes`; `command.v1` `mounts[]` requires privileged authority plus `--allow-host-mounts`.
- **Static interpolation (`spec.vars`)**: Replaces `${VAR}` in allowlisted fields only; undeclared or secret `${...}` expressions fail (`TASKPACK_UNTRUSTED_INTERPOLATION`).
- **Explicit path globs**: Write `dir/**` for recursive directories and exact paths or `*`/`?` globs for files; `protected` always wins over `writable`.
- **Conditional instructions**: `instructions` and `skills` accept `{ path, when }` predicates (see [Task Contract](/loopwright/main/docs/configuration/task-contract/index.md#conditional-activation-rules)) pre-hashed under `discovery: 'disabled'`.
- **Policy profiles**: Local runs protect `.git`, `<controlRoot>`, and `digests.lock.json`; GitHub runs also protect `.github`.

## Preflight and upstreams

`spec.preflight` runs once on the host after actor authorization and `SecretScrubber` setup, writing `{ disposition, upstreams, stagedResources }` JSON to `$LOOPWRIGHT_PREFLIGHT_OUT`.

- **Split staged resources**: `mount: 'prompt'` (`<= 64 KiB` UTF-8) injects context text; `mount: 'workspace'` (`<= 128 MiB`, single-link regular files) stages read-only files and optional `$LOOPWRIGHT_STAGED_DIR` check inputs.
- **Lockstep groups**: Declare `spec.upstreamGroups[]` (`policy: lockstep`) so partial or mismatched releases resolve atomically as `held_back`.

| Upstream `kind` | Typical target | Guardrail |
| --- | --- | --- |
| `github-release` | GitHub Releases | `allowPrerelease` defaults `false` |
| `git-tag` / `git-commit` | Tags or watched repo paths | `watchedPaths` (`0..64`) feeds intake context |
| `http-json` | JSON catalogs and registries | `versionPath` + `monotonicSemver` (default `true`) |
| `custom-table` | Repository version matrix | Keep source table outside `scope.writable` |

## Roles and steps

- **`spec.roles[]`**: Declares `1..16` roles (`task` or `review`) with `provider`, `model`, `tools`, `instructions`, `skills`, `mcpServers`, and fallback `models`. Review roles default `tools` to `['read']` and `mcpServers` to `[]`.
- **`spec.steps[]`**: Declares `1..16` acyclic `agent`, `check`, or `compact` nodes with `dependsOn`, compact `handoffs` (`1..16`; see [Task Contract](/loopwright/main/docs/configuration/task-contract/index.md#handoff-selectors)), and optional `onRework: { rejectTo, maxReworks }`.

## Model configuration

`spec.models[]` (`1..8` items; defaults `zai` / `glm-5.3` / `high`) supports token-authenticated Pi HTTP providers and custom `baseUrl` gateways (`allow-custom-base-url: 'true'`). Interactive OAuth/CLI providers and OAuth MCP servers fail closed (`PROVIDER_OAUTH_UNSUPPORTED`, `MCP_OAUTH_UNSUPPORTED`).

### Execution limits

Precedence is Action `with:` inputs > `spec.limits` > `LOOPWRIGHT_*` environment variables > compiler defaults. Key defaults and caps: `wallTimeSeconds` (`3600`, `60..21600`), `totalTokens` (`20000000`), `maxModelCalls` (`256`), `maxAttempts` (`5`, `1..16`), `maxTurns` / `maxRepairTurns` (`1..1024`), and `limits.overlay` (default `128` files / `4 MiB`, up to `16,384` files / `16 GiB` via `1 MiB` CAS streaming).

## Verification and publication

`spec.verification.localChecks` (`0..32`) and `externalGates` (`0..32`) execute inside isolated verifiers:

| Implementation | Behavior |
| --- | --- |
| `json-artifact.v1` | Validates `spec.proposal` JSON/YAML required fields and scalar equality |
| `json-keys-guard.v1` | Fails if any JSON key outside `allowedPointers` changed vs baseline |
| `line-section-guard.v1` | Fails if any line outside `startMarker`/`endMarker` changed vs baseline |
| `evolve-block-guard.v1` | Verifies bytes outside `EVOLVE-BLOCK-START/END` match baseline SHA-256 |
| `scope.v1` / `no-change.v1` | Enforces writable/protected scope or untouched tree parity |
| `command.v1` | Runs protected script directory read-only with disposable `$LOOPWRIGHT_CANDIDATE_DIR` and `$LOOPWRIGHT_CHECK_OUT` |
| `gate.v1` / `benchmark-gate.v1` | Polls remote HMAC-signed check or hardware benchmark gates |

- **Local vs GitHub defaults**: Local CLI runs can omit `publication`, `memory`, and `triggers`. GitHub runs enforce `triggers` pre-preflight and support all four `memory.apply` modes.
- **Isolation & triage**: Configure `spec.sandbox` ([Sandbox Backends](/loopwright/main/docs/configuration/sandbox-backends/index.md)) and `spec.decisions` ([Decision Routing](/loopwright/main/docs/configuration/decision-routing/index.md)).

## TaskpackSuite

`TaskpackSuite` (default `.loopwright/suite.yaml`, `<= 64 KiB`) coordinates `1..32` domain `Taskpack`s and `0..16` acyclic promotion stages with zero suite state in Git:

```yaml
apiVersion: loopwright.dev/v1alpha1
kind: TaskpackSuite
metadata:
  name: repo-automation
spec:
  domains:
    - id: docs
      taskpack: .loopwright/docs.taskpack.yaml
      schedules: # Optional schedule keys
        - nightly
      stage: stage-a # Optional stage ID
    - id: runtime
      taskpack: .loopwright/runtime.taskpack.yaml
      stage: stage-b # Optional
  stages: # Optional 0..16 acyclic promotion stages
    - id: stage-a
    - id: stage-b
      dependsOn:
        - stage-a
      readiness:
        - id: docs-release # Optional
          kind: github-release
          source: octocat/engine
          versionFrom: # Optional
            domain: docs
            path: docs/version.json
            jsonPointer: /version
```

- **Suite protection**: Action (`suite-path`) and App (`suitePath`) enforce the suite-wide protected union across peer control paths (`<= 128` patterns).
- **Disjoint branches**: Domains sharing a `targetBranch` require pairwise prefix-disjoint `headBranchPrefix` values (`TASKPACK_MANIFEST_INVALID`).
- **Stateless readiness**: Stage probes read `versionFrom` blobs (`<= 1 MiB`) from `baseRevision` and emit `eligible` or `deferred`.

---

**See also** — [Declarative Taskpack](/loopwright/main/docs/walkthroughs/declarative-taskpack/index.md) (step-by-step setup and bootstrap prompt) · [Sandbox Backends](/loopwright/main/docs/configuration/sandbox-backends/index.md) (`spec.sandbox` capabilities and backends) · [Decision Routing](/loopwright/main/docs/configuration/decision-routing/index.md) (`spec.decisions` triage policy)

**Next** → [Task Contract](/loopwright/main/docs/configuration/task-contract/index.md) — inspect the underlying `TaskContract` schema used in Managed Controller mode.
