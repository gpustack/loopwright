import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { evaluatePacket, encodePacket, HEADER_BYTES, JSON_FILE_BYTES, packetSize, AllocationQuota, type VerifierHeader } from '../src/verifier-protocol.js';
import { canonical, hash, type Json } from '../src/schema.js';
import { packetFixture } from './verification-fixtures.js';
test('fixed actual Worker validates complete multi-file JSON membership and complete candidate bytes', async () => {
  const f = packetFixture('json-artifact.v1', [{ name: 'packages/other', bytes: Buffer.from('inert') }, { name: 'packages/result.json', bytes: Buffer.from('{"ok":true}') }]), bytes = f.packet();
  const worker = new Worker(new URL('../src/verifier-worker.js', import.meta.url), { workerData: bytes, transferList: [bytes.buffer], env: {}, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 } });
  const limits = { ...worker.resourceLimits };
  const exited = new Promise<number>((resolve, reject) => { worker.once('exit', resolve); worker.once('error', reject); });
  const message = await new Promise<Uint8Array>((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); }); assert.ok(message instanceof Uint8Array);
  const reply = JSON.parse(Buffer.from(message).toString()) as { status: string; method: string; packetDigest: unknown; allocationBytes: number };
  assert.equal(reply.status, 'passed'); assert.equal(reply.method, 'verify_json'); assert.deepEqual(reply.packetDigest, hash(f.packet())); assert.ok(reply.allocationBytes <= 8388608);
  assert.equal(await exited, 0); assert.equal(limits.maxOldGenerationSizeMb, 64); assert.equal(limits.maxYoungGenerationSizeMb, 8); assert.equal(limits.stackSizeMb, 2);
});
test('complete source/candidate 4-MiB hashes and the last-byte mutation change the independent no-change predicate', () => {
  const original = Buffer.alloc(4194304, 97), changed = Buffer.from(original); changed[changed.length - 1] = 98;
  const source = [{ name: 'packages/large', bytes: original }], same = packetFixture('no-change.v1', source), altered = packetFixture('no-change.v1', source, [{ name: 'packages/large', bytes: changed }]);
  assert.equal(evaluatePacket(same.packet()).status, 'passed'); const result = evaluatePacket(altered.packet()); assert.equal(result.status, 'failed'); assert.equal(result.reason, 'candidate_changed');
  assert.notEqual(same.header.subject.candidateDigest.hex, altered.header.subject.candidateDigest.hex); assert.ok(same.packet().byteLength <= 81932);
});
test('scope independently checks every addition/deletion/change through original core scope', () => {
  const f = packetFixture('scope.v1', [{ name: 'packages/old', bytes: Buffer.from('before') }], [{ name: 'packages/new', bytes: Buffer.from('after') }]); assert.equal(evaluatePacket(f.packet()).status, 'passed');
  const protectedFile = packetFixture('scope.v1', [], [{ name: 'packages/policy/deny', bytes: Buffer.from('after') }]); assert.equal(evaluatePacket(protectedFile.packet()).reason, 'outside_scope');
});
test('missing paths and present-empty files are distinct verified failed predicates', () => {
  const missing = packetFixture('json-artifact.v1', []), empty = packetFixture('json-artifact.v1', [{ name: 'packages/result.json', bytes: Buffer.alloc(0) }]);
  assert.equal(evaluatePacket(missing.packet()).reason, 'missing_file'); assert.equal(evaluatePacket(empty.packet()).reason, 'invalid_json');
  const forged = { ...empty.header, parameters: { ...empty.header.parameters, expected: null } }; assert.throws(() => evaluatePacket(encodePacket(forged, empty.payload)));
});
test('manifest document, entry count/order and selected membership substitutions refuse', () => {
  const f = packetFixture('json-artifact.v1', [{ name: 'packages/other', bytes: Buffer.from('other') }, { name: 'packages/result.json', bytes: Buffer.from('{"ok":true}') }]);
  for (const header of [
    { ...f.header, candidate: { ...f.header.candidate, entryCount: 1 } },
    { ...f.header, candidate: { ...f.header.candidate, metadataId: 'wrong' } },
    { ...f.header, candidate: { ...f.header.candidate, ref: { ...f.header.candidate.ref, byteLength: f.header.candidate.ref.byteLength + 1 } } },
    { ...f.header, parameters: { ...f.header.parameters, expected: f.candidate.spec.entries[0]! as unknown as Json } },
    { ...f.header, parameters: { ...f.header.parameters, candidateManifest: { ...f.candidate, spec: { entries: f.candidate.spec.entries.slice(1) } } as unknown as Json } },
    { ...f.header, parameters: { ...f.header.parameters, candidateManifest: { ...f.candidate, spec: { entries: [...f.candidate.spec.entries].reverse() } } as unknown as Json } },
    { ...f.header, parameters: { ...f.header.parameters, candidateManifest: { ...f.candidate, spec: { entries: [f.candidate.spec.entries[0]!, f.candidate.spec.entries[0]!] } } as unknown as Json } },
    { ...f.header, subject: { ...f.header.subject, candidateDigest: hash('wrong core domain') } },
  ]) assert.throws(() => evaluatePacket(encodePacket(header, f.payload)));
  const corrupt = f.packet(); corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1; assert.throws(() => evaluatePacket(corrupt));
});
test('inventory omissions, duplicate paths, truncation, nonzero header padding and trailing data refuse', () => {
  const f = packetFixture('no-change.v1'), truncated = f.packet().slice(0, -1); assert.throws(() => evaluatePacket(truncated));
  const omitted = f.packet(); new DataView(omitted.buffer).setUint32(4 + HEADER_BYTES, 0); assert.throws(() => evaluatePacket(omitted));
  const padding = f.packet(), length = new DataView(padding.buffer).getUint32(0); padding[4 + length] = 1; assert.throws(() => evaluatePacket(padding));
  const trailing = new Uint8Array(f.packet().length + 1); trailing.set(f.packet()); assert.throws(() => evaluatePacket(trailing));
});
test('the exact complete JSON packet succeeds and one-byte-over preflight refuses', () => {
  const body = Buffer.from('{"ok":true}' + ' '.repeat(JSON_FILE_BYTES - 11)), f = packetFixture('json-artifact.v1', [{ name: 'packages/result.json', bytes: body }]);
  assert.equal(body.byteLength, JSON_FILE_BYTES); assert.equal(packetSize(f.header, f.payload.byteLength), 1048576); assert.equal(f.packet().byteLength, 1048576); assert.equal(evaluatePacket(f.packet()).status, 'passed');
  const bigger = packetFixture('json-artifact.v1', [{ name: 'packages/result.json', bytes: Buffer.concat([body, Buffer.from(' ')]) }]); assert.throws(() => packetSize(bigger.header, bigger.payload.byteLength)); assert.throws(() => bigger.packet());
});
function exactHeader(extra = 0) {
  let low = 0, high = 16000;
  while (low <= high) {
    const fill = Math.floor((low + high) / 2);
    const f = packetFixture('json-artifact.v1', [{ name: 'packages/result.json', bytes: Buffer.from(JSON.stringify({ padding: 'x'.repeat(fill) })) }]);
    const header: VerifierHeader = { ...f.header, jobId: 'x'.repeat(64), operationId: 'x'.repeat(64), dispatchId: 'x'.repeat(64), generation: 16, parameters: { ...f.header.parameters, required: ['padding'], equals: { padding: 'x'.repeat(fill) } } };
    const size = Buffer.byteLength(canonical(header)); if (size === HEADER_BYTES + extra) return { ...f, header }; if (size > HEADER_BYTES + extra) high = fill - 1; else low = fill + 1;
  }
  throw new Error('valid exact header fixture unavailable');
}
test('a valid maximal-framing exact header is accepted and one-byte-over complete header refuses', () => {
  const fitting = exactHeader(); assert.equal(Buffer.byteLength(canonical(fitting.header)), HEADER_BYTES); packetSize(fitting.header, fitting.payload.byteLength);
  assert.equal(evaluatePacket(encodePacket(fitting.header, fitting.payload)).status, 'passed');
  const overflow = exactHeader(1); assert.equal(Buffer.byteLength(canonical(overflow.header)), HEADER_BYTES + 1); assert.throws(() => packetSize(overflow.header, overflow.payload.byteLength));
});
test('application-controlled buffer quota refuses overflow and is independent of an RSS claim', () => {
  const quota = new AllocationQuota(); quota.allocate(8388608); assert.throws(() => quota.allocate(1)); assert.equal(quota.used, 8388609);
});
