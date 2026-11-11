# GitHub App Deployment

The App control plane accepts authenticated GitHub webhooks and leases tenant-scoped work. A production deployment requires separately qualified ingress and host infrastructure.

## Contents

- [Admission and permissions](#admission-and-permissions)
- [Start the control plane](#start-the-control-plane)
- [Host qualification](#host-qualification)

## Admission and permissions

Subscribe only to the event types used by your taskpack, including release, issue comment and pull request review as needed. Comment commands are restricted to authorized actors. Verify `X-Hub-Signature-256` over raw request bytes with HMAC-SHA256; mismatches and conflicting delivery IDs fail closed. The receiver implements verification before intake.

Installation tokens are restricted to one repository. The `read_only` profile grants contents and metadata read; `publish_pull_request` grants contents and pull requests write plus metadata read. Store the App private key and webhook secret in trusted host secret storage.

## Start the control plane

```ts
import { startGitHubAppControlPlane } from '@loopwright/github-app';

const server = await startGitHubAppControlPlane({
  webhookSecret: process.env.LOOPWRIGHT_WEBHOOK_SECRET!,
  taskpackId: 'docs-sync',
});
// Provide a configured InstallationTokenBroker for lease requests.
// Close the handle during host shutdown: await server.close().
```

The service binds loopback by default. Provide authenticated ingress and a configured broker in the trusted host; do not expose tenant lease endpoints publicly. Endpoints include `/webhooks/github`, `/healthz`, and tenant lease and settle routes. The broker issues scoped short-lived tokens and scrubs secrets from responses.

## Host qualification

Qualify platform, Node runtime, local storage, clock and storage profile before running; interactive MCP OAuth is refused. For native OS sandbox execution without Docker, provision `/usr/bin/sandbox-exec` on macOS (`macos-seatbelt`) or `/usr/bin/bwrap` (`linux-bwrap`) / Linux Landlock LSM (`linux-landlock`) on Linux; `negotiateSandboxBackend` fails closed (`SANDBOX_BACKEND_UNAVAILABLE` or `SANDBOX_CAPABILITY_INSUFFICIENT`) rather than falling back to unsandboxed host execution. In-memory queue and delivery state do not establish durable deployed recovery. See [control plane details](../github-app.md) and [closure](../closure-matrix.md) for current boundaries.

**See also**: [Taskpack intake](../github-app.md)

**Next**: [CLI operations](cli.md)
