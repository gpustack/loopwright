import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fsPromises } from 'node:fs';
import { chmod, link, lstat, mkdir, readdir, readFile, symlink, truncate, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OVERLAY_LIMITS } from '@loopwright/core';
import { createCredentialStreamChecker, createVault } from '../src/credentials.js';
import { ControllerFailure } from '../src/errors.js';
import { copyVerifiedFileReadOnly, STREAM_CHUNK_BYTES, streamRegularFile } from '../src/files.js';
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

    // 2. Multi-chunk (> 2 MiB across 1 MiB boundaries) binary file via putCasBlobFromFile
    assert.equal(STREAM_CHUNK_BYTES, 1_048_576);
    const payload = Buffer.alloc(STREAM_CHUNK_BYTES * 2 + 137, 0x5a);
    payload[0] = 0x11;
    payload[STREAM_CHUNK_BYTES - 1] = 0x22;
    payload[STREAM_CHUNK_BYTES] = 0x33;
    payload[STREAM_CHUNK_BYTES * 2] = 0x44;
    payload[payload.byteLength - 1] = 0xee;
    const srcFile = join(scratchDir, 'large.bin');
    await writeFile(srcFile, payload, { mode: 0o700 });
    await chmod(srcFile, 0o700);

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

    // 3. Canonical resolution and single-fd 1 MiB chunked verification reconstruct exact bytes
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
    assert.equal(streamedChunks.length, 3);
    assert.deepEqual(Buffer.concat(streamedChunks), payload);

    // 4. copyVerifiedFileReadOnly supports CoW reflink and 1 MiB streaming fallback (disableReflink: true) with nlink === 1
    const copiedDest = join(scratchDir, 'copied-readonly.bin');
    const copied = await copyVerifiedFileReadOnly(ptr.path, copiedDest, { expectedSha256: expectedHex });
    assert.equal(copied.byteLength, payload.byteLength);
    assert.equal(copied.sha256, expectedHex);
    assert.equal(copied.sourceMode, '100644');
    const copiedStat = await lstat(copiedDest);
    assert.equal(copiedStat.nlink, 1);
    assert.equal(copiedStat.mode & 0o777, 0o400);

    const fallbackDest = join(scratchDir, 'copied-fallback-exec.bin');
    const fallbackCopied = await copyVerifiedFileReadOnly(srcFile, fallbackDest, {
      expectedSha256: expectedHex,
      mode: 0o600,
      disableReflink: true,
    });
    assert.equal(fallbackCopied.byteLength, payload.byteLength);
    assert.equal(fallbackCopied.sha256, expectedHex);
    assert.equal(fallbackCopied.sourceMode, '100755');
    const fallbackStat = await lstat(fallbackDest);
    assert.equal(fallbackStat.nlink, 1);
    assert.equal(fallbackStat.mode & 0o777, 0o600);

    // Pre-existing destination fails immediately without unlinking pre-existing file
    const preExistingDest = join(scratchDir, 'pre-existing.bin');
    await writeFile(preExistingDest, 'keep-existing', { mode: 0o600 });
    await assert.rejects(
      copyVerifiedFileReadOnly(ptr.path, preExistingDest, { expectedSha256: expectedHex }),
      (err: unknown) => err instanceof ControllerFailure && err.diagnostic.code === 'ARTIFACT_INVALID',
    );
    assert.equal((await lstat(preExistingDest)).size, Buffer.byteLength('keep-existing'));

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

