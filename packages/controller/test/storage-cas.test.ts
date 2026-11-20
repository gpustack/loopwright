import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, link, lstat, mkdir, readdir, symlink, truncate, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OVERLAY_LIMITS } from '@loopwright/core';
import { createCredentialStreamChecker } from '../src/credentials.js';
import { ControllerFailure } from '../src/errors.js';
import { copyVerifiedFileReadOnly, streamRegularFile } from '../src/files.js';
import { approvedState } from '../src/config.js';
import {
  ArtifactStore,
  parseCasUri,
  resolveCanonicalCasBlobPath,
  streamVerifiedCasBlob,
} from '../src/storage.js';
import { retainedFixture, setFixture } from './progress-fixtures.js';

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

test('CAS blob store commits .tmp -> 0o400 -> link with nlink === 1, canonical cas:// URIs, and streaming verification', async () => {
  const f = await retainedFixture();
  try {
    const scratchDir = join(f.root, 'cas-sources');
    await mkdir(scratchDir, { mode: 0o700 });

    // 1. Empty 0-byte blob via putCasBlobFromBytes
    const emptyPtr = await f.artifacts.putCasBlobFromBytes('empty.txt', new Uint8Array(0));
    assert.equal(emptyPtr.byteLength, 0);
    assert.equal(emptyPtr.sha256, sha256Hex(new Uint8Array(0)));
    assert.equal(emptyPtr.blobRef.uri, `cas://sha256/${emptyPtr.sha256}`);
    assert.equal(emptyPtr.path, join(f.artifacts.directory, 'blobs', 'sha256', emptyPtr.sha256));
    const emptyStat = await lstat(emptyPtr.path);
    assert.equal(emptyStat.isFile(), true);
    assert.equal(emptyStat.isSymbolicLink(), false);
    assert.equal(emptyStat.nlink, 1);
    assert.equal(emptyStat.mode & 0o777, 0o400);

    // 2. Multi-chunk (> 64 KiB) binary file via putCasBlobFromFile
    const payload = Buffer.alloc(196_613);
    for (let i = 0; i < payload.byteLength; i++) payload[i] = (i * 31 + 7) & 0xff;
    const srcFile = join(scratchDir, 'large.bin');
    await writeFile(srcFile, payload, { mode: 0o600 });

    const ptr = await f.artifacts.putCasBlobFromFile('assets/large.bin', srcFile);
    const expectedHex = sha256Hex(payload);
    assert.equal(ptr.sha256, expectedHex);
    assert.equal(ptr.byteLength, payload.byteLength);
    assert.equal(ptr.blobRef.name, 'assets/large.bin');
    assert.equal(ptr.blobRef.byteLength, payload.byteLength);
    assert.equal(ptr.blobRef.digest.hex, expectedHex);
    assert.equal(ptr.blobRef.uri, `cas://sha256/${expectedHex}`);
    assert.equal(parseCasUri(ptr.blobRef.uri!), expectedHex);

    const blobStat = await lstat(ptr.path);
    assert.equal(blobStat.nlink, 1);
    assert.equal(blobStat.mode & 0o777, 0o400);

    const entries = await readdir(join(f.artifacts.directory, 'blobs', 'sha256'));
    assert.equal(entries.some(name => name.startsWith('.tmp-')), false);

    // 3. Canonical resolution and single-fd chunked verification reconstruct exact bytes
    const resolved = await resolveCanonicalCasBlobPath(f.artifacts.directory, ptr.sha256, ptr.path);
    assert.equal(resolved, ptr.path);
    const streamedChunks: Buffer[] = [];
    await streamVerifiedCasBlob(
      f.artifacts.directory,
      { name: 'assets/large.bin', sha256: ptr.sha256, byteLength: ptr.byteLength, uri: ptr.blobRef.uri, path: ptr.path },
      chunk => {
        streamedChunks.push(Buffer.from(chunk));
      },
    );
    assert.equal(streamedChunks.length, 4);
    assert.deepEqual(Buffer.concat(streamedChunks), payload);

    // 4. copyVerifiedFileReadOnly and streamRegularFile preserve nlink === 1 and read-only mode
    const copiedDest = join(scratchDir, 'copied-readonly.bin');
    const copied = await copyVerifiedFileReadOnly(ptr.path, copiedDest, { expectedSha256: expectedHex });
    assert.equal(copied.byteLength, payload.byteLength);
    assert.equal(copied.sha256, expectedHex);
    const copiedStat = await lstat(copiedDest);
    assert.equal(copiedStat.nlink, 1);
    assert.equal(copiedStat.mode & 0o777, 0o400);

    const mismatchDest = join(scratchDir, 'mismatch-dest.bin');
    await assert.rejects(
      copyVerifiedFileReadOnly(ptr.path, mismatchDest, { expectedSha256: '0'.repeat(64) }),
      (err: unknown) => err instanceof ControllerFailure && err.diagnostic.code === 'ARTIFACT_INVALID',
    );
    await assert.rejects(lstat(mismatchDest), (err: NodeJS.ErrnoException) => err.code === 'ENOENT');

    let regularBytes = 0;
    const summary = await streamRegularFile(copiedDest, { expectedBytes: payload.byteLength, requireReadOnly: true }, chunk => {
      regularBytes += chunk.byteLength;
    });
    assert.equal(summary.byteLength, payload.byteLength);
    assert.equal(regularBytes, payload.byteLength);
  } finally {
    await f.close();
  }
});

