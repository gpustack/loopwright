/* global process, console */
import { recordedDockerSocket } from './docker-socket.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { isAbsentInspect } from './absence.mjs';
/** Exact intents persisted before role creation, including creation-to-ID gaps. */
export function reclaimRoles(path, registry = JSON.parse(readFileSync(path, 'utf8'))) {
 assert.equal(registry.kind, 'restricted-roles-v1'); const receipts = [];
 const args = ['--config', registry.dockerConfig, '--host', 'unix://' + recordedDockerSocket(registry.dockerSocket)];
 for (const intent of registry.roles) {
  let known = intent.id; if (!known) { try { known = JSON.parse(readFileSync(intent.directory + '/container-id.json', 'utf8')).id; } catch { known = intent.name; } }
  if (/^[a-f0-9]{64}$/.test(known)) { intent.id = known; writeFileSync(path, JSON.stringify(registry)); }
  const found = spawnSync('docker', [...args, 'inspect', known], { encoding: 'utf8', timeout: 5000, maxBuffer: 1048576 });
  if (isAbsentInspect(known, found.status, found.stdout, found.stderr)) { receipts.push({ id: known, absent: true }); continue; }
  assert.equal(found.status, 0); const value = JSON.parse(found.stdout)[0];
  assert.equal(value.Name, '/' + intent.name); assert.equal(value.Image, intent.image); assert.deepEqual(value.Config.Labels, intent.labels); if (known !== intent.name) assert.equal(value.Id, known);
  if (value.State.Running) execFileSync('docker', [...args, 'kill', value.Id], { timeout: 5000, stdio: 'pipe' });
  const stopped = JSON.parse(execFileSync('docker', [...args, 'inspect', value.Id], { encoding: 'utf8', timeout: 5000 }))[0]; assert.equal(stopped.State.Running, false);
  execFileSync('docker', [...args, 'rm', value.Id], { timeout: 5000, stdio: 'pipe' });
  const absent = spawnSync('docker', [...args, 'inspect', value.Id], { encoding: 'utf8', timeout: 5000 }); assert.ok(isAbsentInspect(value.Id, absent.status, absent.stdout, absent.stderr));
  receipts.push({ id: value.Id, removed: true, exitCode: stopped.State.ExitCode, absenceConfirmed: true });
 }
 writeFileSync(path + '.cleanup.json', JSON.stringify(receipts)); return receipts;
}
if (process.argv[1]?.endsWith('/role-cleanup.mjs')) console.log(JSON.stringify(reclaimRoles(process.argv[2])));
