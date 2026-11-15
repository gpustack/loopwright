---
name: loopwright-step
description: >-
  Drive Loopwright Managed Controller and Declarative Taskpack runs through the
  pull-based coroutine loop (loopwright step next | submit | cancel) with
  adapter: delegated OAuth coding agents and per-role --role-model overrides.
---

# Loopwright Step Driver

Drive bounded Loopwright pipelines from an OAuth-backed host coding agent with zero Loopwright provider API tokens, or bind distinct models per role via `--role-model`. Read [Coding Agents](https://docs.gpustack.ai/loopwright/latest/docs/operations/coding-agents/) and [CLI](https://docs.gpustack.ai/loopwright/latest/docs/operations/cli/) for complete coroutine and flag contracts.

## When to Use

- Run a [Taskpack](https://docs.gpustack.ai/loopwright/latest/docs/configuration/taskpack/) (`--taskpack` — compiles manifest roles as `adapter: delegated` with `publication.mode: disabled` and a pinned `HEAD` commit OID) or [ControllerConfig](https://docs.gpustack.ai/loopwright/latest/docs/configuration/controller-and-registry/) (`--config`, `--registry`, `--registry-sha256` with explicit `adapter: delegated` role profiles; set `publication.mode: disabled` and pin `target.sourceRevision` to `git rev-parse HEAD` for local-only runs).
- Override role model bindings at admission without editing YAML using `--role-model <roleId>=<provider>/<model>[:<thinking>]` (up to 8 flags, persisted in `run.json`, total CLI `argv <= 64`).
- Keep `--run-root` strictly disjoint from `--repo` (neither inside nor containing `--repo`, with zero symlink path components — resolve `pwd -P` on macOS `/tmp` or `/var`) so materialized workspaces (`<runRoot>/workspaces/<runId>/<attemptId>/`) never pollute the repository checkout.

## Pull Loop Protocol

### 1. Pull the next role assignment (`step next`)

Start a Declarative Taskpack run (`--mode candidate|no-change` optional):

```bash
loopwright step next --taskpack .loopwright/taskpack.yaml --repo <repo-dir> --run-root <outside-dir> --run-id <id> [--role-model <roleId>=<provider>/<model>[:<thinking>]] [--mode candidate|no-change] --json
```

Start a Managed Controller run (pin `target.sourceRevision` in `<controller.yaml>` to `git rev-parse HEAD`):

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
- **Workspace confinement**: Work ONLY inside `candidateDir`. Never edit `--repo` directly during stepping, follow paths into `<runRoot>/<runId>` or `.taskpack-<runId>`, or create symlinks, hardlinks (`nlink > 1`), or `.git` entries. Keep overlay changes within 128 files and 4 MiB (`<= 1 MiB` per file).
- **Read-only and format repairs**: When `repair === "format"` or `allowedTools` excludes mutating tools (`write`, `edit`, `delete`, `bash`) — such as `purpose: "reviewer"` — leave `candidateDir` byte-identical and report findings via `--status`, `--reason`, or `--submission-file`.
- **Protected paths**: Never touch `0o400` / `0o500` files in `candidateDir` or `.github/workflows/**`, `.claude/**`, `.agents/**`, `AGENTS.md`, and `CLAUDE.md`.

### 3. Optional fast screening (`jev`)

When the `jev` skill (`~/.agents/skills/jev/SKILL.md`) is installed locally, run a fast screen (`review-diff` or `eval`) on `candidateDir` diffs or review findings before calling `step submit`. Deliberate deeply when confidence is `< 0.80` or when `jev` disagrees with direct inspection.

### 4. Submit or cancel (`step submit` / `step cancel`)

Submit the finished attempt with its single-use `leaseToken`:

```bash
loopwright step submit --run-root <outside-dir> --run-id <id> --lease <leaseToken> [--submission-file <file>] [--status completed|no_change|failed|blocked] [--reason <text>] --json
```

`step submit` captures the diff, runs independent checks (`scope.v1`, `json-artifact.v1`, `no-change.v1`, `command.v1`), and returns either the next `StepYield` (`kind: "step"`) or the terminal run envelope (`kind: "result"` with `data.result.spec.status`, or `kind: "incident"`).

- **Lease rules**: Duplicate `step next` while parked fails with `OWNER_BUSY` (exit `7`). Pass `loopwright step next --run-root <dir> --run-id <id> --reissue-lease --json` ONLY if a leased worker died and lost its token. Stale or replayed tokens fail with `AUTHORITY_REFUSED` (exit `7`).
- **Pre-commit preservation**: Symlink (`O_NOFOLLOW`), hardlink (`nlink === 1`), size-ceiling, and read-only/`format` invariance checks run before mutating state, preserving `candidateDir` and the lease so you can remediate and re-submit.

To abort an active or parked run cleanly (removing staged workspaces and settling `cancelled`, exit `130`):

```bash
loopwright step cancel --run-root <outside-dir> --run-id <id> --json
```

### 5. Apply verified overlay to local checkout

`step next --taskpack` sets `publication.mode: disabled` and pins `target.sourceRevision` to `HEAD`'s commit OID automatically (for local-only Managed Controller runs, set `publication.mode: disabled` and pin `target.sourceRevision` to `git rev-parse HEAD` in `controller.yaml`), and **terminal `step submit` deletes `<runRoot>/workspaces/<runId>` (`candidateDir`)** while preserving verified state under `<runRoot>/<runId>`.

Once the run settles `completed`, export the digest-checked bundle to a **non-existent** `--output` path inside an existing parent directory (`loopwright inspect` creates `--output` with mode `0700` and rejects pre-existing directories):

```bash
INSPECT_DIR="$(cd "$(mktemp -d "${TMPDIR:-/tmp}/loopwright-inspect.XXXXXX")" && pwd -P)/bundle"
loopwright inspect --run-root <outside-dir> --run-id <id> --output "$INSPECT_DIR" --json
```

Confirm `"$INSPECT_DIR/result.json"` has `spec.status === "completed"`, ensure the local checkout is clean and `HEAD` matches the immutable baseline commit OID, then apply `"$INSPECT_DIR/candidate.files.json"` onto `<repo-dir>`. Because `candidate.files.json` exports `{ name, encoding, body }` without POSIX mode bits, existing `0755` bits on updated scripts are preserved while newly created files write as `0644` (`chmod +x` any brand-new executable script before `git add`):

```bash
node -e '
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const [inspectDir, repoArg] = process.argv.slice(1);
const repoRoot = fs.realpathSync(repoArg);
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
  if (file.encoding !== "base64") throw new Error(`Unsupported encoding: ${file.encoding}`);
  safePath(file.name);
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
  const nextBytes = Buffer.from(file.body, "base64");
  let mode = 0o644, unchanged = false;
  try {
    const st = fs.lstatSync(target);
    if (st.mode & 0o111) mode = 0o755;
    if (st.size === nextBytes.length && fs.readFileSync(target).equals(nextBytes)) unchanged = true;
  } catch {}
  if (unchanged) continue;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  safePath(file.name);
  const tmp = path.join(path.dirname(target), `.lw-apply-${process.pid}-${Math.random().toString(16).slice(2)}`);
  const fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, mode);
  try {
    fs.writeFileSync(fd, nextBytes);
    fs.fchmodSync(fd, mode);
    fs.closeSync(fd);
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.closeSync(fd); } catch {}
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}
' "$INSPECT_DIR" <repo-dir>
```

## Exit Codes

| Exit Code | Meaning |
| --- | --- |
| `0` | `step` yielded `awaiting_role`, or run settled `completed` / `no_change` |
| `2` | CLI usage, configuration, schema, `--run-root` overlap, or Taskpack manifest error |
| `3` | `blocked` outcome or unsupported capability (`CAPABILITY_UNSUPPORTED`) |
| `4` | Check verification or execution `failed` |
| `5` | `exhausted` (`BUDGET_EXHAUSTED`, `ATTEMPT_LIMIT`, `REPEAT_FAILURE`) |
| `6` | `expired` (`DEADLINE` wall-time drained) |
| `7` | Lease, owner, or recovery conflict (`OWNER_BUSY`, `AUTHORITY_REFUSED`, `RECOVERY_REQUIRED`, `reconcile_required`) |
| `8` | State, artifact (`ARTIFACT_INVALID`), limit (`OUTPUT_LIMIT`), or cleanup fault |
| `130` | `cancelled` (`step cancel` or `SIGINT`) |
| `143` | Terminated by `SIGTERM` |
