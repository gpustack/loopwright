import { snapshot, type Json } from './boundary.js';
import {
  artifactRefSchema, arrayOf, checkStatus, digestSchema, document, driverVersionSchema, enumeration,
  evidenceLevel, findingsSchema, FORBIDDEN_PROTOTYPE_KEYS, hardwareIsolationMode, identifier, integer,
  isValidMetricKey, metricsSchema, nullable, object, optional, printableAscii, printableText, record,
  text, validateBucketId, type Digest, type Infer, type MetricsMap, type MetricValue, type Schema,
} from './contracts.js';
import { attempt, fail, type Result } from './diagnostics.js';
import { unique } from './graph.js';
import { subjectSchema } from './identity.js';
import { LIMITS, VERIFIER_ARTIFACT_LIMITS } from './limits.js';
import { isVerifierNamespacePath, parseVerifierArtifactPath } from './scope.js';
import { SecretScrubber } from './scrubber.js';

const DEFAULT_SECRET_SCRUBBER = new SecretScrubber();
const BUCKET_DIMENSION_STRING_RE = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/;
const STALL_REASON_RE = /^[A-Za-z][A-Za-z0-9._:-]*$/;

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

export type BucketDimensionValue = number | string;
export type BucketDimensionsMap = Readonly<Record<string, BucketDimensionValue>>;
export interface BucketMetricEntry {
  readonly bucketId: string;
  readonly dimensions?: BucketDimensionsMap;
  readonly metrics: MetricsMap;
}

function makeBucketDimensionsSchema(scrubber: SecretScrubber): Schema<BucketDimensionsMap> {
  return (value, path) => {
    const input = object(value, path);
    const keys = Object.keys(input).sort();
    if (keys.length > LIMITS.bucketDimensionEntries) fail('VALUE_RANGE', path);
    const output: Record<string, BucketDimensionValue> = Object.create(null) as Record<string, BucketDimensionValue>;
    for (const key of keys) {
      if (!Object.hasOwn(input, key)) continue;
      if (!isValidMetricKey(key)) fail('IDENTIFIER_INVALID', path);
      const entryPath = `${path}/${key}`;
      if (scrubber.containsSecret(key)) fail('VALUE_RANGE', entryPath);
      const raw = input[key];
      if (typeof raw === 'number') {
        if (!Number.isFinite(raw) || Object.is(raw, -0)) fail('VALUE_RANGE', entryPath);
        output[key] = raw;
      } else if (typeof raw === 'string') {
        if (
          raw.length < 1
          || raw.length > LIMITS.bucketDimensionStringValue
          || !BUCKET_DIMENSION_STRING_RE.test(raw)
          || scrubber.containsSecret(raw)
        ) {
          fail('VALUE_RANGE', entryPath);
        }
        output[key] = raw;
      } else {
        fail('VALUE_TYPE', entryPath);
      }
    }
    return output;
  };
}

function makeBucketNumericMetricsSchema(scrubber: SecretScrubber): Schema<MetricsMap> {
  return (value, path) => {
    const input = object(value, path);
    const keys = Object.keys(input).sort();
    if (keys.length > LIMITS.bucketMetricEntries) fail('VALUE_RANGE', path);
    const output: Record<string, MetricValue> = Object.create(null) as Record<string, MetricValue>;
    for (const key of keys) {
      if (!Object.hasOwn(input, key)) continue;
      if (!isValidMetricKey(key)) fail('IDENTIFIER_INVALID', path);
      const entryPath = `${path}/${key}`;
      if (scrubber.containsSecret(key)) fail('VALUE_RANGE', entryPath);
      const raw = input[key];
      if (typeof raw !== 'number') fail('VALUE_TYPE', entryPath);
      if (!Number.isFinite(raw) || Object.is(raw, -0)) fail('VALUE_RANGE', entryPath);
      output[key] = raw;
    }
    return output;
  };
}

function makeBucketMetricsSchema(scrubber: SecretScrubber): Schema<readonly BucketMetricEntry[]> {
  const entrySchema: Schema<BucketMetricEntry> = record({
    bucketId: (value: Json, path: string) => validateBucketId(value, path, scrubber),
    dimensions: optional(makeBucketDimensionsSchema(scrubber)),
    metrics: makeBucketNumericMetricsSchema(scrubber),
  });
  const listSchema = arrayOf(entrySchema, 1, LIMITS.bucketMetrics);
  return (value, path) => {
    const entries = listSchema(value, path);
    unique(entries.map(entry => entry.bucketId), path);
    return entries;
  };
}

export const bucketMetricsSchema: Schema<readonly BucketMetricEntry[]> = makeBucketMetricsSchema(DEFAULT_SECRET_SCRUBBER);

