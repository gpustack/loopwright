import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DEFAULT_PATH_ALLOWLIST, PythonBridge } from '../src/python-bridge.js';
import { RunnerTaskpackError } from '../src/types.js';

const ENV_SHAPE_CODE = `import json, os
print(json.dumps({
    "keys": sorted(os.environ.keys()),
    "HOME": os.environ.get("HOME"),
    "PATH": os.environ.get("PATH"),
    "GIT_ASKPASS": os.environ.get("GIT_ASKPASS"),
    "GIT_CONFIG_GLOBAL": os.environ.get("GIT_CONFIG_GLOBAL"),
    "GIT_CONFIG_NOSYSTEM": os.environ.get("GIT_CONFIG_NOSYSTEM"),
    "GIT_TERMINAL_PROMPT": os.environ.get("GIT_TERMINAL_PROMPT"),
    "PYTHONDONTWRITEBYTECODE": os.environ.get("PYTHONDONTWRITEBYTECODE"),
    "PYTHONPATH": os.environ.get("PYTHONPATH"),
}))`;

const OUTBOUND_BLOCK_CODE = `import socket
try:
    socket.create_connection(("192.0.2.1", 80), timeout=2)
    print("CONNECTED")
except OSError as error:
    print("BLOCKED:%s" % (error.strerror,))`;

const LOOPBACK_ECHO_CODE = `import json, socket, sys
port = json.loads(sys.stdin.read())["port"]
connection = socket.create_connection(("127.0.0.1", port), timeout=5)
connection.sendall(b"ping")
print(connection.recv(16).decode())
connection.close()`;

