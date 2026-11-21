import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { signPayload, verifySignedPayload } from '@loopwright/controller';
import { OVERLAY_LIMITS, identifyManifest, type BaseTreeAnchor, type MetricsMap, type OverlayLimitsInput, type StructuredFinding } from '@loopwright/core';
import { verifyFrozenCorpus } from './corpus.js';
import { PythonBridge } from './python-bridge.js';
import { RunnerTaskpackError } from './types.js';

const execFileAsync = promisify(execFile);
const CAS_CHUNK_BYTES = 1_048_576;
const MAX_PROPOSAL_BYTES = 1_048_576;
const MAX_WORKSPACE_NDJSON_BYTES = 67_108_864;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

interface VerifiedCandidateEntry {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly source:
    | { readonly kind: 'cas_file'; readonly blobPath: string }
    | { readonly kind: 'inline'; readonly bytes: Buffer };
}

export interface VerifiedCandidateSnapshot {
  readonly manifestKind: 'overlay' | 'snapshot';
  readonly baseTree?: BaseTreeAnchor | undefined;
  readonly entries: Map<string, VerifiedCandidateEntry>;
  readonly deleted: readonly string[];
}

export interface CandidatePathPolicy {
  readonly policyProfile?: 'local' | 'github' | undefined;
  readonly allowWorkflowWrites?: boolean | undefined;
}

export interface BaselineRepositoryRef {
  readonly repository: string;
  readonly revision: string;
}

const GIT_OID_RE = /^[0-9a-f]{40,64}$/i;
const CLEAN_GIT_ENV = {
  HOME: '/nonexistent',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  PATH: '/usr/bin:/bin',
} as const;

interface BaselineRegularFile {
  readonly mode: '100644' | '100755';
  readonly byteLength: number;
  readonly sha256: string;
}

interface BaselineGitTree {
  readonly regularFiles: Map<string, BaselineRegularFile>;
  readonly symlinks: Set<string>;
}

function isProtectedGitHubPath(relPath: string, allowWorkflowWrites: boolean): boolean {
  const segments = relPath.split('/');
  if (segments[0]?.toLowerCase() !== '.github') return false;
  if (!allowWorkflowWrites) return true;
  // Even when allowWorkflowWrites is true, non-workflow .github/** paths remain strictly protected.
  return segments.length < 3 || segments[1]?.toLowerCase() !== 'workflows';
}

function isStructurallySafeCandidatePath(relPath: string): boolean {
  if (typeof relPath !== 'string' || relPath.length === 0) return false;
  if (relPath.includes('\0') || relPath.includes('\\') || relPath.startsWith('/') || relPath.endsWith('/')) return false;
  const segments = relPath.split('/');
  if (segments.some(seg => seg === '' || seg === '.' || seg === '..')) return false;
  if (segments.some(seg => seg.toLowerCase() === '.git')) return false;
  return true;
}

function isSafeCandidatePath(relPath: string, policy: CandidatePathPolicy): boolean {
  if (!isStructurallySafeCandidatePath(relPath)) return false;
  const policyProfile = policy.policyProfile ?? 'github';
  if (policyProfile === 'github' && isProtectedGitHubPath(relPath, policy.allowWorkflowWrites === true)) {
    return false;
  }
  return true;
}

function hasSymlinkAncestor(relPath: string, symlinks: ReadonlySet<string>): boolean {
  if (symlinks.size === 0) return false;
  const segments = relPath.split('/');
  let prefix = '';
  for (let i = 0; i < segments.length - 1; i++) {
    prefix = i === 0 ? segments[0]! : `${prefix}/${segments[i]!}`;
    if (symlinks.has(prefix)) return true;
  }
  return false;
}

async function readGitBlobDigests(
  repository: string,
  oids: readonly string[],
): Promise<Map<string, { readonly byteLength: number; readonly sha256: string }> | null> {
  const results = new Map<string, { readonly byteLength: number; readonly sha256: string }>();
  if (oids.length === 0) return results;

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value: Map<string, { readonly byteLength: number; readonly sha256: string }> | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const child = spawn(
      '/usr/bin/git',
      ['-c', 'core.hooksPath=/dev/null', 'cat-file', '--batch'],
      { cwd: repository, env: CLEAN_GIT_ENV, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish(null);
    }, 30_000);
    timer.unref();

    let state: 'header' | 'body' | 'trailer' = 'header';
    let headerChunks: Buffer[] = [];
    let headerLen = 0;
    let oidIndex = 0;
    let currentOid = '';
    let currentSize = 0;
    let remaining = 0;
    let currentHash: ReturnType<typeof createHash> | null = null;
    let failed = false;

    const abort = (): void => {
      failed = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      finish(null);
    };

    const processChunk = (chunk: Buffer): void => {
      let offset = 0;
      while (offset < chunk.length && !failed) {
        if (state === 'header') {
          const nl = chunk.indexOf(0x0a, offset);
          if (nl === -1) {
            const slice = chunk.subarray(offset);
            headerLen += slice.length;
            if (headerLen > 256) { abort(); return; }
            headerChunks.push(Buffer.from(slice));
            return;
          }
          const slice = chunk.subarray(offset, nl);
          headerLen += slice.length;
          if (headerLen > 256) { abort(); return; }
          headerChunks.push(Buffer.from(slice));
          const headerLine = Buffer.concat(headerChunks, headerLen).toString('ascii');
          headerChunks = [];
          headerLen = 0;
          offset = nl + 1;

          const expectedOid = oids[oidIndex];
          if (expectedOid === undefined) { abort(); return; }
          const parts = headerLine.split(' ');
          if (parts.length !== 3 || parts[0] !== expectedOid || parts[1] !== 'blob') {
            abort();
            return;
          }
          const size = Number(parts[2]);
          if (!Number.isSafeInteger(size) || size < 0 || String(size) !== parts[2]) {
            abort();
            return;
          }
          currentOid = expectedOid;
          currentSize = size;
          remaining = size;
          currentHash = createHash('sha256');
          oidIndex += 1;
          if (remaining === 0) {
            results.set(currentOid, { byteLength: 0, sha256: currentHash.digest('hex') });
            currentHash = null;
            state = 'trailer';
          } else {
            state = 'body';
          }
        } else if (state === 'body') {
          const take = Math.min(remaining, chunk.length - offset);
          currentHash!.update(chunk.subarray(offset, offset + take));
          offset += take;
          remaining -= take;
          if (remaining === 0) {
            results.set(currentOid, { byteLength: currentSize, sha256: currentHash!.digest('hex') });
            currentHash = null;
            state = 'trailer';
          }
        } else {
          if (chunk[offset] !== 0x0a) { abort(); return; }
          offset += 1;
          state = 'header';
        }
      }
    };

    child.stdout.on('data', (chunk: Buffer) => processChunk(chunk));
    child.stderr.resume();
    child.on('error', () => abort());
    child.stdin.on('error', () => { /* ignore EPIPE if child exits early */ });
    child.on('close', (code) => {
      if (failed || code !== 0 || state !== 'header' || headerLen !== 0 || oidIndex !== oids.length || results.size !== oids.length) {
        finish(null);
        return;
      }
      finish(results);
    });

    child.stdin.end(oids.join('\n') + '\n', 'ascii');
  });
}

async function readBaselineGitTree(repository: string, revision: string): Promise<BaselineGitTree | null> {
  if (typeof repository !== 'string' || repository.length === 0) return null;
  if (typeof revision !== 'string' || !GIT_OID_RE.test(revision)) return null;
  let treeOutput: string;
  try {
    const out = await execFileAsync(
      '/usr/bin/git',
      ['-c', 'core.hooksPath=/dev/null', 'ls-tree', '-r', '-z', '--full-tree', revision],
      { cwd: repository, env: CLEAN_GIT_ENV, timeout: 15_000, encoding: 'utf8', maxBuffer: 33_554_432 },
    );
    treeOutput = out.stdout;
  } catch {
    return null;
  }

  const pendingRegular: { readonly path: string; readonly mode: '100644' | '100755'; readonly oid: string }[] = [];
  const uniqueOids: string[] = [];
  const seenOids = new Set<string>();
  const symlinks = new Set<string>();

  for (const record of treeOutput.split('\0')) {
    if (record.length === 0) continue;
    const tabIndex = record.indexOf('\t');
    if (tabIndex === -1) return null;
    const meta = record.slice(0, tabIndex).split(/\s+/);
    const entryPath = record.slice(tabIndex + 1);
    if (meta.length !== 3 || entryPath.length === 0) return null;
    const mode = meta[0]!;
    const kind = meta[1]!;
    const oid = meta[2]!;
    if (mode === '120000' && kind === 'blob') {
      symlinks.add(entryPath);
      continue;
    }
    if ((mode === '100644' || mode === '100755') && kind === 'blob') {
      if (!GIT_OID_RE.test(oid)) return null;
      pendingRegular.push({ path: entryPath, mode, oid });
      if (!seenOids.has(oid)) {
        seenOids.add(oid);
        uniqueOids.push(oid);
      }
    }
  }

  const blobStats = await readGitBlobDigests(repository, uniqueOids);
  if (blobStats === null) return null;

  const regularFiles = new Map<string, BaselineRegularFile>();
  for (const item of pendingRegular) {
    const stat = blobStats.get(item.oid);
    if (stat === undefined) return null;
    regularFiles.set(item.path, { mode: item.mode, byteLength: stat.byteLength, sha256: stat.sha256 });
  }
  return { regularFiles, symlinks };
}

