import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { Channel } from '../src/protocol.js';
test('private pipe frames bind nonce/sequence and transfer bounded binary without reparsing data', async () => {
  const forward = new PassThrough(), back = new PassThrough(), left = new Channel('nonce', back, forward), right = new Channel('nonce', forward, back);
  const received = once(right, 'message'); const bytes = Buffer.from('{"kind":"fetch","nonce":"forged"}');
  await left.sendBytes('fixture', { status: 200 }, bytes); const [message] = await received;
  assert.equal(message.kind, 'fixture'); assert.deepEqual(message.body.bytes, bytes); assert.deepEqual({ ...message.body.metadata }, { status: 200 });
  left.close(); right.close();
});
test('forged nonce, duplicate sequence and oversized frames close before dispatch', () => {
  for (const bad of [JSON.stringify({ version: 1, sequence: 1, nonce: 'forged', kind: 'end', body: null }) + '\n',
    [1, 1].map(sequence => JSON.stringify({ version: 1, nonce: 'owned', sequence, kind: 'begin', body: { kind: 'fixture', encoding: 'json', metadata: null, length: 0, digest: 'a'.repeat(64) } }) + '\n').join(''), 'x'.repeat(65537), '{"version":1,"version":1}\n']) {
    const input = new PassThrough(), output = new PassThrough(), channel = new Channel('owned', input, output); let failed = 0, delivered = 0;
    channel.on('failed', () => { failed++; }); channel.on('message', () => { delivered++; }); input.write(bad);
    assert.equal(failed, 1); assert.equal(delivered, 0); channel.close(); input.destroy(); output.destroy();
  }
});
test('concurrent control sends stay ordered and queued bytes have an independent ceiling', async () => {
  const forward = new PassThrough(), back = new PassThrough(), left = new Channel('nonce', back, forward), right = new Channel('nonce', forward, back);
  const received: string[] = []; right.on('message', message => { received.push(message.kind); });
  const first = left.sendBytes('first', null, Buffer.alloc(10)), second = left.sendBytes('second', null, Buffer.alloc(200000));
  await assert.rejects(left.sendBytes('too-much-pending', null, Buffer.alloc(100000)));
  await Promise.all([first, second]); assert.deepEqual(received, ['first', 'second']); left.close(); right.close();
});
test('a final effect guard can refuse after payload frames without dispatching a command', async t => {
  const forward = new PassThrough(), back = new PassThrough(), left = new Channel('nonce', back, forward), right = new Channel('nonce', forward, back);
  let delivered = 0, checks = 0; right.on('message', () => { delivered++; });
  const send: (kind: string, metadata: unknown, bytes: Uint8Array, encoding: string, guard: () => void) => Promise<void> = left.sendBytes.bind(left);
  try {
    await assert.rejects(send('execute-tool', null, Buffer.from('bounded payload'), 'binary', () => { checks++; throw new Error('current authority refused'); }));
    assert.equal(checks, 1); assert.equal(delivered, 0);
  } finally { t.diagnostic(JSON.stringify({ delivered, checks })); left.close(); right.close(); }
});
