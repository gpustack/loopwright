#!/usr/bin/env bash
set -euo pipefail

# Loopwright self-upgrade command.v1 verification gate.
# 1. Pre-audits candidate manifests, lockfile, protected files, and proposal ledger
#    against both baseline git HEAD and the trusted host-staged upgrade bundle
#    before executing any candidate code.
# 2. Materializes an isolated verification workspace under $TMPDIR.
# 3. Installs offline dependencies, compiles with read-only scripts/tools, and runs
#    candidate runtime gates with a read-only build/test tree inside OS containment
#    (Linux bwrap --unshare-all with allowlisted mounts, or macOS sandbox-exec with
#    default-denied $HOME/temp/socket reads, cross-process inspection/signal denial,
#    and pre-existing loopback port denial).

if [[ -n "${SELF_UPGRADE_TEST_NODE_MODULES:-}" ]]; then
  if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
    echo "verify.sh: SELF_UPGRADE_TEST_NODE_MODULES is forbidden when GITHUB_ACTIONS=true" >&2
    exit 1
  fi
  if [[ "${SELF_UPGRADE_ALLOW_TEST_FIXTURE:-}" != "1" ]]; then
    echo "verify.sh: SELF_UPGRADE_TEST_NODE_MODULES requires SELF_UPGRADE_ALLOW_TEST_FIXTURE=1" >&2
    exit 1
  fi
fi

resolve_executable() {
  local candidate
  for candidate in "$@"; do
    if [[ -n "$candidate" && -x "$candidate" && ! -d "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

NODE_BIN="$(resolve_executable \
  "${NODE_BIN_DIR:+${NODE_BIN_DIR}/node}" \
  "$(command -v node 2>/dev/null || true)" \
  "/usr/local/bin/node" \
  "/opt/homebrew/bin/node" \
  "/usr/bin/node")" || {
  echo "verify.sh: unable to locate trusted node executable" >&2
  exit 1
}
NODE_RESOLVED_DIR="$(cd "$(dirname "$NODE_BIN")" && pwd -P)"

NPM_BIN="$(resolve_executable \
  "${NODE_BIN_DIR:+${NODE_BIN_DIR}/npm}" \
  "${NODE_RESOLVED_DIR}/npm" \
  "$(command -v npm 2>/dev/null || true)" \
  "/usr/local/bin/npm" \
  "/opt/homebrew/bin/npm" \
  "/usr/bin/npm")" || {
  echo "verify.sh: unable to locate trusted npm executable" >&2
  exit 1
}

PYTHON_EXEC="$(resolve_executable \
  "${PYTHON_BIN:-}" \
  "$(command -v python3 2>/dev/null || true)" \
  "/usr/bin/python3" \
  "/usr/local/bin/python3" \
  "/opt/homebrew/bin/python3")" || {
  echo "verify.sh: unable to locate python3 executable" >&2
  exit 1
}

GIT_BIN="$(resolve_executable \
  "$(command -v git 2>/dev/null || true)" \
  "/usr/bin/git" \
  "/usr/local/bin/git" \
  "/opt/homebrew/bin/git")" || {
  echo "verify.sh: unable to locate git executable" >&2
  exit 1
}

HUGO_RESOLVED=""
if HUGO_FOUND="$(resolve_executable \
  "${HUGO_BIN:-}" \
  "$(command -v hugo 2>/dev/null || true)" \
  "/usr/local/bin/hugo" \
  "/opt/homebrew/bin/hugo" \
  "/usr/bin/hugo" 2>/dev/null)"; then
  HUGO_RESOLVED="$HUGO_FOUND"
fi
if [[ "${SELF_UPGRADE_REQUIRE_HUGO:-0}" == "1" && -z "$HUGO_RESOLVED" ]]; then
  echo "verify.sh: SELF_UPGRADE_REQUIRE_HUGO=1 but hugo binary was not found" >&2
  exit 1
fi

CANDIDATE_DIR="${LOOPWRIGHT_CANDIDATE_DIR:-$PWD}"
if [[ ! -d "$CANDIDATE_DIR" || -L "$CANDIDATE_DIR" ]]; then
  echo "verify.sh: candidate directory '$CANDIDATE_DIR' must be a real directory" >&2
  exit 1
fi
CANDIDATE_REAL="$("$PYTHON_EXEC" -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$CANDIDATE_DIR")"

BASELINE_REPO="${SELF_UPGRADE_REPO_ROOT:-}"
if [[ -z "$BASELINE_REPO" ]]; then
  if "$GIT_BIN" -C "$CANDIDATE_REAL" rev-parse --show-toplevel >/dev/null 2>&1; then
    BASELINE_REPO="$("$GIT_BIN" -C "$CANDIDATE_REAL" rev-parse --show-toplevel)"
  else
    echo "verify.sh: SELF_UPGRADE_REPO_ROOT must be set when candidate directory has no .git metadata" >&2
    exit 1
  fi
fi
BASELINE_REAL="$("$PYTHON_EXEC" -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$BASELINE_REPO")"

STAGE_RAW="${SELF_UPGRADE_STAGE_DIR:-/tmp/loopwright-self-upgrade-stage}"
if [[ ! -d "$STAGE_RAW" || -L "$STAGE_RAW" ]]; then
  echo "verify.sh: trusted stage directory '$STAGE_RAW' does not exist; run scripts/prepare-self-upgrade.mjs first" >&2
  exit 1
fi
STAGE_REAL="$("$PYTHON_EXEC" -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$STAGE_RAW")"

# ---------------------------------------------------------------------------
# Phase 1: Pre-execution manifest, lockfile, protected-file, and staged-bundle audit
# (Never loads or executes any candidate code prior to passing all checks.)
# ---------------------------------------------------------------------------
"$PYTHON_EXEC" - "$CANDIDATE_REAL" "$BASELINE_REAL" "$STAGE_REAL" "$GIT_BIN" <<'PY'
from __future__ import annotations
import hashlib
import json
import os
import re
import stat
import subprocess
import sys

candidate_dir, baseline_repo, stage_dir, git_bin = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

MAX_LOCKFILE_BYTES = 900 * 1024
MAX_JSON_BYTES = 64 * 1024
SEMVER_RE = re.compile(r"^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$")
FORBIDDEN_KEYS = {"__proto__", "constructor", "prototype"}
LIFECYCLE_HOOKS = {
    "preinstall",
    "install",
    "postinstall",
    "prepublish",
    "preprepare",
    "prepare",
    "postprepare",
}

PI_UPSTREAMS = {
    "pi-coding-agent": "@earendil-works/pi-coding-agent",
    "pi-ai": "@earendil-works/pi-ai",
    "pi-agent-core": "@earendil-works/pi-agent-core",
    "pi-mcp": "@earendil-works/pi-mcp",
    "pi-codemode": "@earendil-works/pi-codemode",
    "pi-tui": "@earendil-works/pi-tui",
}
PI_PACKAGES = set(PI_UPSTREAMS.values())
YAML_WORKSPACES = [
    "packages/cli",
    "packages/controller",
    "packages/decisions",
    "packages/github-app",
]
UNMANAGED_WORKSPACES = [
    "packages/core",
    "packages/state",
    "packages/memory",
    "packages/taskpack-runner",
]
ALL_WORKSPACES = sorted(["packages/agent-pi", *YAML_WORKSPACES, *UNMANAGED_WORKSPACES])
ALLOWED_WORKSPACE_LINKS = {
    f"node_modules/@loopwright/{ws.split('/', 1)[1]}": ws for ws in ALL_WORKSPACES
}
IMMUTABLE_TOOLCHAIN_PREFIXES = (
    "node_modules/typescript",
    "node_modules/eslint",
    "node_modules/typescript-eslint",
    "node_modules/@eslint/",
    "node_modules/@typescript-eslint/",
    "node_modules/@types/",
)
PROTECTED_EXACT_FILES = [
    "package.json",
    "tsconfig.json",
    "tsconfig.base.json",
    "tsconfig.test.json",
    "eslint.config.mjs",
    "action.yml",
    "AGENTS.md",
    ".loopwright/taskpack.yaml",
    ".loopwright/instructions.md",
    ".loopwright/checks/verify.sh",
]
PROTECTED_TREE_PREFIXES = [
    "scripts",
    ".github",
    ".agents",
    "packages/core",
    "packages/state",
    "packages/memory",
    "packages/taskpack-runner",
    "packages/agent-pi/qualification",
    "packages/controller/qualification",
    "docs/contribute",
]
PROTECTED_SOURCE_FILES = [
    "packages/cli/src/closure.ts",
    "packages/cli/src/failure-matrix.ts",
]


def fail(msg: str) -> None:
    sys.stderr.write(f"verify.sh audit failed: {msg}\n")
    sys.exit(1)


