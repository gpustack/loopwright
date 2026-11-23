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

resolve_node_executable() {
  local explicit="${NODE_BIN_DIR:+${NODE_BIN_DIR}/node}"
  if [[ -n "$explicit" && -x "$explicit" && ! -d "$explicit" ]]; then
    printf '%s\n' "$explicit"
    return 0
  fi
  local fallback=""
  local dir candidate major
  local -a search_dirs=()
  local IFS=':'
  for dir in ${PATH:-}; do
    [[ -n "$dir" ]] && search_dirs+=("$dir")
  done
  search_dirs+=("/usr/local/bin" "/opt/homebrew/bin" "/usr/bin")
  for dir in "${search_dirs[@]}"; do
    candidate="${dir%/}/node"
    if [[ -x "$candidate" && ! -d "$candidate" ]]; then
      [[ -z "$fallback" ]] && fallback="$candidate"
      major="$("$candidate" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
      if [[ "$major" =~ ^[0-9]+$ ]] && (( major >= 26 )); then
        printf '%s\n' "$candidate"
        return 0
      fi
    fi
  done
  if [[ -n "$fallback" ]]; then
    printf '%s\n' "$fallback"
    return 0
  fi
  return 1
}

NODE_BIN="$(resolve_node_executable)" || {
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

VERIFY_CHECK_OUT_MAX_BYTES=60000
export VERIFY_CHECK_OUT_MAX_BYTES

VERIFY_WRITE_CHECK_OUT_PY="$(cat <<'PY'
from __future__ import annotations
import json
import os
import stat
import sys

MAX_CHECK_OUT_BYTES = int(os.environ.get("VERIFY_CHECK_OUT_MAX_BYTES", "60000"))
out_path = os.environ.get("LOOPWRIGHT_CHECK_OUT", "").strip()
mode = sys.argv[1] if len(sys.argv) > 1 else ""
if out_path and mode in ("--shell-failure", "--json"):
    parent = os.path.dirname(out_path)
    if parent and os.path.isdir(parent) and not os.path.islink(out_path):
        try:
            raw_in = sys.stdin.buffer.read(MAX_CHECK_OUT_BYTES + 1)
            if len(raw_in) <= MAX_CHECK_OUT_BYTES:
                if mode == "--shell-failure":
                    msg_text = raw_in.decode("utf-8", errors="replace")
                    doc = {
                        "detail": msg_text[:2048],
                        "findings": [
                            {
                                "title": "Self-upgrade verifier precondition failed",
                                "severity": "high",
                                "evidence": msg_text[:1800] if msg_text else "verifier precondition failed",
                            }
                        ],
                    }
                else:
                    doc = json.loads(raw_in.decode("utf-8"))
                if isinstance(doc, dict):
                    encoded = (json.dumps(doc) + "\n").encode("utf-8")
                    if len(encoded) <= MAX_CHECK_OUT_BYTES:
                        flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
                        fd = os.open(out_path, flags, 0o600)
                        try:
                            st = os.fstat(fd)
                            if stat.S_ISREG(st.st_mode) and st.st_nlink == 1:
                                os.write(fd, encoded)
                        finally:
                            os.close(fd)
        except (OSError, ValueError):
            pass
PY
)"
export VERIFY_WRITE_CHECK_OUT_PY

emit_shell_check_failure() {
  local msg="$1"
  if [[ -n "${LOOPWRIGHT_CHECK_OUT:-}" ]]; then
    printf '%s' "${msg:0:2048}" | "$PYTHON_EXEC" -c "$VERIFY_WRITE_CHECK_OUT_PY" --shell-failure || true
  fi
  echo "$msg" >&2
  exit 1
}

GIT_BIN="$(resolve_executable \
  "$(command -v git 2>/dev/null || true)" \
  "/usr/bin/git" \
  "/usr/local/bin/git" \
  "/opt/homebrew/bin/git")" || {
  emit_shell_check_failure "verify.sh: unable to locate git executable"
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
  emit_shell_check_failure "verify.sh: SELF_UPGRADE_REQUIRE_HUGO=1 but hugo binary was not found"
fi

CANDIDATE_DIR="${LOOPWRIGHT_CANDIDATE_DIR:-$PWD}"
if [[ ! -d "$CANDIDATE_DIR" || -L "$CANDIDATE_DIR" ]]; then
  emit_shell_check_failure "verify.sh: candidate directory '$CANDIDATE_DIR' must be a real directory"
fi
CANDIDATE_REAL="$("$PYTHON_EXEC" -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$CANDIDATE_DIR")"

BASE_DIR_RAW="${LOOPWRIGHT_BASE_DIR:-}"
BASE_DIR_REAL=""
BASELINE_REAL=""
if [[ -n "$BASE_DIR_RAW" ]]; then
  if [[ ! -d "$BASE_DIR_RAW" || -L "$BASE_DIR_RAW" ]]; then
    emit_shell_check_failure "verify.sh: LOOPWRIGHT_BASE_DIR '$BASE_DIR_RAW' must be a real directory"
  fi
  BASE_DIR_REAL="$("$PYTHON_EXEC" -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$BASE_DIR_RAW")"
  BASELINE_REAL="$BASE_DIR_REAL"
else
  BASELINE_REPO="${SELF_UPGRADE_REPO_ROOT:-}"
  if [[ -z "$BASELINE_REPO" ]]; then
    if "$GIT_BIN" -C "$CANDIDATE_REAL" rev-parse --show-toplevel >/dev/null 2>&1; then
      BASELINE_REPO="$("$GIT_BIN" -C "$CANDIDATE_REAL" rev-parse --show-toplevel)"
    else
      emit_shell_check_failure "verify.sh: LOOPWRIGHT_BASE_DIR or SELF_UPGRADE_REPO_ROOT must be set when candidate directory has no .git metadata"
    fi
  fi
  BASELINE_REAL="$("$PYTHON_EXEC" -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$BASELINE_REPO")"
fi

if [[ -n "${LOOPWRIGHT_CHECK_ID:-}" || -n "${LOOPWRIGHT_BASE_DIR:-}" ]]; then
  if [[ -z "${LOOPWRIGHT_STAGED_DIR:-}" ]]; then
    emit_shell_check_failure "verify.sh: LOOPWRIGHT_STAGED_DIR must be set under command.v1 (refusing fallback to /tmp/loopwright-self-upgrade-stage)"
  fi
  STAGE_RAW="${LOOPWRIGHT_STAGED_DIR}"
else
  STAGE_RAW="${LOOPWRIGHT_STAGED_DIR:-${SELF_UPGRADE_STAGE_DIR:-/tmp/loopwright-self-upgrade-stage}}"
fi
if [[ ! -d "$STAGE_RAW" || -L "$STAGE_RAW" ]]; then
  emit_shell_check_failure "verify.sh: trusted stage directory '$STAGE_RAW' does not exist; run spec.preflight (scripts/prepare-self-upgrade.mjs) first"
fi
STAGE_REAL="$("$PYTHON_EXEC" -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$STAGE_RAW")"

# ---------------------------------------------------------------------------
# Phase 1: Pre-execution manifest, lockfile, protected-file, and staged-bundle audit
# (Never loads or executes any candidate code prior to passing all checks.)
# ---------------------------------------------------------------------------
PHASE1_RC=0
"$PYTHON_EXEC" - "$CANDIDATE_REAL" "$BASELINE_REAL" "$STAGE_REAL" "$GIT_BIN" "$BASE_DIR_REAL" <<'PY' || PHASE1_RC=$?
from __future__ import annotations
import hashlib
import json
import os
import re
import stat
import subprocess
import sys

