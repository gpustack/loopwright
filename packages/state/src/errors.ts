import type { Diagnostic } from '@loopwright/core';
import type { StateError, StateResult } from './types.js';
export const STATE_ERROR_CODES = Object.freeze([
  'INVALID_INPUT', 'LIMIT_EXCEEDED', 'RUNTIME_UNSUPPORTED', 'STORE_MISSING', 'STORE_INCOMPLETE',
  'STORE_CORRUPT', 'FORMAT_UNSUPPORTED', 'BINDING_MISMATCH', 'IDENTITY_CONFLICT', 'RECORD_NOT_FOUND',
  'STORE_BUSY', 'STORE_UNAVAILABLE', 'STORE_FULL', 'COMMIT_UNKNOWN', 'STORE_CLOSED', 'REVISION_CONFLICT',
  'OWNER_HELD', 'OWNER_EXPIRED', 'STALE_OWNER', 'CLOCK_UNTRUSTED', 'DEADLINE_EXCEEDED', 'BUDGET_EXHAUSTED',
  'CAPABILITY_UNSUPPORTED', 'TRANSITION_INVALID', 'RECEIPT_CONFLICT', 'EVIDENCE_INSUFFICIENT',
  'CHECKPOINT_STALE', 'ARTIFACT_REQUIRED', 'ARITHMETIC_OVERFLOW', 'RUN_BLOCKED',
] as const);
export type StateErrorCode = typeof STATE_ERROR_CODES[number];
export class StateFailure extends Error {
  constructor(readonly code: StateErrorCode, readonly path = '', readonly diagnostics: readonly Diagnostic[] = []) { super(code); }
}
export function fail(code: StateErrorCode, path = '', diagnostics: readonly Diagnostic[] = []): never { throw new StateFailure(code, path, diagnostics); }
export function errorValue(error: unknown): StateError {
  const failure = error instanceof StateFailure ? error : new StateFailure('STORE_UNAVAILABLE');
  return Object.freeze({ code: failure.code, path: failure.path,
    retryable: failure.code === 'STORE_BUSY' || failure.code === 'REVISION_CONFLICT',
    commit: failure.code === 'COMMIT_UNKNOWN' ? 'unknown' : 'not_committed', diagnostics: Object.freeze(failure.diagnostics.map(diagnostic=>Object.freeze({...diagnostic}))) });
}
export function attempt<T>(run: () => T): StateResult<T> {
  try { return Object.freeze({ok: true, value: run()}); }
  catch (error) { return Object.freeze({ok: false, error: errorValue(error)}); }
}
