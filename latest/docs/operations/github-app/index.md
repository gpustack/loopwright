# GitHub App

GitHub Action mode is the primary zero-server path for consumer repositories. Use `gpustack/loopwright@main` for scheduled runs, manual dispatch, and `/loopwright` comment commands.

The resident HTTP daemon is disabled by default. Operators can opt in for centralized webhook queuing and token brokering; production requires separately qualified ingress and host infrastructure.

## Contents

- [App registration](#app-registration)
- [Admission and permissions](#admission-and-permissions)
- [GitHubAppConfig](#githubappconfig)
- [Control plane](#control-plane)
- [Host qualification](#host-qualification)

## App registration

Create a GitHub App in your personal [Developer settings](https://github.com/settings/apps) or organization settings (`https://github.com/organizations/<org>/settings/apps`), then install it on the target repositories.

| Setting | Value |
| --- | --- |
| Contents | Read and write |
| Pull requests | Read and write |
| Issues | Read and write |
| Metadata | Read-only |
| Webhooks | Inactive for Action mode; active for `app-serve` |
| Events | For `app-serve`: Issue comment, Pull request review, Release |
| App secrets | Repository or organization secrets: `LOOPWRIGHT_APP_ID`, `LOOPWRIGHT_APP_PRIVATE_KEY` |
| Webhook secret | `LOOPWRIGHT_WEBHOOK_SECRET` when `app-serve` is enabled |

Use `actions/create-github-app-token@v1` with `gpustack/loopwright@main` in the [consumer workflow](/loopwright/latest/docs/operations/github-action/index.md). The App's webhook secret and private key must also be available in the trusted daemon environment when enabled.

## Admission and permissions

![Authenticated webhook and slash-command intake](/loopwright/latest/docs/assets/diagrams/slash-command-flow.svg)

<!-- flowchart LR
  Comment["01 Verify HMAC"] -> Authorize["02 Authorize actor"] -> Enqueue["03 Fence tenant queue"] -> Broker["04 Broker repo token"]
-->

Subscribe only to the event types used by your taskpack, including release, issue comment and pull request review as needed. Comment commands are restricted to authorized actors. Verify `X-Hub-Signature-256` over raw request bytes with HMAC-SHA256; mismatches and conflicting delivery IDs fail closed. The receiver implements verification before intake.

Installation tokens are restricted to one repository. The `read_only` profile grants contents and metadata read; `publish_pull_request` grants contents and pull requests write plus metadata read. Store the App private key and webhook secret in trusted host secret storage.

## GitHubAppConfig

Save the daemon configuration as `github-app.yaml`:

```yaml
apiVersion: loopwright.dev/v1alpha1
kind: GitHubAppConfig
spec:
  appId: '12345'
  webhookSecretEnv: LOOPWRIGHT_WEBHOOK_SECRET
  privateKeyEnv: LOOPWRIGHT_APP_PRIVATE_KEY
  apiBaseUrl: https://api.github.com # Optional (defaults to https://api.github.com)
  listen: # Optional block (set enabled to true for loopwright app-serve)
    enabled: false # Optional (defaults to false)
    host: 127.0.0.1
    port: 8787
    webhookPath: /webhooks/github # Optional (defaults to /webhooks/github)
  tokenTtlSeconds: 600 # Optional (defaults to 600)
  maxPayloadBytes: 1048576 # Optional (defaults to 1048576)
  taskpackPath: .loopwright/taskpack.yaml # Optional repo-relative taskpack path
  operatorAllowlist: # Optional GitHub login allowlist for slash commands
    - release-operator
```

- **Secrets**: Provide environment variable names, not secret values.
- **Listen**: Add authenticated ingress before serving external webhooks.
- **Path**: The taskpack path must be relative and cannot traverse directories.

| Field path | Required | Default | Bounds and constraint |
| --- | --- | --- | --- |
| `apiVersion` | Yes | — | Must be `'loopwright.dev/v1alpha1'` |
| `kind` | Yes | — | Must be `'GitHubAppConfig'` (`<= 64 KiB` file) |
| `spec.appId` | Yes | — | Non-empty GitHub App numeric ID or slug (`1–64` chars) |
| `spec.webhookSecretEnv` | Yes | — | Uppercase env var name (`[A-Z][A-Z0-9_]*`) holding HMAC secret |
| `spec.privateKeyEnv` | Yes | — | Uppercase env var name (`[A-Z][A-Z0-9_]*`) holding App PEM |
| `spec.apiBaseUrl` | No | `https://api.github.com` | HTTPS URL, or loopback HTTP (`127.0.0.1` / `localhost` / `[::1]`) |
| `spec.listen` | Conditional | Unset | Optional mapping; **required** with `enabled: true` to run `app-serve` |
| `spec.listen.enabled` | No | `false` | Set `true` to enable `loopwright app-serve` |
| `spec.listen.host` | Conditional | `127.0.0.1` | **Required** when `spec.listen` is present; keep tenant routes private |
| `spec.listen.port` | Conditional | `8787` | **Required** when `spec.listen` is present; integer `0–65535` |
| `spec.listen.webhookPath` | No | `/webhooks/github` | Leading `/` path; cannot collide with `/healthz` or `/tenants/*` |
| `spec.tokenTtlSeconds` | No | `600` | Integer `60–3600` cached installation token ceiling |
| `spec.maxPayloadBytes` | No | `1048576` | Integer `1024–26214400` inbound webhook byte cap |
| `spec.taskpackPath` | No | Unset | Relative regular-file path validated at startup |
| `spec.operatorAllowlist` | No | Unset | GitHub login list (`1–64` entries) authorized for slash commands |

## Control plane

Set `spec.listen.enabled: true`, bind the named secrets in the trusted environment, then start the daemon:

```sh
loopwright app-serve --config github-app.yaml --repo .
```

The command applies the configured listener and token broker settings. It refuses disabled or invalid configuration. The loader resolves the named webhook secret and private key from the environment.

The service binds loopback by default. Provide authenticated ingress and a configured broker in the trusted host; do not expose tenant lease endpoints publicly. Endpoints include the configured `listen.webhookPath` (default `/webhooks/github`), `/healthz`, and tenant lease and settle routes. The broker issues scoped short-lived tokens and scrubs secrets from responses.

### Webhook events

| Event | Trigger surface | Admission rule |
| --- | --- | --- |
| `release` | Published upstream release | Enabled via `spec.triggers.releasePublished` |
| `issue_comment` | Issue or PR `/loopwright` command | Requires collaborator or `operatorAllowlist` actor |
| `pull_request_review` | Managed PR review comment | Requires authorized actor and enabled command |
| `schedule` | Cron workflow run | Enabled via `spec.triggers.schedule` |
| `workflow_dispatch` | Manual operator trigger | Enabled via `spec.triggers.workflowDispatch` |
| `repository_dispatch` | Automation dispatch payload | Subject to intake signature and trigger policy |

### Intake dispositions

| Disposition | Queue action | Meaning |
| --- | --- | --- |
| `ready` | Enqueued for tenant | Signature, actor, and trigger checks passed |
| `no_change` | Settled without run | Upstream discovery found no eligible change |
| `blocked` | Rejected before run | Policy, authorization, or payload check refused intake |

## Host qualification

Verify the host against the [runtime baseline](/loopwright/latest/docs/getting-started/architecture/index.md#runtime-baseline) and required [sandbox backends](/loopwright/latest/docs/configuration/sandbox-backends/index.md) before starting `app-serve`. Interactive MCP OAuth challenges and unsandboxed fallbacks fail closed (`MCP_OAUTH_UNSUPPORTED`, `SANDBOX_BACKEND_UNAVAILABLE`, `SANDBOX_CAPABILITY_INSUFFICIENT`).

In-memory queue and delivery state do not establish durable cross-restart recovery.

---

**See also** — [GitHub Action](/loopwright/latest/docs/operations/github-action/index.md) (configure a consumer workflow) · [Sandbox Backends](/loopwright/latest/docs/configuration/sandbox-backends/index.md) (review execution isolation)

**Next** → [CLI](/loopwright/latest/docs/operations/cli/index.md) — inspect and reconcile bounded runs.
