# Controller and Registry

In Managed Controller mode, `TrustedRegistry` (`registry.yaml`) and `ControllerConfig` (`controller.yaml`) separate **operator-approved execution authority** from **task requests** (see [Configuration relationships](../walkthroughs/managed-controller.md#configuration-relationships)). The operator stores `registry.yaml` (`metadata.name`) outside any writable repository, pins exact handler and runtime SHA-256 digests, and locks `registry.yaml` inside `controller.yaml` by `name` and SHA-256 (`--registry-sha256`).

## Contents

- [TrustedRegistry](#trustedregistry)
- [ControllerConfig](#controllerconfig)
- [Handlers and profiles](#handlers-and-profiles)
- [Context and MCP bounds](#context-and-mcp-bounds)
- [Credentials and endpoints](#credentials-and-endpoints)
- [Controller controls](#controller-controls)
- [Recovery](#recovery)

## TrustedRegistry

Store `registry.yaml` in an operator-owned directory outside `cwd`, outside `dirname(controller.yaml)`, and outside `--repo` (otherwise `loadTrustedConfiguration` refuses with `REGISTRY_UNTRUSTED`):

```yaml
apiVersion: loopwright.dev/v1alpha1
kind: TrustedRegistry
metadata:
  name: prod-operator-registry
spec:
  version: 1
  resourceVersion: rev-2026-11
  handlers:
    - id: pi-author
      version: 1
      kind: agent
      implementation: pi.agent.v1
      digest:
        algorithm: sha256
        hex: <hash>
      parameters:
        prompt: Update packages/app/manifest.json and satisfy required schema keys.
        purpose: task
      capabilities: [pi]
    - id: check-manifest-json
      version: 1
      kind: check
      implementation: json-artifact.v1
      digest:
        algorithm: sha256
        hex: <hash>
      parameters:
        checkId: manifest-json
        path: packages/app/manifest.json
        required: [schema_version]
        equals: # Optional exact scalar equality checks
          schema_version: 1
      capabilities: [inert_bytes, read_only]
    - id: check-ci-gate
      version: 1
      kind: check
      implementation: gate.v1
      digest:
        algorithm: sha256
        hex: <hash>
      parameters:
        checkId: ci-gate
        endpointRef: ci-gate-endpoint
        gateId: smoke-suite
      capabilities: [external_service, read_only]
  roleProfiles:
    - id: builder-profile
      selection:
        provider: zai
        model: glm-5.3
        thinking: high
        api: openai-completions
      tools: [read, write, edit, mcp__workspace__read_file]
      context:
        mode: proven_bound
        estimator: lw-pi-final-json-bytes-v1
        proofId: null
        version: 1
        evidence: estimated
        workingWindowCeiling: 98304
        maxRequestBytes: 65536
        serviceMargin: 32768
        toolReserve: 16384
        maxOutputTokens: 1024
      runtimeRef: default-runtime
      providerCredentialRef: zai-token
      mcp: # Optional MCP server binding
        serverId: workspace
        transport: sessionless-http-json-v1
        destinationRef: workspace-mirror
        endpoint: https://mcp.internal.example/mcp
        approvedAddresses: [10.20.30.40]
        credentialRef: mcp-token
        names: [mcp__workspace__read_file]
        effects: [read_only]
        idleTimeoutSeconds: 2
        absoluteTimeoutSeconds: 10
  resources:
    - id: release-guide
      kind: instruction
      path: context/release-guide.md
      digest:
        algorithm: sha256
        hex: <hash>
  runtimeProfiles:
    - id: default-runtime
      dockerExecutable: /usr/local/bin/docker
      dockerSocket: /var/run/docker.sock
      identity:
        sdkIntegrity: pi-sdk-v1
        graphDigest:
          algorithm: sha256
          hex: <hash>
        imageDigest: sha256:<hash>
        configDigest:
          algorithm: sha256
          hex: <hash>
        profile: linux/arm64
  credentialBindings:
    - id: zai-token
      consumer: provider
      destinationRef: zai
      environmentNames: [ZAI_API_KEY]
      template: ${ZAI_API_KEY}
    - id: mcp-token
      consumer: mcp
      destinationRef: workspace-mirror
      environmentNames: [LOOPWRIGHT_MCP_TOKEN]
      template: ${LOOPWRIGHT_MCP_TOKEN}
    - id: gate-hmac
      consumer: gate
      destinationRef: ci-gate-signing
      environmentNames: [LOOPWRIGHT_GATE_SIGNING_SECRET]
      template: ${LOOPWRIGHT_GATE_SIGNING_SECRET}
    - id: pub-hmac
      consumer: publisher
      destinationRef: github-pr-publisher
      environmentNames: [LOOPWRIGHT_PUBLICATION_SIGNING_SECRET]
      template: ${LOOPWRIGHT_PUBLICATION_SIGNING_SECRET}
  environmentBindings:
    - name: ZAI_API_KEY
      classification: credential
      paths: [/spec/credentials/0/template]
    - name: LOOPWRIGHT_MCP_TOKEN
      classification: credential
      paths: [/spec/credentials/1/template]
    - name: LOOPWRIGHT_GATE_SIGNING_SECRET
      classification: credential
      paths: [/spec/credentials/2/template]
    - name: LOOPWRIGHT_PUBLICATION_SIGNING_SECRET
      classification: credential
      paths: [/spec/credentials/3/template]
    - name: UPSTREAM_TAG
      classification: nonsecret
      paths: [/spec/task/spec/target/sourceRevision]
  gateEndpoints: # Optional external gate endpoints
    - id: ci-gate-endpoint
      url: https://gates.internal.example/verify
      signingCredentialRef: gate-hmac
      authCredentialRef: null # Optional Bearer credential ref
      timeoutMs: 15000
      maxPollMs: 120000
      pollInitialMs: 500
      pollMaxMs: 5000
      jitter: 200
  publicationEndpoints: # Optional PR publication endpoints
    - id: pr-publisher
      url: https://publish.internal.example/pull-requests
      signingCredentialRef: pub-hmac
      authCredentialRef: null # Optional Bearer credential ref
      timeoutMs: 30000
```

## ControllerConfig

`ControllerConfig` (`controller.yaml`) embeds a [Task Contract](task-contract.md) and binds `registry.name` plus the exact SHA-256 of `registry.yaml`:

```yaml
apiVersion: loopwright.dev/v1alpha1
kind: ControllerConfig
spec:
  registry:
    name: prod-operator-registry
    digest:
      algorithm: sha256
      hex: <hash>
  task:
    apiVersion: loopwright.dev/v1alpha1
    kind: TaskContract
    spec:
      goal: Update packages/app/manifest.json and pass checks.
      taskpack: app-manifest
      target:
        repository: acme/example-app
        baseRevision: 67a4938
        sourceRevision: ${UPSTREAM_TAG}
        matrix: null
      scope:
        writable: ["packages/app/**"]
        protected: ["packages/app/policy/**"]
      roles:
        - id: builder
          adapter: pi
          provider: zai
          model: glm-5.3
          thinking: high
          tools: [read, write, edit, mcp__workspace__read_file]
      trustedContext:
        revision: rev-2026-11
        discovery: disabled
        resources: []
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
          roleId: null
          dependsOn: [author-change]
      acceptance:
        required: [manifest-json]
        checks:
          - id: manifest-json
            allowedEvidenceLevels: [local_execution]
  profiles:
    roles:
      - { roleId: builder, profileRef: builder-profile }
    steps:
      - { stepId: author-change, handlerRef: pi-author }
      - { stepId: verify-manifest, handlerRef: check-manifest-json }
  credentials:
    - { ref: zai-token, template: "${ZAI_API_KEY}" }
    - { ref: mcp-token, template: "${LOOPWRIGHT_MCP_TOKEN}" }
    - { ref: gate-hmac, template: "${LOOPWRIGHT_GATE_SIGNING_SECRET}" }
    - { ref: pub-hmac, template: "${LOOPWRIGHT_PUBLICATION_SIGNING_SECRET}" }
  controls:
    drainReserveMs: 120000
    maxAttempts: 4
    repeatFailureLimit: 2
    submission:
      mode: artifact_or_assistant
      path: null # Optional relative candidate artifact path
  publication: # Optional publication block (defaults to disabled)
    mode: pull_request
    endpointRef: pr-publisher
    targetBranch: main
    headBranchPrefix: loopwright/app-
    titleTemplate: "chore(app) - update release manifest"
```

## Handlers and profiles

### Handler implementations

Each `TrustedRegistry.spec.handlers[]` entry pins `id`, `version: 1`, `digest` (installed file SHA-256 from `installedHandlerDigests()`), `kind`, `implementation`, `parameters`, and exact `capabilities`:

| Implementation | `kind` | Required `capabilities` | Required `parameters` keys |
| --- | --- | --- | --- |
| `pi.agent.v1` | `agent` | `['pi']` | `prompt` (string), `purpose` (`'task'` or `'review'`) |
| `pi.compact.v1` | `agent` | `['pi', 'compaction']` | `{}` (empty mapping; compacts session context) |
| `scope.v1` | `check` | `['inert_bytes', 'read_only']` | `checkId` (identifier or `null` for implicit guard) |
| `json-artifact.v1` | `check` | `['inert_bytes', 'read_only']` | `checkId`, `path`, `required` (key list), `equals` (scalar map) |
| `no-change.v1` | `check` | `['inert_bytes', 'read_only']` | `checkId` (identifier or `null` for implicit comparison) |
| `gate.v1` | `check` | `['external_service', 'read_only']` | `checkId`, `endpointRef` (`gateEndpoints[].id`), `gateId` |

### Role and runtime profiles

Top-level `TrustedRegistry` requires `metadata.name` (`1..64` chars) and `spec` (`version: 1`, `resourceVersion`, `handlers`, `roleProfiles`, `resources`, `runtimeProfiles`, `credentialBindings`, `environmentBindings`; `gateEndpoints` and `publicationEndpoints` are optional keys):

| Field path | Required | Values and bounds | Meaning |
| --- | --- | --- | --- |
| `roleProfiles[].id` | Yes | Identifier (`1..64` chars) | Unique role profile ID referenced by `ControllerConfig` |
| `roleProfiles[].selection` | Yes | `{ provider, model, thinking, api, customProvider? }` (`off..max`; `anthropic-messages`, `openai-completions`, `openai-responses`) | Token-based Pi model or custom compatible endpoint; see [Model configuration](taskpack.md#model-configuration) |
| `roleProfiles[].tools` | Yes | Subset of `read`, `write`, `edit`, `bash`, `codemode`, `mcp__workspace__read_file` | Host-approved tool ceiling for bound task roles |
| `roleProfiles[].runtimeRef` | Yes | `runtimeProfiles[].id` | Binds the role to a verified runtime identity |
| `roleProfiles[].providerCredentialRef` | Yes (`null` allowed) | `credentialBindings[].id` or `null` | Selects the `provider` credential injected into the broker |
| `runtimeProfiles[].id` | Yes | Identifier (`1..64` chars) | Unique runtime profile ID |
| `runtimeProfiles[].dockerExecutable` | Yes | Absolute path (for example `/usr/local/bin/docker`) | Verified container runtime binary path |
| `runtimeProfiles[].dockerSocket` | Yes | Absolute path (for example `/var/run/docker.sock`) | Container runtime UNIX socket path |
| `runtimeProfiles[].identity` | Yes | `sdkIntegrity`, `graphDigest` (`package-lock.json` SHA-256), `imageDigest` (`sha256:...`), `configDigest`, `profile: 'linux/arm64'` | Cryptographic runtime lock from `describePiAdapterFiles()` |

## Context and MCP bounds

### Context window fields

`roleProfiles[].context` prevents oversized prompts from truncating safety instructions or blowing provider windows:

| Field path | Required | Values and bounds | Meaning |
| --- | --- | --- | --- |
| `context.mode` | No | `'proven_bound'` (default) or `'estimated_guard'` | Strict pre-send byte proof vs. estimated window guard |
| `context.estimator` | Yes | `'lw-pi-final-json-bytes-v1'` | Deterministic JSON request byte estimator |
| `context.proofId` / `version` / `evidence` | Yes | `proofId: null`, `version: 1`, `evidence: 'estimated'` | Estimator protocol metadata required by Pi adapter |
| `context.workingWindowCeiling` | Yes | Integer `1 .. 98304` bytes | Maximum retained conversation window bytes before compaction |
| `context.maxRequestBytes` | Yes | Integer `1 .. 65536` bytes | Maximum single outbound provider HTTP payload size |
| `context.serviceMargin` | Yes | Integer `>= 32768` bytes | Safety buffer reserved for provider system framing |
| `context.toolReserve` | Yes | Integer `>= 16384` bytes | Window space reserved for tool call results |
| `context.maxOutputTokens` | Yes | Integer `1 .. 1024` tokens | Per-call output token ceiling enforced by the adapter |

### MCP configuration

`roleProfiles[].mcp` (`serverId: 'workspace'`) is **required** on every `roleProfiles[]` entry and supports two modes (`names: ['mcp__workspace__read_file']` and `effects: ['read_only']` when `mcp__workspace__read_file` is in `tools`, or `[]` when unused; `idleTimeoutSeconds: 1..2`, `absoluteTimeoutSeconds: idle..10`):

| MCP mode | Required keys | Security constraint |
| --- | --- | --- |
| Local script mode | `serverId`, `scriptDigest`, `names`, `effects`, `idleTimeoutSeconds`, `absoluteTimeoutSeconds` | Verifies local MCP helper against `localMcpScriptDigest` |
| Remote HTTP mode | Replaces `scriptDigest` with `transport: 'sessionless-http-json-v1'`, `destinationRef`, `endpoint`, `approvedAddresses`, `credentialRef` | Requires `https://<hostname>/mcp` (or `http://127.0.0.1:<port>/mcp`) and pinned IP addresses (`1..4` IPs) to block DNS rebinding |

## Credentials and endpoints

### Credential and env bindings

Secrets resolve only in memory into a `CredentialVault` (`$$` escapes a literal `$`), and `vault.assertClean` aborts if raw secret bytes ever appear in serialized config or state:

| Field path | Required | Values and bounds | Meaning |
| --- | --- | --- | --- |
| `credentialBindings[].id` | Yes | Identifier (`1..64` chars) | Unique credential ID referenced by profiles or endpoints |
| `credentialBindings[].consumer` | Yes | `'provider'` \| `'mcp'` \| `'gate'` \| `'publisher'` | Restricts which subsystem may receive the resolved secret |
| `credentialBindings[].destinationRef` | Yes | Identifier (`1..64` chars) | Target service identifier bound to the credential |
| `credentialBindings[].environmentNames` | Yes | Env var list (`[A-Za-z_][A-Za-z0-9_]*`) | Host environment variables permitted inside `template` |
| `credentialBindings[].template` | Yes | Template string (for example `${LOOPWRIGHT_PROVIDER_TOKEN}`) | Secret assembly pattern matched identically in `ControllerConfig.spec.credentials` |
| `environmentBindings[].name` | Yes | Env var name (`[A-Za-z_][A-Za-z0-9_]*`) | Approved host environment variable name |
| `environmentBindings[].classification` | Yes | `'credential'` or `'nonsecret'` | Marks whether resolved values are scrubbed as secrets |
| `environmentBindings[].paths` | Yes | JSON pointer list (`/spec/credentials/<n>/template` or `/spec/task/...`) | Exact `ControllerConfig` paths allowed to reference `name` |

### Environment interpolation

Loopwright expands `${NAME}` (`[A-Za-z_][A-Za-z0-9_]*`) inside `ControllerConfig` in a single pass (`<= 16 KiB` per string) before validating the embedded `TaskContract`:

- **Escape and non-execution**: Write `$$` for a literal `$` (`$${NAME}` stays `${NAME}`). Shell command substitution `$(...)`, `!command` resolvers, and `${NAME:-default}` fallbacks never execute (`CONFIG_ENV_SYNTAX`).
- **JSON Pointer allowlist**: Every `${NAME}` must match `TrustedRegistry.spec.environmentBindings[]` at that exact JSON Pointer (`CONFIG_ENV_DENIED` if unlisted, `CONFIG_ENV_MISSING` if unset): `credential` is restricted to `/spec/credentials/<n>/template`, whereas `nonsecret` injects non-credential values such as `/spec/task/spec/target/sourceRevision`.
- **Untrusted manifests**: In-repo `.loopwright/taskpack.yaml` (`kind: Taskpack`) rejects `${...}` (`TASKPACK_UNTRUSTED_INTERPOLATION`) and binds host variables by name via `spec.models[].apiKeyEnv`.

### Gate and publication endpoints

`spec.gateEndpoints` and `spec.publicationEndpoints` are optional top-level keys in `TrustedRegistry` (`0..16` items). When an item is declared, all keys below are required (`https://` or loopback `http://127.0.0.1:<port>` / `http://[::1]:<port>` with zero URL credentials, query strings, or `#` fragments):

| Field path | Required | Bounds | Meaning |
| --- | --- | --- | --- |
| `gateEndpoints` / `publicationEndpoints` | No | `0 .. 16` items (optional keys) | Omit when unused; required when `gate.v1` or `pull_request` publication is bound |
| `*.id` / `*.url` | Conditional | Identifier (`1..64`) / HTTPS URL | **Required** per endpoint item; unique ID and target service URL |
| `gateEndpoints[].signingCredentialRef` | Conditional | `credentialBindings[].id` (`consumer: gate`) | **Required** per gate item; HMAC key verifying `gate.v1` receipts |
| `gateEndpoints[].authCredentialRef` | Conditional | `credentialBindings[].id` or `null` | **Required** per gate item (`null` when no bearer header is used) |
| `gateEndpoints[].timeoutMs` / `maxPollMs` | Conditional | `1000 .. 60000` ms / `1000 .. 600000` ms | **Required** per gate item; per-request and total polling timeouts |
| `gateEndpoints[].pollInitialMs` / `pollMaxMs` | Conditional | `100 .. 30000` ms / `pollInitialMs .. maxPollMs` | **Required** per gate item; exponential backoff polling interval bounds |
| `gateEndpoints[].jitter` | Conditional | `0 .. 1000` ms | **Required** per gate item; random jitter added between gate polls |
| `publicationEndpoints[].signingCredentialRef` | Conditional | `credentialBindings[].id` (`consumer: publisher`) | **Required** per publication item; HMAC key verifying PR receipts |
| `publicationEndpoints[].authCredentialRef` | Conditional | `credentialBindings[].id` or `null` | **Required** per publication item (`null` when unused) |
| `publicationEndpoints[].timeoutMs` | Conditional | `1000 .. 60000` ms | **Required** per publication item; HTTP timeout for PR requests |

## Controller controls

| Field path | Required | Bounds and values | Meaning |
| --- | --- | --- | --- |
| `spec.task` | Yes | Complete `TaskContract` object | Embedded task contract bound into the run |
| `spec.registry.name` / `digest` | Yes | Registry `metadata.name` + 64-char SHA-256 | Must match `registry.yaml` bytes and `--registry-sha256` CLI flag |
| `spec.profiles.roles` | Yes | `{ roleId, profileRef }` (`0..16` items) | Connects each `TaskContract` role to a `TrustedRegistry` `RoleProfile` |
| `spec.profiles.steps` | Yes | `{ stepId, handlerRef }` (`0..16` items) | Connects each `TaskContract` step to a `TrustedRegistry` `Handler` |
| `spec.credentials` | Yes | `{ ref, template }` list (pass `[]` if none) | Declares credential templates interpolated from approved env vars |
| `controls.drainReserveMs` | Yes | `120000 .. 300000` ms (`< budgets.wallTimeMs`) | Time reserved before `wallTimeMs` to drain processes and persist state |
| `controls.maxAttempts` | Yes | `1 .. 16` | Total execution and repair attempts allowed across the cycle |
| `controls.repeatFailureLimit` | Yes | `2` | Stops repair loops when the exact same failure signature occurs twice |
| `controls.submission` | Yes | `mode: 'artifact_or_assistant'`, `path: null` or relative path | Accepts candidate output from a named workspace file or final assistant turn |
| `spec.publication` | No | Defaults to `{ mode: 'disabled' }`; or `{ mode: 'pull_request', endpointRef, targetBranch, headBranchPrefix, titleTemplate }` | Optional block; when `mode: 'pull_request'`, all four PR keys are required |

## Recovery

### Gates and reconciliation

Run `loopwright check` or `loopwright run --dry-run` before execution. When an external gate or pull request call terminates in an uncertain state (`unknown`), never replay the side effect blindly; verify the remote state and settle the run with `loopwright reconcile` and an authenticated receipt.

---

**See also** — [Managed Controller](../walkthroughs/managed-controller.md) (relationship diagram, setup, and digest commands) · [Task Contract](task-contract.md) (`TaskContract` fields and budget rules)

**Next** → [CLI](../operations/cli.md) — run `check`, `run`, `inspect`, and `reconcile` with your controller files.
