# GitHub Action

The reusable Action runs a taskpack cycle in a consumer repository without a resident server. It discovers upstream changes, verifies candidates, and can publish a managed pull request.

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
          event-name: ${{ github.event_name }}
          event-path: ${{ github.event_path }}
          github-app-id: ${{ secrets.LOOPWRIGHT_APP_ID }}
          github-app-private-key: ${{ secrets.LOOPWRIGHT_APP_PRIVATE_KEY }}
          github-app-installation-id: ${{ secrets.LOOPWRIGHT_APP_INSTALLATION_ID }}
          output: json,github-step-summary # Optional
        env:
          ZAI_API_KEY: ${{ secrets.ZAI_API_KEY }}
```

- **Taskpack**: Set publication to `pull_request` to enable native PR publication, or `disabled` to omit it.
- **Provider**: Set the token variable for the selected model, not necessarily `ZAI_API_KEY`.
- **Runtime**: The Action sets up Node.js 26 and builds the workspace if its entrypoint is absent.
- **Dry run**: Set `dry-run: 'true'` to compile without running the controller.

## Execution and publication

A live Action resolves repository identity and revisions, discovers upstreams, and looks for an existing managed PR. It compiles trusted artifacts outside the checkout, then runs the controller for admitted work.

| Stage | Behavior |
| --- | --- |
| Discover | Read GitHub releases, Git tags or commits, HTTP JSON, or custom tables; compare versions with the proposal. |
| Execute | Author a candidate and verify scope and configured checks; eligible failures can enter bounded repair. |
| Publish | For `pull_request` mode, create or update a managed PR after verification. |

Use `upstream-records` to supply precomputed acquisition records instead of live discovery. Matching upstream state can settle as `no_change`. Unavailable upstreams can block execution.

Native publication uses a detached `git worktree`, a signed-off diff-only commit, and `--force-with-lease`. It does not embed credentials in remote URLs. An uncertain external outcome remains `unknown`; do not silently retry it.

Local `command.v1` checks run through a signed loopback gate against a verified candidate snapshot. The Action verifies each script digest and passes a limited environment. If a check opts into a GitHub token, it receives the resolved token; grant that token only the permissions the check may use.

On GitHub Actions, an omitted `spec.sandbox` selects `direct-dedicated`. This uses host process isolation, not a container security boundary. The turnkey host session supports `macos-seatbelt`, `linux-bwrap`, `linux-landlock`, and `direct-dedicated`, and blocks `docker`. See [Sandbox Backends](../configuration/sandbox-backends.md) for isolation tradeoffs.

Protected paths override writable paths. Workflow files and taskpack control assets remain protected. See [Taskpack](../configuration/taskpack.md) for scope, instructions, and check configuration.

## Secrets and environment

Pass a token with `github-token`, or provide all three App inputs to mint an installation token inside the Action. A nonempty `github-token` takes precedence, followed by `GITHUB_TOKEN`; either prevents App token minting. `GH_TOKEN` is not the Action token fallback.

The App ID and installation ID must be positive integers. The private key is a PEM secret. Restrict installation access to the target repository and required permissions. App tokens can trigger downstream workflows under GitHub's App event rules.

| Credential | Purpose |
| --- | --- |
| `github-token` or `GITHUB_TOKEN` | GitHub discovery and native PR publication; permissions depend on the operations used. |
| `github-app-id`, `github-app-private-key`, `github-app-installation-id` | Mint an installation token when no direct token is supplied. |
| Provider token environment | Authenticate live model calls; token variables can contain comma-separated token pools. |
| `LOOPWRIGHT_GATE_SIGNING_SECRET` | Sign external gate requests when a gate endpoint is configured. |
| `LOOPWRIGHT_PUBLICATION_SIGNING_SECRET` | Sign requests to an external publication endpoint. |

Local command gates and native publication use ephemeral loopback credentials. They do not require external endpoint signing secrets. Generated registry and controller files contain secret references, not raw credentials. Never commit secrets to the repository.

## Inputs

All Action inputs are optional. Conditional credentials, endpoint bindings, and event payloads depend on the taskpack and trigger.

| Input | Default | Purpose |
| --- | --- | --- |
| `taskpack-path` | `.loopwright/taskpack.yaml` | Repository-relative manifest path, including a custom control directory. |
| `mode` | `candidate` | `candidate` or `no-change` cycle mode. |
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
| `gate-endpoint-url` | Unset | External gate endpoint, bound as `default`. |
| `publication-endpoint-url` | Unset | External managed publication endpoint; otherwise native PR publication is available. |
| `output` | Taskpack formats or `json` | Comma-separated output formats; overrides `spec.output.formats`. |
| `github-token` | `GITHUB_TOKEN` or unset | GitHub token for discovery, opted-in checks, and publication. |
| `github-app-id` | Unset | App ID for installation token minting. |
| `github-app-private-key` | Unset | App PEM private key for installation token minting. |
| `github-app-installation-id` | Unset | Installation ID for token minting. |
| `upstream-records` | Unset | JSON array of precomputed upstream acquisition records. |
| `mcp-servers` | Taskpack `spec.mcp.servers` | JSON or YAML MCP server declarations merged by `id` (`LOOPWRIGHT_MCP_SERVERS` fallback). |
| `wall-time-seconds` | `3600` | Run wall-time limit override in seconds (`60..21600`; `LOOPWRIGHT_WALL_TIME_SECONDS`). |
| `total-tokens` | `20000000` | Total token ceiling across model calls (`1000..1000000000`; `LOOPWRIGHT_TOTAL_TOKENS`). |
| `context-window` | Model catalog or `128000` | Model context window token override (`1024..10000000`; `LOOPWRIGHT_CONTEXT_WINDOW`). |
| `max-output-tokens` | `32768` | Per-call output token ceiling (`256..262144`; `LOOPWRIGHT_MAX_OUTPUT_TOKENS`). |
| `max-model-calls` | `256` | Maximum model call count per run (`1..1024`; `LOOPWRIGHT_MAX_MODEL_CALLS`). |
| `max-attempts` | `4` | Maximum controller attempt count (`1..16`; `LOOPWRIGHT_MAX_ATTEMPTS`). |
| `tool-timeout-seconds` | `300` | Per-tool execution timeout in seconds (`5..1800`; `LOOPWRIGHT_TOOL_TIMEOUT_SECONDS`). |
| `command-timeout-seconds` | `30` (`<= 3600`) | `command.v1` local check timeout override (`1..3600`; `LOOPWRIGHT_COMMAND_TIMEOUT_SECONDS`). |

Limit overrides apply in strict order (`INPUT_*` > `LOOPWRIGHT_*` > `spec.limits` > compiler defaults). Additional byte and session ceilings (`LOOPWRIGHT_RESPONSE_BYTES`, `LOOPWRIGHT_TOOL_RESULT_BYTES`, `LOOPWRIGHT_FILE_BYTES`, `LOOPWRIGHT_SESSION_BYTES`) also accept environment overrides. Interactive OAuth and CLI providers or MCP servers are unsupported. Model and MCP options are listed in [Taskpack](../configuration/taskpack.md#model-configuration).

## Outputs

The Action writes a compact, scrubbed `result` JSON summary (with SHA-256 digests and byte lengths rather than raw binary buffers) to stdout and `GITHUB_OUTPUT`. Live runs stream `[loopwright]` progress lines (upstream discovery, connected MCP servers, per-turn token/duration metrics, tool calls, and check outcomes) plus a plain-text run summary to stderr. A `compiled` result alone does not establish successful publication; inspect `delegateOutcome` and the run report.

| Output | Meaning |
| --- | --- |
| `result` | Compact structured entrypoint summary and `delegateOutcome` (`ok`, `detail`). |
| `pr-url` | Published PR URL when available; otherwise empty. |
| `total-tokens` | Exact integer token subtotal, or `0` when usage is unavailable. |
| `cost-usd` | Six-decimal USD known subtotal when cost provenance is `reported` or `estimated`; otherwise omitted. |

Extended outputs are written for live runs, or for dry runs with an explicit `output` input. Step summaries and human-readable reports format token counts using `K`/`M`/`B` and elapsed durations using `ms`/`s`/`m`/`h`, while `total-tokens` and JSON reports preserve exact integer counts. Estimated cost uses model pricing and is not provider-attested billing. A missing cost is unknown, not zero.

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

Intake supports schedule, manual dispatch, repository dispatch, release, issue comment, and pull request review events, subject to taskpack policy. Pass the event name and payload explicitly as shown above. Comment commands also require actor authorization.

Install a workflow in each consumer repository. For centralized webhook intake and token brokering, see [GitHub App](github-app.md).

---

**See also** — [GitHub App](github-app.md) (configure webhook intake) · [Sandbox Backends](../configuration/sandbox-backends.md) (select execution isolation)

**Next** → [Declarative Taskpack](../walkthroughs/declarative-taskpack.md) — configure the repository manifest.
