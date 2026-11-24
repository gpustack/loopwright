# CLI and Action Reference

Evidence: contract.

Complete parameter, flag, output, exit-code, and configuration dictionary for Loopwright's reusable GitHub Action (`action.yml`), local `@gpustack/loopwright` CLI (`23` subcommand actions), and `GitHubAppConfig` webhook listener.

## Contents

- [GitHub Action inputs](#github-action-inputs)
- [GitHub Action outputs](#github-action-outputs)
- [CLI subcommands](#cli-subcommands)
- [CLI exit codes](#cli-exit-codes)
- [GitHubAppConfig](#githubappconfig)

## GitHub Action inputs

All 44 `action.yml` inputs are optional. Precedence order is `Action with:` inputs > `taskpack.yaml` `spec.limits` > `LOOPWRIGHT_*` environment variables > compiler defaults. Explicit `github-token` overrides App credentials, which override ambient `GITHUB_TOKEN` (`GH_TOKEN` is not the Action fallback).

| Input | Default | Purpose |
| --- | --- | --- |
| `taskpack-path` | `.loopwright/taskpack.yaml` | Repository-relative manifest path, including a custom control directory |
| `suite-path` | Unset | Optional repository-relative `TaskpackSuite` manifest path |
| `domain` | Unset | Optional target domain identifier within `suite-path` |
| `resolve-suite-only` | `false` | Set `true` with `suite-path` to emit `outputs.matrix` without running a domain |
| `baseline-alignment` | Taskpack `off` | 3-way conflict alignment override (`off`, `fail-fast`, `extract-context`) |
| `mode` | `candidate` | `auto` (preflight-driven candidate or check-only `no-change`), `candidate`, or `no-change` |
| `allow-privileged-execution` | `false` | Dual-key host unlock for `spec.execution.mode: privileged` or privileged capabilities |
| `allow-workflow-writes` | `false` | Dual-key host unlock allowing `allowWorkflowWrites: true` manifests to edit `.github/workflows/**` |
| `allow-host-mounts` | Unset | Dual-key comma/newline allowlist of absolute host paths or sockets for `command.v1` `parameters.mounts` |
| `event-name` | `workflow_dispatch` | GitHub event name; pass `github.event_name` for other triggers |
| `event-path` | Unset | Event payload path; pass `github.event_path` for comment and review events |
| `run-root` | `RUNNER_TEMP` or `../.loopwright-runs` | Trusted artifact root outside the checkout |
| `run-id` | `GITHUB_RUN_ID` or `local` | Stable run identifier |
| `storage-profile` | `actions-basic` | Host storage profile: `actions-basic` or `durable` |
| `provider`, `model`, `thinking` | Taskpack model pool | Override author model selection; thinking levels range from `off` to `max` |
| `api`, `base-url` | Inferred, unset | Wire API and trusted HTTPS endpoint override; `base-url` requires `api` |
| `provider-token-env` | Provider default | Environment variable containing a provider token or comma-separated pool |
| `models-json` | Unset | Trusted Pi model configuration path; shell credential resolvers are refused |
| `allow-custom-base-url` | `false` | Set `true` to permit model base URLs declared in the taskpack |
| `dry-run` | `false` | Set `true` to compile without executing the controller |
| `force` | `false` | Set `true` on non-comment triggers to bypass `no_change` and open-PR deduplication |
| `gate-endpoint-url` | Unset | External gate endpoint, bound as `default` |
| `publication-endpoint-url` | Unset | External managed publication endpoint; otherwise native PR publication is available |
| `output` | Taskpack formats or `json` | Comma-separated output formats (`json`, `github-step-summary`, `markdown`, `text`) |
| `github-token` | `GITHUB_TOKEN` fallback | GitHub token for discovery, opted-in checks, and publication; overrides App auth |
| `github-app-id` | Unset | App ID for installation token minting (overrides ambient `GITHUB_TOKEN`) |
| `github-app-private-key` | Unset | App PEM private key for installation token minting |
| `github-app-installation-id` | Auto-discovered | Optional installation ID; discovered from `owner/repo` when omitted |
| `git-author-name` | Dynamic or `github-actions[bot]` | Optional commit author, committer, and DCO `Signed-off-by` name override |
| `git-author-email` | Dynamic noreply email | Optional commit author, committer, and DCO `Signed-off-by` email override |
| `upstream-records` | Unset | JSON array of precomputed upstream records (`github-release`, `git-tag`, `git-commit`, `http-json`, `custom-table`) |
| `source-revision` | `GITHUB_SHA` | Git commit SHA or ref materialized as candidate source tree while keeping `GITHUB_SHA` as base |
| `mcp-servers` | Taskpack `spec.mcp.servers` | JSON or YAML MCP server declarations merged by `id` (`LOOPWRIGHT_MCP_SERVERS` fallback) |
| `wall-time-seconds` | `3600` | Run wall-time limit override (`60..21600`; `LOOPWRIGHT_WALL_TIME_SECONDS`) |
| `total-tokens` | `20000000` | Total token ceiling (`1000..1000000000`; `LOOPWRIGHT_TOTAL_TOKENS`) |
| `context-window` | Model catalog or `128000` | Model context window token override (`1024..10000000`; `LOOPWRIGHT_CONTEXT_WINDOW`) |
| `max-output-tokens` | `32768` | Per-call output token ceiling (`256..262144`; `LOOPWRIGHT_MAX_OUTPUT_TOKENS`) |
| `max-model-calls` | `256` | Maximum model call count per run (`1..1024`; `LOOPWRIGHT_MAX_MODEL_CALLS`) |
| `max-attempts` | `5` | Maximum controller attempt count (`1..16`; `LOOPWRIGHT_MAX_ATTEMPTS`) |
| `tool-timeout-seconds` | `300` | Per-tool execution timeout (`1..1800`; `LOOPWRIGHT_TOOL_TIMEOUT_SECONDS`) |
| `command-timeout-seconds` | `30` | Fallback `command.v1` check timeout (`1..3600`; `LOOPWRIGHT_COMMAND_TIMEOUT_SECONDS`) |

## GitHub Action outputs

| Output | Format and meaning |
| --- | --- |
| `result` | Compact structured entrypoint summary and `delegateOutcome` (`ok`, `detail`) |
| `pr-url` | Published PR URL when available; otherwise empty |
| `memory-pr-url` | Separate memory PR URL when published or updated; otherwise empty |
| `total-tokens` | Exact integer token subtotal, or `0` when usage is unavailable |
| `cost-usd` | Six-decimal USD known subtotal when cost provenance is `reported` or `estimated`; otherwise omitted |
| `matrix` | Deterministic JSON matrix (`{ include: [...] }`) emitted when `suite-path` resolves |

- **Output formats**: `json` (stdout and `GITHUB_OUTPUT`), `github-step-summary` (`GITHUB_STEP_SUMMARY`), `markdown` (stderr), and `text` (stderr). Each emits a sanitized `Run Health` (`RunEval`) section with `toolRepeats`, `pingPong`, `repairConvergence`, per-role/per-step breakdowns, and `autoApplied: false` hints.
- **Native CAS publication**: Opens each verified CAS blob once (`O_RDONLY | O_NOFOLLOW`, `nlink === 1`), streams `1 MiB` chunks into `git hash-object -w --stdin`, commits via temporary `GIT_INDEX_FILE` with DCO sign-off and `--force-with-lease`, and leaves uncertain remote effects `unknown`.

## CLI subcommands

CLI limits total `argv` to `64` entries and repeatable `--role-model ROLE=PROVIDER/MODEL[:THINKING]` to `8` unique roles. `run`, `resume`, `step next`, and `step submit` accept `--allow-privileged` and `--allow-workflow-writes`; `run`, `step next`, and `step submit` also accept `--allow-host-mounts <csv>`; `reconcile` accepts `--allow-workflow-writes` only; managed `run --dry-run` (`--config`) and `runner` refuse all privilege flags.

| Subcommand | Required flags | Optional flags | Purpose |
| --- | --- | --- | --- |
| `init` | `--directory` | `--force`, `--json` | Emit `controller.draft.yaml` and `registry.draft.yaml` |
| `check` | `--config`, `--registry`, `--registry-sha256` | `--role-model`, `--output`, `--json` | Compile and verify configuration and registry digest statically |
| `digest sync` | `--taskpack` | `--repo`, `--check`, `--json` | Write or verify `digests.lock.json` SHA-256 digests (`DIGEST_LOCKFILE_DRIFT` exit `4`) |
| `suite check` | `--suite` | `--repo`, `--verify-digests`, `--json` | Validate `TaskpackSuite`, protected union, and prefix disjointness |
| `suite resolve` | `--suite` | `--repo`, `--event`, `--schedule`, `--comment-body`, `--pr-head-ref`, `--pr-base-ref`, `--domain`, `--json` | Resolve domain matrix, PR comments, and stage readiness |
| `run` | `--taskpack` or `--config`+`--registry`+`--registry-sha256`, `--repo`, `--run-root`, `--run-id` | `--mode`, `--baseline-alignment`, `--source-revision`, `--role-model`, privilege flags, `--json`, `--output-format`, `--step-summary-file` | Execute a local taskpack or managed controller run |
| `run --dry-run` | `--dry-run` with `--taskpack`+`--repo` or `--config`+`--registry`+`--registry-sha256` | `--mode`, `--baseline-alignment`, `--source-revision`, `--role-model`, `--output`, `--json` | Compile plan statically without preflight, memory, or publication |
| `resume` | `--config`, `--registry`, `--registry-sha256`, `--repo`, `--run-root`, `--run-id` | `--role-model`, `--allow-privileged`, `--allow-workflow-writes`, `--json`, `--output-format`, `--step-summary-file` | Resume an existing run under identical trusted bindings |
| `step` | `--run-root`, `--run-id`, action (`next\|submit\|cancel`) | `--action`, `--taskpack` or config flags, `--repo`, `--mode`, `--role-model`, `--reissue-lease`, `--lease`, `--status`, `--submission-file`, `--reason`, privilege flags, `--json` | Pull, submit, or cancel delegated work |
| `status` | `--run-root`, `--run-id` | `--json` | Read current run stage, lease state, and checkpoint summary |
| `inspect` | `--run-root`, `--run-id` | `--output`, `--json` | Export redacted receipts, `candidate.files.json`, `run-eval.json`, and diagnostics |
| `reconcile` | `--config`, `--registry`, `--registry-sha256`, `--repo`, `--run-root`, `--run-id`, `--receipt` | `--allow-workflow-writes`, `--output`, `--json`, `--output-format`, `--step-summary-file` | Settle an unknown external outcome with an authenticated receipt |
| `closure` | None | `--repo`, `--output`, `--verify-failures`, `--json` | Audit the 23-capability closure matrix and 14-case failure suite |
| `app-serve` | `--config` | `--repo`, `--json` | Start the opt-in GitHub App HTTP webhook and token listener |
| `runner relay` | `--config` | `--json` | Start the outbound-pull benchmark relay and CAS server |
| `runner worker` | `--config` | `--once`, `--json` | Poll relay leases and execute two-stage hardware benchmarks |
| `evolve check` | `--campaign` | `--repo`, `--json` | Validate an `EvolutionCampaign`, taskpack, and target cell |
| `evolve run` | `--campaign`, `--state` | `--repo`, `--out`, `--format`, `--allow-synthetic-probe`, `--json` | Run an evolutionary campaign over isolated child runs |
| `evolve resume` | `--campaign` (or `--root`) | `--repo`, `--out`, `--format`, `--allow-synthetic-probe`, `--json` | Resume a paused or preempted campaign from `campaign.sqlite` |
| `evolve status` | `--campaign` (or `--root`) | `--json` | Read campaign stage, generation, evaluations, and island state |
| `evolve inspect` | `--campaign` (or `--root`) | `--island`, `--individual`, `--json` | Inspect Pareto frontier, niches, teams, and lineage edges |
| `evolve export` | `--campaign` (or `--root`), `--out` | `--format`, `--allow-synthetic-probe`, `--overwrite`, `--json` | Export a verified `evolution-bundle.v1` package |

### Runner and evolve environment

| Environment variable | Purpose |
| --- | --- |
| `LOOPWRIGHT_BENCHMARK_GATE_URL` | Fallback HTTPS or loopback `benchmark-gate.v1` submission URL for `runner relay` |
| `LOOPWRIGHT_GATE_SIGNING_SECRET` | Required HMAC secret for benchmark submission and fail-closed `evolve export` (`BENCH_SIGNING_SECRET` fallback) |
| `LOOPWRIGHT_GATE_AUTH_TOKEN` | Optional bearer token bound to `authCredentialRef` on remote `runner relay` endpoints |
| `LOOPWRIGHT_MODELS_JSON` | Optional Pi `models.json` path for custom providers and local model endpoints |

## CLI exit codes

| Code | Meaning |
| --- | --- |
| `0` | Completed, no change, successful static command, or `suite` `eligible`/`deferred`/`ignored` |
| `2` | Usage, configuration, unknown `--domain`, or `TaskpackSuite`/`EvolutionCampaign` manifest rejected |
| `3` | Unsupported capability, blocked work, `TEAM_ENVELOPE_VIOLATION`, `EXPORT_UNVERIFIED_FORBIDDEN`, `WORKER_DEVICE_QUARANTINED`, or `baseline_merge_conflict` |
| `4` | Execution, acceptance, `DIGEST_LOCKFILE_DRIFT`, or artifact validation failed |
| `5` | Allowance or campaign budget exhausted |
| `6` | Deadline expired |
| `7` | Reconciliation, `EVOLUTION_CONFLICT`, `EVOLUTION_LEASE_FENCED`, `EVOLUTION_CLOCK_DRIFT`, or fenced runner lease (`QUEUE_LEASE_FENCED`) |
| `8` | Authoritative result unavailable, incident, store corruption, `RUNNER_TEARDOWN_FAILED`, or `RUNNER_TRANSPORT_ERROR` |
| `130` | Step cancellation, paused evolution campaign, or accounted `SIGINT` (subject to uncertainty precedence) |
| `143` | Accounted `SIGTERM` (subject to uncertainty or fenced preemption precedence) |

## GitHubAppConfig

| Field path | Required | Default | Bounds and constraint |
| --- | --- | --- | --- |
| `apiVersion` | Yes | — | Must be `'loopwright.dev/v1alpha1'` |
| `kind` | Yes | — | Must be `'GitHubAppConfig'` (`<= 64 KiB` file) |
| `spec.appId` | Yes | — | Non-empty GitHub App numeric ID or slug (`1–64` chars) |
| `spec.webhookSecretEnv` | Yes | — | Uppercase env var name (`[A-Z][A-Z0-9_]*`) holding HMAC secret |
| `spec.privateKeyEnv` | Yes | — | Uppercase env var name (`[A-Z][A-Z0-9_]*`) holding App PEM |
| `spec.apiBaseUrl` | No | `https://api.github.com` | HTTPS URL (or loopback HTTP); used for tokens and `issue_comment` PR lookup |
| `spec.listen` | Conditional | Unset | Optional mapping; required with `enabled: true` to run `app-serve` |
| `spec.listen.enabled` | No | `false` | Set `true` to enable `loopwright app-serve` |
| `spec.listen.host` | Conditional | `127.0.0.1` | Required when `spec.listen` is present; keep tenant routes private |
| `spec.listen.port` | Conditional | `8787` | Required when `spec.listen` is present; integer `0–65535` |
| `spec.listen.webhookPath` | No | `/webhooks/github` | Leading `/` path; cannot collide with `/healthz` or `/tenants/*` |
| `spec.tokenTtlSeconds` | No | `600` | Integer `60–3600` cached installation token ceiling |
| `spec.maxPayloadBytes` | No | `1048576` | Integer `1024–26214400` inbound webhook byte cap |
| `spec.taskpackPath` | No | Unset | Relative regular-file path validated at startup (mutually exclusive with `suitePath`) |
| `spec.suitePath` | No | Unset | Relative `TaskpackSuite` path validated at startup (mutually exclusive with `taskpackPath`) |
| `spec.operatorAllowlist` | No | Unset | GitHub login list (`1–64` entries) authorized for slash commands |

---

**See also** — [Reference Hub](README.md) (flat reference routing and exact aliases) · [GitHub Action](../operations/github-action.md) (workflow setup and permissions) · [CLI](../operations/cli.md) (operator workflows and recovery) · [GitHub App](../operations/github-app.md) (App registration and webhook admission)
