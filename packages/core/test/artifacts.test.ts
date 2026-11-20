import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import {
  admitTask, bindSubject, digestArtifact, digestArtifactFromMetadata, evaluateAcceptance, identifyManifest, resolveInventory,
  LIMITS, OVERLAY_LIMITS, validateDocument,
  type ArtifactManifest, type ArtifactMetadataInput, type BaseTreeAnchor, type Digest, type ResolvedArtifactInput, type VerifiedArtifactDescriptor,
} from '../src/index.js';
import { createLocalRun, reopenLocalRun } from '../../state/src/index.js';
import { contract, evaluationFixture, value, code } from './fixtures.js';

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

function sha1Anchor(commit = 'a'.repeat(40), tree = 'b'.repeat(40)): BaseTreeAnchor {
  return { objectFormat: 'sha1', commitOid: commit, treeOid: tree };
}

function sha256Anchor(commit = 'c'.repeat(64), tree = 'd'.repeat(64)): BaseTreeAnchor {
  return { objectFormat: 'sha256', commitOid: commit, treeOid: tree };
}

function overlayManifest(
  baseTree: unknown,
  entries: readonly string[],
  deleted: readonly string[],
): unknown {
  return {
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'ArtifactManifest',
    metadata: { id: 'candidate' },
    spec: {
      baseTree,
      entries: entries.map(name => value(digestArtifact(name, Buffer.from(name)))),
      deleted: [...deleted],
    },
  };
}