if (
    stage_dir == candidate_dir
    or stage_dir.startswith(candidate_dir + os.sep)
    or candidate_dir.startswith(stage_dir + os.sep)
):
    fail(f"trusted stage directory {stage_dir!r} must be disjoint from candidate directory {candidate_dir!r}")


def parse_semver(val: object) -> tuple[int, int, int]:
    if not isinstance(val, str):
        fail(f"expected canonical X.Y.Z SemVer string, got {val!r}")
    m = SEMVER_RE.match(val)
    if not m:
        fail(f"non-canonical SemVer {val!r} rejected")
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)))


def strict_json_loads(raw_bytes: bytes, label: str) -> dict:
    def check_pairs(pairs: list[tuple[str, object]]) -> dict:
        out: dict[str, object] = {}
        for k, v in pairs:
            if k in FORBIDDEN_KEYS:
                fail(f"{label} contains forbidden key {k!r}")
            if k in out:
                fail(f"{label} contains duplicate JSON key {k!r}")
            out[k] = v
        return out

    try:
        parsed = json.loads(raw_bytes.decode("utf-8"), object_pairs_hook=check_pairs)
    except Exception as exc:
        fail(f"{label} is not valid UTF-8 JSON: {exc}")
    if not isinstance(parsed, dict):
        fail(f"{label} root must be a JSON object")
    return parsed


def json_strict_equal(left: object, right: object) -> bool:
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        assert isinstance(right, dict)
        if set(left.keys()) != set(right.keys()):
            return False
        return all(json_strict_equal(left[k], right[k]) for k in left)
    if isinstance(left, list):
        assert isinstance(right, list)
        if len(left) != len(right):
            return False
        return all(json_strict_equal(a, b) for a, b in zip(left, right))
    return left == right


