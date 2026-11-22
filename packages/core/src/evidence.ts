import {
  artifactRefSchema, arrayOf, checkStatus, digestSchema, document, driverVersionSchema, enumeration,
  evidenceLevel, findingsSchema, hardwareIsolationMode, identifier, integer, metricsSchema, nullable,
  optional, printableAscii, printableText, record, text, type Digest, type Infer, type Schema,
} from './contracts.js';
import { fail } from './diagnostics.js';
import { unique } from './graph.js';
import { subjectSchema } from './identity.js';
import { LIMITS, VERIFIER_ARTIFACT_LIMITS } from './limits.js';
import { isVerifierNamespacePath, parseVerifierArtifactPath } from './scope.js';
import type { Json } from './boundary.js';

export interface HardwareProvenance {
  readonly targetCellId: string;
  readonly probeKind: 'physical' | 'synthetic_fixture';
  readonly vendor: string;
  readonly deviceModel: string;
  readonly accelerator: string;
  readonly isolationMode: 'whole_device' | 'sliced';
  readonly deviceCount: number;
  readonly driverVersion: string;
  readonly runtimeVersion: string;
  readonly topology?: string;
  readonly workloadDigest: Digest;
  readonly clockLockMode: 'locked' | 'unlocked' | 'unknown';
}

const hardwareProvenanceSchema: Schema<HardwareProvenance> = record({
  targetCellId: identifier,
  probeKind: enumeration('physical', 'synthetic_fixture'),
  vendor: printableText(1, 128),
  deviceModel: printableText(1, 128),
  accelerator: printableAscii(1, 64),
  isolationMode: hardwareIsolationMode,
  deviceCount: integer(1, 64),
  driverVersion: driverVersionSchema,
  runtimeVersion: printableText(1, 128),
  topology: optional(printableText(1, 128)),
  workloadDigest: digestSchema,
  clockLockMode: enumeration('locked', 'unlocked', 'unknown'),
});

const evidenceShape = document('Evidence', record({
  checkId: identifier, observedStatus: checkStatus,
  producerId: identifier, method: identifier, level: evidenceLevel, subject: subjectSchema,
  artifacts: arrayOf(artifactRefSchema, 0, LIMITS.manifest), reason: nullable(text()),
  detail: optional(nullable(text())),
  metrics: optional(metricsSchema),
  findings: optional(findingsSchema),
  hardwareProvenance: optional(hardwareProvenanceSchema),
}));
export type Evidence = Infer<typeof evidenceShape>;
export function evidenceSchema(value: Json, path = ''): Evidence {
  const evidence = evidenceShape(value, path), observation = evidence.spec;
  if (observation.observedStatus === 'passed') {
    if (observation.reason !== null) fail('VALUE_RANGE', `${path}/spec/reason`);
    if (!observation.artifacts.length) fail('VALUE_RANGE', `${path}/spec/artifacts`);
    if (observation.level === 'hardware_execution' && observation.hardwareProvenance === undefined) {
      fail('FIELD_REQUIRED', `${path}/spec/hardwareProvenance`);
    }
  } else if (observation.reason === null) fail('VALUE_RANGE', `${path}/spec/reason`);
  let verifierCount = 0;
  let verifierSlotId: string | null = null;
  observation.artifacts.forEach((ref, index) => {
    if (!isVerifierNamespacePath(ref.name)) return;
    const parsed = parseVerifierArtifactPath(ref.name);
    if (parsed === null) fail('PATH_INVALID', `${path}/spec/artifacts/${index}/name`);
    if (parsed.slotId !== `check.${observation.checkId}` && parsed.slotId !== observation.checkId) {
      fail('PATH_INVALID', `${path}/spec/artifacts/${index}/name`);
    }
    if (verifierSlotId !== null && verifierSlotId !== parsed.slotId) {
      fail('PATH_INVALID', `${path}/spec/artifacts/${index}/name`);
    }
    verifierSlotId = parsed.slotId;
    verifierCount++;
    if (verifierCount > VERIFIER_ARTIFACT_LIMITS.maxFilesPerSlot) {
      fail('LIMIT_COLLECTION', `${path}/spec/artifacts`);
    }
    if (ref.uri !== undefined && ref.uri !== null) {
      const expectedCasUri = `cas://sha256/${ref.digest.hex}`;
      if (ref.uri !== expectedCasUri) {
        fail(
          ref.uri.startsWith('cas://sha256/') ? 'ARTIFACT_DIGEST_MISMATCH' : 'VALUE_RANGE',
          `${path}/spec/artifacts/${index}/uri`,
        );
      }
    }
  });
  unique(observation.artifacts.map(ref => ref.name), `${path}/spec/artifacts`);
  return evidence;
}
const claimShape = record({
  checkId: identifier, status: checkStatus, evidenceId: nullable(identifier), reason: nullable(text()),
  detail: optional(nullable(text())),
  metrics: optional(metricsSchema),
  findings: optional(findingsSchema),
});
export type SubmittedCheck = Infer<typeof claimShape>;
export function claimSchema(value: Json, path: string): SubmittedCheck {
  const claim = claimShape(value, path);
  if ((claim.status === 'passed') !== (claim.reason === null)) fail('VALUE_RANGE', `${path}/reason`);
  if (claim.status === 'not_run' && claim.evidenceId !== null) fail('VALUE_ENUM', `${path}/evidenceId`);
  return claim;
}
