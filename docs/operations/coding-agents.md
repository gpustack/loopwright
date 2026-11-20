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
- [Exit codes](#exit-codes)

## Operating model

Delegated stepping turns Loopwright into a pull-based local coroutine (`loopwright step next | submit | cancel`). Your host coding agent supplies model execution over its existing OAuth or subscription session, while Loopwright enforces SQLite lease fencing, workspace confinement, and independent check verification.

Zero Loopwright provider credentials, GitHub App keys, or workflow secrets are required on disk or in environment variables. Both operating modes share identical `StepYield` envelopes and verification gates:

| Operating mode | Entry flags | Role compilation |
| --- | --- | --- |
| Declarative Taskpack | `--taskpack .loopwright/taskpack.yaml` | Compiles manifest roles as `adapter: delegated` with `publication.mode: disabled` |
| Managed Controller | `--config`, `--registry`, `--registry-sha256` | Uses `adapter: delegated` profiles; set `publication.mode: disabled` for local-only runs |

## Skill and prompt

### Portable skill

Install the standalone `loopwright-step` skill into your project or user skill directory:

```sh
npx skills add gpustack/loopwright --skill loopwright-step
```

Or copy `.agents/skills/loopwright-step/SKILL.md` from a Loopwright checkout into `.agents/skills/loopwright-step/SKILL.md` (repository scope) or `~/.agents/skills/loopwright-step/SKILL.md` (global user scope).

### Zero-install prompt

When running without local skills installed, paste this prompt into your coding agent inside the target checkout:

```text
Read https://docs.gpustack.ai/loopwright/llms.txt and fetch https://docs.gpustack.ai/loopwright/latest/docs/operations/coding-agents/index.md. Drive this repository through loopwright step next and loopwright step submit using a disjoint --run-root directory outside the checkout, keep all edits confined to candidateDir, and once result.json settles completed, export a fresh inspect bundle to a new child path and apply candidate.files.json onto my current Git branch.
```

## Step 1: Pull assignment

Choose a canonical `--run-root` directory strictly disjoint from `--repo` (neither inside nor containing `--repo`, with zero symlink components — resolve `pwd -P` on macOS where `/tmp` and `/var` are symlinks). Start a Declarative Taskpack run:

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

### Host preflight

`step next --taskpack` runs `spec.preflight` natively without manual staging scripts or `--mode auto`. Pass `--allow-privileged` when the taskpack declares privileged preflight or execution capabilities:

```sh
REPO="$(pwd -P)"

loopwright step next \
  --taskpack .auto-sync/taskpack.yaml \
  --repo "$REPO" \
  --run-root "$RUN_ROOT" \
  --run-id "$RUN_ID" \
  --allow-privileged \
  --json
```

Or start a Managed Controller run, pinning `target.sourceRevision` to `git rev-parse HEAD` (`--mode candidate|no-change` is optional):

```sh
loopwright step next \
  --config "$HOME/loopwright-ops/controller.yaml" \
  --registry "$HOME/loopwright-ops/registry.yaml" \
  --registry-sha256 <hex> \
  --repo . \
  --run-root "$RUN_ROOT" \
  --run-id "$RUN_ID" \
  --json
```

With `--json`, stdout emits a versioned NDJSON `Envelope` (`{ version: 1, kind, sequence, runId, data }`). When `kind` is `"step"`, `data` is a `StepYield` assignment:

| Yield field | Type | Contract |
| --- | --- | --- |
| `status` | `"awaiting_role"` | Run is parked at `role_pre` awaiting external role execution |
| `attemptId`, `stepId` | `string` | Monotonic attempt identifier and compiled DAG step identifier |
| `roleId`, `purpose` | `string` | Role identifier and runtime purpose (`"task"` or `"reviewer"`) |
| `repair` | `string` | Repair turn kind (`"none"`, `"format"`, or `"implementation"`) |
| `selection` | `object` | Resolved `{ provider, model, thinking }` target for role dispatch |
| `allowedTools` | `string[]` | Permitted tool names (`[]` when `repair` equals `"format"`) |
| `scope` | `object` | `{ writable, protected }` path rules enforced during capture |
| `candidateDir` | `string` | Staged working tree (`<runRoot>/workspaces/<runId>/<attemptId>/candidate`) |
| `contextFiles` | `string[]` | Read-only (`0o400`) context artifacts under `.../context` |
| `prompt` | `string` | Effective task, review, or format-repair prompt text |
| `submissionMode` | `"artifact_or_assistant"` | Accepts `--submission-file` or structured `--status` metadata |
| `submissionPath` | `string \| null` | Expected relative artifact path inside `candidateDir` when configured |
| `leaseToken` | `string` | Single-use 64-character lowercase hex token required on submit |

## Step 2: Execute role

Execute the yielded prompt inside `candidateDir` while obeying every confinement invariant:

- **Isolated staging**: Modify files only inside `candidateDir`; leave `--repo`, `<runRoot>/<runId>`, and `<runRoot>/.taskpack-<runId>` untouched.
- **Regular files only**: Create zero symlinks (`O_NOFOLLOW`), zero hardlinks (`nlink === 1`), and zero `.git` entries inside `candidateDir`.
- **Overlay bounds**: Keep changed or added files within default `128` entries and `4 MiB` total (configurable via `spec.limits.overlay` up to `16,384` files and `16 GiB` via `1 MiB` CAS streaming; depth `<= 32`, `<= 131,072` scanned entries).
- **Protected invariance**: Never modify or chmod `0o400` / `0o500` protected files, `.git`, `<controlRoot>`, paths matched by `scope.protected`, or `.github/workflows/**` on GitHub policy runs unless explicitly unlocked.
- **Read-only invariance**: Leave `candidateDir` byte-identical when `repair === "format"` or when `allowedTools` omits `write`, `edit`, `delete`, and `bash` (such as `purpose: "reviewer"`).

## Step 3: Submit lease

Submit the completed role turn with its single-use `leaseToken`:

```sh
loopwright step submit \
  --run-root "$RUN_ROOT" \
  --run-id "$RUN_ID" \
  --lease "$LEASE_TOKEN" \
  --status completed \
  --json
```

Pass `--submission-file <path>` when supplying an external JSON artifact, or set `--status` (`completed`, `no_change`, `failed`, or `blocked`) with `--reason "<summary>"` on non-completed turns. Loopwright captures the overlay, runs independent checks (`scope.v1`, `json-artifact.v1`, `no-change.v1`, and local `command.v1` hooks), and emits either the next `StepYield` (`kind: "step"`) or a terminal `result` / `incident` envelope.

Pre-commit scan failures (symlinks, hardlinks, size ceilings, or read-only invariance violations) release authority without consuming `leaseToken` or deleting `candidateDir`, so the agent can fix the workspace and re-submit.

| Condition | Diagnostic code | Exit code |
| --- | --- | --- |
| Duplicate `step next` while parked | `OWNER_BUSY` | `7` |
| Replay or stale `leaseToken` after rotation | `AUTHORITY_REFUSED` | `7` |
| Unattended `run` or `resume` on delegated role | `CAPABILITY_UNSUPPORTED` | `3` |

Recover a lost lease from a crashed worker by rotating the token explicitly, or abort the run cleanly (exit `130`):

```sh
loopwright step next --run-root "$RUN_ROOT" --run-id "$RUN_ID" --reissue-lease --json
loopwright step cancel --run-root "$RUN_ROOT" --run-id "$RUN_ID" --json
```

## Multi-role routing

Declare `1` to `4` ordered roles under `spec.roles` in `.loopwright/taskpack.yaml` (see [Taskpack](../configuration/taskpack.md)) to run multi-agent DAGs such as author-then-reviewer pipelines. During `step next --taskpack`, Loopwright compiles every role into `adapter: delegated` automatically; Managed Controller files set `adapter: delegated` directly on `TaskContract.spec.roles[]` and `TrustedRegistry.spec.roleProfiles[]`.

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
  roles: # Optional — 1..4 roles compiled as adapter delegated during step next
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
    titleTemplate: "chore(sync): update upstream manifests"
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

Override role models at admission without editing YAML by passing repeatable `--role-model <roleId>=<provider>/<model>[:<thinking>]` flags (up to `8` unique role IDs, persisted in `run.json`, total CLI `argv <= 64`). Dispatch each yielded `selection` to a matching subagent or supervised Orca worker:

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

`step next --taskpack` sets `publication.mode: disabled` and pins `target.sourceRevision` to `HEAD`'s commit OID automatically. For local-only Managed Controller runs, set `publication.mode: disabled` and pin `target.sourceRevision` to `git rev-parse HEAD` in `controller.yaml`. Terminal `step submit` deletes `<runRoot>/workspaces/<runId>` (`candidateDir`) while retaining verified artifacts under `<runRoot>/<runId>`.

Once `step submit --json` emits `kind: "result"` with `data.result.spec.status === "completed"`, export the digest-verified bundle to a **new** `--output` path (`loopwright inspect` creates the destination with mode `0700` and rejects pre-existing directories):

```sh
INSPECT_DIR="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/loopwright-inspect.XXXXXX")" && pwd -P)/bundle"
loopwright inspect --run-root "$RUN_ROOT" --run-id "$RUN_ID" --output "$INSPECT_DIR" --json
```

Verify `$INSPECT_DIR/result.json` settled `completed`, confirm your local Git working tree is clean and `HEAD` matches the immutable baseline commit OID, and apply `$INSPECT_DIR/candidate.files.json` onto your branch. `candidate.files.json` exports `version: 2` CAS pointers (`{ name, mode, sha256, byteLength, uri, blobPath }`, verified via `O_NOFOLLOW`, `nlink === 1`, and `1 MiB` streaming SHA-256 while preserving `100644`/`100755` modes), with passive fallback for legacy `version: 1` base64 `body` bundles:

```sh
node -e '
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process"), crypto = require("node:crypto");
const [inspectDir, repoArg] = process.argv.slice(1);
const repoRoot = fs.realpathSync(repoArg), CHUNK = 1048576;
const readJson = (n) => JSON.parse(fs.readFileSync(path.join(inspectDir, n), "utf8"));
const res = readJson("result.json");
if (res.spec?.status !== "completed") throw new Error(`Refusing apply: status=${res.spec?.status}`);
const lock = readJson("task.lock.json"), bundle = readJson("candidate.files.json");
if (!lock.spec?.lockHash?.hex || res.spec?.subject?.lockHash?.hex !== lock.spec.lockHash.hex) throw new Error("Refusing apply: lockHash mismatch");
const git = (...a) => cp.execFileSync("git", ["-C", repoRoot, ...a], { encoding: "utf8" });
if (git("status", "--porcelain", "-z", "--untracked-files=all").length > 0) throw new Error("Refusing apply: working tree is dirty");
const sourceRev = lock.spec?.contract?.spec?.target?.sourceRevision;
if (typeof sourceRev !== "string" || !sourceRev || sourceRev.startsWith("-")) throw new Error("Invalid sourceRevision");
const head = git("rev-parse", "--verify", "HEAD^{commit}").trim();
if (head !== git("rev-parse", "--verify", "--end-of-options", `${sourceRev}^{commit}`).trim()) throw new Error("Refusing apply: HEAD != sourceRevision");
const safePath = (rel) => {
  if (typeof rel !== "string" || !rel || path.isAbsolute(rel) || rel.includes("\\")) throw new Error(`Invalid path: ${rel}`);
  const parts = rel.split("/");
  if (parts.some((p) => !p || p === "." || p === ".." || p === ".git")) throw new Error(`Unsafe segment: ${rel}`);
  let cur = repoRoot;
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]);
    try {
      const st = fs.lstatSync(cur);
      const bad = st.isSymbolicLink() || (i < parts.length - 1 ? !st.isDirectory() : (!st.isFile() || st.nlink !== 1));
      if (bad) throw new Error(`Unsafe target: ${rel}`);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  return cur;
};
const streamHash = (filePath, expectedLen, outFd) => {
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1) throw new Error(`Unsafe source: ${filePath}`);
    if (expectedLen !== null && st.size !== expectedLen) throw new Error(`Size mismatch: ${filePath}`);
    const hash = crypto.createHash("sha256"), buf = Buffer.allocUnsafe(CHUNK);
    let total = 0, n = 0;
    while ((n = fs.readSync(fd, buf, 0, CHUNK, null)) > 0) {
      hash.update(buf.subarray(0, n));
      if (outFd !== null) for (let off = 0; off < n;) off += fs.writeSync(outFd, buf, off, n - off);
      total += n;
    }
    const after = fs.fstatSync(fd);
    if (after.ino !== st.ino || after.dev !== st.dev || after.size !== st.size || after.mtimeMs !== st.mtimeMs) throw new Error(`Source mutated: ${filePath}`);
    if (expectedLen !== null && total !== expectedLen) throw new Error(`Short read: ${filePath}`);
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
};
const isV2 = bundle.version === 2;
if (!isV2 && bundle.version !== 1) throw new Error(`Unsupported bundle version: ${bundle.version}`);
const files = bundle.files ?? [], present = new Set(files.map((f) => f.name));
let deleted;
if (bundle.manifest?.spec?.baseTree != null) {
  const commitOid = bundle.manifest.spec.baseTree.commitOid;
  if (typeof commitOid !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commitOid) || head !== commitOid) {
    throw new Error("Refusing apply: HEAD != baseTree.commitOid");
  }
  deleted = bundle.manifest.spec.deleted ?? [];
} else {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sourceRev) || head !== sourceRev) {
    throw new Error("Refusing apply: classic snapshot requires pinned commit OID sourceRevision");
  }
  const baseRows = git("ls-tree", "-r", "-z", "--full-tree", head).split("\0").filter(Boolean)
    .map((r) => /^(?:100644|100755) blob ([0-9a-f]{40,64})\t(.+)$/s.exec(r)).filter(Boolean)
    .map((m) => m[2]);
  deleted = baseRows.filter((n) => !present.has(n));
}
for (const del of deleted) safePath(del);
for (const file of files) {
  safePath(file.name);
  if (isV2) {
    if (!/^[0-9a-f]{64}$/.test(file.sha256) || file.uri !== `cas://sha256/${file.sha256}`) throw new Error(`Invalid CAS ref: ${file.name}`);
    if (!Number.isSafeInteger(file.byteLength) || file.byteLength < 0 || typeof file.blobPath !== "string" || !path.isAbsolute(file.blobPath)) throw new Error(`Invalid blobPath: ${file.name}`);
    if (streamHash(file.blobPath, file.byteLength, null) !== file.sha256) throw new Error(`Digest mismatch: ${file.name}`);
  } else if (file.encoding !== "base64" || typeof file.body !== "string") {
    throw new Error(`Unsupported encoding: ${file.encoding}`);
  }
}
for (const del of deleted) {
  const target = safePath(del);
  fs.rmSync(target, { force: true });
  for (let d = path.dirname(target); d !== repoRoot && d.startsWith(repoRoot + path.sep); d = path.dirname(d)) {
    try { fs.rmdirSync(d); } catch { break; }
  }
}
for (const file of files) {
  const target = safePath(file.name);
  const v1Bytes = isV2 ? null : Buffer.from(file.body, "base64");
  let mode = file.mode === "100755" ? 0o755 : 0o644, unchanged = false;
  try {
    const st = fs.lstatSync(target);
    if (file.mode == null && (st.mode & 0o111)) mode = 0o755;
    if (isV2) unchanged = st.size === file.byteLength && streamHash(target, file.byteLength, null) === file.sha256 && ((st.mode & 0o111) !== 0) === (mode === 0o755);
    else unchanged = st.size === v1Bytes.length && fs.readFileSync(target).equals(v1Bytes);
  } catch {}
  if (unchanged) continue;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  safePath(file.name);
  const tmp = path.join(path.dirname(target), `.lw-apply-${process.pid}-${Math.random().toString(16).slice(2)}`);
  const fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, mode);
  try {
    if (isV2) {
      if (streamHash(file.blobPath, file.byteLength, fd) !== file.sha256) throw new Error(`Digest mismatch: ${file.name}`);
    } else {
      fs.writeFileSync(fd, v1Bytes);
    }
    fs.fchmodSync(fd, mode);
    fs.closeSync(fd);
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.closeSync(fd); } catch {}
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}
' "$INSPECT_DIR" .
```

Review `git status` and `git diff`, run project tests if desired, and commit on your branch.

## Exit codes

| Exit code | Outcome |
| --- | --- |
| `0` | `step next` or `step submit` yielded `awaiting_role`, or run settled `completed` / `no_change` |
| `2` | CLI flag, configuration schema, `--run-root` overlap, or `Taskpack` manifest error |
| `3` | Run settled `blocked`, or unsupported capability (`CAPABILITY_UNSUPPORTED`) |
| `4` | Verification check or role execution settled `failed` |
| `5` | Allowance settled `exhausted` (`BUDGET_EXHAUSTED`, `ATTEMPT_LIMIT`, `REPEAT_FAILURE`) |
| `6` | Wall-clock deadline settled `expired` (`DEADLINE`) |
| `7` | Lease or recovery conflict (`OWNER_BUSY`, `AUTHORITY_REFUSED`, `RECOVERY_REQUIRED`) |
| `8` | State, artifact (`ARTIFACT_INVALID`), limit (`OUTPUT_LIMIT`), or cleanup incident |
| `130` | Run settled `cancelled` (`step cancel` or accounted `SIGINT`) |
| `143` | Accounted `SIGTERM` termination |

---

**See also** — [CLI](cli.md) (local operator subcommands and flags) · [Taskpack](../configuration/taskpack.md) (manifest roles, scope, and checks) · [Controller and Registry](../configuration/controller-and-registry.md) (delegated role profiles and trusted bindings)

**Next** → [Declarative Taskpack](../walkthroughs/declarative-taskpack.md) — author and verify a `.loopwright/taskpack.yaml` workflow end to end.
