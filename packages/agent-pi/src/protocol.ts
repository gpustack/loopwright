import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { createHash } from 'node:crypto';
import { parseBoundedJson } from './context.js';
export interface ChannelMessage { readonly kind: string; readonly body: unknown }
/** Private inherited-pipe channel: nonce and sequence supplement, rather than replace, channel ownership. */
export class Channel extends EventEmitter {
  #input = Buffer.alloc(0); #readSequence = 0; #writeSequence = 0; #closed = false; #pendingMessages = 0; #queuedBytes = 0; #tail: Promise<void> = Promise.resolve();
  #assembly: { kind: string; length: number; digest: string; encoding: string; metadata: unknown; chunks: Buffer[]; bytes: number; index: number } | null = null;
  constructor(readonly nonce: string, input: Readable, readonly output: Writable) {
    super();
    input.on('data', chunk => {
      if (this.#closed) return;
      try {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        let offset = 0;
        while (offset < data.length) {
          const end = data.indexOf(10, offset), part = data.subarray(offset, end < 0 ? data.length : end);
          if (this.#input.length + part.length > 65536) throw new Error('frame limit');
          this.#input = Buffer.concat([this.#input, part]); offset += part.length + (end < 0 ? 0 : 1);
          if (end < 0) break;
          const frame = this.#input; this.#input = Buffer.alloc(0); this.#accept(frame);
        }
      } catch (error) { const allowed = ['frame limit', 'frame object', 'frame identity', 'assembly', 'data', 'chunk', 'end', 'digest', 'opcode']; this.fail(error instanceof Error && allowed.includes(error.message) ? error.message : 'json_invalid'); }
    });
    input.once('end', () => { if (!this.#closed) this.fail(); }); input.once('error', () => this.fail());
    output.once('error', () => this.fail());
  }
  #accept(bytes: Buffer): void {
    const value = parseBoundedJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), { nodes: 524288, array: 16384, properties: 1024 });
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('frame object');
    if (Object.keys(value).sort().join(',') !== 'body,kind,nonce,sequence,version' || value.version !== 1 || value.nonce !== this.nonce || value.sequence !== ++this.#readSequence || typeof value.kind !== 'string') throw new Error('frame identity');
    const body = value.body as Record<string, unknown>;
    if (value.kind === 'begin') {
      if (this.#assembly || !body || Object.keys(body).sort().join(',') !== 'digest,encoding,kind,length,metadata' || !['json', 'binary'].includes(body.encoding as string) || typeof body.kind !== 'string' || !Number.isSafeInteger(body.length) || (body.length as number) < 0 || (body.length as number) > 67108864 || typeof body.digest !== 'string' || !/^[a-f0-9]{64}$/.test(body.digest)) throw new Error('assembly');
      this.#assembly = { kind: body.kind, length: body.length as number, digest: body.digest, encoding: body.encoding as string, metadata: body.metadata, chunks: [], bytes: 0, index: 0 }; return;
    }
    if (value.kind === 'data') {
      const state = this.#assembly;
      if (!state || !body || Object.keys(body).sort().join(',') !== 'data,index' || body.index !== state.index++ || typeof body.data !== 'string' || body.data.length > 43692) throw new Error('data');
      const part = Buffer.from(body.data, 'base64'); if (part.length > 32768 || part.toString('base64') !== body.data || state.bytes + part.length > state.length) throw new Error('chunk');
      state.bytes += part.length; state.chunks.push(part); return;
    }
    if (value.kind === 'end') {
      const state = this.#assembly;
      if (!state || body !== null || state.bytes !== state.length) throw new Error('end');
      const data = Buffer.concat(state.chunks); if (createHash('sha256').update(data).digest('hex') !== state.digest) throw new Error('digest');
      this.#assembly = null;
      this.emit('message', { kind: state.kind, body: state.encoding === 'json' ? parseBoundedJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data), { nodes: 524288, array: 16384, properties: 1024 }) : { metadata: state.metadata, bytes: data } } satisfies ChannelMessage); return;
    }
    throw new Error('opcode');
  }
  async #frame(kind: string, body: unknown): Promise<void> {
    if (this.#closed) throw new Error('closed channel');
    const data = JSON.stringify({ version: 1, nonce: this.nonce, sequence: ++this.#writeSequence, kind, body }) + '\n';
    if (Buffer.byteLength(data) > 65536 || this.output.writableLength + Buffer.byteLength(data) > 262144) throw new Error('channel backpressure');
    await new Promise<void>((resolve, reject) => this.output.write(data, error => error ? reject(error) : resolve()));
  }
  async send(kind: string, body: unknown): Promise<void> { await this.sendBytes(kind, null, Buffer.from(JSON.stringify(body)), 'json'); }
  async sendBytes(kind: string, metadata: unknown, bytes: Uint8Array, encoding = 'binary', beforeCommit?: () => void): Promise<void> {
    const queued = this.#pendingMessages > 0;
    if (this.#closed || bytes.length > 67108864 || this.#pendingMessages >= 8 || queued && this.#queuedBytes + bytes.length > 262144) throw new Error('message or pending-channel bound');
    this.#pendingMessages++; if (queued) this.#queuedBytes += bytes.length;
    const send = this.#tail.then(async () => {
      if (queued) this.#queuedBytes -= bytes.length;
      try {
        await this.#frame('begin', { kind, length: bytes.length, digest: createHash('sha256').update(bytes).digest('hex'), encoding, metadata });
        for (let index = 0, offset = 0; offset < bytes.length; index++, offset += 32768) await this.#frame('data', { index, data: Buffer.from(bytes.subarray(offset, offset + 32768)).toString('base64') });
        // A peer cannot dispatch the assembled command until this final frame is written.
        // Run the trusted current-authority check after queued/backpressured payload writes.
        beforeCommit?.(); await this.#frame('end', null);
      } catch (error) { this.fail('write_failed'); throw error; }
      finally { this.#pendingMessages--; }
    });
    this.#tail = send.catch(() => {}); return send;
  }
  fail(reason = 'closed'): void { if (!this.#closed) { this.#closed = true; this.#assembly = null; this.emit('failed', reason); } }
  close(): void { this.#closed = true; this.#assembly = null; this.output.end(); }
}
