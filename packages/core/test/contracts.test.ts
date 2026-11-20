import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admitTask, resolveOverlayLimits, validateDocument, LIMITS, OVERLAY_LIMITS } from '../src/index.js';
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

test('contract optional role resourceIds validates against trustedContext.resources and omits when unset', () => {
  const baseline = contract();
  const baselineParsed = value(validateDocument(baseline, 'TaskContract'));
  assert.equal(Object.hasOwn(baselineParsed.spec.roles[0]!, 'resourceIds'), false);

  const withResources = contract();
  Object.assign(withResources.spec.trustedContext, {
    resources: [
      { id: 'inst-1', kind: 'instruction', path: 'docs/a.md', digest: { algorithm: 'sha256', hex: 'a'.repeat(64) } },
      { id: 'skill-1', kind: 'skill', path: 'docs/b.md', digest: { algorithm: 'sha256', hex: 'b'.repeat(64) } },
    ],
  });
  Object.assign(withResources.spec.roles[0]!, { resourceIds: ['inst-1'] });
  const parsed = value(validateDocument(withResources, 'TaskContract'));
  assert.deepEqual(parsed.spec.roles[0]!.resourceIds, ['inst-1']);

  Object.assign(withResources.spec.roles[0]!, { resourceIds: ['inst-1', 'inst-1'] });
  assert.equal(code(validateDocument(withResources, 'TaskContract')), 'DUPLICATE_ID');

  Object.assign(withResources.spec.roles[0]!, { resourceIds: ['missing-res'] });
  assert.equal(code(validateDocument(withResources, 'TaskContract')), 'REFERENCE_UNKNOWN');
});

test('contract optional step onRework validates strict ancestor target and 1..8 maxReworks', () => {
  const baseline = contract();
  const baselineLock = value(admitTask(baseline, { admissionId: 'admission-1', runId: 'run-1' }));
  assert.equal(Object.hasOwn(baselineLock.spec.contract.spec.steps[0]!, 'onRework'), false);

  const pipeline = contract();
  pipeline.spec.steps = [
    { id: 'plan', kind: 'agent', uses: 'plan.step', roleId: 'builder', dependsOn: [] },
    { id: 'implement', kind: 'agent', uses: 'impl.step', roleId: 'builder', dependsOn: ['plan'] },
    { id: 'review', kind: 'agent', uses: 'review.step', roleId: 'builder', dependsOn: ['implement'] },
  ];
  Object.assign(pipeline.spec.steps[2]!, { onRework: { rejectTo: 'implement', maxReworks: 3 } });
  const parsed = value(validateDocument(pipeline, 'TaskContract'));
  assert.equal(Object.getPrototypeOf(parsed.spec.steps[2]!.onRework), null);
  assert.deepEqual({ ...parsed.spec.steps[2]!.onRework }, { rejectTo: 'implement', maxReworks: 3 });

  // Transitive ancestor ('plan') is also valid
  Object.assign(pipeline.spec.steps[2]!, { onRework: { rejectTo: 'plan', maxReworks: 8 } });
  assert.equal(validateDocument(pipeline, 'TaskContract').ok, true);

  // maxReworks bounds: 0, 9, float rejected with VALUE_RANGE
  for (const badMax of [0, 9, 1.5, -1]) {
    Object.assign(pipeline.spec.steps[2]!, { onRework: { rejectTo: 'implement', maxReworks: badMax } });
    assert.equal(code(validateDocument(pipeline, 'TaskContract')), 'VALUE_RANGE');
  }

  // Unknown rejectTo step -> REFERENCE_UNKNOWN
  Object.assign(pipeline.spec.steps[2]!, { onRework: { rejectTo: 'ghost', maxReworks: 2 } });
  assert.equal(code(validateDocument(pipeline, 'TaskContract')), 'REFERENCE_UNKNOWN');

  // Self-target or non-ancestor target -> GRAPH_CYCLE
  Object.assign(pipeline.spec.steps[2]!, { onRework: { rejectTo: 'review', maxReworks: 2 } });
  assert.equal(code(validateDocument(pipeline, 'TaskContract')), 'GRAPH_CYCLE');

  Object.assign(pipeline.spec.steps[0]!, { onRework: { rejectTo: 'implement', maxReworks: 2 } });
  Reflect.deleteProperty(pipeline.spec.steps[2]!, 'onRework');
  assert.equal(code(validateDocument(pipeline, 'TaskContract')), 'GRAPH_CYCLE');

  // Sibling non-ancestor target -> GRAPH_CYCLE
  const branched = contract();
  branched.spec.steps = [
    { id: 'root', kind: 'agent', uses: 'plan.step', roleId: 'builder', dependsOn: [] },
    { id: 'branch-a', kind: 'agent', uses: 'a.step', roleId: 'builder', dependsOn: ['root'] },
    { id: 'branch-b', kind: 'agent', uses: 'b.step', roleId: 'builder', dependsOn: ['root'] },
  ];
  Object.assign(branched.spec.steps[2]!, { onRework: { rejectTo: 'branch-a', maxReworks: 1 } });
  assert.equal(code(validateDocument(branched, 'TaskContract')), 'GRAPH_CYCLE');
});

