/* global process, console, setTimeout, clearTimeout, setInterval */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { docker, owner, persist, inspect, reclaim } from './ownership.mjs';
const dir = resolve('.claude/s03-t0'), image = readFileSync(dir + '/runtime-image.id', 'utf8').trim();
if (process.argv[2] === 'worker') {
  const [mode, path, nonce] = process.argv.slice(3), name = 'lw-s03-watchdog-' + nonce;
  const registry = { nonce, image, containers: [{ name }] }; persist(path, registry);
  const grandchildCode = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const childCode = `const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});spawn(process.execPath,['-e',${JSON.stringify(grandchildCode)},'daemonized-grandchild'],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},1000)`;
  const code = `const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});spawn(process.execPath,['-e',${JSON.stringify(childCode)},'detached-child'],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},1000)`;
  const id = execFileSync('docker', [...docker, 'create', '--name', name, '--label', 'org.loopwright.owner=' + owner, '--label', 'org.loopwright.nonce=' + nonce,
    '--pull=never', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true', '--security-opt', 'seccomp=' + resolve('packages/agent-pi/runtime/seccomp.json'),
    '--user', '1000:1000', '--memory', '512m', '--memory-swap', '512m', '--cpus', '1', '--pids-limit', '64', '--log-driver', 'none', image, '-e', code], { timeout: 5000, encoding: 'utf8' }).trim();
  if (mode === 'stubborn') {
    registry.containers[0].id = id; persist(path, registry);
    execFileSync('docker', [...docker, 'start', id], { timeout: 5000 });
  }
  process.stdout.write('READY\n'); setInterval(() => {}, 1000);
} else {
  mkdirSync(dir, { recursive: true }); const receipts = [];
  const outerPath = process.argv[2] ?? dir + '/watchdog-outer-' + randomBytes(6).toString('hex') + '.json';
  const outer = { cleanupPaths: [] }; persist(outerPath, outer);
  for (const mode of ['stubborn', 'create-before-id-record']) {
    const nonce = randomBytes(6).toString('hex'), path = dir + '/watchdog-' + nonce + '.json';
    outer.cleanupPaths.push(path); persist(outerPath, outer);
    const worker = spawn(process.execPath, [process.argv[1], 'worker', mode, path, nonce], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; worker.stderr.on('data', chunk => { stderr += chunk; });
    const exited = new Promise(resolve => worker.once('exit', (code, signal) => resolve({ code, signal })));
    try {
      let timer;
      try { await Promise.race([new Promise(resolve => worker.stdout.once('data', resolve)), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('watchdog readiness deadline: ' + stderr)), 10000); })]); } finally { clearTimeout(timer); }
      const registry = JSON.parse(readFileSync(path, 'utf8')), value = inspect(registry.containers[0].id ?? registry.containers[0].name);
      if (mode === 'stubborn') {
        await new Promise(resolve => setTimeout(resolve, 300));
        const top = execFileSync('docker', [...docker, 'top', value.Id, '-eo', 'pid,ppid,args'], { timeout: 5000, encoding: 'utf8' });
        assert.ok(top.trim().split('\n').length >= 4, top);
        execFileSync('docker', [...docker, 'kill', '--signal', 'TERM', value.Id], { timeout: 5000 });
        await new Promise(resolve => setTimeout(resolve, 200)); assert.equal(inspect(value.Id).State.Running, true);
        receipts.push({ mode, ignoredTerm: true, processTree: top });
      }
      worker.kill('SIGKILL'); const exit = await exited; assert.equal(exit.signal, 'SIGKILL');
      const cleanup = reclaim(path); assert.equal(cleanup[0].recoveredFromIntent, mode === 'create-before-id-record');
      receipts.push({ mode, outerWorkerExit: exit, cleanup });
    } catch (error) {
      worker.kill('SIGKILL'); await exited;
      try { reclaim(path); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'watchdog case and exact cleanup failed', { cause: cleanupError }); }
      throw error;
    }
  }
  console.log(JSON.stringify({ status: 'passed', level: 'actual local container watchdog and interrupted ID journaling', receipts }, null, 2));
}
