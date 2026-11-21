# CLI

The CLI validates trusted configuration, syncs taskpack digest lockfiles, and manages bounded local runs. Install the `loopwright` command on your laptop first via [Installation](/loopwright/main/docs/getting-started/installation/index.md), then use it to prepare, inspect, resume, or reconcile work and audit capability closure.

## Contents

- [Step 1: Generate drafts](#step-1-generate-drafts)
- [Step 2: Approve bindings](#step-2-approve-bindings)
- [Step 3: Check configuration](#step-3-check-configuration)
- [Step 4: Run work](#step-4-run-work)
- [Step 5: Inspect recovery](#step-5-inspect-recovery)
- [Step 6: Audit closure](#step-6-audit-closure)
- [Digest lockfile](#digest-lockfile)
- [Delegated stepping](#delegated-stepping)
- [Command reference](#command-reference)
- [Exit codes](#exit-codes)

## Step 1: Generate drafts

```sh
loopwright init --directory ./loopwright-config
```

The command creates `controller.draft.yaml`, `registry.draft.yaml`, and `README.draft.md` for **Managed Controller** workflows (for a complete populated setup, follow [Managed Controller](/loopwright/main/docs/walkthroughs/managed-controller/index.md)). Note that `loopwright init` does not generate `.loopwright/taskpack.yaml`; to bootstrap or migrate a repository `Taskpack` interactively, use the [`llms.txt` bootstrap prompt](/loopwright/main/docs/getting-started/installation/index.md#prompt-bootstrap).

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
loopwright run --dry-run --taskpack .loopwright/taskpack.yaml --repo . --json
```

These commands validate and compile statically without running preflight, memory, or publication. Neither proves execution readiness, provider availability, or host qualification. Managed `run --dry-run` refuses `--allow-privileged` and `--allow-workflow-writes`.

## Step 4: Run work

```sh
loopwright run --taskpack .loopwright/taskpack.yaml --repo REPO --run-root TRUSTED_ROOT --run-id demo
loopwright run --config CONFIG --registry REGISTRY --registry-sha256 DIGEST --repo REPO --run-root TRUSTED_ROOT --run-id demo
loopwright resume --config CONFIG --registry REGISTRY --registry-sha256 DIGEST --repo REPO --run-root TRUSTED_ROOT --run-id demo
```

`run --taskpack` runs a local declarative taskpack via `@loopwright/taskpack` without GitHub variables (`--taskpack` is mutually exclusive with `--config`/`--registry`/`--registry-sha256`). It accepts `--mode candidate|no-change|auto`, `--role-model`, `--dry-run`, `--allow-privileged`, `--allow-workflow-writes`, `--json`, `--output-format`, and `--step-summary-file`.

Under local CLI runs without a PR publisher, `mode: auto` defaults to `candidate` when neither `preflight` nor `upstreams` is declared. Declaring `publication.mode: pull_request` or `memory.apply: separate-pull-request` fails closed with `TASKPACK_HOST_BINDING_INVALID`.

Use `resume` for an existing run with the same trusted identity and bindings. Do not replay an uncertain external effect.

`run`, `resume`, `step next`, and `step submit` accept opt-in `--allow-privileged` (unlocks privileged execution capabilities) and `--allow-workflow-writes` (unlocks `.github/workflows/**` writes when the taskpack also enables them). `reconcile` accepts `--allow-workflow-writes` and refuses `--allow-privileged`. Other non-execution commands (`init`, `check`, `run --dry-run`, `status`, `inspect`, `closure`, `digest`, `app-serve`) refuse both flags.

`run` and `step` runs wire live `@loopwright/decisions` adapters into `ControllerPorts.decisions` whenever `spec.decisions.enabled` is `true` (falling back deterministically when credentials or endpoints are unavailable).

`run`, `resume`, and `reconcile` accept `--output-format <csv>` with `json`, `github-step-summary`, `markdown`, and `text`.
Use `--step-summary-file <path>` to select the summary file.
With `--json`, stdout stays pure NDJSON. The CLI does not emit selected Markdown or text reports in this mode.
Use `--step-summary-file` to write a separate Markdown summary. Without `--json`, selected reports go to stdout.

## Step 5: Inspect recovery

![Recovery, receipt reconciliation, and closure audit](/loopwright/main/docs/assets/diagrams/reconcile-closure-flow.svg)

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

## Digest lockfile

```sh
loopwright digest sync --taskpack .loopwright/taskpack.yaml --repo .
loopwright digest sync --taskpack .loopwright/taskpack.yaml --repo . --check --json
```

`digest sync` computes deterministic SHA-256 digests for `spec.preflight.script`, mounted `command.v1` check directories, instructions, and skills, writing `<controlRoot>/digests.lock.json` (or `spec.execution.digests.lockfile`). Pass `--check` in CI to fail closed (`DIGEST_LOCKFILE_DRIFT`, exit `4`) when any tracked file or check helper drifts.

## Delegated stepping

Use `step` to hand each delegated role to a host agent (see [Coding Agents](/loopwright/main/docs/operations/coding-agents/index.md) for the end-to-end coroutine workflow and overlay application). Start with either trusted configuration or a taskpack:

```sh
loopwright step next --config CONFIG --registry REGISTRY --registry-sha256 DIGEST --repo REPO --run-root TRUSTED_ROOT --run-id demo --json
loopwright step next --taskpack TASKPACK --repo REPO --run-root TRUSTED_ROOT --run-id demo --json
loopwright step submit --run-root TRUSTED_ROOT --run-id demo --lease TOKEN --status completed --json
loopwright step cancel --run-root TRUSTED_ROOT --run-id demo --json
```

Use `--action next`, `--action submit`, or `--action cancel` instead of a positional action. `step next` accepts `--mode candidate|no-change`, `--allow-privileged`, and `--allow-workflow-writes`. Pass the same privilege flags to `step submit` when running `command.v1` checks that require privileged host capabilities.

A parked run rejects another pull unless `--reissue-lease` replaces a lost lease. Submit each single-use `--lease` token once. `--submission-file` supplies an artifact; `--status` accepts `completed`, `no_change`, `failed`, or `blocked`. Use `--reason` for a failure or block.

JSON output is NDJSON. An envelope with `kind: 'step'` contains `data.status: 'awaiting_role'`, selection, prompt, allowed tools, scope, workspace paths, and lease token. Follow those bounds before submitting. Cancellation exits `130`; SIGINT and SIGTERM exit `130` and `143`, subject to uncertainty precedence.

`check`, `run`, `resume`, and `step next` accept repeatable `--role-model ROLE=PROVIDER/MODEL[:THINKING]`. Supply at most eight entries. The CLI limits the argument vector to 64 entries. See [Controller and Registry](/loopwright/main/docs/configuration/controller-and-registry/index.md) for precedence and persistence.

## Command reference

| Subcommand | Required flags | Optional flags | Purpose |
| --- | --- | --- | --- |
| `init` | `--directory` | `--force`, `--json` | Emit `controller.draft.yaml` and `registry.draft.yaml` |
| `check` | `--config`, `--registry`, `--registry-sha256` | `--output`, `--json` | Compile and verify configuration and registry digest statically |
| `digest sync` | `--taskpack` | `--repo`, `--check`, `--json` | Write or verify `digests.lock.json` SHA-256 digests |
| `run` | `--taskpack` or `--config`+`--registry`+`--registry-sha256`, plus `--repo`, `--run-root`, `--run-id` | `--mode`, `--role-model`, `--allow-privileged`, `--allow-workflow-writes`, `--json`, `--output-format`, `--step-summary-file` | Execute a local taskpack or managed controller run |
| `run --dry-run` | `--dry-run` with `--taskpack`+`--repo` or `--config`+`--registry`+`--registry-sha256` | `--mode`, `--role-model`, `--output`, `--json` | Compile plan statically without preflight, memory, or publication |
| `resume` | `--config`, `--registry`, `--registry-sha256`, `--repo`, `--run-root`, `--run-id` | `--allow-privileged`, `--allow-workflow-writes`, `--json`, `--output-format`, `--step-summary-file` | Resume an existing run under identical trusted bindings |
| `step` | `--run-root`, `--run-id`, action | `--action`, `--allow-privileged`, `--allow-workflow-writes`, `--json` | Pull, submit, or cancel delegated work |
| `status` | `--run-root`, `--run-id` | `--json` | Read current run stage, lease state, and checkpoint summary |
| `inspect` | `--run-root`, `--run-id` | `--output`, `--json` | Export redacted run receipts, checkpoints, and diagnostics |
| `reconcile` | `--config`, `--registry`, `--registry-sha256`, `--repo`, `--run-root`, `--run-id`, `--receipt` | `--output`, `--json`, `--output-format`, `--step-summary-file` | Settle an unknown external outcome with an authenticated receipt |
| `closure` | None | `--repo`, `--output`, `--verify-failures`, `--json` | Audit the 23-capability closure matrix and 14-case failure suite |
| `app-serve` | `--config` | `--repo`, `--json` | Start the opt-in GitHub App HTTP webhook and token listener |

```sh
loopwright app-serve --config github-app.yaml --repo . --json
```

Set `spec.listen.enabled: true` first. The command exits `2` for disabled or invalid configuration, `130` on SIGINT, and `143` on SIGTERM. See [GitHub App](/loopwright/main/docs/operations/github-app/index.md) for configuration and host requirements.

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
| 130 | Step cancellation or accounted SIGINT, subject to uncertainty precedence |
| 143 | Accounted SIGTERM, subject to uncertainty precedence |

---

**See also** — [Coding Agents](/loopwright/main/docs/operations/coding-agents/index.md) (drive zero-secret `loopwright step` loops from OAuth coding agents) · [Installation](/loopwright/main/docs/getting-started/installation/index.md) (install `@gpustack/loopwright` and copy bootstrap prompts) · [Controller and Registry](/loopwright/main/docs/configuration/controller-and-registry/index.md) (approve trusted execution bindings)

**Next** → [Managed Controller](/loopwright/main/docs/walkthroughs/managed-controller/index.md) — populate `registry.yaml` and `controller.yaml` end to end.
