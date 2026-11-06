/* global process, Buffer, console, setTimeout, clearTimeout */
import { dockerSocket } from './docker-socket.mjs';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { persist, reclaim } from './ownership.mjs';
import { randomBytes, createHash } from 'node:crypto';
const directory = resolve('.claude/s03-t0');
const image = (await readFile(directory + '/runtime-image.id', 'utf8')).trim();
const nonce = randomBytes(6).toString('hex'), owner = 'task_33be673484e7';
const docker = ['--config', directory + '/docker-client', '--host', 'unix://' + dockerSocket()];
const receipts = [], owned = [];
let controlRequests = 0;
const control = http.createServer((request, response) => { controlRequests++; response.end('KNOWN_REACHABLE_CONTROL'); });
await new Promise(resolve => control.listen(0, '0.0.0.0', resolve));
const controlPort = control.address().port;
assert.equal(await (await globalThis.fetch('http://127.0.0.1:' + controlPort)).text(), 'KNOWN_REACHABLE_CONTROL');
const controlBaseline = controlRequests;
const registryPath = process.argv[2] ?? directory + '/ownership-' + nonce + '.json';
const registry = { nonce, image, containers: [] }; persist(registryPath, registry);
const call = args => JSON.parse(execFileSync('docker', [...docker, ...args], { timeout: 10000, encoding: 'utf8' }));
await mkdir(directory + '/candidate', { recursive: true });
await writeFile(directory + '/candidate/allowed.txt', 'ALLOWED_OK'); await writeFile(directory + '/candidate/protected.txt', 'PROTECTED');
await writeFile(directory + '/host-canary.txt', 'SYNTHETIC_HOST_ONLY');
const base = name => ['create', '--pull=never', '--interactive', '--init', '--name', name,
  '--label', 'org.loopwright.owner=' + owner, '--label', 'org.loopwright.nonce=' + nonce,
  '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
  '--security-opt', 'seccomp=' + resolve('packages/agent-pi/runtime/seccomp.json'), '--user', '1000:1000',
  '--memory', '512m', '--memory-swap', '512m', '--cpus', '1', '--pids-limit', '64', '--log-driver', 'none',
  '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=33554432', '--tmpfs', '/scratch:rw,nosuid,nodev,noexec,size=134217728',
  '--mount', 'type=bind,src=' + directory + '/candidate,dst=/workspace/candidate,readonly',
  '--env', 'HOME=/tmp/home', '--env', 'PI_OFFLINE=1', '--env', 'PATH=/usr/local/bin:/usr/bin:/bin', image];