candidate_dir, baseline_repo, stage_dir, git_bin, base_snapshot_dir = (
    sys.argv[1],
    sys.argv[2],
    sys.argv[3],
    sys.argv[4],
    sys.argv[5],
)

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
    "packages/taskpack",
]
UNMANAGED_WORKSPACES = [
    "packages/core",
    "packages/state",
    "packages/memory",
    "packages/taskpack-runner",
    "packages/hardware-runner",
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
    ".auto-sync/taskpack.yaml",
    ".auto-sync/digests.lock.json",
    ".auto-sync/instructions.md",
    ".auto-sync/checks/verify.sh",
]
PROTECTED_TREE_PREFIXES = [
    "scripts",
    ".github",
    ".agents",
    "packages/core",
    "packages/state",
    "packages/memory",
    "packages/taskpack-runner",
    "packages/hardware-runner",
    "packages/agent-pi/qualification",
    "packages/controller/qualification",
    "docs/contribute",
]
PROTECTED_SOURCE_FILES = [
    "packages/cli/src/closure.ts",
    "packages/cli/src/failure-matrix.ts",
]


REL_PATH_TOKEN_RE = re.compile(
    r"(?<![A-Za-z0-9._/-])((?:\.auto-sync/|\.github/|\.agents/|packages/|docs/|scripts/)[A-Za-z0-9._/-]+|package-lock\.json|package\.json|tsconfig(?:\.[A-Za-z0-9._-]+)?\.json|eslint\.config\.[A-Za-z0-9._-]+|action\.yml|AGENTS\.md)"
)
SAFE_REL_SEG_RE = re.compile(r"^[A-Za-z0-9._-]+$")
RESERVED_DEV_RE = re.compile(r"^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", re.IGNORECASE)


def write_phase1_check_out(payload: dict[str, object]) -> None:
    helper_code = os.environ.get("VERIFY_WRITE_CHECK_OUT_PY", "")
    if not helper_code or not os.environ.get("LOOPWRIGHT_CHECK_OUT", "").strip():
        return
    try:
        max_bytes = int(os.environ.get("VERIFY_CHECK_OUT_MAX_BYTES", "60000"))
        encoded = (json.dumps(payload) + "\n").encode("utf-8")
        if len(encoded) <= max_bytes:
            subprocess.run(
                [sys.executable, "-c", helper_code, "--json"],
                input=encoded,
                check=False,
            )
    except (OSError, TypeError, ValueError):
        pass


def infer_finding_rel_path(msg: str) -> str | None:
    m = REL_PATH_TOKEN_RE.search(msg)
    if not m:
        return None
    cand = m.group(1).strip("/")
    if not cand or len(cand) > 512:
        return None
    segs = cand.split("/")
    if len(segs) > 32:
        return None
    for seg in segs:
        if (
            not seg
            or seg in (".", "..")
            or seg.endswith(".")
            or not SAFE_REL_SEG_RE.match(seg)
            or RESERVED_DEV_RE.match(seg)
        ):
            return None
    return cand


def fail(msg: str) -> None:
    finding: dict[str, object] = {
        "title": "Self-upgrade pre-execution audit failed",
        "severity": "high",
        "evidence": msg[:1800] if msg else "pre-execution audit failed",
    }
    inferred_path = infer_finding_rel_path(msg)
    if inferred_path is not None:
        finding["path"] = inferred_path
    write_phase1_check_out({
        "detail": f"verify.sh audit failed: {msg}"[:2048],
        "findings": [finding],
    })
    sys.stderr.write(f"verify.sh audit failed: {msg}\n")
    sys.exit(1)


if (
    stage_dir == candidate_dir
    or stage_dir.startswith(candidate_dir + os.sep)
    or candidate_dir.startswith(stage_dir + os.sep)
):
    fail(f"trusted stage directory {stage_dir!r} must be disjoint from candidate directory {candidate_dir!r}")

try:
    stage_stat = os.lstat(stage_dir)
except OSError as exc:
    fail(f"unable to stat trusted stage directory {stage_dir!r}: {exc}")
if stat.S_ISLNK(stage_stat.st_mode) or not stat.S_ISDIR(stage_stat.st_mode):
    fail(f"trusted stage directory {stage_dir!r} must be a real directory")
if stage_stat.st_uid != os.getuid():
    fail(
        f"trusted stage directory {stage_dir!r} owned by uid {stage_stat.st_uid}, expected current uid {os.getuid()}"
    )


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


def read_base_snapshot_optional(rel_path: str, max_bytes: int = 16 * 1024 * 1024) -> bytes | None:
    parts = [p for p in rel_path.split("/") if p]
    cur = base_snapshot_dir
    for idx, seg in enumerate(parts):
        cur = os.path.join(cur, seg)
        try:
            st = os.lstat(cur)
        except OSError:
            return None
        if stat.S_ISLNK(st.st_mode):
            fail(f"symlink forbidden at base:{rel_path!r}")
        if idx < len(parts) - 1:
            if not stat.S_ISDIR(st.st_mode):
                return None
        elif not stat.S_ISREG(st.st_mode):
            fail(f"base:{rel_path!r} must be a regular file")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    fd = os.open(cur, flags)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            fail(f"base:{rel_path!r} must be a regular file")
        if st.st_size > max_bytes:
            fail(f"base:{rel_path!r} size {st.st_size} exceeds limit {max_bytes} bytes")
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
            fail(f"base:{rel_path!r} exceeded limit {max_bytes} bytes")
        return data
    finally:
        os.close(fd)


def list_head_files(prefix: str | None = None) -> list[str]:
    if base_snapshot_dir:
        search_root = os.path.join(base_snapshot_dir, prefix) if prefix else base_snapshot_dir
        if not os.path.exists(search_root):
            return []
        entries: list[str] = []
        for r, ds, fs in os.walk(search_root, topdown=True, followlinks=False):
            if ".git" in ds:
                ds.remove(".git")
            for f in fs:
                full_f = os.path.join(r, f)
                rel_entry = os.path.relpath(full_f, base_snapshot_dir).replace(os.sep, "/")
                if rel_entry == ".git":
                    continue
                st_f = os.lstat(full_f)
                if stat.S_ISREG(st_f.st_mode) and not stat.S_ISLNK(st_f.st_mode):
                    entries.append(rel_entry)
        entries.sort()
        return entries
    args = [git_bin, "-c", "core.hooksPath=/dev/null", "-C", baseline_repo, "ls-tree", "-r", "--name-only", "HEAD"]
    if prefix:
        args.extend(["--", prefix])
    ls_proc = subprocess.run(
        args,
        env={"PATH": "/usr/bin:/bin:/usr/local/bin", "GIT_CONFIG_NOSYSTEM": "1"},
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        check=True,
    )
    return sorted(line.strip() for line in ls_proc.stdout.splitlines() if line.strip())


def git_show_head_optional(rel_path: str) -> bytes | None:
    if base_snapshot_dir:
        return read_base_snapshot_optional(rel_path)
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
        fail(f"baseline {'LOOPWRIGHT_BASE_DIR' if base_snapshot_dir else 'git HEAD'} in {baseline_repo!r} is missing {rel_path!r}")
    return raw


# 1) Walk candidate tree to forbid symlinks, non-regular files, hardlinks, node_modules/, and nested ESLint/TypeScript configs
cand_tsconfigs: list[str] = []
all_cand_files: list[str] = []
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
        all_cand_files.append(rel_f)
        if (fname.startswith("eslint.config.") or fname.startswith(".eslintrc")) and rel_f != "eslint.config.mjs":
            fail(f"candidate tree contains unauthorized ESLint configuration {rel_f!r}")
        if fname == "tsconfig.json" or (fname.startswith("tsconfig.") and fname.endswith(".json")):
            cand_tsconfigs.append(rel_f)
