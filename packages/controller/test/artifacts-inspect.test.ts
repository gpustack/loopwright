import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, lstat, symlink } from 'node:fs/promises';
import { digestArtifact } from '@loopwright/core';
import { reopenLocalRun } from '@loopwright/state';
import { runCycle, readStatus, inspectRun } from '../src/index.js';
import { cycleFixture } from './scheduling-fixtures.js';
import { stateValue } from '../src/storage.js';
import { PublicBundle } from '../src/bundle.js';
import { hash } from '../src/schema.js';
test('artifacts: public status and inspect export current bound bytes without claims, credentials or state copies', async () => {
  const f = await cycleFixture(true), input = { configuration: f.loaded, repository: f.repository, runRoot: f.runRoot, runId: 'inspect-run' };
  const executed = await runCycle(input); assert.ok(executed.ok);
  const directory = join(f.runRoot, input.runId), descriptor = JSON.parse(await readFile(join(directory, 'run.json'), 'utf8')), store = stateValue(reopenLocalRun(descriptor.identity));
  const before = stateValue(store.inspect()), output = join(f.root, 'export');
  const status = await readStatus({ runRoot: f.runRoot, runId: input.runId }); assert.ok(status.ok); if (!status.ok) return;
  assert.equal(status.value.status, 'completed'); assert.equal(status.value.source, 'current'); assert.equal(status.value.cleanup, 'complete');
  const inspected = await inspectRun({ runRoot: f.runRoot, runId: input.runId, output }); assert.ok(inspected.ok, JSON.stringify(inspected)); if (!inspected.ok || !inspected.value.manifest) return;
  for (const row of inspected.value.manifest.entries) {
    if (row.presence === 'present') { const bytes = await readFile(join(output, row.name)); const ref = digestArtifact(row.name, bytes); assert.ok(ref.ok); if (ref.ok) assert.deepEqual(ref.value, row.ref); }
    else assert.equal(row.ref, null);
  }
  const all = JSON.stringify(inspected.value) + await readFile(join(output, 'checkpoint.manifest.json'), 'utf8');
  for (const excluded of ['nonce', 'privateSession', '.sqlite', 'PROVIDER_TOKEN', 'session.json', f.input.registryPath]) assert.equal(all.includes(excluded), false, excluded);
  assert.equal(inspected.value.manifest.entries.find(row => row.name === 'review.json')!.presence, 'not_run');
  const after = stateValue(store.inspect()); assert.equal(after.revision, before.revision); assert.equal(after.owner.generation, before.owner.generation); assert.deepEqual(after.ledger, before.ledger);
  stateValue(store.close());
  const again = await inspectRun({ runRoot: f.runRoot, runId: input.runId, output }); assert.equal(again.ok, false);
});
test('artifacts: unavailable run remains unknown without creating state or an output directory', async () => {
  const f = await cycleFixture(true), input = { runRoot: f.runRoot, runId: 'missing' };
  const result = await readStatus(input); assert.ok(result.ok); if (result.ok) { assert.equal(result.value.status, null); assert.equal(result.value.source, 'unavailable'); }
  const inspected = await inspectRun({ ...input, output: join(f.root, 'absent-export') }); assert.ok(inspected.ok); if (inspected.ok) assert.equal(inspected.value.manifest, null);
  assert.equal(await lstat(f.runRoot).then(() => true, () => false), false); assert.equal(await lstat(join(f.root, 'absent-export')).then(() => true, () => false), false);
});
test('artifacts: byte caps and symlink destinations refuse rather than truncate or overwrite', async () => {
  const bundle = new PublicBundle('bundle', hash('lock')); assert.throws(() => bundle.add('large', Buffer.alloc(8388609)));
  bundle.add('one', Buffer.from('one'));
  const f = await cycleFixture(true); await symlink(f.root, join(f.root, 'link'));
  await assert.rejects(bundle.write(join(f.root, 'link', 'export'), join(f.root, 'private')));
  assert.equal(await lstat(join(f.root, 'export')).then(() => true, () => false), false);
});