async function readBaselineRegularFileSize(
  repository: string,
  revision: string,
  relPath: string,
): Promise<number | null> {
  if (typeof repository !== 'string' || repository.length === 0) return null;
  if (typeof revision !== 'string' || !GIT_OID_RE.test(revision)) return null;
  if (!isStructurallySafeCandidatePath(relPath)) return null;

  const segments = relPath.split('/');
  let prefix = '';
  for (let i = 0; i < segments.length - 1; i += 1) {
    prefix = i === 0 ? segments[0]! : `${prefix}/${segments[i]!}`;
    let parentOut: string;
    try {
      const res = await execFileAsync(
        '/usr/bin/git',
        ['-c', 'core.hooksPath=/dev/null', 'ls-tree', '-d', '-z', revision, '--', prefix],
        { cwd: repository, env: CLEAN_GIT_ENV, timeout: 15_000, encoding: 'utf8', maxBuffer: 65_536 },
      );
      parentOut = res.stdout;
    } catch {
      return null;
    }
    const records = parentOut.split('\0').filter(r => r.length > 0);
    if (records.length !== 1) return null;
    const tabIndex = records[0]!.indexOf('\t');
    if (tabIndex === -1) return null;
    const meta = records[0]!.slice(0, tabIndex).trim().split(/\s+/);
    const entryPath = records[0]!.slice(tabIndex + 1);
    if (
      meta.length !== 3
      || meta[0] !== '040000'
      || meta[1] !== 'tree'
      || !GIT_OID_RE.test(meta[2]!)
      || entryPath !== prefix
    ) {
      return null;
    }
  }

  let fileOut: string;
  try {
    const res = await execFileAsync(
      '/usr/bin/git',
      ['-c', 'core.hooksPath=/dev/null', 'ls-tree', '-z', '-l', revision, '--', relPath],
      { cwd: repository, env: CLEAN_GIT_ENV, timeout: 15_000, encoding: 'utf8', maxBuffer: 65_536 },
    );
    fileOut = res.stdout;
  } catch {
    return null;
  }
  const records = fileOut.split('\0').filter(r => r.length > 0);
  if (records.length !== 1) return null;
  const tabIndex = records[0]!.indexOf('\t');
  if (tabIndex === -1) return null;
  const meta = records[0]!.slice(0, tabIndex).trim().split(/\s+/);
  const entryPath = records[0]!.slice(tabIndex + 1);
  if (meta.length !== 4 || entryPath !== relPath) return null;
  const [mode, kind, oid, sizeStr] = meta;
  if ((mode !== '100644' && mode !== '100755') || kind !== 'blob' || !GIT_OID_RE.test(oid!)) {
    return null;
  }
  const size = Number(sizeStr);
  if (!Number.isSafeInteger(size) || size < 0 || String(size) !== sizeStr) {
    return null;
  }
  return size;
}

async function verifyBaselineGitAnchor(
  repository: string,
  revision: string,
  baseTree: BaseTreeAnchor,
): Promise<boolean> {
  if (typeof repository !== 'string' || repository.length === 0) return false;
  if (typeof revision !== 'string' || !GIT_OID_RE.test(revision)) return false;
  try {
    const [formatRes, commitRes, treeRes] = await Promise.all([
      execFileAsync(
        '/usr/bin/git',
        ['-c', 'core.hooksPath=/dev/null', 'rev-parse', '--show-object-format'],
        { cwd: repository, env: CLEAN_GIT_ENV, timeout: 15_000, encoding: 'utf8', maxBuffer: 65_536 },
      ),
      execFileAsync(
        '/usr/bin/git',
        ['-c', 'core.hooksPath=/dev/null', 'rev-parse', '--verify', `${revision}^{commit}`],
        { cwd: repository, env: CLEAN_GIT_ENV, timeout: 15_000, encoding: 'utf8', maxBuffer: 65_536 },
      ),
      execFileAsync(
        '/usr/bin/git',
        ['-c', 'core.hooksPath=/dev/null', 'rev-parse', '--verify', `${revision}^{tree}`],
        { cwd: repository, env: CLEAN_GIT_ENV, timeout: 15_000, encoding: 'utf8', maxBuffer: 65_536 },
      ),
    ]);
    const actualObjectFormat = formatRes.stdout.trim();
    const actualCommitOid = commitRes.stdout.trim();
    const actualTreeOid = treeRes.stdout.trim();
    return (
      actualObjectFormat === baseTree.objectFormat
      && actualCommitOid === baseTree.commitOid
      && actualTreeOid === baseTree.treeOid
    );
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Canonical JSON with sorted keys, matching the controller's snapshot byte domain. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const record = value as Record<string, unknown>;
  return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}';
}
const MAX_REQUEST_BYTES = 131072;

const FAKE_SERVER_DRIVER = `import json, sys, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
config = json.loads(sys.stdin.read())
sys.path.insert(0, config["vendorRoot"] + "/tests/auto_sync/fixtures/github")
sys.path.insert(0, config["vendorRoot"])
from service import FakeGitHub
from tools.auto_sync.publish import GitHub
fake = FakeGitHub(Path(config["repoDir"]), config["repository"], config["bot"])
fake.__enter__()
api = GitHub("fake-write-token", config["bot"], api_url=fake.url)
state = {"event": None}

class Control(BaseHTTPRequestHandler):
    def _reply(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/state":
            pulls = api.request("GET", "/repos/" + config["repository"] + "/pulls")
            enriched = []
            for p in pulls:
                html_url = p.get("html_url")
                if not isinstance(html_url, str) or not html_url:
                    html_url = fake.url + "/repos/" + config["repository"] + "/pulls/" + str(p["number"])
                body = p.get("body") or ""
                head_sha = p["head"]["sha"]
                commit_message = ""
                try:
                    commit_message = api.request("GET", "/repos/" + config["repository"] + "/commits/" + head_sha).get("commit", {}).get("message", "")
                except Exception:
                    commit_message = ""
                enriched.append({"number": p["number"], "head_sha": head_sha, "head_ref": p["head"].get("ref"), "body": body, "commit_message": commit_message, "html_url": html_url})
            self._reply({"pulls": enriched, "comments": fake.comments})
        else:
            self._reply({"error": "unknown control route"}, 404)

    def do_POST(self):
        if self.path == "/comment-event":
            length = int(self.headers.get("content-length", "0"))
            body = json.loads(self.rfile.read(length).decode())
            if state["event"] is not None and state["event"]["comment"]["body"] == body["body"] and ("commentId" not in body or body["commentId"] is None or state["event"]["comment"]["id"] == body["commentId"]):
                pass
            else:
                ev = fake.comment_event(body["body"])
                if isinstance(body.get("commentId"), int):
                    ev["comment"]["id"] = body["commentId"]
                    fake.comments[-1]["id"] = body["commentId"]
                state["event"] = ev
            self._reply({"ok": True, "event": state["event"]})
        elif self.path == "/human-commit":
            length = int(self.headers.get("content-length", "0"))
            body = json.loads(self.rfile.read(length).decode())
            sha = fake.human_commit(body.get("path", "README.md"), body.get("content", "# Human edit\\n"))
            self._reply({"ok": True, "sha": sha})
        else:
            self._reply({"error": "unknown control route"}, 404)

    def log_message(self, *args):
        pass

control = ThreadingHTTPServer(("127.0.0.1", 0), Control)
print(json.dumps({"fakePort": fake.server.server_port, "controlPort": control.server_port}), flush=True)
control.serve_forever()
`;