def read_regular_bytes_under(base_dir: str, rel_path: str, max_bytes: int, label_prefix: str) -> bytes:
    parts = [p for p in rel_path.split("/") if p]
    cur = base_dir
    for idx, seg in enumerate(parts):
        cur = os.path.join(cur, seg)
        try:
            st = os.lstat(cur)
        except OSError as exc:
            fail(f"missing required {label_prefix} file {rel_path!r}: {exc}")
        if stat.S_ISLNK(st.st_mode):
            fail(f"symlink forbidden at {label_prefix}:{rel_path!r}")
        if idx < len(parts) - 1:
            if not stat.S_ISDIR(st.st_mode):
                fail(f"non-directory parent at {label_prefix}:{rel_path!r}")
        elif not stat.S_ISREG(st.st_mode):
            fail(f"{label_prefix}:{rel_path!r} must be a regular file")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    fd = os.open(cur, flags)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            fail(f"{label_prefix}:{rel_path!r} must be a regular file")
        if st.st_nlink > 1:
            fail(f"hardlink forbidden at {label_prefix}:{rel_path!r} (nlink={st.st_nlink})")
        if st.st_size > max_bytes:
            fail(f"{label_prefix}:{rel_path!r} size {st.st_size} exceeds limit {max_bytes} bytes")
        chunks: list[bytes] = []
        remaining = st.st_size + 1
        while remaining > 0:
            chunk = os.read(fd, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        if len(data) > max_bytes:
            fail(f"{label_prefix}:{rel_path!r} exceeded limit {max_bytes} bytes")
        return data
    finally:
        os.close(fd)


def read_candidate_regular_bytes(rel_path: str, max_bytes: int) -> bytes:
    return read_regular_bytes_under(candidate_dir, rel_path, max_bytes, "candidate")


def read_staged_regular_bytes(rel_path: str, max_bytes: int) -> bytes:
    return read_regular_bytes_under(stage_dir, rel_path, max_bytes, "staged")


def git_show_head_optional(rel_path: str) -> bytes | None:
    env = {"PATH": "/usr/bin:/bin:/usr/local/bin", "GIT_CONFIG_NOSYSTEM": "1"}
    proc = subprocess.run(
        [git_bin, "-c", "core.hooksPath=/dev/null", "-C", baseline_repo, "show", f"HEAD:{rel_path}"],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if proc.returncode != 0:
        return None
    return proc.stdout


def git_show_head_required(rel_path: str) -> bytes:
    raw = git_show_head_optional(rel_path)
    if raw is None:
        fail(f"baseline git HEAD in {baseline_repo!r} is missing {rel_path!r}")
    return raw


# 1) Walk candidate tree to forbid symlinks, non-regular files, hardlinks, node_modules/, and nested ESLint/TypeScript configs
cand_tsconfigs: list[str] = []
for root, dirs, files in os.walk(candidate_dir, topdown=True, followlinks=False):
    if ".git" in dirs:
        dirs.remove(".git")
    if "node_modules" in dirs:
        fail("candidate directory must not contain node_modules/")
    for dname in list(dirs):
        full_d = os.path.join(root, dname)
        rel_d = os.path.relpath(full_d, candidate_dir).replace(os.sep, "/")
        st_d = os.lstat(full_d)
        if rel_d == ".claude/skills" and stat.S_ISLNK(st_d.st_mode) and os.readlink(full_d) == "../.agents/skills":
            dirs.remove(dname)
            continue
        if stat.S_ISLNK(st_d.st_mode) or not stat.S_ISDIR(st_d.st_mode):
            fail(f"candidate tree contains forbidden non-directory or symlink {rel_d!r}")
    for fname in files:
        full_f = os.path.join(root, fname)
        rel_f = os.path.relpath(full_f, candidate_dir).replace(os.sep, "/")
        if rel_f == ".git":
            continue
        st_f = os.lstat(full_f)
        if rel_f == ".claude/skills" and stat.S_ISLNK(st_f.st_mode) and os.readlink(full_f) == "../.agents/skills":
            continue
        if stat.S_ISLNK(st_f.st_mode) or not stat.S_ISREG(st_f.st_mode):
            fail(f"candidate tree contains forbidden non-regular or symlink entry {rel_f!r}")
        if st_f.st_nlink > 1:
            fail(f"candidate tree contains forbidden hardlink {rel_f!r}")
        if (fname.startswith("eslint.config.") or fname.startswith(".eslintrc")) and rel_f != "eslint.config.mjs":
            fail(f"candidate tree contains unauthorized ESLint configuration {rel_f!r}")
        if fname == "tsconfig.json" or (fname.startswith("tsconfig.") and fname.endswith(".json")):
            cand_tsconfigs.append(rel_f)

all_head_ls = subprocess.run(
    [git_bin, "-c", "core.hooksPath=/dev/null", "-C", baseline_repo, "ls-tree", "-r", "--name-only", "HEAD"],
    env={"PATH": "/usr/bin:/bin:/usr/local/bin", "GIT_CONFIG_NOSYSTEM": "1"},
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    check=True,
)
head_tsconfigs = sorted(
    line.strip()
    for line in all_head_ls.stdout.splitlines()
    if line.strip()
    and (
        os.path.basename(line.strip()) == "tsconfig.json"
        or (os.path.basename(line.strip()).startswith("tsconfig.") and os.path.basename(line.strip()).endswith(".json"))
    )
)
cand_tsconfigs.sort()
if cand_tsconfigs != head_tsconfigs:
    fail(f"candidate tsconfig*.json set {cand_tsconfigs!r} differs from baseline HEAD {head_tsconfigs!r}")
for ts_rel in head_tsconfigs:
    head_ts_raw = git_show_head_required(ts_rel)
    cand_ts_raw = read_candidate_regular_bytes(ts_rel, max(len(head_ts_raw) + 1024, 1024 * 1024))
    if cand_ts_raw != head_ts_raw:
        fail(f"protected TypeScript configuration {ts_rel!r} differs from baseline HEAD")

# 2) Verify protected root, control, and frozen subtree files match baseline git HEAD byte-for-byte
for protected_rel in [*PROTECTED_EXACT_FILES, *PROTECTED_SOURCE_FILES]:
    head_bytes = git_show_head_optional(protected_rel)
    cand_full = os.path.join(candidate_dir, protected_rel)
    if head_bytes is None:
        if os.path.lexists(cand_full):
            fail(f"protected file {protected_rel!r} was added in candidate but absent from HEAD")
        continue
    cand_bytes = read_candidate_regular_bytes(protected_rel, 1024 * 1024)
    if cand_bytes != head_bytes:
        fail(f"protected file {protected_rel!r} differs from baseline HEAD")

for tree_prefix in PROTECTED_TREE_PREFIXES:
    ls_proc = subprocess.run(
        [git_bin, "-c", "core.hooksPath=/dev/null", "-C", baseline_repo, "ls-tree", "-r", "--name-only", "HEAD", "--", tree_prefix],
        env={"PATH": "/usr/bin:/bin:/usr/local/bin", "GIT_CONFIG_NOSYSTEM": "1"},
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=True,
    )
    head_entries = sorted(line.strip() for line in ls_proc.stdout.splitlines() if line.strip())
    cand_entries: list[str] = []
    cand_tree_root = os.path.join(candidate_dir, tree_prefix)
    if os.path.exists(cand_tree_root):
        for r, _, fs in os.walk(cand_tree_root, followlinks=False):
            for f in fs:
                rel_entry = os.path.relpath(os.path.join(r, f), candidate_dir).replace(os.sep, "/")
                cand_entries.append(rel_entry)
    cand_entries.sort()
    if cand_entries != head_entries:
        fail(f"protected subtree {tree_prefix!r} entries differ from HEAD")
    for entry_rel in head_entries:
        head_raw = git_show_head_required(entry_rel)
        cand_raw = read_candidate_regular_bytes(entry_rel, max(len(head_raw) + 1024, 1024 * 1024))
        if cand_raw != head_raw:
            fail(f"protected file {entry_rel!r} differs from baseline HEAD")


def assert_no_lifecycle_hooks(pkg_obj: dict, label: str) -> None:
    scripts_obj = pkg_obj.get("scripts")
    if scripts_obj is None:
        return
    if not isinstance(scripts_obj, dict):
        fail(f"{label}.scripts must be an object when present")
    for hook in LIFECYCLE_HOOKS:
        if hook in scripts_obj:
            fail(f"{label}.scripts contains forbidden lifecycle hook {hook!r}")


root_pkg = strict_json_loads(read_candidate_regular_bytes("package.json", MAX_JSON_BYTES), "package.json")
assert_no_lifecycle_hooks(root_pkg, "package.json")

# 3) Load and validate trusted staged target-versions.json and package-lock.candidate.json
staged_target_bytes = read_staged_regular_bytes("target-versions.json", MAX_JSON_BYTES)
staged_target_doc = strict_json_loads(staged_target_bytes, "staged:target-versions.json")
if not json_strict_equal(staged_target_doc.get("schema_version"), 1):
    fail("staged target-versions.json schema_version must be 1")
staged_upstreams = staged_target_doc.get("upstreams")
staged_packages = staged_target_doc.get("packages")
if not isinstance(staged_upstreams, dict) or not isinstance(staged_packages, dict):
    fail("staged target-versions.json upstreams and packages must be objects")

expected_upstream_ids = set(PI_UPSTREAMS.keys()) | {"yaml"}
if set(staged_upstreams.keys()) != expected_upstream_ids:
    fail("staged target-versions.json upstreams keys mismatch")

staged_pi_versions: set[str] = set()
for up_id, exp_pkg in PI_UPSTREAMS.items():
    entry = staged_upstreams.get(up_id)
    if not isinstance(entry, dict) or not json_strict_equal(entry.get("package"), exp_pkg):
        fail(f"staged target-versions.json upstreams[{up_id!r}] invalid")
    parse_semver(entry.get("version"))
    staged_pi_versions.add(str(entry["version"]))
if len(staged_pi_versions) != 1:
    fail(f"staged target-versions.json @earendil-works/pi-* versions are skewed: {sorted(staged_pi_versions)}")
expected_pi_target = next(iter(staged_pi_versions))

yaml_entry = staged_upstreams.get("yaml")
if not isinstance(yaml_entry, dict) or not json_strict_equal(yaml_entry.get("package"), "yaml"):
    fail("staged target-versions.json upstreams['yaml'] invalid")
parse_semver(yaml_entry.get("version"))
expected_yaml_target = str(yaml_entry["version"])

staged_lock_bytes = read_staged_regular_bytes("package-lock.candidate.json", MAX_LOCKFILE_BYTES)
staged_lock_sha256 = hashlib.sha256(staged_lock_bytes).hexdigest()

# 4) Audit unmanaged workspace package.json files (must equal HEAD with strict JSON types)
for ws in UNMANAGED_WORKSPACES:
    rel = f"{ws}/package.json"
    head_pkg = strict_json_loads(git_show_head_required(rel), f"HEAD:{rel}")
    cand_pkg = strict_json_loads(read_candidate_regular_bytes(rel, MAX_JSON_BYTES), rel)
    assert_no_lifecycle_hooks(cand_pkg, rel)
    if not json_strict_equal(cand_pkg, head_pkg):
        fail(f"unmanaged manifest {rel!r} was modified")

# 5) Audit packages/agent-pi/package.json against HEAD and staged target-versions.json
agent_rel = "packages/agent-pi/package.json"
head_agent = strict_json_loads(git_show_head_required(agent_rel), f"HEAD:{agent_rel}")
cand_agent = strict_json_loads(read_candidate_regular_bytes(agent_rel, MAX_JSON_BYTES), agent_rel)
assert_no_lifecycle_hooks(cand_agent, agent_rel)

if set(cand_agent.keys()) != set(head_agent.keys()):
    fail(f"{agent_rel} top-level fields changed")
for k in head_agent:
    if k == "dependencies":
        continue
    if not json_strict_equal(cand_agent[k], head_agent[k]):
        fail(f"{agent_rel} field {k!r} must not be modified")

head_agent_deps = head_agent.get("dependencies")
cand_agent_deps = cand_agent.get("dependencies")
if not isinstance(head_agent_deps, dict) or not isinstance(cand_agent_deps, dict):
    fail(f"{agent_rel}.dependencies must be an object")
if set(cand_agent_deps.keys()) != set(head_agent_deps.keys()):
    fail(f"{agent_rel}.dependencies keys changed")

head_pi_versions: set[str] = set()
cand_pi_versions: set[str] = set()
for dep_name, head_ver in head_agent_deps.items():
    cand_ver = cand_agent_deps[dep_name]
    if dep_name in PI_PACKAGES:
        cand_tuple = parse_semver(cand_ver)
        head_tuple = parse_semver(head_ver)
        if cand_tuple < head_tuple:
            fail(f"{agent_rel} rolled back {dep_name} from {head_ver} to {cand_ver}")
        head_pi_versions.add(str(head_ver))
        cand_pi_versions.add(str(cand_ver))
    else:
        if not json_strict_equal(cand_ver, head_ver):
            fail(f"{agent_rel} unauthorized dependency edit on {dep_name!r}")

if len(head_pi_versions) != 1:
    fail(f"HEAD {agent_rel} @earendil-works/pi-* versions are skewed")
if len(cand_pi_versions) != 1:
    fail(f"{agent_rel} @earendil-works/pi-* versions are skewed: {sorted(cand_pi_versions)}")
head_pi_ver = next(iter(head_pi_versions))
pi_target = next(iter(cand_pi_versions))
if pi_target != expected_pi_target:
    fail(f"{agent_rel} @earendil-works/pi-* version {pi_target!r} != staged target {expected_pi_target!r}")

# 6) Audit yaml workspace package.json files against HEAD and staged target-versions.json
head_yaml_versions: set[str] = set()
yaml_versions: set[str] = set()
for ws in YAML_WORKSPACES:
    rel = f"{ws}/package.json"
    head_pkg = strict_json_loads(git_show_head_required(rel), f"HEAD:{rel}")
    cand_pkg = strict_json_loads(read_candidate_regular_bytes(rel, MAX_JSON_BYTES), rel)
    assert_no_lifecycle_hooks(cand_pkg, rel)
    if set(cand_pkg.keys()) != set(head_pkg.keys()):
        fail(f"{rel} top-level fields changed")
    for k in head_pkg:
        if k == "dependencies":
            continue
        if not json_strict_equal(cand_pkg[k], head_pkg[k]):
            fail(f"{rel} field {k!r} must not be modified")
    head_deps = head_pkg.get("dependencies")
    cand_deps = cand_pkg.get("dependencies")
    if not isinstance(head_deps, dict) or not isinstance(cand_deps, dict):
        fail(f"{rel}.dependencies must be an object")
    if set(cand_deps.keys()) != set(head_deps.keys()):
        fail(f"{rel}.dependencies keys changed")
    for dep_name, head_ver in head_deps.items():
        cand_ver = cand_deps[dep_name]
        if dep_name == "yaml":
            cand_tuple = parse_semver(cand_ver)
            head_tuple = parse_semver(head_ver)
            if cand_tuple < head_tuple:
                fail(f"{rel} rolled back yaml from {head_ver} to {cand_ver}")
            head_yaml_versions.add(str(head_ver))
            yaml_versions.add(str(cand_ver))
        else:
            if not json_strict_equal(cand_ver, head_ver):
                fail(f"{rel} unauthorized dependency edit on {dep_name!r}")

if len(head_yaml_versions) != 1:
    fail("HEAD workspace yaml versions are skewed")
if len(yaml_versions) != 1:
    fail(f"direct workspace yaml versions are skewed: {sorted(yaml_versions)}")
head_yaml_ver = next(iter(head_yaml_versions))
yaml_target = next(iter(yaml_versions))
if yaml_target != expected_yaml_target:
    fail(f"workspace yaml version {yaml_target!r} != staged target {expected_yaml_target!r}")

# Candidate mode MUST strictly advance at least one dependency group beyond HEAD
if parse_semver(pi_target) == parse_semver(head_pi_ver) and parse_semver(yaml_target) == parse_semver(head_yaml_ver):
    fail("candidate manifests do not advance @earendil-works/pi-* or yaml beyond baseline HEAD")

# 7) Audit package-lock.json structurally AND bind byte-for-byte to staged package-lock.candidate.json
head_lock_doc = strict_json_loads(git_show_head_required("package-lock.json"), "HEAD:package-lock.json")
head_lock_packages = head_lock_doc.get("packages")
if not isinstance(head_lock_packages, dict):
    fail("HEAD:package-lock.json.packages must be an object")

lock_bytes = read_candidate_regular_bytes("package-lock.json", MAX_LOCKFILE_BYTES)
lock_doc = strict_json_loads(lock_bytes, "package-lock.json")
if not json_strict_equal(lock_doc.get("lockfileVersion"), 3):
    fail(f"package-lock.json lockfileVersion must be 3, got {lock_doc.get('lockfileVersion')!r}")
lock_packages = lock_doc.get("packages")
if not isinstance(lock_packages, dict):
    fail("package-lock.json.packages must be an object")

for pkg_key, pkg_entry in lock_packages.items():
    if not isinstance(pkg_entry, dict):
        fail(f"package-lock.json.packages[{pkg_key!r}] must be an object")
    if pkg_key == "" or pkg_key.startswith("packages/"):
        if "hasInstallScript" in pkg_entry and not json_strict_equal(pkg_entry.get("hasInstallScript"), False):
            fail(f"workspace {pkg_key!r} in package-lock.json must not set hasInstallScript")
        if "link" in pkg_entry and not json_strict_equal(pkg_entry.get("link"), False):
            fail(f"workspace {pkg_key!r} in package-lock.json must not be a link")
        assert_no_lifecycle_hooks(pkg_entry, f"package-lock.json:{pkg_key}")
        continue

    if "link" in pkg_entry and not json_strict_equal(pkg_entry.get("link"), False):
        if not json_strict_equal(pkg_entry.get("link"), True):
            fail(f"package-lock.json entry {pkg_key!r} has non-boolean link field")
        expected_target = ALLOWED_WORKSPACE_LINKS.get(pkg_key)
        if expected_target is None or not json_strict_equal(pkg_entry.get("resolved"), expected_target):
            fail(f"package-lock.json contains unauthorized link entry {pkg_key!r} -> {pkg_entry.get('resolved')!r}")
        continue

    if pkg_key in ALLOWED_WORKSPACE_LINKS:
        fail(f"package-lock.json workspace entry {pkg_key!r} must remain a workspace link")

    resolved_url = pkg_entry.get("resolved")
    if resolved_url is not None:
        if not isinstance(resolved_url, str) or not resolved_url.startswith("https://registry.npmjs.org/"):
            fail(f"package-lock.json entry {pkg_key!r} uses unapproved resolved source {resolved_url!r}")
        integrity_val = pkg_entry.get("integrity")
        if not isinstance(integrity_val, str) or not integrity_val.startswith("sha512-"):
            fail(f"package-lock.json entry {pkg_key!r} missing sha512 integrity digest")
    else:
        head_existing = head_lock_packages.get(pkg_key)
        if not json_strict_equal(head_existing, pkg_entry):
            fail(f"package-lock.json entry {pkg_key!r} omits resolved URL without matching HEAD")

    if "hasInstallScript" in pkg_entry and not json_strict_equal(pkg_entry.get("hasInstallScript"), False):
        if not json_strict_equal(pkg_entry.get("hasInstallScript"), True):
            fail(f"package-lock.json entry {pkg_key!r} has non-boolean hasInstallScript")
        head_existing = head_lock_packages.get(pkg_key)
        if not isinstance(head_existing, dict) or not json_strict_equal(head_existing.get("hasInstallScript"), True):
            fail(f"package-lock.json entry {pkg_key!r} introduces forbidden install script")

# Require compiler and linter toolchain entries in package-lock.json to match HEAD
all_toolchain_keys = {
    k for k in (set(head_lock_packages.keys()) | set(lock_packages.keys()))
    if k.startswith(IMMUTABLE_TOOLCHAIN_PREFIXES)
}
for tk in sorted(all_toolchain_keys):
    if not json_strict_equal(lock_packages.get(tk), head_lock_packages.get(tk)):
        fail(f"package-lock.json modified immutable toolchain entry {tk!r}")

expected_ws_deps: dict[str, dict[str, str]] = {
    "packages/agent-pi": {pkg: pi_target for pkg in sorted(PI_PACKAGES)},
    "packages/cli": {"yaml": yaml_target},
    "packages/controller": {"yaml": yaml_target},
    "packages/decisions": {"yaml": yaml_target},
    "packages/github-app": {"yaml": yaml_target},
}

if not json_strict_equal(staged_packages, expected_ws_deps):
    fail("staged target-versions.json packages map does not match expected workspace dependencies")

for ws, dep_map in expected_ws_deps.items():
    ws_entry = lock_packages.get(ws)
    if not isinstance(ws_entry, dict):
        fail(f"package-lock.json missing workspace entry {ws!r}")
    ws_deps = ws_entry.get("dependencies")
    if not isinstance(ws_deps, dict):
        fail(f"package-lock.json workspace {ws!r} missing dependencies")
    for dep_name, exp_ver in dep_map.items():
        if not json_strict_equal(ws_deps.get(dep_name), exp_ver):
            fail(f"package-lock.json {ws}.dependencies[{dep_name!r}]={ws_deps.get(dep_name)!r} != {exp_ver!r}")
        local_key = f"{ws}/node_modules/{dep_name}"
        hoisted_key = f"node_modules/{dep_name}"
        resolved_entry = lock_packages[local_key] if local_key in lock_packages else lock_packages.get(hoisted_key)
        if not isinstance(resolved_entry, dict) or not json_strict_equal(resolved_entry.get("version"), exp_ver):
            actual = resolved_entry.get("version") if isinstance(resolved_entry, dict) else None
            fail(f"package-lock.json direct resolution for {ws} -> {dep_name} is {actual!r}, expected {exp_ver!r}")

cand_lock_sha256 = hashlib.sha256(lock_bytes).hexdigest()
if cand_lock_sha256 != staged_lock_sha256:
    fail(
        f"candidate package-lock.json sha256 ({cand_lock_sha256}) does not match trusted staged package-lock.candidate.json ({staged_lock_sha256})"
    )

# 8) Audit .loopwright/proposal.json parity against staged target-versions.json
proposal_doc = strict_json_loads(
    read_candidate_regular_bytes(".loopwright/proposal.json", MAX_JSON_BYTES),
    ".loopwright/proposal.json",
)
if not json_strict_equal(proposal_doc.get("schema_version"), 1):
    fail(".loopwright/proposal.json schema_version must be 1")
summary = proposal_doc.get("summary")
if not isinstance(summary, str) or not summary.strip():
    fail(".loopwright/proposal.json summary must be non-empty")
prop_upstreams = proposal_doc.get("upstreams")
prop_packages = proposal_doc.get("packages")
if not isinstance(prop_upstreams, dict) or not isinstance(prop_packages, dict):
    fail(".loopwright/proposal.json upstreams and packages must be objects")

if set(prop_upstreams.keys()) != expected_upstream_ids:
    fail(".loopwright/proposal.json upstreams keys mismatch")
for up_id, exp_pkg in {**PI_UPSTREAMS, "yaml": "yaml"}.items():
    entry = prop_upstreams.get(up_id)
    exp_ver = yaml_target if up_id == "yaml" else pi_target
    if not isinstance(entry, dict) or not json_strict_equal(entry.get("package"), exp_pkg) or not json_strict_equal(entry.get("version"), exp_ver):
        fail(f".loopwright/proposal.json upstreams[{up_id!r}] does not match staged target {exp_ver!r}")

if not json_strict_equal(prop_packages, expected_ws_deps):
    fail(".loopwright/proposal.json packages does not match staged target-versions.json")
PY

# ---------------------------------------------------------------------------
# Phase 2: Materialize isolated verification workspace under $TMPDIR
# ---------------------------------------------------------------------------
RAW_TMP_BASE="${TMPDIR:-/tmp}"
REAL_TMP_BASE="$("$PYTHON_EXEC" -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$RAW_TMP_BASE")"
WORK_ROOT="$(mktemp -d "${REAL_TMP_BASE%/}/lwv.XXXXXX")"
chmod 0700 "$WORK_ROOT"
cleanup() {
  chmod -R u+w "$WORK_ROOT" >/dev/null 2>&1 || true
  rm -rf "$WORK_ROOT" >/dev/null 2>&1 || true
}
trap cleanup EXIT

BUILD_WORK="${WORK_ROOT}/build"
RUNTIME_WORK="${WORK_ROOT}/run"
BUILD_HOME="${WORK_ROOT}/hb"
BUILD_TMP="${WORK_ROOT}/tb"
RUNTIME_HOME="${WORK_ROOT}/hr"
RUNTIME_TMP="${WORK_ROOT}/tr"
WORK_NPM_CACHE="${WORK_ROOT}/npm-cache"
mkdir -p "$BUILD_WORK" "$BUILD_HOME" "$BUILD_TMP"
chmod 0700 "$BUILD_WORK" "$BUILD_HOME" "$BUILD_TMP"

"$PYTHON_EXEC" - "$CANDIDATE_REAL" "$BUILD_WORK" <<'PY'
from __future__ import annotations
import os
import shutil
import stat
import sys

src_root, dst_root = sys.argv[1], sys.argv[2]
SKIP_DIRS = {".git", ".claude", "node_modules", ".test-build", "dist", "dist-release"}

for root, dirs, files in os.walk(src_root, topdown=True, followlinks=False):
    dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
    rel_dir = os.path.relpath(root, src_root)
    target_dir = dst_root if rel_dir == "." else os.path.join(dst_root, rel_dir)
    os.makedirs(target_dir, mode=0o755, exist_ok=True)
    for fname in files:
        if fname == ".git":
            continue
        s_path = os.path.join(root, fname)
        st = os.lstat(s_path)
        if not stat.S_ISREG(st.st_mode) or stat.S_ISLNK(st.st_mode):
            raise RuntimeError(f"non-regular file {s_path}")
        d_path = os.path.join(target_dir, fname)
        shutil.copyfile(s_path, d_path, follow_symlinks=False)
        os.chmod(d_path, 0o755 if (st.st_mode & 0o111) else 0o644)

if os.path.isdir(os.path.join(dst_root, ".agents", "skills")):
    claude_dir = os.path.join(dst_root, ".claude")
    os.makedirs(claude_dir, mode=0o755, exist_ok=True)
    os.symlink("../.agents/skills", os.path.join(claude_dir, "skills"))
PY

RAW_CACHE="${SELF_UPGRADE_NPM_CACHE:-${STAGE_REAL}/npm-cache}"
if [[ -d "$RAW_CACHE" ]]; then
  cp -R "$RAW_CACHE" "$WORK_NPM_CACHE"
  chmod -R u+w "$WORK_NPM_CACHE"
elif [[ -n "${SELF_UPGRADE_TEST_NODE_MODULES:-}" ]]; then
  mkdir -p "$WORK_NPM_CACHE"
  chmod 0700 "$WORK_NPM_CACHE"
else
  echo "verify.sh: offline npm cache '$RAW_CACHE' not found; run scripts/prepare-self-upgrade.mjs first" >&2
  exit 1
fi

TEST_NM_REAL=""
if [[ -n "${SELF_UPGRADE_TEST_NODE_MODULES:-}" ]]; then
  TEST_NM_REAL="$("$PYTHON_EXEC" -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$SELF_UPGRADE_TEST_NODE_MODULES")"
  if [[ ! -d "$TEST_NM_REAL" ]]; then
    echo "verify.sh: SELF_UPGRADE_TEST_NODE_MODULES '$TEST_NM_REAL' does not exist" >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Phase 3: Contained offline install, read-only compile, and read-only runtime gates