all_cand_files.sort()

all_head_files = list_head_files()
head_tsconfigs = sorted(
    rel
    for rel in all_head_files
    if os.path.basename(rel) == "tsconfig.json"
    or (os.path.basename(rel).startswith("tsconfig.") and os.path.basename(rel).endswith(".json"))
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
    head_entries = list_head_files(tree_prefix)
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

staged_meta_bytes = read_staged_regular_bytes("preflight-metadata.json", MAX_JSON_BYTES)
staged_meta_doc = strict_json_loads(staged_meta_bytes, "staged:preflight-metadata.json")
if not json_strict_equal(staged_meta_doc.get("schema_version"), 1):
    fail("staged preflight-metadata.json schema_version must be 1")
staged_force = staged_meta_doc.get("force")
if not isinstance(staged_force, bool):
    fail("staged preflight-metadata.json force must be a boolean")
staged_disposition = staged_meta_doc.get("disposition", "candidate")
if not isinstance(staged_disposition, str) or staged_disposition not in ("candidate", "no_change"):
    fail(f"staged preflight-metadata.json disposition must be 'candidate' or 'no_change', got {staged_disposition!r}")

staged_lock_sha256: str | None = None
if staged_disposition == "no_change":
    if staged_force is not False:
        fail("staged preflight-metadata.json force must be false when disposition is 'no_change'")
    expected_head_files = [
        rel
        for rel in all_head_files
        if not (rel == ".claude/skills" and os.path.islink(os.path.join(candidate_dir, rel)))
    ]
    if all_cand_files != expected_head_files:
        fail("no_change candidate file set differs from baseline")
    for rel in expected_head_files:
        head_raw = git_show_head_required(rel)
        cand_raw = read_candidate_regular_bytes(rel, max(len(head_raw) + 1024, 16 * 1024 * 1024))
        if cand_raw != head_raw:
            fail(f"no_change candidate file {rel!r} differs from baseline")
else:
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

# Candidate mode MUST strictly advance at least one dependency group beyond HEAD unless preflight attested force=true
if staged_disposition == "no_change":
    if parse_semver(pi_target) != parse_semver(head_pi_ver) or parse_semver(yaml_target) != parse_semver(head_yaml_ver):
        fail("no_change candidate manifests must match baseline HEAD")
elif staged_force is not True:
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
    "packages/taskpack": {"yaml": yaml_target},
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
if staged_lock_sha256 is not None:
    if cand_lock_sha256 != staged_lock_sha256:
        fail(
            f"candidate package-lock.json sha256 ({cand_lock_sha256}) does not match trusted staged package-lock.candidate.json ({staged_lock_sha256})"
        )
elif lock_bytes != git_show_head_required("package-lock.json"):
    fail("no_change package-lock.json differs from baseline HEAD")

# 8) Audit .auto-sync/proposal.json parity against staged target-versions.json
proposal_doc = strict_json_loads(
    read_candidate_regular_bytes(".auto-sync/proposal.json", MAX_JSON_BYTES),
    ".auto-sync/proposal.json",
)
if not json_strict_equal(proposal_doc.get("schema_version"), 1):
    fail(".auto-sync/proposal.json schema_version must be 1")
summary = proposal_doc.get("summary")
if not isinstance(summary, str) or not summary.strip():
    fail(".auto-sync/proposal.json summary must be non-empty")
prop_upstreams = proposal_doc.get("upstreams")
prop_packages = proposal_doc.get("packages")
if not isinstance(prop_upstreams, dict) or not isinstance(prop_packages, dict):
    fail(".auto-sync/proposal.json upstreams and packages must be objects")

if set(prop_upstreams.keys()) != expected_upstream_ids:
    fail(".auto-sync/proposal.json upstreams keys mismatch")
for up_id, exp_pkg in {**PI_UPSTREAMS, "yaml": "yaml"}.items():
    entry = prop_upstreams.get(up_id)
    exp_ver = yaml_target if up_id == "yaml" else pi_target
    if not isinstance(entry, dict) or not json_strict_equal(entry.get("package"), exp_pkg) or not json_strict_equal(entry.get("version"), exp_ver):
        fail(f".auto-sync/proposal.json upstreams[{up_id!r}] does not match staged target {exp_ver!r}")

if not json_strict_equal(prop_packages, expected_ws_deps):
    fail(".auto-sync/proposal.json packages does not match staged target-versions.json")

if staged_disposition == "no_change":
    write_phase1_check_out({
        "detail": "Verified baseline parity with zero repository modifications.",
        "metrics": {
            "disposition": "no_change",
            "phase3_executed": False,
        },
    })
    sys.exit(10)
PY
if [[ "$PHASE1_RC" -eq 10 ]]; then
  exit 0
elif [[ "$PHASE1_RC" -ne 0 ]]; then
  exit "$PHASE1_RC"
fi

# ---------------------------------------------------------------------------
# Phase 2: Materialize isolated verification workspace under $TMPDIR
# ---------------------------------------------------------------------------
RAW_TMP_BASE="${TMPDIR:-/tmp}"
REAL_TMP_BASE="$("$PYTHON_EXEC" -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$RAW_TMP_BASE")"
WORK_ROOT="$(mktemp -d "${REAL_TMP_BASE%/}/lwv.XXXXXX")"
chmod 0700 "$WORK_ROOT"
RUNTIME_TMP="${WORK_ROOT}/tr"
SHM_RUNTIME_TMP=""
cleanup() {
  chmod -R u+w "$WORK_ROOT" >/dev/null 2>&1 || true
  rm -rf "$WORK_ROOT" >/dev/null 2>&1 || true
  if [[ -n "${SHM_RUNTIME_TMP:-}" && -d "$SHM_RUNTIME_TMP" ]]; then
    chmod -R u+w "$SHM_RUNTIME_TMP" >/dev/null 2>&1 || true
    rm -rf "$SHM_RUNTIME_TMP" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [[ "$(uname -s)" == "Linux" && -d /dev/shm ]]; then
  SHM_RUNTIME_TMP="$("$PYTHON_EXEC" - "$REAL_TMP_BASE" <<'PY'
from __future__ import annotations
import os
import shutil
import subprocess
import sys
import tempfile

def is_path_on_tmpfs(path: str) -> bool:
    real = os.path.realpath(path)
    best_mp = ""
    best_fs = ""
    try:
        with open("/proc/mounts", "r", encoding="utf-8") as f:
            for line in f:
                parts = line.split()
                if len(parts) < 3:
                    continue
                mp = parts[1].replace("\\040", " ")
                fs_type = parts[2]
                if real == mp or (mp == "/" and real.startswith("/")) or real.startswith(mp.rstrip("/") + "/"):
                    if len(mp) > len(best_mp):
                        best_mp = mp
                        best_fs = fs_type
    except OSError:
        return False
    return best_fs in ("tmpfs", "ramfs")

def mem_available_kb() -> int:
    try:
        with open("/proc/meminfo", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("MemAvailable:"):
                    parts = line.split()
                    if len(parts) >= 2:
                        return int(parts[1])
    except (OSError, ValueError):
        return 0
    return 0

try:
    tmp_base = sys.argv[1]
    if is_path_on_tmpfs(tmp_base):
        raise SystemExit(0)
    if not os.path.isdir("/dev/shm"):
        raise SystemExit(0)
    usage = shutil.disk_usage("/dev/shm")
    if usage.total < 3 * 1024 * 1024 * 1024 or usage.free < 2 * 1024 * 1024 * 1024:
        raise SystemExit(0)
    if mem_available_kb() < 2621440:
        raise SystemExit(0)
    rt = os.path.realpath(tempfile.mkdtemp(prefix="lwv-rt.", dir="/dev/shm"))
    os.chmod(rt, 0o700)
    probe = os.path.join(rt, "exec-probe.sh")
    try:
        with open(probe, "w", encoding="utf-8") as f:
            f.write("#!/bin/sh\nexit 0\n")
        os.chmod(probe, 0o700)
        res = subprocess.run([probe], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if res.returncode == 0:
            os.unlink(probe)
            print(rt)
        else:
            shutil.rmtree(rt, ignore_errors=True)
    except Exception:
        shutil.rmtree(rt, ignore_errors=True)
except Exception:
    pass
PY
)"
  if [[ -n "$SHM_RUNTIME_TMP" ]]; then
    RUNTIME_TMP="$SHM_RUNTIME_TMP"
  fi
fi

BUILD_WORK="${WORK_ROOT}/build"
RUNTIME_WORK="${WORK_ROOT}/run"
BUILD_HOME="${WORK_ROOT}/hb"
BUILD_TMP="${WORK_ROOT}/tb"
RUNTIME_HOME="${WORK_ROOT}/hr"
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

RAW_CACHE="${SELF_UPGRADE_NPM_CACHE:-}"
STAGED_CACHE_TGZ="${STAGE_REAL}/npm-cache.tgz"
if [[ -n "$RAW_CACHE" && -d "$RAW_CACHE" ]]; then
  cp -R "$RAW_CACHE" "$WORK_NPM_CACHE"
  chmod -R u+w "$WORK_NPM_CACHE"
elif [[ -e "$STAGED_CACHE_TGZ" || -L "$STAGED_CACHE_TGZ" ]]; then
  mkdir -p "$WORK_NPM_CACHE"
  chmod 0700 "$WORK_NPM_CACHE"
  "$PYTHON_EXEC" - "$STAGED_CACHE_TGZ" "$WORK_NPM_CACHE" <<'PY'
from __future__ import annotations
import io
import os
import posixpath
import stat
import sys
import tarfile

archive_path, dest_root = sys.argv[1], os.path.realpath(sys.argv[2])
MAX_ARCHIVE_BYTES = 128 * 1024 * 1024
MAX_EXTRACTED_BYTES = 512 * 1024 * 1024
MAX_MEMBERS = 65536

st_pre = os.lstat(archive_path)
if stat.S_ISLNK(st_pre.st_mode) or not stat.S_ISREG(st_pre.st_mode):
    sys.stderr.write(f"verify.sh: staged npm-cache.tgz {archive_path!r} must be a regular non-symlink file\n")
    sys.exit(1)

flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
fd = os.open(archive_path, flags)
try:
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode) or st.st_nlink > 1 or st.st_size > MAX_ARCHIVE_BYTES:
        sys.stderr.write(f"verify.sh: staged npm-cache.tgz rejected (nlink={st.st_nlink}, size={st.st_size})\n")
        sys.exit(1)
    chunks: list[bytes] = []
    remaining = st.st_size + 1
    while remaining > 0:
        chunk = os.read(fd, min(65536, remaining))
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    raw = b"".join(chunks)
    if len(raw) > MAX_ARCHIVE_BYTES:
        sys.stderr.write("verify.sh: staged npm-cache.tgz exceeds maximum archive size\n")
        sys.exit(1)
finally:
    os.close(fd)

member_count = 0
total_bytes = 0
with tarfile.open(fileobj=io.BytesIO(raw), mode="r|gz") as tf:
    for member in tf:
        member_count += 1
        if member_count > MAX_MEMBERS:
            sys.stderr.write("verify.sh: staged npm-cache.tgz exceeds member limit\n")
            sys.exit(1)
        if not (member.isfile() or member.isdir()):
            sys.stderr.write(f"verify.sh: staged npm-cache.tgz contains forbidden non-regular entry {member.name!r}\n")
            sys.exit(1)
        raw_name = member.name.lstrip("./")
        if not raw_name or raw_name == ".":
            continue
        if "\x00" in raw_name or "\\" in raw_name or raw_name.startswith("/"):
            sys.stderr.write(f"verify.sh: staged npm-cache.tgz contains unsafe member path {member.name!r}\n")
            sys.exit(1)
        norm = posixpath.normpath(raw_name)
        if norm == ".." or norm.startswith("../") or norm.startswith("/"):
            sys.stderr.write(f"verify.sh: staged npm-cache.tgz member escapes destination {member.name!r}\n")
            sys.exit(1)
        target = os.path.join(dest_root, *norm.split("/"))
        real_target = os.path.realpath(os.path.dirname(target))
        if real_target != dest_root and not real_target.startswith(dest_root + os.sep):
            sys.stderr.write(f"verify.sh: staged npm-cache.tgz member escapes destination {member.name!r}\n")
            sys.exit(1)
        if member.isdir():
            os.makedirs(target, mode=0o700, exist_ok=True)
            continue
        if member.size < 0 or total_bytes + member.size > MAX_EXTRACTED_BYTES:
            sys.stderr.write("verify.sh: staged npm-cache.tgz exceeds extracted byte limit\n")
            sys.exit(1)
        os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
        extracted = tf.extractfile(member)
        if extracted is None:
            sys.stderr.write(f"verify.sh: staged npm-cache.tgz unreadable member {member.name!r}\n")
            sys.exit(1)
        with open(target, "wb") as out_f:
            while True:
                buf = extracted.read(65536)
                if not buf:
                    break
                total_bytes += len(buf)
                if total_bytes > MAX_EXTRACTED_BYTES:
                    sys.stderr.write("verify.sh: staged npm-cache.tgz exceeds extracted byte limit\n")
                    sys.exit(1)
                out_f.write(buf)
        os.chmod(target, 0o644)
PY
elif [[ -d "${STAGE_REAL}/npm-cache" ]]; then
  cp -R "${STAGE_REAL}/npm-cache" "$WORK_NPM_CACHE"
  chmod -R u+w "$WORK_NPM_CACHE"
elif [[ -n "${SELF_UPGRADE_TEST_NODE_MODULES:-}" ]]; then
  mkdir -p "$WORK_NPM_CACHE"
  chmod 0700 "$WORK_NPM_CACHE"
else
  emit_shell_check_failure "verify.sh: offline npm cache ('${STAGED_CACHE_TGZ}' or '${STAGE_REAL}/npm-cache') not found; run spec.preflight first"
fi

TEST_NM_REAL=""
if [[ -n "${SELF_UPGRADE_TEST_NODE_MODULES:-}" ]]; then
  TEST_NM_REAL="$("$PYTHON_EXEC" -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$SELF_UPGRADE_TEST_NODE_MODULES")"
  if [[ ! -d "$TEST_NM_REAL" ]]; then
    emit_shell_check_failure "verify.sh: SELF_UPGRADE_TEST_NODE_MODULES '$TEST_NM_REAL' does not exist"
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

