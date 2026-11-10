import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultCorpusRoot, verifyFrozenCorpus } from './corpus.js';
import { RunnerTaskpackError } from './types.js';

export const MAX_STREAM_BYTES = 1048576;
export const DEFAULT_TIMEOUT_MS = 60000;
export const FROZEN_SUITE_TIMEOUT_MS = 300000;
export const DEFAULT_PATH_ALLOWLIST = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';
export const FROZEN_MODULES = [
  'tools.auto_sync.discovery', 'tools.auto_sync.proposal', 'tools.auto_sync.assemble', 'tools.auto_sync.check_draft',
  'tools.auto_sync.checks', 'tools.auto_sync.publish', 'tools.auto_sync.summary', 'tools.auto_sync.agent',
  'tools.auto_sync.model', 'tools.auto_sync.progress',
] as const;
export const SITE_GUARD_CODE = `import ipaddress
import socket
import sys
import _socket

_original_connect = socket.socket.connect
_original_connect_ex = socket.socket.connect_ex


def _is_loopback_host(host):
    if isinstance(host, (bytes, bytearray)):
        try:
            host = bytes(host).decode("utf-8", "strict")
        except Exception:
            return False
    if not isinstance(host, str):
        return False
    normalized = host.strip("[]").lower()
    if normalized == "localhost":
        return True
    try:
        return ipaddress.ip_address(normalized.split("%")[0]).is_loopback
    except ValueError:
        return False


def _check_address(address, event="socket.connect"):
    if isinstance(address, tuple) and len(address) >= 1:
        if not _is_loopback_host(address[0]):
            raise PermissionError(77, "non-loopback %s blocked by the contained runner bridge: %r" % (event, address[0]))
    elif address is not None:
        raise PermissionError(77, "non-inet %s blocked by the contained runner bridge: %r" % (event, address))


def _guard(event, args):
    if event in ("socket.connect", "socket.sendto", "socket.sendmsg"):
        address = args[1] if len(args) > 1 else None
        _check_address(address, event)
    elif event in ("socket.getaddrinfo", "socket.gethostbyname", "socket.gethostbyname_ex", "socket.gethostbyaddr"):
        host = args[0] if len(args) > 0 else None
        if not _is_loopback_host(host):
            raise PermissionError(77, "non-loopback dns lookup blocked by the contained runner bridge: %r" % (host,))


sys.addaudithook(_guard)


def _loopback_only_connect(self, address, *args, **kwargs):
    _check_address(address, "socket.connect")
    return _original_connect(self, address, *args, **kwargs)


def _loopback_only_connect_ex(self, address, *args, **kwargs):
    _check_address(address, "socket.connect_ex")
    return _original_connect_ex(self, address, *args, **kwargs)


socket.socket.connect = _loopback_only_connect
socket.socket.connect_ex = _loopback_only_connect_ex
`;

export interface PythonBridgeOptions {
  readonly pythonExecutable?: string;
  readonly pathAllowlist?: string;
  readonly defaultTimeoutMs?: number;
}

export interface PythonRunOptions {
  readonly timeoutMs?: number;
  readonly cwd?: string;
  readonly stdin?: string;
  readonly maxOutputBytes?: number;
}

export interface PythonRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly timedOut: boolean;
}

export interface PythonPreflight {
  readonly pythonExecutable: string;
  readonly version: string;
  readonly modules: readonly string[];
}

export interface FrozenUnitCheckResult {
  readonly runner: 'pytest' | 'self-checks';
  readonly passed: boolean;
  readonly exitCode: number;
  readonly summary: string;
}

interface ContainedOutcome { stdout: string; stderr: string; exitCode: number; durationMs: number; timedOut: boolean }

function pythonUnavailable(detail: string, cause?: unknown): RunnerTaskpackError {
  return new RunnerTaskpackError('PYTHON_UNAVAILABLE', `python interpreter prerequisite failed: ${detail}${cause instanceof Error ? ` (${cause.message})` : ''}`);
}

const PRELUDE_CODE = `import importlib.util, json, platform
print(json.dumps({"version": platform.python_version(), "modules": [name for name in ("packaging", "yaml", "requests") if importlib.util.find_spec(name) is not None]}))`;

const PYTEST_PROBE_CODE = `import importlib.util, json
print(json.dumps({"pytest": importlib.util.find_spec("pytest") is not None}))`;

