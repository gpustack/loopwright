import type { Authority, DispatchPermit, RequestAdmission, StateResult } from '@loopwright/state';
import type { PiHost, PiError } from './types.js';
import { canonical, digest, freeze, snapshot } from './boundary.js';
import { refuse } from './errors.js';
export interface DispatchPayload { readonly destination: string; readonly headers: Readonly<Record<string, string>>; readonly body: Uint8Array; readonly signal: AbortSignal }
export interface DispatchTicket { readonly requestId: string }
export interface DispatchPorts { readonly destination: string; readonly fetch: typeof globalThis.fetch }
export function stateValue<T>(value: StateResult<T>, phase: PiError['phase'] = 'admission'): T {
  if (value.ok) return value.value; const error = value.error;
  const code = error.commit === 'unknown' ? 'RECOVERY_REQUIRED' : error.code === 'STALE_OWNER' || error.code.startsWith('OWNER_') ? 'AUTHORITY_REFUSED'
    : error.code === 'DEADLINE_EXCEEDED' ? 'DEADLINE' : ['BUDGET_EXHAUSTED', 'CAPABILITY_UNSUPPORTED', 'LIMIT_EXCEEDED'].includes(error.code) ? 'REQUEST_REFUSED' : 'STATE_REFUSED';
  refuse(code, error.path, { phase, retryable: error.retryable, effect: error.commit === 'unknown' ? 'possible' : 'none', stateErrorCode: error.code });
}
interface Issued {
  readonly permit: DispatchPermit; readonly admission: RequestAdmission; readonly payload: DispatchPayload; readonly bodyDigest: string;
}
/** Original live tickets never leave this owner and cannot be recreated from persistent dispatch markers. */
export class Admission {
  #tickets = new WeakMap<DispatchTicket, Issued>(); #used = new WeakSet<DispatchTicket>();
  readonly #authority: Authority; readonly #destination: string; readonly #fetch: typeof globalThis.fetch;
  constructor(readonly host: PiHost, ports: DispatchPorts) {
    this.#authority = freeze(snapshot(host.authority)) as unknown as Authority; this.#destination = ports.destination; this.#fetch = ports.fetch;
  }
  issue(input: RequestAdmission, payload: DispatchPayload): DispatchTicket {
    if (payload.signal.aborted) refuse('CANCELLED', '', { phase: 'admission' });
    if (payload.destination !== this.#destination || !(payload.body instanceof Uint8Array) || payload.body.buffer instanceof SharedArrayBuffer || payload.body.byteLength > 65536) refuse('PAYLOAD_MISMATCH', '', { phase: 'admission' });
    const body = Buffer.from(payload.body), headers = Object.freeze({ ...payload.headers });
    stateValue(this.host.store.reserveRequest(this.#authority, input));
    const authorized = stateValue(this.host.store.authorizeRequestDispatch(this.#authority, input.requestId));
    if (authorized.kind !== 'new_dispatch') refuse('REQUEST_REFUSED', '', { phase: 'dispatch', requestId: input.requestId, operationId: input.operationId });
    const ticket = Object.freeze({ requestId: input.requestId });
    this.#tickets.set(ticket, { permit: authorized.permit, admission: authorized.record.admission, payload: { destination: this.#destination, headers, body, signal: payload.signal }, bodyDigest: digest(body).hex });
    return ticket;
  }
  #assertCurrent(value: Issued): void {
    const renewed = stateValue(this.host.store.renew(this.#authority), 'dispatch');
    if (canonical(renewed.authority) !== canonical(this.#authority)) refuse('AUTHORITY_REFUSED', '', { phase: 'dispatch' });
    const current = stateValue(this.host.store.getRequest(value.admission.requestId), 'dispatch');
    if (current.state !== 'dispatch_authorized' || current.dispatch?.dispatchId !== value.permit.dispatchId || current.dispatch.generation !== value.permit.generation || canonical(current.admission) !== canonical(value.admission) || digest(value.payload.body).hex !== value.bodyDigest) refuse('PAYLOAD_MISMATCH', '', { phase: 'dispatch' });
    const view = stateValue(this.host.store.inspect(), 'dispatch'), permit = value.permit;
    if (view.clockStatus !== 'trusted' || view.owner.mode !== 'active' || view.owner.ownerId !== this.#authority.ownerId || view.owner.generation !== this.#authority.generation || permit.generation !== this.#authority.generation
      || view.clock.basis.clockEpoch !== permit.clockEpoch || view.storeId !== permit.storeId || view.runId !== permit.runId || canonical(view.lockHash) !== canonical(permit.lockHash)
      || BigInt(view.clock.sampledNow.monotonicMs) >= BigInt(permit.notAfterMonotonicMs) || BigInt(view.clock.sampledNow.monotonicMs) >= BigInt(view.clock.basis.taskDeadlineMonotonicMs)) refuse('AUTHORITY_REFUSED', '', { phase: 'dispatch' });
  }
  async dispatch(ticket: DispatchTicket): Promise<Response> {
    const value = this.#tickets.get(ticket);
    if (!value || this.#used.has(ticket)) refuse('REQUEST_REFUSED', '', { phase: 'dispatch' });
    if (value.payload.signal.aborted) refuse('CANCELLED', '', { phase: 'dispatch' });
    this.#assertCurrent(value);
    this.#used.add(ticket);
    // No await or asynchronous queue between the final qualified clock/owner check and invoking the sole HTTP transport.
    return this.#fetch(value.payload.destination, { method: 'POST', headers: value.payload.headers, body: Buffer.from(value.payload.body), signal: value.payload.signal, redirect: 'error' });
  }
}