LOG_DIR="${TMPDIR:-/tmp}"
LOG_TSC="$(mktemp "${LOG_DIR%/}/lw-tsc.XXXXXX")"
LOG_ESLINT="$(mktemp "${LOG_DIR%/}/lw-eslint.XXXXXX")"
LOG_DOCS="$(mktemp "${LOG_DIR%/}/lw-docs.XXXXXX")"

"$VERIFY_NODE_BIN" ./node_modules/typescript/bin/tsc -p tsconfig.test.json >"$LOG_TSC" 2>&1 &
PID_TSC=$!
"$VERIFY_NODE_BIN" ./node_modules/eslint/bin/eslint.js --config eslint.config.mjs --no-config-lookup --no-cache . >"$LOG_ESLINT" 2>&1 &
PID_ESLINT=$!
"$VERIFY_NODE_BIN" scripts/check-docs.mjs >"$LOG_DOCS" 2>&1 &
PID_DOCS=$!

rc_tsc=0
rc_eslint=0
rc_docs=0
wait "$PID_TSC" || rc_tsc=$?
wait "$PID_ESLINT" || rc_eslint=$?
wait "$PID_DOCS" || rc_docs=$?

cat "$LOG_TSC"
cat "$LOG_ESLINT"
cat "$LOG_DOCS"
rm -f "$LOG_TSC" "$LOG_ESLINT" "$LOG_DOCS"

