# CLI

The CLI validates trusted configuration and manages bounded local runs. Install the `loopwright` command on your laptop first via [Installation](/loopwright/latest/docs/getting-started/installation/index.md), then use it to prepare, inspect, resume, or reconcile work and audit capability closure.

## Contents

- [Step 1: Generate drafts](#step-1-generate-drafts)
- [Step 2: Approve bindings](#step-2-approve-bindings)
- [Step 3: Check configuration](#step-3-check-configuration)
- [Step 4: Run work](#step-4-run-work)
- [Step 5: Inspect recovery](#step-5-inspect-recovery)
- [Step 6: Audit closure](#step-6-audit-closure)
- [Command reference](#command-reference)
- [Exit codes](#exit-codes)

## Step 1: Generate drafts

```sh
loopwright init --directory ./loopwright-config
```

The command creates `controller.draft.yaml`, `registry.draft.yaml`, and `README.draft.md` for **Managed Controller** workflows (for a complete populated setup, follow [Managed Controller](/loopwright/latest/docs/walkthroughs/managed-controller/index.md)). Note that `loopwright init` does not generate `.loopwright/taskpack.yaml`; to bootstrap or migrate a repository `Taskpack` interactively, use the [`llms.txt` bootstrap prompt](/loopwright/latest/docs/getting-started/installation/index.md#prompt-bootstrap).

```yaml
apiVersion: loopwright.dev/v1alpha1
kind: TrustedRegistry
metadata:
  name: operator-draft
spec:
  version: 1
  resourceVersion: context-draft
  handlers: []
  roleProfiles: []
  runtimeProfiles: []
  resources: []
  credentialBindings: []
  environmentBindings: []
```

- **Draft**: The excerpt shows the generated registry; `controller.draft.yaml` contains `REVIEW_REQUIRED` placeholders that must be replaced before execution.
- **Authority**: Keep approved registry bytes and run state outside the checkout.
- **Context**: `proven_bound` is the strict default; estimated guards require explicit immutable opt-in.

| File | Purpose |
| --- | --- |
| `controller.draft.yaml` | Task, registry `name` + digest, profile references, and controls |
| `registry.draft.yaml` | Trusted handlers, profiles, resources, and bindings |
| `README.draft.md` | Draft readiness and review instructions |

## Step 2: Approve bindings

Review the task scope, exact installed profiles, handlers, credentials, and registry bytes. Replace every placeholder and calculate the SHA-256 of the final approved registry. The generated digest matches only the initial draft bytes.

## Step 3: Check configuration

```sh
loopwright check --config CONFIG --registry REGISTRY --registry-sha256 DIGEST --json
loopwright run --dry-run --config CONFIG --registry REGISTRY --registry-sha256 DIGEST --json
```

Both commands validate and compile statically. Neither proves execution readiness, provider availability, or host qualification.

## Step 4: Run work

```sh
loopwright run --config CONFIG --registry REGISTRY --registry-sha256 DIGEST --repo REPO --run-root TRUSTED_ROOT --run-id demo
loopwright resume --config CONFIG --registry REGISTRY --registry-sha256 DIGEST --repo REPO --run-root TRUSTED_ROOT --run-id demo
```

Use `resume` for an existing run with the same trusted identity and bindings. Do not replay an uncertain external effect.

## Step 5: Inspect recovery

![Recovery, receipt reconciliation, and closure audit](/loopwright/latest/docs/assets/diagrams/reconcile-closure-flow.svg)

<!-- flowchart LR
  Inspect["01 Inspect state"] -> Reconcile["02 Reconcile receipt"] -> Closed["03 Verify closed_local"] -> External["04 Report external gaps"]
-->

```sh
loopwright status --run-root TRUSTED_ROOT --run-id demo --json
loopwright inspect --run-root TRUSTED_ROOT --run-id demo --output INSPECTION_DIR --json
loopwright reconcile --config CONFIG --registry REGISTRY --registry-sha256 DIGEST --repo REPO --run-root TRUSTED_ROOT --run-id demo --receipt RECEIPT --json
```

Inspect state and evidence before recovery. Reconcile an unknown external outcome with its matching authenticated receipt; absent evidence stays unknown.

## Step 6: Audit closure

```sh
loopwright closure --verify-failures --json
```

Closure exits `0` for a valid report, `3` for falsification or unsupported capability, `4` for failure-matrix failure, and `8` for integrity failure. JSON output uses versioned envelopes with kind, sequence, run identity, and data.

| Disposition | Evidence scope | Meaning |
| --- | --- | --- |
| `closed_local` | Recorded local evidence level | Local criterion and failure matrix passed |
| `blocked_external` | Unprovisioned external dependency | Live service, host, or hardware remains external |
| `deferred_owned` | Deferred owned capability | Recorded prerequisite remains unimplemented or deferred |

## Command reference

| Subcommand | Required flags | Optional flags | Purpose |
| --- | --- | --- | --- |
| `init` | `--directory` | `--force`, `--json` | Emit `controller.draft.yaml` and `registry.draft.yaml` |
| `check` | `--config`, `--registry`, `--registry-sha256` | `--output`, `--json` | Compile and verify configuration and registry digest statically |
| `run` | `--config`, `--registry`, `--registry-sha256`, `--repo`, `--run-root`, `--run-id` | `--json` | Execute a bounded controller run |
| `run --dry-run` | `--dry-run`, `--config`, `--registry`, `--registry-sha256` | `--output`, `--json` | Compile plan statically (`--repo`, `--run-root`, `--run-id` disallowed) |
| `resume` | `--config`, `--registry`, `--registry-sha256`, `--repo`, `--run-root`, `--run-id` | `--json` | Resume an existing run under identical trusted bindings |
| `status` | `--run-root`, `--run-id` | `--json` | Read current run stage, lease state, and checkpoint summary |
| `inspect` | `--run-root`, `--run-id` | `--output`, `--json` | Export redacted run receipts, checkpoints, and diagnostics |
| `reconcile` | `--config`, `--registry`, `--registry-sha256`, `--repo`, `--run-root`, `--run-id`, `--receipt` | `--output`, `--json` | Settle an unknown external outcome with an authenticated receipt |
| `closure` | None | `--repo`, `--output`, `--verify-failures`, `--json` | Audit the 23-capability closure matrix and 14-case failure suite |
| `app-serve` | `--config` | `--repo`, `--json` | Start the opt-in GitHub App HTTP webhook and token listener |

```sh
loopwright app-serve --config github-app.yaml --repo . --json
```

Set `spec.listen.enabled: true` first. The command exits `2` for disabled or invalid configuration, `130` on SIGINT, and `143` on SIGTERM. See [GitHub App](/loopwright/latest/docs/operations/github-app/index.md) for configuration and host requirements.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Completed, no change, or successful static command |
| 2 | Usage or configuration rejected |
| 3 | Unsupported capability or blocked work |
| 4 | Execution or acceptance failed |
| 5 | Allowance exhausted |
| 6 | Deadline expired |
| 7 | Reconciliation or ownership needed |
| 8 | Authoritative result unavailable or incident |
| 130 | Accounted SIGINT, subject to uncertainty precedence |
| 143 | Accounted SIGTERM, subject to uncertainty precedence |

---

**See also** — [Installation](/loopwright/latest/docs/getting-started/installation/index.md) (install `@gpustack/loopwright` and copy bootstrap prompts) · [Controller and Registry](/loopwright/latest/docs/configuration/controller-and-registry/index.md) (approve trusted execution bindings)

**Next** → [Managed Controller](/loopwright/latest/docs/walkthroughs/managed-controller/index.md) — populate `registry.yaml` and `controller.yaml` end to end.
