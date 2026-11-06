/* global process */
import { dockerSocket, recordedDockerSocket } from './docker-socket.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
export const owner = 'task_33be673484e7';
export const docker = ['--config', process.cwd() + '/.claude/s03-t0/docker-client', '--host', 'unix://' + dockerSocket()];
export function persist(path, value) { if (value.containers) value.dockerSocket ??= dockerSocket(); writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); }
export function inspect(identity, socket = dockerSocket()) { const args = [...docker]; args[args.indexOf('--host') + 1] = 'unix://' + dockerSocket(undefined, socket); return JSON.parse(execFileSync('docker', [...args, 'inspect', identity], { timeout: 5000, encoding: 'utf8' }))[0]; }
export function reclaim(path) {
  const registry = JSON.parse(readFileSync(path, 'utf8')), receipts = [], ownedDocker = [...docker]; ownedDocker[ownedDocker.indexOf('--host') + 1] = 'unix://' + recordedDockerSocket(registry.dockerSocket);
  for (const intent of registry.containers) {
    // Name resolution covers the creation-to-ID-record interruption; labels and image authenticate ownership.
    let value;
    try { value = inspect(intent.id ?? intent.name, registry.dockerSocket); } catch (error) {
      if (error.status === 1 && /No such (object|container)/i.test(error.stderr?.toString() ?? '')) { receipts.push({ name: intent.name, absent: true }); continue; }
      throw error;
    }
    assert.equal(value.Name, '/' + intent.name); assert.equal(value.Config.Labels['org.loopwright.owner'], owner);
    assert.equal(value.Config.Labels['org.loopwright.nonce'], registry.nonce); assert.equal(value.Image, registry.image);
    if (intent.id) assert.equal(value.Id, intent.id);
    if (value.State.Running) execFileSync('docker', [...ownedDocker, 'kill', value.Id], { timeout: 5000, stdio: 'pipe' });
    const stopped = inspect(value.Id, registry.dockerSocket); assert.equal(stopped.State.Running, false);
    execFileSync('docker', [...ownedDocker, 'rm', value.Id], { timeout: 5000, stdio: 'pipe' });
    receipts.push({ id: value.Id, name: intent.name, exitCode: stopped.State.ExitCode, running: false, removed: true, recoveredFromIntent: !intent.id });
  }
  return receipts;
}