if (( rc_tsc != 0 || rc_eslint != 0 || rc_docs != 0 )); then
  exit 1
fi

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
if [[ -z "${LW_TEST_CONCURRENCY:-}" ]]; then
  LW_TEST_CONCURRENCY="$("$VERIFY_NODE_BIN" -e 'const os = require("node:os"); console.log(Math.min(12, Math.max(2, os.availableParallelism())));' 2>/dev/null || echo 4)"
fi
LW_TEST_CONCURRENCY="$LW_TEST_CONCURRENCY" "$VERIFY_NODE_BIN" scripts/run-tests.mjs
EOF
chmod 0555 "$TEST_RUNNER"

export BUILD_WORK RUNTIME_WORK BUILD_HOME BUILD_TMP RUNTIME_HOME RUNTIME_TMP WORK_NPM_CACHE WORK_ROOT
export BASELINE_REAL CANDIDATE_REAL STAGE_REAL TEST_NM_REAL PYTHON_EXEC
export NODE_BIN NPM_BIN NODE_RESOLVED_DIR HUGO_RESOLVED COMPILE_RUNNER TEST_RUNNER

"$PYTHON_EXEC" - <<'PY'
from __future__ import annotations
import base64
import errno
import hashlib
import json
import os
import pwd
import re
import shutil
import signal
import socket
import stat
import struct
import subprocess
import sys
import threading
import time

check_out_env = os.environ.get("LOOPWRIGHT_CHECK_OUT", "").strip()
ANSI_ESCAPE_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
SAFE_FINDING_SEG_RE = re.compile(r"^[A-Za-z0-9._-]+$")
RESERVED_DEV_NAME_RE = re.compile(r"^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", re.IGNORECASE)
STAGE_PATH_TOKEN_RE = re.compile(
    r"(?<![A-Za-z0-9._/-])((?:\.test-build/)?(?:packages|docs|scripts|\.auto-sync)/[A-Za-z0-9._/-]+\.(?:[cm]?[jt]sx?|json|md|ya?ml|sh))"
)
STAGE_ERROR_LINE_RE = re.compile(
    r"(?:\berror TS\d+:|^\s*\d+:\d+\s+error\b|^\s*✖\s+|^\s*not ok\b|^\s*(?:AssertionError|TypeError|SyntaxError|ReferenceError|RangeError|Error):|\b(?:AssertionError|ERR_[A-Z0-9_]+)\b|^\s*npm error\b|^\s*ERROR\b)"
)


def sanitize_finding_rel_path(raw: str, base_root: str | None = None) -> str | None:
    cand = raw.strip().strip("'\"()[]")
    while cand.startswith("./"):
        cand = cand[2:]
    if cand.startswith(".test-build/") and cand.endswith(".js"):
        ts_cand = cand[len(".test-build/") : -3] + ".ts"
        stripped = cand[len(".test-build/") :]
        if base_root and os.path.isfile(os.path.join(base_root, ts_cand)):
            cand = ts_cand
        elif base_root and os.path.isfile(os.path.join(base_root, stripped)):
            cand = stripped
        else:
            return None
    if not cand or len(cand) > 256 or cand.startswith("/") or "\\" in cand:
        return None
    segs = cand.split("/")
    if len(segs) > 32:
        return None
    for seg in segs:
        if (
            not seg
            or seg in (".", "..")
            or seg.endswith(".")
            or not SAFE_FINDING_SEG_RE.match(seg)
            or RESERVED_DEV_NAME_RE.match(seg)
        ):
            return None
    if base_root and not os.path.isfile(os.path.join(base_root, cand)):
        return None
    return cand


class StageOutputCapture:
    MAX_BYTES = 131_072

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._bufs: dict[str, bytearray] = {"stdout": bytearray(), "stderr": bytearray()}

    def stop(self) -> None:
        self._stop.set()

    def append(self, stream_name: str, data: bytes) -> None:
        if not data:
            return
        with self._lock:
            buf = self._bufs[stream_name]
            if len(data) >= self.MAX_BYTES:
                buf[:] = data[-self.MAX_BYTES :]
            else:
                buf.extend(data)
                excess = len(buf) - self.MAX_BYTES
                if excess > 0:
                    del buf[:excess]

    def pump_stream(self, pipe: object, stream_name: str, target_stream: object) -> None:
        try:
            while not self._stop.is_set():
                chunk = pipe.read(16384)  # type: ignore[attr-defined]
                if not chunk:
                    break
                self.append(stream_name, chunk)
                if self._stop.is_set():
                    break
                try:
                    target_stream.write(chunk)  # type: ignore[attr-defined]
                    target_stream.flush()  # type: ignore[attr-defined]
                except OSError:
                    pass
        except OSError:
            pass
        finally:
            try:
                pipe.close()  # type: ignore[attr-defined]
            except OSError:
                pass

    def text(self, stream_name: str) -> str:
        with self._lock:
            raw = bytes(self._bufs[stream_name])
        cleaned = ANSI_ESCAPE_RE.sub("", raw.decode("utf-8", errors="replace"))
        return cleaned.replace("\r\n", "\n").replace("\r", "\n")