test('CAS blob store handles concurrent EEXIST writers safely and cleanCasTempFiles removes only .tmp-* regular files under active owner', async () => {
  const f = await retainedFixture();
  try {
    const scratchDir = join(f.root, 'cas-concurrent');
    await mkdir(scratchDir, { mode: 0o700 });
    const sharedPayload = Buffer.alloc(150_000, 0x5a);
    const files = await Promise.all(
      Array.from({ length: 4 }, async (_, idx) => {
        const path = join(scratchDir, `writer-${idx}.bin`);
        await writeFile(path, sharedPayload, { mode: 0o600 });
        return path;
      }),
    );

    const secondStore = new ArtifactStore(f.artifacts.directory, f.owner, f.artifacts.vault);
    const pointers = await Promise.all([
      f.artifacts.putCasBlobFromFile('concurrent/a.bin', files[0]!),
      secondStore.putCasBlobFromFile('concurrent/b.bin', files[1]!),
      f.artifacts.putCasBlobFromFile('concurrent/c.bin', files[2]!),
      secondStore.putCasBlobFromFile('concurrent/d.bin', files[3]!),
      f.artifacts.putCasBlobFromBytes('concurrent/e.bin', sharedPayload),
      secondStore.putCasBlobFromBytes('concurrent/f.bin', sharedPayload),
    ]);

    const expectedHex = sha256Hex(sharedPayload);
    for (const ptr of pointers) {
      assert.equal(ptr.sha256, expectedHex);
      assert.equal(ptr.byteLength, sharedPayload.byteLength);
    }

    const shaDir = join(f.artifacts.directory, 'blobs', 'sha256');
    const statAfterRace = await lstat(pointers[0]!.path);
    assert.equal(statAfterRace.nlink, 1);
    assert.equal(statAfterRace.mode & 0o777, 0o400);
    assert.deepEqual(await readdir(shaDir), [expectedHex]);

    // Plant orphan .tmp-* files from simulated interrupted crash and verify cleanCasTempFiles()
    await writeFile(join(shaDir, '.tmp-crash-orphan-1'), Buffer.from('partial-1'), { mode: 0o600 });
    await writeFile(join(shaDir, '.tmp-crash-orphan-2'), Buffer.from('partial-2'), { mode: 0o400 });
    await symlink(pointers[0]!.path, join(shaDir, '.tmp-not-regular'));

    const cleaned = await f.artifacts.cleanCasTempFiles();
    assert.equal(cleaned, 2);
    const remaining = await readdir(shaDir);
    assert.equal(remaining.includes(expectedHex), true);
    assert.equal(remaining.includes('.tmp-crash-orphan-1'), false);
    assert.equal(remaining.includes('.tmp-crash-orphan-2'), false);
    await unlink(join(shaDir, '.tmp-not-regular'));

    // Committed <hex> blob remains intact and verifiable
    await streamVerifiedCasBlob(f.artifacts.directory, pointers[0]!);
  } finally {
    await f.close();
  }

  // Deposed/released owner cannot run cleanCasTempFiles or putCasBlobFromBytes
  await assert.rejects(
    f.artifacts.cleanCasTempFiles(),
    (err: unknown) => err instanceof ControllerFailure && err.diagnostic.code === 'AUTHORITY_REFUSED',
  );
  await assert.rejects(
    f.artifacts.putCasBlobFromBytes('after-close.bin', Buffer.from('denied')),
    (err: unknown) => err instanceof ControllerFailure && err.diagnostic.code === 'AUTHORITY_REFUSED',
  );
});

