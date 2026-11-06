import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAbsentInspect } from './absence.mjs';
test('inspect absence requires exact ID and known case-insensitive not-found form', () => {
 const id = 'a'.repeat(64);
 assert.equal(isAbsentInspect(id, 1, '', 'error: no such object: ' + id + '\n'), true);
 assert.equal(isAbsentInspect(id, 1, '[]\n', 'error: no such object: ' + id + '\n'), true);
 assert.equal(isAbsentInspect(id, 1, '', 'Error: No such container: ' + id + '\n'), true);
 for (const [exit, stdout, stderr] of [[1, '', 'Cannot connect to the Docker daemon'], [1, '', 'permission denied'], [1, '', ''], [124, '', 'error: no such object: ' + id], [1, '', 'error: no such object: ' + 'b'.repeat(64)], [1, '{}', 'error: no such object: ' + id], [1, '', 'warning\nerror: no such object: ' + id], [0, '', 'error: no such object: ' + id]]) assert.equal(isAbsentInspect(id, exit, stdout, stderr), false);
});
