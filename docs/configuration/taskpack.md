# Taskpack

`Taskpack` powers Loopwright's automated mode. Declare repository intent in a bounded YAML document (`<= 64 KiB`), such as `.loopwright/taskpack.yaml` or `.auto-sync/taskpack.yaml`. The host compiles runtime contracts, handler SHA-256 digests, and credential bindings.

For out-of-repo `TrustedRegistry` governance or CLI controller files, see [Task Contract](task-contract.md) and [Controller and Registry](controller-and-registry.md).

## Contents

- [Compilation model](#compilation-model)
- [Taskpack](#taskpack)
- [Execution and vars](#execution-and-vars)
- [Scope and proposal](#scope-and-proposal)
- [Preflight and upstreams](#preflight-and-upstreams)
- [Roles and steps](#roles-and-steps)
- [Model configuration](#model-configuration)
- [Verification checks](#verification-checks)
- [Publication and memory](#publication-and-memory)
- [Triggers and policies](#triggers-and-policies)

## Compilation model

When a GitHub Action, App, or `loopwright step` processes a taskpack, the compiler generates three runtime artifacts:

| Generated artifact | Manifest inputs | Compiler defaults |
| --- | --- | --- |
| `TaskContract` | `metadata.name`, `spec.goal`, `spec.scope`, `spec.steps`, `spec.verification`, `spec.limits` | Adds protected paths, 256-checkpoint scaling, and default budgets (`wallTimeMs: 3600000`, `maxModelCalls: 256`) |
| `TrustedRegistry` | `spec.preflight`, `spec.proposal`, `spec.verification`, `spec.publication`, `spec.mcp` | Computes runtime SHA-256 digests for handlers, directories, instructions, skills, and staged resources |
| `ControllerConfig` | Binds compiled `TaskContract`, `TrustedRegistry` SHA-256, and optional `spec.decisions` | Sets `drainReserveMs: 120000`, `maxAttempts: 5`, `repeatFailureLimit: 2`, and `${ENV}` templates (`0600`) |

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
    capabilities: # Optional host capability overrides
      allowHostEnv: false
      allowHostPath: false
      mountReadOnlyGit: false
      allowCheckNetwork: false
      allowWorkflowWrites: false
      allowAgentNetwork: false
    digests: # Optional SHA-256 lockfile policy
      pinDigests: false
      lockfile: .loopwright/digests.lock.json # Optional
  vars: # Optional static non-secret interpolation vars
    RELEASE_CHANNEL: stable
  preflight: # Optional host preflight hook
    script: scripts/preflight.mjs
    timeoutSeconds: 60 # Optional
    env: # Optional allowlisted host env names
      - UPSTREAM_FEED_CHANNEL
  target: # Optional target matrix bindings
    matrix: # Optional cell list or null
      - id: linux-x64
        platform: linux/x64
        variant: default
  roles: # Optional 1..16 delegated or Pi roles
    - id: author
      purpose: task # Optional
      provider: example
      model: author-model
      thinking: medium # Optional
      tools: [read, write, edit, bash] # Optional
      instructions: [.loopwright/author.md] # Optional
      skills: [.agents/skills/catalog/SKILL.md] # Optional
      mcpServers: [github] # Optional MCP allowlist
      models: [zai/glm-5.3] # Optional fallback labels
    - id: review
      purpose: review # Optional
      provider: example
      model: review-model
      tools: [read] # Optional
      mcpServers: [] # Optional (defaults to [] for review)
  steps: # Optional 1..16 DAG steps (agent, check, compact)
    - id: author-step
      kind: agent
      role: author
      dependsOn: []
    - id: static-step
      kind: check
      check: static-check
      dependsOn: [author-step]
    - id: review-step
      kind: agent
      role: review
      dependsOn: [static-step]
      onRework: # Optional bounded rework edge
        rejectTo: author-step
        maxReworks: 2
  scope: # Optional whitelist and blacklist
    writable: # Optional (defaults to repository-wide writes)
      - manifests/**
      - docs/versions.md
    protected: # Optional blacklist
      - manifests/frozen-policy.yaml
      - scripts/**
  instructions: # Optional protected UTF-8 instruction files
    - .loopwright/instructions.md
  skills: # Optional protected UTF-8 skill files
    - .agents/skills/catalog/SKILL.md
  upstreams:
    - id: engine-release
      kind: http-json
      source: https://releases.example.invalid/engine.json
      watchedPaths:
        - docs
      versionPath: version # Optional for http-json
      monotonicSemver: true # Optional (defaults true on SemVer)
    - id: engine-tag
      kind: git-tag
      source: octocat/engine
      watchedPaths: []
  upstreamGroups: # Optional atomic lockstep groups
    - id: engine-family
      policy: lockstep
      members: [engine-release, engine-tag]
  proposal: # Optional structured proposal artifact
    path: manifests/proposal.yaml
    requiredFields: [schema_version, candidates]
    schemaVersion: 1
  submission: # Optional structured agent deliverable
    path: manifests/submission.json
    required: false # Optional
  verification:
    localChecks:
      - id: proposal-schema
        implementation: json-artifact.v1
        parameters: # Optional scalar overrides
          release_channel: stable
      - id: static-check
        implementation: command.v1
        parameters:
          script: .loopwright/checks/verify.sh
          args: [--channel, "${RELEASE_CHANNEL}"] # Optional
          timeoutSeconds: 30 # Optional (defaults to 30)
          toolchainPaths: [.loopwright/bin] # Optional
          preserveRepoDirName: false # Optional
          mountReadOnlyGit: false # Optional
          allowReadOnlyGitHubToken: false # Optional (defaults to false)
          env: # Optional env name list or string map
            CHANNEL: "${RELEASE_CHANNEL}"
    externalGates:
      - id: ci-smoke
        gateId: catalog-smoke
        endpointId: primary-gate
        required: true
        signingCredentialRef: LOOPWRIGHT_GATE_SIGNING_SECRET # Optional
        authCredentialRef: LOOPWRIGHT_GATE_AUTH_TOKEN # Optional
        url: https://gates.example.invalid/verify # Optional
  publication:
    mode: pull_request
    targetBranch: main
    headBranchPrefix: loopwright-catalog-sync-
    titleTemplate: "chore(${RELEASE_CHANNEL}) - sync upstream release metadata"
  memory:
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
  triggers:
    schedule: true
    workflowDispatch: true
    releasePublished: false
    commentCommands: [retry, revise, status]
    commentPrefixes: [/loopwright] # Optional
  models: # Optional ordered model pool (defaults to zai / glm-5.3 / high)
    - provider: zai
      id: glm-5.3
      thinking: high # Optional (defaults to high)
      apiKeyEnv: ZAI_API_KEY # Optional
      cost: # Optional USD per million tokens
        input: 1
        output: 2
  mcp: # Optional host MCP servers
    servers:
      - id: github
        transport: stdio
        command: github-mcp-server
        args: [stdio, --read-only] # Optional
        envFrom: # Optional secret env mapping
          GITHUB_PERSONAL_ACCESS_TOKEN: GITHUB_TOKEN
        readOnly: true # Optional
        timeoutSeconds: 60 # Optional (defaults to 60)
  limits: # Optional execution ceilings
    wallTimeSeconds: 3600 # Optional
    totalTokens: 20000000 # Optional
    maxOutputTokens: 32768 # Optional
    maxModelCalls: 256 # Optional
    maxAttempts: 5 # Optional
    commandTimeoutSeconds: 30 # Optional
    overlay: # Optional overlay cap overrides
      maxFiles: 512
      maxBytes: 16777216
  output: # Optional (defaults to json)
    formats: [json, github-step-summary]
  sandbox: # Optional host isolation policy
    preferredBackends: [macos-seatbelt, linux-bwrap] # Optional
    networkMode: none # Optional (defaults to none)
    requiredCapabilities: [filesystemWriteContainment, processTreeCleanup] # Optional
    deniedReadPaths: [~/.ssh] # Optional
  decisions: # Optional System-One triage policy
    enabled: true
    provider: typesafe-jev # Optional
    disclosurePolicy: public-metadata-only # Optional
    minConfidence: 0.8 # Optional
```

## Execution and vars

`spec.execution` enforces **dual-key host authority**. Even under `mode: strict`, enabling `allowHostEnv`, `allowHostPath`, `mountReadOnlyGit`, `allowCheckNetwork`, `allowAgentNetwork`, or `command.v1` `mountReadOnlyGit: true` requires `allow-privileged-execution: 'true'` or `--allow-privileged`.

Enabling `allowWorkflowWrites: true` independently requires `allow-workflow-writes: 'true'` or `--allow-workflow-writes`. Multi-tenant webhook service runs refuse self-granted privileged capabilities (`TASKPACK_HOST_BINDING_INVALID` / `TASKPACK_SCOPE_VIOLATION`).

### Trust capabilities

| Field path | Strict / privileged | Runtime scope |
| --- | --- | --- |
| `execution.mode` | `'strict'` | `'strict'` or `'privileged'`; `privileged` sets first four capabilities `true` |
| `capabilities.allowHostEnv` | `false` / `true` | Inherits host env for `preflight` and `command.v1` while stripping Loopwright/provider/GitHub secrets |
| `capabilities.allowHostPath` | `false` / `true` | Inherits host `PATH` for `preflight` and `command.v1` checks |
| `capabilities.mountReadOnlyGit` | `false` / `true` | Stages sanitized read-only `.git` (`hooksPath=/dev/null`, config stripped) for `command.v1` |
| `capabilities.allowCheckNetwork` | `false` / `true` | Grants outbound network for `command.v1` checks; avoids nested macOS Seatbelt `EPERM` when checks run inner sandboxes |
| `capabilities.allowWorkflowWrites` | `false` / `false` | Dual-key unlock permitting agent edits under `.github/workflows/**` |
| `capabilities.allowAgentNetwork` | `false` / `false` | Governs `resolveEffectiveTaskpackSandboxPolicy` / `executeSandboxedCommand`; turnkey `agent-pi` `bash` stays offline-isolated |
| `digests.pinDigests` / `lockfile` | `false` / `<controlRoot>/digests.lock.json` | Runtime SHA-256 digests freeze runs when `false`; `true` enforces lockfile parity via `loopwright digest sync` |

- **`spec.vars` AST interpolation**: Declare `0..64` static non-secret strings (`[A-Z][A-Z0-9_]*`, `<= 512` chars). Post-parse single-pass interpolation replaces `${VAR}` only in `goal.*`, `publication.titleTemplate`/`bodyTemplate`, `roles[].prompt`, `preflight.env[]`, and `localChecks[].parameters` (`args[]`, `env`, `startMarker`, `endMarker`, `allowedPointers[]`). Undeclared or secret `${...}` expressions refuse with `TASKPACK_UNTRUSTED_INTERPOLATION`.

## Scope and proposal

| Field path | Required | Type and bounds | Meaning |
| --- | --- | --- | --- |
| `apiVersion` / `kind` | Yes | `'loopwright.dev/v1alpha1'` / `'Taskpack'` | Schema version and manifest kind (`<= 64 KiB`) |
| `metadata.name` | Yes | Slug (`1..64` chars) | Lowercase identifier (`[a-z][a-z0-9._-]*`) |
| `spec.goal.candidate` / `noChange` | Yes | Strings (`1..1024` chars) | Role objectives for candidate and `no_change` runs |
| `spec.scope.writable` / `protected` | No | String lists (`1..128` / `0..128`) | Explicit `/**` directories, exact files, or single-segment `*`/`?` globs |
| `spec.instructions` / `skills` | No | Path or list (`1..16` paths) | Protected UTF-8 trusted context files (`<= 256 KiB` total) |
| `spec.target.matrix` | No | `null` or `1..64` `{ id, platform, variant }` | Target matrix metadata passed to `TaskContract` and memory |
| `spec.proposal` | No | `{ path, requiredFields, schemaVersion }` | Optional writable `.yaml`/`.yml`/`.json` proposal ledger |
| `spec.submission` | No | `{ path, required? }` | Optional writable `.json` agent deliverable path |

### Scope syntax

- **Explicit suffixes**: Use `dir/**` for recursive directories. Paths without `/**` match exact files or bounded single-segment `*`/`?` globs (`packages/*/package.json`), rejecting `..` and reserved names.
- **Built-in masks**: Built-in agent-instruction paths (such as `AGENTS.md` and tool-specific agent config directories), `.loopwright/policies/**`, `digests.lock.json`, the control root, manifests, instructions, skills, and scripts stay protected; `.agents/**` is opt-in in `writable`, and `.github/workflows/**` requires dual-key `allowWorkflowWrites`.

## Preflight and upstreams

`spec.preflight` runs once on the host **after** actor authorization and `SecretScrubber` initialization and **before** `TaskContract` compilation (`script` must reside under a protected path such as `scripts/**`, `timeoutSeconds` `1..3600`, explicit `env` allowlist). It writes JSON to `$LOOPWRIGHT_PREFLIGHT_OUT` (`disposition`: `'candidate' | 'no_change' | 'blocked'`, `upstreams[]`, and `stagedResources[]`) and may read/write `$LOOPWRIGHT_STAGING_DIR`.

### Staged resources

- **Split mounts**: `mount: 'prompt'` (default for `instruction`/`skill`, `<= 64 KiB` UTF-8, `<= 256 KiB` total) loads into `TaskContract.spec.trustedContext.resources`. `mount: 'workspace'` (default for `document`, `<= 128 MiB` per file, `<= 256 MiB` total) stages read-only files on disk without prompt decoding, and `exposeToChecks: true` exposes them under `$LOOPWRIGHT_STAGED_DIR`.
- **Single-link files**: Every staged resource must be a single-link (`nlink === 1`) regular file; pack directories such as `npm-cache` into a `.tgz` archive.

### Upstream kinds

| Field or value | Type or behavior | Constraint or default |
| --- | --- | --- |
| `upstreams[].kind` | `'github-release'`, `'git-tag'`, `'git-commit'`, `'http-json'`, `'custom-table'` | `watchedPaths` (`0..64` paths) wired into intake context; `allowPrerelease` optional |
| `versionPath` / `monotonicSemver` | Dot/bracket selector and downgrade guard (`http-json` only) | `monotonicSemver` defaults `true`; marks downgrades `'held_back'` |
| `upstreamGroups[]` | `{ id, policy: 'lockstep' \| 'independent', members: [...] }` | Under `'lockstep'`, version mismatch or unavailability marks the whole group `'held_back'` atomically |
| `'held_back'` status | `UpstreamAcquisitionStatus` value alongside `available`, `up_to_date`, `blocked`, `failed` | Allows sibling `available` upstreams to proceed while keeping `currentVersion` in memory |

## Roles and steps

`spec.roles` declares `1..16` roles (`id`, `provider`, `model`, `purpose: task | review`, `thinking`, `tools`: `read | write | edit | bash | delete`, `dependsOn`, per-role `instructions`, `skills`, `prompt`, `mcpServers`, `models`). Review roles default `tools` to `['read']` and `mcpServers` to `[]`. Loopwright compiles per-role `resourceIds` and enforces `mcpServers` allowlists in both Action and `loopwright step` modes.

`spec.steps` declares `1..16` acyclic nodes (`id`, `kind: 'agent' | 'check' | 'compact'`, `role` or `check`, `dependsOn`, and optional `onRework: { rejectTo, maxReworks }` where `rejectTo` is a strict ancestor task step and `maxReworks` is `1..8`). Author steps produce `Submission` records while review steps produce `StepVerdict` (`pass | rework | fail | human`, `summary`, `findings`) without overwriting author claims.

## Model configuration

### Model fields

`spec.models` (`1..8` items; defaults `zai` / `glm-5.3` / `high`) accepts token-authenticated Pi HTTP providers and custom `baseUrl` gateways (`allow-custom-base-url: 'true'`); interactive OAuth/CLI providers fail closed (`PROVIDER_OAUTH_UNSUPPORTED`).

| Field path | Type and bounds | Meaning |
| --- | --- | --- |
| `models[].provider` / `id` | Slug (`1..64`) / ID (`1..128`) | Token-based Pi provider or custom provider ID and model identifier |
| `models[].thinking` / `api` | `'off'..'max'` / wire API | Reasoning effort and wire dialect (`anthropic-messages`, `openai-completions`, `openai-responses`) |
| `models[].apiKeyEnv` / `baseUrl` | Env var name / `https://` URL | Host token env var (`[A-Z][A-Z0-9_]*`) and optional custom gateway URL |
| `models[].cost` / `compat` | `{ input, output }` / dialect flags | Optional USD per million tokens and Pi `models.json` compatibility options |

### MCP and limits

`spec.mcp.servers` (`0..16` items) supports `stdio` (`command`, `args`, `env`, `envFrom`, `readOnly`, `timeoutSeconds: 1..600`) and `http` (`url`, `headers`, `headersFrom`, `bearerTokenEnv`, `includeTools`). OAuth MCP configs fail closed (`MCP_OAUTH_UNSUPPORTED`).

### Execution limits

Action `with:` inputs override `spec.limits`, which override `LOOPWRIGHT_*` env vars. Key bounds: `wallTimeSeconds` (`60..21600`), `totalTokens` (`1000..1e9`), `maxModelCalls` (`1..1024`), `maxAttempts` (`1..16`, within 256 checkpoints), `commandTimeoutSeconds` (`1..3600`), and `limits.overlay: { maxFiles: 1..4096, maxBytes: 1024..67108864 }` (default `128` / `4 MiB`; e.g. `512` / `16 MiB`).

Optional `maxTurns` and `maxRepairTurns` (`1..1024`) cap turns per host-session dispatch; when omitted, defaults derive from compiled `maxModelCalls` and `maxImplementationRepairs`. Unlike fallback `LOOPWRIGHT_*` env vars above, `LOOPWRIGHT_MAX_TURNS` and `LOOPWRIGHT_MAX_REPAIR_TURNS` take precedence over `spec.limits` at runtime.

## Verification checks

`spec.verification.localChecks` (`0..32` items) and `externalGates` (`0..32` items) evaluate candidate artifacts and scripts inside isolated verifiers.

### Local implementations

| Implementation | Key parameters | Behavior |
| --- | --- | --- |
| `json-artifact.v1` | Scalar expectations (binds `spec.proposal`) | Validates JSON/YAML keys and scalar equality |
| `json-keys-guard.v1` | `path`, `allowedPointers` (`/json/pointer`) | Fails if any JSON key outside `allowedPointers` changed vs baseline |
| `line-section-guard.v1` | `path`, `startMarker`, `endMarker` | Fails if any line outside delimited marker sections changed vs baseline |
| `scope.v1` / `no-change.v1` | `checkId` (plus implicit guards) | Verifies writable/protected scope or untouched tree parity |
| `command.v1` | `script`, `args`, `env`, `toolchainPaths`, `mountReadOnlyGit`, `preserveRepoDirName` | Mounts the script's parent directory read-only (whole-tree SHA-256 digest so `./lib.sh` works) |

### Command parameters

- **Mounted environment**: `command.v1` receives `$LOOPWRIGHT_CANDIDATE_DIR`, `$LOOPWRIGHT_BASE_DIR` (read-only baseline), `$LOOPWRIGHT_STAGED_DIR` (when `exposeToChecks: true`), and `$LOOPWRIGHT_CHECK_OUT`.
- **Structured check output**: Writing bounded JSON (`{ metrics?, findings?, detail? }`, `<= 64 KiB`) to `$LOOPWRIGHT_CHECK_OUT` propagates through HMAC-signed `gate.v1` verdicts (`metrics`, `findings`, `detail`, `retryablePreemption`) even on exit `0`.
- **Inner sandboxes and gates**: Checks running their own inner OS sandbox (such as macOS `sandbox-exec`) should set `allowCheckNetwork: true` under dual-key `--allow-privileged` to avoid nested Seatbelt `EPERM`. `externalGates[]` support per-gate `signingCredentialRef`, `authCredentialRef`, and `url`.

## Publication and memory

| Field path | Type and values | Meaning |
| --- | --- | --- |
| `publication.mode` / `targetBranch` | `'pull_request' \| 'disabled'` / branch | Native PR creation or local/check-only settlement |
| `publication.headBranchPrefix` / `titleTemplate` | Prefix (`1..64`) / string (`1..256`) | Managed branch prefix and PR title template (optional `bodyTemplate`) |
| `memory.directory` / `apply` | `<controlRoot>/memory` / `'separate-pull-request' \| 'local-only' \| 'disabled'` | Protected CAS memory location and application mode |
| `memory.onNoModelBudget` | `'deterministic-observations-only' \| 'skip'` | Behavior without model budget (optional when `apply` is `'disabled'`) |
| `memory.ttlDays` / `maxEntries` / `maxPromptEntries` | `1..365` (`15`) / `1..512` (`128`) / `1..128` (`32`) | Retention window and entry limits (`checkCodeFingerprint`, `checkUpstreamVersions`, `publishOnFailure`, `skipCi`) |

### Memory apply modes

| Mode | Behavior | Typical use |
| --- | --- | --- |
| `separate-pull-request` | Opens or updates a separate memory branch and PR | Default for reviewed repository memory |
| `local-only` | Updates `<memoryDirectory>` locally without remote branch writes | Local loops or read-only remotes |
| `disabled` | Skips memory loading, prompt injection, and finalization | Stateless or `spec.decisions`-driven taskpacks |

## Triggers and policies

| Field path | Type and values | Meaning |
| --- | --- | --- |
| `triggers.schedule` / `workflowDispatch` / `releasePublished` | Booleans | Permitted GitHub event triggers |
| `triggers.commentCommands` / `commentPrefixes` | `['retry', 'revise', 'status']` / `['/loopwright']` | Authorized PR slash commands and command prefixes |
| `spec.sandbox` / `spec.decisions` / `spec.output` | Objects | Isolation ([Sandbox Backends](sandbox-backends.md)), triage ([Decision Routing](decision-routing.md)), and outputs (`json`, `github-step-summary`, `markdown`, `text`) |

---

**See also** — [Declarative Taskpack](../walkthroughs/declarative-taskpack.md) (step-by-step setup and bootstrap prompt) · [Sandbox Backends](sandbox-backends.md) (`spec.sandbox` capabilities and backends)

**Next** → [Task Contract](task-contract.md) — inspect the underlying `TaskContract` schema used in Managed Controller mode.
