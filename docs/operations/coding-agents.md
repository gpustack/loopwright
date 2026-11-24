# Coding Agents

Drive bounded Loopwright runs from OAuth or subscription coding agents without GitHub Actions, GitHub Apps, or provider API keys. Host sessions in Claude Code, Codex, Antigravity, Cursor, Orca, or Pi pull leased turns via `loopwright step`.

Install the `loopwright` CLI first via [Installation](../getting-started/installation.md). Keep `--run-root` outside `--repo` and export verified overlays with `loopwright inspect` before committing local branch changes.

## Contents

- [Operating model](#operating-model)
- [Skill and prompt](#skill-and-prompt)
- [Step 1: Pull assignment](#step-1-pull-assignment)
- [Step 2: Execute role](#step-2-execute-role)
- [Step 3: Submit lease](#step-3-submit-lease)
- [Multi-role routing](#multi-role-routing)
- [Step 4: Apply overlay](#step-4-apply-overlay)
- [Recovery and exits](#recovery-and-exits)

## Operating model

Delegated stepping turns Loopwright into a pull-based local coroutine (`loopwright step next | submit | cancel`). Your host coding agent supplies model execution over its OAuth or subscription session, while Loopwright enforces SQLite lease fencing, workspace confinement, and independent verification.

Zero Loopwright provider credentials, GitHub App keys, or workflow secrets are needed on disk or in environment variables:

| Operating mode | Entry flags | Role compilation |
| --- | --- | --- |
| Declarative Taskpack | `--taskpack .loopwright/taskpack.yaml` | Compiles roles as `adapter: delegated` with `publication.mode: disabled` |
| Managed Controller | `--config`, `--registry`, `--registry-sha256` | Uses `adapter: delegated` profiles with local `publication.mode: disabled` |

## Skill and prompt

### Portable skill

Install the standalone `loopwright-step` skill into your project or user skill directory:

```sh
npx skills add gpustack/loopwright --skill loopwright-step
```

Or copy `.agents/skills/loopwright-step/SKILL.md` into `.agents/skills/loopwright-step/SKILL.md` (repo scope) or `~/.agents/skills/loopwright-step/SKILL.md` (user scope).

### Zero-install prompt

When running without local skills installed, paste this prompt into your coding agent inside the target checkout:

```text
Read https://docs.gpustack.ai/loopwright/llms.txt and fetch https://docs.gpustack.ai/loopwright/latest/docs/operations/coding-agents/index.md. Drive this repository through loopwright step next and loopwright step submit using a disjoint --run-root directory outside the checkout, keep all edits confined to candidateDir, and once result.json settles completed, export a fresh inspect bundle to a new child path and apply candidate.files.json onto my current Git branch.
```

## Step 1: Pull assignment

Choose a canonical `--run-root` strictly disjoint from `--repo` with zero symlink components (resolve `pwd -P` on macOS). Start a Declarative Taskpack run (native `spec.preflight`, `--baseline-alignment`, `--source-revision`, and `--allow-privileged` are supported):

```sh
RUN_ROOT="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/loopwright-run.XXXXXX")" && pwd -P)"
RUN_ID="local-sync-01"

loopwright step next \
  --taskpack .loopwright/taskpack.yaml \
  --repo . \
  --run-root "$RUN_ROOT" \
  --run-id "$RUN_ID" \
  --json
```

For Managed Controller runs, pin `target.sourceRevision` to `git rev-parse HEAD` and pass `--config`, `--registry`, and `--registry-sha256`. With `--json`, stdout emits NDJSON `Envelope` lines; when `kind` is `"step"`, `data` returns the `StepYield` assignment (`candidateDir`, `contextFiles`, `selection`, `allowedTools`, `scope`, `prompt`, `submissionPath`, and single-use `leaseToken`).

## Step 2: Execute role

Execute the yielded `prompt` inside `candidateDir` while obeying four confinement invariants:

- **Isolated staging**: Modify files only inside `candidateDir`; leave `--repo` and `<runRoot>/<runId>` untouched.
- **Regular files only**: Create zero symlinks (`O_NOFOLLOW`), zero hardlinks (`nlink === 1`), and zero `.git` entries.
- **Overlay bounds**: Stay within `spec.limits.overlay` (default `128` files / `4 MiB`, up to `16,384` files / `16 GiB` via CAS streaming).
- **Protected & read-only invariance**: Never edit `0o400`/`0o500` protected paths, `.git`, `<controlRoot>`, or `candidateDir` during `repair === "format"` or read-only review turns.

## Step 3: Submit lease

Submit the completed turn with its single-use `leaseToken` (add `--submission-file`, `--status no_change|failed|blocked`, or `--reason` when needed):

```sh
loopwright step submit \
  --run-root "$RUN_ROOT" \
  --run-id "$RUN_ID" \
  --lease "$LEASE_TOKEN" \
  --status completed \
  --json
```

Loopwright captures the overlay, runs independent checks (`scope.v1`, `json-artifact.v1`, `no-change.v1`, and local `command.v1`), and emits either the next `StepYield` or a terminal `result`/`incident` envelope. Pre-commit scan failures release authority without consuming `leaseToken` or deleting `candidateDir` so you can fix and re-submit.

## Multi-role routing

Declare `1..4` ordered roles under `spec.roles` in `.loopwright/taskpack.yaml` to run multi-agent DAGs such as author-then-reviewer pipelines. `step next --taskpack` compiles every role as `adapter: delegated` automatically.

### Taskpack

```yaml
apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: multi-role-sync
spec:
  goal:
    candidate: Refresh version manifests from upstream releases and pass every local check.
    noChange: Confirm tracked manifests match upstream releases and settle as no change.
  scope:
    writable:
      - docs
      - versions.json
    protected:
      - policy/invariants.md
  roles: # Optional 1..4 roles compiled as delegated during step next
    - id: author
      purpose: task
      provider: anthropic
      model: claude-sonnet-4-6
      thinking: high # Optional
      tools: # Optional
        - read
        - write
        - edit
        - bash
    - id: review
      purpose: review
      provider: openai
      model: gpt-5.4
      thinking: high # Optional
      tools: # Optional
        - read
      dependsOn: # Optional
        - author
  upstreams:
    - id: engine
      kind: github-release
      source: gpustack/engine
      watchedPaths:
        - docs
  proposal:
    path: docs/proposal.json
    requiredFields:
      - schema_version
      - summary
    schemaVersion: 1
  verification:
    localChecks:
      - id: proposal-json
        implementation: json-artifact.v1
    externalGates: []
  publication:
    mode: pull_request
    targetBranch: main
    headBranchPrefix: auto-sync/
    titleTemplate: "chore(sync) - update upstream manifests"
  memory:
    directory: .loopwright/memory/multi-role-sync
    apply: separate-pull-request
    onNoModelBudget: deterministic-observations-only
  triggers:
    schedule: false
    workflowDispatch: true
    releasePublished: false
    commentCommands: []
```

Override role models at admission without editing YAML via repeatable `--role-model <roleId>=<provider>/<model>[:<thinking>]` flags (up to `8` roles, persisted in `run.json`), then dispatch each yielded `selection` to a matching subagent or worker:

```sh
loopwright step next \
  --taskpack .loopwright/taskpack.yaml \
  --repo . \
  --run-root "$RUN_ROOT" \
  --run-id "$RUN_ID" \
  --role-model author=anthropic/claude-opus-4-6:high \
  --role-model review=openai-codex/gpt-5.4:high \
  --json
```

## Step 4: Apply overlay

Terminal `step submit` deletes `<runRoot>/workspaces/<runId>` while keeping verified artifacts under `<runRoot>/<runId>`. Once `result.json` settles `completed`, export a fresh bundle to a new `--output` path (`0700`):

```sh
INSPECT_DIR="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/loopwright-inspect.XXXXXX")" && pwd -P)/bundle"
loopwright inspect --run-root "$RUN_ROOT" --run-id "$RUN_ID" --output "$INSPECT_DIR" --json
```

Before applying `$INSPECT_DIR/candidate.files.json` onto your branch (either via the `loopwright-step` skill or an atomic script), verify five invariants:

1. **Completed lock**: `$INSPECT_DIR/result.json` settled `completed` and matches `task.lock.json` `lockHash`.
2. **Clean baseline**: Local `git status --porcelain` is empty and `HEAD` equals pinned `sourceRevision` (and `baseTree.commitOid` for overlays).
3. **Safe targets**: Every path is repo-relative with zero symlinks, zero hardlinks (`nlink === 1`), and zero `.git` segments.
4. **Verified CAS blobs**: Every `version: 2` entry (`cas://sha256/<hex>`) matches its `1 MiB` streamed SHA-256 and `100644`/`100755` mode.
5. **Review diff**: Inspect `git status` and `git diff`, run project tests, and commit on your branch.

## Recovery and exits

Rotate a lost lease after a worker crash, or cancel cleanly (exit `130`):

```sh
loopwright step next --run-root "$RUN_ROOT" --run-id "$RUN_ID" --reissue-lease --json
loopwright step cancel --run-root "$RUN_ROOT" --run-id "$RUN_ID" --json
```

| Exit code | Diagnostic or outcome |
| --- | --- |
| `0` | Yielded `awaiting_role`, or settled `completed` / `no_change` |
| `2` / `3` | Schema or `--run-root` overlap (`2`); `blocked` or `CAPABILITY_UNSUPPORTED` (`3`) |
| `4` / `5` / `6` | Verification `failed` (`4`), budget `exhausted` (`5`), or `DEADLINE` (`6`) |
| `7` | `OWNER_BUSY`, `AUTHORITY_REFUSED`, or `RECOVERY_REQUIRED` |
| `8` / `130` / `143` | Artifact/store incident (`8`), `step cancel`/`SIGINT` (`130`), or `SIGTERM` (`143`) |

---

**See also** — [CLI](cli.md) (local operator subcommands and flags) · [Taskpack](../configuration/taskpack.md) (manifest roles, scope, and checks) · [Controller and Registry](../configuration/controller-and-registry.md) (delegated role profiles)

**Next** → [Declarative Taskpack](../walkthroughs/declarative-taskpack.md) — author and verify a `.loopwright/taskpack.yaml` workflow end to end.
