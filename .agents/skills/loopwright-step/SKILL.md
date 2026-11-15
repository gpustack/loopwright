---
name: loopwright-step
description: >-
  Drive Loopwright Managed Controller and Declarative Taskpack runs through the
  pull-based coroutine loop (loopwright step next | submit | cancel) with
  adapter: delegated OAuth coding agents and per-role --role-model overrides.
---

# Loopwright Step Driver

Drive bounded Loopwright pipelines from an OAuth-backed host coding agent with zero Loopwright provider API tokens, or bind distinct models per role via `--role-model`. See [loopwright-overview](../loopwright-overview/SKILL.md) and [CLI](../../../docs/operations/cli.md) for package and flag ownership.

## When to Use

- Run a [ControllerConfig](../../../docs/configuration/controller-and-registry.md) (`--config`, `--registry`, `--registry-sha256`) or [Taskpack](../../../docs/configuration/taskpack.md) (`--taskpack`) workflow whose roles use `adapter: delegated`.
- Override role model bindings at admission without editing `registry.yaml` using `--role-model <roleId>=<provider>/<model>[:<thinking>]` (up to 8 flags, persisted in `run.json`).
- Keep `--run-root` strictly outside `--repo` so materialized workspaces (`<runRoot>/workspaces/<runId>/<attemptId>/`) never pollute the repository checkout.

## Pull Loop Protocol

### 1. Pull the next role assignment (`step next`)

Start a Declarative Taskpack run (`--mode candidate|no-change` optional):

```bash
loopwright step next --taskpack .loopwright/taskpack.yaml --repo <repo-dir> --run-root <outside-dir> --run-id <id> [--role-model <roleId>=<provider>/<model>[:<thinking>]] [--mode candidate|no-change] --json
```

Start a Managed Controller run:

```bash
loopwright step next --config <controller.yaml> --registry <registry.yaml> --registry-sha256 <hex> --repo <repo-dir> --run-root <outside-dir> --run-id <id> [--role-model <roleId>=<provider>/<model>[:<thinking>]] [--mode candidate|no-change] --json
```

`step next` (and `step submit`) writes a v1 NDJSON `Envelope` (`{ version: 1, kind, sequence, runId, data }`). When `kind` is `"step"`, `data` is a `StepYield` record:

| Field | Meaning |
| --- | --- |
| `status` | Always `"awaiting_role"` while parked for an external role |
| `attemptId`, `stepId`, `roleId` | Active attempt, DAG node ID, and role slot ID |
| `purpose`, `repair` | `"task" \| "reviewer"` and `"none" \| "format" \| "implementation"` |
| `selection` | `{ provider, model, thinking }` resolved for this role |
| `allowedTools` | Permitted tool names (`[]` when `repair === "format"`) |
| `scope` | `{ writable, protected }` path globs enforced on submit |
| `candidateDir` | Writable staging directory (`.../candidate`) for this attempt |
| `contextFiles` | Read-only (`0o400`) context files staged in `.../context` |
| `prompt` | Effective task, review, or format-repair prompt |
| `submissionMode`, `submissionPath` | `"artifact_or_assistant"` and optional submission artifact path |
| `leaseToken` | Single-use 64-hex token required by `step submit` |

### 2. Dispatch the role and enforce tools

- **Model routing**: Dispatch each yielded role to a host subagent or supervised Orca worker matching `selection.provider`, `selection.model`, and `selection.thinking`. Execute inline only when the active session already matches `selection`.
- **Workspace confinement**: Work ONLY inside `candidateDir`. Never edit `--repo` directly, follow paths into `<runRoot>/<runId>` or `.taskpack-<runId>`, or create symlinks, hardlinks (`nlink > 1`), or `.git` entries. Keep overlay changes within 128 files and 4 MiB (`<= 1 MiB` per file).
- **Read-only and format repairs**: When `repair === "format"` or `allowedTools` excludes mutating tools (`write`, `edit`, `delete`, `bash`) — such as `purpose: "reviewer"` — leave `candidateDir` byte-identical and report findings via `--status`, `--reason`, or `--submission-file`.
- **Protected paths**: Never touch `0o400` files in `candidateDir` or `.github/workflows/**`, `.claude/**`, `.agents/**`, `AGENTS.md`, and `CLAUDE.md`.

### 3. Optional fast screening (`jev`)

When `jev` (`~/.agents/skills/jev/SKILL.md`) is available, run a fast screen (`review-diff` or `eval`) on `candidateDir` diffs or review findings before calling `step submit`. Deliberate deeply when confidence is `< 0.80` or when `jev` disagrees with direct inspection.

### 4. Submit or cancel (`step submit` / `step cancel`)

Submit the finished attempt with its single-use `leaseToken`:

```bash
loopwright step submit --run-root <outside-dir> --run-id <id> --lease <leaseToken> [--submission-file <file>] [--status completed|no_change|failed|blocked] [--reason <text>] --json
```

`step submit` captures the diff, runs independent checks (`scope.v1`, `json-artifact.v1`, `no-change.v1`, `command.v1`), and returns either the next `StepYield` (`kind: "step"`) or the terminal run envelope (`kind: "result"` or `"incident"`).

- **Lease rules**: Duplicate `step next` while parked fails with `OWNER_BUSY` (exit `7`). Pass `loopwright step next --run-root <dir> --run-id <id> --reissue-lease --json` ONLY if a leased worker died and lost its token. Stale or replayed tokens fail with `AUTHORITY_REFUSED` (exit `7`).
- **Pre-commit preservation**: Symlink (`O_NOFOLLOW`), hardlink (`nlink === 1`), size-ceiling, and read-only/`format` invariance checks run before mutating state, preserving `candidateDir` and the lease so you can remediate and re-submit.

To abort an active or parked run cleanly (removing staged workspaces and settling `cancelled`, exit `130`):

```bash
loopwright step cancel --run-root <outside-dir> --run-id <id> --json
```

## Exit Codes

| Exit Code | Meaning |
| --- | --- |
| `0` | `step` yielded `awaiting_role`, or run settled `completed` / `no_change` |
| `2` | CLI usage, configuration, schema, or Taskpack manifest error |
| `3` | `blocked` outcome or unsupported capability (`CAPABILITY_UNSUPPORTED`) |
| `4` | Check verification or execution `failed` |
| `5` | `exhausted` (`BUDGET_EXHAUSTED`, `ATTEMPT_LIMIT`, `REPEAT_FAILURE`) |
| `6` | `expired` (`DEADLINE` wall-time drained) |
| `7` | Lease, owner, or recovery conflict (`OWNER_BUSY`, `AUTHORITY_REFUSED`, `RECOVERY_REQUIRED`, `reconcile_required`) |
| `8` | State, artifact (`ARTIFACT_INVALID`), limit (`OUTPUT_LIMIT`), or cleanup fault |
| `130` | `cancelled` (`step cancel` or `SIGINT`) |
| `143` | Terminated by `SIGTERM` |