const SELF_CHECK_CODE = `import importlib, json, sys
config = json.loads(sys.stdin.read())
sys.path.insert(0, config["vendorRoot"])
imported, failed = [], []
for name in config["modules"]:
    try:
        importlib.import_module(name)
        imported.append(name)
    except Exception as error:
        failed.append({"module": name, "error": "%s: %s" % (type(error).__name__, error)})
print(json.dumps({"imported": imported, "failed": failed}))`;

function minorVersionAtLeast(version: string, major: number, minor: number): boolean {
  const parts = version.split('.').map(part => Number.parseInt(part, 10));
  if (!Number.isInteger(parts[0]) || !Number.isInteger(parts[1])) return false;
  return parts[0]! > major || (parts[0] === major && parts[1]! >= minor);
}

const AUTO_CANDIDATES = ['python3', 'python3.11', 'python3.12', 'python3.10', 'python3.13'] as const;

/**
 * Contained runner for frozen Python helpers: sanitized environment (private HOME, pinned git settings,
 * allowlisted PATH), a sitecustomize socket guard that permits loopback only, bounded streams, and hard timeouts.
 */
export class PythonBridge {
  readonly #configuredExecutable: string | null;
  readonly #pathAllowlist: string;
  readonly #defaultTimeoutMs: number;
  #interpreter: Promise<{ readonly executable: string; readonly version: string; readonly modules: readonly string[] }> | null = null;
  #scratch: Promise<string> | null = null;
  #disposed = false;

