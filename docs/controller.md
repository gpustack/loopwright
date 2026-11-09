# Local controller and CLI

The private `@loopwright/controller` workspace compiles an explicit trusted configuration and runs a finite task graph.
Core constructs the acceptance result, state owns the original admission/budget/clock, and the Pi adapter owns request
and contained-tool dispatch. Controller progress stores identities and evidence references; it grants no extra calls,
tokens, repair attempts or time. The qualified state profile remains macOS arm64, Node26.13.0/SQLite3.54.1 on one boot.

S02 charges repair allowances per admitted SDK request. One implementation repair command can require a write turn
and a submission turn, consuming two implementation repair requests. The controller separately bounds commands
with `maxAttempts`; disabling implementation repair preserves the independently observed failed acceptance result.
A counted 429 retry can leave the original token charge unknown. Under the current S02/S03 contract, the controller
retains that charge and returns `RECOVERY_REQUIRED` (CLI exit7); it cannot capture or resume unresolved accounting.

## Public API and configuration envelopes

`@loopwright/controller` exports `CONTROLLER_API_VERSION` (`loopwright.dev/controller/v1alpha1`) and:

- `loadTrustedConfiguration({ configPath, registryPath, registrySha256, untrustedRoots })`
- `compilePlan(loadedConfiguration)`
- `runCycle({ configuration, repository, runRoot, runId, signal?, onEvent? })`
- `resumeCycle({ configuration, repository, runRoot, runId, signal?, onEvent? })`
- `readStatus({ runRoot, runId })` and `inspectRun({ runRoot, runId, output? })`

`ControllerConfig` and `TrustedRegistry` envelopes both use that `apiVersion`. The registry's
`spec.environmentBindings` approves variable names, their `credential` or `nonsecret` classification, and exact
JSON-Pointer `paths` in configuration string values. Interpolation is single-pass: `${NAME}` substitutes an approved
environment variable without rescanning its value, `$$` produces `$`, and `$${NAME}` produces literal `${NAME}`.
A bare `$` is literal. Names match `^[A-Za-z_][A-Za-z0-9_]*$`; malformed `${...}` and shell defaults such as
`${NAME:-x}` fail with `CONFIG_ENV_SYNTAX`. A `$` followed by something other than `$` or `{`, including `$(...)`,
is literal.

Registry `spec.credentialBindings` ties each `id`, `consumer` (`provider` or `mcp`), `destinationRef`,
`environmentNames` and `template` to a `{ ref, template }` entry in `ControllerConfig.spec.credentials`.
Resolved secrets stay in the private host vault and out of `CompiledPlan`. See the
[configuration example](../examples/controller.md#configuration-and-mcp-credential-authoring).

After `npm install` and `npm run build`, use `node packages/cli/dist/main.js` or the workspace `loopwright` bin:

```text
loopwright init --directory DIR [--force] [--json]
loopwright check --config FILE --registry FILE --registry-sha256 HEX [--json] [--output FILE]
loopwright run --dry-run --config FILE --registry FILE --registry-sha256 HEX [--json] [--output FILE]
loopwright run --config FILE --registry FILE --registry-sha256 HEX --repo DIR --run-root DIR --run-id ID [--json]
loopwright status --run-root DIR --run-id ID [--json]
loopwright inspect --run-root DIR --run-id ID [--json] [--output DIR]
loopwright resume --run-root DIR --run-id ID --config FILE --registry FILE --registry-sha256 HEX --repo DIR [--json]
```

Paths and stable IDs are explicit. There is no latest-run selection or configuration discovery. Registry bytes must be
owned/private and outside the repository, task directory and working directory, with an explicitly approved SHA256.
The run root is private and outside those writable roots. Unknown/duplicate flags and extra positional arguments fail.
`init` produces named review drafts with no credentials or approved runtime/handlers. Its strict proven_bound default
has no live proof. The draft README identifies the missing approvals; estimated context requires explicit operator opt-in.
`--force` replaces only named generated regular owned files. Other outputs use no-overwrite creation.

`check` and `run --dry-run` perform no admission, Docker query or network call. Their plans show ordered nodes, budgets,
capabilities and evidence needs. Private role command bytes are represented by SHA256 placeholders. The approved
registry digest binds the original bytes, and execution verifies the placeholder before retaining the original command
privately. Static support/readiness fields do not establish that a Docker runtime or provider is currently available.
See [controller acceptance authoring](../examples/controller.md) for required no-change proof and JSON header bounds.

Run/resume emit bounded public progress; JSON mode emits version1 envelopes with kind, sequence, runId and data.
A terminal envelope is result, diagnostic or incident. Human output escapes untrusted text and contains concise status.
Cancellation revokes new work and attempts bounded drain/cleanup under the original deadline. An uncertain request,
provider termination or cleanup remains reconcile_required or an incident even after SIGINT/SIGTERM.

| Exit | Meaning |
| --- | --- |
| 0 | Static command succeeded, or completed/no_change result |
| 2 | Usage/configuration rejection |
| 3 | Unsupported capability or blocked task |
| 4 | Failed acceptance/execution |
| 5 | Exhausted allowance |
| 6 | Expired deadline |
| 7 | Reconciliation/ownership needed |
| 8 | Authoritative result/state unavailable or incident |
| 130 /143 | Accounted SIGINT/SIGTERM cancellation, subject to uncertainty precedence |

Resume reopens the exact retained store and original clock, registry/runtime/source binding and artifacts. It refuses
live/unverifiable owners, torn or substituted artifacts and unaccounted effects. A completed native capture is adopted
without another model request. A verified original verifier receipt is reused. A pre-command boundary with no effect
may issue its original not-started command once. No saved dispatch marker becomes a new permit. Failure signatures and
consumed progress phases survive resume. Unsupported old progress versions remain unsupported; no migration resets caps.

`status`/`inspect` need no configuration or credentials and never claim/renew ownership, start a worker or query Docker.
They describe current state or label retained/unavailable facts. Successful inspection can describe a failed run and
exit0; unavailable authority exits8. An explicit inspect output directory receives a hash manifest and bounded public
lock/plan, candidate bytes, verification/result, usage, checkpoint metadata and events when available. Optional absent
or not-run artifacts are listed with reasons. SQLite, private native sessions, command bodies and ownership nonces
are excluded. Bundle hashes identify bytes; a bundle does not create run authority.

Offline tests include public check-only run/resume, real Git/S02/Workers, CLI subprocesses and export integrity. They
establish those local behaviors. Native Pi/provider/MCP qualification is recorded separately and cannot be inferred
from the unit total or a static plan. Live-provider qualification requires its separate explicitly approved credential
source; no CLI command implicitly publishes or applies external changes.