function sortedNames(count: number, prefix: string): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}-${String(i).padStart(3, '0')}`).sort();
}

test('core LIMITS defines overlayEntries=128, baselineEntries=65536, and classic manifest=256', () => {
  assert.equal(LIMITS.manifest, 256);
  assert.equal(LIMITS.overlayEntries, 128);
  assert.equal(LIMITS.baselineEntries, 65_536);
});

test('classic manifest keeps exact key-only spec and bit-for-bit candidateDigest compatibility', () => {
  const raw = {
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'ArtifactManifest',
    metadata: { id: 'candidate' },
    spec: { entries: [value(digestArtifact('b.txt', Buffer.from('beta'))), value(digestArtifact('a.txt', Buffer.from('alpha')))] },
  };
  const parsed = value(validateDocument(raw, 'ArtifactManifest'));
  assert.deepEqual(Object.keys(parsed.spec), ['entries']);
  assert.equal(Object.hasOwn(parsed.spec, 'baseTree'), false);
  assert.equal(Object.hasOwn(parsed.spec, 'deleted'), false);
  assert.equal(parsed.spec.baseTree, undefined);
  assert.equal(parsed.spec.deleted, undefined);

  const canonicalExpected = JSON.stringify({
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'ArtifactManifest',
    metadata: { id: 'candidate' },
    spec: { entries: raw.spec.entries.map(e => ({ byteLength: e.byteLength, digest: e.digest, name: e.name })) },
  });
  const expectedHex = createHash('sha256').update('loopwright.dev/artifact-manifest/v1alpha1\0' + canonicalExpected).digest('hex');
  assert.equal(value(identifyManifest(raw)).digest.hex, expectedHex);

  const lock = value(admitTask(contract(), { admissionId: 'admission-1', runId: 'run-1' }));
  const subject = value(bindSubject(lock, raw));
  assert.equal(subject.candidateDigest.hex, expectedHex);

  // 128-entry classic manifest passes validateDocument and fits state bounds
  const entries128 = Array.from({ length: LIMITS.overlayEntries }, (_, i) => value(digestArtifact(`file-${i}`, new Uint8Array())));
  const classic128: ArtifactManifest = {
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'ArtifactManifest',
    metadata: { id: 'candidate' },
    spec: { entries: entries128 },
  };
  assert.equal(validateDocument(classic128, 'ArtifactManifest').ok, true);
});

test('tree-overlay manifest accepts valid sha1/sha256 anchors, mixed-case UTF-16 order, and 128+128 limits', () => {
  for (const anchor of [sha1Anchor(), sha256Anchor()]) {
    const empty = overlayManifest(anchor, [], []);
    const validated = value(validateDocument(empty, 'ArtifactManifest'));
    assert.deepEqual({ ...validated.spec.baseTree }, anchor);
    assert.deepEqual(validated.spec.deleted, []);
    assert.deepEqual(Object.keys(validated.spec).sort(), ['baseTree', 'deleted', 'entries']);

    // Mixed-case UTF-16 code-unit order: 'B' (66) < 'a' (97)
    const mixed = overlayManifest(anchor, ['README.md', 'package.json'], ['LICENSE', 'src/old.ts']);
    assert.equal(validateDocument(mixed, 'ArtifactManifest').ok, true);
  }

  // Exact 128 entries + 128 deleted passes
  const maxEntries = sortedNames(LIMITS.overlayEntries, 'entry');
  const maxDeleted = sortedNames(LIMITS.overlayEntries, 'deleted');
  const maxOverlay = overlayManifest(sha256Anchor(), maxEntries, maxDeleted);
  const validatedMax = value(validateDocument(maxOverlay, 'ArtifactManifest'));
  assert.equal(validatedMax.spec.entries.length, 128);
  assert.equal(validatedMax.spec.deleted?.length, 128);

  // Exact 255-byte segment passes in overlay mode
  const seg255 = 'x'.repeat(255);
  assert.equal(validateDocument(overlayManifest(sha1Anchor(), [seg255], [`dir/${seg255}`]), 'ArtifactManifest').ok, true);
});

test('Subject.candidateDigest and evaluateAcceptance bind over full tree-overlay manifest', () => {
  const lock = value(admitTask(contract(), { admissionId: 'admission-1', runId: 'run-1' }));
  const baseA = overlayManifest(sha1Anchor('a'.repeat(40), 'b'.repeat(40)), ['a.txt'], ['removed.txt']);
  const baseB = overlayManifest(sha1Anchor('1'.repeat(40), 'b'.repeat(40)), ['a.txt'], ['removed.txt']);
  const baseC = overlayManifest(sha1Anchor('a'.repeat(40), '2'.repeat(40)), ['a.txt'], ['removed.txt']);
  const baseD = overlayManifest(sha1Anchor('a'.repeat(40), 'b'.repeat(40)), ['a.txt'], ['other.txt']);

  const subA = value(bindSubject(lock, baseA));
  const subB = value(bindSubject(lock, baseB));
  const subC = value(bindSubject(lock, baseC));
  const subD = value(bindSubject(lock, baseD));
  assert.equal(subA.candidateDigest.hex, value(identifyManifest(baseA)).digest.hex);
  assert.notEqual(subA.candidateDigest.hex, subB.candidateDigest.hex);
  assert.notEqual(subA.candidateDigest.hex, subC.candidateDigest.hex);
  assert.notEqual(subA.candidateDigest.hex, subD.candidateDigest.hex);

  // evaluateAcceptance validates manifest.spec.entries against ResolvedArtifact[] and binds full manifest digest
  const fixture = evaluationFixture();
  const candidateBytes = fixture.artifacts[0]!.bytes;
  const candidateRef = value(digestArtifact('candidate.patch', candidateBytes));
  const overlayCandidate: ArtifactManifest = {
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'ArtifactManifest',
    metadata: { id: 'candidate' },
    spec: {
      baseTree: sha1Anchor(),
      entries: [candidateRef],
      deleted: ['obsolete.ts'],
    },
  };
  const overlaySubject = value(bindSubject(lock, overlayCandidate));
  Object.assign(fixture.input.trusted, { candidateManifest: overlayCandidate });
  Object.assign(fixture.input.trusted.eligibleEvidence[0]!.spec, { subject: structuredClone(overlaySubject) });
  const evalResult = value(evaluateAcceptance(fixture.input, fixture.artifacts));
  assert.equal(evalResult.spec.satisfied, true);
  assert.equal(evalResult.spec.subject.candidateDigest.hex, overlaySubject.candidateDigest.hex);

  // Missing artifact in entries still reports ARTIFACT_MISSING
  const missingResult = value(evaluateAcceptance(fixture.input, [fixture.artifacts[1]!]));
  assert.equal(missingResult.spec.satisfied, false);
  assert.equal(missingResult.spec.diagnostics[0]!.code, 'ARTIFACT_MISSING');
});

test('tree-overlay rejects invalid OIDs, partial shapes, and overlay collection overruns', () => {
  const validSha1 = sha1Anchor();
  const validSha256 = sha256Anchor();

  // Bad OIDs
  for (const badAnchor of [
    sha1Anchor('a'.repeat(41), 'b'.repeat(40)),
    sha1Anchor('a'.repeat(40), 'b'.repeat(41)),
    sha1Anchor('a'.repeat(39), 'b'.repeat(40)),
    sha1Anchor('A'.repeat(40), 'b'.repeat(40)),
    sha1Anchor('a'.repeat(40), 'B'.repeat(40)),
    sha1Anchor('g'.repeat(40), 'b'.repeat(40)),
    sha1Anchor('a'.repeat(64), 'b'.repeat(40)),
    sha1Anchor('a'.repeat(40), 'b'.repeat(64)),
    sha256Anchor('c'.repeat(40), 'd'.repeat(64)),
    sha256Anchor('c'.repeat(64), 'd'.repeat(40)),
    sha256Anchor('c'.repeat(65), 'd'.repeat(64)),
    sha256Anchor('c'.repeat(63), 'd'.repeat(64)),
    sha256Anchor('C'.repeat(64), 'd'.repeat(64)),
    sha256Anchor('c'.repeat(64), 'G'.repeat(64)),
  ]) {
    assert.equal(code(identifyManifest(overlayManifest(badAnchor, [], []))), 'VALUE_RANGE');
  }

  assert.equal(code(identifyManifest(overlayManifest({ objectFormat: 'sha512', commitOid: 'a'.repeat(64), treeOid: 'b'.repeat(64) }, [], []))), 'VALUE_ENUM');

  // Partial overlay shapes
  const partials = [
    { apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' }, spec: { baseTree: validSha1, entries: [] } },
    { apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' }, spec: { entries: [], deleted: [] } },
    { apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' }, spec: { baseTree: validSha1 } },
    { apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' }, spec: { deleted: [] } },
    { apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' }, spec: { baseTree: validSha1, deleted: [] } },
  ];
  for (const partial of partials) {
    const res = identifyManifest(partial);
    assert.equal(res.ok, false);
    assert.ok(res.errors[0]!.code === 'FIELD_REQUIRED' || res.errors[0]!.code === 'FIELD_UNKNOWN');
  }

  // Extra key on overlay spec or baseTree
  assert.equal(code(identifyManifest({
    apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' },
    spec: { baseTree: validSha1, entries: [], deleted: [], extra: true },
  })), 'FIELD_UNKNOWN');
  assert.equal(code(identifyManifest(overlayManifest({ ...validSha256, extra: true }, [], []))), 'FIELD_UNKNOWN');

  // > 128 entries or > 128 deleted in overlay mode
  assert.equal(code(identifyManifest(overlayManifest(validSha1, sortedNames(LIMITS.overlayEntries + 1, 'e'), []))), 'VALUE_RANGE');
  assert.equal(code(identifyManifest(overlayManifest(validSha1, [], sortedNames(LIMITS.overlayEntries + 1, 'd')))), 'VALUE_RANGE');
});

test('tree-overlay rejects .git segments, >255-byte segments, unsorted lists, and ambiguity collisions', () => {
  const anchor = sha1Anchor();

  // .git segment & >255-byte segment in entries and deleted
  for (const badPath of ['.git', '.GIT', '.git/config', 'sub/.git/HEAD', 'sub/.Git', 'a'.repeat(256), `dir/${'a'.repeat(256)}`]) {
    const entryDoc = {
      apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' },
      spec: { baseTree: anchor, entries: [value(digestArtifact(badPath, new Uint8Array()))], deleted: [] },
    };
    const deletedDoc = overlayManifest(anchor, [], [badPath]);
    assert.equal(code(identifyManifest(entryDoc)), 'PATH_INVALID', `entry ${badPath}`);
    assert.equal(code(identifyManifest(deletedDoc)), 'PATH_INVALID', `deleted ${badPath}`);
  }

  // Unsorted entries / deleted (including UTF-16 order where 'a' > 'B')
  for (const badOrder of [['b', 'a'], ['a', 'B'], ['a', 'a']]) {
    assert.equal(code(identifyManifest(overlayManifest(anchor, badOrder, []))), 'MANIFEST_AMBIGUOUS');
    assert.equal(code(identifyManifest(overlayManifest(anchor, [], badOrder))), 'MANIFEST_AMBIGUOUS');
  }

  // Cross-set and within-set collisions: exact, case-insensitive, and dir-vs-file prefix both directions
  const ambiguousCases: [string[], string[]][] = [
    [['a.txt'], ['a.txt']],
    [['A.txt'], ['a.txt']],
    [['B.txt', 'b.txt'], []],
    [[], ['B.txt', 'b.txt']],
    [['dir'], ['dir/file.txt']],
    [['dir/file.txt'], ['dir']],
    [['Dir'], ['dir/file.txt']],
    [['dir/file.txt'], ['Dir']],
    [['dir', 'dir/file.txt'], []],
    [[], ['dir', 'dir/file.txt']],
  ];
  for (const [entries, deleted] of ambiguousCases) {
    assert.equal(code(identifyManifest(overlayManifest(anchor, entries, deleted))), 'MANIFEST_AMBIGUOUS',
      `entries=${JSON.stringify(entries)} deleted=${JSON.stringify(deleted)}`);
  }

  // Non-prefix siblings across entries and deleted are allowed
  assert.equal(identifyManifest(overlayManifest(anchor, ['a', 'dir/a'], ['a-b', 'dir/b'])).ok, true);

  // Non-ASCII NFC/NFD inputs are rejected deterministically (nameSchema PATH_INVALID before manifestSchema NFC folding)
  assert.equal(code(identifyManifest(overlayManifest(anchor, [], ['caf\u00e9']))), 'PATH_INVALID');
  assert.equal(code(identifyManifest(overlayManifest(anchor, [], ['cafe\u0301']))), 'PATH_INVALID');
});

test('classic 128-entry and tree-overlay 128+128-entry manifests round-trip through @loopwright/state writeCheckpoint', () => {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'loopwright-core-state-'));
  let store: ReturnType<typeof createLocalRun> extends infer R ? R extends { ok: true; value: infer V } ? V | null : never : never = null;
  try {
    const lock = value(admitTask(contract(), { admissionId: 'admission-1', runId: 'run-1' }));
    const identity = {
      directory: join(parent, 'store'),
      storeId: 'store-1',
      lock,
      policy: { version: 1 as const, leaseMs: 10_000, cost: 'observe_only' as const },
      binding: {
        coreApiVersion: 'loopwright.dev/v1alpha1' as const,
        hostVersion: 'fixture',
        adapters: [{ id: 'pi', version: '1.5.0' }],
        resourceVersion: 'fixture-host',
        clockEpoch: 'fixture-boot',
      },
    };
    const workspace = value(digestArtifact('workspace.patch', Buffer.from('workspace')));

    const created = createLocalRun(identity);
    assert.equal(created.ok, true, JSON.stringify(created));
    if (!created.ok) throw new Error('expected createLocalRun to succeed');
    store = created.value;

    const claimed = store.claim({ ownerId: 'owner-1', expectedGeneration: 0, expectedRevision: 0, mode: 'active' });
    assert.equal(claimed.ok, true, JSON.stringify(claimed));
    if (!claimed.ok) throw new Error('expected claim to succeed');
    const owner = claimed.value;

    const classic128: ArtifactManifest = {
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'ArtifactManifest',
      metadata: { id: 'candidate' },
      spec: {
        entries: Array.from({ length: LIMITS.overlayEntries }, (_, i) => value(digestArtifact(`file-${i}`, new Uint8Array()))),
      },
    };
    const classicExpectedHex = value(identifyManifest(classic128)).digest.hex;
    const savedClassic = store.writeCheckpoint(owner.authority, {
      checkpointId: 'checkpoint-classic-128',
      expectedRevision: owner.revision,
      candidateManifest: classic128,
      workspace,
      privateSession: null,
      additionalArtifacts: [],
    });
    assert.equal(savedClassic.ok, true, JSON.stringify(savedClassic));
    if (!savedClassic.ok) throw new Error('expected classic writeCheckpoint to succeed');
    assert.equal(savedClassic.value.kind, 'created');
    assert.equal(savedClassic.value.record.subject.candidateDigest.hex, classicExpectedHex);

    const overlay128 = overlayManifest(
      sha256Anchor(),
      sortedNames(LIMITS.overlayEntries, 'entry'),
      sortedNames(LIMITS.overlayEntries, 'deleted'),
    );
    const overlayExpectedHex = value(identifyManifest(overlay128)).digest.hex;
    const savedOverlay = store.writeCheckpoint(owner.authority, {
      checkpointId: 'checkpoint-overlay-128',
      expectedRevision: savedClassic.value.revision,
      candidateManifest: overlay128,
      workspace,
      privateSession: null,
      additionalArtifacts: [],
    });
    assert.equal(savedOverlay.ok, true, JSON.stringify(savedOverlay));
    if (!savedOverlay.ok) throw new Error('expected overlay writeCheckpoint to succeed');
    assert.equal(savedOverlay.value.kind, 'created');
    assert.equal(savedOverlay.value.record.subject.candidateDigest.hex, overlayExpectedHex);

    store.close();
    store = null;

    const reopened = reopenLocalRun(identity);
    assert.equal(reopened.ok, true, JSON.stringify(reopened));
    if (!reopened.ok) throw new Error('expected reopenLocalRun to succeed');
    store = reopened.value;

    for (const [checkpointId, expectedHex] of [
      ['checkpoint-classic-128', classicExpectedHex],
      ['checkpoint-overlay-128', overlayExpectedHex],
    ] as const) {
      const record = store.getCheckpoint(checkpointId);
      assert.equal(record.ok, true, JSON.stringify(record));
      if (!record.ok) throw new Error(`expected getCheckpoint(${checkpointId}) to succeed`);
      assert.equal(record.value.subject.candidateDigest.hex, expectedHex);

      const view = store.recoveryView(owner.authority, { checkpointId, availableArtifacts: [workspace] });
      assert.equal(view.ok, true, JSON.stringify(view));
      if (!view.ok) throw new Error(`expected recoveryView(${checkpointId}) to succeed`);
      assert.equal(view.value.checkpoint.subject.candidateDigest.hex, expectedHex);
    }

    const classic129: ArtifactManifest = {
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'ArtifactManifest',
      metadata: { id: 'candidate' },
      spec: {
        entries: Array.from({ length: LIMITS.overlayEntries + 1 }, (_, i) => value(digestArtifact(`file-${i}`, new Uint8Array()))),
      },
    };
    const overflow = store.writeCheckpoint(owner.authority, {
      checkpointId: 'checkpoint-classic-129',
      expectedRevision: savedOverlay.value.revision,
      candidateManifest: classic129,
      workspace,
      privateSession: null,
      additionalArtifacts: [],
    });
    assert.equal(overflow.ok, false);
    if (overflow.ok) throw new Error('expected 129-entry classic manifest writeCheckpoint to fail');
    assert.equal(overflow.error.code, 'LIMIT_EXCEEDED');
  } finally {
    store?.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test('ArtifactRef supports optional uri and mediaType while preserving legacy manifest digests when omitted', () => {
  const bytes = Buffer.from('kernel binary');
  const legacyRef = value(digestArtifact('kernel.cubin', bytes));
  assert.equal(Object.hasOwn(legacyRef, 'uri'), false);
  assert.equal(Object.hasOwn(legacyRef, 'mediaType'), false);

  const legacyManifest = {
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'ArtifactManifest',
    metadata: { id: 'candidate' },
    spec: { entries: [legacyRef] },
  };
  const legacyIdentified = value(identifyManifest(legacyManifest));
  assert.equal(Object.hasOwn(legacyIdentified.manifest.spec.entries[0]!, 'uri'), false);
  assert.equal(Object.hasOwn(legacyIdentified.manifest.spec.entries[0]!, 'mediaType'), false);

  const expectedCanonical = JSON.stringify({
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'ArtifactManifest',
    metadata: { id: 'candidate' },
    spec: { entries: [{ byteLength: legacyRef.byteLength, digest: legacyRef.digest, name: legacyRef.name }] },
  });
  const expectedHex = createHash('sha256').update('loopwright.dev/artifact-manifest/v1alpha1\0' + expectedCanonical).digest('hex');
  assert.equal(legacyIdentified.digest.hex, expectedHex);

  const extRef = value(digestArtifact('kernel.cubin', bytes, {
    uri: 's3://bench-bucket/runs/1/kernel.cubin',
    mediaType: 'application/octet-stream',
  }));
  assert.equal(extRef.uri, 's3://bench-bucket/runs/1/kernel.cubin');
  assert.equal(extRef.mediaType, 'application/octet-stream');

  const extManifest = {
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'ArtifactManifest',
    metadata: { id: 'candidate' },
    spec: { entries: [extRef] },
  };
  const extIdentified = value(identifyManifest(extManifest));
  assert.equal(extIdentified.manifest.spec.entries[0]!.uri, 's3://bench-bucket/runs/1/kernel.cubin');
  assert.equal(extIdentified.manifest.spec.entries[0]!.mediaType, 'application/octet-stream');
  assert.notEqual(extIdentified.digest.hex, legacyIdentified.digest.hex);

  // Explicit null and mediaType with parameter are also valid
  const nullExtRef = value(digestArtifact('notes.txt', Buffer.from('hi'), { uri: null, mediaType: 'text/plain; charset=utf-8' }));
  assert.equal(nullExtRef.uri, null);
  assert.equal(nullExtRef.mediaType, 'text/plain; charset=utf-8');

  // Invalid uri and mediaType values are rejected with VALUE_RANGE
  for (const badUri of ['', 'relative/no-scheme', 'https://example.com/has space', 'https://example.com/\nbad', '123://bad', 'http:', 'https://' + 'a'.repeat(LIMITS.artifactUri)]) {
    assert.equal(code(digestArtifact('a.bin', bytes, { uri: badUri })), 'VALUE_RANGE', badUri);
  }
  for (const badMediaType of ['', 'application', 'application/', '/json', 'text/plain\r\nX-Inject: 1', 'text/plain; badparam', 'application/' + 'a'.repeat(LIMITS.mediaType)]) {
    assert.equal(code(digestArtifact('a.bin', bytes, { mediaType: badMediaType })), 'VALUE_RANGE', badMediaType);
  }
  assert.equal(code(digestArtifact('a.bin', bytes, { extra: true } as unknown as { uri?: string })), 'FIELD_UNKNOWN');
  assert.equal(code(digestArtifact('a.bin', bytes, 'bad' as unknown as { uri?: string })), 'VALUE_TYPE');
});

test('configurable overlay limits admit 512-file and 2048-file manifests, reject 513/2049, and keep 129 rejected by default', () => {
  const anchor = sha256Anchor();
  const names129 = sortedNames(129, 'file');
  const names512 = sortedNames(512, 'file');
  const names513 = sortedNames(513, 'file');
  const overlay129 = overlayManifest(anchor, names129, []);
  const overlay512 = overlayManifest(anchor, names512, []);
  const overlay513 = overlayManifest(anchor, names513, []);
  const opts512 = { overlay: { maxFiles: 512, maxBytes: 16_777_216 } } as const;

  // Default limits still reject 129 entries
  assert.equal(code(identifyManifest(overlay129)), 'VALUE_RANGE');
  assert.equal(code(validateDocument(overlay129, 'ArtifactManifest')), 'VALUE_RANGE');
  const defaultLock = value(admitTask(contract(), { admissionId: 'admission-1', runId: 'run-1' }));
  assert.equal(code(bindSubject(defaultLock, overlay129)), 'VALUE_RANGE');

  // Explicit { maxFiles: 512, maxBytes: 16_777_216 } admits 512 entries and fails closed at 513
  const identified512 = value(identifyManifest(overlay512, opts512));
  assert.equal(identified512.manifest.spec.entries.length, 512);
  assert.equal(value(validateDocument(overlay512, 'ArtifactManifest', opts512)).spec.entries.length, 512);
  assert.equal(value(bindSubject(defaultLock, overlay512, opts512)).candidateDigest.hex, identified512.digest.hex);
  assert.equal(code(identifyManifest(overlay513, opts512)), 'VALUE_RANGE');
  assert.equal(code(validateDocument(overlay513, 'ArtifactManifest', opts512)), 'VALUE_RANGE');
  assert.equal(code(bindSubject(defaultLock, overlay513, opts512)), 'VALUE_RANGE');

  // Derived automatically from expectedLock.spec.contract.spec.budgets.overlay without passing options
  const widenedContract = contract();
  Object.assign(widenedContract.spec.budgets, { overlay: { maxFiles: 512, maxBytes: 16_777_216 } });
  const widenedLock = value(admitTask(widenedContract, { admissionId: 'admission-1', runId: 'run-1' }));
  assert.equal(value(bindSubject(widenedLock, overlay512)).candidateDigest.hex, identified512.digest.hex);
  assert.equal(code(bindSubject(widenedLock, overlay513)), 'VALUE_RANGE');

  // Scales snapshot collection/nodes/inputBytes above default LIMITS.collection (1024) when requested up to 4096
  const names2048 = Array.from({ length: 2_048 }, (_, i) => `f-${String(i).padStart(4, '0')}`).sort();
  const names2049 = Array.from({ length: 2_049 }, (_, i) => `f-${String(i).padStart(4, '0')}`).sort();
  const opts2048 = { overlay: { maxFiles: 2_048, maxBytes: 67_108_864 } } as const;
  assert.equal(value(identifyManifest(overlayManifest(anchor, names2048, []), opts2048)).manifest.spec.entries.length, 2_048);
  assert.equal(code(identifyManifest(overlayManifest(anchor, names2049, []), opts2048)), 'VALUE_RANGE');

  // resolveInventory preserves 384 non-overlay artifact slots (LIMITS.resolvedArtifacts - LIMITS.overlayEntries)
  const inventory896 = Array.from({ length: 512 + (LIMITS.resolvedArtifacts - LIMITS.overlayEntries) }, (_, i) => ({ name: `item-${i}`, bytes: new Uint8Array(1) }));
  assert.throws(() => resolveInventory(inventory896));
  assert.equal(resolveInventory(inventory896, opts512).size, 896);
  const inventory897 = [...inventory896, { name: 'item-896', bytes: new Uint8Array(1) }];
  assert.throws(() => resolveInventory(inventory897, opts512));

  // Worst-case 1024-entry + 1024-deleted manifest with long ArtifactRef.uri and mediaType passes overlaySnapshotBounds
  const opts1024 = { overlay: { maxFiles: 1_024, maxBytes: 67_108_864 } } as const;
  const longUriPrefix = 's3://bench-bucket/' + 'a'.repeat(1_800) + '/';
  const richEntries = Array.from({ length: 1_024 }, (_, i) => {
    const name = `entries/${'p'.repeat(120)}-${String(i).padStart(4, '0')}.bin`;
    return value(digestArtifact(name, Buffer.from(`v-${i}`), {
      uri: `${longUriPrefix}${String(i).padStart(4, '0')}.bin`,
      mediaType: 'application/vnd.loopwright.benchmark+octet-stream',
    }));
  }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const richDeleted = Array.from({ length: 1_024 }, (_, i) => `deleted/${'d'.repeat(200)}-${String(i).padStart(4, '0')}.txt`).sort();
  const richManifest = {
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'ArtifactManifest',
    metadata: { id: 'candidate' },
    spec: { baseTree: anchor, entries: richEntries, deleted: richDeleted },
  };
  assert.equal(value(identifyManifest(richManifest, opts1024)).manifest.spec.entries.length, 1_024);
  assert.equal(value(validateDocument(JSON.stringify(richManifest), 'ArtifactManifest', opts1024)).spec.deleted?.length, 1_024);
});

test('digestArtifactFromMetadata validates bounds, empty-hash invariant, null-prototype records, and JCS parity', () => {
  const emptyDigest: Digest = { algorithm: 'sha256', hex: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' };
  const sampleBytes = Buffer.from('streaming cas blob\n');
  const fromBytes = value(digestArtifact('assets/blob.bin', sampleBytes));
  const fiveGiB = 5 * 1024 * 1024 * 1024;
  const nonEmptyDigest: Digest = { algorithm: 'sha256', hex: 'a'.repeat(64) };

  // Unset, undefined, and null uri/mediaType are omitted completely for bit-for-bit JCS parity with digestArtifact
  for (const metadata of [
    { digest: fromBytes.digest, byteLength: fromBytes.byteLength },
    { digest: fromBytes.digest, byteLength: fromBytes.byteLength, uri: undefined, mediaType: undefined },
    { digest: fromBytes.digest, byteLength: fromBytes.byteLength, uri: null, mediaType: null },
  ] satisfies readonly ArtifactMetadataInput[]) {
    const fromMeta = value(digestArtifactFromMetadata('assets/blob.bin', metadata));
    assert.deepEqual(fromMeta, fromBytes);
    assert.equal(Object.hasOwn(fromMeta, 'uri'), false);
    assert.equal(Object.hasOwn(fromMeta, 'mediaType'), false);
    assert.equal(Object.isFrozen(fromMeta), true);
    const bytesManifest = { apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' }, spec: { entries: [fromBytes] } };
    const metaManifest = { apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' }, spec: { entries: [fromMeta] } };
    assert.equal(value(identifyManifest(metaManifest)).digest.hex, value(identifyManifest(bytesManifest)).digest.hex);
  }

  // Zero-byte invariant: empty digest required for 0 bytes, disallowed for non-zero bytes
  const zeroRef = value(digestArtifactFromMetadata('empty.txt', { digest: emptyDigest, byteLength: 0 }));
  assert.deepEqual(zeroRef, value(digestArtifact('empty.txt', new Uint8Array(0))));
  assert.equal(code(digestArtifactFromMetadata('empty.txt', { digest: nonEmptyDigest, byteLength: 0 })), 'ARTIFACT_DIGEST_MISMATCH');
  assert.equal(code(digestArtifactFromMetadata('non-empty.txt', { digest: emptyDigest, byteLength: 1 })), 'ARTIFACT_DIGEST_MISMATCH');

  // > 4 GiB safe integers and exact 16 GiB ceiling succeed; > 16 GiB refuses with LIMIT_ARTIFACT_BYTES
  const ref5GiB = value(digestArtifactFromMetadata('large/model.bin', { digest: nonEmptyDigest, byteLength: fiveGiB }));
  assert.equal(ref5GiB.byteLength, fiveGiB);
  assert.equal(value(digestArtifactFromMetadata('large/max.bin', { digest: nonEmptyDigest, byteLength: OVERLAY_LIMITS.maxMaxBytes })).byteLength, 17_179_869_184);
  assert.equal(code(digestArtifactFromMetadata('large/over.bin', { digest: nonEmptyDigest, byteLength: OVERLAY_LIMITS.maxMaxBytes + 1 })), 'LIMIT_ARTIFACT_BYTES');

  // Negative, float, NaN, Infinity fail with VALUE_RANGE
  for (const badLen of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(code(digestArtifactFromMetadata('a.bin', { digest: nonEmptyDigest, byteLength: badLen })), 'VALUE_RANGE', String(badLen));
  }

  // Set cas:// URI and mediaType succeed; invalid values fail with VALUE_RANGE
  const casUri = `cas://sha256/${'a'.repeat(64)}`;
  const casRef = value(digestArtifactFromMetadata('assets/blob.bin', {
    digest: nonEmptyDigest,
    byteLength: fiveGiB,
    uri: casUri,
    mediaType: 'application/octet-stream',
  }));
  assert.equal(casRef.uri, casUri);
  assert.equal(casRef.mediaType, 'application/octet-stream');
  assert.equal(code(digestArtifactFromMetadata('assets/blob.bin', { digest: nonEmptyDigest, byteLength: 4, uri: 'no scheme' })), 'VALUE_RANGE');
  assert.equal(code(digestArtifactFromMetadata('assets/blob.bin', { digest: nonEmptyDigest, byteLength: 4, mediaType: 'bad' })), 'VALUE_RANGE');

  // Null-prototype records are accepted; getters are rejected without invocation; name validation matches digestArtifact
  const nullDigest = Object.assign(Object.create(null) as Record<string, unknown>, { algorithm: 'sha256', hex: 'b'.repeat(64) });
  const nullMeta = Object.assign(Object.create(null) as Record<string, unknown>, { digest: nullDigest, byteLength: 128 });
  assert.equal(value(digestArtifactFromMetadata('ok/file.bin', nullMeta as unknown as ArtifactMetadataInput)).byteLength, 128);

  let getterCalls = 0;
  const getterMeta = { digest: nonEmptyDigest };
  Object.defineProperty(getterMeta, 'byteLength', { enumerable: true, get() { getterCalls++; return 10; } });
  assert.equal(code(digestArtifactFromMetadata('a.bin', getterMeta as unknown as ArtifactMetadataInput)), 'INPUT_UNSUPPORTED');
  assert.equal(getterCalls, 0);

  for (const badName of ['', '/leading', 'trailing/', 'a\\b', '../escape', '.', 'a\0b', 'CON', 'x'.repeat(LIMITS.path + 1)]) {
    const rawRes = digestArtifact(badName, new Uint8Array(0));
    const metaRes = digestArtifactFromMetadata(badName, { digest: emptyDigest, byteLength: 0 });
    assert.equal(rawRes.ok, false, badName);
    assert.equal(metaRes.ok, false, badName);
    if (!rawRes.ok && !metaRes.ok) {
      assert.deepEqual(metaRes.errors, rawRes.errors, badName);
    }
  }
});

