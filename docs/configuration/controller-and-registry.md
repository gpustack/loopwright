# Controller and Registry

In Managed Controller mode, `TrustedRegistry` (`registry.yaml`) and `ControllerConfig` (`controller.yaml`) separate **operator-approved execution authority** from **task requests** (see [Configuration relationships](../walkthroughs/managed-controller.md#configuration-relationships)). Store `registry.yaml` outside any writable repository, pin exact handler and runtime SHA-256 digests, and lock it inside `controller.yaml` by `name` and `--registry-sha256`.

## Contents

- [TrustedRegistry](#trustedregistry)
- [ControllerConfig](#controllerconfig)
- [Handlers and profiles](#handlers-and-profiles)
- [Context and MCP bounds](#context-and-mcp-bounds)
- [Credentials and endpoints](#credentials-and-endpoints)
- [Controller controls](#controller-controls)
- [Recovery](#recovery)

## TrustedRegistry

Store `registry.yaml` outside `cwd`, outside `dirname(controller.yaml)`, and outside `--repo` (`REGISTRY_UNTRUSTED` otherwise):

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
        prompt: Update packages/app/manifest.json.
        purpose: task
      capabilities:
        - pi
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
        required:
          - schema_version
        equals:
          schema_version: 1
      capabilities:
        - inert_bytes
        - read_only
  roleProfiles:
    - id: builder-profile
      selection:
        provider: zai
        model: glm-5.3
        thinking: high
        api: openai-completions
      tools:
        - read
        - write
        - edit
        - mcp__workspace__read_file
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
      mcp: # Optional MCP binding (local script or remote sessionless HTTP)
        serverId: workspace
        transport: sessionless-http-json-v1
        destinationRef: workspace-mirror
        endpoint: https://mcp.internal.example/mcp
        approvedAddresses:
          - 10.20.30.40
        credentialRef: mcp-token
        names:
          - mcp__workspace__read_file
        effects:
          - read_only
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
      environmentNames:
        - ZAI_API_KEY
      template: "${ZAI_API_KEY}"
    - id: mcp-token
      consumer: mcp
      destinationRef: workspace-mirror
      environmentNames:
        - LOOPWRIGHT_MCP_TOKEN
      template: "${LOOPWRIGHT_MCP_TOKEN}"
    - id: gate-hmac
      consumer: gate
      destinationRef: ci-gate-signing
      environmentNames:
        - LOOPWRIGHT_GATE_SIGNING_SECRET
      template: "${LOOPWRIGHT_GATE_SIGNING_SECRET}"
  environmentBindings:
    - name: ZAI_API_KEY
      classification: credential
      paths:
        - /spec/credentials/0/template
    - name: LOOPWRIGHT_MCP_TOKEN
      classification: credential
      paths:
        - /spec/credentials/1/template
    - name: UPSTREAM_TAG
      classification: nonsecret
      paths:
        - /spec/task/spec/target/sourceRevision
  gateEndpoints: # Optional external gate endpoints (0..16)
    - id: ci-gate-endpoint
      url: "https://gates.internal.example/verify"
      signingCredentialRef: gate-hmac
      authCredentialRef: null
      timeoutMs: 15000
      maxPollMs: 120000
      pollInitialMs: 500
      pollMaxMs: 5000
      jitter: 200
  publicationEndpoints: [] # Optional PR publication endpoints (0..16)
```

## ControllerConfig

`ControllerConfig` (`controller.yaml`) embeds a [Task Contract](task-contract.md) and pins `registry.name` plus the SHA-256 of `registry.yaml`:

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
      # Complete TaskContract fields; see Task Contract.
      goal: Update packages/app/manifest.json and pass checks.
      taskpack: app-manifest
      target:
        repository: acme/example-app
        baseRevision: 67a4938
        sourceRevision: "${UPSTREAM_TAG}"
        matrix: null
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
          dependsOn:
            - author-change
      acceptance:
        required:
          - manifest-json
        checks:
          - id: manifest-json
            allowedEvidenceLevels:
              - local_execution
  profiles:
    roles:
      - roleId: builder
        profileRef: builder-profile
    steps:
      - stepId: author-change
        handlerRef: pi-author
      - stepId: verify-manifest
        handlerRef: check-manifest-json
  credentials:
    - ref: zai-token
      template: "${ZAI_API_KEY}"
    - ref: mcp-token
      template: "${LOOPWRIGHT_MCP_TOKEN}"
  controls:
    drainReserveMs: 120000
    maxAttempts: 4
    repeatFailureLimit: 2
    submission:
      mode: artifact_or_assistant
      path: null
  publication: # Optional (defaults to disabled)
    mode: disabled
```

## Handlers and profiles

### Handler implementations

Each `handlers[]` entry pins `id`, `version: 1`, `digest` (from `installedHandlerDigests()`), `kind`, `implementation`, `parameters`, and exact `capabilities`:

| Implementation | `kind` | Required `capabilities` |
| --- | --- | --- |
| `pi.agent.v1` / `pi.compact.v1` | `agent` | `['pi']` / `['pi', 'compaction']` |
| `scope.v1` / `no-change.v1` | `check` | `['inert_bytes', 'read_only']` |
| `json-artifact.v1` / `json-keys-guard.v1` / `line-section-guard.v1` | `check` | `['inert_bytes', 'read_only']` |
| `gate.v1` / `benchmark-gate.v1` | `check` | `['external_service', 'read_only']` / `['hardware_execution', 'read_only']` |

### Role and runtime profiles

- **Adapter choice**: `roleProfiles[]` accepts `adapter: pi` (with `runtimeRef` and `mcp`) or `adapter: delegated` (`runtimeRef: null`, `mcp: null`). Unattended `run`/`resume` refuse delegated roles (`CAPABILITY_UNSUPPORTED`).
- **Model selection**: Configure `selection` (see [Model configuration](taskpack.md#model-configuration)); CLI `--role-model` overrides take precedence and persist in `run.json`.
- **Runtime identity**: `runtimeProfiles[]` locks `dockerExecutable`, `dockerSocket`, `sdkIntegrity`, `graphDigest`, `imageDigest`, `configDigest`, and `profile` via `describePiAdapterFiles()`.

## Context and MCP bounds

- **Context guard (`roleProfiles[].context`)**: Enforces `proven_bound` or `estimated_guard` (`lw-pi-final-json-bytes-v1`), capping window bytes (`<= 16 MiB`), margins, and output tokens (`<= 262144`).
- **MCP modes (`serverId: 'workspace'`)**: Local mode pins `scriptDigest`; remote HTTP mode (`sessionless-http-json-v1`) pins `1..4` `approvedAddresses` IPs to prevent DNS rebinding.

## Credentials and endpoints

Secrets resolve exclusively in memory into a `CredentialVault` (`vault.assertClean` aborts if raw secret bytes ever serialize). `${NAME}` expands in a single pass (`<= 16 KiB`) before `TaskContract` validation:

- **Escape & safety**: Use `$$` for a literal `$`. Shell `$(...)`, `!command`, and `${NAME:-default}` fail closed (`CONFIG_ENV_SYNTAX`).
- **JSON Pointer allowlist**: Every `${NAME}` must match `environmentBindings[]` at that exact pointer (`CONFIG_ENV_DENIED` / `CONFIG_ENV_MISSING`): `credential` only under `/spec/credentials/<n>/template`, `nonsecret` under task fields.
- **Scoped endpoints**: `gateEndpoints[]` (`consumer: gate`) and `publicationEndpoints[]` (`consumer: publisher`) require `https://` or loopback URLs with HMAC `signingCredentialRef` and optional bearer `authCredentialRef`.

## Controller controls

| Control field | Bounds | Meaning |
| --- | --- | --- |
| `controls.drainReserveMs` | `5000..600000` ms (`< wallTimeMs`) | Drain window reserved before wall-clock timeout |
| `controls.maxAttempts` | `1..64` | Total execution and repair attempts allowed |
| `controls.repeatFailureLimit` | `2` | Halts repair loops on identical repeated failure signature |
| `controls.submission` | `artifact_or_assistant`, `path \| null` | Candidate output source rule |
| `spec.publication` | `disabled` (default) or `pull_request` | PR mode requires `endpointRef`, `targetBranch`, `headBranchPrefix`, `titleTemplate` |

## Recovery

### Gates and reconciliation

Run `loopwright check` or `loopwright run --dry-run` before execution. When an external gate or pull request call settles `unknown`, never replay blindly; settle with `loopwright reconcile` and an authenticated receipt.

- **Hardware binding**: `hardware_execution` checks must bind `benchmark-gate.v1` with a hardware `targetCellId` (`CAPABILITY_UNSUPPORTED` or `CONFIG_SCHEMA` otherwise).
- **CAS staging & preemption**: Controller stages blobs to the relay, pulls `.loopwright-verifier/<slotId>/*` (`O_NOFOLLOW`, `0o400`), and settles exhausted preemption as `blocked` (`BENCHMARK_PREEMPTED`).

---

**See also** — [Managed Controller](../walkthroughs/managed-controller.md) (relationship diagram, setup, and digest commands) · [Task Contract](task-contract.md) (`TaskContract` fields and budget rules)

**Next** → [CLI](../operations/cli.md) — run `check`, `run`, `inspect`, and `reconcile` with your controller files.
