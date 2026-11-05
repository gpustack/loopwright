import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDocument, LIMITS } from '../src/index.js';
import { contract, code } from './fixtures.js';

test('graph detects unknown roles/dependencies, duplicate nodes/edges and cycles', () => {
  const input = contract(); input.spec.steps[0]!.dependsOn = ['absent'];
  assert.equal(code(validateDocument(input, 'TaskContract')), 'REFERENCE_UNKNOWN');
  input.spec.steps[0]!.dependsOn = ['build'];
  assert.equal(code(validateDocument(input, 'TaskContract')), 'GRAPH_CYCLE');
  input.spec.steps[0]!.dependsOn = ['absent', 'absent'];
  assert.equal(code(validateDocument(input, 'TaskContract')), 'DUPLICATE_EDGE');
  input.spec.steps[0]!.dependsOn = []; input.spec.steps.push({ ...input.spec.steps[0]!, dependsOn: [] });
  assert.equal(code(validateDocument(input, 'TaskContract')), 'DUPLICATE_ID');
  const role = contract(); role.spec.steps[0]!.roleId = null;
  assert.equal(code(validateDocument(role, 'TaskContract')), 'REFERENCE_UNKNOWN');
});
test('graph accepts the bounded long chain and rejects one additional node', () => {
  const input = contract();
  input.spec.steps = Array.from({ length: LIMITS.graphNodes }, (_, index) => ({
    id: 'node-' + index, kind: 'agent', uses: 'patch', roleId: 'builder', dependsOn: index ? ['node-' + (index - 1)] : [],
  }));
  assert.equal(validateDocument(input, 'TaskContract').ok, true);
  input.spec.steps.push({ id: 'extra', kind: 'check', uses: 'verify', roleId: null, dependsOn: [] });
  assert.equal(code(validateDocument(input, 'TaskContract')), 'LIMIT_GRAPH_NODES');
});

test('graph edge cap accepts 2048 distinct DAG edges and rejects 2049', () => {
  const input = contract();
  input.spec.steps = Array.from({ length: LIMITS.graphNodes }, (_, index) => ({
    id: 'node-' + index, kind: 'agent', uses: 'patch', roleId: 'builder',
    dependsOn: Array.from({ length: Math.min(index, 8) }, (_, edge) => 'node-' + (index - edge - 1)),
  }));
  for (let index = 9; index <= 44; index++) input.spec.steps[index]!.dependsOn.push('node-' + (index - 9));
  assert.equal(input.spec.steps.reduce((sum, step) => sum + step.dependsOn.length, 0), LIMITS.graphEdges);
  assert.equal(validateDocument(input, 'TaskContract').ok, true);
  input.spec.steps[45]!.dependsOn.push('node-36');
  assert.equal(code(validateDocument(input, 'TaskContract')), 'LIMIT_GRAPH_EDGES');
});

test('graph duplicate structure precedes missing references and missing references precede cycles', () => {
  const input = contract(); input.spec.acceptance.required = ['unknown'];
  input.spec.steps.push({ ...input.spec.steps[0]!, dependsOn: [] });
  assert.equal(code(validateDocument(input, 'TaskContract')), 'DUPLICATE_ID');
  input.spec.steps.pop(); input.spec.steps[0]!.dependsOn = ['build'];
  assert.equal(code(validateDocument(input, 'TaskContract')), 'REFERENCE_UNKNOWN');
});