# ---------------------------------------------------------------------------
COMPILE_RUNNER="${WORK_ROOT}/run-compile.sh"
cat >"$COMPILE_RUNNER" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

"$VERIFY_NODE_BIN" scripts/build.mjs
"$VERIFY_NODE_BIN" ./node_modules/typescript/bin/tsc -p tsconfig.test.json --noEmit
"$VERIFY_NODE_BIN" ./node_modules/eslint/bin/eslint.js --config eslint.config.mjs --no-config-lookup --no-cache .
"$VERIFY_NODE_BIN" scripts/check-docs.mjs
"$VERIFY_NODE_BIN" ./node_modules/typescript/bin/tsc -p tsconfig.test.json
if [[ -n "${HUGO_BIN:-}" ]]; then
  "$VERIFY_NODE_BIN" scripts/site.mjs build
fi
EOF
chmod 0555 "$COMPILE_RUNNER"

TEST_RUNNER="${WORK_ROOT}/run-tests.sh"
cat >"$TEST_RUNNER" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

"$VERIFY_NODE_BIN" packages/cli/dist/main.js closure --verify-failures
"$VERIFY_NODE_BIN" scripts/run-tests.mjs
EOF
chmod 0555 "$TEST_RUNNER"

export BUILD_WORK RUNTIME_WORK BUILD_HOME BUILD_TMP RUNTIME_HOME RUNTIME_TMP WORK_NPM_CACHE WORK_ROOT
export BASELINE_REAL CANDIDATE_REAL STAGE_REAL TEST_NM_REAL PYTHON_EXEC
export NODE_BIN NPM_BIN NODE_RESOLVED_DIR HUGO_RESOLVED COMPILE_RUNNER TEST_RUNNER

