export { API_VERSION } from './boundary.js';
export { LIMITS, OVERLAY_LIMITS, type OverlayLimits, type OverlayLimitsInput, type OverlayLimitOptions } from './limits.js';
export { DIAGNOSTIC_CODES, type DiagnosticCode, type Diagnostic, type Result } from './diagnostics.js';
export { matchesScopePattern, validateScopePattern, validateRelativePath } from './scope.js';
export {
  isWritablePath, resolveOverlayLimits,
  type TaskContract, type ReworkPolicy, type Digest, type ArtifactRef, type EvidenceLevel, type CheckStatus,
  type MetricValue, type MetricsMap, type FindingSeverity, type StructuredFinding,
} from './contracts.js';
export { admitTask, identifyManifest, bindSubject, type TaskLock, type Subject } from './identity.js';
export {
  digestArtifact, digestArtifactFromMetadata, resolveInventory,
  type ArtifactManifest, type ArtifactMetadataInput, type ArtifactRefOptions, type ArtifactBytes,
  type BaseTreeAnchor, type ResolvedArtifact, type ResolvedArtifactInput, type VerifiedArtifactDescriptor,
} from './artifacts.js';
export { evaluateAcceptance, type VerificationResult, type EvaluatedCheck } from './acceptance.js';
export type { Evidence, SubmittedCheck } from './evidence.js';
export { aggregateUsage, type RequestUsage, type Quantity, type Aggregate, type UsageSummary } from './usage.js';
export { SecretScrubber } from './scrubber.js';
export { constructRunResult, type RunResult, type RunStatus, type MemoryObservation, type NoChangeVerification } from './results.js';
import { contractSchema, resolveOverlayOptions, type TaskContract } from './contracts.js';
import { lockSchema, type TaskLock } from './identity.js';
import { manifestSchema, type ArtifactManifest } from './artifacts.js';
import { overlaySnapshotBounds, snapshot } from './boundary.js';
import { attempt, fail, type Result } from './diagnostics.js';
import { evidenceSchema, type Evidence } from './evidence.js';
import { verificationSchema, type VerificationResult } from './acceptance.js';
import { runSchema, type RunResult } from './results.js';
import type { OverlayLimitOptions } from './limits.js';
export interface DocumentByKind { TaskContract: TaskContract; TaskLock: TaskLock; ArtifactManifest: ArtifactManifest; Evidence: Evidence; VerificationResult: VerificationResult; RunResult: RunResult }
export type DocumentKind = keyof DocumentByKind;
export function validateDocument<K extends DocumentKind>(
  input: unknown,
  kind: K,
  options?: OverlayLimitOptions,
): Result<DocumentByKind[K]> {
  return attempt(() => {
    const overlay = resolveOverlayOptions(options);
    const bounds = kind === 'ArtifactManifest' ? overlaySnapshotBounds(overlay?.maxFiles) : undefined;
    const value = snapshot(input, bounds);
    if (kind === 'TaskContract') return contractSchema(value);
    if (kind === 'TaskLock') return lockSchema(value);
    if (kind === 'ArtifactManifest') return manifestSchema(value, '', overlay?.maxFiles);
    if (kind === 'Evidence') return evidenceSchema(value);
    if (kind === 'VerificationResult') return verificationSchema(value);
    if (kind === 'RunResult') return runSchema(value);
    fail('KIND_MISMATCH', '/kind');
  }) as Result<DocumentByKind[K]>;
}
