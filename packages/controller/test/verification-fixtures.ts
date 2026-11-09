import assert from 'node:assert/strict';
import { admitTask, bindSubject, digestArtifact, type ArtifactManifest, type ArtifactRef } from '@loopwright/core';
import { contract } from '../../core/test/fixtures.js';
import { canonical, hash, type Json } from '../src/schema.js';
import { descriptor, encodeInventory, encodePacket, type ByteHandler, type VerifierHeader } from '../src/verifier-protocol.js';
export function packetFixture(handler: ByteHandler = 'json-artifact.v1', sourceFiles = [{ name: 'packages/result.json', bytes: Buffer.from('{"ok":true}') }], candidateFiles = sourceFiles) {
  const task = contract(), lockResult = admitTask(task, { admissionId: 'admission-1', runId: 'run-1' }); assert.equal(lockResult.ok, true); if (!lockResult.ok) throw new Error('fixture');
  const manifest = (files: typeof sourceFiles): ArtifactManifest => ({ apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' }, spec: { entries: files.map(file => { const ref = digestArtifact(file.name, file.bytes); assert.equal(ref.ok, true); if (!ref.ok) throw new Error('fixture'); return ref.value; }) } });
  const source = manifest(sourceFiles), candidate = manifest(candidateFiles), subject = bindSubject(lockResult.value, candidate); assert.equal(subject.ok, true); if (!subject.ok) throw new Error('fixture');
  const ref = (name: string, value: ArtifactManifest) => ({ name, digest: hash(canonical(value)), byteLength: Buffer.byteLength(canonical(value)) });
  const selected = candidate.spec.entries.find(entry => entry.name === 'packages/result.json') ?? null;
  const parameters = handler === 'json-artifact.v1' ? { path: 'packages/result.json', expected: selected, required: ['ok'], equals: { ok: true }, sourceManifest: source, candidateManifest: candidate } : handler === 'scope.v1' ? { contract: task } : {};
  const header: VerifierHeader = { version: 1, jobId: 'job.one', handler, handlerVersion: 1, handlerDigest: hash('trusted-unit-handler'), checkId: 'tests', producerNonce: 'a'.repeat(32), operationId: 'verify.one', dispatchId: 'dispatch.one', generation: 0,
    subject: subject.value, source: descriptor(source, ref('source.bin', source)), candidate: descriptor(candidate, ref('candidate.bin', candidate)), parameters: parameters as unknown as Record<string, Json>, payloadKind: handler === 'json-artifact.v1' ? 'json' : 'inventories' };
  let payload: Uint8Array;
  if (handler === 'json-artifact.v1') { const bytes = candidateFiles.find(file => file.name === 'packages/result.json')?.bytes ?? Buffer.alloc(0); payload = new Uint8Array(4 + bytes.byteLength); new DataView(payload.buffer).setUint32(0, bytes.byteLength); payload.set(bytes, 4); }
  else { const first = encodeInventory(source), second = encodeInventory(candidate); payload = new Uint8Array(first.byteLength + second.byteLength); payload.set(first); payload.set(second, first.byteLength); }
  return { task, lock: lockResult.value, source, candidate, sourceFiles, candidateFiles, header, payload, packet: () => encodePacket(header, payload) };
}

/** Evidence only: original fixture bodies/maps are outside candidate roots and never grant producer authority. */
export async function retainInventoryInputs(artifacts: import('../src/storage.js').ArtifactStore, manifest: ArtifactManifest, ref: ArtifactRef, files: readonly { readonly name: string; readonly bytes: Uint8Array }[]): Promise<void> {
  const entries = [];
  for (const file of files) {
    const body = await artifacts.put('unit-input', file.bytes, 4194304), expected = manifest.spec.entries.find(entry => entry.name === file.name)!;
    assert.equal(body.byteLength, expected.byteLength); assert.equal(canonical(body.digest), canonical(expected.digest)); entries.push({ name: file.name, body });
  }
  const map = await artifacts.json('unit-input-map', { version: 1, kind: 'original-fixture-byte-inputs', manifest: ref, files: entries }, 1048576);
  const fs = await import('node:fs/promises'), path = await import('node:path'), index = path.join(artifacts.directory, 'unit-input-index.ndjson');
  await fs.appendFile(index, JSON.stringify({ manifest: ref, map }) + '\n', { mode: 0o600 }); const file = await fs.open(index, 'r'); try { await file.sync(); } finally { await file.close(); }
}
