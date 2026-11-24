# Managed Controller

Managed controller mode is Loopwright's fine-grained governance workflow for platform engineers and local CLI operators. Author an out-of-repo `TrustedRegistry`, pin its SHA-256 digest inside `ControllerConfig` alongside a `TaskContract` DAG, and drive runs via the `loopwright` CLI.

For single-file repository automation where Loopwright compiles contracts and digests automatically, follow [Declarative Taskpack](declarative-taskpack.md) instead.

## Contents

- [Configuration relationships](#configuration-relationships)
- [Overview](#overview)
- [Prompt bootstrap](#prompt-bootstrap)
- [Step 1: Generate drafts](#step-1-generate-drafts)
- [Step 2: Pin registry](#step-2-pin-registry)
- [Step 3: Author controller](#step-3-author-controller)
- [Step 4: Execute run](#step-4-execute-run)
- [Step 5: Reconcile receipts](#step-5-reconcile-receipts)

## Configuration relationships

![Managed controller configuration relationships](../assets/diagrams/managed-controller-relations.svg)

<!-- flowchart TB
  Controller["ControllerConfig (controller.yaml)"] -> Task["Embedded TaskContract (spec.task)"]
  Controller -> Bridge["Binding Bridge (spec.registry, profiles, credentials)"]
  Bridge -> Registry["Out-of-repo TrustedRegistry (registry.yaml · metadata.name)"]
  Task -> Registry
-->

Managed controller mode coordinates an operator-owned authority store (`TrustedRegistry`) with a run configuration (`ControllerConfig` embedding `TaskContract`):

| Relationship | Source field | Target declaration | Runtime invariant |
| --- | --- | --- | --- |
| Containment | `ControllerConfig.spec.task` | Embedded `TaskContract` | JCS-hashed into run lock; zero credentials or handler digests |
| Registry hash lock | `spec.registry.{name,digest}` | `TrustedRegistry.metadata.name` + SHA-256 | Matches `--registry-sha256`; lives outside repo/config roots |
| Role binding | `spec.profiles.roles[]` | Bridges `TaskContract.roles[]` to `roleProfiles[]` | Enforces provider, context ceiling, tools, and `runtimeRef` |
| Step binding | `spec.profiles.steps[]` | Bridges `TaskContract.steps[]` to `handlers[]` | Verifies installed handler SHA-256 and `acceptance.checks[]` |
| Context pinning | `trustedContext.{revision,resources}` | `TrustedRegistry.{resourceVersion,resources[]}` | Matches context revision and read-only instruction SHA-256 |
| Secret & PR wiring | `spec.credentials[]` & `publication` | `credentialBindings[]`, `environmentBindings[]` | Resolves `${ENV}` in memory only; signs HMAC requests |

## Overview

![Managed controller lifecycle](../assets/diagrams/managed-controller-flow.svg)

<!-- flowchart LR
  Init["01 Init drafts"] -> Registry["02 Pin TrustedRegistry"] -> Config["03 Bind ControllerConfig"] -> Run["04 Check & run"] -> Reconcile["05 Inspect & settle"]
-->

## Prompt bootstrap

`loopwright init` writes generic `REVIEW_REQUIRED` placeholders. To assemble tailored `registry.yaml` and `controller.yaml` files interactively without looking up digests by hand, paste this prompt into your coding agent:

```text
Read https://docs.gpustack.ai/loopwright/llms.txt and its Bootstrap Interview Reference (https://docs.gpustack.ai/loopwright/references/bootstrap-interview.md). Inspect this repository first WITHOUT editing any files yet, then interview me one question at a time with repository-grounded defaults to align on writable/protected scope, budgets, verification checks, and role bindings. Wait for my approval on the design summary before computing local Loopwright handler and graph SHA-256 digests, writing out-of-repo registry.yaml and controller.yaml, and validating with loopwright check.
```

## Step 1: Generate drafts

Install `@gpustack/loopwright` (see [Installation](../getting-started/installation.md)) and initialize starter YAML files in real non-symlink directories **outside** the target repository:

```sh
mkdir -p "$HOME/loopwright-ops" "$HOME/loopwright-runs" "$HOME/loopwright-trust"
loopwright init --directory "$HOME/loopwright-ops"
cp "$HOME/loopwright-ops/registry.draft.yaml" "$HOME/loopwright-trust/registry.yaml"
cp "$HOME/loopwright-ops/controller.draft.yaml" "$HOME/loopwright-ops/controller.yaml"
```

Keep `registry.yaml` (`0600`) in `$HOME/loopwright-trust` outside `cwd`, outside `$HOME/loopwright-ops`, and outside any target repository (`REGISTRY_UNTRUSTED`).

## Step 2: Pin registry

Compute installed handler and runtime digests from your Loopwright installation so `registry.yaml` pins verified code bytes:

```sh
node --input-type=module -e "
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { installedHandlerDigests } from '@loopwright/controller';
import { describePiAdapterFiles } from '@loopwright/agent-pi';
const handlers = await installedHandlerDigests();
const pi = await describePiAdapterFiles();
const lock = readFileSync(fileURLToPath(new URL('../../../package-lock.json', import.meta.resolve('@loopwright/agent-pi'))));
console.log({ handlers, pi, graphSha256: createHash('sha256').update(lock).digest('hex') });
"
```

Populate `$HOME/loopwright-trust/registry.yaml` (see [Controller and Registry](../configuration/controller-and-registry.md) for every field in `roleProfiles`, `runtimeProfiles`, `mcp`, and endpoints):

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
      mcp:
        serverId: workspace
        scriptDigest:
          algorithm: sha256
          hex: <hash>
        names: []
        effects: []
        idleTimeoutSeconds: 2
        absoluteTimeoutSeconds: 10
  resources: []
  runtimeProfiles:
    - id: default-runtime
      dockerExecutable: /usr/local/bin/docker
      dockerSocket: /var/run/docker.sock
      identity:
        sdkIntegrity: <sdk-integrity>
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
  environmentBindings:
    - name: ZAI_API_KEY
      classification: credential
      paths:
        - /spec/credentials/0/template
```

Compute the SHA-256 digest of the finalized `registry.yaml`:

```sh
REGISTRY_SHA=$(shasum -a 256 "$HOME/loopwright-trust/registry.yaml" | awk '{print $1}')
```

## Step 3: Author controller

Edit `$HOME/loopwright-ops/controller.yaml` to embed your `TaskContract`, bind `registry.name` + `$REGISTRY_SHA`, and map roles and steps (see [Task Contract](../configuration/task-contract.md) for all contract fields):

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
      goal: Update packages/app/manifest.json release metadata and pass JSON validation.
      taskpack: app-manifest
      target:
        repository: acme/example-app
        baseRevision: main
        sourceRevision: v1.4.0
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
        wallTimeMs: 300000 # Must exceed controls.drainReserveMs (120000 ms).
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
  controls:
    drainReserveMs: 120000
    maxAttempts: 4
    repeatFailureLimit: 2
    submission:
      mode: artifact_or_assistant
      path: null
  publication:
    mode: disabled
```

## Step 4: Execute run

Compile statically first (`check` makes zero network or state calls), then launch the fenced run outside `$HOME/loopwright-trust`:

```sh
export ZAI_API_KEY="zai_example_token"
loopwright check --config "$HOME/loopwright-ops/controller.yaml" --registry "$HOME/loopwright-trust/registry.yaml" --registry-sha256 "$REGISTRY_SHA" --json
loopwright run --config "$HOME/loopwright-ops/controller.yaml" --registry "$HOME/loopwright-trust/registry.yaml" --registry-sha256 "$REGISTRY_SHA" --repo /path/to/example-app --run-root "$HOME/loopwright-runs" --run-id run-20261112-01 --json
```

### Delegated execution

For zero-secret delegated stepping, set `adapter: delegated` on the role profile (`runtimeRef: null`, `providerCredentialRef: null`, `mcp: null`) and task role (see [Controller and Registry](../configuration/controller-and-registry.md#role-and-runtime-profiles) and [CLI](../operations/cli.md#delegated-stepping)):

```sh
loopwright step next --config "$HOME/loopwright-ops/controller.yaml" --registry "$HOME/loopwright-trust/registry.yaml" --registry-sha256 "$REGISTRY_SHA" --repo /path/to/example-app --run-root "$HOME/loopwright-runs" --run-id delegated-1 --role-model builder=example/author-model:medium --json
loopwright step submit --run-root "$HOME/loopwright-runs" --run-id delegated-1 --lease TOKEN --status completed --json
```

## Step 5: Reconcile receipts

Inspect run state and export evidence bundles offline:

```sh
loopwright status --run-root "$HOME/loopwright-runs" --run-id run-20261112-01 --json
loopwright inspect --run-root "$HOME/loopwright-runs" --run-id run-20261112-01 --output "$HOME/loopwright-runs/bundle-01"
```

- **Resume after restart**: Run `loopwright resume` with the exact same config, registry, digest, repo, and run identity.
- **Reconcile unknown outcomes (exit `7`)**: Verify remote state and settle with `loopwright reconcile ... --receipt receipt.json` (see [CLI](../operations/cli.md)).

---

**See also** — [Task Contract](../configuration/task-contract.md) (contract fields and budget rules) · [Controller and Registry](../configuration/controller-and-registry.md) (registry and controller schemas)

**Next** → [Task Contract](../configuration/task-contract.md) — review complete contract schemas, budgets, and evidence levels.