test('contract supports at least 16 roles and 16 steps', () => {
  const input = contract();
  input.spec.roles = Array.from({ length: 16 }, (_, i) => ({
    ...input.spec.roles[0]!,
    id: `role-${i}`,
    tools: ['read'],
  }));
  input.spec.steps = Array.from({ length: 16 }, (_, i) => ({
    id: `step-${i}`,
    kind: 'agent',
    uses: 'agent.run',
    roleId: `role-${i}`,
    dependsOn: i === 0 ? [] : [`step-${i - 1}`],
  }));
  assert.equal(validateDocument(input, 'TaskContract').ok, true);
});

test('OVERLAY_LIMITS and resolveOverlayLimits validate configurable overlay ceilings', () => {
  assert.equal(OVERLAY_LIMITS.defaultMaxFiles, 128);
  assert.equal(OVERLAY_LIMITS.defaultMaxBytes, 4_194_304);
  assert.equal(OVERLAY_LIMITS.maxMaxFiles, 4_096);
  assert.equal(OVERLAY_LIMITS.maxMaxBytes, 67_108_864);

  assert.deepEqual(value(resolveOverlayLimits()), { maxFiles: 128, maxBytes: 4_194_304 });
  assert.deepEqual(value(resolveOverlayLimits({})), { maxFiles: 128, maxBytes: 4_194_304 });
  assert.deepEqual(value(resolveOverlayLimits({ maxFiles: 512, maxBytes: 16_777_216 })), { maxFiles: 512, maxBytes: 16_777_216 });
  assert.deepEqual(
    value(resolveOverlayLimits(Object.assign(Object.create(null), { maxFiles: 4_096, maxBytes: 67_108_864 }))),
    { maxFiles: 4_096, maxBytes: 67_108_864 },
  );

  for (const invalid of [
    { maxFiles: 0 },
    { maxFiles: 4_097 },
    { maxFiles: 128.5 },
    { maxFiles: NaN },
    { maxBytes: 512 },
    { maxBytes: 67_108_865 },
    { maxBytes: 4_194_304.5 },
  ]) {
    assert.equal(code(resolveOverlayLimits(invalid)), 'VALUE_RANGE', JSON.stringify(invalid));
  }
  assert.equal(code(resolveOverlayLimits({ maxFiles: 128, extra: true })), 'FIELD_UNKNOWN');
  for (const nonObject of ['not-an-object', null, [], 42]) {
    assert.equal(code(resolveOverlayLimits(nonObject)), 'VALUE_TYPE');
  }
});

test('TaskContract.spec.budgets.overlay is optional, omitted when unset, and bounded by OVERLAY_LIMITS', () => {
  const baseline = contract();
  const baseLock = value(admitTask(baseline, { admissionId: 'admission-1', runId: 'run-1' }));
  assert.equal(Object.hasOwn(baseLock.spec.contract.spec.budgets, 'overlay'), false);

  const widened = contract();
  Object.assign(widened.spec.budgets, { overlay: { maxFiles: 512, maxBytes: 16_777_216 } });
  const widenedLock = value(admitTask(widened, { admissionId: 'admission-1', runId: 'run-1' }));
  assert.deepEqual({ ...widenedLock.spec.contract.spec.budgets.overlay }, { maxFiles: 512, maxBytes: 16_777_216 });
  assert.notEqual(widenedLock.spec.contractHash.hex, baseLock.spec.contractHash.hex);

  for (const badOverlay of [
    { maxFiles: 0, maxBytes: 16_777_216 },
    { maxFiles: 4_097, maxBytes: 16_777_216 },
    { maxFiles: 512.5, maxBytes: 16_777_216 },
    { maxFiles: 512, maxBytes: 512 },
    { maxFiles: 512, maxBytes: 67_108_865 },
  ]) {
    const bad = contract();
    Object.assign(bad.spec.budgets, { overlay: badOverlay });
    assert.equal(code(validateDocument(bad, 'TaskContract')), 'VALUE_RANGE', JSON.stringify(badOverlay));
  }

  const partial = contract();
  Object.assign(partial.spec.budgets, { overlay: { maxFiles: 512 } });
  assert.equal(code(validateDocument(partial, 'TaskContract')), 'FIELD_REQUIRED');

  const extra = contract();
  Object.assign(extra.spec.budgets, { overlay: { maxFiles: 512, maxBytes: 16_777_216, extra: true } });
  assert.equal(code(validateDocument(extra, 'TaskContract')), 'FIELD_UNKNOWN');
});
