# GitHub Action

GitHub Action mode is the primary zero-server entry point for consumer repositories. Use `gpustack/loopwright@main` for scheduled, manual, and `/loopwright` comment triggers.

## Contents

- [Workflow](#workflow)
- [Secrets and environment](#secrets-and-environment)
- [Inputs and output](#inputs-and-output)
- [Taskpack and triggers](#taskpack-and-triggers)

## Workflow

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
      - uses: actions/create-github-app-token@v1 # Optional when minting App PR tokens
        id: app-token
        with:
          app-id: ${{ secrets.LOOPWRIGHT_APP_ID }}
          private-key: ${{ secrets.LOOPWRIGHT_APP_PRIVATE_KEY }}
      - uses: gpustack/loopwright@main
        id: loopwright
        with:
          taskpack-path: .loopwright/taskpack.yaml # Optional (defaults to .loopwright/taskpack.yaml)
          event-name: ${{ github.event_name }} # Optional (defaults to GITHUB_EVENT_NAME)
          event-path: ${{ github.event_path }} # Optional for schedule/manual; needed on comments
          provider: zai # Optional override (omit to use spec.models pool)
          model: glm-5.3 # Optional override (defaults to glm-5.3)
          thinking: high # Optional override
          publication-endpoint-url: https://publish.internal.example/pr # Optional when publication is disabled
          dry-run: 'true' # Optional (defaults to 'false')
        env:
          GH_TOKEN: ${{ steps.app-token.outputs.token }} # Optional in dry-run mode
          ZAI_API_KEY: ${{ secrets.ZAI_API_KEY }} # Optional in dry-run mode
          LOOPWRIGHT_GATE_SIGNING_SECRET: ${{ secrets.LOOPWRIGHT_GATE_SIGNING_SECRET }} # Optional when externalGates is empty
          LOOPWRIGHT_PUBLICATION_SIGNING_SECRET: ${{ secrets.LOOPWRIGHT_PUBLICATION_SIGNING_SECRET }} # Optional when publication is disabled
```

- **Minimal setup**: Every `with:` input on `gpustack/loopwright@main` has a default when running `schedule` or `workflow_dispatch` with `publication.mode: disabled`; conditional inputs (`event-path`, `publication-endpoint-url`, `gate-endpoint-url`) become mandatory when their corresponding features are enabled.
- **Runtime provisioning**: The composite Action provisions the required [runtime baseline](../getting-started/architecture.md#runtime-baseline) automatically and builds the workspace when `dist/action.js` is absent.
- **Dry-run vs. live execution**: Standalone `runActionCli` compiles and scrubs artifacts outside the checkout (`dry-run: 'true'` skips any host controller delegate). Never commit provider or signing secrets to the repository.

## Secrets and environment

`compileDeclarativeTaskpack` writes literal `${LOOPWRIGHT_*}` templates—never raw secret values—into `registry.yaml` and `config.yaml`, and `SecretScrubber` verifies zero secret bytes appear on disk. During live execution, `@loopwright/controller` resolves those approved variable names from `env` in memory for each bound consumer (`provider`, `gate`, or `publisher`).

### GitHub App secrets

Configure repository or organization secrets when using `actions/create-github-app-token@v1`:

| Secret | Required | Consumer step | Purpose |
| --- | --- | --- | --- |
| `LOOPWRIGHT_APP_ID` | Conditional | `create-github-app-token` | Required when minting an App installation token; GitHub App numeric ID |
| `LOOPWRIGHT_APP_PRIVATE_KEY` | Conditional | `create-github-app-token` | Required when minting an App installation token; GitHub App RSA private key PEM |

### Step environment

Pass runtime credentials and optional overrides via `env:` on the `gpustack/loopwright` step:

| Variable | Required | Condition and default | Runtime usage |
| --- | --- | --- | --- |
| `GH_TOKEN` | Conditional | Required for live GitHub API / PR writes | Receives `steps.app-token.outputs.token` so managed PRs trigger downstream CI |
| `ZAI_API_KEY` / `LOOPWRIGHT_PROVIDER_TOKEN` | Conditional | Required for live controller model calls | Standard Pi provider env var or `LOOPWRIGHT_PROVIDER_TOKEN` (accepts comma-separated token pools) |
| `LOOPWRIGHT_GATE_SIGNING_SECRET` | Conditional | Required when `externalGates` is non-empty | Bound to `consumer: gate` to HMAC-SHA256 sign gate requests and verify receipts |
| `LOOPWRIGHT_PUBLICATION_SIGNING_SECRET` | Conditional | Required when `publication.mode` is `pull_request` | Bound to `consumer: publisher` to HMAC-SHA256 sign PR dispatches and verify receipts |
| `LOOPWRIGHT_OPERATOR_ALLOWLIST` | No | Unset (collaborators only) | Comma-separated extra GitHub logins authorized for `/loopwright` slash commands |
| `LOOPWRIGHT_REPOSITORY` | No | `GITHUB_REPOSITORY` | Explicit `owner/repo` override when `GITHUB_REPOSITORY` is unset |

## Inputs and output

### Action inputs

| Input | Required | Default | Purpose |
| --- | --- | --- | --- |
| `taskpack-path` | No | `.loopwright/taskpack.yaml` | Repository-relative manifest path |
| `mode` | No | `candidate` | Execution mode (`candidate` or `no-change`) |
| `event-name` | No | `GITHUB_EVENT_NAME` (`workflow_dispatch`) | Triggering GitHub event name |
| `event-path` | Conditional | Unset | Absolute JSON event payload path; **required** for `issue_comment` and `pull_request_review` |
| `publication-endpoint-url` | Conditional | Unset | Managed PR endpoint URL; **required** when `mode: candidate` and `publication.mode: pull_request` |
| `gate-endpoint-url` | Conditional | Unset | External `gate.v1` URL (bound as `id: default`); **required** when `externalGates` is non-empty |
| `run-root` | No | `RUNNER_TEMP` (`../.loopwright-runs`) | Trusted artifact root outside the repository checkout |
| `run-id` | No | `GITHUB_RUN_ID` (`local`) | Stable identifier for state and receipts |
| `storage-profile` | No | `actions-basic` | Host storage profile (`actions-basic` or `durable`) |
| `provider` | No | `spec.models[0].provider` (`zai`) | Pins one token-based Pi provider (omit to probe `spec.models` in order) |
| `model` | No | `spec.models[0].id` (`glm-5.3`) | Pins one coding/authoring model ID (see [Model configuration](../configuration/taskpack.md#model-configuration)) |
| `thinking` | No | `spec.models[0].thinking` (`high`) | Pi reasoning level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) |
| `api` | Conditional | Inferred | Wire protocol (`anthropic-messages`, `openai-completions`, `openai-responses`); **required** with `base-url` |
| `base-url` | No | Unset | Trusted host override for custom compatible API `baseUrl` |
| `provider-token-env` | No | Pi provider default | Host env var name holding provider API key or comma-separated token pool |
| `models-json` | No | Unset | Path to trusted Pi `models.json` file (`$ENV_VAR` `apiKey` refs only; `!command` refused) |
| `allow-custom-base-url` | No | `'false'` | Set `'true'` to permit `spec.models[].baseUrl` declared inside `.loopwright/taskpack.yaml` |
| `dry-run` | No | `'false'` | Set `'true'` to compile and validate without invoking a host controller delegate |

Interactive OAuth and CLI providers (`github-copilot`, `gemini`, `google`, `claude-code`, `openai-codex`, `google-gemini-cli`, `google-antigravity`) fail closed with `PROVIDER_OAUTH_UNSUPPORTED`.

### Result statuses

`runActionCli` writes the structured JSON `result` object to stdout and `GITHUB_OUTPUT`. In standalone mode, it compiles and validates trusted artifacts outside the checkout unless a host controller delegate is wired via `runGitHubActionEntrypoint`.

| Status | Exit code | Meaning |
| --- | --- | --- |
| `compiled` | `0` | Manifest and trusted configuration compiled cleanly |
| `no_change` | `0` | Discovery or verification settled with no repository update |
| `refused` | `1` | Signature, actor authorization, scope, or sandbox policy refused intake |
| `blocked` | `1` | Host qualification or external prerequisite blocked execution |

A `compiled` status alone does not confirm remote publication.

## Taskpack and triggers

`runGitHubActionEntrypoint` combines the manifest with trusted host bindings and writes `registry.yaml` and `config.yaml` outside the checkout. It scrubs generated artifacts before invoking an optional host delegate.

Configure writable and protected scope, checks, publication, triggers, and optional `spec.sandbox` preferences (`macos-seatbelt`, `linux-bwrap`, `linux-landlock`, `docker`) in [Declarative Taskpack](../walkthroughs/declarative-taskpack.md). When a taskpack declares `spec.sandbox`, backend negotiation (`negotiateSandboxBackend`) fails closed if the runner lacks the required OS sandbox binary or isolation capabilities.

Scheduled, manual, repository dispatch, release, issue comment and pull request review events are supported by intake subject to taskpack policy. Install a workflow in each consumer repository. The resident listener is disabled by default; see [GitHub App](github-app.md) for opt-in centralized queuing and token brokering.

---

**See also** — [GitHub App](github-app.md) (configure webhook intake) · [Sandbox Backends](../configuration/sandbox-backends.md) (select execution isolation)

**Next** → [Declarative Taskpack](../walkthroughs/declarative-taskpack.md) — configure the repository manifest.