"$PYTHON_EXEC" - <<'PY'
from __future__ import annotations
import errno
import hashlib
import os
import pwd
import shutil
import signal
import stat
import subprocess
import sys
import time

build_dir = os.path.realpath(os.environ["BUILD_WORK"])
runtime_dir = os.path.join(os.path.realpath(os.environ["WORK_ROOT"]), "run")
build_home = os.path.realpath(os.environ["BUILD_HOME"])
build_tmp = os.path.realpath(os.environ["BUILD_TMP"])
runtime_home = os.path.join(os.path.realpath(os.environ["WORK_ROOT"]), "hr")
runtime_tmp = os.path.join(os.path.realpath(os.environ["WORK_ROOT"]), "tr")
work_npm_cache = os.path.realpath(os.environ["WORK_NPM_CACHE"])
work_root = os.path.realpath(os.environ["WORK_ROOT"])
baseline_repo = os.path.realpath(os.environ["BASELINE_REAL"])
candidate_dir = os.path.realpath(os.environ["CANDIDATE_REAL"])
stage_dir = os.path.realpath(os.environ["STAGE_REAL"])
test_nm_real = os.environ.get("TEST_NM_REAL", "").strip()
python_exec = os.path.realpath(os.environ["PYTHON_EXEC"])
node_bin = os.path.realpath(os.environ["NODE_BIN"])
npm_bin = os.path.realpath(os.environ["NPM_BIN"])
node_dir = os.path.realpath(os.environ["NODE_RESOLVED_DIR"])
node_install_root = os.path.dirname(node_dir)
hugo_raw = os.environ.get("HUGO_RESOLVED", "").strip()
hugo_bin = os.path.realpath(hugo_raw) if hugo_raw else ""
compile_runner = os.path.realpath(os.environ["COMPILE_RUNNER"])
test_runner = os.path.realpath(os.environ["TEST_RUNNER"])
run_root_env = os.environ.get("SELF_UPGRADE_RUN_ROOT", "").strip()

platform_name = sys.platform
is_dedicated_runner = os.environ.get("GITHUB_ACTIONS") == "true"

# Verify OS containment backend availability upfront when running outside a dedicated GitHub Actions VM
bwrap_bin: str | None = None
if is_dedicated_runner:
    pass