export function validateBucketMetrics(
  input: unknown,
  scrubber: SecretScrubber = DEFAULT_SECRET_SCRUBBER,
): Result<readonly BucketMetricEntry[]> {
  return attempt(() => makeBucketMetricsSchema(scrubber)(snapshot(input), ''));
}

export const HARDWARE_BOUND_PIPELINES = Object.freeze([
  'hbm',
  'l2',
  'smem_lds_ub',
  'tensor_cube',
  'vector_valu',
  'host_launch',
  'comm',
  'unknown',
] as const);
export type HardwareBoundPipeline = typeof HARDWARE_BOUND_PIPELINES[number];

export interface HardwareStallReason {
  readonly reason: string;
  readonly pct: number;
}

export interface HardwareDiagnostics {
  readonly boundPipeline: HardwareBoundPipeline;
  readonly rooflineHeadroom?: number;
  readonly achievedSolPct?: number;
  readonly arithmeticIntensity?: number;
  readonly occupancyPct?: number;
  readonly registerCount?: number;
  readonly sharedMemBytes?: number;
  readonly localSpillBytes?: number;
  readonly l2HitPct?: number;
  readonly bankConflictPct?: number;
  readonly topStallReasons?: readonly HardwareStallReason[];
}

const nonNegativeFiniteNumber: Schema<number> = (value, path) => {
  if (typeof value !== 'number') fail('VALUE_TYPE', path);
  if (!Number.isFinite(value) || Object.is(value, -0) || value < 0) fail('VALUE_RANGE', path);
  return value;
};

const percentageNumber: Schema<number> = (value, path) => {
  if (typeof value !== 'number') fail('VALUE_TYPE', path);
  if (!Number.isFinite(value) || Object.is(value, -0) || value < 0 || value > 100) fail('VALUE_RANGE', path);
  return value;
};

function makeHardwareDiagnosticsSchema(scrubber: SecretScrubber): Schema<HardwareDiagnostics> {
  const stallReasonTextSchema: Schema<string> = (value, path) => {
    const parsed = text(1, LIMITS.hardwareStallReason)(value, path);
    if (FORBIDDEN_PROTOTYPE_KEYS.has(parsed) || !STALL_REASON_RE.test(parsed)) fail('IDENTIFIER_INVALID', path);
    if (scrubber.containsSecret(parsed)) fail('VALUE_RANGE', path);
    return parsed;
  };
  const stallReasonEntrySchema: Schema<HardwareStallReason> = record({
    reason: stallReasonTextSchema,
    pct: percentageNumber,
  });
  const stallReasonsListSchema = arrayOf(stallReasonEntrySchema, 0, LIMITS.hardwareStallReasons);
  const uniqueStallReasonsSchema: Schema<readonly HardwareStallReason[]> = (value, path) => {
    const items = stallReasonsListSchema(value, path);
    unique(items.map(item => item.reason), path);
    return items;
  };

  return record({
    boundPipeline: enumeration(...HARDWARE_BOUND_PIPELINES),
    rooflineHeadroom: optional(nonNegativeFiniteNumber),
    achievedSolPct: optional(percentageNumber),
    arithmeticIntensity: optional(nonNegativeFiniteNumber),
    occupancyPct: optional(percentageNumber),
    registerCount: optional(integer(0)),
    sharedMemBytes: optional(integer(0)),
    localSpillBytes: optional(integer(0)),
    l2HitPct: optional(percentageNumber),
    bankConflictPct: optional(percentageNumber),
    topStallReasons: optional(uniqueStallReasonsSchema),
  });
}

export const hardwareDiagnosticsSchema: Schema<HardwareDiagnostics> = makeHardwareDiagnosticsSchema(DEFAULT_SECRET_SCRUBBER);

export function validateHardwareDiagnostics(
  input: unknown,
  scrubber: SecretScrubber = DEFAULT_SECRET_SCRUBBER,
): Result<HardwareDiagnostics> {
  return attempt(() => makeHardwareDiagnosticsSchema(scrubber)(snapshot(input), ''));
}

const evidenceShape = document('Evidence', record({
  checkId: identifier, observedStatus: checkStatus,
  producerId: identifier, method: identifier, level: evidenceLevel, subject: subjectSchema,
  artifacts: arrayOf(artifactRefSchema, 0, LIMITS.manifest), reason: nullable(text()),
  detail: optional(nullable(text())),
  metrics: optional(metricsSchema),
  findings: optional(findingsSchema),
  hardwareProvenance: optional(hardwareProvenanceSchema),
  bucketMetrics: optional(bucketMetricsSchema),
  hardwareDiagnostics: optional(hardwareDiagnosticsSchema),
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