test('derived-form sliding-window secret scrubber catches raw, JSON-escaped, URL-encoded, and base64 secrets across 1 MiB boundaries and dedup hits', async () => {
  assert.equal(STREAM_CHUNK_BYTES, 1_048_576);
  // 1. Direct unit test for multi-byte UTF-8 and JSON-escaped quotes/backslashes split across 1 MiB chunk boundaries
  const richSecret = 'sec"ret\\line\n🔑-ω-canary';
  for (const encodedForm of [
    richSecret,
    JSON.stringify(richSecret).slice(1, -1),
    encodeURIComponent(richSecret),
    Buffer.from(richSecret, 'utf8').toString('base64'),
  ]) {
    // Place a 4-byte + 3-byte UTF-8 sequence right before the secret starting at 1_048_576 - 10
    const utf8Lead = Buffer.from('🚀€', 'utf8'); // 7 bytes
    const prefix = Buffer.alloc(1_048_576 - 10 - utf8Lead.byteLength, 0x61);
    const secretBytes = Buffer.from(encodedForm, 'utf8');
    const full = Buffer.concat([prefix, utf8Lead, secretBytes, Buffer.alloc(4096, 0x62)]);
    const chunk1 = full.subarray(0, 1_048_576);
    const chunk2 = full.subarray(1_048_576);

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

  // 2. End-to-end ArtifactStore CAS ingestion: raw, JSON-solidus-escaped, URL-encoded, and base64 straddling 1_048_576-byte boundary
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
      const startAt = 1_048_576 - 10;
      // Put 3-byte UTF-8 '€' ending right before the secret starting at 1_048_576 - 10
      const leadFillLen = startAt - 3;
      const body = Buffer.concat([
        Buffer.alloc(leadFillLen, 0x78),
        Buffer.from('€', 'utf8'),
        formBuf,
        Buffer.alloc(32_768, 0x79),
      ]);
      assert.equal(
        body.subarray(startAt, startAt + formBuf.byteLength).equals(formBuf),
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

    // 3. Clean file with 40-char and 64-char hex Git OIDs across 1 MiB boundary succeeds without false positives
    const cleanGitOids = Buffer.concat([
      Buffer.alloc(1_048_576 - 16, 0x41),
      Buffer.from('0123456789abcdef0123456789abcdef01234567\n' + 'fedcba9876543210'.repeat(4) + '\n', 'utf8'),
      Buffer.alloc(8_192, 0x42),
    ]);
    const cleanPtr = await f.artifacts.putCasBlobFromBytes('clean-oids.txt', cleanGitOids);
    assert.equal(cleanPtr.byteLength, cleanGitOids.byteLength);

    // 4. Dedup hit under a newly expanded vault MUST still scrub across 1 MiB boundary before checking existing <hex>!
    const secondSecret = 'ExpandedGateSecret+Gamma/Delta11223344=';
    const secondEncoded = Buffer.from(encodeURIComponent(secondSecret), 'utf8');
    const dedupBody = Buffer.concat([
      Buffer.alloc(1_048_576 - 10, 0x6d),
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

test('empty credential vault rejects generic tokens in assertClean and createStreamChecker across 1 MiB chunk boundaries, and tryReuseCasBlob verifies without writing .tmp files', async () => {
  const f = await retainedFixture();
  try {
    const emptyVault = createVault([], f.loaded.registry);
    const genericTokens = [
      'ghp_0123456789abcdefghij0123456789',
      'github_pat_11AAAAAA0123456789_abcdefghij',
      '-----BEGIN PRIVATE KEY-----',
      '-----BEGIN RSA PRIVATE KEY-----',
      'sk-ant-api03-0123456789abcdefghij',
      'sk-proj-0123456789abcdefghij012345',
      'AKIAIOSFODNN7EXAMPLE',
    ];

    for (const token of genericTokens) {
      assert.throws(
        () => emptyVault.assertClean(`prefix ${token} suffix`),
        (err: unknown) =>
          err instanceof ControllerFailure
          && err.diagnostic.code === 'CONFIG_CREDENTIAL_INVALID'
          && err.diagnostic.path === '/spec/credentials',
        `assertClean should reject ${token}`,
      );
      assert.throws(
        () => emptyVault.assertClean(Buffer.from(`prefix ${token} suffix`, 'utf8')),
        (err: unknown) =>
          err instanceof ControllerFailure
          && err.diagnostic.code === 'CONFIG_CREDENTIAL_INVALID'
          && err.diagnostic.path === '/spec/credentials',
      );

      // Split token right across a 1 MiB boundary in createStreamChecker()
      const tokenBuf = Buffer.from(token, 'utf8');
      const splitOffset = 1_048_576 - Math.floor(tokenBuf.byteLength / 2);
      const full = Buffer.concat([
        Buffer.alloc(splitOffset, 0x20),
        tokenBuf,
        Buffer.alloc(4096, 0x20),
      ]);
      const checker = emptyVault.createStreamChecker();
      checker.push(full.subarray(0, 1_048_576));
      assert.throws(
        () => checker.push(full.subarray(1_048_576)),
        (err: unknown) =>
          err instanceof ControllerFailure
          && err.diagnostic.code === 'CONFIG_CREDENTIAL_INVALID'
          && err.diagnostic.path === '/spec/credentials',
        `streamChecker should reject split ${token}`,
      );
      checker.finish();
    }

    // tryReuseCasBlob returns null when blob is absent, reuses existing blob with zero .tmp writes, and rejects secret-bearing blobs
    const missingSha = sha256Hex(Buffer.from('not-in-cas-yet'));
    assert.equal(await f.artifacts.tryReuseCasBlob('missing.txt', missingSha, 14), null);

    const cleanBody = Buffer.from('clean reusable baseline content\n', 'utf8');
    const seeded = await f.artifacts.putCasBlobFromBytes('clean.txt', cleanBody);
    const statBefore = await lstat(seeded.path);
    const reused = await f.artifacts.tryReuseCasBlob('clean.txt', seeded.sha256, seeded.byteLength);
    assert.ok(reused !== null);
    assert.equal(reused.path, seeded.path);
    assert.equal(reused.sha256, seeded.sha256);
    assert.equal(reused.byteLength, seeded.byteLength);
    assert.equal(reused.blobRef.uri, `cas://sha256/${seeded.sha256}`);
    const statAfter = await lstat(seeded.path);
    assert.equal(statAfter.ino, statBefore.ino);
    assert.equal(statAfter.mtimeMs, statBefore.mtimeMs);

    // Pre-plant a blob containing a generic token directly in CAS and verify tryReuseCasBlob rejects it!
    const leakedBody = Buffer.from('export const k = "ghp_0123456789abcdefghij0123456789";\n', 'utf8');
    const leakedSha = sha256Hex(leakedBody);
    const leakedCasPath = join(f.artifacts.directory, 'blobs', 'sha256', leakedSha);
    await writeFile(leakedCasPath, leakedBody, { mode: 0o400 });
    await chmod(leakedCasPath, 0o400);
    await assert.rejects(
      f.artifacts.tryReuseCasBlob('leaked.ts', leakedSha, leakedBody.byteLength),
      (err: unknown) =>
        err instanceof ControllerFailure
        && err.diagnostic.code === 'CONFIG_CREDENTIAL_INVALID'
        && err.diagnostic.path === '/spec/credentials',
    );
  } finally {
    await f.close();
  }
});

test('R2-11: bounded generic token lookahead avoids chunk-boundary false positive on 17-char AKIA prefix while rejecting true 16-char AKIA keys', () => {
  // 1. "prefix_" + "AKIA" + "A".repeat(17) (17 chars after AKIA) MUST pass both as single buffer and when split after the 16th A at a 1 MiB chunk boundary
  const benignSuffix = 'prefix_' + 'AKIA' + 'A'.repeat(17);
  const singleChecker = createCredentialStreamChecker([]);
  singleChecker.push(Buffer.from(benignSuffix, 'utf8'));
  singleChecker.finish();

  const splitAt16 = 'prefix_' + 'AKIA' + 'A'.repeat(16);
  const padLen = STREAM_CHUNK_BYTES - Buffer.byteLength(splitAt16, 'utf8');
  const chunk1 = Buffer.concat([Buffer.alloc(padLen, 0x20), Buffer.from(splitAt16, 'utf8')]);
  assert.equal(chunk1.byteLength, STREAM_CHUNK_BYTES);
  const splitBenignChecker = createCredentialStreamChecker([]);
  splitBenignChecker.push(chunk1);
  splitBenignChecker.push(Buffer.from('A', 'utf8'));
  splitBenignChecker.finish();

  // 2. True 16-char AKIA key at EOF across 1 MiB boundary MUST be rejected on finish()
  const eofChecker = createCredentialStreamChecker([]);
  eofChecker.push(chunk1);
  assert.throws(
    () => eofChecker.finish(),
    (err: unknown) =>
      err instanceof ControllerFailure
      && err.diagnostic.code === 'CONFIG_CREDENTIAL_INVALID'
      && err.diagnostic.path === '/spec/credentials',
  );
  // Idempotent finish() after failure must not throw again
  eofChecker.finish();

  // 3. True 16-char AKIA key followed by space or newline across 1 MiB boundary MUST be rejected on chunk 2
  for (const delimiter of [' ', '\n']) {
    const delimChecker = createCredentialStreamChecker([]);
    delimChecker.push(chunk1);
    assert.throws(
      () => delimChecker.push(Buffer.from(delimiter, 'utf8')),
      (err: unknown) =>
        err instanceof ControllerFailure
        && err.diagnostic.code === 'CONFIG_CREDENTIAL_INVALID'
        && err.diagnostic.path === '/spec/credentials',
    );
    delimChecker.finish();
  }

  // 4. Carry-tail left truncation must not turn a preceded "XAKIA..." into a false positive on a subsequent chunk
  const preceded = Buffer.concat([
    Buffer.from('X' + 'AKIA' + 'A'.repeat(16), 'utf8'),
    Buffer.alloc(16_364, 0x20),
  ]);
  const truncationChecker = createCredentialStreamChecker([]);
  truncationChecker.push(preceded);
  truncationChecker.push(Buffer.from('hello world\n', 'utf8'));
  truncationChecker.finish();
});

test('R5-10: copyVerifiedFileReadOnly binds staging, verification, fchmod, and link to one owned descriptor with zero pathname chmod calls', async () => {
  const f = await retainedFixture();
  try {
    const scratchDir = join(f.root, 'r5-10-owned-fd');
    await mkdir(scratchDir, { mode: 0o700 });

    const payload = Buffer.alloc(STREAM_CHUNK_BYTES + 4096, 0x6b);
    payload[0] = 0x21;
    payload[payload.byteLength - 1] = 0x7e;
    const expectedHex = sha256Hex(payload);
    const srcPath = join(scratchDir, 'source.bin');
    await writeFile(srcPath, payload, { mode: 0o400 });
    await chmod(srcPath, 0o400);
    const srcStat = await lstat(srcPath);

    const chmodSpy = mock.method(fsPromises, 'chmod', () => {
      throw new Error('pathname chmod must not be called by copyVerifiedFileReadOnly');
    });
    try {
      for (const targetMode of [0o400, 0o444, 0o555] as const) {
        const destPath = join(scratchDir, `dest-${targetMode.toString(8)}.bin`);
        const copied = await copyVerifiedFileReadOnly(srcPath, destPath, {
          expectedBytes: payload.byteLength,
          expectedSha256: expectedHex,
          mode: targetMode,
          ownedSource: true,
          requireReadOnlySource: true,
        });
        assert.equal(copied.byteLength, payload.byteLength);
        assert.equal(copied.sha256, expectedHex);

        const destStat = await lstat(destPath);
        assert.equal(destStat.isFile(), true);
        assert.equal(destStat.isSymbolicLink(), false);
        assert.equal(destStat.nlink, 1);
        assert.notEqual(destStat.ino, srcStat.ino);
        assert.equal(destStat.mode & 0o777, targetMode);
        assert.equal(sha256Hex(await readFile(destPath)), expectedHex);
      }

      // Pre-existing EEXIST target keeps exact mode, inode, and content untouched.
      const existingPath = join(scratchDir, 'pre-existing.bin');
      await writeFile(existingPath, 'keep-existing-r5-10', { mode: 0o600 });
      const existingBefore = await lstat(existingPath);
      await assert.rejects(
        copyVerifiedFileReadOnly(srcPath, existingPath, {
          expectedBytes: payload.byteLength,
          expectedSha256: expectedHex,
          mode: 0o444,
        }),
        (err: unknown) => err instanceof ControllerFailure && err.diagnostic.code === 'ARTIFACT_INVALID',
      );
      const existingAfter = await lstat(existingPath);
      assert.equal(existingAfter.ino, existingBefore.ino);
      assert.equal(existingAfter.mode & 0o777, existingBefore.mode & 0o777);
      assert.equal(await readFile(existingPath, 'utf8'), 'keep-existing-r5-10');

      assert.equal(chmodSpy.mock.callCount(), 0);
      const remainingEntries = await readdir(scratchDir);
      assert.equal(remainingEntries.some(name => name.startsWith('.lw-stage-')), false);
    } finally {
      chmodSpy.mock.restore();
    }
  } finally {
    await f.close();
  }
});
