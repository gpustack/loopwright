import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDocument, LIMITS } from '../src/index.js';
import { contract, code, value } from './fixtures.js';

test('contract accepts exact builtin/MCP tools without weakening identifiers', () => {
  const input = contract(); input.spec.roles[0]!.tools = ['read', 'bash', 'repo.read', 'mcp__probe__allowed', 'MCP__Probe__Allowed'];
  assert.deepEqual(value(validateDocument(input, 'TaskContract')).spec.roles[0]!.tools, input.spec.roles[0]!.tools);
  for (const tool of ['read*', '${TOOL}', 'read all', 'read\n', 'read/other', '9read', '.read', 'read..all', 'read.']) {
    const bad = contract(); bad.spec.roles[0]!.tools = [tool];
    assert.equal(code(validateDocument(bad, 'TaskContract')), 'IDENTIFIER_INVALID', tool);
  }
  input.spec.roles[0]!.tools = ['read', 'read'];
  assert.equal(code(validateDocument(input, 'TaskContract')), 'DUPLICATE_ID');
  input.spec.roles[0]!.tools = ['read']; input.spec.roles[0]!.id = 'mcp__probe__allowed';
  assert.equal(code(validateDocument(input, 'TaskContract')), 'IDENTIFIER_INVALID');
});
test('contract closes policy records and rejects missing, wrong scalar/version/enum', () => {
  assert.equal(code(validateDocument({ ...contract(), apiVersion: 'v2' }, 'TaskContract')), 'VERSION_UNSUPPORTED');
  const wrong = contract(); wrong.spec.trustedContext.discovery = 'enabled';
  assert.equal(code(validateDocument(wrong, 'TaskContract')), 'VALUE_ENUM');
  const input = contract(); Object.assign(input.spec.budgets, { unlimited: true });
  assert.equal(code(validateDocument(input, 'TaskContract')), 'FIELD_UNKNOWN');
  const missing = contract(); Reflect.deleteProperty(missing.spec.target, 'baseRevision');
  assert.equal(code(validateDocument(missing, 'TaskContract')), 'FIELD_REQUIRED');
  const stringNumber = contract(); Object.assign(stringNumber.spec.budgets, { totalTokens: '1000' });
  assert.equal(code(validateDocument(stringNumber, 'TaskContract')), 'VALUE_TYPE');
});
test('contract independent repair zero caps share parent limits', () => {
  for (const [format, implementation, retries] of [[0, 2, 1], [2, 0, 1], [0, 0, 0], [6, 6, 6]]) {
    const input = contract(); Object.assign(input.spec.budgets, { maxFormatRepairs: format, maxImplementationRepairs: implementation, maxTransportRetries: retries });
    assert.equal(validateDocument(input, 'TaskContract').ok, true);
  }
  for (const field of ['maxFormatRepairs', 'maxImplementationRepairs', 'maxTransportRetries', 'maxConcurrency'] as const) {
    const input = contract(); input.spec.budgets[field] = 11;
    assert.equal(code(validateDocument(input, 'TaskContract')), 'BUDGET_INCONSISTENT');
    input.spec.budgets[field] = -1;
    assert.equal(code(validateDocument(input, 'TaskContract')), 'VALUE_RANGE');
  }
  const input = contract(); input.spec.budgets.perCallOutputTokens = 1_001;
  assert.equal(code(validateDocument(input, 'TaskContract')), 'BUDGET_INCONSISTENT');
});

test('contract declared collection caps accept the limit and reject one extra', () => {
  const examples: { limit: number; set: (task: ReturnType<typeof contract>, count: number) => void }[] = [
    { limit: LIMITS.roles, set: (task, count) => { task.spec.roles = Array.from({ length: count }, (_, i) => ({ ...task.spec.roles[0]!, id: i ? 'role-' + i : 'builder', tools: [] })); } },
    { limit: LIMITS.tools, set: (task, count) => { task.spec.roles[0]!.tools = Array.from({ length: count }, (_, i) => 'mcp__tool__' + i); } },
    { limit: LIMITS.patterns, set: (task, count) => { task.spec.scope.writable = Array.from({ length: count }, (_, i) => 'file-' + i); } },
    { limit: LIMITS.patterns, set: (task, count) => { task.spec.scope.protected = Array.from({ length: count }, (_, i) => 'file-' + i); } },
    { limit: LIMITS.targets, set: (task, count) => { task.spec.target.matrix = Array.from({ length: count }, (_, i) => ({ id: 'target-' + i, platform: 'linux', variant: 'cpu' })); } },
    { limit: LIMITS.resources, set: (task, count) => { Object.assign(task.spec.trustedContext, { resources: Array.from({ length: count }, (_, i) => ({ id: 'resource-' + i, kind: 'document', path: 'docs/file-' + i, digest: { algorithm: 'sha256', hex: '0'.repeat(64) } })) }); } },
    { limit: LIMITS.checks, set: (task, count) => { task.spec.acceptance.checks = Array.from({ length: count }, (_, i) => ({ id: i ? 'check-' + i : 'tests', allowedEvidenceLevels: ['local_execution'] })); } },
  ];
  for (const example of examples) {
    const input = contract(); example.set(input, example.limit);
    assert.equal(validateDocument(input, 'TaskContract').ok, true);
    example.set(input, example.limit + 1);
    assert.equal(code(validateDocument(input, 'TaskContract')), 'VALUE_RANGE');
  }
});

test('contract scalar caps and deterministic version/unknown precedence', () => {
  const input = contract(); input.spec.taskpack = 'a'.repeat(LIMITS.identifier); input.spec.goal = 'x'.repeat(LIMITS.goal);
  input.spec.roles[0]!.tools = ['x'.repeat(LIMITS.toolName)];
  assert.equal(validateDocument(input, 'TaskContract').ok, true);
  input.spec.roles[0]!.tools = ['x'.repeat(LIMITS.toolName + 1)];
  assert.equal(code(validateDocument(input, 'TaskContract')), 'VALUE_RANGE');
  const bad = { ...contract(), apiVersion: 'v2', extra: true };
  const reordered = Object.fromEntries(Object.entries(bad).reverse());
  assert.deepEqual(validateDocument(bad, 'TaskContract'), validateDocument(reordered, 'TaskContract'));
  assert.equal(code(validateDocument(bad, 'TaskContract')), 'VERSION_UNSUPPORTED');
});

test('review R1 exact labels reject nonprinting Unicode while retaining printable labels', () => {
  for (const model of ['exact\u202Emodel', 'exact\u200Bmodel', 'exact\u00ADmodel', 'exact\uE000model', 'exact\u0378model']) {
    const input = contract(); input.spec.roles[0]!.model = model;
    assert.equal(code(validateDocument(input, 'TaskContract')), 'IDENTIFIER_INVALID');
  }
  for (const model of ['modèle', '模型', 'model-😀', 'modele\u0301']) {
    const input = contract(); input.spec.roles[0]!.model = model;
    assert.equal(value(validateDocument(input, 'TaskContract')).spec.roles[0]!.model, model);
  }
});
