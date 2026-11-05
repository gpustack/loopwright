export { API_VERSION } from './boundary.js';
export { LIMITS } from './limits.js';
export { DIAGNOSTIC_CODES, type DiagnosticCode, type Diagnostic, type Result } from './diagnostics.js';
export { isWritablePath, type TaskContract, type Digest, type ArtifactRef, type EvidenceLevel, type CheckStatus } from './contracts.js';
export { admitTask, identifyManifest, bindSubject, type TaskLock, type Subject } from './identity.js';
export { digestArtifact, type ArtifactManifest, type ResolvedArtifact } from './artifacts.js';
export { evaluateAcceptance, type VerificationResult, type EvaluatedCheck } from './acceptance.js';
export type { Evidence, SubmittedCheck } from './evidence.js';
export { aggregateUsage, type RequestUsage, type Quantity, type Aggregate, type UsageSummary } from './usage.js';
export { constructRunResult, type RunResult, type RunStatus, type MemoryObservation, type NoChangeVerification } from './results.js';
import { contractSchema, type TaskContract } from './contracts.js';
import { lockSchema, type TaskLock } from './identity.js';
import { manifestSchema, type ArtifactManifest } from './artifacts.js';
import { snapshot } from './boundary.js';
import { attempt, fail, type Result } from './diagnostics.js';
import { evidenceSchema, type Evidence } from './evidence.js';
import { verificationSchema, type VerificationResult } from './acceptance.js';
import { runSchema, type RunResult } from './results.js';
export interface DocumentByKind { TaskContract: TaskContract; TaskLock: TaskLock; ArtifactManifest: ArtifactManifest; Evidence: Evidence; VerificationResult: VerificationResult; RunResult: RunResult }
export type DocumentKind = keyof DocumentByKind;
export function validateDocument<K extends DocumentKind>(input: unknown, kind: K): Result<DocumentByKind[K]> {
  return attempt(() => {
    const value = snapshot(input);
    if (kind === 'TaskContract') return contractSchema(value);
    if (kind === 'TaskLock') return lockSchema(value);
    if (kind === 'ArtifactManifest') return manifestSchema(value);
    if (kind === 'Evidence') return evidenceSchema(value);
    if (kind === 'VerificationResult') return verificationSchema(value);
    if (kind === 'RunResult') return runSchema(value);
    fail('KIND_MISMATCH', '/kind');
  }) as Result<DocumentByKind[K]>;
}
