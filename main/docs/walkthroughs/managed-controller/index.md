# Managed Controller

Managed controller mode is Loopwright's fine-grained governance workflow for platform engineers and local CLI operators. You author an out-of-repo `TrustedRegistry`, pin its SHA-256 digest inside `ControllerConfig` alongside a `TaskContract` DAG, and drive admission, execution, inspection, and crash reconciliation via the `loopwright` CLI.

For single-file repository automation where Loopwright compiles contracts and digests automatically, follow [Declarative Taskpack](/loopwright/main/docs/walkthroughs/declarative-taskpack/index.md) instead.

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

![Managed controller configuration relationships](/loopwright/main/docs/assets/diagrams/managed-controller-relations.svg)

<!-- flowchart TB
  Controller["ControllerConfig (controller.yaml)"] -> Task["Embedded TaskContract (spec.task)"]
  Controller -> Bridge["Binding Bridge (spec.registry, profiles, credentials)"]
  Bridge -> Registry["Out-of-repo TrustedRegistry (registry.yaml · metadata.name)"]
  Task -> Registry
-->

Managed controller mode coordinates an operator-owned authority store (`TrustedRegistry`) with a run configuration (`ControllerConfig` embedding `TaskContract`):

| Relationship | Source field | Target declaration | Runtime invariant |
| --- | --- | --- | --- |
| Containment | `ControllerConfig.spec.task` | Embedded `TaskContract` (`apiVersion`, `kind`, `spec`) | JCS-hashed into run lock; carries zero credentials or handler digests |
| Registry hash lock | `ControllerConfig.spec.registry.{name,digest}` | `TrustedRegistry.metadata.name` + file SHA-256 | Must match `--registry-sha256` and live outside repo/config roots |
| Role binding | `spec.profiles.roles[].{roleId,profileRef}` | Bridges `TaskContract.roles[].id` to `roleProfiles[].id` | Enforces provider, context ceiling, tool subset, and `runtimeRef` |
| Step & check binding | `spec.profiles.steps[].{stepId,handlerRef}` | Bridges `TaskContract.steps[].id` to `handlers[].id` | Verifies installed handler SHA-256 and `acceptance.checks[].id` |
| Context pinning | `TaskContract.trustedContext.{revision,resources}` | `TrustedRegistry.{resourceVersion,resources[]}` | Matches context revision and read-only instruction SHA-256 digests |
| Secret & PR wiring | `spec.credentials[]` & `publication.endpointRef` | `credentialBindings[]`, `environmentBindings[]`, `publicationEndpoints[]` | Resolves `${ENV}` in memory only; signs HMAC PR/gate requests |

## Overview

![Managed controller lifecycle](/loopwright/main/docs/assets/diagrams/managed-controller-flow.svg)

<!-- flowchart LR
  Init["01 Init drafts"] -> Registry["02 Pin TrustedRegistry"] -> Config["03 Bind ControllerConfig"] -> Run["04 Check & run"] -> Reconcile["05 Inspect & settle"]
-->

## Prompt bootstrap

`loopwright init` writes generic `REVIEW_REQUIRED` placeholders. To assemble tailored `registry.yaml` and `controller.yaml` files interactively without looking up digests by hand, paste this prompt into your local coding agent:

```text
Read https://docs.gpustack.ai/loopwright/llms.txt and fetch the Markdown guides for Managed Controller, Task Contract, and Controller and Registry. Inspect this target repository, confirm my writable/protected scope, budgets, and required checks, compute the installed Loopwright handler and graph SHA-256 digests on this machine, write out-of-repo registry.yaml and controller.yaml, and validate them with loopwright check.
```

## Step 1: Generate drafts

Install `@gpustack/loopwright` (see [Installation](/loopwright/main/docs/getting-started/installation/index.md)) and initialize starter YAML files in a real non-symlink directory **outside** the target repository:

```sh
mkdir -p "$HOME/loopwright-ops" "$HOME/loopwright-runs" "$HOME/loopwright-trust"
loopwright init --directory "$HOME/loopwright-ops"
cp "$HOME/loopwright-ops/registry.draft.yaml" "$HOME/loopwright-trust/registry.yaml"
cp "$HOME/loopwright-ops/controller.draft.yaml" "$HOME/loopwright-ops/controller.yaml"
```

`loopwright init` writes `0600` drafts. Keep `registry.yaml` in `$HOME/loopwright-trust` outside `cwd`, outside `$HOME/loopwright-ops`, and outside any target repository (`REGISTRY_UNTRUSTED`).

## Step 2: Pin registry

Compute the installed handler and runtime digests from your Loopwright installation so `registry.yaml` pins verified code bytes:

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

Populate `$HOME/loopwright-trust/registry.yaml` (`metadata.name` is referenced by `controller.yaml`):

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
          - release
        equals:
          schema_version: 1
      capabilities:
        - inert_bytes
        - read_only
    - id: scope
      version: 1
      kind: check
      implementation: scope.v1
      digest:
        algorithm: sha256
        hex: <hash>
      parameters:
        checkId: null
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
      template: ${ZAI_API_KEY}
  environmentBindings:
    - name: ZAI_API_KEY
      classification: credential
      paths:
        - /spec/credentials/0/template
```

Compute and export the SHA-256 digest of the finalized `registry.yaml`:

```sh
REGISTRY_SHA=$(shasum -a 256 "$HOME/loopwright-trust/registry.yaml" | awk '{print $1}')
echo "$REGISTRY_SHA"
```

## Step 3: Author controller

Edit `$HOME/loopwright-ops/controller.yaml` to embed your `TaskContract`, bind `registry.name` + `$REGISTRY_SHA`, and map roles and steps:

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
      template: ${ZAI_API_KEY}
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

- **Contract fields**: See [Task Contract](/loopwright/main/docs/configuration/task-contract/index.md) for every `TaskContract` field and budget invariant.
- **Registry and controller fields**: See [Controller and Registry](/loopwright/main/docs/configuration/controller-and-registry/index.md) for every `TrustedRegistry` and `ControllerConfig` field.

## Step 4: Execute run

Run static compilation first (`check` performs zero network calls and zero state admission), then launch the fenced run outside `$HOME/loopwright-trust`:

```sh
export ZAI_API_KEY="zai_example_token"
loopwright check --config "$HOME/loopwright-ops/controller.yaml" --registry "$HOME/loopwright-trust/registry.yaml" --registry-sha256 "$REGISTRY_SHA" --json
loopwright run --config "$HOME/loopwright-ops/controller.yaml" --registry "$HOME/loopwright-trust/registry.yaml" --registry-sha256 "$REGISTRY_SHA" --repo /path/to/example-app --run-root "$HOME/loopwright-runs" --run-id run-20261112-01 --json
```

## Step 5: Reconcile receipts

Query run state, export evidence bundles, or resume/reconcile interrupted executions:

```sh
loopwright status --run-root "$HOME/loopwright-runs" --run-id run-20261112-01 --json
loopwright inspect --run-root "$HOME/loopwright-runs" --run-id run-20261112-01 --output "$HOME/loopwright-runs/bundle-01"
```

- **Resume after host restart**: Run `loopwright resume` with the same `--run-root`, `--run-id`, `--config`, `--registry`, `--registry-sha256`, and `--repo`.
- **Reconcile uncertain publication (exit `7`)**: Never retry uncertain remote mutations blindly; verify remote state and settle with `loopwright reconcile ... --receipt receipt.json` (see [CLI](/loopwright/main/docs/operations/cli/index.md)).

---

**See also** — [Task Contract](/loopwright/main/docs/configuration/task-contract/index.md) (every `TaskContract` field and budget rule) · [Controller and Registry](/loopwright/main/docs/configuration/controller-and-registry/index.md) (every `TrustedRegistry` and `ControllerConfig` field)

**Next** → [Task Contract](/loopwright/main/docs/configuration/task-contract/index.md) — review complete contract schemas, budgets, and evidence levels.
