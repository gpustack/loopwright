import type { PiEvent, PiOpenInput } from './types.js';
import { canonical, freeze } from './boundary.js';
import { PiFailure, refuse } from './errors.js';
type Fields = Partial<Pick<PiEvent, 'requestId' | 'operationId' | 'attemptId' | 'code' | 'count' | 'digest' | 'context'>>;
export type EventPublisher = (kind: PiEvent['kind'], fields?: Fields) => Promise<void>;
/** One ordered consumer; data and waiting producers both have explicit finite limits. */
export class Events {
  #sequence = 0; #persist: (sequence: number) => Promise<void> = async () => {}; #disconnected = false; #bytes = 0; #pending = 0; #ended = false; #consumer = false; #failure: PiFailure | null = null; #tail = Promise.resolve();
  readonly #queue: { event: PiEvent; bytes: number }[] = []; readonly #drain = new Set<() => void>();
  #reader: { resolve: (item: IteratorResult<PiEvent>) => void; reject: (reason: unknown) => void } | null = null;
  highWaterEvents = 0; highWaterBytes = 0;
  restoreSequence(sequence: number, persist: (sequence: number) => Promise<void> = async () => {}): void { if (this.#sequence || !Number.isSafeInteger(sequence) || sequence < 0) refuse('INPUT_INVALID'); this.#sequence = sequence; this.#persist = persist; }
  get sequence(): number { return this.#sequence; }
  constructor(readonly input: PiOpenInput, readonly disconnected: () => Promise<void>, readonly overflow: () => void) {}
  #fail(): PiFailure {
    if (!this.#failure) {
      try { refuse('EVENT_OVERFLOW', '', { phase: 'session' }); } catch (error) { this.#failure = error as PiFailure; }
      this.#reader?.reject(this.#failure); this.#reader = null; for (const wake of this.#drain) wake(); this.#drain.clear(); this.overflow();
    }
    return this.#failure!;
  }
  push(kind: PiEvent['kind'], fields: Fields = {}): Promise<void> {
    if (this.#failure) return Promise.reject(this.#failure); if (this.#ended) return Promise.reject(new Error('Closed event producer'));
    if (this.#pending >= 8) return Promise.reject(this.#fail()); this.#pending++;
    const value = freeze(structuredClone(fields));
    const action = this.#tail.then(async () => {
      if (this.#failure) throw this.#failure; if (this.#ended) refuse('CANCELLED', '', { phase: 'session' });
      const event: PiEvent = freeze({ version: 1, sessionId: this.input.sessionId, runId: this.input.lock.spec.runId, roleId: this.input.roleId, stepId: this.input.stepId, lockHash: { ...this.input.lock.spec.lockHash }, requestId: null, operationId: null, attemptId: null, code: null, count: null, digest: null, context: null, ...value, sequence: this.#sequence + 1, kind });
      const bytes = Buffer.byteLength(canonical(event)); if (bytes > this.input.policy.limits.eventBytes || bytes > this.input.policy.limits.eventQueueBytes) throw this.#fail();
      const full = () => this.#queue.length >= this.input.policy.limits.eventQueue || this.#bytes + bytes > this.input.policy.limits.eventQueueBytes;
      if (full()) {
        let timer: ReturnType<typeof setTimeout> | undefined, wake: () => void = () => {};
        try { await new Promise<void>(resolve => { wake = resolve; this.#drain.add(wake); timer = setTimeout(resolve, 250); }); }
        finally { clearTimeout(timer); this.#drain.delete(wake); }
      }
      if (this.#failure) throw this.#failure; if (this.#ended) refuse('CANCELLED', '', { phase: 'session' }); if (full()) throw this.#fail();
      try { await this.#persist(this.#sequence + 1); } catch { throw this.#fail(); } this.#sequence++;
      if (this.#reader) { const reader = this.#reader; this.#reader = null; reader.resolve({ done: false, value: event }); return; }
      this.#queue.push({ event, bytes }); this.#bytes += bytes; this.highWaterEvents = Math.max(this.highWaterEvents, this.#queue.length); this.highWaterBytes = Math.max(this.highWaterBytes, this.#bytes);
    });
    this.#tail = action.catch(() => {}); return action.finally(() => { this.#pending--; });
  }
  iterator(): AsyncIterable<PiEvent> {
    if (this.#consumer) refuse('SESSION_BUSY', '', { phase: 'session' }); this.#consumer = true;
    const next = async (): Promise<IteratorResult<PiEvent>> => {
      const item = this.#queue.shift(); if (item) { this.#bytes -= item.bytes; for (const wake of this.#drain) wake(); this.#drain.clear(); return { done: false, value: item.event }; }
      if (this.#failure) throw this.#failure; if (this.#ended) return { done: true, value: undefined }; if (this.#reader) refuse('SESSION_BUSY', '', { phase: 'session' });
      return new Promise((resolve, reject) => { this.#reader = { resolve, reject }; });
    };
    const stop = async (): Promise<IteratorResult<PiEvent>> => { this.close(); this.#queue.length = 0; this.#bytes = 0; if (!this.#disconnected) { this.#disconnected = true; await this.disconnected(); } return { done: true, value: undefined }; };
    return { [Symbol.asyncIterator]: () => ({ next, return: stop, throw: async () => stop() }) };
  }
  close(): void { this.#ended = true; this.#reader?.resolve({ done: true, value: undefined }); this.#reader = null; for (const wake of this.#drain) wake(); this.#drain.clear(); }
}