test('CAS blob store refuses symlinks, hardlinks, oversize inputs, cross-run paths, bad URIs, writable modes, and corrupted blobs', async () => {
  const f = await retainedFixture();
  try {
    const scratchDir = join(f.root, 'cas-refusals');
    await mkdir(scratchDir, { mode: 0o700 });

    const realSrc = join(scratchDir, 'real.bin');
    await writeFile(realSrc, Buffer.from('hello-cas-world'), { mode: 0o600 });

    // 1. Symlink source refuses ARTIFACT_INVALID and leaves zero blobs
    const symSrc = join(scratchDir, 'sym.bin');
    await symlink(realSrc, symSrc);
    await assert.rejects(
      f.artifacts.putCasBlobFromFile('sym.bin', symSrc),
      (err: unknown) => err instanceof ControllerFailure && err.diagnostic.code === 'ARTIFACT_INVALID',
    );

    // 2. Hardlinked source (nlink > 1) refuses ARTIFACT_INVALID and leaves zero blobs
    const hardSrc = join(scratchDir, 'hard.bin');
    await link(realSrc, hardSrc);
    await assert.rejects(
      f.artifacts.putCasBlobFromFile('hard.bin', realSrc),
      (err: unknown) => err instanceof ControllerFailure && err.diagnostic.code === 'ARTIFACT_INVALID',
    );
    await unlink(hardSrc);

    // 3. Oversize source (> maxBytes) refuses OUTPUT_LIMIT and leaves zero .tmp-* or <hex> files
    await assert.rejects(
      f.artifacts.putCasBlobFromFile('real.bin', realSrc, 4),
      (err: unknown) => err instanceof ControllerFailure && err.diagnostic.code === 'OUTPUT_LIMIT',
    );
    const shaDir = join(f.artifacts.directory, 'blobs', 'sha256');
    assert.deepEqual(await readdir(shaDir), []);

    // Ingest valid blob for read/verification tamper checks
    const ptr = await f.artifacts.putCasBlobFromFile('real.bin', realSrc, OVERLAY_LIMITS.maxMaxBytes);

    // 4. Invalid CAS URIs and cross-run paths refuse ARTIFACT_INVALID
    for (const badUri of [
      '',
      `file://${ptr.path}`,
      `cas://sha256/${ptr.sha256.toUpperCase()}`,
      'cas://sha256/short',
      `cas://sha256/${ptr.sha256}/extra`,
    ]) {
      assert.throws(
        () => parseCasUri(badUri),
        (err: unknown) => err instanceof ControllerFailure && err.diagnostic.code === 'ARTIFACT_INVALID',
      );
    }

    const otherRunArtifacts = join(f.root, 'other-run', 'artifacts');
    await mkdir(join(otherRunArtifacts, 'blobs', 'sha256'), { recursive: true, mode: 0o700 });
    const crossRunPath = join(otherRunArtifacts, 'blobs', 'sha256', ptr.sha256);
    await writeFile(crossRunPath, Buffer.from('hello-cas-world'), { mode: 0o400 });
    await assert.rejects(
      resolveCanonicalCasBlobPath(f.artifacts.directory, ptr.sha256, crossRunPath),
      (err: unknown) => err instanceof ControllerFailure && err.diagnostic.code === 'ARTIFACT_INVALID',
    );
    await assert.rejects(
      streamVerifiedCasBlob(f.artifacts.directory, {
        name: 'real.bin',
        sha256: ptr.sha256,
        byteLength: ptr.byteLength,
        path: crossRunPath,
      }),
      (err: unknown) => err instanceof ControllerFailure && err.diagnostic.code === 'ARTIFACT_INVALID',
    );

    // 5. Hardlinked CAS blob (nlink > 1) refuses both streamVerifiedCasBlob and EEXIST dedup
    const extraCasLink = join(scratchDir, 'aliased-cas.bin');
    await link(ptr.path, extraCasLink);
    await assert.rejects(
      streamVerifiedCasBlob(f.artifacts.directory, ptr),
      (err: unknown) => err instanceof ControllerFailure && err.diagnostic.code === 'ARTIFACT_INVALID',
    );
    await assert.rejects(
      f.artifacts.putCasBlobFromBytes('real.bin', Buffer.from('hello-cas-world')),
      (err: unknown) => err instanceof ControllerFailure && err.diagnostic.code === 'ARTIFACT_INVALID',
    );
    await unlink(extraCasLink);
    await streamVerifiedCasBlob(f.artifacts.directory, ptr);

    // 6. Writable CAS blob ((mode & 0o222) !== 0) refuses ARTIFACT_INVALID
    await chmod(ptr.path, 0o600);
    await assert.rejects(
      streamVerifiedCasBlob(f.artifacts.directory, ptr),
      (err: unknown) => err instanceof ControllerFailure && err.diagnostic.code === 'ARTIFACT_INVALID',
    );

    // 7. Same-size corrupted CAS blob refuses ARTIFACT_INVALID
    await writeFile(ptr.path, Buffer.from('HELLO-cas-world'));
    await chmod(ptr.path, 0o400);
    await assert.rejects(
      streamVerifiedCasBlob(f.artifacts.directory, ptr),
      (err: unknown) => err instanceof ControllerFailure && err.diagnostic.code === 'ARTIFACT_INVALID',
    );

    // 8. Truncated CAS blob refuses ARTIFACT_INVALID
    await chmod(ptr.path, 0o600);
    await truncate(ptr.path, 5);
    await chmod(ptr.path, 0o400);
    await assert.rejects(
      streamVerifiedCasBlob(f.artifacts.directory, ptr),
      (err: unknown) => err instanceof ControllerFailure && err.diagnostic.code === 'ARTIFACT_INVALID',
    );

    // 9. Symlinked CAS blob refuses ARTIFACT_INVALID
    await unlink(ptr.path);
    await symlink(realSrc, ptr.path);
    await assert.rejects(
      streamVerifiedCasBlob(f.artifacts.directory, ptr),
      (err: unknown) => err instanceof ControllerFailure && err.diagnostic.code === 'ARTIFACT_INVALID',
    );
  } finally {
    await f.close();
  }
});