test('resolveInventory accepts VerifiedArtifactDescriptor up to 16 GiB while preserving raw byte caps and rejecting ambiguity', () => {
  const eightyMiB = 80 * 1024 * 1024;
  const ninetyMiB = 90 * 1024 * 1024;
  const fiveGiB = 5 * 1024 * 1024 * 1024;
  const d1: Digest = { algorithm: 'sha256', hex: '1'.repeat(64) };
  const d2: Digest = { algorithm: 'sha256', hex: '2'.repeat(64) };

  const nullDesc = Object.assign(Object.create(null) as Record<string, unknown>, {
    name: 'weights/shard-1.bin',
    byteLength: eightyMiB,
    digest: Object.assign(Object.create(null) as Record<string, unknown>, d1),
  }) as unknown as VerifiedArtifactDescriptor;
  const mixed: readonly ResolvedArtifactInput[] = [
    nullDesc,
    { name: 'weights/shard-2.bin', byteLength: ninetyMiB, digest: d2 },
    { name: 'test.log', bytes: Buffer.from('ok\n') },
  ];
  const resolved = resolveInventory(mixed);
  assert.equal(resolved.get('weights/shard-1.bin')?.byteLength, eightyMiB);
  assert.equal(resolved.get('weights/shard-2.bin')?.digest.hex, d2.hex);
  assert.equal(resolved.get('test.log')?.byteLength, 3);

  // 5 GiB + 11 GiB === 16 GiB succeeds; + 1 byte fails with LIMIT_RESOLVED_BYTES
  const exact16GiB: readonly ResolvedArtifactInput[] = [
    { name: 'a.bin', byteLength: fiveGiB, digest: d1 },
    { name: 'b.bin', byteLength: OVERLAY_LIMITS.maxMaxBytes - fiveGiB, digest: d2 },
  ];
  assert.equal(resolveInventory(exact16GiB).size, 2);
  assert.throws(
    () => resolveInventory([...exact16GiB, { name: 'c.bin', bytes: new Uint8Array(1) }]),
    (err: unknown) => err instanceof Error && err.message === 'LIMIT_RESOLVED_BYTES',
  );

  // Ambiguous objects (both bytes and digest, or neither) and duplicates fail closed
  assert.throws(
    () => resolveInventory([{ name: 'both.bin', bytes: new Uint8Array(1), byteLength: 1, digest: d1 } as unknown as ResolvedArtifactInput]),
    (err: unknown) => err instanceof Error && err.message === 'INPUT_UNSUPPORTED',
  );
  assert.throws(
    () => resolveInventory([{ name: 'neither.bin' } as unknown as ResolvedArtifactInput]),
    (err: unknown) => err instanceof Error && err.message === 'INPUT_UNSUPPORTED',
  );
  assert.throws(
    () => resolveInventory([{ name: 'dup.bin', byteLength: 10, digest: d1 }, { name: 'DUP.bin', bytes: new Uint8Array(1) }]),
    (err: unknown) => err instanceof Error && err.message === 'ARTIFACT_DUPLICATE',
  );
});