export const GATE_DRIVER = `import hashlib, json, os, shutil, stat, subprocess, sys, tempfile
from pathlib import Path

CHUNK_BYTES = 1048576
MAX_PROPOSAL_BYTES = 1048576

def fail(msg):
    print(json.dumps({"ok": False, "error": msg}))
    sys.exit(0)

config = json.loads(sys.stdin.read())
sys.path.insert(0, config["vendorRoot"])
from tools.auto_sync.assemble import assemble
from tools.auto_sync.proposal import validate_proposal
from tools.auto_sync.checks import validate_candidate
work = Path(tempfile.mkdtemp(prefix="runner-gate-"))
try:
    repo = work / "target"
    git_env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": "/nonexistent",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_TERMINAL_PROMPT": "0",
    }
    subprocess.run(["git", "-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=always", "clone", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-q", "--no-hardlinks", "--", config["repository"], str(repo)], env=git_env, check=True)
    subprocess.run(["git", "-C", str(repo), "-c", "core.hooksPath=/dev/null", "checkout", "-q", "-B", "pr-head", config["identity"]["head_sha"]], env=git_env, check=True)
    repo_real = repo.resolve()

    index_path = Path(config["candidateIndexPath"])
    idx_lstat = os.lstat(index_path)
    if stat.S_ISLNK(idx_lstat.st_mode) or not stat.S_ISREG(idx_lstat.st_mode):
        fail("candidate index must be a regular file")
    with open(index_path, "r", encoding="utf-8") as index_fh:
        index_doc = json.load(index_fh)
    if not isinstance(index_doc, dict) or index_doc.get("version") != 1 or not isinstance(index_doc.get("entries"), list):
        fail("candidate index schema invalid")
    deleted = index_doc.get("deleted", [])
    if not isinstance(deleted, list):
        fail("candidate index deleted schema invalid")

    deleted_paths = set()
    for del_path in deleted:
        if not isinstance(del_path, str) or not del_path or "\\x00" in del_path or "\\\\" in del_path or del_path.startswith("/") or del_path.endswith("/"):
            fail("candidate deleted path invalid")
        segs = del_path.split("/")
        rel = Path(del_path)
        if rel.is_absolute() or any(s in ("", ".", "..") for s in segs) or ".." in rel.parts or ".git" in [p.lower() for p in rel.parts]:
            fail("candidate deleted path escapes or targets .git: %s" % del_path)
        if del_path in deleted_paths:
            fail("duplicate candidate deleted path: %s" % del_path)
        deleted_paths.add(del_path)

    for entry in index_doc["entries"]:
        if not isinstance(entry, dict):
            fail("candidate index entry invalid")
        epath = entry.get("path")
        if isinstance(epath, str) and epath in deleted_paths:
            fail("candidate path appears in both entries and deleted: %s" % epath)

    for del_path in deleted:
        if config["identity"].get("mode") == "revise" and not del_path.startswith(".autosync/"):
            continue
        rel = Path(del_path)
        cur = repo
        parents_exist = True
        for part in rel.parts[:-1]:
            cur = cur / part
            if not cur.exists() and not cur.is_symlink():
                parents_exist = False
                break
            if cur.is_symlink() or not cur.is_dir():
                fail("candidate deleted parent path is a symlink or non-directory: %s" % del_path)
        if not parents_exist:
            continue
        target = repo / rel
        if target.is_symlink():
            fail("candidate deleted target is a symlink: %s" % del_path)
        if target.exists() and target.is_dir():
            fail("candidate deleted target is a directory: %s" % del_path)
        parent_real = target.parent.resolve()
        if parent_real != repo_real and repo_real not in parent_real.parents:
            fail("candidate deleted target escapes repository root: %s" % del_path)
        if target.exists():
            tgt_lstat = os.lstat(target)
            if stat.S_ISLNK(tgt_lstat.st_mode) or not stat.S_ISREG(tgt_lstat.st_mode):
                fail("candidate deleted target is not a regular file: %s" % del_path)
            target.unlink()
            parent_cur = target.parent
            while parent_cur != repo and parent_cur.resolve() != repo_real:
                if parent_cur.is_symlink() or not parent_cur.is_dir():
                    break
                try:
                    if any(parent_cur.iterdir()):
                        break
                    parent_cur.rmdir()
                except OSError:
                    break
                parent_cur = parent_cur.parent

    for entry in index_doc["entries"]:
        if not isinstance(entry, dict):
            fail("candidate index entry invalid")
        path = entry.get("path")
        blob_path = entry.get("blobPath")
        expected_len = entry.get("byteLength")
        expected_sha = entry.get("sha256")
        if not isinstance(path, str) or not path or not isinstance(blob_path, str) or not blob_path:
            fail("candidate index entry missing path or blobPath")
        if not isinstance(expected_len, int) or isinstance(expected_len, bool) or expected_len < 0:
            fail("candidate index entry invalid byteLength")
        if not isinstance(expected_sha, str) or len(expected_sha) != 64:
            fail("candidate index entry invalid sha256")
        if config["identity"].get("mode") == "revise" and not path.startswith(".autosync/"):
            continue
        rel = Path(path)
        if rel.is_absolute() or ".." in rel.parts or "\\x00" in path or "\\\\" in path or ".git" in [p.lower() for p in rel.parts]:
            fail("candidate path escapes the repository: %s" % path)

        blob_lstat = os.lstat(blob_path)
        if stat.S_ISLNK(blob_lstat.st_mode) or not stat.S_ISREG(blob_lstat.st_mode):
            fail("candidate blob is not a regular file: %s" % path)
        if blob_lstat.st_nlink != 1:
            fail("candidate blob must have nlink == 1: %s" % path)
        if blob_lstat.st_size != expected_len:
            fail("candidate blob length mismatch: %s" % path)

        target = repo / rel
        cur = repo
        for part in rel.parts[:-1]:
            cur = cur / part
            if cur.exists() or cur.is_symlink():
                if cur.is_symlink() or not cur.is_dir():
                    fail("candidate parent path is a symlink or non-directory: %s" % path)
            else:
                cur.mkdir(mode=0o700)
        if target.is_symlink():
            fail("candidate target is a symlink: %s" % path)
        if target.exists() and target.is_dir():
            fail("candidate target is a directory: %s" % path)
        if target.parent.resolve() != repo_real and repo_real not in target.parent.resolve().parents:
            fail("candidate target escapes repository root: %s" % path)

        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        src_fd = os.open(blob_path, flags)
        dst_fd = -1
        hasher = hashlib.sha256()
        total = 0
        try:
            st_before = os.fstat(src_fd)
            if not stat.S_ISREG(st_before.st_mode) or st_before.st_nlink != 1 or st_before.st_dev != blob_lstat.st_dev or st_before.st_ino != blob_lstat.st_ino or st_before.st_size != expected_len:
                fail("candidate blob changed during open: %s" % path)
            dst_flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
            dst_fd = os.open(target, dst_flags, 0o600)
            dst_stat = os.fstat(dst_fd)
            if not stat.S_ISREG(dst_stat.st_mode):
                fail("candidate destination is not a regular file: %s" % path)
            with os.fdopen(src_fd, "rb", closefd=True) as src, os.fdopen(dst_fd, "wb", closefd=True) as dst:
                src_fd = -1
                dst_fd = -1
                while True:
                    chunk = src.read(CHUNK_BYTES)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > expected_len:
                        fail("candidate blob grew past expected byteLength: %s" % path)
                    hasher.update(chunk)
                    dst.write(chunk)
                st_after = os.fstat(src.fileno())
                if not stat.S_ISREG(st_after.st_mode) or st_after.st_nlink != 1 or st_after.st_dev != st_before.st_dev or st_after.st_ino != st_before.st_ino or st_after.st_size != st_before.st_size or st_after.st_mtime_ns != st_before.st_mtime_ns:
                    fail("candidate blob mutated during copy: %s" % path)
        finally:
            if src_fd >= 0:
                os.close(src_fd)
            if dst_fd >= 0:
                os.close(dst_fd)
        if total != expected_len or hasher.hexdigest() != expected_sha:
            fail("candidate blob sha256 mismatch: %s" % path)

    proposal_file = repo / ".autosync" / "proposal.json"
    prop_lstat = os.lstat(proposal_file)
    if stat.S_ISLNK(prop_lstat.st_mode) or not stat.S_ISREG(prop_lstat.st_mode):
        fail("proposal file is not a regular file")
    if prop_lstat.st_size > MAX_PROPOSAL_BYTES:
        fail("proposal file exceeds %d byte limit" % MAX_PROPOSAL_BYTES)
    prop_fd = os.open(str(proposal_file), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(prop_fd, "rb", closefd=True) as prop_fh:
        raw_proposal = prop_fh.read(MAX_PROPOSAL_BYTES + 1)
    if len(raw_proposal) > MAX_PROPOSAL_BYTES:
        fail("proposal file exceeds %d byte limit" % MAX_PROPOSAL_BYTES)
    proposal = json.loads(raw_proposal.decode("utf-8"))
    assembled = assemble(proposal, repo)
    normalized = validate_proposal(assembled, config["identity"], engine_prereleases=set(config["enginePrereleases"]), prerelease_packages=set(config["prereleasePackages"]))
    checked = validate_candidate(repo, normalized, config["identity"], sources=config["sources"], ascend_pairs=config["ascendPairs"], engine_prereleases=set(config["enginePrereleases"]), prerelease_packages=set(config["prereleasePackages"]))
    accepted = len([g for g in checked.get("groups", []) if g.get("status") == "ready"])
    if accepted == 0:
        fail("zero accepted groups: %s" % json.dumps(checked.get("rejected", []))[:200])
    print(json.dumps({"ok": True, "checked": checked})[:900000])
except Exception as error:
    print(json.dumps({"ok": False, "error": "%s: %s" % (type(error).__name__, str(error)[:200])}))
finally:
    shutil.rmtree(work, ignore_errors=True)
`;

const PUBLISH_DRIVER = `import json, shutil, subprocess, sys, tempfile
from pathlib import Path
config = json.loads(sys.stdin.read())
sys.path.insert(0, config["vendorRoot"])
from tools.auto_sync.publish import GitHub, prepare_context, publish
work = Path(tempfile.mkdtemp(prefix="runner-publish-"))
try:
    repo = work / "target"
    subprocess.run(["git", "clone", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-q", "--no-hardlinks", config["snapshotPath"], str(repo)], check=True)
    subprocess.run(["git", "-C", str(repo), "-c", "core.hooksPath=/dev/null", "checkout", "-q", "-B", "pr-head", config["headSha"]], check=True)
    artifact = config["checked"]
    api = GitHub("fake-write-token", config["bot"], api_url=config["fakeUrl"])
    event = config.get("event")
    context = prepare_context(api, config["repository"], config["defaultSha"], event)
    result = publish(api, str(repo), context, artifact, sources=config["sources"], ascend_pairs=config["ascendPairs"], engine_prereleases=set(config["enginePrereleases"]), prerelease_packages=set(config["prereleasePackages"]))
    reduced = {key: value for key, value in result.items() if key not in ("checked", "revalidation")}
    print(json.dumps({"result": reduced})[:200000])
except Exception as error:
    print(json.dumps({"failed": "%s: %s" % (type(error).__name__, str(error)[:200])}))
finally:
    shutil.rmtree(work, ignore_errors=True)
`;

export interface RunnerCandidateIdentity {
  readonly repository: string;
  readonly defaultSha: string;
  readonly headSha: string;
  readonly mode: 'discover' | 'revise';
  readonly prNumber: number | null;
  readonly commandId: number | null;
  readonly commandDigest: string | null;
  /** Optional bound PR branch head; when set, revise publication refuses if the PR head moved past it. */
  readonly prHeadSha?: string | null;
}

export interface GateVerdictMetadata {
  readonly detail?: string | null | undefined;
  readonly metrics?: MetricsMap | undefined;
  readonly findings?: readonly StructuredFinding[] | undefined;
}

/** Candidate files, exact-source fixtures, and the target snapshot a registered run's gate requests bind to. */
export interface RunnerCandidateRegistration {
  readonly storeId: string;
  readonly runId: string;
  /** Optional pin: when set, gate requests carrying a different candidate digest are denied. */
  readonly candidateDigest?: string | null | undefined;
  /** The operator-registered proposal; optional when the taskpack omits `spec.proposal`. */
  readonly proposalJson?: string | null | undefined;
  readonly identity: RunnerCandidateIdentity;
  readonly repositorySnapshot: string;
  readonly upstreamSources: Readonly<Record<string, string>>;
  readonly ascendPairs: Readonly<Record<string, unknown>>;
  readonly enginePrereleases: readonly string[];
  readonly prereleasePackages: readonly string[];
  /** Run root when the candidate comes from a controller cycle's checkpoint snapshots (Path A). */
  readonly runRoot?: string | undefined;
  /** Direct candidate file overrides for unit-level registrations (Path B). */
  readonly candidateFiles?: Readonly<Record<string, string>> | undefined;
  /** Authorized revise command body; required (with commandDigest) when identity.mode is 'revise'. */
  readonly reviseCommentBody?: string | undefined;
  /** Optional overlay limits forwarded to `identifyManifest` when verifying >128-file candidates. */
  readonly overlay?: OverlayLimitsInput | undefined;
  /** Optional Taskpack 2.0 extensible verdict metadata (`detail`, `metrics`, `findings`) attached to `gate_verdict`. */
  readonly gateVerdictMetadata?: GateVerdictMetadata | undefined;
  /** Optional host policy profile for candidate path/deletion enforcement (defaults to `'github'`). */
  readonly policyProfile?: 'local' | 'github' | undefined;
  /** Optional workflow write opt-in (under `'github'`, only `.github/workflows/**` may be unlocked; non-workflow `.github/**` remains protected). */
  readonly allowWorkflowWrites?: boolean | undefined;
}

export interface RunnerTaskpackServiceOptions {
  readonly gateSecret: string;
  readonly publicationSecret: string;
  readonly bridge?: PythonBridge;
  readonly corpusRoot?: string;
  readonly port?: number;
  readonly fakeRepository?: string;
  readonly fakeRepositorySnapshot?: string;
  readonly publicationChaos?: 'drop_after_write';
  /** Optional path to persist and reload idempotent receipts and checked artifacts across restarts. */
  readonly stateFilePath?: string;
  /** When set, the service commits an empty commit on this snapshot right after a gate approval (scenario 13). */
  readonly headMutation?: { readonly repository: string; readonly message: string };
}

export interface OperatorReceiptInput {
  readonly storeId: string;
  readonly runId: string;
  /** Optional; the journaled run lock hash object when the caller read it from the run store. */
  readonly lockHash?: unknown;
  readonly operationId: string;
  readonly dispatchId: string;
  readonly dispatchGeneration: number;
  readonly idempotencyKey: string;
  readonly candidateDigest: string;
}

export interface RunnerTaskpackService {
  readonly gateUrl: string;
  readonly publicationUrl: string;
  readonly port: number;
  registerCandidate(registration: RunnerCandidateRegistration): Promise<void>;
  fakePullCount(): Promise<number>;
  fakePullHeadSha(prNumber: number): Promise<string | null>;
  /** Commit a human edit on the managed pull request branch of the service double; returns the new head sha. */
  fakeHumanCommit(path: string, content: string): Promise<string>;
  /** The latest cached gate verification for a run: accepted group count and the verified patch digest. */
  checkedFor(runId: string): { readonly candidateDigest: string; readonly acceptedGroups: number; readonly patchDigest: string | null } | null;
  deriveOperatorReceipt(input: OperatorReceiptInput): Promise<{ readonly bytes: Buffer; readonly signature: string } | null>;
  close(): Promise<void>;
}

