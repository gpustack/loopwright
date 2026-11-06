/* global process, console */
import { recordedDockerSocket } from './docker-socket.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { isAbsentInspect } from './absence.mjs';
export function reclaimSessionRegistry(path) {
 const registry = JSON.parse(readFileSync(path, 'utf8')); assert.equal(registry.kind, 'runtime-session-v1'); const receipts = [];
 const args = ['--config', registry.dockerConfig, '--host', 'unix://' + recordedDockerSocket(registry.dockerSocket)];
 for (const intent of registry.sessions) {
  const known = intent.id ?? (() => { try { return JSON.parse(readFileSync(intent.directory + '/container-id.json', 'utf8')).id; } catch { return intent.name; } })();
  const inspected = spawnSync('docker', [...args, 'inspect', known], { encoding: 'utf8', timeout: 5000, maxBuffer: 1048576 });
  if (isAbsentInspect(known, inspected.status, inspected.stdout, inspected.stderr)) { receipts.push({ id: known, absent: true }); continue; }
  assert.equal(inspected.status, 0); const value = JSON.parse(inspected.stdout)[0];
  assert.equal(value.Name, '/' + intent.name); assert.equal(value.Image, intent.image);
  assert.deepEqual(value.Config.Labels, { ...(intent.generation === undefined ? {} : { 'org.loopwright.generation': String(intent.generation) }), 'org.loopwright.run': intent.runId, 'org.loopwright.session': intent.sessionId, 'org.loopwright.nonce': intent.nonce });
  if (known !== intent.name) assert.equal(value.Id, known);
  if (value.State.Running) execFileSync('docker', [...args, 'kill', value.Id], { timeout: 5000, stdio: 'pipe' });
  const stopped = JSON.parse(execFileSync('docker', [...args, 'inspect', value.Id], { encoding: 'utf8', timeout: 5000 }))[0]; assert.equal(stopped.State.Running, false);
  execFileSync('docker', [...args, 'rm', value.Id], { timeout: 5000, stdio: 'pipe' });
  const absent = spawnSync('docker', [...args, 'inspect', value.Id], { encoding: 'utf8', timeout: 5000 }); assert.ok(isAbsentInspect(value.Id, absent.status, absent.stdout, absent.stderr)); receipts.push({ id: value.Id, removed: true, exitCode: stopped.State.ExitCode, absenceConfirmed: true });
 }
 writeFileSync(path + '.cleanup.json', JSON.stringify(receipts)); return receipts;
}
if (process.argv[1]?.endsWith('/session-cleanup.mjs')) console.log(JSON.stringify(reclaimSessionRegistry(process.argv[2])));
