/* global process, console, setTimeout, clearTimeout */
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { docker } from './ownership.mjs';
export async function runtimeImage(options = {}) {
  if (options.owner !== undefined && options.owner !== 'controller') throw new Error('Unsupported qualification owner');
  const directory = resolve('.claude/s03-t0'); await mkdir(directory, { recursive: true });
  const context = await mkdtemp(directory + '/runtime-context-');
  const nonce = randomBytes(12).toString('hex');
  const tag = options.owner === 'controller' ? 'loopwright-controller-runtime:' + nonce : 'loopwright-s03-runtime:task-33be673484e7';
  const ownership = { version: 1, owner: options.owner ?? 'legacy-s03', nonce, tag, context, image: null, state: 'intent' };
  const ownershipPath = directory + '/image-' + nonce + '.json';
  await writeFile(ownershipPath, JSON.stringify(ownership), { flag: 'wx', mode: 0o600, flush: true });
  if (options.owner === 'controller') {
    const countPath = directory + '/controller-image-builds.json';
    let attempts;
    try { attempts = JSON.parse(await readFile(countPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; attempts = []; }
    if (!Array.isArray(attempts) || attempts.length >= 3) throw new Error('Image build ceiling');
    attempts.push({ nonce, tag, ownershipPath });
    await writeFile(countPath, JSON.stringify(attempts), { mode: 0o600, flush: true });
  }
  try {
    await cp('node_modules', context + '/node_modules', { recursive: true, dereference: false, verbatimSymlinks: true });
    for (const name of ['core', 'state', 'agent-pi']) {
      const target = context + '/packages/' + name; await mkdir(target, { recursive: true });
      await cp('packages/' + name + '/dist', target + '/dist', { recursive: true });
      await cp('packages/' + name + '/package.json', target + '/package.json');
      if (name === 'agent-pi') await cp('packages/' + name + '/qualification', target + '/qualification', { recursive: true });
    }
    for (const file of ['package.json', 'package-lock.json']) await cp(file, context + '/' + file);
    await cp('packages/agent-pi/runtime/Dockerfile', context + '/Dockerfile');
    const args = [...docker, 'build', '--pull=false', '--network=none', '--iidfile', context + '/image.id', '--tag', tag, context];
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] }); let output = '', timer;
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output += chunk; if (output.length > 4194304) child.kill('SIGKILL'); });
    const finished = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    let result;
    try { result = await Promise.race([finished, new Promise((_, reject) => { timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('runtime image build deadline')); }, 100000); })]); } finally { clearTimeout(timer); }
    assert.equal(result.code, 0, output); const image = (await readFile(context + '/image.id', 'utf8')).trim();
    const inspected = JSON.parse(execFileSync('docker', [...docker, 'image', 'inspect', image], { encoding: 'utf8', timeout: 5000 }))[0];
    assert.equal(inspected.Id, image); assert.equal(inspected.Os, 'linux'); assert.equal(inspected.Architecture, 'arm64');
    await writeFile(directory + '/runtime-image.id', image + '\n');
    ownership.image = image; ownership.state = 'built';
    await writeFile(ownershipPath, JSON.stringify(ownership), { mode: 0o600, flush: true });
    return { status: 'passed', image, configUser: inspected.Config.User, rootfs: inspected.RootFS, base: 'sha256:067b2d425f1204b5a898ae3d3145f7524c1425a4096a62b0f67dd4344a494440',
      dockerfileSha256: createHash('sha256').update(await readFile('packages/agent-pi/runtime/Dockerfile')).digest('hex'), buildLog: output };
  } finally { await rm(context, { recursive: true, force: true }); }
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const ownerIndex = process.argv.indexOf('--owner');
  console.log(JSON.stringify(await runtimeImage(ownerIndex < 0 ? {} : { owner: process.argv[ownerIndex + 1] }), null, 2));
}
