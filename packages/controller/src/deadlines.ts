import type { Authority, LocalRunStore, RunView } from '@loopwright/state';
import { stateValue } from './storage.js';
import { refuse } from './errors.js';
import { same } from './schema.js';
export type StopCode = 'DEADLINE' | 'CANCELLED' | 'AUTHORITY_REFUSED' | 'OUTPUT_LIMIT';
/** This timer revokes work; only the original S02 clock and permits authorize effects. */
export class WorkDeadline {
  readonly abort = new AbortController(); readonly deadline: bigint; readonly cutoff: bigint;
  reason: StopCode | null = null;
  #timer: NodeJS.Timeout; #renew: NodeJS.Timeout; #external: () => void; #stop: ((reason: StopCode) => Promise<void>) | null = null;
  #stopping: Promise<void> = Promise.resolve(); #failure = false; readonly #basis: RunView['clock']['basis'];
  constructor(readonly store: LocalRunStore, readonly authority: Authority, reserveMs: number, readonly external: AbortSignal) {
    const view = stateValue(store.inspect()); this.#basis = view.clock.basis; this.deadline = BigInt(view.clock.basis.taskDeadlineMonotonicMs); this.cutoff = this.deadline - BigInt(reserveMs);
    if (view.clockStatus !== 'trusted') refuse('RECOVERY_REQUIRED', '', 'admission');
    this.#timer = setTimeout(() => this.stop('DEADLINE'), Math.max(0, Number(this.cutoff - BigInt(view.clock.sampledNow.monotonicMs)))); this.#timer.unref();
    this.#renew = setInterval(() => { try { this.assert(true); } catch { this.stop('AUTHORITY_REFUSED'); } }, Math.max(250, Math.min(1000, Math.floor(view.policy.leaseMs / 3)))); this.#renew.unref();
    this.#external = () => this.stop('CANCELLED'); external.addEventListener('abort', this.#external, { once: true }); if (external.aborted) this.#external();
    if (this.cutoff <= BigInt(view.clock.sampledNow.monotonicMs)) this.stop('DEADLINE');
  }
  assert(allowDispatched = false): RunView {
    if (this.reason) refuse(this.reason, '', 'execution');
    stateValue(this.store.renew(this.authority)); const view = stateValue(this.store.inspect());
    if (!same(view.clock.basis, this.#basis) || view.clockStatus !== 'trusted' || view.owner.mode !== 'active' || view.owner.ownerId !== this.authority.ownerId || view.owner.generation !== this.authority.generation) { this.stop('AUTHORITY_REFUSED'); refuse('AUTHORITY_REFUSED', '', 'execution'); }
    if (BigInt(view.clock.sampledNow.monotonicMs) >= this.cutoff) { this.stop('DEADLINE'); refuse('DEADLINE', '', 'execution'); }
    if (!allowDispatched && (view.counts.dispatchedRequests || view.counts.unresolvedRequests || view.counts.unresolvedOperations || view.ledger.violations.length)) refuse('RECOVERY_REQUIRED', '', 'execution'); return view;
  }
  onStop(callback: ((reason: StopCode) => Promise<void>) | null): void { this.#stop = callback; if (this.reason && callback) this.#invoke(callback, this.reason); }
  #invoke(callback: (reason: StopCode) => Promise<void>, reason: StopCode): void { this.#stopping = this.#stopping.then(() => callback(reason)).catch(() => { this.#failure = true; }); }
  stop(reason: StopCode): void { if (this.reason) return; this.reason = reason; this.abort.abort(); clearInterval(this.#renew); if (this.#stop) this.#invoke(this.#stop, reason); }
  async dispose(): Promise<void> { clearTimeout(this.#timer); clearInterval(this.#renew); this.external.removeEventListener('abort', this.#external); this.#stop = null; await this.#stopping; if (this.#failure) refuse('CLEANUP_FAILED', '', 'finalization'); }
}
