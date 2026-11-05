import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { admitTask, bindSubject, identifyManifest, validateDocument } from '../src/index.js';
import { contract, value, code } from './fixtures.js';

const admission = { admissionId: 'admission-1', runId: 'run-1' };
test('identity ignores record order but preserves meaningful arrays and every permission/limit', () => {
  const input = contract(), lock = value(admitTask(input, admission));
  const reorder = (item: unknown): unknown => Array.isArray(item) ? item.map(reorder)
    : item !== null && typeof item === 'object' ? Object.fromEntries(Object.entries(item).reverse().map(([key, child]) => [key, reorder(child)])) : item;
  assert.equal(value(admitTask(reorder(input), admission)).spec.contractHash.hex, lock.spec.contractHash.hex);
  for (const mutate of [
    (x: ReturnType<typeof contract>) => { x.spec.scope.writable.push('docs/**'); },
    (x: ReturnType<typeof contract>) => { x.spec.roles[0]!.model = 'other'; },
    (x: ReturnType<typeof contract>) => { x.spec.target.sourceRevision = 'source-2'; },
    (x: ReturnType<typeof contract>) => { x.spec.target.baseRevision = 'base-2'; },
    (x: ReturnType<typeof contract>) => { x.spec.budgets.maxFormatRepairs = 1; },
    (x: ReturnType<typeof contract>) => { x.spec.budgets.maxImplementationRepairs = 3; },
    (x: ReturnType<typeof contract>) => { x.spec.roles[0]!.tools.reverse(); },
    (x: ReturnType<typeof contract>) => { x.spec.roles[0]!.tools[0] = 'Read'; },
    (x: ReturnType<typeof contract>) => { x.spec.acceptance.checks.push({ id: 'scope', allowedEvidenceLevels: ['local_execution'] }); x.spec.acceptance.required.push('scope'); },
  ]) {
    const changed = contract(); mutate(changed);
    const next = value(admitTask(changed, admission));
    assert.notEqual(next.spec.contractHash.hex, lock.spec.contractHash.hex);
    assert.notEqual(next.spec.lockHash.hex, lock.spec.lockHash.hex);
  }
  assert.equal(value(admitTask(input, { ...admission, runId: 'run-2' })).spec.contractHash.hex, lock.spec.contractHash.hex);
  assert.notEqual(value(admitTask(input, { ...admission, runId: 'run-2' })).spec.lockHash.hex, lock.spec.lockHash.hex);
  assert.equal(validateDocument(lock, 'TaskLock').ok, true);
  const forged = structuredClone(lock); Object.assign(forged.spec, { contractHash: { algorithm: 'sha256', hex: '0'.repeat(64) } });
  assert.equal(code(validateDocument(forged, 'TaskLock')), 'HASH_MISMATCH');
});
test('identity canonical manifest has an independently specified hash domain vector', () => {
  const manifest = { spec: { entries: [] }, kind: 'ArtifactManifest', metadata: { id: 'empty' }, apiVersion: 'loopwright.dev/v1alpha1' };
  const canonical = '{"apiVersion":"loopwright.dev/v1alpha1","kind":"ArtifactManifest","metadata":{"id":"empty"},"spec":{"entries":[]}}';
  const expected = createHash('sha256').update('loopwright.dev/artifact-manifest/v1alpha1\0' + canonical).digest('hex');
  assert.equal(value(identifyManifest(manifest)).digest.hex, expected);
});
test('identity binds explicit base/source while candidate byte identity can stay fixed', () => {
  const input = contract(), manifest = { apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' }, spec: { entries: [] } };
  const old = value(bindSubject(value(admitTask(input, admission)), manifest));
  input.spec.target.baseRevision = 'base-2';
  const changed = value(bindSubject(value(admitTask(input, admission)), manifest));
  assert.notEqual(changed.lockHash.hex, old.lockHash.hex);
  assert.equal(changed.candidateDigest.hex, old.candidateDigest.hex);
  assert.equal(changed.sourceRevision, old.sourceRevision);
  input.spec.target.baseRevision = input.spec.target.sourceRevision;
  assert.equal(admitTask(input, admission).ok, true);
});

test('identity admitted lock stays frozen after author and returned collection mutation attempts', () => {
  const input = contract(); const lock = value(admitTask(input, admission));
  const original = lock.spec.contractHash.hex;
  input.spec.acceptance.required.push('other'); input.spec.roles[0]!.tools.push('bash');
  assert.equal(lock.spec.contractHash.hex, original);
  assert.equal(lock.spec.contract.spec.roles[0]!.tools.length, 2);
  assert.equal(Reflect.set(lock.spec.contract.spec.budgets, 'maxModelCalls', 999), false);
  assert.equal(lock.spec.contract.spec.budgets.maxModelCalls, 10);
  assert.throws(() => (lock.spec.contract.spec.acceptance.required as string[]).push('other'), TypeError);
  assert.equal(validateDocument(lock, 'TaskLock').ok, true);
});