export interface ComputeRunnerCandidateDigestOptions {
  readonly repositorySnapshot: string;
  readonly headSha: string;
  readonly proposalJson?: string | null | undefined;
  readonly candidateFiles?: Readonly<Record<string, string | Uint8Array>> | undefined;
  readonly overlay?: OverlayLimitsInput | undefined;
  readonly baseTree?: BaseTreeAnchor | undefined;
}

/**
 * Deterministic candidate digest: the git tree at headSha (or `baseTree` overlay when provided) overlaid with
 * the proposal document and any extra candidate files, identified through ArtifactManifest discipline.
 */
export async function computeRunnerCandidateDigest(options: ComputeRunnerCandidateDigestOptions): Promise<{ readonly digest: string; readonly files: ReadonlyMap<string, Buffer> }> {
  const files = new Map<string, Buffer>();
  if (options.baseTree === undefined) {
    const tree = await execFileAsync('/usr/bin/git', ['ls-tree', '-rz', '--full-tree', options.headSha], { cwd: options.repositorySnapshot, encoding: 'utf8', maxBuffer: 33554432 });
    for (const line of tree.stdout.split('\0')) {
      if (line.trim() === '') continue;
      const metadata = line.split('\t');
      if (metadata.length !== 2) continue;
      const info = metadata[0]!.split(/\s+/);
      const blobSha = info[2]!;
      const path = metadata[1]!;
      const blob = await execFileAsync('/usr/bin/git', ['cat-file', 'blob', blobSha], { cwd: options.repositorySnapshot, maxBuffer: 33554432, encoding: 'buffer' });
      files.set(path, blob.stdout as Buffer);
    }
  }
  if (options.proposalJson != null && options.proposalJson !== '') {
    files.set('.autosync/proposal.json', Buffer.from(options.proposalJson, 'utf8'));
  }
  if (options.candidateFiles !== undefined) {
    for (const [path, content] of Object.entries(options.candidateFiles)) {
      files.set(path, typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content));
    }
  }
  const entries = [...files.entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([name, bytes]) => ({ name, digest: { algorithm: 'sha256' as const, hex: createHash('sha256').update(bytes).digest('hex') }, byteLength: bytes.byteLength }));
  const spec = options.baseTree !== undefined
    ? { baseTree: options.baseTree, entries, deleted: [] }
    : { entries };
  const identified = identifyManifest(
    { apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' }, spec },
    options.overlay !== undefined ? { overlay: options.overlay } : undefined,
  );
  if (!identified.ok) throw new RunnerTaskpackError('SERVICE_FAULT', `candidate manifest rejected: ${JSON.stringify(identified.errors).slice(0, 200)}`);
  return { digest: identified.value.digest.hex, files };
}

interface CheckedEntry {
  readonly registration: RunnerCandidateRegistration;
  readonly candidateDigest: string;
  readonly checked: Record<string, unknown>;
  readonly patchDigest: string | null;
}

function validatorRegistrationFingerprint(registration: RunnerCandidateRegistration): string {
  return canonical({
    policyProfile: registration.policyProfile ?? 'github',
    allowWorkflowWrites: registration.allowWorkflowWrites === true,
    upstreamSources: registration.upstreamSources,
    ascendPairs: registration.ascendPairs,
    enginePrereleases: registration.enginePrereleases,
    prereleasePackages: registration.prereleasePackages,
  });
}

interface Binding {
  readonly storeId: string;
  readonly runId: string;
  readonly lockHash: unknown;
  readonly operationId: string;
  readonly dispatchId: string;
  readonly dispatchGeneration: number;
}

function verifyAndParse(body: Buffer, secret: string, signature: string | undefined, kinds: readonly string[]): Record<string, unknown> | null {
  if (signature === undefined) return null;
  if (!verifySignedPayload(secret, body, signature)) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString('utf8')); } catch { return null; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;
  if (value.version !== 1 || !kinds.includes(String(value.kind))) return null;
  for (const field of ['storeId', 'runId', 'operationId', 'dispatchId']) if (typeof value[field] !== 'string' || value[field] === '') return null;
  const lock = value.lockHash;
  const lockOk = typeof lock === 'string' ? /^[0-9a-f]{64}$/.test(lock) : lock !== null && typeof lock === 'object' && (lock as Record<string, unknown>).algorithm === 'sha256' && typeof (lock as Record<string, unknown>).hex === 'string' && /^[0-9a-f]{64}$/.test(String((lock as Record<string, unknown>).hex));
  if (!lockOk) return null;
  if (typeof value.dispatchGeneration !== 'number' || !Number.isSafeInteger(value.dispatchGeneration)) return null;
  return value;
}

function respondJson(response: ServerResponse, bytes: Buffer, signature: string): void {
  response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(bytes.byteLength), 'x-loopwright-signature': signature });
  response.end(bytes);
}

function verdictDocument(
  binding: Binding,
  extra: {
    gateId: string;
    checkId: string;
    candidateDigest: string;
    status: 'approved' | 'denied';
    reason: string | null;
    expiresAtMs: string;
    detail?: string | null | undefined;
    metrics?: MetricsMap | undefined;
    findings?: readonly StructuredFinding[] | undefined;
  },
): Buffer {
  return Buffer.from(JSON.stringify({ version: 1, kind: 'gate_verdict', ...binding, ...extra }));
}

function receiptDocument(binding: Binding, extra: { idempotencyKey: string; candidateDigest: string; outcome: 'succeeded' | 'not_executed' | 'failed'; externalUrl: string | null; reason: string | null }): Buffer {
  return Buffer.from(JSON.stringify({ version: 1, kind: 'publication_receipt', ...binding, ...extra }));
}

async function headRevision(repository: string): Promise<string> {
  try {
    const outcome = await execFileAsync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', 'rev-parse', 'HEAD'], { cwd: repository, timeout: 5000, encoding: 'utf8', env: { HOME: '/nonexistent', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', PATH: '/usr/bin:/bin' } });
    return outcome.stdout.trim();
  } catch { return ''; }
}

async function resolveVerifiedCasSha256Dir(runRoot: string, runId: string): Promise<string | null> {
  if (!runRoot || !runId || runId.includes('/') || runId.includes('\\') || runId === '.' || runId === '..') {
    return null;
  }
  try {
    const canonicalRunRoot = await realpath(runRoot);
    const runDir = join(canonicalRunRoot, runId);
    const artifactsDir = join(runDir, 'artifacts');
    const blobsDir = join(artifactsDir, 'blobs');
    const sha256Dir = join(blobsDir, 'sha256');
    for (const dir of [runDir, artifactsDir, blobsDir, sha256Dir]) {
      const info = await lstat(dir);
      if (info.isSymbolicLink() || !info.isDirectory()) return null;
    }
    return sha256Dir;
  } catch {
    return null;
  }
}

async function readBoundedRegularFile(filePath: string, maxBytes: number): Promise<Buffer | null> {
  let linfo;
  try {
    linfo = await lstat(filePath);
  } catch {
    return null;
  }
  if (linfo.isSymbolicLink() || !linfo.isFile() || linfo.size > maxBytes) return null;
  let fd;
  try {
    fd = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const before = await fd.stat();
    if (!before.isFile() || before.dev !== linfo.dev || before.ino !== linfo.ino || before.size > maxBytes) return null;
    const chunks: Buffer[] = [];
    const chunkBuf = Buffer.allocUnsafe(Math.min(CAS_CHUNK_BYTES, Math.max(1, before.size + 1)));
    let totalRead = 0;
    for (;;) {
      const part = await fd.read(chunkBuf, 0, chunkBuf.length, totalRead);
      if (part.bytesRead === 0) break;
      totalRead += part.bytesRead;
      if (totalRead > maxBytes) return null;
      chunks.push(Buffer.from(chunkBuf.subarray(0, part.bytesRead)));
    }
    const after = await fd.stat();
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      return null;
    }
    return Buffer.concat(chunks, totalRead);
  } finally {
    await fd.close();
  }
}

