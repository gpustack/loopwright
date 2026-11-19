# Taskpack

`Taskpack` powers Loopwright's automated mode. Declare repository intent in a bounded YAML document (`<= 64 KiB`), such as `.loopwright/taskpack.yaml` or `.auto-sync/taskpack.yaml`. The host compiles runtime contracts, handler SHA-256 digests, and credential bindings.

For multi-step DAGs or operator-owned `TrustedRegistry` files stored outside the repository, use Managed Controller mode ([Task Contract](task-contract.md) and [Controller and Registry](controller-and-registry.md)).

## Contents

- [Compilation model](#compilation-model)
- [Taskpack](#taskpack)
- [Metadata and scope](#metadata-and-scope)
- [Model configuration](#model-configuration)
- [MCP and limits](#mcp-and-limits)
- [Upstreams and proposal](#upstreams-and-proposal)
- [Verification checks](#verification-checks)
- [Publication and memory](#publication-and-memory)
- [Triggers and policies](#triggers-and-policies)

## Compilation model

When a GitHub Action or App processes a taskpack, `compileDeclarativeTaskpack` generates three runtime artifacts:

| Generated artifact | Manifest inputs | Compiler defaults |
| --- | --- | --- |
| `TaskContract` | `metadata.name`, `spec.goal`, `spec.scope`, `spec.verification`, `spec.limits` | Adds protected paths and default budgets (`wallTimeMs: 3600000`, `maxModelCalls: 256`) |
| `TrustedRegistry` | `spec.proposal`, `spec.verification`, `spec.publication`, `spec.mcp` | Computes SHA-256 digests for installed handlers (`pi.agent.v1`, `json-artifact.v1`, `scope.v1`, `no-change.v1`, `gate.v1`) and `package-lock.json` |
| `ControllerConfig` | Binds compiled `TaskContract` and `TrustedRegistry` SHA-256 | Sets `drainReserveMs: 120000`, `maxAttempts: 5`, `repeatFailureLimit: 2`, and `${ENV}` credential templates (`0600`) |

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
  roles: # Optional delegated or Pi role DAG
    - id: author
      purpose: task # Optional
      provider: example
      model: author-model
      thinking: medium # Optional
      tools: # Optional
        - read
        - write
        - edit
    - id: review
      purpose: review # Optional
      provider: example
      model: review-model
      tools: # Optional
        - read
      dependsOn: # Optional prior role IDs
        - author
  scope: # Optional whitelist and blacklist
    writable: # Optional (defaults to repository-wide writes)
      - manifests
      - docs/versions.md
    protected: # Optional blacklist
      - manifests/frozen-policy.yaml
  instructions: # Optional protected UTF-8 instruction files
    - .loopwright/instructions.md
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
      - id: static-check
        implementation: command.v1
        parameters:
          script: .loopwright/checks/verify.sh
          timeoutSeconds: 30 # Optional (defaults to 30)
          allowReadOnlyGitHubToken: false # Optional (defaults to false)
          env: # Optional safe environment variable names
            - CHECK_MODE
    externalGates:
      - id: ci-smoke
        gateId: catalog-smoke
        endpointId: primary-gate
        required: true
  publication:
    mode: pull_request
    targetBranch: main
    headBranchPrefix: loopwright-catalog-sync-
    titleTemplate: "chore(catalog) - sync upstream release metadata"
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
      cost: # Optional USD per million tokens
        input: 1
        output: 2
  mcp: # Optional host MCP servers
    servers:
      - id: github
        transport: stdio
        command: github-mcp-server
        args: # Optional command arguments
          - stdio
          - --read-only
        envFrom: # Optional secret env mapping
          GITHUB_PERSONAL_ACCESS_TOKEN: GITHUB_TOKEN
        timeoutSeconds: 60 # Optional (defaults to 60)
  limits: # Optional execution ceilings (see Execution limits)
    wallTimeSeconds: 3600 # Optional
    totalTokens: 20000000 # Optional
    maxOutputTokens: 32768 # Optional
    maxModelCalls: 256 # Optional
    maxAttempts: 5 # Optional
    commandTimeoutSeconds: 30 # Optional
  output: # Optional (defaults to json)
    formats:
      - json
      - github-step-summary
  sandbox: # Optional host isolation policy
    preferredBackends: # Optional
      - macos-seatbelt
      - linux-bwrap
    networkMode: none # Optional (defaults to none)
    requiredCapabilities: # Optional
      - filesystemWriteContainment
      - processTreeCleanup
    deniedReadPaths: # Optional
      - ~/.ssh
  decisions: # Optional System-One triage policy
    enabled: true
    provider: typesafe-jev # Optional (defaults to typesafe-jev)
    disclosurePolicy: public-metadata-only # Optional (defaults to disabled)
    minConfidence: 0.8 # Optional (defaults to 0.8)
```

### Role DAG

`spec.roles` contains one to four acyclic roles (`id`, `provider`, `model`, optional `purpose: task | review`, `thinking`, `tools`, and earlier `dependsOn` IDs; Turnkey grants `read`, `write`, `edit`, `bash`, `delete` plus `mcp__<id>__<tool>`). The first check depends on every sink role, `maxAttempts` fits `D <= 64`, and `loopwright step next --taskpack` runs `executionMode: 'delegated'` without provider secrets ([CLI](../operations/cli.md)).

- **Strict YAML 1.2**: Rejects symlinks (`O_NOFOLLOW`), `..` traversal, duplicate keys, anchors/aliases, and `${NAME}` interpolation (`TASKPACK_UNTRUSTED_INTERPOLATION`; see [Environment interpolation](controller-and-registry.md#environment-interpolation)).
- **Control root and masks**: Action `taskpack-path` parent becomes the control root (default `.loopwright`); protects `.github`, `.claude`, `.codex`, `.agents`, `.loopwright/policies`, `AGENTS.md`, `CLAUDE.md`, the control root (except an exact `spec.proposal.path`), the manifest, instructions, and check scripts.

## Metadata and scope

| Field path | Required | Type and bounds | Meaning |
| --- | --- | --- | --- |
| `apiVersion` | Yes | `'loopwright.dev/v1alpha1'` | Unified Loopwright schema version |
| `kind` | Yes | `'Taskpack'` | Selects declarative taskpack validation (`<= 64 KiB`) |
| `metadata.name` | Yes | Identifier (`1..64` chars) | Unique lowercase slug (`[a-z][a-z0-9._-]*`); scopes tenant queue and `TaskContract.spec.taskpack` |
| `spec.goal.candidate` | Yes | String (`1..1024` chars) | Prompt objective compiled when candidate edits are expected |
| `spec.goal.noChange` | Yes | String (`1..1024` chars) | Prompt objective compiled when verifying `no_change` eligibility |
| `spec.scope` | No | Object | Writable whitelist and protected blacklist; both fields may be omitted |
| `spec.scope.writable` | No | String list (`1..128` paths) | Relative paths open for writes; omission allows the repository subject to protected paths |
| `spec.scope.protected` | No | String list (`0..128` paths) | Relative paths excluded from writes in addition to built-in masks |
| `spec.instructions` | No | Relative path or list (`1..16` paths) | UTF-8 files compiled as SHA-256-pinned `instruction` trusted resources; aggregate size `<= 262144` bytes |

Scope paths include descendants except for an exact `spec.proposal.path` file inside the control root (which requires an exact `writable` entry). Raw globs, traversal, spaces, symlinks, and empty writable lists are rejected; protected paths win over writable ancestors, and `proposal.path` must stay writable.

## Model configuration

Loopwright inherits `provider`, `model`, `thinking`, wire `api`, and custom `models.json` semantics from the [Pi model catalog](https://pi.dev/models) and Pi's [providers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md), [models](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md), and [models-configuration](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models-configuration.md) guides. `spec.models` declares an ordered `1..8` candidate list for the **coding and authoring LLM** (separate from `spec.decisions` triage) and admits **token-authenticated HTTP providers only**:

- **Built-in token providers**: `zai` (`ZAI_API_KEY`) and `zai-coding-cn` (`ZAI_CODING_CN_API_KEY`) ship `glm-5.3` (`thinking`: `off`, `low`, `high`, `max`), alongside `anthropic`, `openai`, `openrouter`, `deepseek`, `qwen-token-plan`, `qwen-token-plan-cn`, `fireworks`, `together`, `baseten`, `nvidia`, `groq`, `cerebras`, `mistral`, `xai`, `huggingface`, `minimax`, `minimax-cn`, `moonshotai`, `kimi-coding`, `opencode`, `vercel-ai-gateway`, `xiaomi`, and `ant-ling`.
- **Custom gateways and fallback**: Declare `baseUrl` and `api` on any `spec.models[]` item (with Action `allow-custom-base-url: 'true'`) or pass `models-json`. One candidate skips probing; `>= 2` candidates (or comma-separated `apiKeyEnv` tokens) run a `max_tokens=1` preflight probe (`<= 15s` each, `<= 30s` total) and rotate on quota exhaustion.
- **Refused OAuth and shell providers**: Interactive OAuth/CLI providers (`github-copilot`, `gemini`, `google`, `gemini-cli`, `google-gemini-cli`, `google-antigravity`, `claude-code`, `openai-codex`), `oauth` blocks, literal `apiKey` secrets, and `!command` resolvers fail closed with `PROVIDER_OAUTH_UNSUPPORTED`.

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
| `models[].cost` | No | Object (`input`, `output`, optional `cacheRead`, `cacheWrite`) | USD per million tokens; each rate is `0..1000`; `input` and `output` are required |
| `models[].thinkingLevelMap` | No | Map of level to wire effort or `null` | Custom Pi `thinkingLevelMap` (`null` marks a level unsupported) |
| `models[].samplingParams` | No | `{ temperature, top_p, top_k, min_p, presence_penalty, repetition_penalty }` | Default Pi sampling parameters forwarded on outbound model requests |
| `models[].samplingParamsByThinkingLevel` | No | Map of thinking level to `samplingParams` | Per-thinking-level sampling parameter overrides |
| `models[].compat` | No | Object (`thinkingFormat`, `maxTokensField`, `zaiToolStream`, booleans) | OpenAI-compatible dialect flags matching Pi `models.json` `compat` |

Provider-reported cost retains `reported` provenance; when absent and pricing is positive, Loopwright estimates cost from tokens (otherwise `unknown`).

## MCP and limits

`spec.mcp.servers` connects `stdio` and Streamable `http` MCP servers on the host and exposes tools as `mcp__<id>__<tool>`. OAuth MCP declarations fail closed (`MCP_OAUTH_UNSUPPORTED`).

### MCP server fields

| Field path | Required | Type and bounds | Meaning |
| --- | --- | --- | --- |
| `mcp.servers` | No | Object list (`0..16` items) | Host MCP servers (`id`: `1..24` chars, never `workspace`) |
| `servers[].transport` | Conditional | `'stdio'` \| `'http'` | **Required** per server; selects local process or Streamable HTTP |
| `servers[].command` / `args` | Conditional | Executable / string list (`0..64`) | `stdio` binary resolved on trusted host `PATH` and fixed CLI arguments |
| `servers[].env` / `envFrom` | No | String maps (`<= 32` entries) | Non-secret `stdio` env values and host secret env bindings (scrubbed automatically) |
| `servers[].url` | Conditional | `https://` URL | **Required** for `http` servers (loopback `http://` requires custom base URL opt-in) |
| `servers[].headersFrom` / `bearerTokenEnv` | No | Header map / env name | Host secret env bindings for HTTP headers or `Authorization: Bearer` |
| `servers[].includeTools` / `timeoutSeconds` | No | Tool list (`1..64`) / `1..600` | Optional upstream tool allowlist and per-call timeout in seconds (default `60`) |

### Execution limits

Explicit Action `with:` inputs override `spec.limits`, and `spec.limits` overrides `LOOPWRIGHT_*` environment variables before compiler defaults apply; unknown alias keys fail closed with `TASKPACK_MANIFEST_INVALID`.

| Field | Environment variable | Default and bounds | Meaning |
| --- | --- | --- | --- |
| `limits.wallTimeSeconds` | `LOOPWRIGHT_WALL_TIME_SECONDS` | `3600` (`60..21600`) | Run wall-clock ceiling in seconds (Action input `wall-time-seconds`) |
| `limits.totalTokens` | `LOOPWRIGHT_TOTAL_TOKENS` | `20000000` (`1000..1000000000`) | Aggregate input and output token ceiling across calls (Action input `total-tokens`) |
| `limits.contextWindow` | `LOOPWRIGHT_CONTEXT_WINDOW` | Catalog or `128000` (`1024..10000000`) | Model context window token ceiling (Action input `context-window`) |
| `limits.maxOutputTokens` | `LOOPWRIGHT_MAX_OUTPUT_TOKENS` | `32768` (`256..262144`) | Per-call output token ceiling clamped to model and window caps (Action input `max-output-tokens`) |
| `limits.maxModelCalls` | `LOOPWRIGHT_MAX_MODEL_CALLS` | `256` (`1..1024`) | Maximum model calls per run within store capacity (Action input `max-model-calls`) |
| `limits.maxAttempts` | `LOOPWRIGHT_MAX_ATTEMPTS` | `5` (`1..16`) | Maximum controller attempts within 64-checkpoint cap (Action input `max-attempts`) |
| `limits.maxFormatRepairs` | `LOOPWRIGHT_MAX_FORMAT_REPAIRS` | `6` (`0..1024`) | Maximum model calls spent repairing malformed submission JSON |
| `limits.maxImplementationRepairs` | `LOOPWRIGHT_MAX_IMPLEMENTATION_REPAIRS` | `32` (`0..1024`) | Maximum model calls spent repairing failed verification checks |
| `limits.maxTransportRetries` | `LOOPWRIGHT_MAX_TRANSPORT_RETRIES` | `3` (`0..8`) | Maximum in-session retries on transient network or rate-limit errors |
| `limits.toolTimeoutSeconds` | `LOOPWRIGHT_TOOL_TIMEOUT_SECONDS` | `300` (`1..1800`) | Per-tool wall-clock timeout in seconds (Action input `tool-timeout-seconds`) |
| `limits.commandTimeoutSeconds` | `LOOPWRIGHT_COMMAND_TIMEOUT_SECONDS` | `30` (`1..3600`) | Fallback `command.v1` script timeout in seconds (Action input `command-timeout-seconds`) |
| `limits.workingWindowBytes` | `LOOPWRIGHT_WORKING_WINDOW_BYTES` | `8388608..16777216` (`131072..16777216`) | Retained session working window bytes (`min(16 MiB, max(8 MiB, contextWindow))`) |
| `limits.maxRequestBytes` | `LOOPWRIGHT_MAX_REQUEST_BYTES` | `8388608` (`65536..16777216`) | Single outbound model HTTP payload byte ceiling (`<= workingWindowBytes`) |
| `limits.promptBytes` | `LOOPWRIGHT_PROMPT_BYTES` | `262144` (`4096..1048576`) | Maximum UTF-8 role prompt byte size |
| `limits.responseBytes` | `LOOPWRIGHT_RESPONSE_BYTES` | `67108864` (`65536..67108864`) | Maximum single provider response stream byte size |
| `limits.toolArgsBytes` | `LOOPWRIGHT_TOOL_ARGS_BYTES` | `1048576` (`16384..4194304`) | Maximum serialized tool call arguments byte size |
| `limits.toolResultBytes` | `LOOPWRIGHT_TOOL_RESULT_BYTES` | `1048576` (`16384..4194304`) | Maximum serialized tool result byte size |
| `limits.fileBytes` | `LOOPWRIGHT_FILE_BYTES` | `33554432` (`65536..67108864`) | Maximum candidate file byte size read or written by workspace tools |
| `limits.sessionBytes` | `LOOPWRIGHT_SESSION_BYTES` | `33554432` (`524288..67108864`) | Maximum cumulative isolated Pi session transcript byte size |
| `limits.candidateEntries` | `LOOPWRIGHT_CANDIDATE_ENTRIES` | `4096` (`16..4096`) | Maximum tracked candidate workspace entries |

## Upstreams and proposal

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

| Field path | Required | Type and bounds | Meaning |
| --- | --- | --- | --- |
| `verification.localChecks` | Yes | Object list (`0..32` items) | In-host verifiers (`candidate` mode requires `>= 1` local or required gate check) |
| `localChecks[].id` | Yes | Identifier (`1..64` chars) | Unique check ID (cannot use reserved `scope`, `no-change`, `taskpack-author`, `taskpack-no-change`) |
| `localChecks[].implementation` | Yes | Enum (see table below) | Built-in verifier bound by compiler to its installed SHA-256 digest |
| `localChecks[].parameters` | Conditional | Object | Scalar expectations for built-in checks; `command.v1` requires its own parameters below |
| `verification.externalGates` | Yes | Object list (`0..32` items) | Remote authenticated `gate.v1` checks (pass `[]` when unused) |
| `externalGates[].id` | Conditional | Identifier (`1..64` chars) | **Required** per gate item; unique check ID recorded in acceptance evidence |
| `externalGates[].gateId` | Conditional | Identifier (`1..64` chars) | **Required** per gate item; remote gate policy identifier |
| `externalGates[].endpointId` | Conditional | Identifier (`1..64` chars) | **Required** per gate item; matches a host `HostGateEndpointPlan.id` |
| `externalGates[].required` | Conditional | Boolean | **Required** per gate item; marks gate receipt mandatory for candidate acceptance |

### Local implementations

| Implementation | Compiler parameters | Verification check |
| --- | --- | --- |
| `json-artifact.v1` | Binds `proposal.path`, `requiredFields`, and `schema_version` | Parses structured candidate artifact and checks required keys and scalars |
| `scope.v1` | Binds `checkId` (compiler also runs implicit `scope` guard) | Verifies modified and deleted paths stay inside `writable` and outside `protected` |
| `no-change.v1` | Binds `checkId` (used automatically in `no-change` mode) | Confirms candidate tree equals base tree when settling as `no_change` |
| `command.v1` | Pins script SHA-256 and compiles an authenticated local `gate.v1` | Runs a protected script against a retained candidate copy |

### Command parameters

| Parameter | Required | Type and bounds | Meaning |
| --- | --- | --- | --- |
| `script` | Yes | Relative file path, `<= 262144` bytes | Protected regular script with no symlink ancestors; SHA-256 is checked again before execution |
| `timeoutSeconds` | No | Integer (`1..3600`, default `30`) | Maximum script execution time |
| `allowReadOnlyGitHubToken` | No | Boolean (default `false`) | Passes the resolved GitHub token when available; the flag does not reduce its permissions |
| `env` | No | List (`0..16` names) | Safe uppercase host environment variable names to pass to the script |

The script runs with a minimal environment and `LOOPWRIGHT_CANDIDATE_DIR` pointing to a temporary candidate copy (`0` approves; nonzero denies with scrubbed diagnostics). `env` rejects `LOOPWRIGHT_*`, `INPUT_*`, `GITHUB_APP_*`, `ACTIONS_*`, `LD_*`, `DYLD_*`, `GIT_*`, `GH_TOKEN`, `GITHUB_TOKEN`, `BASH_ENV`, `ENV`, and `NODE_OPTIONS`.

## Publication and memory

| Field path | Required | Type and bounds | Meaning |
| --- | --- | --- | --- |
| `publication.mode` | Yes | `'pull_request'` or `'disabled'` | Opens/updates a managed pull request or skips remote branch writes |
| `publication.targetBranch` | Yes | Branch name (`1..128` chars) | Base branch targeted by generated pull requests (required even when `disabled`) |
| `publication.headBranchPrefix` | Yes | Prefix (`1..64` chars, no `//`) | Branch prefix for head-pinned PRs (for example `loopwright-catalog-sync-`) |
| `publication.titleTemplate` | Yes | String (`1..256` chars) | Pull request title string |
| `memory.directory` | Yes | `<controlRoot>/memory` or descendant | Storage directory for reviewed CAS memory, protected even inside a writable ancestor |
| `memory.apply` | Yes | `'separate-pull-request'`, `'local-only'`, `'disabled'` | Proposes memory updates in a separate PR, applies locally, or disables memory |
| `memory.onNoModelBudget` | Conditional | `'deterministic-observations-only'` or `'skip'` | Records deterministic entries or skips emission; optional when `apply` is `'disabled'` |
| `memory.ttlDays` | No | Integer (`1..365`, default `15`) | Entry retention window in days before eager retirement |
| `memory.maxEntries` | No | Integer (`1..512`, default `128`) | Maximum active entries retained per taskpack store |
| `memory.maxPromptEntries` | No | Integer (`1..128`, default `32`) | Maximum prioritized active entries injected into role prompts |
| `memory.checkCodeFingerprint` | No | Boolean (default `false`) | Enables `scope.writable` hash checks for memory validity |
| `memory.checkUpstreamVersions` | No | Boolean (default `false`) | Enables upstream version checks for memory validity |
| `memory.publishOnFailure` | No | Boolean (default `false`) | Publishes separate memory PRs on failed or incident runs when `true` |
| `memory.skipCi` | No | Boolean (default `true`) | Adds `[skip ci]` to memory commit bodies before DCO trailers |

- **Direct deletion**: Retiring or evicting an entry deletes `entries/<id>.md` on disk and clears `index.retired`.
- **Loose defaults**: Memory skips `codeFingerprint` and `upstreamVersions` invalidation unless you opt in with `true`.
- **Quiet PR defaults**: Separate memory PRs skip failed runs and add `[skip ci]` before the DCO trailer.
- **Stateless taskpacks**: Set `apply: disabled` for stateless workflows or taskpacks driven by `spec.decisions`.
- **Non-blocking isolation**: Memory reads, warnings, CAS conflicts, and cleanup PRs never block task completion.

### Memory apply modes

| Mode | Behavior | Typical use |
| --- | --- | --- |
| `separate-pull-request` | Opens or updates a separate memory branch and PR | Default for reviewed repository memory |
| `local-only` | Updates `<memoryDirectory>` locally without remote branch writes | Local loops or read-only remotes |
| `disabled` | Skips memory loading, prompt injection, and finalization | Stateless or `spec.decisions`-driven taskpacks |

## Triggers and policies

| Field path | Required | Type and bounds | Meaning |
| --- | --- | --- | --- |
| `triggers.schedule` | Yes | Boolean | Permits scheduled cron triggers |
| `triggers.workflowDispatch` | Yes | Boolean | Permits manual `workflow_dispatch` triggers |
| `triggers.releasePublished` | Yes | Boolean | Permits GitHub `release` event triggers |
| `triggers.commentCommands` | Yes | Command list (`0..3` items) | Authorized slash commands (`retry`, `revise`, `status`; pass `[]` to disable) |
| `triggers.commentPrefixes` | No | String list (`1..8` items) | Command prefix tokens; defaults to `['/loopwright']` |
| `spec.sandbox` | No | Object (unset by default) | Host sandbox isolation requirements; see [Sandbox Backends](sandbox-backends.md) |
| `spec.decisions` | No | Object (unset by default) | Advisory System-One triage thresholds; see [Decision Routing](decision-routing.md) |

### Comment commands

| Command | Invocation example | Intake behavior |
| --- | --- | --- |
| `retry` | `/loopwright retry` | Re-runs bounded upstream discovery and candidate execution |
| `revise` | `/loopwright revise` | Passes bounded reviewer guidance (`<= 40` lines, `<= 2048` bytes) into next attempt |
| `status` | `/loopwright status` | Reports active queue lease, run status, or last receipt summary |

A bare prefix on the first line followed by non-empty guidance on later lines also invokes `revise` when `revise` is enabled.

### Output formats

`spec.output` accepts a format string, a list, or an object with a `formats` list (`json` by default; Action `output` overrides it, and CLI uses `--output-format`).

| Format | Destination | Content |
| --- | --- | --- |
| `json` | Action stdout or CLI | Machine-readable JSON |
| `github-step-summary` | Summary file when available | Markdown run summary |
| `markdown` | Action stderr or CLI stdout | Markdown run summary |
| `text` | Action stderr or CLI stdout | Plain-text run summary |

Summaries include status, connected MCP servers, checks, `K`/`M`/`B` token counts, `ms`/`s`/`m`/`h` durations, publication URL, and reported or estimated USD cost (`unknown` cost is omitted).

---

**See also** — [Declarative Taskpack](../walkthroughs/declarative-taskpack.md) (step-by-step setup and bootstrap prompt) · [Sandbox Backends](sandbox-backends.md) (`spec.sandbox` capabilities and backends)

**Next** → [Task Contract](task-contract.md) — inspect the underlying `TaskContract` schema used in Managed Controller mode.
