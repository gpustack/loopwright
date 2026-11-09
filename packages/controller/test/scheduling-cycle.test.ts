import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { reopenLocalRun } from '@loopwright/state';
import { cycleFixture } from './scheduling-fixtures.js';
import { runCycleWithPorts, type RunDescriptor } from '../src/controller.js';
import { hash } from '../src/schema.js';
import { stateValue } from '../src/storage.js';
import type { ControllerEvent } from '../src/events.js';
import { runCycle } from '../src/index.js';

test('scheduling: public production controller completes a check-only cycle without injected execution ports', async () => {
  const f = await cycleFixture(true);
  const execution = await runCycle({ configuration: f.loaded, repository: f.repository, runRoot: f.runRoot, runId: 'public-cycle' });
  assert.equal(execution.ok, true, JSON.stringify(execution)); if (!execution.ok) return;
  assert.equal(execution.value.kind, 'result', JSON.stringify(execution)); if (execution.value.kind !== 'result') return;
  assert.equal(execution.value.result.spec.status, 'completed');
  const descriptor = JSON.parse(await readFile(join(f.runRoot, 'public-cycle', 'run.json'), 'utf8')) as RunDescriptor;
  const store = stateValue(reopenLocalRun(descriptor.identity));
  try {
    const view = stateValue(store.inspect());
    assert.equal(view.counts.requests, 0); assert.equal(view.owner.mode, null);
    assert.equal(view.counts.unresolvedOperations, 0); assert.equal(view.counts.unresolvedRequests, 0);
  } finally { stateValue(store.close()); }
});

for (const valid of [true, false]) test('scheduling: public-boundary check-only cycle uses real Git/S02/Workers/core with expected ' + (valid ? 'completion' : 'failure'), async () => {
  const f = await cycleFixture(valid), events: ControllerEvent[] = []; let opens = 0;
  const result = await runCycleWithPorts({ configuration: f.loaded, repository: f.repository, runRoot: f.runRoot, runId: 'run-check', onEvent: async event => { events.push(event); } }, { openAdapter: async () => { opens++; throw new Error('no native role in check-only graph'); } });
  assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) return;
  assert.equal(result.value.kind, 'result', JSON.stringify(result)); if (result.value.kind !== 'result') return;
  assert.equal(result.value.result.spec.status, valid ? 'completed' : 'failed'); assert.deepEqual(result.value.secondary, []); assert.equal(opens, 0);
  const directory = join(f.runRoot, 'run-check'), descriptor = JSON.parse(await readFile(join(directory, 'run.json'), 'utf8')) as RunDescriptor;
  const store = stateValue(reopenLocalRun(descriptor.identity)), view = stateValue(store.inspect());
  assert.equal(view.counts.requests, 0); assert.equal(view.counts.operations, 3); assert.equal(view.counts.checkpoints, 10); assert.equal(view.owner.mode, null);
  const operations = stateValue(store.listOperations({ limit: 100, cursor: null })).items; assert.ok(operations.every(operation => operation.state === 'confirmed' && operation.intent.effect === 'read_only'));
  const checkpoints = stateValue(store.listCheckpoints({ limit: 100, cursor: null })).items; assert.ok(checkpoints.every(checkpoint => checkpoint.additionalArtifacts.length === 4));
  stateValue(store.close()); assert.equal(await lstat(join(directory, 'controller.owner.ndjson')).then(() => false, error => error.code === 'ENOENT'), true);
  assert.ok(events.length >= 5); assert.deepEqual(events.map(event => event.sequence), events.map((_, index) => index + 1)); assert.equal(events.at(-1)!.stage, 'terminal');
  const observations = JSON.parse(await readFile(join(directory, 'artifacts', result.value.observations!.name), 'utf8'));
  assert.equal(observations.requestedStatusSource, 'controller_check_only'); assert.equal(observations.verifierMatrix.length, 3); assert.equal(observations.verifierMatrix.find((row: { implicit: unknown }) => row.implicit === 'no_change').status, 'passed');
  await writeFile(join(directory, 'unit-cycle-result.json'), JSON.stringify({ version: 1, level: 'real-local-check-only', result: result.value, events, state: view, operations, checkpoints, artifactIdentity: hash(Buffer.from(JSON.stringify(observations))), nativeAgentExecution: false, retained: true }), { mode: 0o600 });
});
