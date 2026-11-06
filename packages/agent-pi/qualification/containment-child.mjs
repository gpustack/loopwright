/* global process, console */
import assert from 'node:assert/strict';
import { readFile, writeFile, rename, symlink, link } from 'node:fs/promises';
import net from 'node:net';
await writeFile('/scratch/allowed-output', 'OWNED_SCRATCH_OK');
assert.equal(await readFile('/workspace/candidate/allowed.txt', 'utf8'), 'ALLOWED_OK');
const denied = [];
for (const [name, action] of [
  ['protected write', () => writeFile('/workspace/candidate/protected.txt', 'bad')],
  ['new protected descendant', () => writeFile('/workspace/candidate/new-protected.txt', 'bad')],
  ['rename', () => rename('/workspace/candidate/allowed.txt', '/workspace/candidate/protected.txt')],
  ['symlink', () => symlink('/etc/passwd', '/workspace/candidate/escape')],
  ['hardlink', () => link('/etc/passwd', '/workspace/candidate/escape')],
  ['host file', () => readFile(process.argv[2], 'utf8')],
  ['root filesystem', () => writeFile('/root-escape', 'bad')],
]) { await assert.rejects(action()); denied.push(name); }
assert.equal(process.env.LW_SYNTHETIC_SECRET, undefined);
const port = Number(process.argv[3]);
const reachable = await new Promise(resolve => { const socket = net.connect({ host: 'host.docker.internal', port }); socket.setTimeout(500); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); socket.once('timeout', () => { socket.destroy(); resolve(false); }); });
assert.equal(reachable, false); denied.push('known-reachable-host-control');
const status = await readFile('/proc/self/status', 'utf8'); assert.match(status, /CapEff:\s+0+/); assert.match(status, /NoNewPrivs:\s+1/); assert.match(status, /Seccomp:\s+2/);
for (const host of ['1.1.1.1', 'host.docker.internal', '2606:4700:4700::1111']) {
  const connected = await new Promise(resolve => { const socket = net.connect({ host, port: 443 }); socket.setTimeout(500); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); socket.once('timeout', () => { socket.destroy(); resolve(false); }); });
  assert.equal(connected, false); denied.push('egress:' + host);
}
console.log(JSON.stringify({ allowedScratchWrite: true, allowedRead: true, denied, capabilitiesDropped: true, noNewPrivileges: true, seccompActive: true }));