function child(suffix, script, args = []) {
  const name = 'lw-s03-' + nonce + '-' + suffix;
  const intent = { name }; registry.containers.push(intent); persist(registryPath, registry);
  const create = [...docker, ...base(name), '/opt/loopwright/packages/agent-pi/qualification/' + script, ...args];
  intent.id = execFileSync('docker', create, { timeout: 10000, encoding: 'utf8' }).trim(); persist(registryPath, registry);
  const argv = [...docker, 'start', '--attach', '--interactive', intent.id];
  const proc = spawn('docker', argv, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, LW_SYNTHETIC_SECRET: 'HOST_ONLY_FIXTURE_CANARY' } });
  const record = { name, argv, proc, stderr: '', stdout: '', exit: null }; owned.push(record);
  proc.stderr.on('data', chunk => { record.stderr += chunk; if (record.stderr.length > 32768) proc.kill('SIGKILL'); });
  record.finished = new Promise((resolve, reject) => { proc.once('error', reject); proc.once('exit', (code, signal) => { record.exit = { code, signal }; resolve(record.exit); }); });
  return record;
}
async function finite(record, seconds = 30) {
  let timer;
  try { return await Promise.race([record.finished, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('owned container absolute deadline: ' + record.name)), seconds * 1000); })]); }
  finally { clearTimeout(timer); }
}
function frames(stream, handle) {
  let buffer = '';
  stream.on('data', chunk => {
    buffer += chunk; if (Buffer.byteLength(buffer) > 65536) throw new Error('owned fixture frame cap');
    for (;;) { const end = buffer.indexOf('\n'); if (end < 0) break; const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (line) handle(JSON.parse(line)); }
  });
}
try {
  const sdk = child('serializer', 'sdk-probe.mjs');
  sdk.proc.stdout.on('data', data => { sdk.stdout += data; if (sdk.stdout.length > 65536) sdk.proc.kill('SIGKILL'); });
  const sdkExit = await finite(sdk); assert.equal(sdkExit.code, 0, sdk.stderr); const serializer = JSON.parse(sdk.stdout);
  assert.equal(serializer.deniedSecond, 1); receipts.push({ case: 'contained actual SDK parser/compaction', result: serializer });
  const server = child('mcp', 'mcp-server.mjs');
  const native = child('native', 'mcp-child.mjs'); let result;
  frames(native.proc.stdout, frame => {
    if (frame.kind === 'mcp') {
      if (frame.message.method === 'tools/call') assert.equal(frame.message.params.name, 'read_file');
      server.proc.stdin.write(JSON.stringify(frame.message) + '\n');
    } else if (frame.kind === 'result') result = frame.result;
    else throw new Error('unknown private fixture channel');
  });
  frames(server.proc.stdout, message => native.proc.stdin.write(JSON.stringify({ kind: 'mcp-reply', message }) + '\n'));
  const nativeExit = await finite(native); server.proc.stdin.end(); const serverExit = await finite(server, 5);
  assert.equal(nativeExit.code, 0, native.stderr); assert.equal(serverExit.code, 0, server.stderr);
  assert.equal(result.allowedNestedRead, true); assert.equal(result.failedParentDenied, true);
  const calls = server.stderr.trim().split('\n').filter(Boolean).map(JSON.parse); assert.deepEqual(calls.map(item => item.called), ['read_file']);
  receipts.push({ case: 'separate contained real MCP transport/native codemode, fake model', result, serverCalls: calls });
  const tool = child('containment', 'containment-child.mjs', [directory + '/host-canary.txt', String(controlPort)]);
  tool.proc.stdout.on('data', data => { tool.stdout += data; if (tool.stdout.length > 65536) tool.proc.kill('SIGKILL'); });
  assert.equal((await finite(tool)).code, 0, tool.stderr); assert.equal(controlRequests, controlBaseline); receipts.push({ case: 'actual containment controls', result: JSON.parse(tool.stdout), knownReachableHostControl: true, containerControlRequests: controlRequests - controlBaseline });
  const inspected = call(['inspect', tool.name])[0];
  assert.equal(inspected.HostConfig.ReadonlyRootfs, true); assert.equal(inspected.HostConfig.NetworkMode, 'none');
  assert.equal(inspected.HostConfig.Privileged, false); assert.equal(inspected.HostConfig.Memory, 536870912); assert.equal(inspected.HostConfig.MemorySwap, 536870912);
  assert.equal(inspected.HostConfig.PidsLimit, 64); assert.equal(inspected.Config.User, '1000:1000');
  assert.equal(await readFile(directory + '/candidate/protected.txt', 'utf8'), 'PROTECTED');
  console.log(JSON.stringify({ status: 'passed', level: 'T0 actual owned Linux SDK/tool/MCP feasibility, fake model/HTTP fixture; not final production acceptance', image, nonce,
    seccompSha256: createHash('sha256').update(await readFile('packages/agent-pi/runtime/seccomp.json')).digest('hex'), receipts }, null, 2));
} finally {
  control.closeAllConnections(); await new Promise(resolve => control.close(resolve));
  const cleanup = reclaim(registryPath);
  for (const record of owned) {
    record.proc.stdin.destroy(); record.proc.stdout.destroy(); record.proc.stderr.destroy();
    if (record.exit === null) record.proc.kill('SIGKILL');
  }
  for (const receipt of cleanup) process.stderr.write(JSON.stringify({ cleanup: true, ...receipt }) + '\n');
}
