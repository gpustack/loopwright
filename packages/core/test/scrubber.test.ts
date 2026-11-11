import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SecretScrubber } from '../src/scrubber.js';

describe('SecretScrubber', () => {
  it('scrubs registered secrets in raw, JSON-escaped, URL-encoded, and base64 forms', () => {
    const scrubber = new SecretScrubber();
    scrubber.register('hunter2-secret-value');
    const raw = 'token=hunter2-secret-value';
    const escaped = 'token="hunter2-secret-value"';
    const encoded = `token=${encodeURIComponent('hunter2-secret-value')}`;
    const base64 = `token=${Buffer.from('hunter2-secret-value', 'utf8').toString('base64')}`;
    for (const text of [raw, escaped, encoded, base64]) {
      assert.equal(scrubber.containsSecret(text), true);
      assert.equal(scrubber.scrub(text).includes('hunter2-secret-value'), false);
      assert.equal(scrubber.scrub(text).includes('[scrubbed]'), true);
    }
  });

  it('ignores short or empty secrets that would over-match', () => {
    const scrubber = new SecretScrubber();
    scrubber.register('ab');
    scrubber.register('');
    assert.equal(scrubber.containsSecret('ab'), false);
    assert.equal(scrubber.scrub('abc'), 'abc');
  });

  it('detects generic token patterns without registration', () => {
    const scrubber = new SecretScrubber();
    assert.equal(scrubber.containsSecret('found ghs_AAAABBBBCCCCDDDDEEEE token'), true);
    assert.equal(scrubber.containsSecret('found ghp_AAAABBBBCCCCDDDDEEEE token'), true);
    assert.equal(scrubber.containsSecret('found github_pat_AAAA_BBBBCCCCDDDDEEEE token'), true);
    assert.equal(scrubber.containsSecret('-----BEGIN RSA PRIVATE KEY-----'), true);
    assert.equal(scrubber.containsSecret('nothing secret here'), false);
    assert.equal(scrubber.scrub('keep ghs_AAAABBBBCCCCDDDDEEEE out'), 'keep [scrubbed] out');
  });

  it('scrubs every occurrence and leaves clean text untouched', () => {
    const scrubber = new SecretScrubber();
    scrubber.register('hunter2-secret-value');
    const text = 'a hunter2-secret-value b hunter2-secret-value c';
    assert.equal(scrubber.scrub(text), 'a [scrubbed] b [scrubbed] c');
    assert.equal(scrubber.scrub('clean text'), 'clean text');
  });
});
