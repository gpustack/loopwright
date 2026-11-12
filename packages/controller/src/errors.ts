export const CODES = ['CONFIG_SYNTAX', 'CONFIG_DUPLICATE_KEY', 'CONFIG_LIMIT', 'CONFIG_SCHEMA', 'CONFIG_REFERENCE', 'CONFIG_ENV_MISSING',
  'CONFIG_ENV_SYNTAX', 'CONFIG_ENV_DENIED', 'CONFIG_CREDENTIAL_INVALID', 'REGISTRY_UNTRUSTED', 'TARGET_MISMATCH', 'CAPABILITY_UNSUPPORTED',
  'MCP_AUTHENTICATION_REQUIRED', 'SUBMISSION_INVALID', 'SUBMISSION_AMBIGUOUS', 'VERIFICATION_FAILED', 'EVIDENCE_UNAVAILABLE', 'GATE_TIMEOUT', 'RECEIPT_CONFLICT', 'REPEAT_FAILURE',
  'ATTEMPT_LIMIT', 'BUDGET_EXHAUSTED', 'DEADLINE', 'CANCELLED', 'OWNER_BUSY', 'AUTHORITY_REFUSED', 'RECOVERY_REQUIRED', 'ARTIFACT_INVALID',
  'OUTPUT_LIMIT', 'CLEANUP_FAILED', 'STATE_UNAVAILABLE'] as const;
export interface ControllerDiagnostic {
  readonly version: 1; readonly code: typeof CODES[number]; readonly phase: 'configuration' | 'compile' | 'admission' | 'execution' | 'verification' | 'recovery' | 'finalization' | 'inspection';
  readonly path: string; readonly stateCode: string | null; readonly piCode: string | null;
  readonly effect: 'none' | 'possible' | 'confirmed'; readonly retryable: boolean;
}
export type ControllerResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ControllerDiagnostic };
export class ControllerFailure extends Error {
  constructor(readonly diagnostic: ControllerDiagnostic) { super(diagnostic.code); }
}
const fields = new Set(('apiVersion kind metadata id name spec registry config task goal taskpack target repository baseRevision sourceRevision matrix platform variant scope writable protected roles adapter provider model thinking tools trustedContext revision discovery resources path digest algorithm hex budgets wallTimeMs totalTokens perCallOutputTokens maxModelCalls maxConcurrency maxFormatRepairs maxImplementationRepairs maxTransportRetries enforcement wallTime tokens modelCalls concurrency formatRepairs implementationRepairs transportRetries steps uses roleId dependsOn acceptance required checks allowedEvidenceLevels profiles profileRef handlerRef credentials ref template controls drainReserveMs maxAttempts repeatFailureLimit submission mode handlers roleProfiles runtimeProfiles credentialBindings environmentBindings version resourceVersion selection runtimeRef providerCredentialRef mcp names effects idleTimeoutSeconds absoluteTimeoutSeconds transport destinationRef endpoint approvedAddresses credentialRef scriptDigest context estimator proofId evidence workingWindowCeiling maxRequestBytes serviceMargin toolReserve maxOutputTokens identity sdkIntegrity graphDigest imageDigest configDigest profile dockerExecutable dockerSocket consumer environmentNames classification paths parameters capabilities checkId prompt purpose implementation publication gate gateEndpoints publicationEndpoints endpointRef targetBranch headBranchPrefix titleTemplate signingCredentialRef authCredentialRef timeoutMs maxPollMs pollInitialMs pollMaxMs jitter receipt').split(' '));
function safePath(path: string): string {
  const output: string[] = [];
  for (const segment of path.split('/').slice(1)) { if (!fields.has(segment) && !/^(?:0|[1-9][0-9]{0,2})$/.test(segment)) break; output.push(segment); }
  return output.length ? '/' + output.join('/') : '';
}
export function refuse(code: ControllerDiagnostic['code'], path = '', phase: ControllerDiagnostic['phase'] = 'configuration', extra: Partial<Pick<ControllerDiagnostic, 'stateCode' | 'piCode' | 'effect' | 'retryable'>> = {}): never {
  throw new ControllerFailure(Object.freeze({ version: 1, code, phase, path: safePath(path), stateCode: null, piCode: null, effect: 'none', retryable: false, ...extra }));
}
export async function result<T>(work: () => Promise<T> | T, phase: ControllerDiagnostic['phase'] = 'configuration'): Promise<ControllerResult<T>> {
  try { return { ok: true, value: await work() }; }
  catch (error) {
    return { ok: false, error: error instanceof ControllerFailure ? error.diagnostic : Object.freeze({ version: 1, code: phase === 'configuration' ? 'CONFIG_SCHEMA' : 'STATE_UNAVAILABLE', phase,
      path: '', stateCode: null, piCode: null, effect: 'none', retryable: false }) };
  }
}
