# GitHub Action

The reusable Action runs a taskpack cycle in a consumer repository without a resident server. It executes optional host preflight, discovers upstream changes, verifies candidates, and can publish a managed pull request.

## Contents

- [Workflow](#workflow)
- [Execution and publication](#execution-and-publication)
- [Secrets and environment](#secrets-and-environment)
- [Core inputs](#core-inputs)
- [Outputs](#outputs)
- [Triggers](#triggers)

## Workflow

Install a taskpack and configure provider and App secrets before enabling this workflow. The App installation needs repository contents and pull request write permissions for native publication.

```yaml
name: loopwright
on:
  schedule:
    - cron: '0 3 * * *'
  workflow_dispatch: {}
  issue_comment:
    types:
      - created
permissions:
  contents: read
jobs:
  taskpack:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: gpustack/loopwright@main
        id: loopwright
        with:
          taskpack-path: .loopwright/taskpack.yaml # Optional
          suite-path: .loopwright/suite.yaml # Optional multi-domain suite
          domain: docs # Optional suite domain ID
          resolve-suite-only: 'false' # Optional matrix resolution only
          mode: auto # Optional (auto, candidate, or no-change)
          allow-privileged-execution: 'false' # Optional dual-key host unlock
          allow-workflow-writes: 'false' # Optional dual-key workflow write unlock
          event-name: ${{ github.event_name }}
          event-path: ${{ github.event_path }}
          github-app-id: ${{ secrets.LOOPWRIGHT_APP_ID }}
          github-app-private-key: ${{ secrets.LOOPWRIGHT_APP_PRIVATE_KEY }}
          output: json,github-step-summary # Optional
        env:
          ZAI_API_KEY: ${{ secrets.ZAI_API_KEY }}
```

- **Mode `auto`**: Runs preflight or upstream discovery, dispatches `candidate` on changes, or settles `no-change` without model calls.
- **Suite matrix**: Pass `suite-path` with `resolve-suite-only: 'true'` to emit `outputs.matrix`, then run each job with `domain`.
- **Dual-key authority**: Privileged capabilities require `allow-privileged-execution: 'true'`; workflow edits require `allow-workflow-writes: 'true'`; host mounts require `allow-host-mounts`.
- **Provider**: Set the token environment variable expected by the model selected in `spec.models`.
- **Runtime**: The Action provisions Node.js `26` and builds the workspace if its entrypoint is absent.

## Execution and publication

Live runs enforce `policyProfile: github`, validate `spec.triggers` before `spec.preflight`, authorize the actor, initialize `SecretScrubber`, and compile artifacts outside the checkout.

| Stage | Behavior |
| --- | --- |
| Preflight | Validates `spec.triggers` (and `suite-path` probes) first, then runs `spec.preflight.script` post-auth |
| Align | Runs isolated 3-way `git merge-tree` when `sourceRevision !== baseRevision` (`fail-fast` or `extract-context`) |
| Discover | Resolves upstreams, lockstep `held_back` holds, or `upstream-records`; routes settled `auto` runs to `no-change` |
| Execute | Authors candidates in sandboxes with CAS pointers and runs local or external checks with bounded repair |
| Publish | Streams verified CAS blobs into a head-pinned managed PR with DCO sign-off and `--force-with-lease` |

Pass `source-revision` when preflight stages writable files onto a commit separate from `GITHUB_SHA`. Uncertain external outcomes stay `unknown` and are never retried silently.

Memory finalization follows `spec.memory.apply` (`separate-pull-request`, `inline-with-candidate`, `local-only`, or `disabled`) without blocking primary task completion. On GitHub-hosted runners (`RUNNER_ENVIRONMENT=github-hosted`), an omitted `spec.sandbox` selects `direct-dedicated`; self-hosted runners negotiate host OS sandboxes instead (see [Sandbox Backends](/loopwright/main/docs/configuration/sandbox-backends/index.md)).

Protected paths override writable paths. `.github/workflows/**` stays write-protected unless both `allowWorkflowWrites: true` and `allow-workflow-writes: 'true'` are set.

## Secrets and environment

Pass `github-token`, or pass `github-app-id` and `github-app-private-key` to mint an installation token. Precedence is explicit `github-token` > App credentials > ambient `GITHUB_TOKEN` (`GH_TOKEN` is not the Action fallback).

| Credential | Purpose |
| --- | --- |
| `github-token` or `GITHUB_TOKEN` | GitHub discovery, opted-in checks, and native PR publication |
| `github-app-id`, `github-app-private-key` | Mint repository installation token (`github-app-installation-id` auto-discovers) |
| Provider token env var | Authenticate live model calls (supports comma-separated token pools) |
| `LOOPWRIGHT_GATE_SIGNING_SECRET` | Sign external `gate.v1` requests when a remote gate endpoint is used |
| `LOOPWRIGHT_PUBLICATION_SIGNING_SECRET` | Sign external publication endpoint requests |

Local `command.v1` gates and native publication use ephemeral loopback credentials and need no external signing secrets.

## Core inputs

All Action inputs are optional. Precedence is `Action with:` inputs > `taskpack.yaml` `spec.limits` > `LOOPWRIGHT_*` env vars > compiler defaults.

| Input | Default | Purpose |
| --- | --- | --- |
| `taskpack-path` / `suite-path` | `.loopwright/taskpack.yaml` / unset | Manifest or multi-domain `TaskpackSuite` path |
| `domain` / `resolve-suite-only` | Unset / `false` | Target suite domain or emit `outputs.matrix` only |
| `mode` / `baseline-alignment` | `candidate` / `off` | `auto\|candidate\|no-change` and 3-way conflict policy |
| `dry-run` / `force` | `false` / `false` | Compile statically without execution, or bypass `no_change`/dedupe |
| `event-name` / `event-path` | `workflow_dispatch` / unset | Pass `github.event_name` and `github.event_path` for trigger checks |
| `source-revision` / `upstream-records` | `GITHUB_SHA` / unset | Detached candidate base ref or precomputed upstream JSON |
| `allow-privileged-execution` | `false` | Dual-key unlock for privileged execution capabilities |
| `allow-workflow-writes` / `allow-host-mounts` | `false` / unset | Dual-key `.github/workflows/**` write unlock and host mount allowlist |
| `provider`, `model`, `thinking`, `api`, `base-url` | Taskpack model pool | Model, reasoning level, wire API, and gateway overrides |
| `wall-time-seconds`, `total-tokens`, `max-attempts` | `3600`, `20000000`, `5` | Execution limit overrides (see [Taskpack](/loopwright/main/docs/configuration/taskpack/index.md#execution-limits)) |

## Outputs

The Action writes a scrubbed `result` JSON summary to stdout and `GITHUB_OUTPUT`, and streams `[loopwright]` progress lines to stderr. A `compiled` result alone does not establish publication; inspect `delegateOutcome`.

| Output | Meaning |
| --- | --- |
| `result` | Compact structured summary and `delegateOutcome` (`ok`, `detail`) |
| `pr-url` | Published PR URL when available; otherwise empty |
| `memory-pr-url` | Separate memory PR URL when published or updated; otherwise empty |
| `total-tokens` | Exact integer token subtotal, or `0` when usage is unavailable |
| `cost-usd` | Six-decimal USD subtotal when provenance is `reported` or `estimated` |
| `matrix` | Deterministic JSON matrix (`{ include: [...] }`) when `suite-path` resolves |

Extended formats (`json`, `github-step-summary`, `markdown`, `text`) append a sanitized `Run Health` (`RunEval`) section with `toolRepeats`, `pingPong`, `repairConvergence`, and `autoApplied: false` hints. Missing cost is unknown, not zero.

## Triggers

Intake enforces `spec.triggers` strictly before `spec.preflight` or execution. Omitted or disabled triggers reject `schedule`, `workflow_dispatch`, `release`, `repository_dispatch`, and comment events fail-closed.

Install a workflow in each consumer repository. For centralized webhook intake and token brokering, see [GitHub App](/loopwright/main/docs/operations/github-app/index.md).

---

**See also** — [GitHub App](/loopwright/main/docs/operations/github-app/index.md) (configure webhook intake) · [Sandbox Backends](/loopwright/main/docs/configuration/sandbox-backends/index.md) (select execution isolation) · [Taskpack](/loopwright/main/docs/configuration/taskpack/index.md) (manifest schema and limits)

**Next** → [Declarative Taskpack](/loopwright/main/docs/walkthroughs/declarative-taskpack/index.md) — configure the repository manifest.
