import { execFile, spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { constants, existsSync, writeFileSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { createBashTool, createReadTool } from '@earendil-works/pi-coding-agent';
import type { JsonRpcMessage } from '@earendil-works/pi-mcp';
import { constructAdapterV2 } from './adapter-v2.js';
import { constructAdapter, type FactoryPorts, type LeasePort } from './adapter.js';
import { stateValue } from './admission.js';
import { canonical, digest, freeze, integer, list, object } from './boundary.js';
import { receiveBrokerMessage } from './broker-channel.js';
import { materializeCandidateDirectory, setDirectoryTreeMode } from './candidate.js';
import type { ContainerExit } from './containers.js';
import { parseBoundedJson } from './context.js';
import { scheduleDeadline } from './deadline.js';
import { PiFailure, refuse } from './errors.js';
import { Execution, type AdmittedToolIdentity, type ExecutionPorts } from './execution.js';
import { verifyNativeCompletion } from './lifecycle.js';
import type { McpProcessPort } from './mcp-process.js';
import { sameIdentity } from './policy.js';
import { Channel, type ChannelMessage } from './protocol.js';
import type { RuntimeBroker } from './provider.js';
import { recoverSnapshot } from './recovery.js';
import { systemPrompt } from './resources.js';
import { profileIdentity } from './runtime-profile.js';
import { canonicalDirectory } from './session-host.js';
import { SnapshotTransfer } from './snapshot-transfer.js';
import type { ToolProcessPort, ToolProcessReply } from './tool-process.js';
import type { ToolResult } from './tools.js';
import type { PiAdapterV2, PiHostV2, PiOpenInputV2, PiResultV2 } from './types-v2.js';
import type { PiAdapter, PiCapabilities, PiErrorCode, PiHost, PiOpenInput, PiResult } from './types.js';
import { WORKSPACE_TOOL, readWorkspace } from './workspace-mcp.js';

const exec = promisify(execFile);
const probeEnv = { PATH: '/usr/bin:/bin:/usr/sbin', LANG: 'C' };

export function isSupportedHostSessionPlatform(
  platform: string = process.platform,
  arch: string = process.arch,
): boolean {
  return (platform === 'darwin' && arch === 'arm64') || (platform === 'linux' && (arch === 'arm64' || arch === 'x64'));
}

function resolveLockfileUrl(): URL {
  const direct = new URL('../../../package-lock.json', import.meta.url);
  return existsSync(direct) ? direct : new URL('../../../../package-lock.json', import.meta.url);
}

function killProcessGroup(pid: number | undefined, includeLeader = true): void {
  if (pid && pid > 1) {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already exited */ }
    if (includeLeader) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
    }
  }
}

function escapeSeatbeltString(value: string): string {
  if (/[\0\r\n]/.test(value)) refuse('CONTAINMENT_MISMATCH', '', { phase: 'tool' });
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildDarwinSeatbeltProfile(canonicalScratchDir: string, canonicalTmpDir: string): string {
  const scratch = escapeSeatbeltString(canonicalScratchDir);
  const tmp = escapeSeatbeltString(canonicalTmpDir);
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny file-write*)',
    `(allow file-write* (subpath "${scratch}") (subpath "${tmp}") (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty"))`,
  ].join('\n');
}

let linuxBwrapSupported: boolean | null = null;
let linuxLandlockPythonPath: string | null | undefined = undefined;

const HOST_LANDLOCK_PROBE_SCRIPT = [
  'import ctypes, sys',
  'libc = ctypes.CDLL(None, use_errno=True)',
  'abi = libc.syscall(444, None, 0, 1)',
  'sys.exit(0 if abi >= 1 else 1)',
].join('; ');

const HOST_LANDLOCK_BOOTSTRAP_SCRIPT = `import ctypes, json, os, signal, sys

libc = ctypes.CDLL(None, use_errno=True)
PR_SET_PDEATHSIG = 1
PR_SET_NO_NEW_PRIVS = 38
SYS_landlock_create_ruleset = 444
SYS_landlock_add_rule = 445
SYS_landlock_restrict_self = 446
LANDLOCK_CREATE_RULESET_VERSION = 1 << 0
LANDLOCK_RULE_PATH_BENEATH = 1

class RulesetAttrFsOnly(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64)]

class RulesetAttrWithNet(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64), ("handled_access_net", ctypes.c_uint64)]

class PathBeneathAttr(ctypes.Structure):
    _pack_ = 1
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]

cfg = json.loads(sys.argv[1])
cmd = sys.argv[2]

libc.prctl(PR_SET_PDEATHSIG, signal.SIGKILL, 0, 0, 0)
if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
    sys.exit(126)

abi = libc.syscall(SYS_landlock_create_ruleset, None, 0, LANDLOCK_CREATE_RULESET_VERSION)
if abi < 1:
    sys.exit(126)

FS_EXECUTE = 1 << 0
FS_WRITE_FILE = 1 << 1
FS_READ_FILE = 1 << 2
FS_READ_DIR = 1 << 3
FS_REMOVE_DIR = 1 << 4
FS_REMOVE_FILE = 1 << 5
FS_MAKE_CHAR = 1 << 6
FS_MAKE_DIR = 1 << 7
FS_MAKE_REG = 1 << 8
FS_MAKE_SOCK = 1 << 9
FS_MAKE_FIFO = 1 << 10
FS_MAKE_BLOCK = 1 << 11
FS_MAKE_SYM = 1 << 12
FS_REFER = 1 << 13 if abi >= 2 else 0
FS_TRUNCATE = 1 << 14 if abi >= 3 else 0

READ_ACCESS = FS_EXECUTE | FS_READ_FILE | FS_READ_DIR
WRITE_FILE_ACCESS = FS_WRITE_FILE | FS_TRUNCATE
WRITE_DIR_ACCESS = (
    FS_WRITE_FILE | FS_REMOVE_DIR | FS_REMOVE_FILE | FS_MAKE_CHAR |
    FS_MAKE_DIR | FS_MAKE_REG | FS_MAKE_SOCK | FS_MAKE_FIFO |
    FS_MAKE_BLOCK | FS_MAKE_SYM | FS_REFER | FS_TRUNCATE
)
HANDLED_FS = READ_ACCESS | WRITE_DIR_ACCESS
HANDLED_NET = ((1 << 0) | (1 << 1)) if abi >= 4 else 0

attr = RulesetAttrWithNet(HANDLED_FS, HANDLED_NET) if abi >= 4 else RulesetAttrFsOnly(HANDLED_FS)
ruleset_fd = libc.syscall(SYS_landlock_create_ruleset, ctypes.byref(attr), ctypes.sizeof(attr), 0)
if ruleset_fd < 0:
    sys.exit(126)

O_PATH = getattr(os, "O_PATH", 0o10000000)

def add_path_rule(path, access, required=False):
    try:
        fd = os.open(path, O_PATH | os.O_CLOEXEC)
    except OSError:
        if required:
            sys.exit(126)
        return
    try:
        actual = access if os.path.isdir(path) else (access & (FS_EXECUTE | FS_READ_FILE | WRITE_FILE_ACCESS))
        if actual == 0:
            return
        rule = PathBeneathAttr(actual, fd)
        if libc.syscall(SYS_landlock_add_rule, ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, ctypes.byref(rule), 0) != 0 and required:
            sys.exit(126)
    finally:
        os.close(fd)

def is_same_or_child(candidate, parent):
    if parent == "/":
        return True
    return candidate == parent or candidate.startswith(parent + "/")

def grant_tree(current, excluded_set, access):
    if current in excluded_set:
        return
    needs_split = any(ex != current and is_same_or_child(ex, current) for ex in excluded_set)
    if not needs_split or not os.path.isdir(current) or os.path.islink(current):
        add_path_rule(current, access)
        return
    try:
        entries = os.listdir(current)
    except OSError:
        return
    for name in entries:
        child = "/" + name if current == "/" else current + "/" + name
        grant_tree(child, excluded_set, access)

denied_reads = {p for p in cfg.get("deniedReadPaths", []) if os.path.exists(p)}
grant_tree("/", denied_reads, READ_ACCESS)

for dev in ("/dev/null", "/dev/zero", "/dev/tty"):
    add_path_rule(dev, READ_ACCESS | WRITE_FILE_ACCESS)

add_path_rule(cfg["candidateDir"], READ_ACCESS, required=True)

for wp in (cfg["scratchDir"], cfg["tmpDir"]):
    add_path_rule(wp, READ_ACCESS | WRITE_DIR_ACCESS, required=True)

if libc.syscall(SYS_landlock_restrict_self, ruleset_fd, 0) != 0:
    os.close(ruleset_fd)
    sys.exit(126)
os.close(ruleset_fd)

os.chdir(cfg["scratchDir"])
os.execvp("/bin/bash", ["/bin/bash", "-c", cmd])
`;

