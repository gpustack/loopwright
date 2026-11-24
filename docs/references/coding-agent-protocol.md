# Coding Agent Protocol Reference

Evidence: contract.

Machine-readable `StepYield` JSON schema, lease-fencing diagnostics, exit codes, and verified `candidate.files.json` overlay-apply script for `loopwright step next | submit | cancel`.

## Contents

- [StepYield schema](#stepyield-schema)
- [Confinement and leases](#confinement-and-leases)
- [Overlay apply script](#overlay-apply-script)
- [Exit codes](#exit-codes)

## StepYield schema

With `--json`, `loopwright step next` and `loopwright step submit` emit versioned NDJSON `Envelope` lines (`{ version: 1, kind, sequence, runId, data }`). When `kind` is `"step"`, `data` conforms to `StepYield`:

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

## Confinement and leases

- **Isolated staging**: Modify files only inside `candidateDir`; leave `--repo`, `<runRoot>/<runId>`, and `<runRoot>/.taskpack-<runId>` untouched.
- **Regular files only**: Create zero symlinks (`O_NOFOLLOW`), zero hardlinks (`nlink === 1`), and zero `.git` entries inside `candidateDir`.
- **Overlay bounds**: Default `128` entries / `4 MiB` (configurable via `spec.limits.overlay` up to `16,384` files and `16 GiB` via `1 MiB` CAS streaming; depth `<= 32`, `<= 131,072` scanned entries).
- **Protected & read-only invariance**: Never modify or chmod `0o400`/`0o500` protected files, `.git`, `<controlRoot>`, `scope.protected`, or `.github/workflows/**` on GitHub policy runs. Leave `candidateDir` byte-identical when `repair === "format"` or `allowedTools` omits `write`, `edit`, `delete`, and `bash`.
- **Pre-commit scan recovery**: Scan failures (symlinks, hardlinks, size ceilings, read-only violations) release authority without consuming `leaseToken` or deleting `candidateDir` so the agent can fix and re-submit.

| Condition | Diagnostic code | Exit code |
| --- | --- | --- |
| Duplicate `step next` while parked | `OWNER_BUSY` | `7` |
| Replay or stale `leaseToken` after rotation | `AUTHORITY_REFUSED` | `7` |
| Unattended `run` or `resume` on delegated role | `CAPABILITY_UNSUPPORTED` | `3` |

## Overlay apply script

After `loopwright inspect --run-root "$RUN_ROOT" --run-id "$RUN_ID" --output "$INSPECT_DIR" --json` writes a fresh bundle (`0700`), verify `$INSPECT_DIR/result.json` settled `completed`, confirm a clean Git working tree matching `sourceRevision`, and apply `$INSPECT_DIR/candidate.files.json` (`version: 2` CAS pointers with `O_NOFOLLOW`, `nlink === 1`, `1 MiB` streaming SHA-256, and `100644`/`100755` mode preservation, plus passive `version: 1` fallback):

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
    if (file.mode !== "100644" && file.mode !== "100755") throw new Error(`Invalid mode: ${file.name}`);
    if (streamHash(file.blobPath, file.byteLength, null) !== file.sha256) throw new Error(`Digest mismatch: ${file.name}`);
  } else if (file.encoding !== "base64" || typeof file.body !== "string") {
    throw new Error(`Invalid v1 bundle entry: ${file.name}`);
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

**See also** — [Reference Hub](README.md) (flat reference routing and exact aliases) · [Coding Agents](../operations/coding-agents.md) (human-first delegated stepping workflow) · [CLI](../operations/cli.md) (operator subcommands and flags)
