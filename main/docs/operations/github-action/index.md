# GitHub Action

The reusable Action runs a taskpack cycle in a consumer repository without a resident server. It executes optional host preflight, discovers upstream changes, verifies candidates, and can publish a managed pull request.

## Contents

- [Workflow](#workflow)
- [Execution and publication](#execution-and-publication)
- [Secrets and environment](#secrets-and-environment)
- [Inputs](#inputs)
- [Outputs](#outputs)
- [Triggers](#triggers)

## Workflow

Install a taskpack and configure the provider and App secrets before enabling this workflow. The App installation needs repository contents and pull request write permissions for native publication.

```yaml
name: loopwright
on:
  schedule:
    - cron: '0 3 * * *'
  workflow_dispatch: {}
  issue_comment:
    types: [created]
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
          baseline-alignment: 'off' # Optional (off, fail-fast, extract-context)
          mode: auto # Optional (auto, candidate, or no-change)
          allow-privileged-execution: 'false' # Optional dual-key host unlock
          allow-workflow-writes: 'false' # Optional dual-key workflow write unlock
          event-name: ${{ github.event_name }}
          event-path: ${{ github.event_path }}
          github-app-id: ${{ secrets.LOOPWRIGHT_APP_ID }}
          github-app-private-key: ${{ secrets.LOOPWRIGHT_APP_PRIVATE_KEY }}
          github-app-installation-id: ${{ secrets.LOOPWRIGHT_APP_INSTALLATION_ID }} # Optional
          output: json,github-step-summary # Optional
        env:
          ZAI_API_KEY: ${{ secrets.ZAI_API_KEY }}
```

- **Mode `auto`**: Runs `spec.preflight` or upstream discovery, dispatches `candidate` when updates exist or `force` is `'true'`, and compiles a check-only `no-change` run with zero agent model calls when settled.
- **Suite matrix**: Pass `suite-path` with `resolve-suite-only: 'true'` to emit `outputs.matrix` (`{ include: [...] }`), then run each matrix job with `domain: ${{ matrix.domainId }}` for per-job revalidation.
- **Comment checkout**: Workflows triggered on `issue_comment` should fetch the PR head commit when running candidate checkout (`Suite` lookup verifies `head.repo.full_name`, `base.ref`, `head.ref`, and `head.sha`).
- **Dual-key authority**: Even under `spec.execution.mode: strict`, enabling `allowHostEnv`, `allowHostPath`, `mountReadOnlyGit`, `allowCheckNetwork`, `allowAgentNetwork`, or `command.v1` `mountReadOnlyGit: true` requires `allow-privileged-execution: 'true'`. Enabling `allowWorkflowWrites: true` independently requires `allow-workflow-writes: 'true'`.
- **Provider**: Set the token variable for the selected model, not necessarily `ZAI_API_KEY`.
- **Runtime**: The Action sets up Node.js 26 and builds the workspace if its entrypoint is absent.

## Execution and publication

A live Action enforces `policyProfile: github` (persisted in `run.json`), validates `spec.triggers` strictly **before** `spec.preflight`, resolves repository identity and revisions, authorizes the actor, initializes `SecretScrubber`, runs `spec.preflight`, and checks for an existing managed PR.

When `suite-path` is set, intake resolves `.loopwright/suite.yaml` (verifying PR ownership via GitHub API on `issue_comment` and refusing cross-fork PRs or domain conflicts), enforces the suite-wide protected union, and revalidates domain eligibility per matrix job before compiling outside the checkout.

| Stage | Behavior |
| --- | --- |
| Preflight | Validates `spec.triggers` (and `suite-path` domain/stage probes) first, then runs `spec.preflight.script` after actor auth and scrubber setup |
| Align | When `sourceRevision !== baseRevision`, runs isolated 3-way `git merge-tree` (`fail-fast` blocks conflicts; `extract-context` stages scrubbed hunks) before model probes |
| Discover | Resolves upstreams, `upstreamGroups` lockstep holds (`held_back`), or `upstream-records`; `mode: auto` routes `no_change` to check-only checks |
| Execute | Authors a candidate in sandboxed steps with CAS blob pointers and verifies scope and local or external checks; eligible failures can enter bounded repair or `rejectTo` rework |
| Publish | For `pull_request` mode, consumes shared 3-way merged carry blobs, verifies extracted conflict resolution, and streams verified CAS blobs into a managed PR |

Pass `source-revision` when preflight stages writable files onto a commit separate from `GITHUB_SHA`. Local checks and publication keep protected and non-writable files at `GITHUB_SHA`, and squash writable changes onto a commit parented on `GITHUB_SHA`.

Native publication opens each verified CAS blob once (`O_RDONLY | O_NOFOLLOW`, `nlink === 1`), streams `1 MiB` chunks into `git hash-object -w --stdin` while verifying SHA-256 and Git blob OID, and commits via a temporary `GIT_INDEX_FILE` with DCO sign-off and `--force-with-lease`. It does not embed credentials in remote URLs. An uncertain external outcome remains `unknown`; do not silently retry it.

Memory finalization follows `spec.memory.apply` (`separate-pull-request`, `local-only`, or `disabled`) and opens cleanup PRs when stale entries retire. Separate memory PRs skip non-passing runs by default (`publishOnFailure: false`) and add `[skip ci]` before the DCO trailer (`skipCi: true`). Memory errors or skipped updates never block primary task completion.

Local `command.v1` checks run through a signed loopback gate against a verified candidate snapshot, mounting the check script's parent directory read-only with whole-tree SHA-256 verification and exposing `$LOOPWRIGHT_BASE_DIR`, `$LOOPWRIGHT_STAGED_DIR` (when `exposeToChecks: true`), and `$LOOPWRIGHT_CHECK_OUT`. If a check opts into a GitHub token, grant that token only the permissions the check may use.

On GitHub-hosted Actions runners (`GITHUB_ACTIONS=true` and `RUNNER_ENVIRONMENT=github-hosted`), an omitted `spec.sandbox` selects `direct-dedicated`. Self-hosted runners negotiate host OS sandboxes instead. The turnkey host session supports `macos-seatbelt`, `linux-bwrap`, `linux-landlock`, and `direct-dedicated`, and blocks `docker`. See [Sandbox Backends](/loopwright/main/docs/configuration/sandbox-backends/index.md) for isolation tradeoffs.

Protected paths override writable paths. `.github/workflows/**` stays write-protected unless both `spec.execution.capabilities.allowWorkflowWrites: true` and `allow-workflow-writes: 'true'` are set. See [Taskpack](/loopwright/main/docs/configuration/taskpack/index.md) for full manifest fields.

## Secrets and environment

Pass `github-token` directly, or pass `github-app-id` and `github-app-private-key` to mint an installation token. Explicit `github-token` takes precedence over App credentials, and App credentials take precedence over ambient `GITHUB_TOKEN`. When `github-app-installation-id` is omitted, the Action discovers the repository installation automatically. `GH_TOKEN` is not the Action token fallback.

The App ID and optional installation ID must be positive integers. The private key is a PEM secret. Restrict installation access to the target repository and required permissions. App tokens can trigger downstream workflows under GitHub's App event rules.

| Credential | Purpose |
| --- | --- |
| `github-token` or `GITHUB_TOKEN` | GitHub discovery and native PR publication; permissions depend on the operations used. |
| `github-app-id`, `github-app-private-key`, `github-app-installation-id` | Mint a repository installation token; installation ID is auto-discovered when omitted. |
| Provider token environment | Authenticate live model calls; token variables can contain comma-separated token pools. |
| `LOOPWRIGHT_GATE_SIGNING_SECRET` | Sign external gate requests when a gate endpoint is configured. |
| `LOOPWRIGHT_PUBLICATION_SIGNING_SECRET` | Sign requests to an external publication endpoint. |

Local command gates and native publication use ephemeral loopback credentials. They do not require external endpoint signing secrets. Generated registry and controller files contain secret references, not raw credentials. Never commit secrets to the repository.

## Inputs

All Action inputs are optional. Conditional credentials, endpoint bindings, and event payloads depend on the taskpack and trigger.

| Input | Default | Purpose |
| --- | --- | --- |
| `taskpack-path` | `.loopwright/taskpack.yaml` | Repository-relative manifest path, including a custom control directory. |
| `suite-path` | Unset | Optional repository-relative `TaskpackSuite` manifest path (for example `.loopwright/suite.yaml`). |
| `domain` | Unset | Optional target domain identifier within `suite-path`. |
| `resolve-suite-only` | `false` | Set `true` with `suite-path` to emit `outputs.matrix` without executing a domain run. |
| `baseline-alignment` | Taskpack `off` | Optional 3-way conflict alignment override (`off`, `fail-fast`, or `extract-context`). |
| `mode` | `candidate` | `auto` (preflight-driven candidate or check-only `no-change`), `candidate`, or `no-change`. |
| `allow-privileged-execution` | `false` | Dual-key host unlock for `spec.execution.mode: privileged` or privileged capabilities. |
| `allow-workflow-writes` | `false` | Dual-key host unlock allowing `allowWorkflowWrites: true` manifests to edit `.github/workflows/**`. |
| `event-name` | `workflow_dispatch` | GitHub event name; pass `github.event_name` for other triggers. |
| `event-path` | Unset | Event payload path; pass `github.event_path` for comment and review events. |
| `run-root` | `RUNNER_TEMP` or `../.loopwright-runs` | Trusted artifact root outside the checkout. |
| `run-id` | `GITHUB_RUN_ID` or `local` | Stable run identifier. |
| `storage-profile` | `actions-basic` | Host storage profile: `actions-basic` or `durable`. |
| `provider`, `model`, `thinking` | Taskpack model pool | Override author model selection; thinking levels range from `off` to `max`. |
| `api`, `base-url` | Inferred, unset | Wire API and trusted HTTPS endpoint override; `base-url` requires `api`. |
| `provider-token-env` | Provider default | Environment variable containing a provider token or comma-separated pool. |
| `models-json` | Unset | Trusted Pi model configuration path; shell credential resolvers are refused. |
| `allow-custom-base-url` | `false` | Set `true` to permit model base URLs declared in the taskpack. |
| `dry-run` | `false` | Set `true` to compile without executing the controller. |
| `force` | `false` | Set `true` on non-comment triggers to bypass `no_change` and open-PR deduplication. |
| `gate-endpoint-url` | Unset | External gate endpoint, bound as `default`. |
| `publication-endpoint-url` | Unset | External managed publication endpoint; otherwise native PR publication is available. |
| `output` | Taskpack formats or `json` | Comma-separated output formats; overrides `spec.output.formats`. |
| `github-token` | `GITHUB_TOKEN` fallback | GitHub token for discovery, opted-in checks, and publication; explicit input overrides App auth. |
| `github-app-id` | Unset | App ID for installation token minting (overrides ambient `GITHUB_TOKEN`). |
| `github-app-private-key` | Unset | App PEM private key for installation token minting. |
| `github-app-installation-id` | Auto-discovered | Optional installation ID; discovered from `owner/repo` when omitted. |
| `git-author-name` | Dynamic or `github-actions[bot]` | Optional commit author, committer, and DCO `Signed-off-by` name override. |
| `git-author-email` | Dynamic noreply email | Optional commit author, committer, and DCO `Signed-off-by` email override. |
| `upstream-records` | Unset | JSON array of precomputed upstream acquisition records (`github-release`, `git-tag`, `git-commit`, `http-json`, or `custom-table`). |
| `source-revision` | `GITHUB_SHA` | Git commit SHA or ref materialized as the candidate source tree while keeping `GITHUB_SHA` as base revision. |
| `mcp-servers` | Taskpack `spec.mcp.servers` | JSON or YAML MCP server declarations merged by `id` (`LOOPWRIGHT_MCP_SERVERS` fallback). |
| `wall-time-seconds` | `3600` | Run wall-time limit override in seconds (`60..21600`; `LOOPWRIGHT_WALL_TIME_SECONDS`). |
| `total-tokens` | `20000000` | Total token ceiling across model calls (`1000..1000000000`; `LOOPWRIGHT_TOTAL_TOKENS`). |
| `context-window` | Model catalog or `128000` | Model context window token override (`1024..10000000`; `LOOPWRIGHT_CONTEXT_WINDOW`). |
| `max-output-tokens` | `32768` | Per-call output token ceiling (`256..262144`; `LOOPWRIGHT_MAX_OUTPUT_TOKENS`). |
| `max-model-calls` | `256` | Maximum model call count per run (`1..1024`; `LOOPWRIGHT_MAX_MODEL_CALLS`). |
| `max-attempts` | `5` | Maximum controller attempt count (`1..16`; `LOOPWRIGHT_MAX_ATTEMPTS`). |
| `tool-timeout-seconds` | `300` | Per-tool execution timeout in seconds (`1..1800`; `LOOPWRIGHT_TOOL_TIMEOUT_SECONDS`). |
| `command-timeout-seconds` | `30` | Fallback `command.v1` check timeout in seconds (`1..3600`; `LOOPWRIGHT_COMMAND_TIMEOUT_SECONDS`). |

Explicit configuration takes precedence over environment variables (`Action with:` inputs > `taskpack.yaml` `spec.limits` > `LOOPWRIGHT_*` environment variables > compiler defaults). Repair sub-budgets and byte or entry ceilings also accept canonical `spec.limits` keys and `LOOPWRIGHT_*` fallbacks; see [Taskpack](/loopwright/main/docs/configuration/taskpack/index.md#execution-limits). Interactive OAuth and CLI providers or MCP servers are unsupported.

The `force` input applies only to candidate discovery on non-comment trigger events (`workflow_dispatch`, `schedule`, `repository_dispatch`, `release`), while PR comment commands (`/auto-sync retry`, `revise`, `status`) follow comment-command dispatch semantics.

## Outputs

The Action writes a compact, scrubbed `result` JSON summary (with SHA-256 digests and byte lengths rather than raw binary buffers) to stdout and `GITHUB_OUTPUT`. Live runs stream `[loopwright]` progress lines (upstream discovery, connected MCP servers, per-turn token/duration metrics, tool calls, and check outcomes) plus a plain-text run summary to stderr. A `compiled` result alone does not establish successful publication; inspect `delegateOutcome` and the run report.

| Output | Meaning |
| --- | --- |
| `result` | Compact structured entrypoint summary and `delegateOutcome` (`ok`, `detail`). |
| `pr-url` | Published PR URL when available; otherwise empty. |
| `memory-pr-url` | Separate memory PR URL when published or updated; otherwise empty. |
| `total-tokens` | Exact integer token subtotal, or `0` when usage is unavailable. |
| `cost-usd` | Six-decimal USD known subtotal when cost provenance is `reported` or `estimated`; otherwise omitted. |
| `matrix` | Deterministic JSON matrix (`{ include: [...] }`) emitted when `suite-path` resolves. |

Extended outputs are written for live runs, or for dry runs with an explicit `output` input. `github-step-summary`, `markdown`, `text`, and `json` include a sanitized `Run Health` (`RunEval`) section with `toolRepeats`, `pingPong`, `repairConvergence`, per-role/per-step breakdowns, and `autoApplied: false` hints.

Step summaries and human-readable reports format token counts using `K`/`M`/`B` and elapsed durations using `ms`/`s`/`m`/`h`, while `total-tokens` and JSON reports preserve exact integers. Estimated cost uses model pricing, not provider-attested billing; missing cost is unknown, not zero.

| Format | Destination |
| --- | --- |
| `json` | Structured Action result remains on stdout and `GITHUB_OUTPUT`. |
| `github-step-summary` | Markdown report appended to `GITHUB_STEP_SUMMARY` when available. |
| `markdown` | Human-readable report on stderr. |
| `text` | Plain-text report on stderr. |

`totalTokens` is the primary usage metric across sinks, with `inputTokens` and `outputTokens` breakdowns when available.
Human-readable summaries show cost only for `reported` or `estimated` provenance.
Reports include usage provenance when available. Output is scrubbed and workflow command text is neutralized. Local and fixture tests do not qualify live GitHub publication or provider billing.

## Triggers

Intake enforces `spec.triggers` strictly before `spec.preflight` or execution. Omitted or disabled triggers reject `schedule`, `workflow_dispatch`, `release`, `repository_dispatch`, and comment events fail-closed. Pass the event name and payload explicitly as shown above; comment commands also require actor authorization.

Install a workflow in each consumer repository. For centralized webhook intake and token brokering, see [GitHub App](/loopwright/main/docs/operations/github-app/index.md).

---

**See also** — [GitHub App](/loopwright/main/docs/operations/github-app/index.md) (configure webhook intake) · [Sandbox Backends](/loopwright/main/docs/configuration/sandbox-backends/index.md) (select execution isolation)

**Next** → [Declarative Taskpack](/loopwright/main/docs/walkthroughs/declarative-taskpack/index.md) — configure the repository manifest.