function canUseLinuxBwrap(): boolean {
  if (process.platform !== 'linux') return false;
  if (linuxBwrapSupported !== null) return linuxBwrapSupported;
  if (!existsSync('/usr/bin/bwrap')) {
    linuxBwrapSupported = false;
    return false;
  }
  const probe = spawnSync(
    '/usr/bin/bwrap',
    ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-pid', '--unshare-net', '--', '/bin/true'],
    { timeout: 2000, env: probeEnv, stdio: 'ignore' },
  );
  linuxBwrapSupported = probe.status === 0;
  return linuxBwrapSupported;
}

function canUseLinuxLandlock(): string | null {
  if (process.platform !== 'linux') return null;
  if (linuxLandlockPythonPath !== undefined) return linuxLandlockPythonPath;
  const python3 = existsSync('/usr/bin/python3')
    ? '/usr/bin/python3'
    : existsSync('/bin/python3')
      ? '/bin/python3'
      : null;
  if (python3 === null) {
    linuxLandlockPythonPath = null;
    return null;
  }
  const probe = spawnSync(
    python3,
    ['-c', HOST_LANDLOCK_PROBE_SCRIPT],
    { timeout: 2000, env: probeEnv, stdio: 'ignore' },
  );
  linuxLandlockPythonPath = probe.status === 0 ? python3 : null;
  return linuxLandlockPythonPath;
}

function buildHostToolBashSpawnSpec(options: {
  readonly candidateDir: string;
  readonly scratchDir: string;
  readonly tmpDir: string;
  readonly ownedRoot: string;
  readonly seatbeltProfile: string | null;
  readonly command: string;
}): { readonly executable: string; readonly args: readonly string[] } {
  if (process.env['LOOPWRIGHT_TEST_DISABLE_HOST_CONFINEMENT'] === '1') {
    refuse('CONTAINMENT_MISMATCH', '', { phase: 'tool' });
  }
  if (process.platform === 'darwin') {
    if (options.seatbeltProfile !== null && existsSync('/usr/bin/sandbox-exec')) {
      return { executable: '/usr/bin/sandbox-exec', args: ['-p', options.seatbeltProfile, '/bin/bash', '-c', options.command] };
    }
    refuse('CONTAINMENT_MISMATCH', '', { phase: 'tool' });
  }
  if (process.platform === 'linux') {
    if (canUseLinuxBwrap()) {
      return {
        executable: '/usr/bin/bwrap',
        args: [
          '--ro-bind', '/', '/',
          '--bind', options.scratchDir, options.scratchDir,
          '--bind', options.tmpDir, options.tmpDir,
          '--dev', '/dev',
          '--proc', '/proc',
          '--unshare-pid',
          '--unshare-net',
          '--die-with-parent',
          '--chdir', options.scratchDir,
          '--',
          '/bin/bash', '-c', options.command,
        ],
      };
    }
    const landlockPython = canUseLinuxLandlock();
    if (landlockPython !== null) {
      const landlockConfig = JSON.stringify({
        candidateDir: options.candidateDir,
        scratchDir: options.scratchDir,
        tmpDir: options.tmpDir,
        deniedReadPaths: [`/proc/${process.pid}`, options.ownedRoot],
      });
      return {
        executable: landlockPython,
        args: ['-c', HOST_LANDLOCK_BOOTSTRAP_SCRIPT, landlockConfig, options.command],
      };
    }
    refuse('CONTAINMENT_MISMATCH', '', { phase: 'tool' });
  }
  refuse('CONTAINMENT_MISMATCH', '', { phase: 'tool' });
}

async function birth(pid: number): Promise<string | null> {
  try {
    const result = await exec('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
      timeout: 10000,
      maxBuffer: 1024,
      env: probeEnv,
    });
    const value = result.stdout.trim();
    if (!value || value.length > 128 || result.stderr) refuse('RECOVERY_REQUIRED');
    return value;
  } catch (error) {
    const value = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
    if (value.code === 1 && value.stdout === '' && value.stderr === '') return null;
    throw error;
  }
}

async function boot(): Promise<string> {
  if (process.platform === 'linux' && (process.arch === 'arm64' || process.arch === 'x64')) {
    let file: Awaited<ReturnType<typeof open>> | null = null;
    try {
      file = await open('/proc/sys/kernel/random/boot_id', constants.O_RDONLY | constants.O_NOFOLLOW);
      const buffer = Buffer.alloc(64);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      const raw = buffer.subarray(0, bytesRead).toString('utf8');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\n$/.test(raw)) refuse('RECOVERY_REQUIRED');
      return raw.trim();
    } catch {
      refuse('RECOVERY_REQUIRED');
    } finally {
      await file?.close();
    }
  }
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    const result = await exec('/usr/sbin/sysctl', ['-n', 'kern.boottime'], {
      timeout: 10000,
      maxBuffer: 1024,
      env: probeEnv,
    });
    if (!/^\{ sec = \d+, usec = \d+ \} [^\r\n]+\n$/.test(result.stdout) || result.stderr) refuse('RECOVERY_REQUIRED');
    return result.stdout.trim();
  }
  refuse('RUNTIME_UNSUPPORTED', '/host/runtime');
}

interface HostChildIntent {
  readonly name: string;
  readonly nonce: string;
  readonly role: 'sdk' | 'tool';
  readonly labels: Readonly<Record<string, string>>;
}

const hostLeases = new WeakMap<PiHost, HostExecutionLease>();

class HostExecutionLease implements LeasePort {
  #fd: Awaited<ReturnType<typeof open>> | null = null;
  #tail = Promise.resolve();
  #released = false;
  #releasing: Promise<void> | null = null;
  readonly #children = new Map<string, HostChildIntent>();
  readonly token = randomBytes(16).toString('hex');
  readonly path: string;

  private constructor(readonly host: PiHost, readonly input: PiOpenInput) {
    this.path = join(
      host.artifactsDirectory,
      'pi-execution-' + digest(Buffer.from(canonical({
        storeId: stateValue(host.store.inspect()).storeId,
        runId: input.lock.spec.runId,
      }))).hex + '.ndjson',
    );
  }

