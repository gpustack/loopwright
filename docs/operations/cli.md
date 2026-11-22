# CLI

The CLI validates trusted configuration, syncs taskpack digest lockfiles, and manages bounded local runs. Install the `loopwright` command on your laptop first via [Installation](../getting-started/installation.md), then use it to prepare, inspect, resume, or reconcile work and audit capability closure.

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

The command creates `controller.draft.yaml`, `registry.draft.yaml`, and `README.draft.md` for **Managed Controller** workflows (for a complete populated setup, follow [Managed Controller](../walkthroughs/managed-controller.md)). Note that `loopwright init` does not generate `.loopwright/taskpack.yaml`; to bootstrap or migrate a repository `Taskpack` interactively, use the [`llms.txt` bootstrap prompt](../getting-started/installation.md#prompt-bootstrap).

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

These commands validate and compile statically without running preflight, memory, or publication. Neither proves execution readiness, provider availability, or host qualification. Managed `run --dry-run` (`--config`) refuses `--allow-privileged`, `--allow-workflow-writes`, and `--allow-host-mounts`, whereas `run --dry-run --taskpack` accepts them for static validation.

## Step 4: Run work

```sh
loopwright run --taskpack .loopwright/taskpack.yaml --repo REPO --run-root TRUSTED_ROOT --run-id demo
loopwright run --config CONFIG --registry REGISTRY --registry-sha256 DIGEST --repo REPO --run-root TRUSTED_ROOT --run-id demo
loopwright resume --config CONFIG --registry REGISTRY --registry-sha256 DIGEST --repo REPO --run-root TRUSTED_ROOT --run-id demo
```

`run --taskpack` runs a local declarative taskpack via `@loopwright/taskpack` without GitHub variables (`--taskpack` is mutually exclusive with `--config`/`--registry`/`--registry-sha256`). It accepts `--mode candidate|no-change|auto`, `--baseline-alignment off|fail-fast|extract-context`, `--source-revision <REV>`, `--role-model`, `--dry-run`, `--allow-privileged`, `--allow-workflow-writes`, `--allow-host-mounts`, `--json`, `--output-format`, and `--step-summary-file`.

When `--source-revision` differs from `HEAD`, `--baseline-alignment` probes 3-way merge conflicts in an isolated Git object directory before model calls (`fail-fast` halts as `baseline_merge_conflict`, exit `3`; `extract-context` stages scrubbed conflict hunks).

Under local CLI runs without a PR publisher, `mode: auto` defaults to `candidate` when neither `preflight` nor `upstreams` is declared. Declaring `publication.mode: pull_request`, `memory.apply: separate-pull-request`, or `memory.apply: inline-with-candidate` fails closed with `TASKPACK_HOST_BINDING_INVALID`.

Use `resume` for an existing run with the same trusted identity and bindings. Do not replay an uncertain external effect.

`run`, `resume`, `step next`, and `step submit` accept opt-in `--allow-privileged` and `--allow-workflow-writes`. `run`, `step next`, and `step submit` also accept `--allow-host-mounts <csv>` to authorize `command.v1` `parameters.mounts` sources. `reconcile` accepts `--allow-workflow-writes` only; other commands (including `runner`) refuse all privilege flags.

`run` and `step` runs wire live `@loopwright/decisions` adapters into `ControllerPorts.decisions` whenever `spec.decisions.enabled` is `true` (falling back deterministically when credentials or endpoints are unavailable).

`run`, `resume`, and `reconcile` accept `--output-format <csv>` with `json`, `github-step-summary`, `markdown`, and `text` (each emitting a sanitized `Run Health` (`RunEval`) section covering tool repeats, ping-pong loops, repair convergence, per-step/role breakdowns, and `autoApplied: false` suggestions).
Use `--step-summary-file <path>` to write a separate Markdown summary. With `--json`, stdout stays pure NDJSON and omits selected Markdown or text reports. Without `--json`, selected reports go to stdout.

## Step 5: Inspect recovery

![Recovery, receipt reconciliation, and closure audit](../assets/diagrams/reconcile-closure-flow.svg)

<!-- flowchart LR
  Inspect["01 Inspect state"] -> Reconcile["02 Reconcile receipt"] -> Closed["03 Verify closed_local"] -> External["04 Report external gaps"]
-->

```sh
loopwright status --run-root TRUSTED_ROOT --run-id demo --json
loopwright inspect --run-root TRUSTED_ROOT --run-id demo --output INSPECTION_DIR --json
loopwright reconcile --config CONFIG --registry REGISTRY --registry-sha256 DIGEST --repo REPO --run-root TRUSTED_ROOT --run-id demo --receipt RECEIPT --json
```

Inspect state and evidence before recovery. `loopwright inspect` exports `run-eval.json` inside `--output` and attaches `runEval` to JSON output without calling a model or network service. Reconcile an unknown external outcome with its matching authenticated receipt; absent evidence stays unknown.

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

Use `step` to hand each delegated role to a host agent (see [Coding Agents](coding-agents.md) for the end-to-end coroutine workflow and overlay application). Start with either trusted configuration or a taskpack:

```sh
loopwright step next --config CONFIG --registry REGISTRY --registry-sha256 DIGEST --repo REPO --run-root TRUSTED_ROOT --run-id demo --json
loopwright step next --taskpack TASKPACK --repo REPO --run-root TRUSTED_ROOT --run-id demo --json
loopwright step submit --run-root TRUSTED_ROOT --run-id demo --lease TOKEN --status completed --json
loopwright step cancel --run-root TRUSTED_ROOT --run-id demo --json
```

Use `--action next`, `--action submit`, or `--action cancel` instead of a positional action. `step next` accepts `--mode candidate|no-change`, `--baseline-alignment off|fail-fast|extract-context`, `--source-revision <REV>`, `--allow-privileged`, `--allow-workflow-writes`, and `--allow-host-mounts <csv>`. Pass the same privilege flags to `step submit` when running `command.v1` checks that require privileged host capabilities or host mounts.

A parked run rejects another pull unless `--reissue-lease` replaces a lost lease. Submit each single-use `--lease` token once. `--submission-file` supplies an artifact; `--status` accepts `completed`, `no_change`, `failed`, or `blocked`. Use `--reason` for a failure or block.

JSON output is NDJSON. An envelope with `kind: 'step'` contains `data.status: 'awaiting_role'`, selection, prompt, allowed tools, scope, workspace paths, and lease token. Follow those bounds before submitting. Cancellation exits `130`; SIGINT and SIGTERM exit `130` and `143`, subject to uncertainty precedence.

`check`, `run`, `resume`, and `step next` accept repeatable `--role-model ROLE=PROVIDER/MODEL[:THINKING]`. Supply at most eight entries. The CLI limits the argument vector to 64 entries. See [Controller and Registry](../configuration/controller-and-registry.md) for precedence and persistence.

## Command reference

| Subcommand | Required flags | Optional flags | Purpose |
| --- | --- | --- | --- |
| `init` | `--directory` | `--force`, `--json` | Emit `controller.draft.yaml` and `registry.draft.yaml` |
| `check` | `--config`, `--registry`, `--registry-sha256` | `--output`, `--json` | Compile and verify configuration and registry digest statically |
| `digest sync` | `--taskpack` | `--repo`, `--check`, `--json` | Write or verify `digests.lock.json` SHA-256 digests |
| `suite check` | `--suite` | `--repo`, `--verify-digests`, `--json` | Validate `TaskpackSuite`, protected union, and prefix disjointness |
| `suite resolve` | `--suite` | `--repo`, `--event`, `--schedule`, `--comment-body`, `--pr-head-ref`, `--pr-base-ref`, `--domain`, `--json` | Resolve domain matrix, PR comments, and stage readiness |
| `run` | `--taskpack` or `--config`+`--registry`+`--registry-sha256`, plus `--repo`, `--run-root`, `--run-id` | `--mode`, `--baseline-alignment`, `--source-revision`, `--role-model`, `--allow-privileged`, `--allow-workflow-writes`, `--json`, `--output-format`, `--step-summary-file` | Execute a local taskpack or managed controller run |
| `run --dry-run` | `--dry-run` with `--taskpack`+`--repo` or `--config`+`--registry`+`--registry-sha256` | `--mode`, `--baseline-alignment`, `--source-revision`, `--role-model`, `--output`, `--json` | Compile plan statically without preflight, memory, or publication |
| `resume` | `--config`, `--registry`, `--registry-sha256`, `--repo`, `--run-root`, `--run-id` | `--allow-privileged`, `--allow-workflow-writes`, `--json`, `--output-format`, `--step-summary-file` | Resume an existing run under identical trusted bindings |
| `step` | `--run-root`, `--run-id`, action | `--action`, `--baseline-alignment`, `--source-revision`, `--allow-privileged`, `--allow-workflow-writes`, `--json` | Pull, submit, or cancel delegated work |
| `status` | `--run-root`, `--run-id` | `--json` | Read current run stage, lease state, and checkpoint summary |
| `inspect` | `--run-root`, `--run-id` | `--output`, `--json` | Export redacted receipts, `run-eval.json`, and diagnostics |
| `reconcile` | `--config`, `--registry`, `--registry-sha256`, `--repo`, `--run-root`, `--run-id`, `--receipt` | `--output`, `--json`, `--output-format`, `--step-summary-file` | Settle an unknown external outcome with an authenticated receipt |
| `closure` | None | `--repo`, `--output`, `--verify-failures`, `--json` | Audit the 23-capability closure matrix and 14-case failure suite |
| `app-serve` | `--config` | `--repo`, `--json` | Start the opt-in GitHub App HTTP webhook and token listener |
| `runner relay` | `--config` | `--json` | Start the outbound-pull benchmark relay and CAS server |
| `runner worker` | `--config` | `--once`, `--json` | Poll relay leases and execute two-stage hardware benchmarks |

### Suite commands

```sh
loopwright suite check --suite .loopwright/suite.yaml --repo . --verify-digests --json
loopwright suite resolve --suite .loopwright/suite.yaml --repo . --event schedule --schedule nightly --json
loopwright suite resolve --suite .loopwright/suite.yaml --repo . --event issue_comment --comment-body "/loopwright docs retry" --pr-head-ref loopwright-docs-1 --pr-base-ref main --json
```

`suite resolve` emits `{ include: [...] }` matrix cells in `--json` mode and exits `0` for `eligible`, `deferred`, and `ignored` dispositions, `2` for usage, unknown `--domain`, or manifest/scope validation errors, and `3` for runtime `blocked` outcomes (such as probe failures or branch-ownership mismatches).

```sh
loopwright app-serve --config github-app.yaml --repo . --json
```

Set `spec.listen.enabled: true` first. The command exits `2` for disabled or invalid configuration, `130` on SIGINT, and `143` on SIGTERM. See [GitHub App](github-app.md) for configuration and host requirements.

### Hardware runner

```sh
loopwright runner --help
loopwright runner relay --config relay.yaml --json
loopwright runner worker --config worker.yaml --once --json
```

`runner relay` listens for controller submissions (`/v1/benchmark/jobs/*`) and worker pull-lease polls (`/v1/runner/leases*`) with monotonic `leaseEpoch` fencing and `1 MiB` CAS streaming.

`runner worker` opens zero inbound ports, pulls leases outbound over HTTPS or loopback HTTP, compiles Stage A artifacts without `held_out_workloads`, executes Stage B benchmarks read-only under `networkMode: none`, and returns signed verdicts.

- **Graceful shutdown (`SIGINT`)**: Exits `130` (`runner worker` returns `8` if an `unknown` settlement takes precedence).
- **Preemption (`SIGTERM`)**: Reports lease preemption to the relay and exits `143`, unless superseded by `unknown` (`8`) or a `fenced` preemption acknowledgment (`7`).
- **Fenced lease (`7`)**: Exits `7` when the relay rejects a stale `leaseEpoch` or `relayBootId` (`QUEUE_LEASE_FENCED`).
- **Unknown or teardown (`8`)**: Exits `8` on `unknown` acknowledgment, `RUNNER_TEARDOWN_FAILED`, or `RUNNER_TRANSPORT_ERROR`.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Completed, no change, successful static command, or `suite` `eligible`/`deferred`/`ignored` |
| 2 | Usage, configuration, unknown `--domain`, or `TaskpackSuite` manifest rejected |
| 3 | Unsupported capability or runtime `blocked` (`baseline_merge_conflict`, stage probe, branch mismatch) |
| 4 | Execution or acceptance failed |
| 5 | Allowance exhausted |
| 6 | Deadline expired |
| 7 | Reconciliation, ownership needed, or fenced runner lease |
| 8 | Authoritative result unavailable, incident, or runner teardown failure |
| 130 | Step cancellation or accounted SIGINT, subject to uncertainty precedence |
| 143 | Accounted SIGTERM, subject to uncertainty precedence |

---

**See also** — [Coding Agents](coding-agents.md) (drive zero-secret `loopwright step` loops from OAuth coding agents) · [Installation](../getting-started/installation.md) (install `@gpustack/loopwright` and copy bootstrap prompts) · [Controller and Registry](../configuration/controller-and-registry.md) (approve trusted execution bindings)

**Next** → [Managed Controller](../walkthroughs/managed-controller.md) — populate `registry.yaml` and `controller.yaml` end to end.
