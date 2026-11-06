import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { Channel, type ChannelMessage } from '../src/protocol.js';
import { SnapshotTransfer } from '../src/snapshot-transfer.js';
test('actual pipe framing streams a snapshot larger than one message with one acknowledged chunk in flight', async () => {
  const toOwner = new PassThrough(), toWorker = new PassThrough(), owner = new Channel('fixture', toOwner, toWorker), worker = new Channel('fixture', toWorker, toOwner), receive = new SnapshotTransfer(owner), send = new SnapshotTransfer(worker);
  let bytes = 0, largest = 0, pending = 0, highWater = 0;
  owner.on('message', (message: ChannelMessage) => { void receive.receive(message); }); worker.on('message', (message: ChannelMessage) => { void send.receive(message); });
  const expected = receive.expect(async chunk => { pending++; highWater = Math.max(highWater, pending); largest = Math.max(largest, chunk.length); await new Promise(resolve => setImmediate(resolve)); bytes += chunk.length; pending--; }, 2097152, 10000);
  async function* chunks() { for (let index = 0; index < 40; index++) yield Buffer.alloc(32768, index); }
  await send.send(expected.query, chunks(), 2097152); await expected.done; assert.equal(bytes, 1310720); assert.equal(highWater, 1); assert.equal(largest, 32768); receive.close(); send.close(); owner.close(); worker.close();
});
test('out-of-order snapshot bytes fail the pending capture rather than skipping a chunk', async () => {
  const channel = new Channel('fixture', new PassThrough(), new PassThrough()), transfer = new SnapshotTransfer(channel); let delivered = 0;
  const expected = transfer.expect(async () => { delivered++; }, 4096, 1000);
  await assert.rejects(transfer.receive({ kind: 'snapshot-chunk', body: { metadata: { query: expected.query, index: 1 }, bytes: Buffer.from('unexpected') } })); await assert.rejects(expected.done); assert.equal(delivered, 0); transfer.close(); channel.close();
});
test('a previous acknowledgement cannot clear the next in-flight snapshot sink guard', async () => {
  let releaseAck!: () => void, releaseSink!: () => void, acknowledgements = 0, deliveries = 0;
  const firstAck = new Promise<void>(resolve => { releaseAck = resolve; }), secondSink = new Promise<void>(resolve => { releaseSink = resolve; });
  const channel = { send: async () => { if (++acknowledgements === 1) await firstAck; } } as unknown as Channel;
  const transfer = new SnapshotTransfer(channel), expected = transfer.expect(async () => { if (++deliveries === 2) await secondSink; }, 128, 10000);
  const chunk = (index: number): ChannelMessage => ({ kind: 'snapshot-chunk', body: { metadata: { query: expected.query, index }, bytes: Buffer.from('x') } });
  const first = transfer.receive(chunk(0)); let second: Promise<boolean> | null = null;
  try {
    await new Promise(resolve => setImmediate(resolve)); second = transfer.receive(chunk(1)); await new Promise(resolve => setImmediate(resolve)); releaseAck(); await first;
    await assert.rejects(transfer.receive(chunk(1))); assert.equal(deliveries, 2);
  } finally { transfer.close(); releaseAck(); releaseSink(); await Promise.allSettled([first, ...(second ? [second] : [])]); await assert.rejects(expected.done); }
});