elif platform_name == "darwin":
    seatbelt_bin = "/usr/bin/sandbox-exec"
    if not (os.path.isfile(seatbelt_bin) and os.access(seatbelt_bin, os.X_OK)):
        sys.stderr.write("verify.sh: /usr/bin/sandbox-exec unavailable on macOS; failing closed\n")
        sys.exit(1)
    seatbelt_probe = subprocess.run(
        [
            seatbelt_bin,
            "-p",
            '(version 1)\n(allow default)\n(deny file-write* (literal "/System/nonexistent"))\n',
            "/usr/bin/true",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if seatbelt_probe.returncode != 0:
        sys.stderr.write("verify.sh: /usr/bin/sandbox-exec containment unavailable on macOS; failing closed\n")
        sys.exit(1)
elif platform_name.startswith("linux"):
    for candidate in ("/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"):
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            probe = subprocess.run(
                [candidate, "--unshare-all", "--ro-bind", "/", "/", "--", "/bin/true"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
            if probe.returncode == 0:
                bwrap_bin = candidate
                break
    if bwrap_bin is None:
        sys.stderr.write("verify.sh: Linux bwrap --unshare-all unavailable; failing closed\n")
        sys.exit(1)
else:
    sys.stderr.write(f"verify.sh: unsupported host platform {platform_name!r}; failing closed\n")
    sys.exit(1)

try:
    real_user_home = os.path.realpath(pwd.getpwuid(os.getuid()).pw_dir)
except Exception:
    real_user_home = ""

denied_read_roots: set[str] = set()
for candidate_root in [
    real_user_home,
    os.environ.get("HOME", ""),
    os.environ.get("TMPDIR", ""),
    os.environ.get("RUNNER_TEMP", ""),
    run_root_env,
    baseline_repo,
    candidate_dir,
    stage_dir,
    "/tmp",
    "/private/tmp",
    "/var/folders",
    "/private/var/folders",
    "/var/run",
    "/private/var/run",
    "/run",
]:
    if not candidate_root:
        continue
    real_p = os.path.realpath(candidate_root)
    if real_p and real_p != "/":
        denied_read_roots.add(real_p)

allowed_read_roots: list[str] = [work_root]


def add_tool_read_root(raw_path: str) -> None:
    if not raw_path:
        return
    rp = os.path.realpath(raw_path)
    if not rp or rp == "/":
        return
    if real_user_home and (rp == real_user_home or real_user_home.startswith(rp + "/")):
        return
    if rp not in allowed_read_roots:
        allowed_read_roots.append(rp)


add_tool_read_root(node_install_root)
add_tool_read_root(os.path.dirname(os.path.dirname(node_bin)))
add_tool_read_root(node_dir)
add_tool_read_root(os.path.dirname(node_bin))
add_tool_read_root(os.path.dirname(os.path.dirname(python_exec)))
add_tool_read_root(os.path.dirname(python_exec))
if "/node_modules/npm/" in npm_bin:
    npm_pkg_root = npm_bin.split("/node_modules/npm/", 1)[0] + "/node_modules/npm"
    add_tool_read_root(npm_pkg_root)
else:
    add_tool_read_root(os.path.dirname(npm_bin))
if hugo_bin:
    add_tool_read_root(os.path.dirname(hugo_bin))
if test_nm_real:
    add_tool_read_root(test_nm_real)


def make_stage_env(home_dir: str, tmp_dir: str, extra: dict[str, str] | None = None) -> dict[str, str]:
    env: dict[str, str] = {
        "PATH": f"{node_dir}:/usr/local/bin:/usr/bin:/bin",
        "HOME": home_dir,
        "TMPDIR": tmp_dir,
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "TERM": "dumb",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_TERMINAL_PROMPT": "0",
        "NPM_CONFIG_CACHE": work_npm_cache,
        "npm_config_cache": work_npm_cache,
        "npm_config_offline": "true",
        "npm_config_ignore_scripts": "true",
        "npm_config_audit": "false",
        "npm_config_fund": "false",
        "npm_config_update_notifier": "false",
        "VERIFY_NODE_BIN": node_bin,
    }
    if hugo_bin:
        env["HUGO_BIN"] = hugo_bin
        env["HUGO_NOBUILDLOCK"] = "true"
    if extra:
        env.update(extra)
    return env


def escape_sbpl(val: str) -> str:
    return val.replace("\\", "\\\\").replace('"', '\\"')


def file_sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(65536)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def snapshot_and_lock_masks(
    paths: list[str],
    dir_modes: dict[str, int] | None = None,
    file_snap: dict[str, tuple[int, str, int]] | None = None,
) -> tuple[dict[str, int], dict[str, tuple[int, str, int]]]:
    if dir_modes is None:
        dir_modes = {}
    if file_snap is None:
        file_snap = {}
    for target in paths:
        if not os.path.lexists(target):
            continue
        st_top = os.lstat(target)
        if stat.S_ISLNK(st_top.st_mode):
            continue
        if stat.S_ISREG(st_top.st_mode):
            if target not in file_snap:
                orig_mode = stat.S_IMODE(st_top.st_mode)
                file_snap[target] = (orig_mode, file_sha256(target), st_top.st_ino)
                os.chmod(target, orig_mode & ~0o222)
            continue
        if not stat.S_ISDIR(st_top.st_mode):
            continue
        for r, _, files in os.walk(target, topdown=False, followlinks=False):
            st_r = os.lstat(r)
            if stat.S_ISLNK(st_r.st_mode):
                continue
            orig_dir_mode = stat.S_IMODE(st_r.st_mode)
            if r not in dir_modes:
                dir_modes[r] = orig_dir_mode
            for fname in files:
                fp = os.path.join(r, fname)
                st_f = os.lstat(fp)
                if not stat.S_ISLNK(st_f.st_mode) and stat.S_ISREG(st_f.st_mode):
                    if fp not in file_snap:
                        orig_f_mode = stat.S_IMODE(st_f.st_mode)
                        file_snap[fp] = (orig_f_mode, file_sha256(fp), st_f.st_ino)
                        os.chmod(fp, orig_f_mode & ~0o222)
            os.chmod(r, dir_modes[r] & ~0o222)
    return dir_modes, file_snap


def restore_and_verify_regular_file(
    path: str,
    st_entry: os.stat_result,
    expected: tuple[int, str, int],
) -> str | None:
    orig_mode, exp_sha256, exp_ino = expected
    issue: str | None = None
    try:
        os.chmod(path, orig_mode)
    except OSError:
        issue = f"masked file restore failed during stage: {path}"
    try:
        actual_sha256 = file_sha256(path)
    except OSError as exc:
        return issue or f"masked file unreadable during verify: {path} ({exc.strerror or exc})"
    if st_entry.st_ino != exp_ino or actual_sha256 != exp_sha256:
        return issue or f"masked file modified during stage: {path}"
    return issue


def restore_and_verify_masks(
    paths: list[str],
    dir_modes: dict[str, int],
    file_snap: dict[str, tuple[int, str, int]],
) -> str | None:
    tampered: str | None = None
    seen_files: set[str] = set()
    seen_dirs: set[str] = set()
    for dpath in sorted(dir_modes.keys(), key=len):
        try:
            if not os.path.lexists(dpath):
                tampered = tampered or f"masked directory removed during stage: {dpath}"
                continue
            st_d = os.lstat(dpath)
            if stat.S_ISLNK(st_d.st_mode) or not stat.S_ISDIR(st_d.st_mode):
                tampered = tampered or f"masked directory replaced during stage: {dpath}"
                continue
            os.chmod(dpath, dir_modes[dpath])
        except OSError:
            tampered = tampered or f"masked directory restore failed during stage: {dpath}"
    for target in paths:
        if not os.path.lexists(target):
            if target in file_snap or target in dir_modes:
                tampered = tampered or f"masked path deleted during stage: {target}"
            continue
        st_top = os.lstat(target)
        if stat.S_ISLNK(st_top.st_mode):
            if target in file_snap or target in dir_modes:
                tampered = tampered or f"masked path replaced by symlink during stage: {target}"
            continue
        if stat.S_ISREG(st_top.st_mode):
            if target in dir_modes:
                tampered = tampered or f"masked directory replaced by file during stage: {target}"
                continue
            seen_files.add(target)
            expected = file_snap.get(target)
            if expected is None:
                tampered = tampered or f"unexpected file created at masked path: {target}"
            else:
                tampered = tampered or restore_and_verify_regular_file(target, st_top, expected)
            continue
        if not stat.S_ISDIR(st_top.st_mode):
            if target in file_snap or target in dir_modes:
                tampered = tampered or f"masked path replaced by non-directory during stage: {target}"
            continue
        if target in file_snap:
            tampered = tampered or f"masked file replaced by directory during stage: {target}"
            continue
        for r, dirs, files in os.walk(target, topdown=True, followlinks=False):
            seen_dirs.add(r)
            if r not in dir_modes:
                tampered = tampered or f"unexpected directory created inside masked tree: {r}"
            for dname in list(dirs):
                dp = os.path.join(r, dname)
                st_sub = os.lstat(dp)
                if stat.S_ISLNK(st_sub.st_mode):
                    if dp in dir_modes or dp in file_snap:
                        tampered = tampered or f"masked path replaced by symlink inside masked tree: {dp}"
                    dirs.remove(dname)
                elif dp not in dir_modes:
                    tampered = tampered or f"unexpected directory created inside masked tree: {dp}"
            for fname in files:
                fp = os.path.join(r, fname)
                st_f = os.lstat(fp)
                if stat.S_ISLNK(st_f.st_mode):
                    if fp in file_snap or fp in dir_modes:
                        tampered = tampered or f"masked path replaced by symlink inside masked tree: {fp}"
                    continue
                if not stat.S_ISREG(st_f.st_mode):
                    tampered = tampered or f"unexpected non-regular entry inside masked tree: {fp}"
                    continue
                seen_files.add(fp)
                expected = file_snap.get(fp)
                if expected is None:
                    tampered = tampered or f"unexpected file created inside masked tree: {fp}"
                else:
                    tampered = tampered or restore_and_verify_regular_file(fp, st_f, expected)
    if tampered is None and len(seen_dirs) < len(dir_modes):
        missing_dirs = sorted(set(dir_modes.keys()) - seen_dirs)
        if missing_dirs:
            tampered = f"masked directory removed during stage: {missing_dirs[0]}"
    if tampered is None and len(seen_files) < len(file_snap):
        missing = sorted(set(file_snap.keys()) - seen_files)
        if missing:
            tampered = f"masked file removed during stage: {missing[0]}"
    return tampered


def run_contained(
    stage_label: str,
    argv: list[str],
    stage_cwd: str,
    stage_env: dict[str, str],
    writable_paths: list[str],
    readonly_subpaths_after_writable: list[str],
    network_mode: str,
) -> None:
    if network_mode not in ("none", "loopback-only"):
        raise ValueError(f"unsupported network_mode {network_mode!r}")
    real_writables = sorted({os.path.realpath(p) for p in writable_paths})
    real_ro_masks = sorted({os.path.realpath(p) for p in readonly_subpaths_after_writable if os.path.exists(p)})

    if is_dedicated_runner:
        # Trust boundary (`direct-dedicated` on ephemeral single-job GitHub-hosted runner VMs):
        # The VM itself is destroyed after the job, `actions/checkout` runs with `persist-credentials: false`,
        # and `command.v1` strips all tokens/keys from `env` (no `.taskpack-*/secrets.json` exists in Action mode).
        # We lock masked subpaths read-only, snapshot inodes + SHA-256 digests to detect same-UID `chmod` tampering,
        # and reap any lingering background process-group members before restoring and verifying masks.
        dir_modes: dict[str, int] = {}
        file_snap: dict[str, tuple[int, str, int]] = {}
        proc: subprocess.Popen[bytes] | None = None
        returncode = 1
        tamper_reason: str | None = None
        kill_timed_out = False
        try:
            snapshot_and_lock_masks(real_ro_masks, dir_modes, file_snap)
            proc = subprocess.Popen(argv, cwd=stage_cwd, env=stage_env, start_new_session=True)
            if hasattr(os, "waitid") and hasattr(os, "WEXITED") and hasattr(os, "WNOWAIT"):
                os.waitid(os.P_PID, proc.pid, os.WEXITED | os.WNOWAIT)
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except OSError:
                    pass
            returncode = proc.wait()
        finally:
            if proc is not None:
                pgid = proc.pid
                if proc.poll() is None:
                    try:
                        os.killpg(pgid, signal.SIGKILL)
                    except OSError:
                        pass
                    try:
                        proc.wait(timeout=5)
                    except Exception:
                        kill_timed_out = True
                deadline = time.monotonic() + 5.0
                while True:
                    try:
                        os.killpg(pgid, signal.SIGKILL)
                    except OSError as exc:
                        if exc.errno == errno.ESRCH:
                            break
                    if time.monotonic() >= deadline:
                        kill_timed_out = True
                        break
                    time.sleep(0.02)
            tamper_reason = restore_and_verify_masks(real_ro_masks, dir_modes, file_snap)
            if tamper_reason is not None:
                sys.stderr.write(f"verify.sh: {tamper_reason} in stage {stage_label!r}\n")
            if kill_timed_out:
                sys.stderr.write(f"verify.sh: timed out terminating process group for stage {stage_label!r}\n")
        if tamper_reason is not None or kill_timed_out:
            sys.exit(1)
        if returncode != 0:
            sys.stderr.write(f"verify.sh: contained stage {stage_label!r} failed with exit code {returncode}\n")
            sys.exit(returncode)
        return

    if platform_name == "darwin":
        ancestors: set[str] = set()
        for ar in allowed_read_roots:
            cur = os.path.dirname(os.path.realpath(ar))
            while cur and cur != "/":
                ancestors.add(cur)
                cur = os.path.dirname(cur)

        lines = [
            "(version 1)",
            "(allow default)",
            "(deny signal)",
            "(allow signal (target same-sandbox))",
            "(deny process-info*)",
            "(allow process-info* (target same-sandbox))",
            "(deny mach-priv-task-port)",
            "(deny sysctl-read",
            '  (sysctl-name "kern.procargs")',
            '  (sysctl-name-prefix "kern.procargs.")',
            '  (sysctl-name "kern.procargs2")',
            '  (sysctl-name-prefix "kern.procargs2.")',
            '  (sysctl-name "kern.proc")',
            '  (sysctl-name-prefix "kern.proc.")',
            ")",
        ]
        if denied_read_roots:
            lines.append("(deny file-read*")
            for dr in sorted(denied_read_roots):
                lines.append(f'  (subpath "{escape_sbpl(dr)}")')
            lines.append(")")
        if ancestors:
            lines.append("(allow file-read-metadata")
            for anc in sorted(ancestors):
                lines.append(f'  (literal "{escape_sbpl(anc)}")')
            lines.append(")")
        lines.append("(allow file-read*")
        for ar in sorted({os.path.realpath(p) for p in allowed_read_roots}):
            lines.append(f'  (subpath "{escape_sbpl(ar)}")')
        lines.append(")")

        lines.append("(deny file-write*)")
        lines.append("(allow file-write*")
        lines.append('  (literal "/dev/null")')
        lines.append('  (literal "/dev/zero")')
        lines.append('  (literal "/dev/dtracehelper")')
        for wp in real_writables:
            lines.append(f'  (subpath "{escape_sbpl(wp)}")')
        lines.append(")")

        if real_ro_masks:
            lines.append("(deny file-write*")
            for rp in real_ro_masks:
                lines.append(f'  (subpath "{escape_sbpl(rp)}")')
            lines.append(")")

        if network_mode == "none":
            lines.append("(deny network*)")
        elif network_mode == "loopback-only":
            lines.append("(deny network*)")
            lines.append('(allow network-outbound (remote ip "localhost:*"))')
            lines.append('(allow network-inbound (local ip "localhost:*"))')
            lines.append('(allow network-bind (local ip "localhost:*"))')
        else:
            raise ValueError(f"unsupported network_mode {network_mode!r}")

        profile_text = "\n".join(lines) + "\n"
        cmd = ["/usr/bin/sandbox-exec", "-p", profile_text, *argv]
    else:
        # Linux allowlisted bwrap mount namespace (zero host /run, /var/run/docker.sock, /tmp, or $HOME mounts)
        assert bwrap_bin is not None
        cmd = [
            bwrap_bin,
            "--unshare-all",
            "--die-with-parent",
            "--new-session",
            "--ro-bind", "/usr", "/usr",
        ]
        for top_link in ("/bin", "/sbin", "/lib", "/lib64"):
            if os.path.islink(top_link):
                cmd.extend(["--symlink", os.readlink(top_link), top_link])
            elif os.path.isdir(top_link):
                cmd.extend(["--ro-bind", top_link, top_link])

        for etc_entry in (
            "/etc/alternatives",
            "/etc/ssl",
            "/etc/ca-certificates",
            "/etc/pki",
            "/etc/ld.so.cache",
            "/etc/ld.so.conf",
            "/etc/ld.so.conf.d",
            "/etc/localtime",
            "/etc/passwd",
            "/etc/group",
            "/etc/hosts",
            "/etc/nsswitch.conf",
        ):
            if os.path.lexists(etc_entry):
                cmd.extend(["--ro-bind-try", etc_entry, etc_entry])

        cmd.extend([
            "--proc", "/proc",
            "--dev", "/dev",
            "--tmpfs", "/tmp",
            "--tmpfs", "/run",
            "--tmpfs", "/var",
            "--dir", "/var/tmp",
        ])

        mounted_ro: set[str] = {"/usr"}
        for extra_ro in sorted({os.path.realpath(p) for p in allowed_read_roots}):
            if extra_ro == work_root or extra_ro.startswith(work_root + "/"):
                continue
            if any(extra_ro == m or extra_ro.startswith(m + "/") for m in mounted_ro):
                continue
            if os.path.exists(extra_ro):
                cmd.extend(["--ro-bind", extra_ro, extra_ro])
                mounted_ro.add(extra_ro)

        cmd.extend(["--ro-bind", work_root, work_root])
        for wp in real_writables:
            cmd.extend(["--bind", wp, wp])
        for rp in real_ro_masks:
            cmd.extend(["--ro-bind", rp, rp])

        cmd.extend(["--chdir", stage_cwd, "--clearenv"])
        for env_k, env_v in sorted(stage_env.items()):
            cmd.extend(["--setenv", env_k, env_v])
        cmd.extend(["--", *argv])

    proc = subprocess.Popen(cmd, cwd=stage_cwd, env=stage_env, start_new_session=True)
    returncode = 1
    try:
        returncode = proc.wait()
    finally:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
    if returncode != 0:
        sys.stderr.write(f"verify.sh: contained stage {stage_label!r} failed with exit code {returncode}\n")
        sys.exit(returncode)


def force_remove_dir(target_dir: str) -> None:
    if not os.path.lexists(target_dir):
        return
    for r, ds, _ in os.walk(target_dir, topdown=True, followlinks=False):
        try:
            st_r = os.lstat(r)
            if not stat.S_ISLNK(st_r.st_mode):
                os.chmod(r, st_r.st_mode | 0o700)
        except OSError:
            pass
        for d in ds:
            dp = os.path.join(r, d)
            try:
                st_d = os.lstat(dp)
                if not stat.S_ISLNK(st_d.st_mode):
                    os.chmod(dp, st_d.st_mode | 0o700)
            except OSError:
                pass
    shutil.rmtree(target_dir, ignore_errors=True)


def promote_build_to_runtime(src_root: str, dst_root: str) -> None:
    os.makedirs(dst_root, mode=0o700, exist_ok=True)
    for r, ds, fs in os.walk(src_root, topdown=True, followlinks=False):
        rel_dir = os.path.relpath(r, src_root)
        target_dir = dst_root if rel_dir == "." else os.path.join(dst_root, rel_dir)
        os.makedirs(target_dir, mode=0o755 if rel_dir != "." else 0o700, exist_ok=True)
        kept_dirs: list[str] = []
        for dname in ds:
            s_dir = os.path.join(r, dname)
            d_dir = os.path.join(target_dir, dname)
            st_d = os.lstat(s_dir)
            if stat.S_ISLNK(st_d.st_mode):
                link_target = os.readlink(s_dir)
                rel_entry = os.path.relpath(s_dir, src_root).replace(os.sep, "/")
                if not os.path.isabs(link_target):
                    norm_rel = os.path.normpath(os.path.join(os.path.dirname(rel_entry), link_target)).replace(os.sep, "/")
                    if norm_rel == ".." or norm_rel.startswith("../"):
                        raise RuntimeError(f"escaping relative symlink in build tree: {rel_entry} -> {link_target}")
                    os.symlink(link_target, d_dir)
                elif test_nm_real and rel_dir == "node_modules" and os.path.realpath(link_target).startswith(test_nm_real + os.sep):
                    os.symlink(link_target, d_dir)
                else:
                    raise RuntimeError(f"forbidden symlink directory in build tree: {rel_entry} -> {link_target}")
            elif stat.S_ISDIR(st_d.st_mode):
                kept_dirs.append(dname)
            else:
                raise RuntimeError(f"unexpected directory entry in build tree: {s_dir}")
        ds[:] = kept_dirs

        for fname in fs:
            s_file = os.path.join(r, fname)
            d_file = os.path.join(target_dir, fname)
            rel_entry = os.path.relpath(s_file, src_root).replace(os.sep, "/")
            st_f = os.lstat(s_file)
            if stat.S_ISLNK(st_f.st_mode):
                link_target = os.readlink(s_file)
                if not os.path.isabs(link_target):
                    norm_rel = os.path.normpath(os.path.join(os.path.dirname(rel_entry), link_target)).replace(os.sep, "/")
                    if norm_rel == ".." or norm_rel.startswith("../"):
                        raise RuntimeError(f"escaping relative symlink in build tree: {rel_entry} -> {link_target}")
                    os.symlink(link_target, d_file)
                elif test_nm_real and rel_dir == "node_modules" and os.path.realpath(link_target).startswith(test_nm_real + os.sep):
                    os.symlink(link_target, d_file)
                else:
                    raise RuntimeError(f"forbidden symlink file in build tree: {rel_entry} -> {link_target}")
            elif stat.S_ISREG(st_f.st_mode):
                shutil.copyfile(s_file, d_file, follow_symlinks=False)
                os.chmod(d_file, 0o755 if (st_f.st_mode & 0o111) else 0o644)
            else:
                raise RuntimeError(f"forbidden non-regular file in build tree: {rel_entry}")


build_stage_env = make_stage_env(build_home, build_tmp)

# Stage A: Install dependencies inside OS containment (or link test-only node_modules fixture)
if test_nm_real:
    dst_nm = os.path.join(build_dir, "node_modules")
    os.makedirs(dst_nm, mode=0o755, exist_ok=True)
    for entry in os.listdir(test_nm_real):
        if entry == "@loopwright":
            continue
        os.symlink(os.path.join(test_nm_real, entry), os.path.join(dst_nm, entry))
    lw_scope = os.path.join(dst_nm, "@loopwright")
    os.makedirs(lw_scope, mode=0o755, exist_ok=True)
    pkgs_dir = os.path.join(build_dir, "packages")
    for pkg in os.listdir(pkgs_dir):
        if os.path.isdir(os.path.join(pkgs_dir, pkg)):
            os.symlink(os.path.join("..", "..", "packages", pkg), os.path.join(lw_scope, pkg))
else:
    run_contained(
        stage_label="npm-ci-offline",
        argv=[
            npm_bin,
            "ci",
            "--offline",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--cache",
            work_npm_cache,
            "--prefix",
            build_dir,
        ],
        stage_cwd=build_dir,
        stage_env=build_stage_env,
        writable_paths=[build_dir, build_home, build_tmp, work_npm_cache],
        readonly_subpaths_after_writable=[
            os.path.join(build_dir, "scripts"),
            os.path.join(build_dir, "package.json"),
            os.path.join(build_dir, "package-lock.json"),
        ],
        network_mode="none",
    )

# Stage B1: Compile & static lint inside OS containment (scripts/, node_modules/, and sources read-only)
compile_writable_dirs = [
    build_home,
    build_tmp,
    os.path.join(build_dir, ".test-build"),
    os.path.join(build_dir, "site", "public"),
    os.path.join(build_dir, "site", "resources"),
]
pkgs_root = os.path.join(build_dir, "packages")
for pkg_name in sorted(os.listdir(pkgs_root)):
    pkg_full = os.path.join(pkgs_root, pkg_name)
    if os.path.isdir(pkg_full):
        dist_dir = os.path.join(pkg_full, "dist")
        os.makedirs(dist_dir, mode=0o755, exist_ok=True)
        compile_writable_dirs.append(dist_dir)

for d in compile_writable_dirs:
    os.makedirs(d, mode=0o755, exist_ok=True)

run_contained(
    stage_label="compile-and-lint",
    argv=["/bin/bash", compile_runner],
    stage_cwd=build_dir,
    stage_env=build_stage_env,
    writable_paths=compile_writable_dirs,
    readonly_subpaths_after_writable=[
        os.path.join(build_dir, "scripts"),
        os.path.join(build_dir, "node_modules"),
    ],
    network_mode="none",
)

# Promote compiled tree into brand-new RUNTIME_WORK (fresh regular-file inodes) and destroy BUILD_WORK
# so any compile-stage process that escaped its process group has zero Seatbelt/inode write authority.
promote_build_to_runtime(build_dir, runtime_dir)
force_remove_dir(build_dir)
force_remove_dir(build_home)
force_remove_dir(build_tmp)

os.makedirs(runtime_home, mode=0o700, exist_ok=True)
os.makedirs(runtime_tmp, mode=0o700, exist_ok=True)

runtime_writable_dirs = [
    runtime_home,
    runtime_tmp,
    os.path.join(runtime_dir, ".claude", "s04-qualification"),
    os.path.join(runtime_dir, "site", "public"),
    os.path.join(runtime_dir, "site", "resources"),
]
for runtime_writable in runtime_writable_dirs:
    os.makedirs(runtime_writable, mode=0o755, exist_ok=True)

runtime_stage_env = make_stage_env(runtime_home, runtime_tmp)

# Stage B2: Execute candidate runtime gates (closure + tests) with scripts/, packages/, node_modules/, and .test-build/ OS-read-only!
run_contained(
    stage_label="runtime-gates",
    argv=["/bin/bash", test_runner],
    stage_cwd=runtime_dir,
    stage_env=runtime_stage_env,
    writable_paths=runtime_writable_dirs,
    readonly_subpaths_after_writable=[
        os.path.join(runtime_dir, "scripts"),
        os.path.join(runtime_dir, "node_modules"),
        os.path.join(runtime_dir, ".test-build"),
    ],
    network_mode="loopback-only",
)
PY