def build_stage_failure_diagnostics(
    stage_label: str,
    returncode: int,
    capture: StageOutputCapture,
    stage_cwd: str,
) -> tuple[str, list[dict[str, object]]]:
    base_msg = f"verify.sh: contained stage {stage_label!r} failed with exit code {returncode}"
    stdout_txt = capture.text("stdout")
    stderr_txt = capture.text("stderr")
    combined = "\n".join(part for part in (stdout_txt, stderr_txt) if part.strip())

    # 1. Extract structured Node test runner `✖ failing tests:` summary when present
    marker = "✖ failing tests:"
    marker_idx = combined.rfind(marker)
    if marker_idx != -1:
        fail_section = combined[marker_idx + len(marker) :].strip()
        blocks: list[str] = []
        current: list[str] = []
        for line in fail_section.splitlines():
            if line.lstrip().startswith("test at ") and current:
                blocks.append("\n".join(current).strip())
                current = [line]
            elif line.strip() or current:
                current.append(line)
        if current:
            blocks.append("\n".join(current).strip())

        findings: list[dict[str, object]] = []
        summary_names: list[str] = []
        for block in blocks[:8]:
            block_lines = [ln for ln in block.splitlines() if ln.strip()]
            loc_line = block_lines[0] if block_lines else ""
            name_line = next((ln.strip() for ln in block_lines if ln.lstrip().startswith("✖")), loc_line)
            test_name = name_line.lstrip("✖ ").strip() or f"stage {stage_label} test failure"
            summary_names.append(test_name)
            finding: dict[str, object] = {
                "title": f"Test failed: {test_name}"[:256],
                "severity": "high",
                "evidence": block[:1800] if block else base_msg,
            }
            path_match = STAGE_PATH_TOKEN_RE.search(loc_line) or STAGE_PATH_TOKEN_RE.search(block)
            if path_match is not None:
                rel_path = sanitize_finding_rel_path(path_match.group(1), stage_cwd)
                if rel_path is not None:
                    finding["path"] = rel_path
            findings.append(finding)

        if findings:
            names_preview = "; ".join(summary_names[:4])
            if len(blocks) > 4:
                names_preview += f" (+{len(blocks) - 4} more)"
            first_excerpt = " | ".join(
                ln.strip() for ln in blocks[0].splitlines()[:8] if ln.strip()
            )
            detail = f"{base_msg} — {names_preview}: {first_excerpt}"[:2048]
            return detail, findings

    # 2. Extract targeted error lines (tsc, eslint, check-docs, hugo, closure, npm) or tail excerpt
    all_lines = [ln.rstrip() for ln in combined.splitlines() if ln.strip()]
    matched_indices = [
        idx
        for idx, ln in enumerate(all_lines)
        if not ln.lstrip().startswith(("✔", "ℹ")) and STAGE_ERROR_LINE_RE.search(ln)
    ]
    if matched_indices:
        selected_idx: set[int] = set()
        for idx in matched_indices[-20:]:
            selected_idx.add(idx)
            if idx + 1 < len(all_lines):
                selected_idx.add(idx + 1)
        excerpt = "\n".join(all_lines[i] for i in sorted(selected_idx))
    else:
        excerpt = "\n".join(all_lines[-40:])

    excerpt = excerpt.strip()
    if not excerpt:
        return base_msg, [
            {
                "title": f"Contained stage '{stage_label}' failed"[:256],
                "severity": "high",
                "evidence": base_msg[:1800],
            }
        ]

    finding_item: dict[str, object] = {
        "title": f"Contained stage '{stage_label}' failed"[:256],
        "severity": "high",
        "evidence": excerpt[:1800],
    }
    path_match = STAGE_PATH_TOKEN_RE.search(excerpt)
    if path_match is not None:
        rel_path = sanitize_finding_rel_path(path_match.group(1), stage_cwd)
        if rel_path is not None:
            finding_item["path"] = rel_path
    compact = " | ".join(ln.strip() for ln in excerpt.splitlines()[:6] if ln.strip())
    detail = f"{base_msg}: {compact}"[:2048]
    return detail, [finding_item]


def write_phase3_check_out(
    detail: str,
    finding_title: str | None = None,
    finding_evidence: str | None = None,
    metrics: dict[str, object] | None = None,
    findings: list[dict[str, object]] | None = None,
) -> None:
    helper_code = os.environ.get("VERIFY_WRITE_CHECK_OUT_PY", "")
    if not check_out_env or not helper_code:
        return
    doc: dict[str, object] = {"detail": detail[:2048]}
    if findings:
        doc["findings"] = findings[:16]
    elif finding_title and finding_evidence:
        doc["findings"] = [
            {
                "title": finding_title[:256],
                "severity": "high",
                "evidence": finding_evidence[:1800],
            }
        ]
    if metrics is not None:
        doc["metrics"] = metrics
    try:
        max_bytes = int(os.environ.get("VERIFY_CHECK_OUT_MAX_BYTES", "60000"))
        encoded = (json.dumps(doc) + "\n").encode("utf-8")
        if len(encoded) <= max_bytes:
            subprocess.run(
                [python_exec, "-c", helper_code, "--json"],
                input=encoded,
                check=False,
            )
    except (OSError, TypeError, ValueError):
        pass

build_dir = os.path.realpath(os.environ["BUILD_WORK"])
runtime_dir = os.path.join(os.path.realpath(os.environ["WORK_ROOT"]), "run")
build_home = os.path.realpath(os.environ["BUILD_HOME"])
build_tmp = os.path.realpath(os.environ["BUILD_TMP"])
runtime_home = os.path.join(os.path.realpath(os.environ["WORK_ROOT"]), "hr")
runtime_tmp = os.path.realpath(os.environ["RUNTIME_TMP"])
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
runner_env = os.environ.get("RUNNER_ENVIRONMENT", "").strip()
has_macos_sb_helper = bool(os.environ.get("LOOPWRIGHT_MACOS_SB_SOCK", "").strip())
is_dedicated_runner = (
    os.environ.get("GITHUB_ACTIONS") == "true"
    and runner_env == "github-hosted"
    and not has_macos_sb_helper
)

# Verify OS containment backend availability upfront when running outside a dedicated GitHub Actions VM
bwrap_bin: str | None = None
macos_sb_helper_sock: str | None = None
if is_dedicated_runner:
    pass
