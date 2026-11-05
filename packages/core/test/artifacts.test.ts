import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { digestArtifact, identifyManifest, LIMITS } from '../src/index.js';
import { value, code } from './fixtures.js';

test('artifact digest uses original bytes and declared length', () => {
  const digest = value(digestArtifact('candidate.patch', Buffer.from('abc')));
  assert.equal(digest.digest.hex, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(digest.byteLength, 3);
  assert.notEqual(value(digestArtifact('candidate.patch', Buffer.from('abc\n'))).digest.hex, digest.digest.hex);
  let calls = 0;
  const bytes = new Uint8Array([97, 98, 99]);
  Object.defineProperty(bytes, 'buffer', { get() { calls++; throw new Error('getter'); } });
  assert.equal(value(digestArtifact('candidate.patch', bytes)).digest.hex, digest.digest.hex);
  assert.equal(calls, 0);
});
test('artifact manifest rejects normalized name collisions and file/child ambiguity', () => {
  const manifest = (names: string[]) => ({ apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' }, spec: { entries: names.map(name => value(digestArtifact(name, new Uint8Array()))) } });
  for (const names of [['a', 'a'], ['A', 'a'], ['a', 'a-b', 'a/child']]) {
    assert.equal(code(identifyManifest(manifest(names))), 'MANIFEST_AMBIGUOUS');
  }
  assert.equal(identifyManifest(manifest(['a', 'b'])).ok, true);
});
test('artifact hashing bounds bytes and rejects shared/detached/unsupported views', () => {
  assert.equal(digestArtifact('x', new Uint8Array(LIMITS.artifactBytes)).ok, true);
  assert.equal(code(digestArtifact('x', new Uint8Array(LIMITS.artifactBytes + 1))), 'LIMIT_ARTIFACT_BYTES');
  assert.equal(code(digestArtifact('x', new Uint8Array(new SharedArrayBuffer(1)))), 'INPUT_UNSUPPORTED');
  assert.equal(code(digestArtifact('x', new Uint16Array(1) as unknown as Uint8Array)), 'INPUT_UNSUPPORTED');
  const bytes = new Uint8Array(1); structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
  assert.equal(code(digestArtifact('x', bytes)), 'INPUT_UNSUPPORTED');
});

test('artifact manifest entry limit is exact', () => {
  const manifest = { apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' },
    spec: { entries: Array.from({ length: LIMITS.manifest }, (_, i) => value(digestArtifact('file-' + i, new Uint8Array()))) } };
  assert.equal(identifyManifest(manifest).ok, true);
  manifest.spec.entries.push(value(digestArtifact('extra', new Uint8Array())));
  assert.equal(code(identifyManifest(manifest)), 'VALUE_RANGE');
});

test('artifact shared-buffer rejection uses native brand across realms', () => {
  const foreign = runInNewContext('new SharedArrayBuffer(4)') as SharedArrayBuffer;
  assert.equal(code(digestArtifact('x', new Uint8Array(foreign))), 'INPUT_UNSUPPORTED');
});
