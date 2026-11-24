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

Use `actions/create-github-app-token@v1` with `gpustack/loopwright@main` in the [consumer workflow](github-action.md). Supply the App webhook secret and private key in the trusted daemon environment when `app-serve` is enabled.

## Admission and permissions

![Authenticated webhook and slash-command intake](../assets/diagrams/slash-command-flow.svg)

<!-- flowchart LR
  Comment["01 Verify HMAC"] -> Authorize["02 Authorize actor"] -> Enqueue["03 Fence tenant queue"] -> Broker["04 Broker repo token"]
-->

Subscribe only to the event types used by your taskpack. Comment commands require authorized actors. The receiver verifies `X-Hub-Signature-256` over raw request bytes with HMAC-SHA256 and fails closed on mismatches or conflicting delivery IDs.

Installation tokens are restricted to one repository. The `read_only` profile grants contents and metadata read; `publish_pull_request` grants contents and pull requests write plus metadata read.

## GitHubAppConfig

Save the daemon configuration as `github-app.yaml` (`<= 64 KiB`):

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
  tokenTtlSeconds: 600 # Optional (60..3600, defaults to 600)
  maxPayloadBytes: 1048576 # Optional (1024..26214400, defaults to 1048576)
  taskpackPath: .loopwright/taskpack.yaml # Optional repo-relative taskpack path
  suitePath: .loopwright/suite.yaml # Optional mutually exclusive with taskpackPath
  operatorAllowlist: # Optional 1..64 GitHub logins for slash commands
    - release-operator
```

- **Secrets**: Name uppercase environment variables (`[A-Z][A-Z0-9_]*`), never raw secret values.
- **Listen**: Set `listen.enabled: true` with `host` and `port`, and place authenticated ingress in front of external webhooks.
- **Manifest path**: `taskpackPath` and `suitePath` must be repo-relative regular files and are mutually exclusive.
- **Route isolation**: `webhookPath` must start with `/` and cannot collide with `/healthz` or `/tenants/*`.

## Control plane

Set `spec.listen.enabled: true`, bind the named secrets in the trusted environment, then start the daemon:

```sh
loopwright app-serve --config github-app.yaml --repo .
```

The daemon binds loopback by default and exposes `listen.webhookPath` (default `/webhooks/github`), `/healthz`, and private tenant lease/settle routes. The broker issues scoped short-lived tokens and scrubs secrets from responses.

With `spec.suitePath`, one verified `X-GitHub-Delivery` fans out across matching domains while deduplicating redeliveries, enforcing the suite protected union, and binding each domain manifest SHA-256. For `issue_comment` webhooks lacking PR branch metadata, intake queries `spec.apiBaseUrl` to verify same-repo ownership before admission.

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

Verify the host against the [runtime baseline](../getting-started/architecture.md#runtime-baseline) and required [sandbox backends](../configuration/sandbox-backends.md) before starting `app-serve`. Interactive MCP OAuth challenges and unsandboxed fallbacks fail closed (`MCP_OAUTH_UNSUPPORTED`, `SANDBOX_BACKEND_UNAVAILABLE`, `SANDBOX_CAPABILITY_INSUFFICIENT`).

In-memory queue and delivery state do not establish durable cross-restart recovery.

---

**See also** — [GitHub Action](github-action.md) (configure a consumer workflow) · [Sandbox Backends](../configuration/sandbox-backends.md) (review execution isolation)

**Next** → [CLI](cli.md) — inspect and reconcile bounded runs.
