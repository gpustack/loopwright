import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TaskpackError } from '../src/types.js';
import {
  assertCleanArtifact,
  assertStreamClean,
  createStreamScrubber,
  DEFAULT_STREAM_OVERLAP_BYTES,
  scrubStreamChunk,
  SecretScrubber,
} from '../src/scrubber.js';

describe('scrubber.ts: derived-form scrubbing and 64 KiB boundary sliding-window stream scrubber', () => {
  it('scrubs and detects raw, JSON-escaped, URL-encoded, base64, and generic secret forms', () => {
    const secret = 'tok/with+special"chars&value=987654321';
    const scrubber = new SecretScrubber();
    scrubber.register(secret);

    assert.equal(scrubber.streamOverlapBytes, DEFAULT_STREAM_OVERLAP_BYTES);
    assert.equal(scrubber.scrub(`raw=${secret}`), 'raw=[scrubbed]');
    assert.equal(scrubber.scrub(`json=${JSON.stringify(secret).slice(1, -1)}`), 'json=[scrubbed]');
    assert.equal(scrubber.scrub(`url=${encodeURIComponent(secret)}`), 'url=[scrubbed]');
    assert.equal(scrubber.scrub(`b64=${Buffer.from(secret, 'utf8').toString('base64')}`), 'b64=[scrubbed]');

    assert.throws(
      () => scrubber.assertClean({ nested: secret }),
      (err: unknown) => err instanceof TaskpackError && err.code === 'TOKEN_SECRET_LEAK_DETECTED',
    );
    assert.throws(
      () => assertCleanArtifact(`ghs_${'a'.repeat(24)}`),
      (err: unknown) => err instanceof TaskpackError && err.code === 'TOKEN_SECRET_LEAK_DETECTED',
    );
  });

  it('detects raw, JSON-escaped, URL-encoded, base64, and multi-byte UTF-8 secrets spanning a 1 MiB chunk boundary', async () => {
    const secret = 'sec/边界+"val&1234567890';
    const scrubber = new SecretScrubber();
    scrubber.register(secret);

    const forms = [
      secret,
      JSON.stringify(secret).slice(1, -1),
      encodeURIComponent(secret),
      Buffer.from(secret, 'utf8').toString('base64'),
      `ghs_${'z'.repeat(24)}`,
    ];

    for (const form of forms) {
      const formBuf = Buffer.from(form, 'utf8');
      const splitPoint = Math.min(10, Math.floor(formBuf.byteLength / 2));
      const chunk1 = Buffer.concat([
        Buffer.alloc(1_048_576 - splitPoint, 0x61), // 'a' padding up to exact 1 MiB chunk boundary
        formBuf.subarray(0, splitPoint),
      ]);
      const chunk2 = Buffer.concat([
        formBuf.subarray(splitPoint),
        Buffer.alloc(1024, 0x62),
      ]);
      assert.equal(chunk1.byteLength, 1_048_576);

      await assert.rejects(
        assertStreamClean([chunk1, chunk2], scrubber, '/stream-test'),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TOKEN_SECRET_LEAK_DETECTED',
      );

      // Streaming scrub replaces the boundary-spanning secret completely without corrupting UTF-8
      const stream = createStreamScrubber(scrubber);
      const out = scrubStreamChunk(stream, chunk1) + scrubStreamChunk(stream, chunk2) + stream.flushScrub();
      assert.equal(out.includes(form), false);
      assert.ok(out.includes('[scrubbed]'));
    }

    // Multi-byte UTF-8 character split mid-codepoint across clean 1 MiB chunks survives intact
    const emojiBuf = Buffer.from('🚀', 'utf8'); // 4-byte UTF-8 sequence
    const cleanChunk1 = Buffer.concat([Buffer.alloc(1_048_576 - 2, 0x63), emojiBuf.subarray(0, 2)]);
    const cleanChunk2 = Buffer.concat([emojiBuf.subarray(2), Buffer.from('-done', 'utf8')]);
    assert.equal(cleanChunk1.byteLength, 1_048_576);
    await assert.doesNotReject(assertStreamClean([cleanChunk1, cleanChunk2], scrubber));
    const cleanStream = createStreamScrubber(scrubber);
    const cleanOut = scrubStreamChunk(cleanStream, cleanChunk1) + scrubStreamChunk(cleanStream, cleanChunk2) + cleanStream.flushScrub();
    assert.ok(cleanOut.endsWith('🚀-done'));

    // Dynamic overlap grows beyond 16 KiB when a derived secret form exceeds 16 KiB
    const hugeSecret = 'K'.repeat(18_000);
    scrubber.register(hugeSecret);
    assert.ok(scrubber.streamOverlapBytes >= Buffer.from(hugeSecret, 'utf8').toString('base64').length);
    const hugeB64 = Buffer.from(hugeSecret, 'utf8').toString('base64');
    const hugeBuf = Buffer.from(hugeB64, 'utf8');
    const half = Math.floor(hugeBuf.byteLength / 2);
    await assert.rejects(
      assertStreamClean([hugeBuf.subarray(0, half), hugeBuf.subarray(half)], scrubber),
      (err: unknown) => err instanceof TaskpackError && err.code === 'TOKEN_SECRET_LEAK_DETECTED',
    );
  });
});