  constructor(options: PythonBridgeOptions = {}) {
    const configured = options.pythonExecutable ?? process.env.RUNNER_TASKPACK_PYTHON ?? null;
    if (configured !== null && configured.includes('/') && !configured.startsWith('/')) throw pythonUnavailable('configured pythonExecutable must be an absolute path or a bare PATH name');
    this.#configuredExecutable = configured;
    this.#pathAllowlist = options.pathAllowlist ?? DEFAULT_PATH_ALLOWLIST;
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Private per-bridge scratch tree holding the socket guard and serving as HOME. */
  #scratchDirectory(): Promise<string> {
    if (this.#disposed) throw pythonUnavailable('bridge has been disposed');
    this.#scratch ??= (async () => {
      const root = await mkdtemp(join(await (await import('node:fs/promises')).realpath(tmpdir()), 'taskpack-python-'));
      await chmod(root, 0o700);
      const guard = join(root, 'siteguard');
      await mkdir(guard, { mode: 0o700 });
      await writeFile(join(guard, 'sitecustomize.py'), SITE_GUARD_CODE, { mode: 0o600 });
      return root;
    })();
    return this.#scratch;
  }

  async #environment(): Promise<Record<string, string>> {
    const scratch = await this.#scratchDirectory();
    return {
      HOME: scratch,
      PATH: this.#pathAllowlist,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/usr/bin/false',
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONPATH: join(scratch, 'siteguard'),
    };
  }

  /** Resolve a bare interpreter name to a validated executable file against the parent process PATH (never the contained PATH). */
  async #resolveOnParentPath(name: string): Promise<string | null> {
    if (name.startsWith('/')) return name;
    const directories = (process.env.PATH ?? '').split(':').filter(part => part.length > 0);
    for (const directory of directories) {
      const candidate = join(directory, name);
      if (await this.#validatedExecutable(candidate)) return candidate;
    }
    return null;
  }

  /** A candidate must be a regular executable file after resolving symlinks; anything else is skipped. */
  async #validatedExecutable(candidate: string): Promise<boolean> {
    const fs = await import('node:fs/promises');
    try {
      const real = await fs.realpath(candidate);
      const stats = await fs.stat(real);
      return stats.isFile() && (stats.mode & 0o111) !== 0;
    } catch { return false; }
  }

  /** Pick and memoize the interpreter: explicit configuration is authoritative, otherwise scan candidates by preflight. */
  #resolvedInterpreter(): Promise<{ readonly executable: string; readonly version: string; readonly modules: readonly string[] }> {
    if (this.#disposed) throw pythonUnavailable('bridge has been disposed');
    this.#interpreter ??= (async () => {
      const candidates: readonly string[] = this.#configuredExecutable !== null ? [this.#configuredExecutable] : AUTO_CANDIDATES;
      const failures: string[] = [];
      for (const candidate of candidates) {
        const executable = await this.#resolveOnParentPath(candidate);
        if (executable === null) { failures.push(`${candidate}: not found`); continue; }
        try {
          const outcome = await this.#contained(executable, ['-B', '-c', PRELUDE_CODE], { timeoutMs: Math.min(this.#defaultTimeoutMs, 30000) });
          if (outcome.timedOut) { failures.push(`${candidate}: probe timed out`); continue; }
          if (outcome.exitCode !== 0) { failures.push(`${candidate}: probe exited ${outcome.exitCode}`); continue; }
          let probe: { version?: unknown; modules?: unknown };
          try { probe = JSON.parse(outcome.stdout) as typeof probe; } catch { failures.push(`${candidate}: unreadable probe output`); continue; }
          if (typeof probe.version !== 'string' || !minorVersionAtLeast(probe.version, 3, 10)) { failures.push(`${candidate}: python >= 3.10 required, found ${String(probe.version)}`); continue; }
          if (!Array.isArray(probe.modules)) { failures.push(`${candidate}: probe omitted module inventory`); continue; }
          const modules: string[] = [];
          for (const required of ['packaging', 'yaml', 'requests']) {
            if (!probe.modules.includes(required)) { failures.push(`${candidate}: required site package ${required} is missing`); break; }
            modules.push(required);
          }
          if (modules.length < 3) continue;
          return { executable, version: probe.version, modules };
        } catch (error) {
          if (error instanceof RunnerTaskpackError && (error.code === 'PYTHON_BOUNDARY' || error.code === 'PYTHON_TIMEOUT')) { failures.push(`${candidate}: ${error.message}`); continue; }
          throw error;
        }
      }
      throw pythonUnavailable(`no candidate interpreter satisfies python >= 3.10 with packaging, yaml, and requests (${failures.join('; ')})`);
    })();
    return this.#interpreter;
  }

  /** One contained child; non-zero exits are normal results, infrastructure faults throw typed errors. */
  async #contained(executable: string, argv: readonly string[], options: PythonRunOptions): Promise<ContainedOutcome> {
    if (options.stdin !== undefined && Buffer.byteLength(options.stdin, 'utf8') > (options.maxOutputBytes ?? MAX_STREAM_BYTES)) {
      throw new RunnerTaskpackError('PYTHON_BOUNDARY', 'python helper stdin exceeded the bounded stream size');
    }
    const environment = await this.#environment();
    const timeoutMs = options.timeoutMs ?? this.#defaultTimeoutMs;
    const maximum = options.maxOutputBytes ?? MAX_STREAM_BYTES;
    const started = performance.now();
    return await new Promise<ContainedOutcome>((resolve, reject) => {
      const child = spawn(executable, [...argv], { env: environment, cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      const killGroup = (signal: NodeJS.Signals): void => {
        try { if (child.pid !== undefined) process.kill(-child.pid, signal); } catch { child.kill(signal); }
      };
      const chunks: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] };
      const sizes: { stdout: number; stderr: number } = { stdout: 0, stderr: 0 };
      let settled = false, timedOut = false, bounded = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup('SIGTERM');
        setTimeout(() => { if (!settled) killGroup('SIGKILL'); }, 250);
      }, timeoutMs);
      const finish = (failure?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (failure !== undefined) return reject(failure);
        const decode = (parts: Buffer[]): string => Buffer.concat(parts).toString('utf8');
        resolve({
          stdout: decode(chunks.stdout), stderr: decode(chunks.stderr),
          exitCode: child.exitCode ?? -1, durationMs: Math.ceil(performance.now() - started), timedOut,
        });
      };
      child.on('error', error => {
        const failure = error as NodeJS.ErrnoException;
        if (failure.code === 'ENOENT' || failure.code === 'EACCES') finish(pythonUnavailable(`interpreter ${executable} is not executable`, error));
        else finish(new RunnerTaskpackError('PYTHON_BOUNDARY', `python helper failed to start: ${failure.message}`));
      });
      const collect = (channel: 'stdout' | 'stderr', chunk: Buffer): void => {
        sizes[channel] += chunk.byteLength;
        if (sizes[channel] > maximum) {
          if (!bounded) {
          bounded = true;
          killGroup('SIGTERM');
          setTimeout(() => { if (!settled) killGroup('SIGKILL'); }, 250);
          finish(new RunnerTaskpackError('PYTHON_BOUNDARY', 'python helper output exceeded the bounded stream size'));
        }
          return;
        }
        chunks[channel].push(chunk);
      };
      child.stdout.on('data', chunk => collect('stdout', chunk));
      child.stderr.on('data', chunk => collect('stderr', chunk));
      if (options.stdin !== undefined) child.stdin.end(options.stdin); else child.stdin.end();
      child.on('close', () => {
        if (timedOut) return finish(new RunnerTaskpackError('PYTHON_TIMEOUT', `python helper exceeded its ${timeoutMs}ms budget`));
        if (bounded) return;
        finish();
      });
    });
  }

  /** Run one Python snippet under the contained environment; non-zero exits are results, not bridge faults. */
  async run(code: string, options: PythonRunOptions = {}): Promise<PythonRunResult> {
    const { executable } = await this.#resolvedInterpreter();
    return await this.#contained(executable, ['-B', '-c', code], options);
  }

  /** Spawn a resident helper (e.g. the loopback GitHub service double) under the same contained environment. */
  async residentSpawn(argv: readonly string[], options: { readonly cwd?: string; readonly stdin?: string } = {}): Promise<import('node:child_process').ChildProcess> {
    if (this.#disposed) throw pythonUnavailable('bridge has been disposed');
    const { executable } = await this.#resolvedInterpreter();
    const child = spawn(executable, ['-B', ...argv], { env: await this.#environment(), cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    if (options.stdin !== undefined) child.stdin.end(options.stdin); else child.stdin.end();
    return child;
  }

  /** Verify interpreter presence, version floor, and site-package prerequisites before any domain helper runs. */
  async preflight(): Promise<PythonPreflight> {
    const resolved = await this.#resolvedInterpreter();
    return { pythonExecutable: resolved.executable, version: resolved.version, modules: resolved.modules };
  }

  /** Execute the vendored frozen unit checks: full pytest when available, module self-checks on stock Python otherwise. */
  async runFrozenUnitChecks(options: { readonly corpusRoot?: string; readonly timeoutMs?: number } = {}): Promise<FrozenUnitCheckResult> {
    const resolved = options.corpusRoot ?? defaultCorpusRoot();
    if (resolved === null) throw new RunnerTaskpackError('CORPUS_UNAVAILABLE', 'vendored frozen corpus directory is absent');
    const verification = await verifyFrozenCorpus(resolved);
    const root = verification.root;
    const probe = await this.run(PYTEST_PROBE_CODE, { timeoutMs: Math.min(this.#defaultTimeoutMs, 30000) });
    let hasPytest = false;
    if (probe.exitCode === 0) {
      try { hasPytest = (JSON.parse(probe.stdout) as { pytest?: unknown }).pytest === true; } catch { hasPytest = false; }
    }
    if (hasPytest) {
      const { executable } = await this.#resolvedInterpreter();
      const outcome = await this.#contained(executable, ['-B', '-m', 'pytest', join(root, 'tests', 'auto_sync'), '-q', '-p', 'no:cacheprovider', '--color', 'no'],
        { cwd: root, timeoutMs: options.timeoutMs ?? FROZEN_SUITE_TIMEOUT_MS });
      return { runner: 'pytest', passed: !outcome.timedOut && outcome.exitCode === 0, exitCode: outcome.timedOut ? -1 : outcome.exitCode, summary: (outcome.stdout.trim().split('\n').at(-1) ?? outcome.stderr.trim().split('\n').at(-1) ?? '').slice(0, 256) };
    }
    const { executable } = await this.#resolvedInterpreter();
    const outcome = await this.#contained(executable, ['-B', '-c', SELF_CHECK_CODE], {
      timeoutMs: options.timeoutMs ?? this.#defaultTimeoutMs,
      stdin: JSON.stringify({ vendorRoot: root, modules: FROZEN_MODULES }),
    });
    if (outcome.timedOut) throw new RunnerTaskpackError('PYTHON_TIMEOUT', `frozen self-check exceeded its ${options.timeoutMs ?? this.#defaultTimeoutMs}ms budget`);
    if (outcome.exitCode !== 0) return { runner: 'self-checks', passed: false, exitCode: outcome.exitCode, summary: outcome.stderr.slice(0, 256) };
    let report: { imported?: unknown; failed?: unknown };
    try { report = JSON.parse(outcome.stdout) as typeof report; } catch {
      return { runner: 'self-checks', passed: false, exitCode: outcome.exitCode, summary: 'self-check produced unreadable output' };
    }
    const imported = Array.isArray(report.imported) ? report.imported.length : 0;
    const failed = Array.isArray(report.failed) ? report.failed : [];
    const detail = JSON.stringify(failed).slice(0, 256);
    return { runner: 'self-checks', passed: imported === FROZEN_MODULES.length && failed.length === 0, exitCode: outcome.exitCode, summary: failed.length === 0 ? `imported ${imported}/${FROZEN_MODULES.length} frozen modules` : detail };
  }

  /** Remove the private scratch tree; every later invocation refuses with PYTHON_UNAVAILABLE. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    if (this.#scratch === null) return;
    const scratch = await this.#scratch;
    this.#scratch = null;
    await rm(scratch, { recursive: true, force: true });
  }
}
