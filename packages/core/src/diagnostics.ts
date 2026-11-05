export const DIAGNOSTIC_CODES = Object.freeze([
  'INPUT_TYPE', 'INPUT_UNSUPPORTED', 'INPUT_CYCLE', 'INPUT_ALIAS',
  'LIMIT_BYTES', 'LIMIT_DEPTH', 'LIMIT_STRING', 'LIMIT_COLLECTION', 'LIMIT_NODES',
  'JSON_SYNTAX', 'JSON_DUPLICATE_MEMBER', 'VERSION_UNSUPPORTED', 'KIND_MISMATCH',
  'FIELD_REQUIRED', 'FIELD_UNKNOWN', 'VALUE_TYPE', 'VALUE_ENUM', 'VALUE_RANGE',
  'IDENTIFIER_INVALID', 'PATH_INVALID', 'PATTERN_UNSUPPORTED', 'DUPLICATE_ID',
  'DUPLICATE_EDGE', 'REFERENCE_UNKNOWN', 'GRAPH_CYCLE', 'LIMIT_GRAPH_NODES',
  'LIMIT_GRAPH_EDGES', 'BUDGET_INCONSISTENT', 'HASH_MISMATCH', 'MANIFEST_AMBIGUOUS',
  'IDENTITY_MISMATCH', 'EVIDENCE_DUPLICATE', 'EVIDENCE_CONTRADICTORY',
  'ARTIFACT_DUPLICATE', 'LIMIT_ARTIFACT_BYTES', 'LIMIT_RESOLVED_BYTES',
  'USAGE_OVERFLOW', 'RUN_ACCEPTANCE_REQUIRED', 'RUN_NO_CHANGE_REQUIRED',
  'RUN_RECONCILIATION_REQUIRED', 'CHECK_MISSING', 'EVIDENCE_MISSING',
  'EVIDENCE_LEVEL_DISALLOWED', 'ARTIFACT_MISSING', 'ARTIFACT_LENGTH_MISMATCH',
  'ARTIFACT_DIGEST_MISMATCH',
] as const);

export type DiagnosticCode = typeof DIAGNOSTIC_CODES[number];
export interface Diagnostic {
  readonly code: DiagnosticCode;
  readonly path: string;
  readonly checkId: string | null;
}
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly Diagnostic[] };

export class Invalid extends Error {
  constructor(readonly diagnostic: Diagnostic) { super(diagnostic.code); }
}
export function fail(code: DiagnosticCode, path = '', checkId: string | null = null): never {
  throw new Invalid(Object.freeze({ code, path, checkId }));
}
export function freeze<T>(value: T): T {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  while (pending.length) {
    const next = pending.pop();
    if (next === null || typeof next !== 'object' || seen.has(next)) continue;
    seen.add(next);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(next))) {
      if ('value' in descriptor) pending.push(descriptor.value);
    }
    Object.freeze(next);
  }
  return value;
}
export function attempt<T>(operation: () => T): Result<T> {
  try { return freeze({ ok: true as const, value: operation() }); }
  catch (error) {
    const diagnostic = error instanceof Invalid ? error.diagnostic
      : Object.freeze({ code: 'INPUT_UNSUPPORTED' as const, path: '', checkId: null });
    return freeze({ ok: false as const, errors: [diagnostic] });
  }
}
