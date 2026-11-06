import { refuse } from './errors.js';
/** Public commands serialize before any owner permission is issued; close revokes new work first. */
export class ExecutionGuard {
  readonly #abort = new AbortController(); #busy = false; #active: Promise<unknown> | null = null;
  get signal(): AbortSignal { return this.#abort.signal; }
  get busy(): boolean { return this.#busy; }
  run<T>(action: () => T | Promise<T>): Promise<T> {
    if (this.signal.aborted) refuse('CANCELLED', '', { phase: 'session' });
    if (this.#busy) refuse('SESSION_BUSY', '', { phase: 'session' }); this.#busy = true;
    const active = Promise.resolve().then(() => { if (this.signal.aborted) refuse('CANCELLED', '', { phase: 'session' }); return action(); }); this.#active = active;
    return active.finally(() => { if (this.#active === active) { this.#active = null; this.#busy = false; } });
  }
  revoke(): void { this.#abort.abort(); }
  async drain(): Promise<void> { await this.#active?.catch(() => {}); }
}
