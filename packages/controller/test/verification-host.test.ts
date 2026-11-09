import { retainInventoryInputs } from './verification-fixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { admitTask, bindSubject, digestArtifact, type ArtifactManifest } from '@loopwright/core';
import { retainedFixture } from './progress-fixtures.js';
import { Verifier, prepareVerification, authenticatedCheck, type VerifiedCheck } from '../src/verification.js';
import { journal } from '../src/progress.js';
import { canonical, hash } from '../src/schema.js';
import { HEADER_BYTES, JSON_FILE_BYTES } from '../src/verifier-protocol.js';
import { reopenLocalRun } from '@loopwright/state';
import { stateValue } from '../src/storage.js';
async function verifierFixture(files = [{ name: 'result.json', bytes: Buffer.from('{"ok":true}') }]) {
  const f = await retainedFixture(), entries = files.map(file => { const result = digestArtifact(file.name, file.bytes); assert.equal(result.ok, true); if (!result.ok) throw new Error('fixture'); return result.value; });
  const manifest: ArtifactManifest = { apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' }, spec: { entries } }, ref = await f.artifacts.json('manifest', manifest, 32768);
  await retainInventoryInputs(f.artifacts, manifest, ref, files);
  const inventory = { manifest, ref, files }, bound = bindSubject(f.lock, manifest); assert.equal(bound.ok, true); if (!bound.ok) throw new Error('fixture');
  return { ...f, inventory, subject: bound.value, job: () => prepareVerification(f.plan, f.lock, 'check.tests', inventory, inventory, 0, 'c'.repeat(32)) };
}
test('real S02 read-only permit and actual fixed Worker produce one private authenticated receipt, never a reusable permit', async () => {
  const f = await verifierFixture();
  try {
    const before = journal(f.store), prepared = f.job(), verifier = new Verifier(f.store, f.authority, f.artifacts, f.plan, f.lock, () => f.subject), checked = await verifier.run(prepared, new AbortController().signal);
    assert.equal(checked.status, 'passed'); assert.equal(checked.generation, 0); const evidence = authenticatedCheck(checked); assert.equal(evidence.evidence.spec.method, 'verify_json'); assert.equal(evidence.evidence.spec.level, 'local_execution');
    const after = journal(f.store); assert.equal(after.operations.length, 1); assert.equal(after.operations[0]!.state, 'confirmed'); assert.equal(after.view.counts.requests, 0); assert.deepEqual(after.view.ledger, before.view.ledger);
    assert.throws(() => authenticatedCheck({ ...checked })); await assert.rejects(verifier.run(prepared, new AbortController().signal)); assert.equal(journal(f.store).operations.length, 1);
    const output = JSON.parse(Buffer.from(await f.artifacts.read(checked.output)).toString()) as { observation: { threadId: number; exit: number; limits: unknown }; packetDigest: unknown };
    assert.ok(output.observation.threadId > 0); assert.equal(output.observation.exit, 0); assert.deepEqual(output.observation.limits, { oldMb: 64, youngMb: 8, stackMb: 2 });
    const key = hash(checked.operationId + '\0' + checked.producerNonce).hex; assert.ok((await readFile(join(f.artifacts.directory, 'producer-' + key + '.binding.json'))).length > 0); assert.ok((await readFile(join(f.artifacts.directory, 'producer-' + key + '.proof.json'))).length > 0);
    const binding = JSON.parse(await readFile(join(f.artifacts.directory, 'producer-' + key + '.binding.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(Object.hasOwn(binding, 'permit'), false); assert.deepEqual(Object.keys(binding.dispatchReceipt as object).sort(), ['clockEpoch', 'dispatchId', 'generation', 'revision']);
    await writeFile(join(f.directory, 'verifier-result.json'), canonical({ version: 1, kind: 'real-s02-worker-component', nativeAgentExecution: false, checked, evidence: evidence.evidence, observation: output.observation, noModelRequest: true }), { mode: 0o600 });
  } finally { await f.close(); }
});
test('forged handles and substituted producer/nonce/subject/dispatch output cannot enter eligible evidence', async () => {
  for (const field of ['producerNonce', 'dispatchId', 'subject', 'packetDigest'] as const) {
    const f = await verifierFixture();
    try {
      const verifier = new Verifier(f.store, f.authority, f.artifacts, f.plan, f.lock, () => f.subject, { afterReply: bytes => {
        const reply = JSON.parse(Buffer.from(bytes).toString()) as Record<string, unknown>;
        reply[field] = field === 'subject' ? { ...f.subject, candidateDigest: hash('stale candidate') } : field === 'packetDigest' ? hash('another job') : 'wrong'; return Buffer.from(canonical(reply));
      } });
      await assert.rejects(verifier.run(f.job(), new AbortController().signal)); assert.throws(() => authenticatedCheck({ status: 'passed' } as VerifiedCheck));
      const after = journal(f.store); assert.equal(after.operations.length, 1); assert.notEqual(after.operations[0]!.state, 'confirmed'); assert.equal(after.view.counts.requests, 0);
    } finally { await f.close(); }
  }
});
test('a coherently substituted packet cannot authenticate itself against the retained original job', async () => {
  const f = await verifierFixture();
  try {
    const verifier = new Verifier(f.store, f.authority, f.artifacts, f.plan, f.lock, () => f.subject, { beforeWorker: bytes => {
      const size = new DataView(bytes.buffer).getUint32(0), header = JSON.parse(Buffer.from(bytes.subarray(4, 4 + size)).toString()) as Record<string, unknown>;
      header.producerNonce = 'd'.repeat(32); const text = canonical(header); assert.equal(Buffer.byteLength(text), size); bytes.fill(0, 4, 4 + HEADER_BYTES); Buffer.from(bytes.buffer).write(text, 4, 'utf8');
    } });
    await assert.rejects(verifier.run(f.job(), new AbortController().signal)); assert.equal(journal(f.store).operations[0]!.state, 'dispatch_uncertain');
  } finally { await f.close(); }
});
test('file/header overflow and pre-dispatch cancellation create zero verifier intents or Workers', async () => {
  const large = await verifierFixture([{ name: 'result.json', bytes: Buffer.alloc(JSON_FILE_BYTES + 1, 32) }]);
  try { const before = journal(large.store); assert.throws(large.job); assert.deepEqual(journal(large.store).view.counts, before.view.counts); } finally { await large.close(); }
  const many = await verifierFixture([{ name: 'result.json', bytes: Buffer.from('{"ok":true}') }, ...Array.from({ length: 79 }, (_, index) => ({ name: 'packages/file-' + index, bytes: Buffer.from('x') }))]);
  try { const before = journal(many.store); assert.throws(many.job); assert.deepEqual(journal(many.store).view.counts, before.view.counts); } finally { await many.close(); }
  const f = await verifierFixture();
  try {
    const aborted = new AbortController(); aborted.abort(); const before = journal(f.store), verifier = new Verifier(f.store, f.authority, f.artifacts, f.plan, f.lock, () => f.subject);
    await assert.rejects(verifier.run(f.job(), aborted.signal)); assert.deepEqual(journal(f.store).view.counts, before.view.counts);
  } finally { await f.close(); }
});
test('synced original producer receipt adopts after actual S02 reopen with no new Worker or permit', async () => {
  const f = await verifierFixture(); let workers = 0;
  try {
    const job = f.job(), original = new Verifier(f.store, f.authority, f.artifacts, f.plan, f.lock, () => f.subject, { beforeWorker: () => { workers++; }, afterReceiptBytes: () => { throw new Error('planned receipt ACK loss'); } });
    await assert.rejects(original.run(job, new AbortController().signal)); assert.equal(workers, 1); const before = journal(f.store); assert.equal(before.operations[0]!.state, 'dispatch_uncertain');
    stateValue(f.store.close()); const store = stateValue(reopenLocalRun(f.identity));
    try {
      const verifier = new Verifier(store, f.authority, f.artifacts, f.plan, f.lock, () => f.subject, { beforeWorker: () => { workers++; } }), recovered = await verifier.restore(f.job()), again = await verifier.restore(f.job());
      assert.equal(recovered.status, 'passed'); assert.equal(canonical(recovered), canonical(again)); assert.equal(workers, 1); const after = journal(store);
      assert.equal(after.operations.length, 1); assert.equal(after.operations[0]!.state, 'confirmed'); assert.deepEqual(after.view.ledger, before.view.ledger); assert.deepEqual(after.view.clock.basis, before.view.clock.basis);
      await assert.rejects(verifier.run(f.job(), new AbortController().signal)); assert.equal(workers, 1);
      await writeFile(join(f.directory, 'producer-recovery-result.json'), canonical({ version: 1, kind: 'real-worker-s02-receipt-adoption', nativeAgentExecution: false, recovered, again, workers, originalClock: after.view.clock.basis, originalLedger: after.view.ledger, originalOperation: after.operations[0] }), { mode: 0o600 });
    } finally { stateValue(store.close()); }
  } finally { await f.close(); }
});
test('corrupt private producer proof or matching candidate-visible bytes cannot authorize restoration', async () => {
  for (const kind of ['corrupt', 'candidate-copy'] as const) {
    const f = await verifierFixture(); let workers = 0;
    try {
      const verifier = new Verifier(f.store, f.authority, f.artifacts, f.plan, f.lock, () => f.subject, { beforeWorker: () => { workers++; } }), checked = await verifier.run(f.job(), new AbortController().signal);
      const proof = join(f.artifacts.directory, 'producer-' + hash(checked.operationId + '\0' + checked.producerNonce).hex + '.proof.json');
      if (kind === 'corrupt') { const value = JSON.parse(await readFile(proof, 'utf8')) as { evidence: { metadata: { id: string } } }; value.evidence.metadata.id = 'forged'; await writeFile(proof, canonical(value)); }
      else await rename(proof, join(f.taskDirectory, 'verification.json'));
      await assert.rejects(verifier.restore(f.job())); assert.equal(workers, 1); assert.equal(journal(f.store).operations.length, 1);
      await writeFile(join(f.directory, 'producer-refusal-result.json'), canonical({ version: 1, kind, restoreRefused: true, workers, originalOperationCount: 1 }), { mode: 0o600 });
    } finally { await f.close(); }
  }
});
test('another run lock or plan cannot create a verifier intent in the original guarded store', async () => {
  const f = await verifierFixture();
  try {
    const other = admitTask(f.plan.task, { admissionId: 'other-admission', runId: 'other-run' }); assert.equal(other.ok, true); if (!other.ok) throw new Error('fixture');
    const subject = bindSubject(other.value, f.inventory.manifest); assert.equal(subject.ok, true); if (!subject.ok) throw new Error('fixture');
    const wrongRun = new Verifier(f.store, f.authority, f.artifacts, f.plan, other.value, () => subject.value), before = journal(f.store);
    await assert.rejects(wrongRun.run(prepareVerification(f.plan, other.value, 'check.tests', f.inventory, f.inventory, 0, 'c'.repeat(32)), new AbortController().signal));
    const plan = { ...f.plan, planDigest: hash('another plan') }, wrongPlan = new Verifier(f.store, f.authority, f.artifacts, plan, f.lock, () => f.subject);
    await assert.rejects(wrongPlan.run(prepareVerification(plan, f.lock, 'check.tests', f.inventory, f.inventory, 0, 'c'.repeat(32)), new AbortController().signal));
    assert.deepEqual(journal(f.store).view.counts, before.view.counts);
  } finally { await f.close(); }
});
