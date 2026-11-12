# Taskpack

`Taskpack` (`.loopwright/taskpack.yaml`) powers Loopwright's simple automated mode. You declare repository intent in one bounded YAML document (`<= 64 KiB`), and the host compiles runtime contracts, handler SHA-256 digests, and credential bindings automatically.

For multi-step DAGs or operator-owned `TrustedRegistry` files stored outside the repository, use Managed Controller mode ([Task Contract](/loopwright/latest/docs/configuration/task-contract/index.md) and [Controller and Registry](/loopwright/latest/docs/configuration/controller-and-registry/index.md)).

## Contents

- [Compilation model](#compilation-model)
- [Taskpack](#taskpack)
- [Metadata and scope](#metadata-and-scope)
- [Model configuration](#model-configuration)
- [Upstreams and proposal](#upstreams-and-proposal)
- [Verification checks](#verification-checks)
- [Publication and memory](#publication-and-memory)
- [Triggers and policies](#triggers-and-policies)

## Compilation model

When a GitHub Action or App processes `.loopwright/taskpack.yaml`, `compileDeclarativeTaskpack` generates three runtime artifacts without manual authoring:

| Generated artifact | Manifest inputs | Compiler defaults |
| --- | --- | --- |
| `TaskContract` | `metadata.name`, `spec.goal`, `spec.scope`, `spec.verification` | Appends built-in protected paths (`.github`, `.loopwright/policies`, `AGENTS.md`, `CLAUDE.md`) and default budgets (`wallTimeMs: 3300000`, `maxModelCalls: 12`) |
| `TrustedRegistry` | `spec.proposal`, `spec.verification`, `spec.publication` | Computes SHA-256 digests for installed handlers (`pi.agent.v1`, `json-artifact.v1`, `scope.v1`, `no-change.v1`, `gate.v1`) and `package-lock.json` |
| `ControllerConfig` | Binds compiled `TaskContract` and `TrustedRegistry` SHA-256 | Sets `drainReserveMs: 120000`, `maxAttempts: 3`, `repeatFailureLimit: 2`, and `${ENV}` credential templates (`0600`) |

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
  scope:
    writable:
      - manifests
      - docs/versions.md
    protected:
      - manifests/frozen-policy.yaml
  upstreams:
    - id: engine-release
      kind: github-release
      source: octocat/engine
      watchedPaths:
        - docs
      allowPrerelease: false # Optional (defaults to false)
  proposal:
    path: manifests/proposal.yaml
    requiredFields:
      - schema_version
      - candidates
    schemaVersion: 1
  verification:
    localChecks:
      - id: proposal-schema
        implementation: json-artifact.v1
        parameters: # Optional scalar overrides
          release_channel: stable
    externalGates: # Optional remote gate.v1 checks (use [] when none)
      - id: ci-smoke
        gateId: catalog-smoke
        endpointId: primary-gate
        required: true
  publication:
    mode: pull_request
    targetBranch: main
    headBranchPrefix: loopwright/catalog-sync-
    titleTemplate: "chore(catalog) - sync upstream release metadata"
  memory:
    directory: .loopwright/memory/catalog-sync
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: true
    workflowDispatch: true
    releasePublished: false
    commentCommands:
      - retry
      - revise
      - status
    commentPrefixes: # Optional (defaults to ['/loopwright'])
      - /loopwright
  models: # Optional ordered model pool (defaults to zai / glm-5.3 / high)
    - provider: zai
      id: glm-5.3
      thinking: high # Optional (defaults to high)
      apiKeyEnv: ZAI_API_KEY # Optional (defaults to provider token env)
    - provider: zai-coding-cn # Optional fallback candidate on quota exhaustion
      id: glm-5.3
      thinking: high # Optional
      apiKeyEnv: ZAI_CODING_CN_API_KEY # Optional
  sandbox: # Optional host isolation policy
    preferredBackends: # Optional
      - macos-seatbelt
      - linux-bwrap
      - linux-landlock
      - docker
    networkMode: none # Optional (defaults to none)
    requiredCapabilities: # Optional
      - filesystemReadContainment
      - filesystemWriteContainment
      - protectedPathReadOnlyMask
      - networkIsolation
      - processTreeCleanup
    deniedReadPaths: # Optional
      - ~/.ssh
  decisions: # Optional System-One triage policy
    enabled: true
    provider: typesafe-jev # Optional (defaults to typesafe-jev)
    disclosurePolicy: public-metadata-only # Optional (defaults to disabled)
    minConfidence: 0.8 # Optional (defaults to 0.8)
    confirmThreshold: 0.6 # Optional (defaults to 0.6)
    hardDeadlineMs: 5000 # Optional (defaults to 5000)
    maxAttempts: 1 # Optional (defaults to 1)
    allowImages: false # Optional (defaults to false)
```

- **Strict YAML 1.2**: The parser rejects symlinks (`O_NOFOLLOW`), `..` traversal, duplicate keys, YAML anchors/aliases, and `${NAME}` interpolation (`TASKPACK_UNTRUSTED_INTERPOLATION`; see [Environment interpolation](/loopwright/latest/docs/configuration/controller-and-registry/index.md#environment-interpolation)).
- **Built-in masks**: `.github`, `.loopwright/policies`, `AGENTS.md`, and `CLAUDE.md` remain protected even if omitted from `spec.scope.protected`.

## Metadata and scope

| Field path | Required | Type and bounds | Meaning |
| --- | --- | --- | --- |
| `apiVersion` | Yes | `'loopwright.dev/v1alpha1'` | Unified Loopwright schema version |
| `kind` | Yes | `'Taskpack'` | Selects declarative taskpack validation (`<= 64 KiB`) |
| `metadata.name` | Yes | Identifier (`1..64` chars) | Unique lowercase slug (`[a-z][a-z0-9._-]*`); scopes tenant queue, `TaskContract.spec.taskpack`, and `.loopwright/memory/<name>` |
| `spec.goal.candidate` | Yes | String (`1..1024` chars) | Prompt objective compiled when candidate edits are expected |
| `spec.goal.noChange` | Yes | String (`1..1024` chars) | Prompt objective compiled when verifying `no_change` eligibility |
| `spec.scope.writable` | Yes | String list (`1..128` paths) | Relative repo paths open for agent writes; cannot overlap protected paths |
| `spec.scope.protected` | Yes | String list (`0..128` paths) | Relative repo paths masked read-only (pass `[]` when relying on built-in masks) |

## Model configuration

Loopwright inherits `provider`, `model`, `thinking`, wire `api`, and custom `models.json` semantics from the [Pi model catalog](https://pi.dev/models) and Pi's [providers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md), [models](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md), and [models-configuration](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models-configuration.md) guides. `spec.models` declares an ordered `1..8` candidate list for the **coding and authoring LLM** (separate from `spec.decisions` triage).

Loopwright admits **token-authenticated HTTP providers only** and handles rate spikes and quota limits across two layers:

- **Supported built-in token providers**: `zai` (`ZAI_API_KEY`) and `zai-coding-cn` (`ZAI_CODING_CN_API_KEY`) ship `glm-5.3` (`thinking`: `off`, `low`, `high`, `max`), alongside `anthropic`, `openai`, `openrouter`, `deepseek`, `qwen-token-plan`, `qwen-token-plan-cn`, `fireworks`, `together`, `baseten`, `nvidia`, `groq`, `cerebras`, `mistral`, `xai`, `huggingface`, `minimax`, `minimax-cn`, `moonshotai`, `kimi-coding`, `opencode`, `vercel-ai-gateway`, `xiaomi`, and `ant-ling`.
- **Supported custom gateways**: Declare `baseUrl` and `api` (`openai-completions`, `openai-responses`, or `anthropic-messages`) in any `spec.models[]` item (with Action `allow-custom-base-url: 'true'`) or supply a host Pi `models.json` file (`models-json`).
- **Quota probe and fallback**: A single candidate runs with zero probe overhead; `>= 2` candidates (or comma-separated tokens in `apiKeyEnv`) run a `max_tokens=1` preflight probe (`<= 15s` each, `<= 30s` total) to skip `402`, `400` quota codes (`1113`), `401`/`403`, `429`, or `5xx`, while `maxTransportRetries` absorbs transient `429` bursts in-session and rotates to the next candidate on mid-run quota exhaustion.
- **Refused OAuth and shell providers**: Interactive OAuth/CLI providers (`github-copilot`, `gemini`, `google`, `gemini-cli`, `google-gemini-cli`, `google-antigravity`, `claude-code`, `openai-codex`), `oauth` blocks, literal `apiKey` secrets, and `!command` shell resolvers fail closed with `PROVIDER_OAUTH_UNSUPPORTED`.

```yaml
apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: catalog-sync
spec:
  # Other Taskpack sections omitted; see Taskpack above.
  models: # Optional ordered model pool
    - provider: custom-glm-gateway
      id: glm-5.3
      thinking: high # Optional
      api: openai-completions # Optional for built-in providers; needed with baseUrl
      baseUrl: https://llm-gateway.example.com/v1 # Optional custom endpoint URL
      apiKeyEnv: ZAI_API_KEY # Optional
      authHeader: true # Optional Bearer header toggle
      contextWindow: 204800 # Optional
      maxTokens: 32768 # Optional
      reasoning: true # Optional
      samplingParams: # Optional
        temperature: 0.6
        top_p: 0.95
      compat: # Optional OpenAI-compatible wire dialect tuning
        thinkingFormat: zai
        maxTokensField: max_tokens
        zaiToolStream: true
    - provider: zai-coding-cn # Optional fallback candidate
      id: glm-5.3
      thinking: high # Optional
      apiKeyEnv: ZAI_CODING_CN_API_KEY # Optional
```

### Model fields

| Field path | Required | Type and bounds | Meaning |
| --- | --- | --- | --- |
| `spec.models` | No | Object list (`1..8` items; `zai`/`glm-5.3`/`high` default) | Ordered coding model candidates; Action `provider`/`model` inputs override the list |
| `models[].provider` | Conditional | Slug (`1..64` chars) | **Required** per item; token-based Pi provider or custom provider ID |
| `models[].id` | Conditional | Model ID (`1..128` chars) | **Required** per item; model identifier (for example `glm-5.3`) |
| `models[].thinking` | No | `'off'` \| `'minimal'` \| `'low'` \| `'medium'` \| `'high'` \| `'xhigh'` \| `'max'` | Reasoning effort validated against Pi `reasoning` and `thinkingLevelMap` |
| `models[].api` | Conditional | `'anthropic-messages'` \| `'openai-completions'` \| `'openai-responses'` | **Required** when `models[].baseUrl` is set; inferred for built-in Pi providers |
| `models[].apiKeyEnv` | No | Env var name (`[A-Z][A-Z0-9_]*`) | Host env var holding API token or comma-separated tokens (defaults to Pi env or `LOOPWRIGHT_PROVIDER_TOKEN`) |
| `models[].baseUrl` | No | `https://` URL (or loopback `http://127.0.0.1:<port>`) | Custom compatible API base URL; requires host `allowManifestCustomBaseUrl` |
| `models[].authHeader` | No | Boolean | Forces `Authorization: Bearer <token>` on custom `anthropic-messages` endpoints |
| `models[].headers` | No | String map (`<= 32` headers) | Non-auth static headers (`Authorization`, `x-api-key`, and `!command` refused) |
| `models[].contextWindow` / `maxTokens` | No | Integers (`1024..10000000` / `1..1048576`) | Custom model context window and output token caps (defaults `128000` / `16384`) |
| `models[].reasoning` | No | Boolean (defaults `true` when `thinking != 'off'`) | Declares whether custom model accepts reasoning parameters |
| `models[].thinkingLevelMap` | No | Map of level to wire effort or `null` | Custom Pi `thinkingLevelMap` (`null` marks a level unsupported) |
| `models[].samplingParams` | No | `{ temperature, top_p, top_k, min_p, presence_penalty, repetition_penalty }` | Default Pi sampling parameters forwarded on outbound model requests |
| `models[].samplingParamsByThinkingLevel` | No | Map of thinking level to `samplingParams` | Per-thinking-level sampling parameter overrides |
| `models[].compat` | No | Object (`thinkingFormat`, `maxTokensField`, `zaiToolStream`, booleans) | OpenAI-compatible dialect flags matching Pi `models.json` `compat` |

## Upstreams and proposal

### Upstream and proposal fields

| Field path | Required | Type and bounds | Meaning |
| --- | --- | --- | --- |
| `spec.upstreams` | Yes | Object list (`1..32` items) | External or internal sources monitored for version drift |
| `upstreams[].id` | Yes | Identifier (`1..64` chars) | Unique identifier for the upstream source |
| `upstreams[].kind` | Yes | Enum (see table below) | Discovery mechanism used to read upstream state |
| `upstreams[].source` | Yes | String (`1..512` chars) | `owner/repo` slug, git URL, `https://` feed URL, or table ID |
| `upstreams[].watchedPaths` | Yes | String list (`0..64` paths) | Relative paths filtered on `git-commit` sources (pass `[]` if unused) |
| `upstreams[].allowPrerelease` | No | Boolean (unset by default) | Includes pre-release tags when `kind` is `github-release` |
| `spec.proposal.path` | Yes | Relative path (`.yaml`/`.yml`/`.json`) | Structured proposal file written inside `spec.scope.writable` |
| `spec.proposal.requiredFields` | Yes | String list (`1..32` keys) | Top-level keys that must exist in the generated proposal document |
| `spec.proposal.schemaVersion` | Yes | Integer (`>= 1`) | Exact integer required at `schema_version` inside `proposal.path` |

### Upstream kinds

| Value | Expected `source` | Discovery behavior |
| --- | --- | --- |
| `github-release` | `owner/repo` | Tracks latest published GitHub Release (or pre-release if enabled) |
| `git-tag` | `owner/repo` or git URL | Tracks latest upstream Git tag reference |
| `git-commit` | `owner/repo` or git URL | Tracks upstream commit SHA touching `watchedPaths` |
| `http-json` | `https://...` URL | Polls a deterministic JSON release metadata endpoint |
| `custom-table` | Repository table ID | Reads a pinned structured version matrix in the repository |

## Verification checks

### Check and gate fields

| Field path | Required | Type and bounds | Meaning |
| --- | --- | --- | --- |
| `verification.localChecks` | Yes | Object list (`0..32` items) | In-host verifiers (`candidate` mode requires `>= 1` local or required gate check) |
| `localChecks[].id` | Yes | Identifier (`1..64` chars) | Unique check ID (cannot use reserved `scope`, `no-change`, `taskpack-author`, `taskpack-no-change`) |
| `localChecks[].implementation` | Yes | Enum (see table below) | Built-in verifier bound by compiler to its installed SHA-256 digest |
| `localChecks[].parameters` | No | Scalar map (unset by default) | Extra scalar expectations (`string <= 1024` chars, `number`, `boolean`, `null`) |
| `verification.externalGates` | Yes | Object list (`0..32` items) | Remote authenticated `gate.v1` checks (pass `[]` when unused) |
| `externalGates[].id` | Conditional | Identifier (`1..64` chars) | **Required** per gate item; unique check ID recorded in acceptance evidence |
| `externalGates[].gateId` | Conditional | Identifier (`1..64` chars) | **Required** per gate item; remote gate policy identifier |
| `externalGates[].endpointId` | Conditional | Identifier (`1..64` chars) | **Required** per gate item; matches a host `HostGateEndpointPlan.id` |
| `externalGates[].required` | Conditional | Boolean | **Required** per gate item; marks gate receipt mandatory for candidate acceptance |

### Local implementations

| Implementation | Compiler parameters | Verification check |
| --- | --- | --- |
| `json-artifact.v1` | Binds `proposal.path`, `requiredFields`, and `schema_version` | Parses structured candidate artifact and checks required keys and scalars |
| `scope.v1` | Binds `checkId` (compiler also runs implicit `scope` guard) | Verifies every modified file stays inside `writable` and outside `protected` |
| `no-change.v1` | Binds `checkId` (used automatically in `no-change` mode) | Confirms candidate tree equals base tree when settling as `no_change` |

## Publication and memory

| Field path | Required | Type and bounds | Meaning |
| --- | --- | --- | --- |
| `publication.mode` | Yes | `'pull_request'` or `'disabled'` | Opens/updates a managed pull request or skips remote branch writes |
| `publication.targetBranch` | Yes | Branch name (`1..128` chars) | Base branch targeted by generated pull requests (required even when `disabled`) |
| `publication.headBranchPrefix` | Yes | Prefix (`1..64` chars, no `//`) | Branch prefix for head-pinned PRs (for example `loopwright/catalog-sync-`) |
| `publication.titleTemplate` | Yes | String (`1..256` chars) | Pull request title string |
| `memory.directory` | Yes | Path under `.loopwright/memory/<name>` | Storage directory for reviewed CAS memory; must not overlap `writable` |
| `memory.apply` | Yes | `'separate-pull-request'` | Proposes memory updates in a separate PR outside candidate changes |
| `memory.onNoModelBudget` | Yes | `'deterministic-observations-only'` | Records deterministic run facts without extra LLM calls when budget ends |

## Triggers and policies

### Trigger and policy fields

| Field path | Required | Type and bounds | Meaning |
| --- | --- | --- | --- |
| `triggers.schedule` | Yes | Boolean | Permits scheduled cron triggers |
| `triggers.workflowDispatch` | Yes | Boolean | Permits manual `workflow_dispatch` triggers |
| `triggers.releasePublished` | Yes | Boolean | Permits GitHub `release` event triggers |
| `triggers.commentCommands` | Yes | Command list (`0..3` items) | Authorized slash commands (`retry`, `revise`, `status`; pass `[]` to disable) |
| `triggers.commentPrefixes` | No | String list (`1..8` items) | Command prefix tokens; defaults to `['/loopwright']` |
| `spec.sandbox` | No | Object (unset by default) | Host sandbox isolation requirements; see [Sandbox Backends](/loopwright/latest/docs/configuration/sandbox-backends/index.md) |
| `spec.decisions` | No | Object (unset by default) | Advisory System-One triage thresholds; see [Decision Routing](/loopwright/latest/docs/configuration/decision-routing/index.md) |

### Comment commands

| Command | Invocation example | Intake behavior |
| --- | --- | --- |
| `retry` | `/loopwright retry` | Re-runs bounded upstream discovery and candidate execution |
| `revise` | `/loopwright revise` | Passes bounded reviewer guidance (`<= 40` lines, `<= 2048` bytes) into next attempt |
| `status` | `/loopwright status` | Reports active queue lease, run status, or last receipt summary |

---

**See also** — [Declarative Taskpack](/loopwright/latest/docs/walkthroughs/declarative-taskpack/index.md) (step-by-step setup and bootstrap prompt) · [Sandbox Backends](/loopwright/latest/docs/configuration/sandbox-backends/index.md) (`spec.sandbox` capabilities and backends)

**Next** → [Task Contract](/loopwright/latest/docs/configuration/task-contract/index.md) — inspect the underlying `TaskContract` schema used in Managed Controller mode.