test('derived-form sliding-window secret scrubber catches raw, JSON-escaped, URL-encoded, and base64 secrets across 64 KiB boundaries and dedup hits', async () => {
  // 1. Direct unit test for multi-byte UTF-8 and JSON-escaped quotes/backslashes split across chunk and 1-byte boundaries
  const richSecret = 'sec"ret\\line\n🔑-ω-canary';
  for (const encodedForm of [
    richSecret,
    JSON.stringify(richSecret).slice(1, -1),
    encodeURIComponent(richSecret),
    Buffer.from(richSecret, 'utf8').toString('base64'),
  ]) {
    const prefix = Buffer.alloc(65_530, 0x61);
    // Place a 4-byte UTF-8 character right before the secret so multi-byte sequences cross chunk boundaries
    const utf8Lead = Buffer.from('🚀€', 'utf8');
    const secretBytes = Buffer.from(encodedForm, 'utf8');
    const full = Buffer.concat([prefix, utf8Lead, secretBytes, Buffer.alloc(1024, 0x62)]);
    const chunk1 = full.subarray(0, 65_536);
    const chunk2 = full.subarray(65_536);

    const checker = createCredentialStreamChecker([richSecret]);
    checker.push(chunk1);
    assert.throws(
      () => checker.push(chunk2),
      (err: unknown) =>
        err instanceof ControllerFailure
        && err.diagnostic.code === 'CONFIG_CREDENTIAL_INVALID'
        && err.diagnostic.path === '/spec/credentials',
    );
  }

  // 2. End-to-end ArtifactStore CAS ingestion: raw, JSON-solidus-escaped, URL-encoded, and base64 split across 65_536-byte boundary
  const vaultToken = 'LwVaultSecret+Alpha/Beta9988776655==';
  const f = await retainedFixture(1, 3, 2, 60_000, fixture => {
    fixture.environment.PROVIDER_TOKEN = vaultToken;
  });
  try {
    const scratchDir = join(f.root, 'cas-scrub');
    await mkdir(scratchDir, { mode: 0o700 });
    const shaDir = join(f.artifacts.directory, 'blobs', 'sha256');

    const derivedForms = [
      vaultToken,
      JSON.stringify(vaultToken).slice(1, -1).replaceAll('/', '\\/'),
      encodeURIComponent(vaultToken),
      Buffer.from(vaultToken, 'utf8').toString('base64'),
    ];

    for (const [idx, form] of derivedForms.entries()) {
      const formBuf = Buffer.from(form, 'utf8');
      const splitOffset = Math.floor(formBuf.byteLength / 2);
      // Put 3-byte UTF-8 '€' ending right before the secret straddling byte 65_536
      const leadFillLen = 65_536 - splitOffset - 3;
      const body = Buffer.concat([
        Buffer.alloc(leadFillLen, 0x78),
        Buffer.from('€', 'utf8'),
        formBuf,
        Buffer.alloc(70_000, 0x79),
      ]);
      assert.equal(
        body.subarray(65_536 - splitOffset, 65_536 - splitOffset + formBuf.byteLength).equals(formBuf),
        true,
      );
      const leakedPath = join(scratchDir, `leaked-${idx}.bin`);
      await writeFile(leakedPath, body, { mode: 0o600 });

      await assert.rejects(
        f.artifacts.putCasBlobFromFile(`leaked-${idx}.bin`, leakedPath),
        (err: unknown) =>
          err instanceof ControllerFailure
          && err.diagnostic.code === 'CONFIG_CREDENTIAL_INVALID'
          && err.diagnostic.path === '/spec/credentials',
      );
      assert.deepEqual(await readdir(shaDir).catch(() => []), []);
    }

    // 3. Clean file with 40-char and 64-char hex Git OIDs succeeds without false positives
    const cleanGitOids = Buffer.concat([
      Buffer.alloc(65_520, 0x41),
      Buffer.from('0123456789abcdef0123456789abcdef01234567\n' + 'fedcba9876543210'.repeat(4) + '\n', 'utf8'),
      Buffer.alloc(8_192, 0x42),
    ]);
    const cleanPtr = await f.artifacts.putCasBlobFromBytes('clean-oids.txt', cleanGitOids);
    assert.equal(cleanPtr.byteLength, cleanGitOids.byteLength);

    // 4. Dedup hit under a newly expanded vault MUST still scrub before checking existing <hex>!
    const secondSecret = 'ExpandedGateSecret+Gamma/Delta11223344=';
    const secondEncoded = Buffer.from(encodeURIComponent(secondSecret), 'utf8');
    const dedupBody = Buffer.concat([
      Buffer.alloc(65_536 - 10, 0x6d),
      secondEncoded,
      Buffer.alloc(32_768, 0x6e),
    ]);
    const dedupSrc = join(scratchDir, 'dedup-secret.bin');
    await writeFile(dedupSrc, dedupBody, { mode: 0o600 });

    // Store 1 (without secondSecret) commits <hex>
    const committedBeforeExpansion = await f.artifacts.putCasBlobFromFile('dedup.bin', dedupSrc);
    assert.equal((await lstat(committedBeforeExpansion.path)).isFile(), true);

    // Expand configuration with secondSecret and load a second vault on the SAME artifacts directory
    f.environment.GATE_SECRET = secondSecret;
    setFixture(f.registry, ['spec', 'credentialBindings'], [
      ...f.registry.spec.credentialBindings,
      { id: 'gate-signer', consumer: 'gate', destinationRef: 'gate-svc', environmentNames: ['GATE_SECRET'], template: '${GATE_SECRET}' },
    ]);
    setFixture(f.registry, ['spec', 'environmentBindings'], [
      ...f.registry.spec.environmentBindings,
      { name: 'GATE_SECRET', classification: 'credential', paths: ['/spec/credentials/1/template'] },
    ]);
    setFixture(f.config, ['spec', 'credentials'], [
      ...f.config.spec.credentials,
      { ref: 'gate-signer', template: '${GATE_SECRET}' },
    ]);
    await f.save();
    const expandedLoaded = await f.load();
    assert.equal(expandedLoaded.ok, true);
    if (!expandedLoaded.ok) throw new Error('expected expanded config load');

    const expandedStore = new ArtifactStore(f.artifacts.directory, f.owner, approvedState(expandedLoaded.value).vault);
    await assert.rejects(
      expandedStore.putCasBlobFromFile('dedup.bin', dedupSrc),
      (err: unknown) =>
        err instanceof ControllerFailure
        && err.diagnostic.code === 'CONFIG_CREDENTIAL_INVALID'
        && err.diagnostic.path === '/spec/credentials',
    );
    await assert.rejects(
      expandedStore.putCasBlobFromBytes('dedup.bin', dedupBody),
      (err: unknown) =>
        err instanceof ControllerFailure
        && err.diagnostic.code === 'CONFIG_CREDENTIAL_INVALID'
        && err.diagnostic.path === '/spec/credentials',
    );
    const afterDedupEntries = await readdir(shaDir);
    assert.equal(afterDedupEntries.some(name => name.startsWith('.tmp-')), false);
  } finally {
    await f.close();
  }
});
