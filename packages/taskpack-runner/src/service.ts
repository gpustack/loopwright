import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { signPayload, verifySignedPayload } from '@loopwright/controller';
import { identifyManifest } from '@loopwright/core';
import { verifyFrozenCorpus } from './corpus.js';
import { PythonBridge } from './python-bridge.js';
import { RunnerTaskpackError } from './types.js';

const execFileAsync = promisify(execFile);

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

const GATE_DRIVER = `import base64, json, shutil, subprocess, sys, tempfile
from pathlib import Path
config = json.loads(sys.stdin.read())
sys.path.insert(0, config["vendorRoot"])
from tools.auto_sync.assemble import assemble
from tools.auto_sync.proposal import validate_proposal
from tools.auto_sync.checks import validate_candidate
work = Path(tempfile.mkdtemp(prefix="runner-gate-"))
try:
    repo = work / "target"
    subprocess.run(["git", "clone", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-q", "--no-hardlinks", config["repository"], str(repo)], check=True)
    subprocess.run(["git", "-C", str(repo), "-c", "core.hooksPath=/dev/null", "checkout", "-q", "-B", "pr-head", config["identity"]["head_sha"]], check=True)
    for path, b64 in config["candidateFilesB64"]:
        if config["identity"].get("mode") == "revise" and not path.startswith(".autosync/"):
            continue
        target = repo / path
        if ".." in Path(path).parts or Path(path).is_absolute():
            print(json.dumps({"ok": False, "error": "candidate path escapes the repository: %s" % path}))
            sys.exit(0)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(base64.standard_b64decode(b64))
    proposal = json.loads(base64.standard_b64decode(config["proposalB64"]))
    assembled = assemble(proposal, repo)
    normalized = validate_proposal(assembled, config["identity"], engine_prereleases=set(config["enginePrereleases"]), prerelease_packages=set(config["prereleasePackages"]))
    checked = validate_candidate(repo, normalized, config["identity"], sources=config["sources"], ascend_pairs=config["ascendPairs"], engine_prereleases=set(config["enginePrereleases"]), prerelease_packages=set(config["prereleasePackages"]))
    accepted = len([g for g in checked.get("groups", []) if g.get("status") == "ready"])
    if accepted == 0:
        print(json.dumps({"ok": False, "error": "zero accepted groups: %s" % json.dumps(checked.get("rejected", []))[:200]}))
        sys.exit(0)
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

/** Candidate files, exact-source fixtures, and the target snapshot a registered run's gate requests bind to. */
export interface RunnerCandidateRegistration {
  readonly storeId: string;
  readonly runId: string;
  /** Optional pin: when set, gate requests carrying a different candidate digest are denied. */
  readonly candidateDigest?: string | null;
  /** The operator-registered proposal; used only for direct (Path B) digest computation, never as the validated candidate. */
  readonly proposalJson: string;
  readonly identity: RunnerCandidateIdentity;
  readonly repositorySnapshot: string;
  readonly upstreamSources: Readonly<Record<string, string>>;
  readonly ascendPairs: Readonly<Record<string, unknown>>;
  readonly enginePrereleases: readonly string[];
  readonly prereleasePackages: readonly string[];
  /** Run root when the candidate comes from a controller cycle's checkpoint snapshots (Path A). */
  readonly runRoot?: string;
  /** Direct candidate file overrides for unit-level registrations (Path B). */
  readonly candidateFiles?: Readonly<Record<string, string>>;
  /** Authorized revise command body; required (with commandDigest) when identity.mode is 'revise'. */
  readonly reviseCommentBody?: string;
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
  readonly proposalJson?: string;
  readonly candidateFiles?: Readonly<Record<string, string | Uint8Array>>;
}

/**
 * Deterministic candidate digest: the git tree at headSha overlaid with the proposal document and any extra
 * candidate files, identified through the same ArtifactManifest discipline the controller uses.
 */
export async function computeRunnerCandidateDigest(options: ComputeRunnerCandidateDigestOptions): Promise<{ readonly digest: string; readonly files: ReadonlyMap<string, Buffer> }> {
  const tree = await execFileAsync('/usr/bin/git', ['ls-tree', '-rz', '--full-tree', options.headSha], { cwd: options.repositorySnapshot, encoding: 'utf8', maxBuffer: 33554432 });
  const files = new Map<string, Buffer>();
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
  if (options.proposalJson !== undefined && options.proposalJson !== '') {
    files.set('.autosync/proposal.json', Buffer.from(options.proposalJson, 'utf8'));
  }
  if (options.candidateFiles !== undefined) {
    for (const [path, content] of Object.entries(options.candidateFiles)) {
      files.set(path, typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content));
    }
  }
  const entries = [...files.entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([name, bytes]) => ({ name, digest: { algorithm: 'sha256' as const, hex: createHash('sha256').update(bytes).digest('hex') }, byteLength: bytes.byteLength }));
  const identified = identifyManifest({ apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' }, spec: { entries } });
  if (!identified.ok) throw new RunnerTaskpackError('SERVICE_FAULT', `candidate manifest rejected: ${JSON.stringify(identified.errors).slice(0, 200)}`);
  return { digest: identified.value.digest.hex, files };
}

interface CheckedEntry {
  readonly registration: RunnerCandidateRegistration;
  readonly candidateDigest: string;
  readonly candidateFiles: Map<string, Buffer>;
  readonly checked: Record<string, unknown>;
  readonly patchDigest: string | null;
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

function verdictDocument(binding: Binding, extra: { gateId: string; checkId: string; candidateDigest: string; status: 'approved' | 'denied'; reason: string | null; expiresAtMs: string }): Buffer {
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

/** Reconstruct the candidate files from the run's checkpoint workspace snapshots for a given manifest digest. */
async function candidateFilesFromRunArtifacts(runRoot: string, runId: string, candidateDigest: string): Promise<Map<string, Buffer> | null> {
  let checkpoints: string;
  try { checkpoints = join(runRoot, runId, 'artifacts', 'pi-checkpoints'); } catch { return null; }
  let files: string[];
  try { files = await readdir(checkpoints); } catch { return null; }
  for (const name of files.filter(file => file.endsWith('.workspace.ndjson')).sort()) {
    const bytes = await readFile(join(checkpoints, name));
    const lines = bytes.toString('utf8').split('\n').filter(line => line.trim() !== '');
    if (lines.length === 0) continue;
    let header: { type?: unknown; manifest?: unknown };
    try { header = JSON.parse(lines[0]!) as typeof header; } catch { continue; }
    if (header.type !== 'workspace_snapshot') continue;
    const manifestCandidate = header.manifest as { spec?: { entries?: { name: string; digest: { hex: string }; byteLength: number }[] } } | undefined;
    const entries = manifestCandidate?.spec?.entries;
    if (!Array.isArray(entries)) continue;
    // Identify the manifest the same way the controller does, then compare.
    const identified = identifyManifest({ apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' }, spec: { entries: entries.map(entry => ({ name: entry.name, digest: { algorithm: 'sha256' as const, hex: entry.digest.hex }, byteLength: entry.byteLength })) } });
    if (!identified.ok) continue;
    if (identified.value.digest.hex !== candidateDigest) continue;
    const reconstructed = new Map<string, Buffer>();
    let currentName: string | null = null, currentDigest: string | null = null, currentLength = 0, chunks: Buffer[] = [];
    let complete = 0;
    for (const line of lines.slice(1)) {
      let row: Record<string, unknown>;
      try { row = JSON.parse(line) as Record<string, unknown>; } catch { return null; }
      if (row.type === 'file') { currentName = String(row.ref !== null && typeof row.ref === 'object' ? (row.ref as Record<string, unknown>).name : ''); currentDigest = String(row.ref !== null && typeof row.ref === 'object' ? (row.ref as Record<string, unknown>).digest !== undefined ? ((row.ref as Record<string, unknown>).digest as Record<string, unknown>).hex : '' : ''); currentLength = Number(row.ref !== null && typeof row.ref === 'object' ? (row.ref as Record<string, unknown>).byteLength : 0); chunks = []; continue; }
      if (row.type === 'chunk') { chunks.push(Buffer.from(String(row.data), 'base64')); continue; }
      if (row.type === 'file_end') {
        const bytes2 = Buffer.concat(chunks);
        if (bytes2.byteLength !== currentLength || createHash('sha256').update(bytes2).digest('hex') !== currentDigest) return null;
        if (currentName !== null) reconstructed.set(currentName, bytes2);
        complete += 1;
        continue;
      }
      if (row.type === 'end') { if (Number(row.files) !== complete || complete !== entries.length) return null; break; }
    }
    return reconstructed;
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

  async function resolveCandidateFiles(request: Record<string, unknown>, registration: RunnerCandidateRegistration, candidateDigest: string): Promise<Map<string, Buffer> | null> {
    if (registration.runRoot !== undefined) {
      const fromRun = await candidateFilesFromRunArtifacts(registration.runRoot, registration.runId, candidateDigest);
      if (fromRun !== null) return fromRun;
      return null;
    }
    const expected = await computeRunnerCandidateDigest({ repositorySnapshot: registration.repositorySnapshot, headSha: registration.identity.headSha, proposalJson: registration.proposalJson, ...(registration.candidateFiles === undefined ? {} : { candidateFiles: registration.candidateFiles }) });
    if (expected.digest !== candidateDigest) return null;
    return new Map(expected.files);
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
    const candidateFiles = await resolveCandidateFiles(request, registration, candidateDigest);
    if (candidateFiles === null) {
      return { bytes: verdictDocument(binding, { ...verdictBase, status: 'denied', reason: 'candidate digest does not match registered candidate snapshot', expiresAtMs: String(Date.now() + 60000) }) };
    }
    const proposalBytes = candidateFiles.get('.autosync/proposal.json');
    if (proposalBytes === undefined) {
      return { bytes: verdictDocument(binding, { ...verdictBase, status: 'denied', reason: 'candidate snapshot omits .autosync/proposal.json', expiresAtMs: String(Date.now() + 60000) }) };
    }
    const key = `${normalized.storeId}|${normalized.runId}|${candidateDigest}`;
    const cached = checkedCache.get(key);
    if (cached === undefined) {
      const candidateFilesB64 = [...candidateFiles.entries()].map(([path, bytes]) => [path, bytes.toString('base64')] as [string, string]);
      const isRevise = registration.identity.mode === 'revise' && registration.identity.prHeadSha != null;
      const gateRepoSource = isRevise ? (activeDouble(registration.repositorySnapshot) ? ensureFakeRepoDir(registration.repositorySnapshot) : registration.repositorySnapshot) : registration.repositorySnapshot;
      const gateHeadSha = isRevise ? registration.identity.prHeadSha! : registration.identity.headSha;
      const outcome = await bridge.run(GATE_DRIVER, {
        timeoutMs: 180000,
        stdin: JSON.stringify({
          vendorRoot: (await verifyFrozenCorpus(options.corpusRoot)).root,
          repository: gateRepoSource,
          identity: { repository: registration.identity.repository, default_sha: registration.identity.defaultSha, head_sha: gateHeadSha, mode: registration.identity.mode, pr_number: registration.identity.prNumber, command_id: registration.identity.commandId, command_digest: registration.identity.commandDigest },
          proposalB64: proposalBytes.toString('base64'),
          candidateFilesB64,
          sources: registration.upstreamSources,
          ascendPairs: registration.ascendPairs,
          enginePrereleases: registration.enginePrereleases,
          prereleasePackages: registration.prereleasePackages,
        }),
      });
      if (outcome.exitCode !== 0) {
        return { bytes: verdictDocument(binding, { ...verdictBase, status: 'denied', reason: `validator transport failed: ${outcome.stderr.slice(0, 180)}`, expiresAtMs: String(Date.now() + 60000) }) };
      }
      let report: { ok?: unknown; checked?: unknown; error?: unknown };
      try { report = JSON.parse(outcome.stdout) as typeof report; } catch { return { bytes: verdictDocument(binding, { ...verdictBase, status: 'denied', reason: 'validator produced unreadable output', expiresAtMs: String(Date.now() + 60000) }) }; }
      if (report.ok !== true || report.checked === null || typeof report.checked !== 'object') {
        return { bytes: verdictDocument(binding, { ...verdictBase, status: 'denied', reason: String(report.error ?? 'candidate validation failed').slice(0, 256), expiresAtMs: String(Date.now() + 60000) }) };
      }
      const checked = report.checked as Record<string, unknown>;
      const patchDigest = typeof checked.patch_digest === 'string' ? checked.patch_digest : null;
      checkedCache.set(key, { registration, candidateDigest, candidateFiles, checked, patchDigest });
      if (options.headMutation !== undefined && options.headMutation.repository === registration.repositorySnapshot) {
        await execFileAsync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Human Committer', '-c', 'user.email=human@example.invalid', 'commit', '--allow-empty', '-qm', options.headMutation.message], { cwd: registration.repositorySnapshot, env: { HOME: scratch, PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).catch(() => undefined);
      }
    }
    return { bytes: verdictDocument(binding, { ...verdictBase, status: 'approved', reason: null, expiresAtMs: String(Date.now() + 3600000) }) };
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
    const cached = checkedCache.get(`${normalized.storeId}|${normalized.runId}|${candidateDigest}`);
    if (cached === undefined) return settle('not_executed', null, 'gate_revalidation_required: no gate-verified artifact for this binding');
    // The gate-verified artifact is bound to the candidate digest; a re-registered binding (for example a
    // moved prHeadSha) refreshes the identity used for publication guards without re-running the gate.
    const registration = registrationFor(normalized) ?? cached.registration;
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