describe('contained python bridge', () => {
  const bridges: PythonBridge[] = [];
  const scratchRoots: string[] = [];
  let loopbackPort: number | null = null;
  let loopbackServer: ReturnType<typeof createServer> | null = null;

  function bridge(options?: ConstructorParameters<typeof PythonBridge>[0]): PythonBridge {
    const instance = new PythonBridge(options);
    bridges.push(instance);
    return instance;
  }

  before(async () => {
    loopbackServer = createServer(socket => {
      socket.on('data', chunk => { if (chunk.toString() === 'ping') socket.write('PONG'); });
    });
    await new Promise<void>(resolve => loopbackServer!.listen(0, '127.0.0.1', resolve));
    loopbackPort = (loopbackServer.address() as { port: number }).port;
  });

  after(async () => {
    loopbackServer?.close();
    for (const instance of bridges) await instance.dispose();
    await Promise.allSettled(scratchRoots.map(root => rm(root, { recursive: true, force: true })));
  });

  it('passes preflight with the default interpreter', async () => {
    const preflight = await bridge().preflight();
    assert.match(preflight.version, /^3\.(1[0-9]|[2-9][0-9])\./);
    assert.deepEqual(preflight.modules, ['packaging', 'yaml', 'requests']);
    assert.ok(preflight.pythonExecutable.startsWith('/'), preflight.pythonExecutable);
    assert.ok(preflight.pythonExecutable.includes('python'), preflight.pythonExecutable);
  });

  it('reports a missing interpreter as PYTHON_UNAVAILABLE', async () => {
    const root = await mkdtemp(join(await (await import('node:fs/promises')).realpath(tmpdir()), 'bridge-probe-'));
    scratchRoots.push(root);
    const missing = join(root, 'no-such-python');
    await assert.rejects(bridge({ pythonExecutable: missing }).preflight(), (error: unknown) => {
      assert.ok(error instanceof RunnerTaskpackError);
      assert.equal(error.code, 'PYTHON_UNAVAILABLE');
      return true;
    });
    await rm(root, { recursive: true, force: true });
  });

  it('refuses a relative configured interpreter path', () => {
    assert.throws(() => bridge({ pythonExecutable: 'relative/python3' }), (error: unknown) => {
      assert.ok(error instanceof RunnerTaskpackError);
      assert.equal(error.code, 'PYTHON_UNAVAILABLE');
      return true;
    });
  });

  it('runs every helper in an exactly pinned sanitized environment', async () => {
    const outcome = await bridge().run(ENV_SHAPE_CODE);
    assert.equal(outcome.exitCode, 0, outcome.stderr);
    const shape = JSON.parse(outcome.stdout) as { keys: string[]; HOME: string; PATH: string; GIT_ASKPASS: string; GIT_CONFIG_GLOBAL: string; GIT_CONFIG_NOSYSTEM: string; GIT_TERMINAL_PROMPT: string; PYTHONDONTWRITEBYTECODE: string; PYTHONPATH: string };
    const pinned = ['GIT_ASKPASS', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT', 'HOME', 'PATH', 'PYTHONDONTWRITEBYTECODE', 'PYTHONPATH'];
    const interpreterInjected = ['LC_CTYPE', '__CF_USER_TEXT_ENCODING'];
    for (const key of pinned) assert.ok(shape.keys.includes(key), `missing pinned key ${key}`);
    const extras = shape.keys.filter(key => !pinned.includes(key)).sort();
    assert.deepEqual(extras, extras.filter(key => interpreterInjected.includes(key)), `unexpected extra environment keys: ${extras.join(', ')}`);
    for (const key of shape.keys) assert.doesNotMatch(key, /(TOKEN|SECRET|PASSWORD|KEY_|AWS|GITHUB|GH_|NPM_|NODE_)/i, `suspicious environment key leaked: ${key}`);
    assert.equal(shape.PATH, DEFAULT_PATH_ALLOWLIST);
    assert.equal(shape.GIT_ASKPASS, '/usr/bin/false');
    assert.equal(shape.GIT_CONFIG_GLOBAL, '/dev/null');
    assert.equal(shape.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(shape.GIT_TERMINAL_PROMPT, '0');
    assert.equal(shape.PYTHONDONTWRITEBYTECODE, '1');
    const home = shape.HOME as string;
    assert.notEqual(home, process.env.HOME);
    assert.ok(home.includes('taskpack-python-'), home);
    const homeStats = await stat(home);
    assert.ok((homeStats.mode & 0o777) === 0o700, `HOME mode is ${homeStats.mode.toString(8)}`);
    assert.ok((shape.PYTHONPATH as string).endsWith('siteguard'));
  });

  it('blocks a non-loopback socket connection before any packet leaves', async () => {
    const outcome = await bridge().run(OUTBOUND_BLOCK_CODE, { timeoutMs: 10000 });
    assert.equal(outcome.exitCode, 0, outcome.stderr);
    assert.match(outcome.stdout, /^BLOCKED:non-loopback (dns lookup|socket\.connect) blocked by the contained runner bridge/);
  });

  it('blocks connect_ex and the _socket escape hatch before any packet leaves', async () => {
    const code = `import _socket, socket
results = []
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
for label, fn in [
    ("connect_ex", lambda: s.connect_ex(("192.0.2.1", 80))),
    ("bytes_connect", lambda: s.connect((b"192.0.2.1", 80))),
    ("raw_connect", lambda: _socket.socket(socket.AF_INET, socket.SOCK_STREAM).connect((bytearray(b"192.0.2.1"), 80))),
    ("sendto_bytes", lambda: s.sendto(b"leak", (b"192.0.2.1", 80))),
    ("sendto_str", lambda: s.sendto(b"leak", ("192.0.2.1", 80))),
]:
    try:
        code = fn()
        results.append(label + ":CONNECTED" if code is None or code == 0 else label + ":BLOCKED")
    except (PermissionError, OSError):
        results.append(label + ":BLOCKED")
print(";".join(results))`;
    const outcome = await bridge().run(code, { timeoutMs: 10000 });
    assert.equal(outcome.exitCode, 0, outcome.stderr);
    for (const part of outcome.stdout.trim().split(';')) {
      assert.match(part, /(connect_ex|raw_connect|sendto_bytes|sendto_str|bytes_connect):BLOCKED/, `escape hatch not blocked: ${part}`);
    }
  });

  it('blocks non-loopback hostnames even when they start with 127.', async () => {
    const outcome = await bridge().run(`import socket
try:
    socket.create_connection(("127.attacker.example", 80), timeout=2)
    print("CONNECTED")
except Exception as error:
    print("BLOCKED:%s" % (getattr(error, 'strerror', error),))`, { timeoutMs: 10000 });
    assert.equal(outcome.exitCode, 0, outcome.stderr);
    assert.match(outcome.stdout, /^BLOCKED:non-loopback dns lookup blocked/);
  });

  it('permits a loopback socket connection', async () => {
    const outcome = await bridge().run(LOOPBACK_ECHO_CODE, { timeoutMs: 10000, stdin: JSON.stringify({ port: loopbackPort }) });
    assert.equal(outcome.exitCode, 0, outcome.stderr);
    assert.equal(outcome.stdout.trim(), 'PONG');
  });

  it('throws PYTHON_TIMEOUT when a helper exceeds its budget', async () => {
    await assert.rejects(bridge().run('import time\ntime.sleep(5)\n', { timeoutMs: 300 }), (error: unknown) => {
      assert.ok(error instanceof RunnerTaskpackError);
      assert.equal(error.code, 'PYTHON_TIMEOUT');
      return true;
    });
  });

  it('throws PYTHON_BOUNDARY when output exceeds the bounded stream', async () => {
    await assert.rejects(bridge().run('print("x" * (2 * 1024 * 1024))', { timeoutMs: 20000 }), (error: unknown) => {
      assert.ok(error instanceof RunnerTaskpackError);
      assert.equal(error.code, 'PYTHON_BOUNDARY');
      return true;
    });
  });

  it('returns non-zero exits as results instead of bridge faults', async () => {
    const outcome = await bridge().run('import sys\nprint("before")\nsys.exit(3)\n');
    assert.equal(outcome.exitCode, 3);
    assert.equal(outcome.stdout.trim(), 'before');
  });

  it('passes bounded stdin into the helper', async () => {
    const outcome = await bridge().run('import sys\nprint(sys.stdin.read().upper())\n', { stdin: 'payload' });
    assert.equal(outcome.stdout.trim(), 'PAYLOAD');
  });

  it('executes the vendored frozen unit checks on the configured interpreter', { timeout: 300000 }, async t => {
    const result = await bridge().runFrozenUnitChecks();
    assert.equal(result.passed, true, result.summary);
    if (result.runner === 'pytest') {
      t.log(`frozen pytest suite: ${result.summary}`);
      assert.match(result.summary, /passed/);
    } else {
      assert.match(result.summary, /imported 10\/10 frozen modules/);
    }
  });

  it('refuses invocations after dispose', async () => {
    const instance = bridge();
    await instance.run('print("warm")');
    await instance.dispose();
    await assert.rejects(instance.run('print("again")'), (error: unknown) => {
      assert.ok(error instanceof RunnerTaskpackError);
      assert.equal(error.code, 'PYTHON_UNAVAILABLE');
      return true;
    });
  });
});