elif platform_name == "darwin":
    seatbelt_bin = "/usr/bin/sandbox-exec"
    if not (os.path.isfile(seatbelt_bin) and os.access(seatbelt_bin, os.X_OK)):
        msg = "verify.sh: /usr/bin/sandbox-exec unavailable on macOS; failing closed"
        write_phase3_check_out(msg, "OS containment backend unavailable", msg)
        sys.stderr.write(msg + "\n")
        sys.exit(1)
    seatbelt_probe = subprocess.run(
        [
            seatbelt_bin,
            "-p",
            '(version 1)\n(allow default)\n(deny file-write* (literal "/System/nonexistent"))\n',
            "/usr/bin/true",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        check=False,
    )
    if seatbelt_probe.returncode != 0:
        probe_stderr = seatbelt_probe.stderr or b""
        cand_sock = os.environ.get("LOOPWRIGHT_MACOS_SB_SOCK", "").strip()
        if (
            os.environ.get("LOOPWRIGHT_CHECK_ID", "").strip() != ""
            and b"Operation not permitted" in probe_stderr
            and cand_sock != ""
            and os.path.isabs(cand_sock)
        ):
            write_blocked = False
            probe_tmp_file = os.path.join("/private/tmp", f".lw-sb-check-{os.getpid()}")
            try:
                fd = os.open(
                    probe_tmp_file,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
                    0o600,
                )
                os.close(fd)
                try:
                    os.unlink(probe_tmp_file)
                except OSError:
                    pass
            except PermissionError:
                write_blocked = True
            except OSError as exc:
                if exc.errno in (errno.EPERM, errno.EACCES, errno.EROFS):
                    write_blocked = True

            secrets_blocked = False
            try:
                with open(os.path.join(stage_dir, "..", "secrets.json"), "rb") as _sf:
                    _sf.read(1)
            except (PermissionError, FileNotFoundError):
                secrets_blocked = True
            except OSError as exc:
                if exc.errno in (errno.EPERM, errno.EACCES, errno.ENOENT):
                    secrets_blocked = True

            git_blocked = False
            try:
                with open(os.path.join(baseline_repo, ".git", "HEAD"), "rb") as _gf:
                    _gf.read(1)
            except (PermissionError, FileNotFoundError):
                git_blocked = True
            except OSError as exc:
                if exc.errno in (errno.EPERM, errno.EACCES, errno.ENOENT):
                    git_blocked = True

            net_blocked = False
            probe_net = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                probe_net.setblocking(False)
                probe_net.connect(("192.0.2.1", 80))
            except PermissionError:
                net_blocked = True
            except OSError as exc:
                if exc.errno in (errno.EPERM, errno.EACCES):
                    net_blocked = True
            finally:
                probe_net.close()

            helper_ok = False
            try:
                sock_st = os.stat(cand_sock)
                if stat.S_ISSOCK(sock_st.st_mode) and sock_st.st_uid == os.getuid():
                    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as ping_sock:
                        ping_sock.settimeout(5.0)
                        ping_sock.connect(cand_sock)
                        ping_sock.sendall(b'{"op":"ping"}\n')
                        ping_buf = b""
                        while b"\n" not in ping_buf and len(ping_buf) < 4096:
                            chunk = ping_sock.recv(1024)
                            if not chunk:
                                break
                            ping_buf += chunk
                        if b"\n" in ping_buf:
                            ping_resp = json.loads(ping_buf.split(b"\n", 1)[0].decode("utf-8"))
                            if isinstance(ping_resp, dict) and ping_resp.get("ok") is True:
                                helper_ok = True
            except (OSError, ValueError):
                helper_ok = False

            if write_blocked and secrets_blocked and git_blocked and net_blocked and helper_ok:
                macos_sb_helper_sock = cand_sock

        if macos_sb_helper_sock is None:
            msg = "verify.sh: /usr/bin/sandbox-exec per-stage containment unavailable on macOS; failing closed"
            write_phase3_check_out(msg, "OS containment backend unavailable", msg)
            sys.stderr.write(msg + "\n")
            sys.exit(1)
elif platform_name.startswith("linux"):
    host_machine = os.uname().machine
    if host_machine not in ("x86_64", "amd64", "aarch64", "arm64"):
        msg = f"verify.sh: unsupported Linux architecture {host_machine!r} for seccomp filter; failing closed"
        write_phase3_check_out(msg, "OS containment backend unavailable", msg)
        sys.stderr.write(msg + "\n")
        sys.exit(1)
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
        msg = "verify.sh: Linux bwrap --unshare-all unavailable; failing closed"
        write_phase3_check_out(msg, "OS containment backend unavailable", msg)
        sys.stderr.write(msg + "\n")
        sys.exit(1)
else:
    msg = f"verify.sh: unsupported host platform {platform_name!r}; failing closed"
    write_phase3_check_out(msg, "OS containment backend unavailable", msg)
    sys.stderr.write(msg + "\n")
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
    add_tool_read_root(hugo_bin)
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


def build_no_ip_seccomp_bpf(machine: str) -> bytes:
    if machine in ("x86_64", "amd64"):
        audit_arch = 0xC000003E
        nr_socket = 41
        block_x32 = True
    elif machine in ("aarch64", "arm64"):
        audit_arch = 0xC00000B7
        nr_socket = 198
        block_x32 = False
    else:
        raise ValueError(f"unsupported architecture {machine!r} for Linux seccomp filter")
    deny_errno = 0x00050000 | (errno.EPERM & 0xFFFF)
    insns: list[tuple[int, int, int, int]] = [
        (0x20, 0, 0, 4),
        (0x15, 1, 0, audit_arch),
        (0x06, 0, 0, deny_errno),
        (0x20, 0, 0, 0),
    ]
    if block_x32:
        insns.append((0x35, 7, 0, 0x40000000))
    insns.extend(
        [
            (0x15, 6, 0, 425),
            (0x15, 5, 0, 426),
            (0x15, 4, 0, 427),
            (0x15, 0, 2, nr_socket),
            (0x20, 0, 0, 16),
            (0x15, 0, 1, 1),
            (0x06, 0, 0, 0x7FFF0000),
            (0x06, 0, 0, deny_errno),
        ]
    )
    return b"".join(struct.pack("<HBBI", code, jt, jf, k) for code, jt, jf, k in insns)


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

    capture = StageOutputCapture()

    if is_dedicated_runner:
        # Trust boundary (`direct-dedicated` on ephemeral single-job GitHub-hosted runner VMs):
        # The VM itself is destroyed after the job, `actions/checkout` runs with `persist-credentials: false`,
        # and `command.v1` strips all tokens/keys from `env` (no `.taskpack-*/secrets.json` exists in Action mode).
        # We lock masked subpaths read-only, snapshot inodes + SHA-256 digests to detect same-UID `chmod` tampering,
        # and reap any lingering background process-group members before restoring and verifying masks.
        dir_modes: dict[str, int] = {}
        file_snap: dict[str, tuple[int, str, int]] = {}
        proc: subprocess.Popen[bytes] | None = None
        pump_threads: list[threading.Thread] = []
        returncode = 1
        tamper_reason: str | None = None
        kill_timed_out = False
        try:
            snapshot_and_lock_masks(real_ro_masks, dir_modes, file_snap)
            proc = subprocess.Popen(
                argv,
                cwd=stage_cwd,
                env=stage_env,
                start_new_session=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            if proc.stdout is not None:
                t_out = threading.Thread(
                    target=capture.pump_stream,
                    args=(proc.stdout, "stdout", sys.stdout.buffer),
                    daemon=True,
                )
                t_out.start()
                pump_threads.append(t_out)
            if proc.stderr is not None:
                t_err = threading.Thread(
                    target=capture.pump_stream,
                    args=(proc.stderr, "stderr", sys.stderr.buffer),
                    daemon=True,
                )
                t_err.start()
                pump_threads.append(t_err)
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
            drain_deadline = time.monotonic() + 5.0
            for t in pump_threads:
                remaining = max(0.0, drain_deadline - time.monotonic())
                t.join(timeout=remaining)
            if any(t.is_alive() for t in pump_threads):
                capture.stop()
            elif proc is not None:
                for stream in (proc.stdout, proc.stderr):
                    if stream is not None:
                        try:
                            stream.close()
                        except OSError:
                            pass
            tamper_reason = restore_and_verify_masks(real_ro_masks, dir_modes, file_snap)
            if tamper_reason is not None:
                sys.stderr.write(f"verify.sh: {tamper_reason} in stage {stage_label!r}\n")
            if kill_timed_out:
                sys.stderr.write(f"verify.sh: timed out terminating process group for stage {stage_label!r}\n")
        if tamper_reason is not None or kill_timed_out:
            detail_msg = (
                f"verify.sh: {tamper_reason} in stage {stage_label!r}"
                if tamper_reason is not None
                else f"verify.sh: timed out terminating process group for stage {stage_label!r}"
            )
            write_phase3_check_out(detail_msg, f"Contained stage '{stage_label}' integrity violation", detail_msg)
            sys.exit(1)
        if returncode != 0:
            detail_msg, stage_findings = build_stage_failure_diagnostics(stage_label, returncode, capture, stage_cwd)
            write_phase3_check_out(detail_msg, findings=stage_findings)
            sys.stderr.write(f"verify.sh: contained stage {stage_label!r} failed with exit code {returncode}\n")
            sys.exit(returncode)
        return

    if macos_sb_helper_sock is not None:
        req_payload = {
            "op": "exec",
            "argv": argv,
            "cwd": stage_cwd,
            "env": stage_env,
            "allowedReadRoots": sorted({os.path.realpath(p) for p in allowed_read_roots}),
            "deniedReadRoots": sorted(denied_read_roots),
            "writablePaths": real_writables,
            "readOnlyMasks": real_ro_masks,
            "networkMode": network_mode,
        }
        helper_rc: int | None = None
        helper_err: str | None = None
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sb_sock:
                sb_sock.connect(macos_sb_helper_sock)
                sb_sock.sendall((json.dumps(req_payload) + "\n").encode("utf-8"))
                recv_buf = b""
                while True:
                    chunk = sb_sock.recv(65536)
                    if not chunk:
                        break
                    recv_buf += chunk
                    while b"\n" in recv_buf:
                        raw_line, recv_buf = recv_buf.split(b"\n", 1)
                        if not raw_line:
                            continue
                        frame = json.loads(raw_line.decode("utf-8"))
                        if not isinstance(frame, dict):
                            helper_err = "malformed helper frame"
                            break
                        if frame.get("ok") is False:
                            helper_err = str(frame.get("error", "stage containment rejected"))
                            break
                        stream_name = frame.get("stream")
                        if stream_name in ("stdout", "stderr") and isinstance(frame.get("data"), str):
                            decoded = base64.b64decode(frame["data"])
                            capture.append(stream_name, decoded)
                            target_stream = sys.stdout.buffer if stream_name == "stdout" else sys.stderr.buffer
                            target_stream.write(decoded)
                            target_stream.flush()
                        if frame.get("done") is True:
                            helper_rc = int(frame.get("exitCode", 1))
                    if helper_err is not None or helper_rc is not None:
                        break
        except (OSError, ValueError) as exc:
            helper_err = f"helper communication failed: {exc}"

        if helper_err is not None or helper_rc is None:
            detail_msg = f"verify.sh: macOS sandbox helper failed in stage {stage_label!r}: {helper_err or 'unexpected EOF'}"
            write_phase3_check_out(detail_msg, "OS containment backend unavailable", detail_msg)
            sys.stderr.write(detail_msg + "\n")
            sys.exit(1)
        if helper_rc != 0:
            detail_msg, stage_findings = build_stage_failure_diagnostics(stage_label, helper_rc, capture, stage_cwd)
            write_phase3_check_out(detail_msg, findings=stage_findings)
            sys.stderr.write(f"verify.sh: contained stage {stage_label!r} failed with exit code {helper_rc}\n")
            sys.exit(helper_rc)
        return

    if platform_name == "darwin":
        darwin_system_roots = [
            "/System",
            "/usr",
            "/bin",
            "/sbin",
            "/Library/Apple",
            "/Library/Developer",
            "/Library/Frameworks",
            "/Library/Preferences",
            "/Applications/Xcode.app",
            "/opt/homebrew",
            "/dev",
            "/private/etc",
            "/private/var/db",
            "/private/var/select",
        ]
        positive_grants = sorted({*darwin_system_roots, *(os.path.realpath(p) for p in allowed_read_roots), *real_writables})
        ancestors: set[str] = {"/", "/etc", "/var", "/tmp", "/private", "/private/tmp", "/private/var"}
        for gp in positive_grants:
            cur = os.path.dirname(gp)
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
            "(deny file-read*)",
            "(allow file-read-metadata",
        ]
        for anc in sorted(ancestors):
            lines.append(f'  (literal "{escape_sbpl(anc)}")')
        lines.append(")")
        lines.append("(allow file-read*")
        lines.append('  (literal "/")')
        lines.append('  (literal "/etc")')
        lines.append('  (literal "/var")')
        lines.append('  (literal "/tmp")')
        for gp in positive_grants:
            if os.path.isfile(gp):
                lines.append(f'  (literal "{escape_sbpl(gp)}")')
            else:
                lines.append(f'  (subpath "{escape_sbpl(gp)}")')
        lines.append('  (regex #"^/private/tmp/sh-thd[^/]*$")')
        lines.append(")")
        explicit_reopen = {os.path.realpath(p) for p in allowed_read_roots} | set(real_writables)
        post_denied = sorted(
            dr for dr in denied_read_roots
            if dr not in explicit_reopen
            and any(dr.startswith(gp + "/") for gp in positive_grants)
        )
        if post_denied:
            lines.append("(deny file-read*")
            for dr in post_denied:
                lines.append(f'  (subpath "{escape_sbpl(dr)}")')
            lines.append(")")
            nested_reopen = sorted(
                er for er in explicit_reopen
                if any(er.startswith(dr + "/") for dr in post_denied)
            )
            if nested_reopen:
                lines.append("(allow file-read*")
                for nr in nested_reopen:
                    if os.path.isfile(nr):
                        lines.append(f'  (literal "{escape_sbpl(nr)}")')
                    else:
                        lines.append(f'  (subpath "{escape_sbpl(nr)}")')
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

    seccomp_r: int | None = None
    proc: subprocess.Popen[bytes] | None = None
    pump_threads: list[threading.Thread] = []
    returncode = 1
    try:
        if platform_name != "darwin":
            if network_mode == "none":
                bpf_bytes = build_no_ip_seccomp_bpf(os.uname().machine)
                seccomp_r, seccomp_w = os.pipe()
                try:
                    written = 0
                    while written < len(bpf_bytes):
                        written += os.write(seccomp_w, bpf_bytes[written:])
                finally:
                    os.close(seccomp_w)
                os.set_inheritable(seccomp_r, True)
                cmd.extend(["--seccomp", str(seccomp_r)])
            cmd.extend(["--", *argv])
        proc = subprocess.Popen(
            cmd,
            cwd=stage_cwd,
            env=stage_env,
            start_new_session=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            pass_fds=(seccomp_r,) if seccomp_r is not None else (),
        )
        if seccomp_r is not None:
            os.close(seccomp_r)
            seccomp_r = None
        if proc.stdout is not None:
            t_out = threading.Thread(
                target=capture.pump_stream,
                args=(proc.stdout, "stdout", sys.stdout.buffer),
                daemon=True,
            )
            t_out.start()
            pump_threads.append(t_out)
        if proc.stderr is not None:
            t_err = threading.Thread(
                target=capture.pump_stream,
                args=(proc.stderr, "stderr", sys.stderr.buffer),
                daemon=True,
            )
            t_err.start()
            pump_threads.append(t_err)
        returncode = proc.wait()
    finally:
        if seccomp_r is not None:
            try:
                os.close(seccomp_r)
            except OSError:
                pass
        if proc is not None:
            pgid = proc.pid
            kill_deadline = time.monotonic() + 5.0
            while True:
                try:
                    os.killpg(pgid, signal.SIGKILL)
                except OSError as exc:
                    if exc.errno != errno.EINTR:
                        break
                if time.monotonic() >= kill_deadline:
                    break
                time.sleep(0.02)
        drain_deadline = time.monotonic() + 5.0
        for t in pump_threads:
            remaining = max(0.0, drain_deadline - time.monotonic())
            t.join(timeout=remaining)
        if any(t.is_alive() for t in pump_threads):
            capture.stop()
        elif proc is not None:
            for stream in (proc.stdout, proc.stderr):
                if stream is not None:
                    try:
                        stream.close()
                    except OSError:
                        pass
    if returncode != 0:
        detail_msg, stage_findings = build_stage_failure_diagnostics(stage_label, returncode, capture, stage_cwd)
        write_phase3_check_out(detail_msg, findings=stage_findings)
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

# Promote compiled tree into brand-new RUNTIME_WORK (fresh regular-file inodes) via staging dir
# and atomic rename so any compile-stage survivor cannot race file creation in RUNTIME_WORK.
runtime_stage = os.path.join(work_root, "run.staging")
force_remove_dir(runtime_stage)
promote_build_to_runtime(build_dir, runtime_stage)
os.replace(runtime_stage, runtime_dir)
force_remove_dir(build_dir)
force_remove_dir(build_home)
force_remove_dir(build_tmp)

if platform_name == "linux" and os.path.isdir("/dev/shm"):
    shm_root = os.path.realpath("/dev/shm")
    if runtime_tmp == shm_root or runtime_tmp.startswith(shm_root + "/") or runtime_tmp.startswith("/dev/shm/"):
        mem_avail_kb = 0
        try:
            with open("/proc/meminfo", "r", encoding="utf-8") as mf:
                for line in mf:
                    if line.startswith("MemAvailable:"):
                        parts = line.split()
                        if len(parts) >= 2:
                            mem_avail_kb = int(parts[1])
                        break
        except (OSError, ValueError):
            mem_avail_kb = 0
        try:
            shm_free = shutil.disk_usage("/dev/shm").free
        except OSError:
            shm_free = 0
        if shm_free < 1536 * 1024 * 1024 or mem_avail_kb < 2 * 1024 * 1024:
            force_remove_dir(runtime_tmp)
            runtime_tmp = os.path.join(work_root, "tr")

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
write_phase3_check_out(
    "Offline install, compile, lint, docs, closure, and runtime test gates passed.",
    metrics={
        "disposition": "candidate",
        "phase3_executed": True,
    },
)
PY
