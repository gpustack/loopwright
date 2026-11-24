# CLI

The CLI validates trusted configuration, syncs taskpack digest lockfiles, and manages bounded local runs. Install `loopwright` first via [Installation](../getting-started/installation.md), then use it to prepare, run, inspect, reconcile, or audit capability closure.

## Contents

- [Step 1: Prepare and check](#step-1-prepare-and-check)
- [Step 2: Execute runs](#step-2-execute-runs)
- [Step 3: Inspect and recover](#step-3-inspect-and-recover)
- [Step 4: Audit closure](#step-4-audit-closure)
- [Delegated stepping](#delegated-stepping)
- [Suites and App](#suites-and-app)
- [Runner and evolution](#runner-and-evolution)
- [Exit codes](#exit-codes)

## Step 1: Prepare and check

Scaffold Managed Controller drafts outside the checkout (`controller.draft.yaml`, `registry.draft.yaml`, `README.draft.md`), pin `digests.lock.json` for `Taskpack`s, and compile statically:

```sh
loopwright init --directory ./loopwright-config
loopwright digest sync --taskpack .loopwright/taskpack.yaml --repo . --check --json
loopwright check --config CONFIG --registry REGISTRY --registry-sha256 DIGEST --json
loopwright run --dry-run --taskpack .loopwright/taskpack.yaml --repo . --json
```

- **Drafts**: Replace `REVIEW_REQUIRED` placeholders and compute the approved `registry.yaml` SHA-256 before running `check`. For repository `Taskpack`s, use the [bootstrap prompt](../getting-started/installation.md#prompt-bootstrap).
- **Digest lockfile**: `digest sync` hashes `preflight.script`, `command.v1` directories, instructions, and skills (`DIGEST_LOCKFILE_DRIFT`, exit `4` on drift).
- **Static check**: `check` and `run --dry-run` perform zero preflight, model, or publication calls; managed `run --dry-run` refuses privilege flags.

## Step 2: Execute runs

Run a local `Taskpack`, launch a Managed Controller cycle, or resume an existing run under identical trusted bindings:

```sh
loopwright run --taskpack .loopwright/taskpack.yaml --repo REPO --run-root TRUSTED_ROOT --run-id demo
loopwright run --config CONFIG --registry REGISTRY --registry-sha256 DIGEST --repo REPO --run-root TRUSTED_ROOT --run-id demo
loopwright resume --config CONFIG --registry REGISTRY --registry-sha256 DIGEST --repo REPO --run-root TRUSTED_ROOT --run-id demo
```

- **Local taskpack mode**: `--taskpack` accepts `--mode`, `--baseline-alignment`, `--source-revision`, and `--role-model`. PR publication or PR memory fails closed locally (`TASKPACK_HOST_BINDING_INVALID`).
- **Dual-key privileges**: `run`, `resume`, `step next`, and `step submit` accept `--allow-privileged` and `--allow-workflow-writes`; `run` and `step` also accept `--allow-host-mounts <csv>`.
- **Diagnostics & decisions**: `--output-format` (`json`, `github-step-summary`, `markdown`, `text`) and `--step-summary-file` emit `RunEval`. Enabled `spec.decisions` wires live adapters with fallback.

## Step 3: Inspect and recover

![Recovery, receipt reconciliation, and closure audit](../assets/diagrams/reconcile-closure-flow.svg)

<!-- flowchart LR
  Inspect["01 Inspect state"] -> Reconcile["02 Reconcile receipt"] -> Closed["03 Verify closed_local"] -> External["04 Report external gaps"]
-->

```sh
loopwright status --run-root TRUSTED_ROOT --run-id demo --json
loopwright inspect --run-root TRUSTED_ROOT --run-id demo --output INSPECTION_DIR --json
loopwright reconcile --config CONFIG --registry REGISTRY --registry-sha256 DIGEST --repo REPO --run-root TRUSTED_ROOT --run-id demo --receipt RECEIPT --json
```

Inspect state and `run-eval.json` offline before recovery. Settle any `unknown` external outcome with its matching authenticated receipt via `reconcile`; never silently retry uncertain remote effects.

## Step 4: Audit closure

```sh
loopwright closure --verify-failures --json
```

Closure audits the 23-capability matrix and 14-case failure suite, exiting `0` when valid, `3` on unsupported/falsified capability, `4` on failure-matrix failure, and `8` on integrity failure.

| Disposition | Evidence scope | Meaning |
| --- | --- | --- |
| `closed_local` | Recorded local evidence | Local criterion and failure matrix passed |
| `blocked_external` | Unprovisioned external service | Live provider, host, or hardware remains external |
| `deferred_owned` | Deferred owned capability | Recorded prerequisite remains unimplemented |

## Delegated stepping

Hand delegated roles to host coding agents (see [Coding Agents](coding-agents.md) for the full coroutine loop and overlay application):

```sh
loopwright step next --taskpack .loopwright/taskpack.yaml --repo REPO --run-root TRUSTED_ROOT --run-id demo --json
loopwright step submit --run-root TRUSTED_ROOT --run-id demo --lease TOKEN --status completed --json
loopwright step cancel --run-root TRUSTED_ROOT --run-id demo --json
```

- **Leases & recovery**: Submit each single-use `--lease` token once (`--status completed|no_change|failed|blocked`, optional `--submission-file` or `--reason`). Pass `--reissue-lease` to rotate a lost lease on a parked run.
- **Model overrides**: `check`, `run`, `resume`, and `step next` accept up to `8` repeatable `--role-model ROLE=PROVIDER/MODEL[:THINKING]` entries (`argv <= 64`).

## Suites and App

### Suite commands

Validate multi-domain `TaskpackSuite` manifests and resolve GitHub Actions matrices or comment commands offline:

```sh
loopwright suite check --suite .loopwright/suite.yaml --repo . --verify-digests --json
loopwright suite resolve --suite .loopwright/suite.yaml --repo . --event schedule --schedule nightly --json
```

`suite resolve` emits `{ include: [...] }` in `--json` mode, exiting `0` for `eligible`/`deferred`/`ignored`, `2` for schema or unknown `--domain` errors, and `3` for blocked probes or branch mismatches.

### App daemon

```sh
loopwright app-serve --config github-app.yaml --repo . --json
```

Requires `spec.listen.enabled: true` (exit `2` when disabled or invalid; `130`/`143` on `SIGINT`/`SIGTERM`). See [GitHub App](github-app.md).

## Runner and evolution

### Hardware runner

![Hardware relay and outbound worker topology](../assets/diagrams/hardware-relay-flow.svg)

<!-- flowchart LR
  Control["Zone 1: Control Plane (CLI or GitHub Actions, Outbound HTTPS)"] -> DMZ["Zone 2: Relay DMZ (HTTPS Gate, HMAC Auth, Lease Fence, CAS)"] -> Firewall["Cluster Firewall (Zero Inbound Ports)"] -> Worker["Zone 3: Private GPU Cluster (Outbound Pull)"] -> Sandbox["Offline Zero-Network Docker (Stage A Build + Stage B Bench)"] -> Receipt["Signed Verdict Receipt"]
-->

```sh
loopwright runner relay --config relay.yaml --json
loopwright runner worker --config worker.yaml --once --json
```

`runner relay` isolates controller HMAC secrets from worker tokens, enforces `leaseEpoch` fencing, and streams `1 MiB` CAS artifacts so private GPU workers open zero inbound ports. Workers compile Stage A without `held_out_workloads` and execute Stage B read-only with `networkMode: none`.

### Evolution campaigns

```sh
loopwright evolve check --campaign campaign.yaml --repo . --json
loopwright evolve run --campaign campaign.yaml --state ../campaign-state --repo . --json
loopwright evolve status --campaign ../campaign-state --json
loopwright evolve inspect --campaign ../campaign-state --island 0 --json
loopwright evolve resume --campaign ../campaign-state --repo . --json
loopwright evolve export --campaign ../campaign-state --out ../bundle --format oci-layout --json
```

Keep `--state` strictly outside `--repo` (`EVOLUTION_SCHEMA_INVALID`, exit `2` otherwise). `evolve export` verifies every HMAC verdict receipt fail-closed (`EXPORT_UNVERIFIED_FORBIDDEN`, exit `3`) and refuses `synthetic_fixture` receipts without `--allow-synthetic-probe`.

| Environment variable | Purpose |
| --- | --- |
| `LOOPWRIGHT_BENCHMARK_GATE_URL` | Fallback HTTPS or loopback `benchmark-gate.v1` URL for `runner relay` |
| `LOOPWRIGHT_GATE_SIGNING_SECRET` | Required HMAC secret for benchmark submission and fail-closed `evolve export` |
| `LOOPWRIGHT_GATE_AUTH_TOKEN` | Optional bearer token bound to `authCredentialRef` on remote relays |
| `LOOPWRIGHT_MODELS_JSON` | Optional Pi `models.json` path for custom providers and endpoints |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Completed, no change, successful static command, or `suite` `eligible`/`deferred`/`ignored` |
| `2` | Usage, configuration, unknown `--domain`, or manifest rejected |
| `3` | Unsupported capability, blocked work, `TEAM_ENVELOPE_VIOLATION`, or `EXPORT_UNVERIFIED_FORBIDDEN` |
| `4` | Execution, acceptance, `DIGEST_LOCKFILE_DRIFT`, or artifact validation failed |
| `5` | Allowance or campaign budget exhausted |
| `6` | Deadline expired |
| `7` | Reconciliation, `EVOLUTION_CONFLICT`, lease fenced (`QUEUE_LEASE_FENCED`), or clock drift |
| `8` | Authoritative result unavailable, incident, store corruption, or runner teardown failure |
| `130` / `143` | Cancellation, pause, or accounted `SIGINT` / `SIGTERM` (subject to uncertainty precedence) |

---

**See also** — [Coding Agents](coding-agents.md) (zero-secret `loopwright step` loops) · [Installation](../getting-started/installation.md) (CLI install and bootstrap prompts) · [Controller and Registry](../configuration/controller-and-registry.md) (trusted execution bindings)

**Next** → [Managed Controller](../walkthroughs/managed-controller.md) — populate `registry.yaml` and `controller.yaml` end to end.