async function verifyCasBlobFile(blobPath: string, expectedLength: number, expectedDigest: string): Promise<boolean> {
  let linfo;
  try {
    linfo = await lstat(blobPath);
  } catch {
    return false;
  }
  if (
    linfo.isSymbolicLink()
    || !linfo.isFile()
    || linfo.nlink !== 1
    || (linfo.mode & 0o222) !== 0
    || linfo.size !== expectedLength
  ) {
    return false;
  }
  let fd;
  try {
    fd = await open(blobPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return false;
  }
  try {
    const before = await fd.stat();
    if (
      !before.isFile()
      || before.nlink !== 1
      || (before.mode & 0o222) !== 0
      || before.dev !== linfo.dev
      || before.ino !== linfo.ino
      || before.size !== expectedLength
    ) {
      return false;
    }
    const hash = createHash('sha256');
    const chunkBuf = Buffer.allocUnsafe(Math.min(CAS_CHUNK_BYTES, Math.max(1, expectedLength + 1)));
    let bytesRead = 0;
    for (;;) {
      const part = await fd.read(chunkBuf, 0, chunkBuf.length, bytesRead);
      if (part.bytesRead === 0) break;
      bytesRead += part.bytesRead;
      if (bytesRead > expectedLength) return false;
      hash.update(chunkBuf.subarray(0, part.bytesRead));
    }
    const after = await fd.stat();
    if (
      !after.isFile()
      || after.nlink !== 1
      || (after.mode & 0o222) !== 0
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
    ) {
      return false;
    }
    return bytesRead === expectedLength && hash.digest('hex') === expectedDigest;
  } finally {
    await fd.close();
  }
}

function parseEntryRef(value: unknown): { readonly name: string; readonly digest: string; readonly byteLength: number } | null {
  if (!isPlainObject(value)) return null;
  if (typeof value.name !== 'string' || value.name.length === 0) return null;
  if (!isPlainObject(value.digest)) return null;
  if (value.digest.algorithm !== 'sha256' || typeof value.digest.hex !== 'string' || !SHA256_HEX_RE.test(value.digest.hex)) return null;
  if (typeof value.byteLength !== 'number' || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0) return null;
  return { name: value.name, digest: value.digest.hex, byteLength: value.byteLength };
}

/** Reconstruct verified candidate entries and deleted paths from v2 `blob_ref` or legacy v1 `chunk` checkpoint snapshots without buffering large CAS blobs in RAM. */
export async function candidateEntriesFromRunArtifacts(
  runRoot: string,
  runId: string,
  candidateDigest: string,
  overlay?: OverlayLimitsInput,
  pathPolicy?: CandidatePathPolicy,
  baselineRepository?: BaselineRepositoryRef,
): Promise<VerifiedCandidateSnapshot | null> {
  const effectivePolicy: CandidatePathPolicy = {
    policyProfile: pathPolicy?.policyProfile ?? 'github',
    allowWorkflowWrites: pathPolicy?.allowWorkflowWrites === true,
  };
  let checkpoints: string;
  try { checkpoints = join(runRoot, runId, 'artifacts', 'pi-checkpoints'); } catch { return null; }
  let files: string[];
  try { files = await readdir(checkpoints); } catch { return null; }
  let verifiedSha256Dir: string | null = null;

  for (const name of files.filter(file => file.endsWith('.workspace.ndjson')).sort()) {
    const bytes = await readBoundedRegularFile(join(checkpoints, name), MAX_WORKSPACE_NDJSON_BYTES);
    if (bytes === null) continue;
    const lines = bytes.toString('utf8').split('\n').filter(line => line.trim() !== '');
    if (lines.length === 0) continue;
    let header: unknown;
    try { header = JSON.parse(lines[0]!); } catch { continue; }
    if (!isPlainObject(header) || header.type !== 'workspace_snapshot') continue;
    if (!isPlainObject(header.manifest) || !isPlainObject(header.manifest.spec)) continue;
    const rawEntries = header.manifest.spec.entries;
    if (!Array.isArray(rawEntries) || rawEntries.length > OVERLAY_LIMITS.maxMaxFiles) continue;
    const parsedEntries: { readonly name: string; readonly digest: { readonly algorithm: 'sha256'; readonly hex: string }; readonly byteLength: number }[] = [];
    let validEntries = true;
    for (const rawEntry of rawEntries) {
      const parsed = parseEntryRef(rawEntry);
      if (parsed === null) { validEntries = false; break; }
      parsedEntries.push({ name: parsed.name, digest: { algorithm: 'sha256', hex: parsed.digest }, byteLength: parsed.byteLength });
    }
    if (!validEntries) continue;

    // Identify the manifest the same way the controller does, then compare.
    const identified = identifyManifest(
      {
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'ArtifactManifest',
        metadata: { id: 'candidate' },
        spec: {
          ...(header.manifest.spec.baseTree !== undefined ? { baseTree: header.manifest.spec.baseTree } : {}),
          entries: parsedEntries,
          ...(header.manifest.spec.deleted !== undefined ? { deleted: header.manifest.spec.deleted } : {}),
        },
      },
      overlay !== undefined ? { overlay } : undefined,
    );
    if (!identified.ok) continue;
    if (identified.value.digest.hex !== candidateDigest) continue;

    const baseTree = identified.value.manifest.spec.baseTree;
    const manifestKind: 'overlay' | 'snapshot' = baseTree !== undefined ? 'overlay' : 'snapshot';
    if (manifestKind === 'snapshot' && identified.value.manifest.spec.deleted !== undefined) {
      return null;
    }
    if (manifestKind === 'overlay' && baselineRepository !== undefined) {
      const anchorMatches = await verifyBaselineGitAnchor(
        baselineRepository.repository,
        baselineRepository.revision,
        baseTree!,
      );
      if (!anchorMatches) return null;
    }

    const expectedByName = new Map(identified.value.manifest.spec.entries.map(entry => [entry.name, entry]));
    const validatedDeleted: string[] = [];
    if (manifestKind === 'overlay') {
      for (const entryName of expectedByName.keys()) {
        if (!isSafeCandidatePath(entryName, effectivePolicy)) return null;
      }
      const rawDeleted = identified.value.manifest.spec.deleted ?? [];
      const seenDeleted = new Set<string>();
      for (const delPath of rawDeleted) {
        if (!isSafeCandidatePath(delPath, effectivePolicy)) return null;
        if (expectedByName.has(delPath) || seenDeleted.has(delPath)) return null;
        seenDeleted.add(delPath);
        validatedDeleted.push(delPath);
      }
    } else {
      for (const entryName of expectedByName.keys()) {
        if (!isStructurallySafeCandidatePath(entryName)) return null;
        if (baselineRepository === undefined && !isSafeCandidatePath(entryName, effectivePolicy)) return null;
      }
    }
    const reconstructed = new Map<string, VerifiedCandidateEntry>();
    let snapshotMode: 'unset' | 'blob_ref' | 'chunk' = 'unset';
    let current: {
      readonly name: string;
      readonly digest: string;
      readonly length: number;
      sawBlobRef: boolean;
      sawChunk: boolean;
      casBlobPath: string | null;
      chunks: Buffer[];
      chunkBytes: number;
    } | null = null;
    let complete = 0;
    let ended = false;

    for (const line of lines.slice(1)) {
      if (ended) return null;
      let parsedRow: unknown;
      try { parsedRow = JSON.parse(line); } catch { return null; }
      if (!isPlainObject(parsedRow)) return null;
      const row = parsedRow;

      if (row.type === 'file') {
        if (current !== null) return null;
        const ref = parseEntryRef(row.ref);
        if (ref === null) return null;
        const expected = expectedByName.get(ref.name);
        if (expected === undefined || expected.digest.hex !== ref.digest || expected.byteLength !== ref.byteLength) return null;
        if (reconstructed.has(ref.name)) return null;
        current = {
          name: ref.name,
          digest: ref.digest,
          length: ref.byteLength,
          sawBlobRef: false,
          sawChunk: false,
          casBlobPath: null,
          chunks: [],
          chunkBytes: 0,
        };
        continue;
      }

      if (row.type === 'blob_ref') {
        if (current === null || snapshotMode === 'chunk' || current.sawBlobRef || current.sawChunk) return null;
        snapshotMode = 'blob_ref';
        current.sawBlobRef = true;
        const ref = parseEntryRef(row.ref);
        if (ref === null || ref.name !== current.name || ref.digest !== current.digest || ref.byteLength !== current.length) return null;
        const blobRefRaw = row.blobRef;
        if (!isPlainObject(blobRefRaw)) return null;
        const blobRefParsed = parseEntryRef(blobRefRaw);
        if (
          blobRefParsed === null
          || blobRefParsed.name !== current.name
          || blobRefParsed.digest !== current.digest
          || blobRefParsed.byteLength !== current.length
          || blobRefRaw.uri !== `cas://sha256/${current.digest}`
        ) {
          return null;
        }
        if (verifiedSha256Dir === null) {
          verifiedSha256Dir = await resolveVerifiedCasSha256Dir(runRoot, runId);
          if (verifiedSha256Dir === null) return null;
        }
        const blobPath = join(verifiedSha256Dir, current.digest);
        if (!(await verifyCasBlobFile(blobPath, current.length, current.digest))) return null;
        current.casBlobPath = blobPath;
        continue;
      }

      if (row.type === 'chunk') {
        if (current === null || snapshotMode === 'blob_ref' || current.sawBlobRef) return null;
        if (typeof row.data !== 'string') return null;
        snapshotMode = 'chunk';
        current.sawChunk = true;
        const part = Buffer.from(row.data, 'base64');
        current.chunkBytes += part.byteLength;
        if (current.chunkBytes > current.length) return null;
        current.chunks.push(part);
        continue;
      }

      if (row.type === 'file_end') {
        if (current === null) return null;
        if (row.byteLength !== current.length || row.digest !== current.digest) return null;
        if (current.sawBlobRef) {
          if (current.casBlobPath === null) return null;
          reconstructed.set(current.name, {
            path: current.name,
            byteLength: current.length,
            sha256: current.digest,
            source: { kind: 'cas_file', blobPath: current.casBlobPath },
          });
        } else {
          if (snapshotMode === 'blob_ref') return null;
          snapshotMode = 'chunk';
          const bytes2 = Buffer.concat(current.chunks, current.chunkBytes);
          if (bytes2.byteLength !== current.length || createHash('sha256').update(bytes2).digest('hex') !== current.digest) return null;
          reconstructed.set(current.name, {
            path: current.name,
            byteLength: current.length,
            sha256: current.digest,
            source: { kind: 'inline', bytes: bytes2 },
          });
        }
        current = null;
        complete += 1;
        continue;
      }

      if (row.type === 'end') {
        if (current !== null) return null;
        if (row.files !== complete || complete !== parsedEntries.length || reconstructed.size !== parsedEntries.length) return null;
        ended = true;
        continue;
      }

      return null;
    }

    if (!ended || current !== null || complete !== parsedEntries.length || reconstructed.size !== parsedEntries.length) {
      return null;
    }
    if (manifestKind === 'overlay') {
      return { manifestKind, baseTree, entries: reconstructed, deleted: validatedDeleted };
    }
    if (baselineRepository === undefined) {
      return { manifestKind, entries: reconstructed, deleted: validatedDeleted };
    }

    const baseline = await readBaselineGitTree(baselineRepository.repository, baselineRepository.revision);
    if (baseline === null) return null;

    const effectiveDeleted: string[] = [];
    for (const basePath of baseline.regularFiles.keys()) {
      if (reconstructed.has(basePath)) continue;
      if (!isSafeCandidatePath(basePath, effectivePolicy)) return null;
      effectiveDeleted.push(basePath);
    }
    effectiveDeleted.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    const changedEntries = new Map<string, VerifiedCandidateEntry>();
    for (const [entryPath, entry] of reconstructed.entries()) {
      if (baseline.symlinks.has(entryPath) || hasSymlinkAncestor(entryPath, baseline.symlinks)) {
        return null;
      }
      const base = baseline.regularFiles.get(entryPath);
      const isUnchangedBaseline =
        base !== undefined
        && base.byteLength === entry.byteLength
        && base.sha256 === entry.sha256;
      if (isUnchangedBaseline) {
        if (entryPath === '.autosync/proposal.json') {
          changedEntries.set(entryPath, entry);
        }
        continue;
      }
      if (!isSafeCandidatePath(entryPath, effectivePolicy)) return null;
      changedEntries.set(entryPath, entry);
    }

    return { manifestKind, entries: changedEntries, deleted: effectiveDeleted };
  }
  return null;
}

/**
 * Loopback-only authenticated runner validation gate and publication service over the vendored frozen validators.
 * The gate validates the bound candidate snapshot (never the operator's pre-registered proposal), runs frozen
 * assemble -> validate_proposal -> validate_candidate, denies zero-accepted-group candidates, and the publisher
 * passes the gate-verified artifact to frozen publish with honest outcome mapping.
 */
export async function startRunnerTaskpackService(options: RunnerTaskpackServiceOptions): Promise<RunnerTaskpackService> {
  const bridge = options.bridge ?? new PythonBridge();
  const ownedBridge = options.bridge === undefined;
  const scratch = await mkdtemp(join(await (await import('node:fs/promises')).realpath(tmpdir()), 'runner-service-'));
  await chmod(scratch, 0o700);
  const verifiedCorpus = await verifyFrozenCorpus(options.corpusRoot);
  const gateSecret = options.gateSecret, publicationSecret = options.publicationSecret;
  const registrations = new Map<string, RunnerCandidateRegistration>();
  const checkedCache = new Map<string, CheckedEntry>();
  const idempotentReceipts = new Map<string, { requestDigest: string; bytes: Buffer; signature: string }>();
  const replayBindings = new Map<string, string>();
  const fakeRepository = options.fakeRepository ?? 'example-org/runtime-runner';

  if (options.stateFilePath !== undefined) {
    try {
      const persisted = JSON.parse(await readFile(options.stateFilePath, 'utf8')) as { receipts?: [string, { requestDigest: string; bytes: string; signature: string }][] };
      for (const [key, value] of persisted.receipts ?? []) idempotentReceipts.set(key, { requestDigest: value.requestDigest, bytes: Buffer.from(value.bytes, 'base64'), signature: value.signature });
    } catch { /* fresh state when the file is absent or unreadable */ }
  }
  const persistState = async (): Promise<void> => {
    if (options.stateFilePath === undefined) return;
    const receipts = [...idempotentReceipts.entries()].map(([key, value]) => [key, { requestDigest: value.requestDigest, bytes: value.bytes.toString('base64'), signature: value.signature }] as [string, { requestDigest: string; bytes: string; signature: string }]);
    await writeFile(options.stateFilePath, JSON.stringify({ receipts }), { mode: 0o600 }).catch(() => undefined);
  };

  const fakeServerScript = join(scratch, 'fake-server.py');
  await writeFile(fakeServerScript, FAKE_SERVER_DRIVER, { mode: 0o600 });
  const fakeDoubles = new Map<string, { child: import('node:child_process').ChildProcess; fakeUrl: string; controlPort: number; source: string; fakeRepoDir: string }>();
  const trackedChildren = new Set<import('node:child_process').ChildProcess>();
  let activeFakeKey: string | null = null;

  function terminateResidentChild(child: import('node:child_process').ChildProcess): Promise<void> {
    trackedChildren.delete(child);
    child.removeAllListeners('exit');
    child.stdout?.destroy();
    child.stderr?.destroy();
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise<void>(resolve => {
      const done = (): void => { clearTimeout(killTimer); resolve(); };
      child.once('exit', done);
      try { if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch { child.kill('SIGTERM'); }
      const killTimer = setTimeout(() => {
        try { if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { child.kill('SIGKILL'); }
        done();
      }, 250);
      killTimer.unref();
    });
  }

  async function ensureFakeDouble(snapshotPath: string): Promise<void> {
    const existing = fakeDoubles.get(snapshotPath);
    if (existing !== undefined) { activeFakeKey = snapshotPath; return; }
    const gitEnv = { HOME: scratch, PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
    const fakeRepoDir = join(await mkdtemp(join(scratch, 'fake-repo-')), 'repository');
    await execFileAsync('/usr/bin/git', ['clone', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-q', '--no-hardlinks', snapshotPath, fakeRepoDir], { env: gitEnv, encoding: 'utf8' });
    const child = await bridge.residentSpawn([fakeServerScript], {
      stdin: JSON.stringify({ vendorRoot: verifiedCorpus.root, repoDir: fakeRepoDir, repository: fakeRepository, bot: 'runner-sync[bot]' }),
    });
    trackedChildren.add(child);
    child.stderr?.resume();
    let ready: { fakePort: number; controlPort: number };
    try {
      const readyJson = await new Promise<string>((resolve, reject) => {
        let buffered = '';
        const cleanup = (): void => {
          clearTimeout(timer);
          child.stdout?.off('data', onData);
          child.off('exit', onExit);
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new RunnerTaskpackError('SERVICE_FAULT', 'github service double did not become ready'));
        }, 30000);
        const onData = (chunk: Buffer): void => {
          buffered += chunk.toString('utf8');
          if (buffered.includes('\n')) {
            cleanup();
            resolve(buffered.slice(0, buffered.indexOf('\n')));
          }
        };
        const onExit = (code: number | null): void => {
          cleanup();
          reject(new RunnerTaskpackError('SERVICE_FAULT', `github service double exited early (${String(code)})`));
        };
        child.stdout!.on('data', onData);
        child.once('exit', onExit);
      });
      ready = JSON.parse(readyJson) as { fakePort: number; controlPort: number };
    } catch (error) {
      await terminateResidentChild(child);
      throw error;
    }
    child.stdout?.resume();
    (child.stdout as unknown as { unref?: () => void })?.unref?.();
    (child.stderr as unknown as { unref?: () => void })?.unref?.();
    child.unref();
    fakeDoubles.set(snapshotPath, { child, fakeUrl: `http://127.0.0.1:${ready.fakePort}`, controlPort: ready.controlPort, source: snapshotPath, fakeRepoDir });
    activeFakeKey = snapshotPath;
  }

  function activeDouble(snapshotPath?: string): { fakeUrl: string; controlPort: number } | null {
    if (snapshotPath !== undefined) {
      const instance = fakeDoubles.get(snapshotPath);
      if (instance === undefined) return null;
      activeFakeKey = snapshotPath;
      return { fakeUrl: instance.fakeUrl, controlPort: instance.controlPort };
    }
    if (activeFakeKey === null) return null;
    const instance = fakeDoubles.get(activeFakeKey);
    return instance === undefined ? null : { fakeUrl: instance.fakeUrl, controlPort: instance.controlPort };
  }


  function ensureFakeRepoDir(snapshotPath: string): string {
    const instance = fakeDoubles.get(snapshotPath);
    if (instance !== undefined) return instance.fakeRepoDir;
    return snapshotPath;
  }

  async function controlGetState(snapshotPath?: string): Promise<{ pulls: { number: number; head_sha: string; head_ref: string | null; body: string; commit_message: string; html_url: string | null }[]; comments: readonly { id: number; body: string }[] }> {
    const active = activeDouble(snapshotPath);
    if (active === null) return { pulls: [], comments: [] };
    const response = await fetch(`http://127.0.0.1:${active.controlPort}/state`);
    if (!response.ok) throw new RunnerTaskpackError('SERVICE_FAULT', 'github service double state query failed');
    return await response.json() as { pulls: { number: number; head_sha: string; head_ref: string | null; body: string; commit_message: string; html_url: string | null }[]; comments: readonly { id: number; body: string }[] };
  }

  function lookupBinding(request: Record<string, unknown>): { storeId: string; runId: string; lockHash: string; operationId: string; dispatchId: string; dispatchGeneration: number } | null {
    const rawLock = request.lockHash;
    const lockHash = typeof rawLock === 'string' ? rawLock : typeof rawLock === 'object' && rawLock !== null ? String((rawLock as Record<string, unknown>).hex ?? '') : '';
    const binding = { storeId: String(request.storeId), runId: String(request.runId), lockHash, operationId: String(request.operationId), dispatchId: String(request.dispatchId), dispatchGeneration: Number(request.dispatchGeneration) };
    if (!/^[0-9a-f]{64}$/.test(binding.lockHash)) return null;
    return binding;
  }

  function registrationFor(normalized: { storeId: string; runId: string }): RunnerCandidateRegistration | undefined {
    return registrations.get(`${normalized.storeId}|${normalized.runId}`);
  }

  async function resolveCandidateEntries(
    _request: Record<string, unknown>,
    registration: RunnerCandidateRegistration,
    candidateDigest: string,
    baselineRepository: BaselineRepositoryRef,
  ): Promise<VerifiedCandidateSnapshot | null> {
    const pathPolicy: CandidatePathPolicy = {
      policyProfile: registration.policyProfile ?? 'github',
      allowWorkflowWrites: registration.allowWorkflowWrites === true,
    };
    if (registration.runRoot !== undefined) {
      const fromRun = await candidateEntriesFromRunArtifacts(
        registration.runRoot,
        registration.runId,
        candidateDigest,
        registration.overlay,
        pathPolicy,
        baselineRepository,
      );
      if (fromRun !== null) return fromRun;
      return null;
    }
    if (registration.candidateFiles !== undefined) {
      for (const path of Object.keys(registration.candidateFiles)) {
        if (!isSafeCandidatePath(path, pathPolicy)) return null;
      }
    }
    const expected = await computeRunnerCandidateDigest({
      repositorySnapshot: registration.repositorySnapshot,
      headSha: registration.identity.headSha,
      ...(registration.proposalJson !== undefined ? { proposalJson: registration.proposalJson } : {}),
      ...(registration.candidateFiles === undefined ? {} : { candidateFiles: registration.candidateFiles }),
      ...(registration.overlay !== undefined ? { overlay: registration.overlay } : {}),
    });
    if (expected.digest !== candidateDigest) return null;
    const entries = new Map<string, VerifiedCandidateEntry>();
    for (const [path, bytes] of expected.files.entries()) {
      entries.set(path, {
        path,
        byteLength: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        source: { kind: 'inline', bytes },
      });
    }
    return { manifestKind: 'snapshot', entries, deleted: [] };
  }

  async function handleGate(request: Record<string, unknown>): Promise<{ bytes: Buffer } | null> {
    for (const field of ['gateId', 'checkId', 'candidateDigest', 'requestDigest']) {
      const value = request[field];
      if (typeof value !== 'string' || value.length === 0 || value.length > 128) return null;
    }
    if (String(request.gateId) !== 'runner-candidate-validation' || String(request.checkId) !== 'runner-candidate-validation') return null;
    const subject = request.subject;
    if (subject === null || typeof subject !== 'object' || Array.isArray(subject)) return null;
    const binding = { ...lookupBinding(request)!, lockHash: request.lockHash } as Binding;
    if (binding === undefined) return null;
    const normalized = lookupBinding(request);
    if (normalized === null) return null;
    const replayKey = `${normalized.storeId}|${normalized.runId}|${normalized.dispatchId}|${normalized.operationId}`;
    const seenDigest = replayBindings.get(replayKey);
    if (seenDigest !== undefined && seenDigest !== String(request.requestDigest)) return null;
    replayBindings.set(replayKey, String(request.requestDigest));
    const candidateDigest = String(request.candidateDigest);
    const verdictBase = { gateId: String(request.gateId), checkId: String(request.checkId), candidateDigest };
    const registration = registrationFor(normalized);
    if (registration === undefined) {
      return { bytes: verdictDocument(binding, { ...verdictBase, status: 'denied', reason: 'candidate not registered for this run binding', expiresAtMs: String(Date.now() + 60000) }) };
    }
    if (registration.candidateDigest != null && registration.candidateDigest !== candidateDigest) {
      return { bytes: verdictDocument(binding, { ...verdictBase, status: 'denied', reason: 'candidate digest differs from the pinned registration', expiresAtMs: String(Date.now() + 60000) }) };
    }
    const subjectCandidate = (subject as Record<string, unknown>).candidateDigest;
    const subjectCandidateHex = typeof subjectCandidate === 'string' ? subjectCandidate : subjectCandidate !== null && typeof subjectCandidate === 'object' ? String((subjectCandidate as Record<string, unknown>).hex ?? '') : undefined;
    if (subjectCandidateHex !== undefined && subjectCandidateHex !== '' && subjectCandidateHex !== candidateDigest) {
      return { bytes: verdictDocument(binding, { ...verdictBase, status: 'denied', reason: 'subject candidate digest differs from the request binding', expiresAtMs: String(Date.now() + 60000) }) };
    }
    const subjectRepository = (subject as Record<string, unknown>).repository;
    if (subjectRepository !== undefined && String(subjectRepository) !== registration.identity.repository) {
      return { bytes: verdictDocument(binding, { ...verdictBase, status: 'denied', reason: 'subject repository differs from the registered identity', expiresAtMs: String(Date.now() + 60000) }) };
    }
    const isRevise = registration.identity.mode === 'revise' && registration.identity.prHeadSha != null;
    const gateRepoSource = isRevise ? (activeDouble(registration.repositorySnapshot) ? ensureFakeRepoDir(registration.repositorySnapshot) : registration.repositorySnapshot) : registration.repositorySnapshot;
    const gateHeadSha = isRevise ? registration.identity.prHeadSha! : registration.identity.headSha;
    const candidateSnapshot = await resolveCandidateEntries(request, registration, candidateDigest, {
      repository: gateRepoSource,
      revision: gateHeadSha,
    });
    if (candidateSnapshot === null) {
      return { bytes: verdictDocument(binding, { ...verdictBase, status: 'denied', reason: 'candidate digest does not match registered candidate snapshot', expiresAtMs: String(Date.now() + 60000) }) };
    }
    const candidateEntries = candidateSnapshot.entries;
    const metaFields = registration.gateVerdictMetadata !== undefined
      ? {
          ...(Object.hasOwn(registration.gateVerdictMetadata, 'detail') ? { detail: registration.gateVerdictMetadata.detail } : {}),
          ...(registration.gateVerdictMetadata.metrics !== undefined ? { metrics: registration.gateVerdictMetadata.metrics } : {}),
          ...(registration.gateVerdictMetadata.findings !== undefined ? { findings: registration.gateVerdictMetadata.findings } : {}),
        }
      : {};
    const proposalEntry = candidateEntries.get('.autosync/proposal.json');
    let proposalByteLength: number | null = proposalEntry !== undefined ? proposalEntry.byteLength : null;
    if (
      proposalByteLength === null
      && candidateSnapshot.manifestKind === 'overlay'
      && !candidateSnapshot.deleted.includes('.autosync/proposal.json')
    ) {
      proposalByteLength = await readBaselineRegularFileSize(gateRepoSource, gateHeadSha, '.autosync/proposal.json');
    }
    if (proposalByteLength === null) {
      return { bytes: verdictDocument(binding, { ...verdictBase, status: 'denied', reason: 'candidate snapshot omits .autosync/proposal.json', expiresAtMs: String(Date.now() + 60000), ...metaFields }) };
    }
    if (proposalByteLength > MAX_PROPOSAL_BYTES) {
      return { bytes: verdictDocument(binding, { ...verdictBase, status: 'denied', reason: 'candidate .autosync/proposal.json exceeds 1 MiB limit', expiresAtMs: String(Date.now() + 60000), ...metaFields }) };
    }
    const key = `${normalized.storeId}|${normalized.runId}|${candidateDigest}`;
    const rawCached = checkedCache.get(key);
    const cached = rawCached !== undefined
      && validatorRegistrationFingerprint(rawCached.registration) === validatorRegistrationFingerprint(registration)
      ? rawCached
      : undefined;
    if (cached === undefined) {
      const gateTempDir = await mkdtemp(join(scratch, 'gate-index-'));
      await chmod(gateTempDir, 0o700);
      let outcome: Awaited<ReturnType<PythonBridge['run']>>;
      try {
        const inlineBlobsDir = join(gateTempDir, 'inline-blobs');
        let inlineDirReady = false;
        const materializedInline = new Map<string, string>();
        const indexEntries: { readonly path: string; readonly blobPath: string; readonly byteLength: number; readonly sha256: string }[] = [];
        const sortedEntries = [...candidateEntries.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
        for (const entry of sortedEntries) {
          let blobPath: string;
          if (entry.source.kind === 'cas_file') {
            blobPath = entry.source.blobPath;
          } else {
            const existing = materializedInline.get(entry.sha256);
            if (existing !== undefined) {
              blobPath = existing;
            } else {
              if (!inlineDirReady) {
                await mkdir(inlineBlobsDir, { mode: 0o700 });
                inlineDirReady = true;
              }
              const inlinePath = join(inlineBlobsDir, entry.sha256);
              const handle = await open(inlinePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
              try {
                let offset = 0;
                while (offset < entry.source.bytes.byteLength) {
                  const written = await handle.write(entry.source.bytes, offset, entry.source.bytes.byteLength - offset);
                  if (written.bytesWritten <= 0) throw new RunnerTaskpackError('SERVICE_FAULT', 'short write materializing inline gate blob');
                  offset += written.bytesWritten;
                }
                await handle.chmod(0o400);
              } finally {
                await handle.close();
              }
              materializedInline.set(entry.sha256, inlinePath);
              blobPath = inlinePath;
            }
          }
          indexEntries.push({ path: entry.path, blobPath, byteLength: entry.byteLength, sha256: entry.sha256 });
        }
        const sortedDeleted = [...candidateSnapshot.deleted].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const candidateIndexPath = join(gateTempDir, 'candidate-index.json');
        await writeFile(candidateIndexPath, JSON.stringify({ version: 1, entries: indexEntries, deleted: sortedDeleted }), { mode: 0o600 });
        outcome = await bridge.run(GATE_DRIVER, {
          timeoutMs: 180000,
          stdin: JSON.stringify({
            vendorRoot: (await verifyFrozenCorpus(options.corpusRoot)).root,
            repository: gateRepoSource,
            identity: { repository: registration.identity.repository, default_sha: registration.identity.defaultSha, head_sha: gateHeadSha, mode: registration.identity.mode, pr_number: registration.identity.prNumber, command_id: registration.identity.commandId, command_digest: registration.identity.commandDigest },
            candidateIndexPath,
            sources: registration.upstreamSources,
            ascendPairs: registration.ascendPairs,
            enginePrereleases: registration.enginePrereleases,
            prereleasePackages: registration.prereleasePackages,
          }),
        });
      } finally {
        await rm(gateTempDir, { recursive: true, force: true }).catch(() => undefined);
      }
      if (outcome.exitCode !== 0) {
        return { bytes: verdictDocument(binding, { ...verdictBase, status: 'denied', reason: `validator transport failed: ${outcome.stderr.slice(0, 180)}`, expiresAtMs: String(Date.now() + 60000), ...metaFields }) };
      }
      let report: { ok?: unknown; checked?: unknown; error?: unknown };
      try { report = JSON.parse(outcome.stdout) as typeof report; } catch { return { bytes: verdictDocument(binding, { ...verdictBase, status: 'denied', reason: 'validator produced unreadable output', expiresAtMs: String(Date.now() + 60000), ...metaFields }) }; }
      if (report.ok !== true || report.checked === null || typeof report.checked !== 'object') {
        return { bytes: verdictDocument(binding, { ...verdictBase, status: 'denied', reason: String(report.error ?? 'candidate validation failed').slice(0, 256), expiresAtMs: String(Date.now() + 60000), ...metaFields }) };
      }
      const checked = report.checked as Record<string, unknown>;
      const patchDigest = typeof checked.patch_digest === 'string' ? checked.patch_digest : null;
      checkedCache.set(key, { registration, candidateDigest, checked, patchDigest });
      if (options.headMutation !== undefined && options.headMutation.repository === registration.repositorySnapshot) {
        await execFileAsync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Human Committer', '-c', 'user.email=human@example.invalid', 'commit', '--allow-empty', '-qm', options.headMutation.message], { cwd: registration.repositorySnapshot, env: { HOME: scratch, PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).catch(() => undefined);
      }
    }
    return { bytes: verdictDocument(binding, { ...verdictBase, status: 'approved', reason: null, expiresAtMs: String(Date.now() + 3600000), ...metaFields }) };
  }

  class ChaosDrop extends Error {
    constructor() { super('chaos drop after write'); }
  }

  async function handlePublish(request: Record<string, unknown>): Promise<{ bytes: Buffer } | null> {
    for (const field of ['idempotencyKey', 'candidateDigest', 'requestDigest', 'targetBranch', 'headBranch', 'title', 'baseRevision', 'sourceRevision']) {
      const value = request[field];
      if (typeof value !== 'string' || value.length === 0 || value.length > 256) return null;
    }
    const normalized = lookupBinding(request);
    if (normalized === null) return null;
    const binding: Binding = { ...normalized, lockHash: request.lockHash };
    const idempotencyKey = String(request.idempotencyKey);
    const candidateDigest = String(request.candidateDigest);
    const requestDigest = String(request.requestDigest);
    const replay = idempotentReceipts.get(idempotencyKey);
    if (replay !== undefined) {
      if (replay.requestDigest !== requestDigest) return null;
      return { bytes: replay.bytes };
    }
    const base = { idempotencyKey, candidateDigest };
    const settle = (outcome: 'succeeded' | 'not_executed' | 'failed', externalUrl: string | null, reason: string | null): { bytes: Buffer } => {
      const bytes = receiptDocument(binding, { ...base, outcome, externalUrl, reason: reason === null ? null : reason.slice(0, 256) });
      idempotentReceipts.set(idempotencyKey, { requestDigest, bytes, signature: signPayload(publicationSecret, bytes) });
      void persistState();
      return { bytes };
    };
    const rawCached = checkedCache.get(`${normalized.storeId}|${normalized.runId}|${candidateDigest}`);
    // The gate-verified artifact is bound to the candidate digest; a re-registered binding (for example a
    // moved prHeadSha) refreshes the identity used for publication guards without re-running the gate,
    // provided its host policy profile and workflow-write authority have not changed.
    const registration = registrationFor(normalized) ?? rawCached?.registration;
    const cached = rawCached !== undefined
      && registration !== undefined
      && validatorRegistrationFingerprint(rawCached.registration) === validatorRegistrationFingerprint(registration)
      ? rawCached
      : undefined;
    if (cached === undefined || registration === undefined) return settle('not_executed', null, 'gate_revalidation_required: no gate-verified artifact for this binding');
    if (registration.candidateDigest != null && registration.candidateDigest !== candidateDigest) {
      return settle('not_executed', null, 'candidate_pin_mismatch: request candidate differs from the registered candidate digest');
    }
    if (String(request.baseRevision) !== registration.identity.defaultSha || String(request.sourceRevision) !== registration.identity.headSha) {
      return settle('not_executed', null, 'revision_binding_mismatch: request revisions differ from the registered identity');
    }
    const head = await headRevision(registration.repositorySnapshot);
    if (![registration.identity.defaultSha, registration.identity.headSha].includes(head)) {
      return settle('not_executed', null, `head_changed_before_publish: snapshot head ${head.slice(0, 12)} is outside the bound revisions`);
    }
    if (registration.identity.mode === 'revise') {
      const { prNumber, commandId, commandDigest } = registration.identity;
      if (prNumber === null || commandId === null || commandDigest === null || registration.reviseCommentBody === undefined) {
        return settle('not_executed', null, 'revise_binding_invalid: revise registration is missing its command binding');
      }
      const bodyDigest = createHash('sha256').update(Buffer.from(registration.reviseCommentBody, 'utf8')).digest('hex');
      if (bodyDigest !== commandDigest) return settle('not_executed', null, 'revise_binding_invalid: command body digest differs from the registered command digest');
      const state = await controlGetState(registration.repositorySnapshot);
      const managed = state.pulls.find(pull => pull.number === prNumber);
      if (managed === undefined) return settle('not_executed', null, 'revise_head_changed: the managed pull request is no longer open');
      const expectedPrHead = registration.identity.prHeadSha ?? (registration.identity.headSha !== registration.identity.defaultSha ? registration.identity.headSha : null);
      if (expectedPrHead !== null && managed.head_sha !== expectedPrHead) {
        return settle('not_executed', null, `revise_head_changed: managed pull request head ${managed.head_sha.slice(0, 12)} moved past the bound head`);
      }
      const commandMarkerPattern = new RegExp(`"command_id"\\s*:\\s*${commandId}\\b`);
      const recordedText = [managed.body, managed.commit_message, ...state.comments.map(c => c.body)].join('\n');
      if (commandMarkerPattern.test(recordedText)) {
        return settle('not_executed', null, 'duplicate_command_id: this command id was already applied to the managed pull request');
      }
    }
    const publishOutcome = await bridge.run(PUBLISH_DRIVER, {
      timeoutMs: 240000,
      stdin: JSON.stringify({
        vendorRoot: (await verifyFrozenCorpus(options.corpusRoot)).root,
        fakeUrl: activeDouble(registration.repositorySnapshot)?.fakeUrl ?? '',
        bot: 'runner-sync[bot]',
        snapshotPath: (registration.identity.mode === 'revise' && registration.identity.prHeadSha != null) ? (activeDouble(registration.repositorySnapshot) ? ensureFakeRepoDir(registration.repositorySnapshot) : registration.repositorySnapshot) : registration.repositorySnapshot,
        repository: registration.identity.repository,
        defaultSha: registration.identity.defaultSha,
        headSha: (registration.identity.mode === 'revise' && registration.identity.prHeadSha != null) ? registration.identity.prHeadSha! : registration.identity.headSha,
        event: registration.identity.mode === 'revise' ? await commentEvent(registration) : null,
        checked: cached.checked,
        sources: registration.upstreamSources,
        ascendPairs: registration.ascendPairs,
        enginePrereleases: registration.enginePrereleases,
        prereleasePackages: registration.prereleasePackages,
      }),
    });
    if (publishOutcome.timedOut) return settle('failed', null, 'publisher timeout: the frozen publish helper exceeded its budget');
    if (publishOutcome.exitCode !== 0) return settle('failed', null, `publisher transport failed: ${publishOutcome.stderr.slice(0, 180)}`);
    let report: { result?: { status?: unknown; reason?: unknown; pr_number?: unknown }; failed?: unknown };
    try { report = JSON.parse(publishOutcome.stdout) as typeof report; } catch { return settle('failed', null, 'publisher produced unreadable output'); }
    if (typeof report.failed === 'string') return settle('failed', null, `publisher error: ${report.failed}`);
    const status = String(report.result?.status ?? 'unknown');
    if (status === 'published' || status === 'duplicate') {
      const state = await controlGetState(registration.repositorySnapshot);
      const prNumber = typeof report.result?.pr_number === 'number' ? report.result.pr_number : null;
      const landed = state.pulls.find(pull => pull.number === prNumber) ?? state.pulls[state.pulls.length - 1] ?? null;
      const receipt = settle('succeeded', landed?.html_url ?? null, status === 'duplicate' ? 'converged with an already-landed managed pull request' : null);
      if (options.publicationChaos === 'drop_after_write') throw new ChaosDrop();
      return receipt;
    }
    if (status === 'failed') return settle('failed', null, `publish failed: ${String(report.result?.reason ?? 'frozen publish reported failure')}`);
    if (status === 'ignored' || status === 'no_changes') return settle('not_executed', null, `${status}: ${String(report.result?.reason ?? 'no remote write occurred')}`);
    if (status === 'deferred') return settle('not_executed', null, `deferred: ${String(report.result?.reason ?? 'publication deferred')}`);
    return settle('failed', null, `unknown publish status: ${status}: ${String(report.result?.reason ?? '')}`);
  }

  async function commentEvent(registration: RunnerCandidateRegistration): Promise<unknown> {
    const active = activeDouble(registration.repositorySnapshot);
    if (active === null) throw new RunnerTaskpackError('SERVICE_FAULT', 'github service double is not running');
    const body = registration.reviseCommentBody ?? '/auto-sync\nRevise the managed proposal.';
    const response = await fetch(`http://127.0.0.1:${active.controlPort}/comment-event`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body, commentId: registration.identity.commandId }) });
    if (!response.ok) throw new RunnerTaskpackError('SERVICE_FAULT', 'comment event preparation failed');
    return ((await response.json()) as { event: unknown }).event;
  }

  const server: Server = createServer((incoming: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const signature = incoming.headers['x-loopwright-signature'];
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of incoming) {
        size += (chunk as Buffer).byteLength;
        if (size > MAX_REQUEST_BYTES) { response.writeHead(413).end(); return; }
        chunks.push(chunk as Buffer);
      }
      const body = Buffer.concat(chunks);
      const route = incoming.url?.split('?')[0] ?? '';
      if (route === '/gate' && incoming.method === 'POST') {
        const parsed = verifyAndParse(body, gateSecret, typeof signature === 'string' ? signature : undefined, ['gate_request']);
        if (parsed === null) { response.writeHead(403).end(); return; }
        const outcome = await handleGate(parsed);
        if (outcome === null) { response.writeHead(400).end(); return; }
        respondJson(response, outcome.bytes, signPayload(gateSecret, outcome.bytes));
        return;
      }
      if (route === '/publish' && incoming.method === 'POST') {
        const parsed = verifyAndParse(body, publicationSecret, typeof signature === 'string' ? signature : undefined, ['publication_request']);
        if (parsed === null) { response.writeHead(403).end(); return; }
        try {
          const outcome = await handlePublish(parsed);
          if (outcome === null) { response.writeHead(400).end(); return; }
          respondJson(response, outcome.bytes, signPayload(publicationSecret, outcome.bytes));
        } catch {
          if (options.publicationChaos === 'drop_after_write') { response.destroy(); return; }
          response.writeHead(500).end();
        }
        return;
      }
      response.writeHead(404).end();
    })().catch(() => { try { response.writeHead(500).end(); } catch { /* socket gone */ } });
  });

  const port = options.port ?? 0;
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new RunnerTaskpackError('SERVICE_FAULT', 'loopback listener failed to bind');
  const boundPort = address.port;
  let closed = false;

  return {
    gateUrl: `http://127.0.0.1:${boundPort}/gate`,
    publicationUrl: `http://127.0.0.1:${boundPort}/publish`,
    port: boundPort,
    registerCandidate(registration: RunnerCandidateRegistration): Promise<void> {
      registrations.set(`${registration.storeId}|${registration.runId}`, registration);
      return ensureFakeDouble(registration.repositorySnapshot);
    },
    async fakePullCount() {
      return (await controlGetState()).pulls.length;
    },
    async fakePullHeadSha(prNumber: number) {
      return (await controlGetState()).pulls.find(pull => pull.number === prNumber)?.head_sha ?? null;
    },
    async fakeHumanCommit(path: string, content: string): Promise<string> {
      const active = activeDouble();
      if (active === null) throw new RunnerTaskpackError('SERVICE_FAULT', 'github service double is not running');
      const response = await fetch(`http://127.0.0.1:${active.controlPort}/human-commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, content }) });
      if (!response.ok) throw new RunnerTaskpackError('SERVICE_FAULT', 'human commit preparation failed');
      return ((await response.json()) as { sha: string }).sha;
    },
    checkedFor(runId: string) {
      const entries = [...checkedCache.entries()].filter(([key]) => key.includes(`|${runId}|`));
      if (entries.length === 0) return null;
      const [, last] = entries[entries.length - 1]!;
      const checked = last.checked as { groups?: Array<{ status?: unknown }> };
      const acceptedGroups = Array.isArray(checked.groups) ? checked.groups.filter(g => (g as Record<string, unknown>).status === 'ready').length : 0;
      return { candidateDigest: last.candidateDigest, acceptedGroups, patchDigest: last.patchDigest };
    },
    async deriveOperatorReceipt(input: OperatorReceiptInput) {
      const state = await controlGetState();
      const cached = checkedCache.get(`${input.storeId}|${input.runId}|${input.candidateDigest}`) ?? [...checkedCache.entries()].find(([key]) => key.endsWith(`|${input.runId}|${input.candidateDigest}`))?.[1];
      const expectedBranch = `loopwright-runner-${input.runId}`;
      const patchDigest = cached?.patchDigest ?? null;
      const matched = state.pulls.find(pull =>
        (typeof pull.head_ref === 'string' && pull.head_ref === expectedBranch) ||
        (patchDigest !== null && (pull.commit_message + '\n' + pull.body).includes(patchDigest))) ?? null;
      const bodyObj = {
        version: 1,
        kind: 'publication_receipt',
        storeId: input.storeId,
        runId: input.runId,
        lockHash: input.lockHash ?? '',
        operationId: input.operationId,
        dispatchId: input.dispatchId,
        dispatchGeneration: input.dispatchGeneration,
        idempotencyKey: input.idempotencyKey,
        candidateDigest: input.candidateDigest,
        outcome: matched === null ? 'not_executed' : 'succeeded',
        externalUrl: matched?.html_url ?? null,
        reason: matched === null ? 'no pull request matching the bound candidate landed in the service double' : null,
      };
      const signature = signPayload(publicationSecret, canonical(bodyObj));
      const bytes = Buffer.from(JSON.stringify({ ...bodyObj, signature }));
      return { bytes, signature };
    },
    async close() {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)));
      const children = new Set<import('node:child_process').ChildProcess>([...trackedChildren, ...[...fakeDoubles.values()].map(instance => instance.child)]);
      await Promise.all([...children].map(child => terminateResidentChild(child)));
      fakeDoubles.clear();
      if (ownedBridge) await bridge.dispose();
      await rm(scratch, { recursive: true, force: true });
    },
  };
}
