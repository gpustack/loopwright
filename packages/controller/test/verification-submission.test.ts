import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSubmission, retainSubmission } from '../src/submission.js';
import { packetFixture } from './verification-fixtures.js';
import { retainedFixture } from './progress-fixtures.js';
import { hash } from '../src/schema.js';
import type { CapturedRole } from '../src/capture.js';
const task = packetFixture().lock.spec.contract;
const document = (reason: string | null = null) => ({ version: 1, status: 'completed', checks: [{ checkId: 'tests', status: 'passed', evidenceId: 'model.fake', reason: null }], reason });
test('submission parsing selects one entire document or exact outer json fence and rejects duplicate/extra/unknown claims', () => {
  const raw = JSON.stringify(document()), parsed = normalizeSubmission(Buffer.from(raw), task); assert.equal(parsed.status, 'completed'); assert.equal(parsed.checks[0]!.evidenceId, 'model.fake');
  assert.deepEqual(normalizeSubmission(Buffer.from('```json\n' + raw + '\n```'), task), parsed);
  for (const input of ['', 'prose ' + raw, raw + raw, '```\n' + raw + '\n```', '{"version":1,"status":"completed","\\u0073tatus":"failed","checks":[],"reason":null}', JSON.stringify({ ...document(), unknown: true }),
    JSON.stringify({ ...document(), checks: [document().checks[0], document().checks[0]] }), JSON.stringify({ ...document(), checks: [{ ...document().checks[0], checkId: 'not.registered' }] })]) assert.throws(() => normalizeSubmission(Buffer.from(input), task));
  assert.throws(() => normalizeSubmission(Uint8Array.from([255]), task)); assert.throws(() => normalizeSubmission(Buffer.alloc(1048577, 32), task));
});
test('top-level and check reasons preserve exact control-range boundaries, nonempty cap and astral text', () => {
  for (const code of [0, 9, 10, 13, 31, 127, 128, 159]) {
    const reason = 'before' + String.fromCharCode(code) + 'after'; assert.throws(() => normalizeSubmission(Buffer.from(JSON.stringify(document(reason))), task));
    assert.throws(() => normalizeSubmission(Buffer.from(JSON.stringify({ ...document(), checks: [{ checkId: 'tests', status: 'failed', evidenceId: null, reason }] })), task));
  }
  for (const reason of [String.fromCharCode(32), String.fromCharCode(126), String.fromCharCode(160), 'visible 😀 text', 'x'.repeat(4096)]) assert.equal(normalizeSubmission(Buffer.from(JSON.stringify(document(reason))), task).reason, reason);
  for (const reason of ['', 'x'.repeat(4097)]) assert.throws(() => normalizeSubmission(Buffer.from(JSON.stringify(document(reason))), task));
});
test('artifact/assistant selection preserves exact raw fencing bytes and refuses conflicting sources', async () => {
  const f = await retainedFixture();
  try {
    const raw = Buffer.from('  ```json\n' + JSON.stringify(document()) + '\n```  '), ref = await f.artifacts.put('submission', raw), stub = await f.artifacts.put('unit', Buffer.from('synthetic capture metadata'));
    const capture: CapturedRole = { checkpointId: 'unit', outcome: stub, originalManifest: stub, manifest: stub, digest: hash('unit'), workspace: stub, session: stub, submission: ref, artifacts: [{ name: 'response.json', bytes: raw }] };
    const retained = await retainSubmission(capture, { mode: 'artifact_or_assistant', path: 'response.json' }, f.plan.task, f.artifacts);
    assert.equal(retained.origin, 'both'); assert.equal(retained.raw.digest.hex, hash(raw).hex); assert.deepEqual(Buffer.from(await f.artifacts.read(retained.raw)), raw);
    await assert.rejects(retainSubmission({ ...capture, artifacts: [{ name: 'response.json', bytes: Buffer.from(JSON.stringify(document())) }] }, { mode: 'artifact_or_assistant', path: 'response.json' }, f.plan.task, f.artifacts));
    assert.equal((await retainSubmission({ ...capture, artifacts: [] }, { mode: 'artifact_or_assistant', path: 'response.json' }, f.plan.task, f.artifacts)).origin, 'assistant');
    await assert.rejects(retainSubmission({ ...capture, submission: null, artifacts: [] }, { mode: 'artifact_or_assistant', path: null }, f.plan.task, f.artifacts));
  } finally { await f.close(); }
});