  static async acquire(host: PiHost, input: PiOpenInput): Promise<HostExecutionLease> {
    if (!isSupportedHostSessionPlatform(process.platform, process.arch)) {
      refuse('RUNTIME_UNSUPPORTED', '/host/runtime');
    }
    const root = await lstat(host.artifactsDirectory);
    if (
      !root.isDirectory() ||
      root.isSymbolicLink() ||
      root.uid !== process.getuid?.() ||
      root.mode & 0o022 ||
      (await realpath(host.artifactsDirectory)) !== resolve(host.artifactsDirectory)
    ) {
      refuse('INPUT_INVALID');
    }
    const lease = new HostExecutionLease(host, input);
    const born = await birth(process.pid);
    const bootIdentity = await boot();
    if (!born) refuse('RECOVERY_REQUIRED');

    try {
      lease.#fd = await open(lease.path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let recovery: Awaited<ReturnType<typeof open>>;
      try {
        recovery = await open(lease.path + '.recovery', constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      } catch {
        refuse('SESSION_BUSY');
      }
      try {
        await lease.#recover(bootIdentity);
        lease.#fd = await open(lease.path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      } finally {
        await recovery.close();
        await unlink(lease.path + '.recovery');
      }
    }

    try {
      const view = stateValue(host.store.inspect());
      stateValue(host.store.renew(host.authority));
      await lease.#append({
        type: 'owner',
        version: 2,
        daemon: { kind: 'host-process-group', platform: process.platform, arch: process.arch },
        token: lease.token,
        pid: process.pid,
        birth: born,
        boot: bootIdentity,
        authority: host.authority,
        storeId: view.storeId,
        runId: view.runId,
        lockHash: view.lockHash,
        clockBasis: view.clock.basis,
      });
      await lease.#syncParent();
      hostLeases.set(host, lease);
      return lease;
    } catch (error) {
      await lease.#fd?.close();
      lease.#fd = null;
      await unlink(lease.path);
      throw error;
    }
  }

  async #syncParent(): Promise<void> {
    const fd = await open(this.host.artifactsDirectory, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await fd.sync(); } finally { await fd.close(); }
  }

  async #append(value: unknown): Promise<void> {
    if (!this.#fd || this.#released) refuse('RECOVERY_REQUIRED');
    const bytes = Buffer.from(JSON.stringify(value) + '\n');
    if ((await this.#fd.stat()).size + bytes.length > 2097152) refuse('OUTPUT_LIMIT');
    await this.#fd.writeFile(bytes);
    await this.#fd.sync();
  }

  async #recover(bootIdentity: string): Promise<void> {
    const fd = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let rows: Record<string, unknown>[];
    let inode: number;
    try {
      const info = await fd.stat();
      inode = info.ino;
      if (!info.isFile() || info.uid !== process.getuid?.() || info.mode & 0o077 || info.nlink !== 1 || info.size > 2097152) {
        refuse('RECOVERY_REQUIRED');
      }
      const content = await fd.readFile('utf8');
      if (!content.endsWith('\n')) refuse('RECOVERY_REQUIRED');
      rows = content.slice(0, -1).split('\n').map(row => parseBoundedJson(row) as Record<string, unknown>);
    } finally {
      await fd.close();
    }

    const first = rows[0];
    if (!first || first.version !== 2) refuse('RECOVERY_REQUIRED');
    try {
      object(first, ['type', 'version', 'daemon', 'token', 'pid', 'birth', 'boot', 'authority', 'storeId', 'runId', 'lockHash', 'clockBasis']);
    } catch {
      refuse('RECOVERY_REQUIRED');
    }

    let daemon: Record<string, unknown>;
    try {
      daemon = object(first.daemon, ['kind', 'platform', 'arch']);
    } catch {
      refuse('RECOVERY_REQUIRED');
    }
    if (
      daemon.kind !== 'host-process-group' ||
      daemon.platform !== process.platform ||
      daemon.arch !== process.arch ||
      !isSupportedHostSessionPlatform(daemon.platform as string, daemon.arch as string)
    ) {
      refuse('RECOVERY_REQUIRED');
    }

    const view = stateValue(this.host.store.inspect());
    if (
      first.type !== 'owner' ||
      !Number.isSafeInteger(first.pid) ||
      (first.pid as number) < 1 ||
      typeof first.birth !== 'string' ||
      typeof first.token !== 'string' ||
      !/^[a-f0-9]{32}$/.test(first.token) ||
      first.boot !== bootIdentity ||
      first.storeId !== view.storeId ||
      first.runId !== view.runId ||
      !sameIdentity(first.lockHash, view.lockHash) ||
      !sameIdentity(first.clockBasis, view.clock.basis)
    ) {
      refuse('RECOVERY_REQUIRED');
    }

    const authority = object(first.authority, ['storeId', 'runId', 'lockHash', 'ownerId', 'generation', 'nonce']);
    if (
      authority.storeId !== view.storeId ||
      authority.runId !== view.runId ||
      !sameIdentity(authority.lockHash, view.lockHash) ||
      !Number.isSafeInteger(authority.generation) ||
      (authority.generation as number) > this.host.authority.generation
    ) {
      refuse('RECOVERY_REQUIRED');
    }

    const currentBirth = await birth(first.pid as number);
    if (currentBirth !== null) refuse(currentBirth === first.birth ? 'SESSION_BUSY' : 'RECOVERY_REQUIRED');
    try {
      process.kill(first.pid as number, 0);
      refuse('RECOVERY_REQUIRED');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }

    const intents = new Map<string, HostChildIntent>();
    const attaches = new Map<string, { pid: number; birth: string }>();
    const receipts: unknown[] = [];

    for (const row of rows.slice(1)) {
      if (row.type === 'child') {
        const item = object(row, ['type', 'name', 'nonce', 'role', 'labels']);
        if (
          typeof item.name !== 'string' ||
          !/^lw-pi-(?:tool-)?[a-f0-9]{32}$/.test(item.name) ||
          typeof item.nonce !== 'string' ||
          !/^[a-f0-9]{32}$/.test(item.nonce) ||
          (item.role !== 'sdk' && item.role !== 'tool')
        ) {
          refuse('RECOVERY_REQUIRED');
        }
        const labels = item.labels as Record<string, string>;
        if (
          !labels ||
          labels['org.loopwright.run'] !== view.runId ||
          labels['org.loopwright.nonce'] !== item.nonce ||
          labels['org.loopwright.generation'] !== String(authority.generation) ||
          intents.has(item.nonce)
        ) {
          refuse('RECOVERY_REQUIRED');
        }
        intents.set(item.nonce, item as unknown as HostChildIntent);
      } else if (row.type === 'attach') {
        object(row, ['type', 'nonce', 'pid', 'birth']);
        if (
          typeof row.nonce !== 'string' ||
          !intents.has(row.nonce) ||
          attaches.has(row.nonce) ||
          !Number.isSafeInteger(row.pid) ||
          (row.pid as number) < 1 ||
          typeof row.birth !== 'string' ||
          !row.birth
        ) {
          refuse('RECOVERY_REQUIRED');
        }
        attaches.set(row.nonce, { pid: row.pid as number, birth: row.birth });
      } else if (row.type === 'exit') {
        object(row, ['type', 'nonce']);
        if (typeof row.nonce !== 'string' || !intents.delete(row.nonce)) refuse('RECOVERY_REQUIRED');
        attaches.delete(row.nonce);
      } else {
        refuse('RECOVERY_REQUIRED');
      }
    }

    stateValue(this.host.store.renew(this.host.authority));

    for (const intent of intents.values()) {
      const attach = attaches.get(intent.nonce);
      if (!attach) {
        receipts.push({ name: intent.name, nonce: intent.nonce, absent: true, cli: null });
        continue;
      }
      const observed = await birth(attach.pid);
      if (observed !== null && observed !== attach.birth) {
        refuse('CLEANUP_FAILED');
      }
      if (observed === attach.birth) {
        killProcessGroup(attach.pid, true);
      } else if (observed === null) {
        killProcessGroup(attach.pid, false);
      }
      const deadline = performance.now() + 2000;
      for (;;) {
        const current = await birth(attach.pid);
        if (current === null) {
          try {
            process.kill(attach.pid, 0);
            refuse('RECOVERY_REQUIRED');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') refuse('RECOVERY_REQUIRED');
          }
          break;
        }
        if (current !== attach.birth || performance.now() >= deadline) refuse('CLEANUP_FAILED');
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
      }
      receipts.push({
        name: intent.name,
        nonce: intent.nonce,
        removed: true,
        cli: { pid: attach.pid, birth: attach.birth, deathConfirmed: true },
      });
    }

    const record = await open(
      join(this.host.artifactsDirectory, 'pi-recovery-' + first.token + '.json'),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await record.writeFile(JSON.stringify({
        version: 1,
        priorPid: first.pid,
        priorBirth: first.birth,
        boot: first.boot,
        deathConfirmed: true,
        receipts,
      }));
      await record.sync();
    } finally {
      await record.close();
    }

    const now = await lstat(this.path);
    if (now.ino !== inode || now.nlink !== 1) refuse('RECOVERY_REQUIRED');
    await unlink(this.path);
    await this.#syncParent();
  }

  register(intent: HostChildIntent): Promise<void> {
    const next = this.#tail.then(async () => {
      stateValue(this.host.store.renew(this.host.authority));
      if (this.#children.has(intent.nonce)) refuse('RECOVERY_REQUIRED');
      await this.#append({ type: 'child', ...intent });
      this.#children.set(intent.nonce, intent);
    });
    this.#tail = next.catch(() => {});
    return next;
  }

  attach(nonce: string, pid: number, allowAlreadyExited = false): Promise<void> {
    const next = this.#tail.then(async () => {
      if (!this.#children.has(nonce)) refuse('RECOVERY_REQUIRED');
      const born = await birth(pid);
      if (!born) {
        if (allowAlreadyExited) return;
        refuse('RECOVERY_REQUIRED');
      }
      await this.#append({ type: 'attach', nonce, pid, birth: born });
    });
    this.#tail = next.catch(() => {});
    return next;
  }

  exit(nonce: string): Promise<void> {
    const next = this.#tail.then(async () => {
      if (!this.#children.has(nonce)) refuse('RECOVERY_REQUIRED');
      await this.#append({ type: 'exit', nonce });
      this.#children.delete(nonce);
    });
    this.#tail = next.catch(() => {});
    return next;
  }

  release(): Promise<void> {
    return this.#releasing ??= this.#release();
  }

  async #release(): Promise<void> {
    await this.#tail;
    if (this.#released) return;
    if (this.#children.size || !this.#fd) refuse('CLEANUP_FAILED');
    const fdStat = await this.#fd.stat();
    const current = await lstat(this.path);
    if (current.ino !== fdStat.ino || current.nlink !== 1) refuse('RECOVERY_REQUIRED');
    await this.#fd.close();
    this.#fd = null;
    await unlink(this.path);
    await this.#syncParent();
    this.#released = true;
    hostLeases.delete(this.host);
  }
}

