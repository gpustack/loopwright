import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, chmod, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digestArtifact } from '@loopwright/core';
import { Candidate } from '../src/candidate.js';
import { sessionInput } from './session-fixtures.js';
async function fixture() {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'loopwright-candidate-')), root = join(directory, 'candidate'), input = sessionInput();
  const protectedBytes = Buffer.from('PROTECTED_ORIGINAL'), ref = digestArtifact('packages/policy/settings.ts', protectedBytes); assert.equal(ref.ok, true); if (!ref.ok) throw new Error('fixture artifact');
  const raw = structuredClone(input) as unknown as { candidate: { artifacts: { name: string; bytes: Uint8Array }[]; manifest: { spec: { entries: unknown[] } } } }; raw.candidate.artifacts.push({ name: ref.value.name, bytes: protectedBytes }); raw.candidate.manifest.spec.entries.push(ref.value);
  for (const file of raw.candidate.artifacts) { await mkdir(join(root, file.name, '..'), { recursive: true }); await writeFile(join(root, file.name), file.bytes, { mode: 0o444 }); }
  await mkdir(join(directory, 'outside')); const candidate = new Candidate(root, raw as unknown as typeof input);
  const write = async (name: string, content = 'NEW') => { const change = await candidate.prepareWrite(name, content); await candidate.commit(change, () => {}); };
  return { directory, root, candidate, write, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
test('candidate permits a scoped new regular file', async () => {
  const f = await fixture(); try { await f.write('packages/new.ts', 'ALLOWED'); assert.equal(await readFile(join(f.root, 'packages/new.ts'), 'utf8'), 'ALLOWED'); } finally { await f.cleanup(); }
});
test('protected, protected-case aliases and traversal deny before a file effect', async () => {
  for (const name of ['packages/policy/new.ts', 'packages/policy/settings.ts', 'packages/POLICY/new.ts', '../outside/new.ts', 'not-allowed.ts']) {
    const f = await fixture(); try { await assert.rejects(f.write(name)); assert.equal(await readFile(join(f.root, 'packages/policy/settings.ts'), 'utf8'), 'PROTECTED_ORIGINAL'); } finally { await f.cleanup(); }
  }
});
test('an ancestor symlink cannot redirect an allowed new path outside the candidate', async () => {
  const f = await fixture(); try { await symlink(join(f.directory, 'outside'), join(f.root, 'packages/escape')); await assert.rejects(f.write('packages/escape/new.ts')); await assert.rejects(readFile(join(f.directory, 'outside/new.ts'))); } finally { await f.cleanup(); }
});
test('hard-linked existing files are rejected before either link can change', async () => {
  const f = await fixture(); try { const original = await readFile(join(f.root, 'packages/example.ts')); await chmod(join(f.root, 'packages/example.ts'), 0o644); await link(join(f.root, 'packages/example.ts'), join(f.directory, 'outside/linked.ts')); await assert.rejects(f.write('packages/example.ts')); assert.deepEqual(await readFile(join(f.directory, 'outside/linked.ts')), original); } finally { await f.cleanup(); }
});
test('edit commits exact disjoint replacements and publishes the resulting manifest digest', async () => {
  const f = await fixture();
  try {
    const change = await f.candidate.prepareEdit('packages/example.ts', [{ oldText: 'value', newText: 'updated' }, { oldText: '1', newText: '2' }]);
    await f.candidate.commit(change, () => {}); const bytes = await readFile(join(f.root, 'packages/example.ts')); assert.equal(bytes.toString(), 'export const updated = 2;\n');
    const ref = digestArtifact('packages/example.ts', bytes); assert.equal(ref.ok, true); if (ref.ok) assert.deepEqual((await f.candidate.manifest()).spec.entries.find(entry => entry.name === ref.value.name), ref.value);
    await assert.rejects(f.candidate.commit(change, () => {}));
  } finally { await f.cleanup(); }
});
test('guard refusal, changed old bytes and ambiguous edits cannot replace a candidate file', async () => {
  const f = await fixture();
  try {
    const original = await readFile(join(f.root, 'packages/example.ts'));
    const guarded = await f.candidate.prepareWrite('packages/guarded.ts', 'DENIED'); await assert.rejects(f.candidate.commit(guarded, () => { throw new Error('current owner refused'); })); await assert.rejects(readFile(join(f.root, 'packages/guarded.ts')));
    await assert.rejects(f.candidate.prepareEdit('packages/example.ts', [{ oldText: 'value =', newText: 'a' }, { oldText: '= 1', newText: 'b' }])); assert.deepEqual(await readFile(join(f.root, 'packages/example.ts')), original);
    const stale = await f.candidate.prepareWrite('packages/example.ts', 'REPLACEMENT'); await chmod(join(f.root, 'packages/example.ts'), 0o644); await writeFile(join(f.root, 'packages/example.ts'), 'CHANGED_BY_OTHER_OWNER');
    await assert.rejects(f.candidate.commit(stale, () => {})); assert.equal(await readFile(join(f.root, 'packages/example.ts'), 'utf8'), 'CHANGED_BY_OTHER_OWNER');
  } finally { await f.cleanup(); }
});
