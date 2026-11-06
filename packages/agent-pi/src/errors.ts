import type { PiError, PiErrorCode, PiResult } from './types.js';
export class PiFailure extends Error {
  constructor(readonly detail: PiError) { super(detail.code); }
}
export function refuse(code: PiErrorCode, path = '', patch: Partial<Omit<PiError, 'code' | 'path'>> = {}): never {
  throw new PiFailure(Object.freeze({ code, path, phase: 'preflight', retryable: false, effect: 'none', requestId: null,
    operationId: null, stateErrorCode: null, ...patch }));
}
export async function result<T>(operation: () => T | Promise<T>): Promise<PiResult<T>> {
  try { return { ok: true, value: await operation() }; }
  catch (error) { return { ok: false, error: error instanceof PiFailure ? error.detail : Object.freeze({ code: 'INPUT_INVALID', path: '', phase: 'preflight', retryable: false, effect: 'none', requestId: null, operationId: null, stateErrorCode: null }) }; }
}
