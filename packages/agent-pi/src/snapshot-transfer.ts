import { createHash } from 'node:crypto';
import { Channel, type ChannelMessage } from './protocol.js';
import { object, integer, text } from './boundary.js';
import { refuse } from './errors.js';
/** A single acknowledged 32 KiB chunk is in flight; aggregate snapshots need no large protocol message. */
export class SnapshotTransfer {
  #ordinal = 0;
  #incoming: { query: number; index: number; bytes: number; max: number; busy: boolean; hash: ReturnType<typeof createHash>; sink: (bytes: Uint8Array) => Promise<void>; resolve: () => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  #ack: { query: number; index: number; resolve: () => void; reject: (error: unknown) => void } | null = null;
  constructor(readonly channel: Channel) {}
  expect(sink: (bytes: Uint8Array) => Promise<void>, max: number, timeout: number): { query: number; done: Promise<void> } {
    if (this.#incoming) refuse('SESSION_BUSY'); const query = ++this.#ordinal;
    const done = new Promise<void>((resolve, reject) => { const timer = setTimeout(() => this.close(), timeout); this.#incoming = { query, index: 0, bytes: 0, max, busy: false, hash: createHash('sha256'), sink, resolve, reject, timer }; }); void done.catch(() => {});
    return { query, done };
  }
  async send(query: number, chunks: AsyncIterable<Uint8Array>, max: number, beforeEnd: () => void = () => {}): Promise<void> {
    const hash = createHash('sha256'); let length = 0, index = 0;
    for await (const chunk of chunks) {
      for (let offset = 0; offset < chunk.length; offset += 32768) {
        const bytes = chunk.subarray(offset, offset + 32768); length += bytes.length; if (length > max || this.#ack) refuse('OUTPUT_LIMIT'); hash.update(bytes);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const ack = new Promise<void>((resolve, reject) => { this.#ack = { query, index, resolve, reject }; timer = setTimeout(() => this.close(), 10000); }); void ack.catch(() => {});
        try { await this.channel.sendBytes('snapshot-chunk', { query, index }, bytes); await ack; } finally { clearTimeout(timer); this.#ack = null; } index++;
      }
    }
    beforeEnd(); await this.channel.send('snapshot-end', { query, chunks: index, byteLength: length, digest: hash.digest('hex') });
  }
  async receive(message: ChannelMessage): Promise<boolean> {
    if (message.kind === 'snapshot-ack') {
      const value = object(message.body, ['query', 'index']), ack = this.#ack;
      if (!ack || value.query !== ack.query || value.index !== ack.index) refuse('RECOVERY_REQUIRED'); this.#ack = null; ack.resolve(); return true;
    }
    if (message.kind !== 'snapshot-chunk' && message.kind !== 'snapshot-end') return false;
    const incoming = this.#incoming; if (!incoming || incoming.busy) refuse('RECOVERY_REQUIRED'); incoming.busy = true;
    try {
      if (message.kind === 'snapshot-chunk') {
        const value = message.body as { metadata: unknown; bytes: Uint8Array }, meta = object(value.metadata, ['query', 'index']);
        if (meta.query !== incoming.query || meta.index !== incoming.index || !(value.bytes instanceof Uint8Array) || value.bytes.length === 0 || value.bytes.length > 32768 || incoming.bytes + value.bytes.length > incoming.max) refuse('RECOVERY_REQUIRED');
        incoming.bytes += value.bytes.length; incoming.hash.update(value.bytes); await incoming.sink(value.bytes);
        incoming.busy = false; await this.channel.send('snapshot-ack', { query: incoming.query, index: incoming.index++ });
      } else {
        const value = object(message.body, ['query', 'chunks', 'byteLength', 'digest']); integer(value.chunks, 0, 8192); integer(value.byteLength, 0, incoming.max); text(value.digest);
        if (value.query !== incoming.query || value.chunks !== incoming.index || value.byteLength !== incoming.bytes || value.digest !== incoming.hash.digest('hex')) refuse('RECOVERY_REQUIRED');
        clearTimeout(incoming.timer); this.#incoming = null; incoming.resolve();
      }
    } catch (error) { this.close(error); throw error; }
    return true;
  }
  close(error: unknown = new Error('Snapshot transfer closed')): void {
    const incoming = this.#incoming; this.#incoming = null; if (incoming) { clearTimeout(incoming.timer); incoming.reject(error); }
    this.#ack?.reject(error); this.#ack = null;
  }
}
