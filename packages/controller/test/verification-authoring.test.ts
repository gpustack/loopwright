import test from 'node:test';
import assert from 'node:assert/strict';
import { configurationFixture } from './config-fixtures.js';
import { setFixture } from './progress-fixtures.js';
import { compilePlan } from '../src/compile.js';
async function eligibility(kind: 'required' | 'optional' | 'disallowed' | 'wrong_handler' | 'absent' | 'multiple') {
  const f = await configurationFixture();
  try {
    if (kind !== 'absent') {
      const prototype = f.registry.spec.handlers.find(item => item.implementation === (kind === 'wrong_handler' ? 'json-artifact.v1' : 'no-change.v1'))!;
      const ids = kind === 'multiple' ? ['zeta', 'alpha'] : ['unchanged'];
      setFixture(f.registry, ['spec', 'handlers'], [...f.registry.spec.handlers, ...ids.map(id => ({ ...prototype, id: 'predicate.' + id, parameters: kind === 'wrong_handler' ? { ...prototype.parameters, checkId: id } : { checkId: id } }))]);
      setFixture(f.config, ['spec', 'task', 'spec', 'acceptance'], { required: ['tests', ...(kind === 'optional' ? [] : ids)], checks: [...f.config.spec.task.spec.acceptance.checks,
        ...ids.map(id => ({ id, allowedEvidenceLevels: kind === 'disallowed' ? ['external_service'] : ['local_execution'] }))] });
    }
    await f.save(); const loaded = await f.load(); assert.equal(loaded.ok, true); if (!loaded.ok) throw new Error('fixture');
    const compiled = await compilePlan(loaded.value); assert.equal(compiled.ok, true); if (!compiled.ok) throw new Error('fixture');
    assert.equal(compiled.value.runId, null); assert.equal(compiled.value.admission, 'not_performed'); assert.deepEqual(compiled.value.task, loaded.value.configuration.spec.task);
    return compiled.value.noChangeEligibility;
  } finally { await f.cleanup(); }
}
test('static no-change eligibility requires an original required registered local-execution predicate', async () => {
  assert.deepEqual(await eligibility('required'), { available: true, checkId: 'unchanged', reason: null });
  for (const kind of ['absent', 'optional', 'disallowed', 'wrong_handler'] as const) assert.deepEqual(await eligibility(kind), { available: false, checkId: null, reason: 'original_required_no_change_check_missing' });
});
test('static no-change selection is lexical before outcomes and independent of registry order', async () => {
  assert.deepEqual(await eligibility('multiple'), { available: true, checkId: 'alpha', reason: null });
});
