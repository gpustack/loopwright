import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAbsentContainer } from '../src/docker-absence.js';
test('cleanup never treats daemon, permission or wrong-ID failures as absence', () => {
  const id = 'a'.repeat(64), absent = { code: 1, stdout: '[]\n', stderr: 'error: no such object: ' + id + '\n' };
  assert.equal(isAbsentContainer(id, absent), true);
  for (const patch of [{ code: 124 }, { stdout: '{}' }, { stderr: 'Cannot connect to the Docker daemon' }, { stderr: 'permission denied' }, { stderr: 'error: no such object: ' + 'b'.repeat(64) }, { stderr: 'daemon unavailable\n' + absent.stderr }]) assert.equal(isAbsentContainer(id, { ...absent, ...patch }), false);
  assert.equal(isAbsentContainer('unresolved-container-name', { ...absent, stderr: 'error: no such object: unresolved-container-name' }), false);
});