async function registerChild(host: PiHost, intent: HostChildIntent): Promise<void> {
  const lease = hostLeases.get(host);
  if (!lease) refuse('RECOVERY_REQUIRED');
  await lease.register(intent);
}

async function registerAttach(host: PiHost, nonce: string, pid: number | undefined, allowAlreadyExited = false): Promise<void> {
  const lease = hostLeases.get(host);
  if (!lease || !pid) refuse('RECOVERY_REQUIRED');
  await lease.attach(nonce, pid, allowAlreadyExited);
}

async function exitChild(host: PiHost, nonce: string): Promise<void> {
  const lease = hostLeases.get(host);
  if (!lease) refuse('RECOVERY_REQUIRED');
  await lease.exit(nonce);
}

function textResult(value: AgentToolResult<unknown>): ToolResult {
  return {
    content: value.content.map(block => {
      if (block.type !== 'text') refuse('TOOL_DENIED');
      return { type: 'text' as const, text: block.text };
    }),
    details: value.details ?? null,
    ...(value.isError ? { isError: true } : {}),
    ...(value.structuredContent === undefined ? {} : { structuredContent: value.structuredContent }),
  };
}

class HostToolProcess implements ToolProcessPort {
  readonly nonce = randomBytes(16).toString('hex');
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly #cancel = new AbortController();
  #bootWork: Promise<void> | null = null;
  #closing = false;
  #readyComplete = false;
  #used = false;
  #scratchDir = '';
  #tmpDir = '';
  #ownedRoot = '';
  #seatbeltProfile: string | null = null;
  #canonicalCandidate = '';
  #activeChild: ChildProcess | null = null;
  #activeExit: Promise<void> | null = null;
  #registeredChild = false;
  #exitCode = 0;
  #receipt: ContainerExit | null = null;
  #closedWork: Promise<ContainerExit | null> | null = null;
  readonly #onAbort: () => void;

  constructor(
    readonly host: PiHost,
    readonly input: PiOpenInput,
    readonly directory: string,
    readonly candidate: string,
    readonly operationId: string,
    readonly signal: AbortSignal,
  ) {
    this.name = 'lw-pi-tool-' + this.nonce;
    this.labels = Object.freeze({
      'org.loopwright.generation': String(host.authority.generation),
      'org.loopwright.run': input.lock.spec.runId,
      'org.loopwright.session': input.sessionId,
      'org.loopwright.nonce': this.nonce,
      'org.loopwright.role': 'tool',
      'org.loopwright.operation': operationId,
    });
    this.#onAbort = () => {
      this.#cancel.abort();
      const running = this.#activeChild !== null && this.#activeChild.exitCode === null && this.#activeChild.signalCode === null;
      killProcessGroup(this.#activeChild?.pid, running);
    };
    signal.addEventListener('abort', this.#onAbort, { once: true });
  }

  ready(): Promise<void> {
    if (this.#bootWork || this.#closing) refuse('SESSION_BUSY');
    const work = this.#boot();
    this.#bootWork = work;
    return work;
  }

  async #boot(): Promise<void> {
    this.signal.throwIfAborted();
    if (!isSupportedHostSessionPlatform(process.platform, process.arch) || !/^v26\./.test(process.version)) {
      refuse('RUNTIME_MISMATCH', '', { phase: 'tool' });
    }
    if (
      !sameIdentity(await profileIdentity(), this.input.policy.runtime.configDigest) ||
      !sameIdentity(digest(await readFile(resolveLockfileUrl())), this.input.policy.runtime.graphDigest)
    ) {
      refuse('RUNTIME_MISMATCH', '', { phase: 'tool' });
    }
    const resolvedCandidate = await realpath(this.candidate);
    if (resolvedCandidate !== resolve(this.candidate) || !(await stat(this.candidate)).isDirectory()) {
      refuse('CONTAINMENT_MISMATCH', '', { phase: 'tool' });
    }
    this.#canonicalCandidate = resolvedCandidate;
    this.#ownedRoot = await canonicalDirectory(this.host.directory);
    await mkdir(this.directory, { mode: 0o700 });
    const canonicalToolDir = await canonicalDirectory(this.directory);
    this.#scratchDir = join(canonicalToolDir, 'scratch');
    this.#tmpDir = join(canonicalToolDir, 'tmp');
    await mkdir(this.#scratchDir, { mode: 0o700 });
    await mkdir(this.#tmpDir, { mode: 0o700 });
    this.#seatbeltProfile = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')
      ? buildDarwinSeatbeltProfile(this.#scratchDir, this.#tmpDir)
      : null;
    this.#readyComplete = true;
  }

  async execute(
    name: 'read' | 'bash',
    bytes: Uint8Array,
    read: { readonly path: string; readonly digest: string } | null,
    guard: () => void,
  ): Promise<ToolProcessReply> {
    if (!this.#readyComplete || this.#closing || this.#used) refuse('RECOVERY_REQUIRED', '', { phase: 'tool' });
    this.#used = true;

    const fileBytes = integer(this.input.policy.limits.fileBytes, 1, 8388608);
    const resultBytes = integer(this.input.policy.limits.toolResultBytes, 1, 65536);
    const wallMs = integer(this.input.policy.limits.toolWallMs, 1, 10000);

    guard();

    let produced = 0;
    let overflow = false;
    let code: PiErrorCode | null = null;
    let rawResult: ToolResult;

    try {
      if (bytes.length > 65536) refuse('OUTPUT_LIMIT');
      const args = parseBoundedJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Record<string, unknown>;

      if (name === 'read') {
        if (
          typeof read?.path !== 'string' ||
          !read.path ||
          !/^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(read.path) ||
          read.path.split('/').some(part => part === '.' || part === '..')
        ) {
          refuse('TOOL_DENIED');
        }
        const expectedPath = join(this.#canonicalCandidate, read.path);
        const expectedDigest = read.digest;
        const check = async (targetPath: string) => {
          if (targetPath !== expectedPath) refuse('TOOL_DENIED');
          const info = await lstat(targetPath);
          if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > fileBytes) refuse('TOOL_DENIED');
        };
        const readTool = createReadTool(this.#canonicalCandidate, {
          autoResizeImages: false,
          operations: {
            access: check,
            detectImageMimeType: async () => null,
            readFile: async targetPath => {
              await check(targetPath);
              const fd = await open(targetPath, constants.O_RDONLY | constants.O_NOFOLLOW);
              try {
                const info = await fd.stat();
                if (!info.isFile() || info.nlink !== 1 || info.size > fileBytes) refuse('TOOL_DENIED');
                const buf = Buffer.alloc(info.size + 1);
                let offset = 0;
                while (offset < buf.length) {
                  const next = await fd.read(buf, offset, buf.length - offset, offset);
                  if (!next.bytesRead) break;
                  offset += next.bytesRead;
                }
                const data = buf.subarray(0, offset);
                if (offset !== info.size || digest(data).hex !== expectedDigest) refuse('RECOVERY_REQUIRED');
                new TextDecoder('utf-8', { fatal: true }).decode(data);
                return data;
              } finally {
                await fd.close();
              }
            },
          },
        });
        rawResult = textResult(await readTool.execute('owned-read', { ...args, path: read.path } as Parameters<typeof readTool.execute>[1], this.#cancel.signal));
      } else if (name === 'bash') {
        const candidateDir = this.#canonicalCandidate;
        const scratchDir = this.#scratchDir;
        const tmpDir = this.#tmpDir;
        const ownedRoot = this.#ownedRoot;
        const seatbeltProfile = this.#seatbeltProfile;
        const cleanEnv: NodeJS.ProcessEnv = {
          PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
          HOME: scratchDir,
          TMPDIR: tmpDir,
          LANG: 'C.UTF-8',
          LC_ALL: 'C.UTF-8',
          TERM: 'dumb',
        };
        const outputAbort = new AbortController();
        const bashTool = createBashTool(scratchDir, {
          exposeSessionEnvironment: false,
          shellPath: '/bin/bash',
          operations: {
            exec: async (command, cwd, options) => {
              if (cwd !== scratchDir) refuse('TOOL_DENIED');
              const timeoutMs = options.timeout && options.timeout > 0 ? Math.min(wallMs, options.timeout * 1000) : wallMs;
              const wallTimeout = AbortSignal.timeout(timeoutMs);
              const combined = AbortSignal.any([
                this.signal,
                this.#cancel.signal,
                outputAbort.signal,
                wallTimeout,
                ...(options.signal ? [options.signal] : []),
              ]);
              combined.throwIfAborted();

              const spawnSpec = buildHostToolBashSpawnSpec({
                candidateDir,
                scratchDir,
                tmpDir,
                ownedRoot,
                seatbeltProfile,
                command,
              });

              await registerChild(this.host, { name: this.name, nonce: this.nonce, role: 'tool', labels: this.labels });
              this.#registeredChild = true;

              const child = spawn(spawnSpec.executable, spawnSpec.args, {
                cwd: scratchDir,
                env: cleanEnv,
                detached: true,
                stdio: ['ignore', 'pipe', 'pipe'],
              });
              this.#activeChild = child;

              let resolveExit!: () => void;
              this.#activeExit = new Promise<void>(resolvePromise => { resolveExit = resolvePromise; });

              const onAbort = () => {
                killProcessGroup(child.pid, child.exitCode === null && child.signalCode === null);
              };
              combined.addEventListener('abort', onAbort, { once: true });
              if (combined.aborted) onAbort();

              if (child.pid && child.exitCode === null && child.signalCode === null) {
                await registerAttach(this.host, this.nonce, child.pid, true);
              }

              const onData = (chunk: Buffer) => {
                produced += chunk.length;
                if (produced > resultBytes) {
                  overflow = true;
                  outputAbort.abort();
                  killProcessGroup(child.pid, child.exitCode === null && child.signalCode === null);
                  return;
                }
                options.onData(chunk);
              };
              child.stdout.on('data', onData);
              child.stderr.on('data', onData);

              child.once('exit', () => {
                killProcessGroup(child.pid, false);
              });

              const exitCode = await new Promise<number | null>((resolveClose, rejectClose) => {
                child.once('error', err => {
                  resolveExit();
                  rejectClose(err);
                });
                child.once('close', exit => {
                  resolveExit();
                  resolveClose(exit);
                });
              }).finally(() => {
                combined.removeEventListener('abort', onAbort);
              });

              killProcessGroup(child.pid, false);

              if (overflow) refuse('OUTPUT_LIMIT');
              if (this.signal.aborted || this.#cancel.signal.aborted) refuse('CANCELLED');
              if (wallTimeout.aborted) refuse('CANCELLED');
              return { exitCode };
            },
          },
        });
        rawResult = textResult(await bashTool.execute('owned-bash', args as Parameters<typeof bashTool.execute>[1], this.#cancel.signal));
      } else {
        refuse('TOOL_DENIED');
      }

      if (overflow || Buffer.byteLength(canonical(rawResult)) > resultBytes || rawResult.content.some(item => item.type !== 'text')) {
        refuse('OUTPUT_LIMIT');
      }
    } catch (error) {
      if (error instanceof PiFailure && error.detail.code === 'CONTAINMENT_MISMATCH') {
        throw error;
      }
      code = overflow
        ? 'OUTPUT_LIMIT'
        : (this.signal.aborted || this.#cancel.signal.aborted)
          ? 'CANCELLED'
          : error instanceof PiFailure
            ? error.detail.code
            : 'TOOL_DENIED';
      rawResult = { content: [{ type: 'text', text: code }], isError: true, details: null };
    }

    if (code !== null && !['TOOL_DENIED', 'OUTPUT_LIMIT', 'CANCELLED', 'RECOVERY_REQUIRED'].includes(code)) {
      refuse('RECOVERY_REQUIRED', '', { phase: 'tool', effect: 'possible' });
    }
    const raw = rawResult as unknown as Record<string, unknown>;
    const keys = Object.keys(raw);
    if (
      !keys.includes('content') ||
      !keys.includes('details') ||
      keys.some(key => !['content', 'details', 'structuredContent', 'isError'].includes(key)) ||
      Buffer.byteLength(canonical(raw)) > resultBytes
    ) {
      refuse('OUTPUT_LIMIT', '', { phase: 'tool', effect: 'possible' });
    }
    const validated = object(raw, keys);
    if (validated.isError !== undefined && typeof validated.isError !== 'boolean') {
      refuse('RECOVERY_REQUIRED', '', { phase: 'tool', effect: 'possible' });
    }
    const content = list(validated.content, 16, '/content').map(item => {
      const block = object(item, ['type', 'text']);
      if (block.type !== 'text' || typeof block.text !== 'string') refuse('TOOL_DENIED', '', { phase: 'tool' });
      return { type: 'text' as const, text: block.text };
    });

    return {
      result: { ...validated, content, details: validated.details } as ToolResult,
      code,
      produced,
    };
  }

  close(): Promise<ContainerExit | null> {
    if (this.#receipt) return Promise.resolve(this.#receipt);
    if (this.#closedWork) return this.#closedWork;
    const work = this.#cleanup();
    this.#closedWork = work;
    void work.catch(() => { this.#closedWork = null; });
    return work;
  }

  async #cleanup(): Promise<ContainerExit | null> {
    this.#closing = true;
    this.signal.removeEventListener('abort', this.#onAbort);
    this.#cancel.abort();
    await this.#bootWork?.catch(() => {});
    if (this.#activeChild) {
      const running = this.#activeChild.exitCode === null && this.#activeChild.signalCode === null;
      killProcessGroup(this.#activeChild.pid, running);
    }
    if (this.#activeExit) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.#activeExit,
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Host tool process cleanup deadline')), 2000); }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      killProcessGroup(this.#activeChild?.pid, false);
    }
    if (this.#registeredChild) {
      await exitChild(this.host, this.nonce);
      this.#registeredChild = false;
    }
    if (!this.#readyComplete) return null;
    const receipt: ContainerExit = {
      id: digest(Buffer.from(this.nonce)).hex,
      exitCode: this.#exitCode,
      removed: true,
      cli: { code: this.#exitCode, signal: null },
    };
    await writeFile(join(this.directory, 'cleanup.json'), JSON.stringify(receipt), { mode: 0o600 });
    this.#receipt = receipt;
    return receipt;
  }
}

class HostExecution extends Execution {
  #gate: Promise<void> = Promise.resolve();

  constructor(host: PiHost, input: PiOpenInput, readonly candidateDir: string, ports: ExecutionPorts) {
    super(host, input, candidateDir, ports);
  }

  #extractTargetPath(identity: AdmittedToolIdentity, bytes: Uint8Array): string | null {
    if (!this.input.policy.tools.includes(identity.name)) return null;
    if (bytes.byteLength > this.input.policy.limits.toolArgsBytes) return null;
    try {
      const value = parseBoundedJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const args = object(value, Object.keys(value));
      if (typeof args.path !== 'string' || !args.path) return null;
      return this.candidate.normalize(args.path);
    } catch {
      return null;
    }
  }

  override invoke(
    identity: AdmittedToolIdentity,
    bytes: Uint8Array,
    signal: AbortSignal,
    onOperation: (id: string) => void,
  ): Promise<ToolResult> {
    if (identity.name !== 'write' && identity.name !== 'edit' && identity.name !== 'delete') {
      const plain = this.#gate.then(() => super.invoke(identity, bytes, signal, onOperation));
      this.#gate = plain.then(() => {}, () => {});
      return plain;
    }
    const mediated = this.#gate.then(async () => {
      const relPath = this.#extractTargetPath(identity, bytes);
      let writable = false;
      if (relPath !== null) {
        try {
          this.candidate.assertWritable(relPath);
          writable = true;
        } catch {
          writable = false;
        }
      }
      if (relPath === null || !writable) {
        return await super.invoke(identity, bytes, signal, onOperation);
      }

      const segments = relPath.split('/').slice(0, -1);
      const chain = [this.candidateDir, ...segments.map((_, index) => join(this.candidateDir, ...segments.slice(0, index + 1)))];
      const unlockedDirs: string[] = [];
      const absentBeforeOp = new Set<string>();
      let stoppedAtNonDir = false;
      let result!: ToolResult;
      let opFailed = false;
      let opError: unknown;
      this.candidate.clearLastPrunedDirectories();

      try {
        for (let i = 0; i < chain.length; i++) {
          const dir = chain[i]!;
          let info;
          try {
            info = await lstat(dir);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              if (i === 0) refuse('RECOVERY_REQUIRED', '/candidate', { phase: 'tool' });
              if (identity.name === 'write') {
                for (let j = i; j < chain.length; j++) absentBeforeOp.add(chain[j]!);
              }
              break;
            }
            throw error;
          }
          if (info.isSymbolicLink() || !info.isDirectory()) {
            if (i === 0) refuse('RECOVERY_REQUIRED', '/candidate', { phase: 'tool' });
            stoppedAtNonDir = true;
            break;
          }
          await chmod(dir, 0o755);
          unlockedDirs.push(dir);
        }
        result = await super.invoke(identity, bytes, signal, onOperation);
      } catch (error) {
        opFailed = true;
        opError = error;
      }

      const prunedDirs = this.candidate.consumeLastPrunedDirectories();
      const toRelock = [...unlockedDirs, ...(stoppedAtNonDir ? [] : absentBeforeOp)];
      let relockError: unknown = null;
      for (let i = toRelock.length - 1; i >= 0; i--) {
        const dir = toRelock[i]!;
        try {
          await chmod(dir, 0o555);
          const verified = await lstat(dir);
          if (!verified.isDirectory() || verified.isSymbolicLink() || (verified.mode & 0o777) !== 0o555) {
            relockError ??= new PiFailure({ code: 'RECOVERY_REQUIRED', path: '/candidate', phase: 'tool', retryable: false, effect: 'possible', requestId: null, operationId: null, stateErrorCode: null });
          }
        } catch (error) {
          const isAbsent = (error as NodeJS.ErrnoException).code === 'ENOENT';
          const tolerateAbsent = isAbsent && dir !== this.candidateDir && (
            (identity.name === 'delete' && prunedDirs.has(resolve(dir)))
            || (identity.name === 'write' && absentBeforeOp.has(dir))
          );
          if (tolerateAbsent) continue;
          relockError ??= new PiFailure({ code: 'RECOVERY_REQUIRED', path: '/candidate', phase: 'tool', retryable: false, effect: 'possible', requestId: null, operationId: null, stateErrorCode: null });
        }
      }
      if (opFailed && (relockError === null || (opError instanceof PiFailure && opError.detail.code === 'RECOVERY_REQUIRED'))) {
        throw opError;
      }
      if (relockError !== null) throw relockError;
      if (opFailed) throw opError;
      return result;
    });
    this.#gate = mediated.then(() => {}, () => {});
    return mediated;
  }
}

class HostMcpProcess extends EventEmitter implements McpProcessPort {
  #initialized = false;
  #readyState = false;
  #closed = false;
  #failed = false;
  #tail = Promise.resolve();
  #pending = 0;

  constructor(readonly input: PiOpenInput, readonly candidateDir: string) {
    super();
  }

  #fail(): void {
    if (!this.#closed && !this.#failed) {
      this.#failed = true;
      this.emit('failed');
    }
  }

  async ready(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.#closed || this.#failed) refuse('MCP_FAILED', '', { phase: 'tool' });
    if (!isSupportedHostSessionPlatform(process.platform, process.arch) || !/^v26\./.test(process.version)) {
      refuse('RUNTIME_MISMATCH', '', { phase: 'tool' });
    }
    if ((await realpath(this.candidateDir)) !== resolve(this.candidateDir) || !(await stat(this.candidateDir)).isDirectory()) {
      refuse('CONTAINMENT_MISMATCH', '', { phase: 'tool' });
    }
  }

  async send(message: JsonRpcMessage, guard: () => void): Promise<void> {
    if (this.#closed || this.#failed || this.#pending >= 32) refuse('MCP_FAILED', '', { phase: 'tool' });
    const serialized = canonical(message) + '\n';
    if (Buffer.byteLength(serialized) > 65536) refuse('OUTPUT_LIMIT', '', { phase: 'tool' });
    this.#pending++;
    const work = this.#tail.then(async () => {
      if (this.#closed || this.#failed) refuse('MCP_FAILED', '', { phase: 'tool' });
      guard();
      await this.#dispatch(message);
    });
    this.#tail = work.catch(() => { this.#fail(); });
    try {
      await work;
    } finally {
      this.#pending--;
    }
  }

  async #dispatch(value: JsonRpcMessage): Promise<void> {
    if (!('method' in value)) {
      this.#fail();
      return;
    }
    if (!('id' in value)) {
      if (value.method === 'notifications/initialized' && this.#initialized) {
        this.#readyState = true;
      } else if (value.method !== 'notifications/cancelled') {
        this.#fail();
      }
      return;
    }

    const emitReply = (payload: JsonRpcMessage) => {
      const bytes = Buffer.byteLength(canonical(payload)) + 1;
      if (bytes > 65536) {
        this.#fail();
        return;
      }
      queueMicrotask(() => {
        if (!this.#closed && !this.#failed) this.emit('message', payload);
      });
    };

    if (value.method === 'initialize' && !this.#initialized) {
      this.#initialized = true;
      emitReply({
        jsonrpc: '2.0',
        id: value.id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'loopwright-workspace', version: '1' },
        },
      });
      return;
    }
    if (!this.#readyState) {
      this.#fail();
      return;
    }
    if (value.method === 'tools/list') {
      emitReply({ jsonrpc: '2.0', id: value.id, result: { tools: [WORKSPACE_TOOL] } });
      return;
    }
    if (value.method !== 'tools/call') {
      emitReply({ jsonrpc: '2.0', id: value.id, error: { code: -32601, message: 'MCP_FAILED' } });
      return;
    }

    let result: unknown;
    try {
      const keys = Object.keys(value.params ?? {});
      const params = object(value.params, keys);
      if (keys.some(k => !['name', 'arguments', '_meta'].includes(k)) || params.name !== 'read_file') {
        refuse('TOOL_DENIED', '', { phase: 'tool' });
      }
      const args = object(params.arguments, ['path']);
      if (typeof args.path !== 'string') refuse('TOOL_DENIED', '', { phase: 'tool' });
      result = { content: [{ type: 'text', text: await readWorkspace(this.candidateDir, args.path, 65536) }] };
      if (Buffer.byteLength(canonical({ jsonrpc: '2.0', id: value.id, result })) + 1 > 65536) {
        refuse('OUTPUT_LIMIT', '', { phase: 'tool' });
      }
    } catch (error) {
      const code = error instanceof PiFailure ? error.detail.code : 'MCP_FAILED';
      result = { isError: true, content: [{ type: 'text', text: code }] };
    }
    emitReply({ jsonrpc: '2.0', id: value.id, result } as JsonRpcMessage);
  }

  async close(): Promise<ContainerExit | null> {
    this.#closed = true;
    await this.#tail.catch(() => {});
    return null;
  }
}

class HostRuntimeSession {
  readonly nonce = randomBytes(16).toString('hex');
  readonly name = 'lw-pi-' + this.nonce;
  #process: ChildProcessWithoutNullStreams | null = null;
  #channel: Channel | null = null;
  #snapshots: SnapshotTransfer | null = null;
  #bootWork: Promise<PiCapabilities> | null = null;
  #creationAttempted = false;
  #closing: Promise<void> | null = null;
  #exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null;
  #closed = false;
  #cleanupComplete = false;
  #failed = false;
  #pending: { kind: string; resolve: (value: unknown) => void; reject: (error: Error) => void } | null = null;

  constructor(
    readonly host: PiHost,
    readonly input: PiOpenInput,
    readonly broker: RuntimeBroker,
    readonly directory: string,
  ) {}

  start(): Promise<PiCapabilities> {
    if (this.#bootWork || this.#closed) refuse('SESSION_BUSY');
    const work = this.#boot();
    this.#bootWork = work;
    return work.catch(async error => {
      await this.close();
      throw error;
    });
  }

  async #boot(): Promise<PiCapabilities> {
    if (!isSupportedHostSessionPlatform(process.platform, process.arch)) {
      refuse('RUNTIME_UNSUPPORTED', '/host/runtime');
    }
    if (!/^v26\./.test(process.version)) {
      refuse('RUNTIME_MISMATCH', '/host/runtime');
    }
    if (!sameIdentity(await profileIdentity(), this.input.policy.runtime.configDigest)) {
      refuse('RUNTIME_MISMATCH', '/policy/runtime/configDigest');
    }
    const lockBytes = await readFile(resolveLockfileUrl());
    if (!sameIdentity(digest(lockBytes), this.input.policy.runtime.graphDigest)) {
      refuse('RUNTIME_MISMATCH', '/policy/runtime/graphDigest');
    }

    await mkdir(this.directory, { mode: 0o700 });
    const canonicalDir = await realpath(this.directory);
    const homeDir = join(canonicalDir, 'home');
    const tmpDir = join(canonicalDir, 'tmp');
    await mkdir(homeDir, { mode: 0o700 });
    await mkdir(tmpDir, { mode: 0o700 });
    const candidateDir = join(this.directory, 'candidate');
    await materializeCandidateDirectory(candidateDir, this.input);

    const labels = Object.freeze({
      'org.loopwright.generation': String(this.host.authority.generation),
      'org.loopwright.run': this.input.lock.spec.runId,
      'org.loopwright.session': this.input.sessionId,
      'org.loopwright.nonce': this.nonce,
    });
    await writeFile(
      join(this.directory, 'process-intent.json'),
      JSON.stringify({ version: 1, name: this.name, nonce: this.nonce, labels }),
      { flag: 'wx', mode: 0o600 },
    );
    await registerChild(this.host, { name: this.name, nonce: this.nonce, role: 'sdk', labels });
    this.#creationAttempted = true;
    if (this.#closed) refuse('CANCELLED');

    const workerScript = fileURLToPath(new URL('./sdk-worker.js', import.meta.url));
    const child = spawn(process.execPath, [workerScript, this.nonce], {
      cwd: canonicalDir,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        HOME: homeDir,
        TMPDIR: tmpDir,
        PI_OFFLINE: '1',
        LOOPWRIGHT_HOST_SESSION: '1',
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        TERM: 'dumb',
      },
    });
    this.#process = child;
    this.#exited = new Promise(resolvePromise => {
      child.once('exit', (code, signal) => resolvePromise({ code, signal }));
      child.once('error', () => {
        this.#fail();
        resolvePromise({ code: null, signal: null });
      });
    });

    const diagnosticLimit = this.input.policy.limits.diagnosticBytes;
    const retainedLimit = Math.floor((diagnosticLimit - 64) * 3 / 4);
    let stderrBytes = 0;
    let retained = Buffer.alloc(0);
    child.stderr.on('data', (data: Buffer) => {
      stderrBytes += data.length;
      const keep = Math.min(data.length, Math.max(0, retainedLimit - retained.length));
      if (keep) retained = Buffer.concat([retained, data.subarray(0, keep)]);
      try {
        if (this.input.policy.privateArtifacts) {
          writeFileSync(
            join(this.directory, 'private-sdk-stderr'),
            JSON.stringify({ encoding: 'base64', truncated: stderrBytes > retained.length, data: retained.toString('base64') }) + '\n',
            { mode: 0o600 },
          );
        }
      } catch {
        this.#fail();
      }
      if (stderrBytes > diagnosticLimit) {
        this.broker.runtimeFault?.('OUTPUT_LIMIT');
        this.#fail();
      }
    });

    this.#channel = new Channel(this.nonce, child.stdout, child.stdin);
    this.#snapshots = new SnapshotTransfer(this.#channel);
    this.#channel.on('failed', () => this.#fail());
    this.#channel.on('message', (message: ChannelMessage) => {
      void this.#receive(message).catch(() => this.#fail());
    });
    await registerAttach(this.host, this.nonce, child.pid);

    const restored = recoverSnapshot(this.host, this.input);
    if (restored) {
      const accepted = this.#wait('restore-ready');
      await this.#channel.send('restore-start', {
        selection: this.input.policy.selection,
        toolNames: this.input.policy.tools,
        sessionBytes: this.input.policy.limits.sessionBytes,
      });
      await accepted;
      async function* chunks() {
        yield restored!.native;
      }
      const complete = this.#wait('restore-complete', 90000);
      await this.#snapshots.send(1, chunks(), this.input.policy.limits.sessionBytes);
      await complete;
    }

    const ready = this.#wait('ready');
    const [, response] = await Promise.all([
      this.#channel.send('init', {
        selection: this.input.policy.selection,
        systemPrompt: systemPrompt(this.input),
        toolNames: this.input.policy.tools,
        mcp: this.input.policy.mcp,
        toolResultBytes: this.input.policy.limits.toolResultBytes,
        sessionBytes: this.input.policy.limits.sessionBytes,
        outputTokens: Math.min(
          this.input.lock.spec.contract.spec.budgets.perCallOutputTokens,
          this.input.policy.context.maxOutputTokens,
        ),
      }),
      ready,
    ]);

    const facts = response as {
      selection: unknown;
      thinkingLevel: unknown;
      node: unknown;
      platform: unknown;
      architecture: unknown;
    };
    if (
      !sameIdentity(facts.selection, this.input.policy.selection) ||
      facts.thinkingLevel !== this.input.policy.selection.thinking ||
      !/^v26\./.test(process.version) ||
      facts.node !== process.version ||
      typeof facts.platform !== 'string' ||
      typeof facts.architecture !== 'string' ||
      !isSupportedHostSessionPlatform(facts.platform, facts.architecture)
    ) {
      refuse('RUNTIME_MISMATCH');
    }

    return freeze({
      version: 1,
      policyDigest: digest(Buffer.from(canonical(this.input.policy))),
      runtime: this.input.policy.runtime,
      requested: this.input.policy.selection,
      catalogSupported: structuredClone(this.input.policy.selection),
      sessionEffective: structuredClone(this.input.policy.selection),
      outboundObserved: null,
      resources: this.input.policy.resources,
      accounting: 'soft_only',
      contextFit: 'unproven',
      defaultMode: 'proven_bound',
      liveProvenBoundAvailable: false,
      optInMode: 'estimated_guard',
      contextEstimator: { id: 'lw-pi-final-json-bytes-v1', version: 1, provenance: 'estimated' },
      toolExecution: { candidate: 'read_only', candidateWrites: 'mediated', scratch: 'per_call' },
    });
  }

  #wait(kind: string, timeoutMs = 10000, remaining?: () => number | null): Promise<unknown> {
    if (this.#pending) refuse('SESSION_BUSY', '', { phase: 'session' });
    if (this.#failed) refuse('RECOVERY_REQUIRED', '', { phase: 'session' });
    return new Promise((resolvePromise, rejectPromise) => {
      let stop = () => {};
      const expires = performance.now() + timeoutMs;
      this.#pending = {
        kind,
        resolve: value => {
          stop();
          this.#pending = null;
          resolvePromise(value);
        },
        reject: error => {
          stop();
          this.#pending = null;
          rejectPromise(error);
        },
      };
      stop = scheduleDeadline(
        remaining ?? (() => expires - performance.now()),
        () => {
          this.#pending = null;
          rejectPromise(new PiFailure({
            code: 'DEADLINE',
            path: '',
            phase: 'session',
            retryable: false,
            effect: 'possible',
            requestId: null,
            operationId: null,
            stateErrorCode: null,
          }));
          this.#fail();
        },
      );
    });
  }

  async #receive(message: ChannelMessage): Promise<void> {
    if (this.#closed) throw new Error('Closed SDK channel');
    if (await this.#snapshots!.receive(message)) return;
    if (await receiveBrokerMessage(this.#channel!, this.broker, message)) return;
    if (message.kind === 'refused') {
      this.#snapshots?.close();
      const body = message.body as { code?: string };
      const code = body.code === 'MODEL_UNAVAILABLE' || body.code === 'THINKING_UNSUPPORTED'
        ? body.code
        : 'PROVIDER_RESPONSE_INVALID';
      this.#pending?.reject(new PiFailure({
        code,
        path: '/policy/selection',
        phase: 'session',
        retryable: false,
        effect: 'none',
        requestId: null,
        operationId: null,
        stateErrorCode: null,
      }));
      return;
    }
    if (!this.#pending || message.kind !== this.#pending.kind) throw new Error('Unrequested SDK result');
    this.#pending.resolve(message.body);
  }

  #fail(): void {
    if (!this.#closed) {
      this.#failed = true;
      this.#snapshots?.close();
      this.#pending?.reject(new Error('SDK channel failed'));
    }
  }

  async command(kind: 'execute' | 'compact', body: unknown): Promise<unknown> {
    if (this.#closed || !this.#channel) refuse('CANCELLED', '', { phase: 'session' });
    const view = stateValue(this.host.store.inspect(), 'session');
    const remaining = view.clock.remainingTaskMs.safeValue;
    if (remaining === null || remaining <= 0) refuse('DEADLINE', '', { phase: 'session' });
    const pending = this.#wait('settled', undefined, () => {
      const current = this.host.store.inspect();
      return current.ok && current.value.clockStatus === 'trusted' ? current.value.clock.remainingTaskMs.safeValue : null;
    });
    const [, response] = await Promise.all([this.#channel.send(kind, body), pending]);
    verifyNativeCompletion((response as { native?: unknown }).native, kind);
    return response;
  }

  async capture(sink: (bytes: Uint8Array) => Promise<void>): Promise<void> {
    if (this.#closed || !this.#channel || !this.#snapshots) refuse('CANCELLED');
    const view = stateValue(this.host.store.inspect(), 'restore');
    const remaining = view.clock.remainingTaskMs.safeValue;
    if (remaining === null || remaining <= 0) refuse('DEADLINE');
    const expected = this.#snapshots.expect(sink, this.input.policy.limits.sessionBytes, Math.min(90000, remaining));
    try {
      await this.#channel.send('capture', { query: expected.query });
      await expected.done;
    } catch (error) {
      this.#snapshots.close();
      if (error instanceof PiFailure && error.detail.code !== 'INPUT_INVALID') throw error;
      refuse('RECOVERY_REQUIRED', '', { phase: 'restore' });
    }
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    const attempt = this.#cleanup();
    this.#closing = attempt;
    void attempt.then(() => { this.#closing = null; }, () => { this.#closing = null; });
    return attempt;
  }

  async #cleanup(): Promise<void> {
    if (this.#cleanupComplete) return;
    this.#closed = true;
    this.#snapshots?.close();
    this.#pending?.reject(new Error('closed'));
    await this.#bootWork?.catch(() => {});

    let leaderExited = false;
    try {
      if (this.#channel) {
        try { await this.#channel.send('close', null); } catch { /* process-group cleanup follows */ }
        this.#channel.close();
      }
      if (this.#exited && this.#process && this.#process.exitCode === null && this.#process.signalCode === null) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([this.#exited, new Promise(resolvePromise => { timer = setTimeout(resolvePromise, 500); })]);
        } finally {
          clearTimeout(timer);
        }
      }
      leaderExited = this.#process !== null && (this.#process.exitCode !== null || this.#process.signalCode !== null);
      if (!this.#creationAttempted) {
        if (existsSync(join(this.directory, 'candidate'))) {
          await setDirectoryTreeMode(join(this.directory, 'candidate'), 0o755).catch(() => {});
        }
        this.#cleanupComplete = true;
        return;
      }
    } finally {
      const exitedNow = leaderExited || (this.#process !== null && (this.#process.exitCode !== null || this.#process.signalCode !== null));
      killProcessGroup(this.#process?.pid, !exitedNow);
      this.#process?.stdin.destroy();
      this.#process?.stdout.destroy();
      this.#process?.stderr.destroy();
    }

    let exit: { code: number | null; signal: NodeJS.Signals | null } = { code: null, signal: null };
    if (this.#exited) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        exit = await Promise.race([
          this.#exited,
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Host SDK worker cleanup deadline')), 2000); }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      killProcessGroup(this.#process?.pid, false);
    }

    if (existsSync(join(this.directory, 'candidate'))) {
      await setDirectoryTreeMode(join(this.directory, 'candidate'), 0o755).catch(() => {});
    }

    await writeFile(
      join(this.directory, 'cleanup.json'),
      JSON.stringify({
        id: digest(Buffer.from(this.nonce)).hex,
        nonce: this.nonce,
        pid: this.#process?.pid ?? null,
        removed: true,
        absenceConfirmed: true,
        state: exit,
      }),
      { mode: 0o600 },
    );
    await writeFile(join(this.directory, 'cli-exit.json'), JSON.stringify(exit), { mode: 0o600 });
    await exitChild(this.host, this.nonce);
    this.#cleanupComplete = true;
  }
}

async function environment(host: PiHost): Promise<void> {
  if (!isSupportedHostSessionPlatform(process.platform, process.arch)) {
    refuse('RUNTIME_UNSUPPORTED', '/host/runtime');
  }
  try {
    await canonicalDirectory(host.directory);
    await canonicalDirectory(host.artifactsDirectory);
  } catch {
    refuse('CONTAINMENT_UNAVAILABLE');
  }
}

const hostSessionPorts: FactoryPorts = Object.freeze<FactoryPorts>({
  environment,
  lease: (host, input) => HostExecutionLease.acquire(host, input),
  execution: (host, owned, candidateDir) => new HostExecution(host, owned, candidateDir, {
    process: (operationId, signal) => new HostToolProcess(
      host,
      owned,
      join(host.directory, 'tool-' + operationId),
      candidateDir,
      operationId,
      signal,
    ),
  }),
  mcp: (host, owned) => ({
    process: () => new HostMcpProcess(owned, join(host.directory, 'sdk-' + owned.sessionId, 'candidate')),
  }),
  session: (host, owned, sender, directory) => new HostRuntimeSession(host, owned, sender, directory),
});

export function openPiHostSessionAdapter(
  host: PiHost,
  input: unknown,
): Promise<PiResult<PiAdapter>> {
  return constructAdapter(host, input, hostSessionPorts);
}

export function openPiHostSessionAdapterV2(
  host: PiHostV2,
  input: PiOpenInputV2,
): Promise<PiResultV2<PiAdapterV2>> {
  return constructAdapterV2(host, input, hostSessionPorts);
}
