import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants, linkSync, lstatSync, realpathSync, statSync, unlinkSync, type Stats } from 'node:fs';
import { chmod, lstat, mkdir, open, opendir, unlink } from 'node:fs/promises';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  isVerifierNamespacePath,
  LIMITS,
  SecretScrubber,
  validateBucketMetrics,
  validateHardwareDiagnostics,
  validateRelativePath,
  VERIFIER_ARTIFACT_LIMITS,
  type BaseTreeAnchor,
  type BucketMetricEntry,
  type Digest,
  type FindingSeverity,
  type HardwareDiagnostics,
  type HardwareProvenance,
  type HardwareTargetSpec,
  type MetricBucketScope,
  type MetricThresholdRule,
  type MetricsMap,
  type MetricValue,
  type StructuredFinding,
  type Subject,
} from '@loopwright/core';
import { readBoundedRegularFile, type Json } from '@loopwright/taskpack';
import {
  assertNoSymlinkAncestors,
  canonicalJson,
  expectNullProtoRecord,
  hasLoneSurrogate,
  normalizeRelayServerConfig,
  parseStrictJsonBytes,
  toNullPrototypeValue,
  validateWorkerCapabilitiesObject,
} from './config.js';
import {
  MAX_ACQUIRE_WAIT_MS,
  RelayPullQueue,
  timingSafeEqualStrings,
  verdictMatchesRequestBinding,
} from './queue.js';
import {
  HardwareRunnerError,
  type AcquireLeaseInput,
  type BenchmarkBaseTreeBundle,
  type BenchmarkCandidateArtifacts,
  type BenchmarkCandidateEntry,
  type BenchmarkOutputArtifact,
  type BenchmarkRequest,
  type BenchmarkVerdict,
  type CompleteLeaseInput,
  type HardwareRunnerErrorCode,
  type HeartbeatLeaseInput,
  type LeaseCredentials,
  type PreemptLeaseInput,
  type RelayServerHandle,
  type RelayServerOptions,
  type StageAStaticAuditSpec,
} from './types.js';

export const MAX_CONTROL_BODY_BYTES = 65_536;
export const MAX_RECEIPT_FILE_BYTES = MAX_CONTROL_BODY_BYTES + 256;
export const MAX_OPERATION_FILE_BYTES = MAX_CONTROL_BODY_BYTES + 512;
export const MAX_CAS_CHUNK_BYTES = 1_048_576;
export const EMPTY_SHA256_HEX = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const SHA1_HEX_RE = /^[0-9a-f]{40}$/;
const IDENTIFIER_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_FILENAME_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPOSITORY_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/;
const REVISION_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const METRIC_KEY_RE = /^[A-Za-z_][A-Za-z0-9._-]*$/;
const DOTTED_VERSION_RE = /^\d+(?:\.\d+)*$/;
const PRINTABLE_ASCII_RE = /^[\x20-\x7E]+$/;
const CONTROL_CHAR_RE = /[\r\n\t\p{C}]/u;
const FORBIDDEN_METRIC_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const DARWIN_ROOT_SYMLINKS = new Set(['/var', '/tmp', '/etc']);
const SECRET_SCAN_MIN_OVERLAP_BYTES = 16_384;
const SECRET_SCAN_MAX_OVERLAP_BYTES = 262_144;

function isAllowedOsRootSymlink(targetPath: string): boolean {
  return process.platform === 'darwin' && DARWIN_ROOT_SYMLINKS.has(targetPath);
}

function encodedSecretForms(secret: string): readonly string[] {
  return [
    secret,
    JSON.stringify(secret).slice(1, -1),
    encodeURIComponent(secret),
    Buffer.from(secret, 'utf8').toString('base64'),
  ];
}

export function computeSecretScanOverlapBytes(secrets: readonly string[]): number {
  let maxEncodedBytes = 0;
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length === 0) continue;
    for (const form of encodedSecretForms(secret)) {
      const len = Buffer.byteLength(form, 'utf8');
      if (len > maxEncodedBytes) {
        maxEncodedBytes = len;
      }
    }
  }
  return Math.min(
    SECRET_SCAN_MAX_OVERLAP_BYTES,
    Math.max(SECRET_SCAN_MIN_OVERLAP_BYTES, maxEncodedBytes + 4),
  );
}

export function signRelayPayload(secret: string, payload: Uint8Array | string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function verifyRelaySignature(
  secret: string,
  payload: Uint8Array | string,
  signatureHeader: string,
): boolean {
  const hex = signatureHeader.startsWith('sha256=') ? signatureHeader.slice(7) : signatureHeader;
  if (!SHA256_HEX_RE.test(hex)) return false;
  const expected = Buffer.from(hex, 'hex');
  const observed = createHmac('sha256', secret).update(payload).digest();
  return expected.byteLength === observed.byteLength && timingSafeEqual(expected, observed);
}

export function signBenchmarkVerdict(secret: string, verdict: BenchmarkVerdict): string {
  return signRelayPayload(secret, canonicalJson(verdict));
}

export function verifyBenchmarkVerdictSignature(
  secret: string,
  receiptOrVerdict: Readonly<Record<string, unknown>>,
  signatureHex: string,
): boolean {
  const stripped: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(receiptOrVerdict)) {
    if (key === 'signature' || !Object.hasOwn(receiptOrVerdict, key) || receiptOrVerdict[key] === undefined) continue;
    stripped[key] = receiptOrVerdict[key];
  }
  let serialized: string;
  try {
    serialized = canonicalJson(stripped);
  } catch {
    return false;
  }
  return verifyRelaySignature(secret, serialized, signatureHex);
}

function wireInvalid(message: string, path = '/'): never {
  throw new HardwareRunnerError('ARTIFACT_INVALID', message, path);
}

function parseIntStrict(value: unknown, min: number, max: number, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < min || value > max) {
    wireInvalid(`expected integer in ${min}..${max}`, path);
  }
  return value;
}

function parseStringStrict(value: unknown, min: number, max: number, path: string): string {
  if (typeof value !== 'string' || value.length < min || value.length > max || hasLoneSurrogate(value)) {
    wireInvalid(`expected string length ${min}..${max}`, path);
  }
  return value;
}

function parsePrintableText(value: unknown, min: number, max: number, path: string, asciiOnly = false): string {
  const s = parseStringStrict(value, min, max, path);
  if (s.trim() !== s) wireInvalid('leading or trailing whitespace forbidden', path);
  if (asciiOnly) {
    if (!PRINTABLE_ASCII_RE.test(s)) wireInvalid('expected printable ASCII', path);
  } else if (CONTROL_CHAR_RE.test(s)) {
    wireInvalid('control characters forbidden', path);
  }
  return s;
}

function parseIdentifier(value: unknown, path: string): string {
  const s = parseStringStrict(value, 1, LIMITS.identifier, path);
  if (!IDENTIFIER_RE.test(s)) wireInvalid('invalid identifier', path);
  return s;
}

function parseSafeId(value: unknown, path: string): string {
  const s = parseStringStrict(value, 1, 128, path);
  if (!SAFE_ID_RE.test(s)) wireInvalid('invalid identifier token', path);
  return s;
}

function parseOperationId(value: unknown, path: string): string {
  const s = parseStringStrict(value, 1, 128, path);
  if (!SAFE_FILENAME_ID_RE.test(s) || s === '.' || s === '..') {
    wireInvalid('invalid operationId', path);
  }
  return s;
}

function parseSha256Hex(value: unknown, path: string): string {
  const s = parseStringStrict(value, 64, 64, path);
  if (!SHA256_HEX_RE.test(s)) wireInvalid('expected 64-char lowercase sha256 hex', path);
  return s;
}

const DIGEST_KEYS: ReadonlySet<string> = new Set(['algorithm', 'hex']);

function parseDigest(value: unknown, path: string): Digest {
  const obj = expectNullProtoRecord(value, DIGEST_KEYS, ['algorithm', 'hex'], 'ARTIFACT_INVALID', path);
  if (obj.algorithm !== 'sha256') wireInvalid('digest algorithm must be sha256', `${path}/algorithm`);
  const hex = parseSha256Hex(obj.hex, `${path}/hex`);
  return Object.freeze({ algorithm: 'sha256', hex });
}

const SUBJECT_KEYS: ReadonlySet<string> = new Set([
  'lockHash',
  'contractHash',
  'repository',
  'baseRevision',
  'sourceRevision',
  'candidateDigest',
  'targetMatrixDigest',
]);

function parseSubject(value: unknown, path: string): Subject {
  const obj = expectNullProtoRecord(
    value,
    SUBJECT_KEYS,
    ['lockHash', 'contractHash', 'repository', 'baseRevision', 'sourceRevision', 'candidateDigest', 'targetMatrixDigest'],
    'ARTIFACT_INVALID',
    path,
  );
  const repository = parseStringStrict(obj.repository, 1, 256, `${path}/repository`);
  if (!REPOSITORY_RE.test(repository)) wireInvalid('invalid subject.repository', `${path}/repository`);
  const baseRevision = parseStringStrict(obj.baseRevision, 1, 128, `${path}/baseRevision`);
  if (!REVISION_RE.test(baseRevision)) wireInvalid('invalid subject.baseRevision', `${path}/baseRevision`);
  const sourceRevision = parseStringStrict(obj.sourceRevision, 1, 128, `${path}/sourceRevision`);
  if (!REVISION_RE.test(sourceRevision)) wireInvalid('invalid subject.sourceRevision', `${path}/sourceRevision`);
  return Object.freeze({
    lockHash: parseDigest(obj.lockHash, `${path}/lockHash`),
    contractHash: parseDigest(obj.contractHash, `${path}/contractHash`),
    repository,
    baseRevision,
    sourceRevision,
    candidateDigest: parseDigest(obj.candidateDigest, `${path}/candidateDigest`),
    targetMatrixDigest: obj.targetMatrixDigest === null
      ? null
      : parseDigest(obj.targetMatrixDigest, `${path}/targetMatrixDigest`),
  });
}

const HARDWARE_TARGET_KEYS: ReadonlySet<string> = new Set([
  'accelerator',
  'isolationMode',
  'deviceCount',
  'driverConstraint',
  'topology',
  'forbiddenSymbolPatterns',
  'maxRegisterCount',
  'maxLocalSpillBytes',
]);
const STAGE_A_AUDIT_KEYS: ReadonlySet<string> = new Set([
  'forbiddenSymbolPatterns',
  'maxRegisterCount',
  'maxLocalSpillBytes',
]);
const BUCKET_SCOPE_TARGET_KEYS: ReadonlySet<string> = new Set(['bucketId']);
const BUCKET_ID_WIRE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const FORBIDDEN_SYMBOL_GLOB_WIRE_RE = /[*?[\]]/;

function isValidDottedVersion(value: string): boolean {
  if (!value.length || !DOTTED_VERSION_RE.test(value)) return false;
  return value.split('.').every(seg => {
    const n = Number(seg);
    return Number.isSafeInteger(n) && n >= 0;
  });
}

function parseStageAStaticAuditFields(
  obj: Record<string, Json>,
  path: string,
): StageAStaticAuditSpec {
  let forbiddenSymbolPatterns: readonly string[] | undefined;
  if (Object.hasOwn(obj, 'forbiddenSymbolPatterns')) {
    const rawList = obj.forbiddenSymbolPatterns;
    if (!Array.isArray(rawList) || rawList.length > LIMITS.forbiddenSymbolPatterns) {
      wireInvalid(
        `forbiddenSymbolPatterns must contain 0..${LIMITS.forbiddenSymbolPatterns} patterns`,
        `${path}/forbiddenSymbolPatterns`,
      );
    }
    const seen = new Set<string>();
    const parsedPatterns = rawList.map((entry, idx) => {
      const pPath = `${path}/forbiddenSymbolPatterns/${idx}`;
      const pat = parsePrintableText(entry, 1, LIMITS.forbiddenSymbolPattern, pPath, true);
      if (FORBIDDEN_SYMBOL_GLOB_WIRE_RE.test(pat)) {
        wireInvalid('glob wildcards are forbidden in forbiddenSymbolPatterns', pPath);
      }
      if (seen.has(pat)) {
        wireInvalid(`duplicate forbiddenSymbolPattern "${pat}"`, pPath);
      }
      seen.add(pat);
      return pat;
    });
    forbiddenSymbolPatterns = Object.freeze(parsedPatterns);
  }
  const maxRegisterCount = Object.hasOwn(obj, 'maxRegisterCount')
    ? parseIntStrict(obj.maxRegisterCount, 0, Number.MAX_SAFE_INTEGER, `${path}/maxRegisterCount`)
    : undefined;
  const maxLocalSpillBytes = Object.hasOwn(obj, 'maxLocalSpillBytes')
    ? parseIntStrict(obj.maxLocalSpillBytes, 0, Number.MAX_SAFE_INTEGER, `${path}/maxLocalSpillBytes`)
    : undefined;

  return Object.freeze({
    ...(forbiddenSymbolPatterns !== undefined ? { forbiddenSymbolPatterns } : {}),
    ...(maxRegisterCount !== undefined ? { maxRegisterCount } : {}),
    ...(maxLocalSpillBytes !== undefined ? { maxLocalSpillBytes } : {}),
  });
}

function parseStageAStaticAuditSpec(value: unknown, path: string): StageAStaticAuditSpec {
  const obj = expectNullProtoRecord(value, STAGE_A_AUDIT_KEYS, [], 'ARTIFACT_INVALID', path);
  return parseStageAStaticAuditFields(obj, path);
}

function parseHardwareTarget(value: unknown, path: string): HardwareTargetSpec {
  const obj = expectNullProtoRecord(
    value,
    HARDWARE_TARGET_KEYS,
    ['accelerator', 'isolationMode'],
    'ARTIFACT_INVALID',
    path,
  );
  const accelerator = parsePrintableText(obj.accelerator, 1, 64, `${path}/accelerator`, true);
  if (obj.isolationMode !== 'whole_device' && obj.isolationMode !== 'sliced') {
    wireInvalid('isolationMode must be "whole_device" or "sliced"', `${path}/isolationMode`);
  }
  const deviceCount = Object.hasOwn(obj, 'deviceCount')
    ? parseIntStrict(obj.deviceCount, 1, 64, `${path}/deviceCount`)
    : undefined;
  let driverConstraint: string | undefined;
  if (Object.hasOwn(obj, 'driverConstraint')) {
    driverConstraint = parsePrintableText(obj.driverConstraint, 1, 128, `${path}/driverConstraint`, false);
    if (driverConstraint.startsWith('>=') && !isValidDottedVersion(driverConstraint.slice(2))) {
      wireInvalid('invalid >= dotted version driverConstraint', `${path}/driverConstraint`);
    }
  }
  const topology = Object.hasOwn(obj, 'topology')
    ? parsePrintableText(obj.topology, 1, 128, `${path}/topology`, false)
    : undefined;
  const auditFields = parseStageAStaticAuditFields(obj, path);

  return Object.freeze({
    accelerator,
    isolationMode: obj.isolationMode,
    ...(deviceCount !== undefined ? { deviceCount } : {}),
    ...(driverConstraint !== undefined ? { driverConstraint } : {}),
    ...(topology !== undefined ? { topology } : {}),
    ...(auditFields.forbiddenSymbolPatterns !== undefined
      ? { forbiddenSymbolPatterns: auditFields.forbiddenSymbolPatterns }
      : {}),
    ...(auditFields.maxRegisterCount !== undefined ? { maxRegisterCount: auditFields.maxRegisterCount } : {}),
    ...(auditFields.maxLocalSpillBytes !== undefined ? { maxLocalSpillBytes: auditFields.maxLocalSpillBytes } : {}),
  });
}

const BOUNDS_RULE_KEYS: ReadonlySet<string> = new Set(['kind', 'metric', 'min', 'max', 'bucketScope']);
const COMPARATIVE_RULE_KEYS: ReadonlySet<string> = new Set([
  'kind',
  'metric',
  'baselineMetric',
  'operator',
  'threshold',
  'bucketScope',
]);

function parseMetricBucketScope(value: unknown, path: string): MetricBucketScope {
  if (value === 'aggregate' || value === 'all_buckets') {
    return value;
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = expectNullProtoRecord(value, BUCKET_SCOPE_TARGET_KEYS, ['bucketId'], 'ARTIFACT_INVALID', path);
    const bucketId = parseStringStrict(obj.bucketId, 1, LIMITS.bucketId, `${path}/bucketId`);
    if (FORBIDDEN_METRIC_KEYS.has(bucketId) || !BUCKET_ID_WIRE_RE.test(bucketId)) {
      wireInvalid('invalid bucketScope.bucketId', `${path}/bucketId`);
    }
    return Object.freeze({ bucketId });
  }
  wireInvalid('invalid metric threshold bucketScope', path);
}

function parseMetricKey(value: unknown, path: string): string {
  const key = parseStringStrict(value, 1, LIMITS.metricKey, path);
  if (FORBIDDEN_METRIC_KEYS.has(key) || !METRIC_KEY_RE.test(key)) {
    wireInvalid('invalid metric key', path);
  }
  return key;
}

function parseFiniteControlNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0)) {
    wireInvalid('expected finite number (not -0)', path);
  }
  return value;
}

function parseMetricThresholdRule(value: unknown, path: string): MetricThresholdRule {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    wireInvalid('expected threshold rule object', path);
  }
  const rawObj = value as Record<string, Json>;
  if (!Object.hasOwn(rawObj, 'kind')) wireInvalid('missing threshold rule kind', `${path}/kind`);
  if (rawObj.kind === 'bounds') {
    const obj = expectNullProtoRecord(value, BOUNDS_RULE_KEYS, ['kind', 'metric'], 'ARTIFACT_INVALID', path);
    const metric = parseMetricKey(obj.metric, `${path}/metric`);
    const min = Object.hasOwn(obj, 'min') ? parseFiniteControlNumber(obj.min, `${path}/min`) : undefined;
    const max = Object.hasOwn(obj, 'max') ? parseFiniteControlNumber(obj.max, `${path}/max`) : undefined;
    if (min === undefined && max === undefined) {
      wireInvalid('bounds threshold rule requires min or max', path);
    }
    if (min !== undefined && max !== undefined && min > max) {
      wireInvalid('bounds min must not exceed max', path);
    }
    const bucketScope = Object.hasOwn(obj, 'bucketScope')
      ? parseMetricBucketScope(obj.bucketScope, `${path}/bucketScope`)
      : undefined;
    return Object.freeze({
      kind: 'bounds',
      metric,
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      ...(bucketScope !== undefined ? { bucketScope } : {}),
    });
  }
  if (rawObj.kind === 'comparative') {
    const obj = expectNullProtoRecord(
      value,
      COMPARATIVE_RULE_KEYS,
      ['kind', 'metric', 'baselineMetric', 'operator', 'threshold'],
      'ARTIFACT_INVALID',
      path,
    );
    const metric = parseMetricKey(obj.metric, `${path}/metric`);
    const baselineMetric = parseMetricKey(obj.baselineMetric, `${path}/baselineMetric`);
    if (obj.operator !== 'min_ratio' && obj.operator !== 'max_ratio' && obj.operator !== 'max_delta') {
      wireInvalid('invalid comparative operator', `${path}/operator`);
    }
    const threshold = parseFiniteControlNumber(obj.threshold, `${path}/threshold`);
    const bucketScope = Object.hasOwn(obj, 'bucketScope')
      ? parseMetricBucketScope(obj.bucketScope, `${path}/bucketScope`)
      : undefined;
    return Object.freeze({
      kind: 'comparative',
      metric,
      baselineMetric,
      operator: obj.operator,
      threshold,
      ...(bucketScope !== undefined ? { bucketScope } : {}),
    });
  }
  wireInvalid('unsupported threshold rule kind', `${path}/kind`);
}

const BASE_TREE_KEYS: ReadonlySet<string> = new Set(['objectFormat', 'commitOid', 'treeOid']);
const BASE_TREE_BUNDLE_KEYS: ReadonlySet<string> = new Set(['digest', 'byteLength']);
const CANDIDATE_ENTRY_KEYS: ReadonlySet<string> = new Set(['name', 'digest', 'byteLength', 'mode']);
const CANDIDATE_ARTIFACTS_KEYS: ReadonlySet<string> = new Set(['entries', 'deleted', 'baseTree', 'baseTreeBundle']);

function parseBaseTreeAnchor(value: unknown, path: string): BaseTreeAnchor {
  const obj = expectNullProtoRecord(
    value,
    BASE_TREE_KEYS,
    ['objectFormat', 'commitOid', 'treeOid'],
    'ARTIFACT_INVALID',
    path,
  );
  if (obj.objectFormat !== 'sha1' && obj.objectFormat !== 'sha256') {
    wireInvalid('objectFormat must be sha1 or sha256', `${path}/objectFormat`);
  }
  const oidRe = obj.objectFormat === 'sha1' ? SHA1_HEX_RE : SHA256_HEX_RE;
  const commitOid = parseStringStrict(obj.commitOid, 40, 64, `${path}/commitOid`);
  const treeOid = parseStringStrict(obj.treeOid, 40, 64, `${path}/treeOid`);
  if (!oidRe.test(commitOid) || !oidRe.test(treeOid)) {
    wireInvalid('invalid baseTree oid hex', path);
  }
  return Object.freeze({ objectFormat: obj.objectFormat, commitOid, treeOid });
}

function parseBaseTreeBundle(value: unknown, maxBlobBytes: number, path: string): BenchmarkBaseTreeBundle {
  const obj = expectNullProtoRecord(
    value,
    BASE_TREE_BUNDLE_KEYS,
    ['digest', 'byteLength'],
    'ARTIFACT_INVALID',
    path,
  );
  const digest = parseDigest(obj.digest, `${path}/digest`);
  const upperBound = Math.min(maxBlobBytes, VERIFIER_ARTIFACT_LIMITS.maxFileBytes);
  const byteLength = parseIntStrict(obj.byteLength, 12, upperBound, `${path}/byteLength`);
  return Object.freeze({ digest, byteLength });
}

function collectDeclaredInputBlobs(
  artifacts: BenchmarkCandidateArtifacts,
): readonly { readonly digest: Digest; readonly byteLength: number }[] {
  if (artifacts.baseTreeBundle === undefined) {
    return artifacts.entries;
  }
  return [...artifacts.entries, artifacts.baseTreeBundle];
}

function parseCandidateRelativeName(value: unknown, path: string): string {
  const raw = parseStringStrict(value, 1, LIMITS.path, path);
  const res = validateRelativePath(raw);
  if (!res.ok || isVerifierNamespacePath(res.value) || res.value.split('/').some(seg => seg.toLowerCase() === '.git')) {
    wireInvalid('invalid candidate relative path', path);
  }
  return res.value;
}

function parseCandidateArtifacts(value: unknown, maxBlobBytes: number, path: string): BenchmarkCandidateArtifacts {
  const obj = expectNullProtoRecord(
    value,
    CANDIDATE_ARTIFACTS_KEYS,
    ['entries', 'deleted'],
    'ARTIFACT_INVALID',
    path,
  );
  if (!Array.isArray(obj.entries) || obj.entries.length > 4_096) {
    wireInvalid('candidateArtifacts.entries must be a bounded array', `${path}/entries`);
  }
  if (!Array.isArray(obj.deleted) || obj.deleted.length > 4_096) {
    wireInvalid('candidateArtifacts.deleted must be a bounded array', `${path}/deleted`);
  }
  const seenPaths = new Set<string>();
  const entries: BenchmarkCandidateEntry[] = obj.entries.map((rawEntry, idx) => {
    const entryPath = `${path}/entries/${idx}`;
    const item = expectNullProtoRecord(
      rawEntry,
      CANDIDATE_ENTRY_KEYS,
      ['name', 'digest', 'byteLength'],
      'ARTIFACT_INVALID',
      entryPath,
    );
    const name = parseCandidateRelativeName(item.name, `${entryPath}/name`);
    const folded = name.toLowerCase();
    if (seenPaths.has(folded)) wireInvalid('duplicate candidate path', `${entryPath}/name`);
    seenPaths.add(folded);
    const digest = parseDigest(item.digest, `${entryPath}/digest`);
    const byteLength = parseIntStrict(item.byteLength, 0, maxBlobBytes, `${entryPath}/byteLength`);
    if ((byteLength === 0) !== (digest.hex === EMPTY_SHA256_HEX)) {
      wireInvalid('empty-file digest mismatch', `${entryPath}/digest`);
    }
    let mode: '100644' | '100755' | undefined;
    if (Object.hasOwn(item, 'mode')) {
      if (item.mode !== '100644' && item.mode !== '100755') {
        wireInvalid('candidate entry mode must be "100644" or "100755"', `${entryPath}/mode`);
      }
      mode = item.mode;
    }
    return Object.freeze({
      name,
      digest,
      byteLength,
      ...(mode !== undefined ? { mode } : {}),
    });
  });

  const deleted: string[] = obj.deleted.map((rawName, idx) => {
    const delPath = `${path}/deleted/${idx}`;
    const name = parseCandidateRelativeName(rawName, delPath);
    const folded = name.toLowerCase();
    if (seenPaths.has(folded)) wireInvalid('duplicate or overlapping deleted path', delPath);
    seenPaths.add(folded);
    return name;
  });

  const baseTree = Object.hasOwn(obj, 'baseTree')
    ? parseBaseTreeAnchor(obj.baseTree, `${path}/baseTree`)
    : undefined;
  const baseTreeBundle = Object.hasOwn(obj, 'baseTreeBundle')
    ? parseBaseTreeBundle(obj.baseTreeBundle, maxBlobBytes, `${path}/baseTreeBundle`)
    : undefined;
  if (baseTreeBundle !== undefined && baseTree === undefined) {
    wireInvalid('baseTreeBundle requires baseTree anchor', `${path}/baseTreeBundle`);
  }

  return Object.freeze({
    entries: Object.freeze(entries),
    deleted: Object.freeze(deleted),
    ...(baseTree !== undefined ? { baseTree } : {}),
    ...(baseTreeBundle !== undefined ? { baseTreeBundle } : {}),
  });
}

const BENCHMARK_REQUEST_KEYS: ReadonlySet<string> = new Set([
  'version',
  'kind',
  'storeId',
  'runId',
  'lockHash',
  'operationId',
  'dispatchId',
  'dispatchGeneration',
  'requestDigest',
  'gateId',
  'checkId',
  'candidateDigest',
  'subject',
  'targetCellId',
  'targetHardware',
  'stageAAudit',
  'heldOutWorkloadId',
  'metricThresholds',
  'maxPreemptions',
  'candidateArtifacts',
]);

export function parseBenchmarkRequest(
  rawInput: unknown,
  maxBlobBytes: number = VERIFIER_ARTIFACT_LIMITS.maxFileBytes,
): BenchmarkRequest {
  const normalized = toNullPrototypeValue(rawInput, 'ARTIFACT_INVALID', '/');
  const root = expectNullProtoRecord(
    normalized,
    BENCHMARK_REQUEST_KEYS,
    [
      'version',
      'kind',
      'storeId',
      'runId',
      'lockHash',
      'operationId',
      'dispatchId',
      'dispatchGeneration',
      'requestDigest',
      'gateId',
      'checkId',
      'candidateDigest',
      'subject',
      'targetCellId',
      'targetHardware',
      'heldOutWorkloadId',
      'candidateArtifacts',
    ],
    'ARTIFACT_INVALID',
    '/',
  );

  if (root.version !== 1) wireInvalid('version must be 1', '/version');
  if (root.kind !== 'benchmark_request') wireInvalid('kind must be benchmark_request', '/kind');
  const storeId = parseSafeId(root.storeId, '/storeId');
  const runId = parseIdentifier(root.runId, '/runId');
  const lockHash = parseDigest(root.lockHash, '/lockHash');
  const operationId = parseOperationId(root.operationId, '/operationId');
  const dispatchId = parseSafeId(root.dispatchId, '/dispatchId');
  const dispatchGeneration = parseIntStrict(root.dispatchGeneration, 0, Number.MAX_SAFE_INTEGER, '/dispatchGeneration');
  const requestDigest = parseSha256Hex(root.requestDigest, '/requestDigest');
  const gateId = parsePrintableText(root.gateId, 1, 128, '/gateId', true);
  const checkId = parseIdentifier(root.checkId, '/checkId');
  const candidateDigest = parseSha256Hex(root.candidateDigest, '/candidateDigest');
  const subject = parseSubject(root.subject, '/subject');
  if (subject.candidateDigest.hex !== candidateDigest || subject.lockHash.hex !== lockHash.hex) {
    wireInvalid('subject bindings do not match candidateDigest or lockHash', '/subject');
  }
  const targetCellId = parseIdentifier(root.targetCellId, '/targetCellId');
  const targetHardware = parseHardwareTarget(root.targetHardware, '/targetHardware');
  const stageAAudit = Object.hasOwn(root, 'stageAAudit')
    ? parseStageAStaticAuditSpec(root.stageAAudit, '/stageAAudit')
    : undefined;
  if (
    targetHardware.forbiddenSymbolPatterns !== undefined
    && stageAAudit?.forbiddenSymbolPatterns !== undefined
  ) {
    const combinedPatterns = new Set<string>([
      ...targetHardware.forbiddenSymbolPatterns,
      ...stageAAudit.forbiddenSymbolPatterns,
    ]);
    if (combinedPatterns.size > LIMITS.forbiddenSymbolPatterns) {
      wireInvalid(
        `combined forbiddenSymbolPatterns exceeds ${LIMITS.forbiddenSymbolPatterns}`,
        '/stageAAudit/forbiddenSymbolPatterns',
      );
    }
  }
  const heldOutWorkloadId = parsePrintableText(root.heldOutWorkloadId, 1, 128, '/heldOutWorkloadId', true);
  if (!SAFE_FILENAME_ID_RE.test(heldOutWorkloadId)) {
    wireInvalid('invalid heldOutWorkloadId', '/heldOutWorkloadId');
  }

  let metricThresholds: readonly MetricThresholdRule[] = Object.freeze([]);
  if (Object.hasOwn(root, 'metricThresholds')) {
    if (!Array.isArray(root.metricThresholds) || root.metricThresholds.length > LIMITS.metricThresholds) {
      wireInvalid(`metricThresholds must contain 0..${LIMITS.metricThresholds} rules`, '/metricThresholds');
    }
    metricThresholds = Object.freeze(
      root.metricThresholds.map((r, idx) => parseMetricThresholdRule(r, `/metricThresholds/${idx}`)),
    );
  }

  const maxPreemptions = Object.hasOwn(root, 'maxPreemptions')
    ? parseIntStrict(root.maxPreemptions, 0, 16, '/maxPreemptions')
    : 3;

  const candidateArtifacts = parseCandidateArtifacts(root.candidateArtifacts, maxBlobBytes, '/candidateArtifacts');

  return Object.freeze({
    version: 1,
    kind: 'benchmark_request',
    storeId,
    runId,
    lockHash,
    operationId,
    dispatchId,
    dispatchGeneration,
    requestDigest,
    gateId,
    checkId,
    candidateDigest,
    subject,
    targetCellId,
    targetHardware,
    ...(stageAAudit !== undefined ? { stageAAudit } : {}),
    heldOutWorkloadId,
    metricThresholds,
    maxPreemptions,
    candidateArtifacts,
  });
}

const ACQUIRE_KEYS: ReadonlySet<string> = new Set(['workerId', 'capabilities', 'waitMs']);
const HEARTBEAT_KEYS: ReadonlySet<string> = new Set(['relayBootId', 'leaseEpoch', 'leaseToken', 'state']);
const PREEMPT_KEYS: ReadonlySet<string> = new Set(['relayBootId', 'leaseEpoch', 'leaseToken', 'reason']);
const COMPLETE_KEYS: ReadonlySet<string> = new Set([
  'relayBootId',
  'leaseEpoch',
  'leaseToken',
  'status',
  'reason',
  'detail',
  'metrics',
  'findings',
  'hardwareProvenance',
  'bucketMetrics',
  'hardwareDiagnostics',
  'outputArtifacts',
]);
const PROVENANCE_KEYS: ReadonlySet<string> = new Set([
  'targetCellId',
  'probeKind',
  'vendor',
  'deviceModel',
  'accelerator',
  'isolationMode',
  'deviceCount',
  'driverVersion',
  'runtimeVersion',
  'topology',
  'workloadDigest',
  'clockLockMode',
]);
const FINDING_KEYS: ReadonlySet<string> = new Set(['title', 'severity', 'path', 'line', 'evidence']);
const OUTPUT_ARTIFACT_KEYS: ReadonlySet<string> = new Set(['name', 'digest', 'byteLength', 'mediaType']);
const SIGNED_RECEIPT_KEYS: ReadonlySet<string> = new Set([
  'version',
  'kind',
  'storeId',
  'runId',
  'lockHash',
  'operationId',
  'dispatchId',
  'dispatchGeneration',
  'gateId',
  'checkId',
  'candidateDigest',
  'status',
  'reason',
  'expiresAtMs',
  'preemptionCount',
  'retryablePreemption',
  'detail',
  'metrics',
  'findings',
  'hardwareProvenance',
  'bucketMetrics',
  'hardwareDiagnostics',
  'outputArtifacts',
  'signature',
]);
const OPERATION_RECORD_KEYS: ReadonlySet<string> = new Set([
  'version',
  'kind',
  'request',
  'signature',
]);

function parseAcquireInput(raw: Json): AcquireLeaseInput {
  const obj = expectNullProtoRecord(raw, ACQUIRE_KEYS, ['workerId', 'capabilities'], 'ARTIFACT_INVALID', '/');
  const workerId = parseSafeId(obj.workerId, '/workerId');
  const capabilities = validateWorkerCapabilitiesObject(obj.capabilities, 'ARTIFACT_INVALID', '/capabilities');
  const waitMs = Object.hasOwn(obj, 'waitMs')
    ? Math.min(MAX_ACQUIRE_WAIT_MS, parseIntStrict(obj.waitMs, 0, 300_000, '/waitMs'))
    : undefined;
  return Object.freeze({
    workerId,
    capabilities,
    ...(waitMs !== undefined ? { waitMs } : {}),
  });
}

function parseLeaseCredsFromObject(obj: Record<string, Json>): LeaseCredentials {
  if (
    typeof obj.relayBootId !== 'string'
    || typeof obj.leaseToken !== 'string'
    || typeof obj.leaseEpoch !== 'number'
    || !Number.isSafeInteger(obj.leaseEpoch)
    || Object.is(obj.leaseEpoch, -0)
    || obj.leaseEpoch < 1
  ) {
    throw new HardwareRunnerError('QUEUE_LEASE_FENCED', 'invalid lease credentials');
  }
  return {
    relayBootId: obj.relayBootId,
    leaseEpoch: obj.leaseEpoch,
    leaseToken: obj.leaseToken,
  };
}

function parseHeartbeatInput(raw: Json): HeartbeatLeaseInput {
  const obj = expectNullProtoRecord(
    raw,
    HEARTBEAT_KEYS,
    ['relayBootId', 'leaseEpoch', 'leaseToken'],
    'ARTIFACT_INVALID',
    '/',
  );
  const creds = parseLeaseCredsFromObject(obj);
  if (Object.hasOwn(obj, 'state') && obj.state !== 'running') {
    wireInvalid('heartbeat state must be "running"', '/state');
  }
  return Object.freeze({
    ...creds,
    ...(Object.hasOwn(obj, 'state') ? { state: 'running' as const } : {}),
  });
}

function parsePreemptInput(raw: Json): PreemptLeaseInput {
  const obj = expectNullProtoRecord(
    raw,
    PREEMPT_KEYS,
    ['relayBootId', 'leaseEpoch', 'leaseToken'],
    'ARTIFACT_INVALID',
    '/',
  );
  const creds = parseLeaseCredsFromObject(obj);
  const reason = Object.hasOwn(obj, 'reason')
    ? parseStringStrict(obj.reason, 1, 256, '/reason')
    : undefined;
  return Object.freeze({
    ...creds,
    ...(reason !== undefined ? { reason } : {}),
  });
}

function parseMetricsMap(value: unknown, path: string): MetricsMap {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    wireInvalid('metrics must be an object', path);
  }
  const src = value as Record<string, Json>;
  const keys = Object.keys(src).sort();
  if (keys.length > LIMITS.metricEntries) {
    wireInvalid('metrics exceeds maximum entry count', path);
  }
  const out: Record<string, MetricValue> = Object.create(null) as Record<string, MetricValue>;
  for (const key of keys) {
    parseMetricKey(key, `${path}/${key}`);
    const entry = src[key];
    if (typeof entry === 'number') {
      out[key] = parseFiniteControlNumber(entry, `${path}/${key}`);
    } else if (typeof entry === 'string') {
      out[key] = parseStringStrict(entry, 0, LIMITS.metricStringValue, `${path}/${key}`);
    } else if (typeof entry === 'boolean') {
      out[key] = entry;
    } else {
      wireInvalid('unsupported metric value type', `${path}/${key}`);
    }
  }
  return Object.freeze(out);
}

function parseFindingsList(value: unknown, path: string): readonly StructuredFinding[] {
  if (!Array.isArray(value) || value.length > LIMITS.findings) {
    wireInvalid('findings must be a bounded array', path);
  }
  const out: StructuredFinding[] = value.map((item, idx) => {
    const fPath = `${path}/${idx}`;
    const obj = expectNullProtoRecord(item, FINDING_KEYS, ['title', 'severity', 'evidence'], 'ARTIFACT_INVALID', fPath);
    const title = parseStringStrict(obj.title, 1, LIMITS.findingTitle, `${fPath}/title`);
    if (obj.severity !== 'critical' && obj.severity !== 'high' && obj.severity !== 'medium' && obj.severity !== 'low') {
      wireInvalid('invalid finding severity', `${fPath}/severity`);
    }
    const severity: FindingSeverity = obj.severity;
    const evidence = parseStringStrict(obj.evidence, 1, LIMITS.findingEvidence, `${fPath}/evidence`);
    let relPath: string | null | undefined;
    if (Object.hasOwn(obj, 'path')) {
      if (obj.path === null) relPath = null;
      else {
        const s = parseStringStrict(obj.path, 1, LIMITS.path, `${fPath}/path`);
        const valid = validateRelativePath(s);
        if (!valid.ok) wireInvalid('invalid finding path', `${fPath}/path`);
        relPath = valid.value;
      }
    }
    let line: number | null | undefined;
    if (Object.hasOwn(obj, 'line')) {
      line = obj.line === null ? null : parseIntStrict(obj.line, 1, Number.MAX_SAFE_INTEGER, `${fPath}/line`);
    }
    const built: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    built.title = title;
    built.severity = severity;
    if (relPath !== undefined) built.path = relPath;
    if (line !== undefined) built.line = line;
    built.evidence = evidence;
    return Object.freeze(built as unknown as StructuredFinding);
  });
  return Object.freeze(out);
}

function parseHardwareProvenance(value: unknown, path: string): HardwareProvenance {
  const obj = expectNullProtoRecord(
    value,
    PROVENANCE_KEYS,
    [
      'targetCellId',
      'probeKind',
      'vendor',
      'deviceModel',
      'accelerator',
      'isolationMode',
      'deviceCount',
      'driverVersion',
      'runtimeVersion',
      'workloadDigest',
      'clockLockMode',
    ],
    'ARTIFACT_INVALID',
    path,
  );
  const targetCellId = parseIdentifier(obj.targetCellId, `${path}/targetCellId`);
  if (obj.probeKind !== 'physical' && obj.probeKind !== 'synthetic_fixture') {
    wireInvalid('invalid probeKind', `${path}/probeKind`);
  }
  const vendor = parsePrintableText(obj.vendor, 1, 128, `${path}/vendor`, false);
  const deviceModel = parsePrintableText(obj.deviceModel, 1, 128, `${path}/deviceModel`, false);
  const accelerator = parsePrintableText(obj.accelerator, 1, 64, `${path}/accelerator`, true);
  if (obj.isolationMode !== 'whole_device' && obj.isolationMode !== 'sliced') {
    wireInvalid('invalid isolationMode', `${path}/isolationMode`);
  }
  const deviceCount = parseIntStrict(obj.deviceCount, 1, 64, `${path}/deviceCount`);
  const driverVersion = parsePrintableText(obj.driverVersion, 1, 128, `${path}/driverVersion`, false);
  const runtimeVersion = parsePrintableText(obj.runtimeVersion, 1, 128, `${path}/runtimeVersion`, false);
  const topology = Object.hasOwn(obj, 'topology')
    ? parsePrintableText(obj.topology, 1, 128, `${path}/topology`, false)
    : undefined;
  const workloadDigest = parseDigest(obj.workloadDigest, `${path}/workloadDigest`);
  if (obj.clockLockMode !== 'locked' && obj.clockLockMode !== 'unlocked' && obj.clockLockMode !== 'unknown') {
    wireInvalid('invalid clockLockMode', `${path}/clockLockMode`);
  }
  return Object.freeze({
    targetCellId,
    probeKind: obj.probeKind,
    vendor,
    deviceModel,
    accelerator,
    isolationMode: obj.isolationMode,
    deviceCount,
    driverVersion,
    runtimeVersion,
    ...(topology !== undefined ? { topology } : {}),
    workloadDigest,
    clockLockMode: obj.clockLockMode,
  });
}

function validateMediaType(value: unknown, path: string): string {
  const mime = parseStringStrict(value, 1, LIMITS.mediaType, path);
  if (CONTROL_CHAR_RE.test(mime)) wireInvalid('invalid mediaType', path);
  const parts = mime.split(';');
  const essence = parts[0]!.trim();
  if (
    essence !== parts[0]!
    || !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/.test(essence)
  ) {
    wireInvalid('invalid mediaType essence', path);
  }
  for (let idx = 1; idx < parts.length; idx += 1) {
    const param = parts[idx]!.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*=[A-Za-z0-9!#$&^_.+-]+$/.test(param)) {
      wireInvalid('invalid mediaType parameter', path);
    }
  }
  return mime;
}

function parseOutputArtifacts(
  value: unknown,
  maxBlobBytes: number,
  path: string,
): readonly BenchmarkOutputArtifact[] {
  if (!Array.isArray(value) || value.length > VERIFIER_ARTIFACT_LIMITS.maxFilesPerSlot) {
    wireInvalid(`outputArtifacts must contain 0..${VERIFIER_ARTIFACT_LIMITS.maxFilesPerSlot} entries`, path);
  }
  const perFileMax = Math.min(maxBlobBytes, VERIFIER_ARTIFACT_LIMITS.maxFileBytes);
  const seen = new Set<string>();
  let totalBytes = 0;
  const out: BenchmarkOutputArtifact[] = value.map((item, idx) => {
    const aPath = `${path}/${idx}`;
    const obj = expectNullProtoRecord(
      item,
      OUTPUT_ARTIFACT_KEYS,
      ['name', 'digest', 'byteLength'],
      'ARTIFACT_INVALID',
      aPath,
    );
    const name = parseCandidateRelativeName(obj.name, `${aPath}/name`);
    const folded = name.toLowerCase();
    if (seen.has(folded)) wireInvalid('duplicate outputArtifact path', `${aPath}/name`);
    seen.add(folded);
    const digest = parseDigest(obj.digest, `${aPath}/digest`);
    const byteLength = parseIntStrict(obj.byteLength, 0, perFileMax, `${aPath}/byteLength`);
    if ((byteLength === 0) !== (digest.hex === EMPTY_SHA256_HEX)) {
      wireInvalid('empty outputArtifact digest mismatch', `${aPath}/digest`);
    }
    if (byteLength > VERIFIER_ARTIFACT_LIMITS.maxTotalBytes - totalBytes) {
      throw new HardwareRunnerError(
        'PAYLOAD_TOO_LARGE',
        `outputArtifacts total byteLength exceeds ${VERIFIER_ARTIFACT_LIMITS.maxTotalBytes} bytes`,
        `${aPath}/byteLength`,
      );
    }
    totalBytes += byteLength;
    let mediaType: string | null | undefined;
    if (Object.hasOwn(obj, 'mediaType')) {
      mediaType = obj.mediaType === null ? null : validateMediaType(obj.mediaType, `${aPath}/mediaType`);
    }
    return Object.freeze({
      name,
      digest,
      byteLength,
      ...(mediaType !== undefined ? { mediaType } : {}),
    });
  });
  return Object.freeze(out);
}

const DEFAULT_WIRE_SCRUBBER = new SecretScrubber();

function assertNoRawInvalidWireNumbers(value: unknown, path: string, depth = 0): void {
  if (depth > 32) {
    wireInvalid('wire structure exceeds maximum depth', path);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      wireInvalid('numeric value must be finite and not -0', path);
    }
    return;
  }
  if (typeof value === 'string') {
    if (hasLoneSurrogate(value)) {
      wireInvalid('string contains lone UTF-16 surrogate', path);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      assertNoRawInvalidWireNumbers(value[i], `${path}/${i}`, depth + 1);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    const rec = value as Readonly<Record<string, unknown>>;
    for (const key of Reflect.ownKeys(rec)) {
      if (typeof key !== 'string' || FORBIDDEN_METRIC_KEYS.has(key) || hasLoneSurrogate(key)) {
        wireInvalid('forbidden object key', path);
      }
      assertNoRawInvalidWireNumbers(rec[key], `${path}/${key}`, depth + 1);
    }
  }
}

function parseWireBucketMetrics(
  value: unknown,
  path: string,
  scrubber: SecretScrubber = DEFAULT_WIRE_SCRUBBER,
): readonly BucketMetricEntry[] {
  assertNoRawInvalidWireNumbers(value, path);
  const validated = validateBucketMetrics(value, scrubber);
  if (!validated.ok) {
    const first = validated.errors[0];
    wireInvalid(
      `invalid bucketMetrics (${first?.code ?? 'INVALID'})`,
      first?.path ? `${path}${first.path}` : path,
    );
  }
  return validated.value;
}

function parseWireHardwareDiagnostics(
  value: unknown,
  path: string,
  scrubber: SecretScrubber = DEFAULT_WIRE_SCRUBBER,
): HardwareDiagnostics {
  assertNoRawInvalidWireNumbers(value, path);
  const validated = validateHardwareDiagnostics(value, scrubber);
  if (!validated.ok) {
    const first = validated.errors[0];
    wireInvalid(
      `invalid hardwareDiagnostics (${first?.code ?? 'INVALID'})`,
      first?.path ? `${path}${first.path}` : path,
    );
  }
  return validated.value;
}

function parseCompleteInput(
  raw: Json,
  maxBlobBytes: number,
  scrubber: SecretScrubber = DEFAULT_WIRE_SCRUBBER,
): CompleteLeaseInput {
  const obj = expectNullProtoRecord(
    raw,
    COMPLETE_KEYS,
    ['relayBootId', 'leaseEpoch', 'leaseToken', 'status', 'reason'],
    'ARTIFACT_INVALID',
    '/',
  );
  const creds = parseLeaseCredsFromObject(obj);
  if (obj.status !== 'approved' && obj.status !== 'denied') {
    wireInvalid('status must be "approved" or "denied"', '/status');
  }
  const reason = obj.reason === null ? null : parseStringStrict(obj.reason, 1, 256, '/reason');
  if (obj.status === 'approved' && reason !== null) {
    wireInvalid('approved verdict must carry reason: null', '/reason');
  }
  if (obj.status === 'denied' && reason === null) {
    wireInvalid('denied verdict requires non-null reason', '/reason');
  }
  const detail = Object.hasOwn(obj, 'detail')
    ? obj.detail === null ? null : parseStringStrict(obj.detail, 1, LIMITS.string, '/detail')
    : undefined;
  const metrics = Object.hasOwn(obj, 'metrics') ? parseMetricsMap(obj.metrics, '/metrics') : undefined;
  const findings = Object.hasOwn(obj, 'findings') ? parseFindingsList(obj.findings, '/findings') : undefined;
  const hardwareProvenance = Object.hasOwn(obj, 'hardwareProvenance')
    ? parseHardwareProvenance(obj.hardwareProvenance, '/hardwareProvenance')
    : undefined;
  if (obj.status === 'approved' && hardwareProvenance === undefined) {
    wireInvalid('approved verdict requires hardwareProvenance', '/hardwareProvenance');
  }
  const bucketMetrics = Object.hasOwn(obj, 'bucketMetrics')
    ? parseWireBucketMetrics(obj.bucketMetrics, '/bucketMetrics', scrubber)
    : undefined;
  const hardwareDiagnostics = Object.hasOwn(obj, 'hardwareDiagnostics')
    ? parseWireHardwareDiagnostics(obj.hardwareDiagnostics, '/hardwareDiagnostics', scrubber)
    : undefined;
  const outputArtifacts = Object.hasOwn(obj, 'outputArtifacts')
    ? parseOutputArtifacts(obj.outputArtifacts, maxBlobBytes, '/outputArtifacts')
    : undefined;

  return Object.freeze({
    ...creds,
    status: obj.status,
    reason,
    ...(detail !== undefined ? { detail } : {}),
    ...(metrics !== undefined ? { metrics } : {}),
    ...(findings !== undefined ? { findings } : {}),
    ...(hardwareProvenance !== undefined ? { hardwareProvenance } : {}),
    ...(bucketMetrics !== undefined ? { bucketMetrics } : {}),
    ...(hardwareDiagnostics !== undefined ? { hardwareDiagnostics } : {}),
    ...(outputArtifacts !== undefined ? { outputArtifacts } : {}),
  });
}

function parseAuthenticatedReceiptBytes(
  bytes: Uint8Array,
  expectedOperationId: string,
  signingSecret: string,
  maxBlobBytes: number,
  scrubber: SecretScrubber,
): BenchmarkVerdict {
  const raw = parseStrictJsonBytes(bytes, MAX_RECEIPT_FILE_BYTES, 'ARTIFACT_INVALID', '/receipt');
  const obj = expectNullProtoRecord(
    raw,
    SIGNED_RECEIPT_KEYS,
    [
      'version',
      'kind',
      'storeId',
      'runId',
      'lockHash',
      'operationId',
      'dispatchId',
      'dispatchGeneration',
      'gateId',
      'checkId',
      'candidateDigest',
      'status',
      'reason',
      'expiresAtMs',
      'preemptionCount',
      'signature',
    ],
    'ARTIFACT_INVALID',
    '/receipt',
  );

  const signature = parseSha256Hex(obj.signature, '/receipt/signature');
  if (!verifyBenchmarkVerdictSignature(signingSecret, obj, signature)) {
    wireInvalid('receipt HMAC signature verification failed', '/receipt/signature');
  }

  if (obj.version !== 1) wireInvalid('receipt version must be 1', '/receipt/version');
  if (obj.kind !== 'benchmark_verdict') wireInvalid('receipt kind must be benchmark_verdict', '/receipt/kind');
  const storeId = parseSafeId(obj.storeId, '/receipt/storeId');
  const runId = parseIdentifier(obj.runId, '/receipt/runId');
  const lockHash = parseDigest(obj.lockHash, '/receipt/lockHash');
  const operationId = parseOperationId(obj.operationId, '/receipt/operationId');
  if (operationId !== expectedOperationId) {
    wireInvalid('receipt operationId does not match filename', '/receipt/operationId');
  }
  const dispatchId = parseSafeId(obj.dispatchId, '/receipt/dispatchId');
  const dispatchGeneration = parseIntStrict(obj.dispatchGeneration, 0, Number.MAX_SAFE_INTEGER, '/receipt/dispatchGeneration');
  const gateId = parsePrintableText(obj.gateId, 1, 128, '/receipt/gateId', true);
  const checkId = parseIdentifier(obj.checkId, '/receipt/checkId');
  const candidateDigest = parseSha256Hex(obj.candidateDigest, '/receipt/candidateDigest');

  if (obj.status !== 'approved' && obj.status !== 'denied' && obj.status !== 'expired') {
    wireInvalid('durable receipt status must be terminal', '/receipt/status');
  }
  const status = obj.status;
  const reason = obj.reason === null ? null : parseStringStrict(obj.reason, 1, 256, '/receipt/reason');
  if (status === 'approved' && reason !== null) {
    wireInvalid('approved receipt must carry null reason', '/receipt/reason');
  }
  const expiresAtMs = parseStringStrict(obj.expiresAtMs, 1, 19, '/receipt/expiresAtMs');
  if (!/^(?:0|[1-9][0-9]{0,17})$/.test(expiresAtMs)) {
    wireInvalid('invalid receipt expiresAtMs', '/receipt/expiresAtMs');
  }
  const preemptionCount = parseIntStrict(obj.preemptionCount, 0, 16, '/receipt/preemptionCount');

  let retryablePreemption: boolean | undefined;
  if (Object.hasOwn(obj, 'retryablePreemption')) {
    if (typeof obj.retryablePreemption !== 'boolean' || (obj.retryablePreemption === true && status === 'approved')) {
      wireInvalid('invalid retryablePreemption on receipt', '/receipt/retryablePreemption');
    }
    retryablePreemption = obj.retryablePreemption;
  }
  const detail = Object.hasOwn(obj, 'detail')
    ? obj.detail === null ? null : parseStringStrict(obj.detail, 1, LIMITS.string, '/receipt/detail')
    : undefined;
  const metrics = Object.hasOwn(obj, 'metrics') ? parseMetricsMap(obj.metrics, '/receipt/metrics') : undefined;
  const findings = Object.hasOwn(obj, 'findings') ? parseFindingsList(obj.findings, '/receipt/findings') : undefined;
  const hardwareProvenance = Object.hasOwn(obj, 'hardwareProvenance')
    ? parseHardwareProvenance(obj.hardwareProvenance, '/receipt/hardwareProvenance')
    : undefined;
  if (status === 'approved' && hardwareProvenance === undefined) {
    wireInvalid('approved receipt requires hardwareProvenance', '/receipt/hardwareProvenance');
  }
  const bucketMetrics = Object.hasOwn(obj, 'bucketMetrics')
    ? parseWireBucketMetrics(obj.bucketMetrics, '/receipt/bucketMetrics', scrubber)
    : undefined;
  const hardwareDiagnostics = Object.hasOwn(obj, 'hardwareDiagnostics')
    ? parseWireHardwareDiagnostics(obj.hardwareDiagnostics, '/receipt/hardwareDiagnostics', scrubber)
    : undefined;
  const outputArtifacts = Object.hasOwn(obj, 'outputArtifacts')
    ? parseOutputArtifacts(obj.outputArtifacts, maxBlobBytes, '/receipt/outputArtifacts')
    : undefined;

  const verdict: BenchmarkVerdict = Object.freeze({
    version: 1,
    kind: 'benchmark_verdict',
    storeId,
    runId,
    lockHash,
    operationId,
    dispatchId,
    dispatchGeneration,
    gateId,
    checkId,
    candidateDigest,
    status,
    reason,
    expiresAtMs,
    preemptionCount,
    ...(retryablePreemption !== undefined ? { retryablePreemption } : {}),
    ...(detail !== undefined ? { detail } : {}),
    ...(metrics !== undefined ? { metrics } : {}),
    ...(findings !== undefined ? { findings } : {}),
    ...(hardwareProvenance !== undefined ? { hardwareProvenance } : {}),
    ...(bucketMetrics !== undefined ? { bucketMetrics } : {}),
    ...(hardwareDiagnostics !== undefined ? { hardwareDiagnostics } : {}),
    ...(outputArtifacts !== undefined ? { outputArtifacts } : {}),
  });

  const canonical = canonicalJson(verdict);
  if (Buffer.byteLength(canonical, 'utf8') > MAX_CONTROL_BODY_BYTES) {
    wireInvalid('receipt verdict exceeds 65536 bytes', '/receipt');
  }
  if (scrubber.containsSecret(canonical)) {
    wireInvalid('receipt verdict rejected by SecretScrubber', '/receipt');
  }
  return verdict;
}

function parseAuthenticatedOperationBytes(
  bytes: Uint8Array,
  expectedOperationId: string,
  signingSecret: string,
  maxBlobBytes: number,
): BenchmarkRequest {
  const raw = parseStrictJsonBytes(bytes, MAX_OPERATION_FILE_BYTES, 'ARTIFACT_INVALID', '/operation');
  const obj = expectNullProtoRecord(
    raw,
    OPERATION_RECORD_KEYS,
    ['version', 'kind', 'request', 'signature'],
    'ARTIFACT_INVALID',
    '/operation',
  );
  if (obj.version !== 1 || obj.kind !== 'benchmark_operation_request') {
    wireInvalid('invalid operation record kind or version', '/operation');
  }
  const signature = parseSha256Hex(obj.signature, '/operation/signature');
  const req = parseBenchmarkRequest(obj.request, maxBlobBytes);
  if (req.operationId !== expectedOperationId) {
    wireInvalid('operationId mismatch in persisted operation record', '/operation/request/operationId');
  }
  const signingInput = `REQ\n${canonicalJson(req)}`;
  if (!verifyRelaySignature(signingSecret, signingInput, signature)) {
    wireInvalid('operation record HMAC signature verification failed', '/operation/signature');
  }
  return req;
}

function singleHeader(req: IncomingMessage, name: string): string | null {
  const val = req.headers[name];
  if (typeof val === 'string') return val;
  return null;
}

function parseLeaseHeaders(req: IncomingMessage): LeaseCredentials {
  const relayBootId = singleHeader(req, 'x-loopwright-relay-boot-id');
  const epochRaw = singleHeader(req, 'x-loopwright-lease-epoch');
  const leaseToken = singleHeader(req, 'x-loopwright-lease-token');
  if (
    relayBootId === null
    || epochRaw === null
    || leaseToken === null
    || relayBootId.length === 0
    || leaseToken.length === 0
    || !/^[1-9][0-9]{0,14}$/.test(epochRaw)
  ) {
    throw new HardwareRunnerError('ARTIFACT_INVALID', 'missing or malformed lease fencing headers');
  }
  const leaseEpoch = Number(epochRaw);
  if (!Number.isSafeInteger(leaseEpoch) || leaseEpoch < 1) {
    throw new HardwareRunnerError('ARTIFACT_INVALID', 'invalid x-loopwright-lease-epoch header');
  }
  return { relayBootId, leaseEpoch, leaseToken };
}

function extractBearerToken(req: IncomingMessage): string | null {
  const auth = singleHeader(req, 'authorization');
  if (auth === null || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  return token.length > 0 ? token : null;
}

function verifyBearerAgainstList(req: IncomingMessage, validTokens: readonly string[]): boolean {
  const token = extractBearerToken(req);
  if (token === null) return false;
  let matched = false;
  for (const candidate of validTokens) {
    if (timingSafeEqualStrings(token, candidate)) {
      matched = true;
    }
  }
  return matched;
}

async function readBoundedRequestBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const clHeader = singleHeader(req, 'content-length');
  if (clHeader !== null) {
    if (!/^(?:0|[1-9][0-9]{0,14})$/.test(clHeader)) {
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'invalid content-length header');
    }
    if (Number(clHeader) > maxBytes) {
      throw new HardwareRunnerError('PAYLOAD_TOO_LARGE', `request body exceeds ${maxBytes} bytes`);
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const rawChunk of req) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
    total += chunk.byteLength;
    if (total > maxBytes) {
      throw new HardwareRunnerError('PAYLOAD_TOO_LARGE', `request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  return chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks, total);
}

async function readRecordFileOrNull(
  filePath: string,
  maxBytes: number,
  phase: 'startup' | 'runtime',
): Promise<Buffer | null> {
  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
  const failIntegrity = (message: string, cause?: unknown): never => {
    if (phase === 'startup') {
      throw new HardwareRunnerError('ARTIFACT_INVALID', message, filePath);
    }
    throw new Error(message, cause !== undefined ? { cause } : undefined);
  };

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, constants.O_RDONLY | noFollow);
  } catch (err: unknown) {
    const errCode = (err as NodeJS.ErrnoException)?.code;
    if (errCode === 'ENOENT') {
      const lst = await lstat(filePath).catch((lstatErr: unknown) => {
        if ((lstatErr as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
        throw lstatErr;
      });
      if (lst === null) {
        return null;
      }
      return failIntegrity('symlink or irregular file at record path', err);
    }
    if (errCode === 'ELOOP' || errCode === 'EMLINK' || errCode === 'EFTYPE' || errCode === 'EISDIR') {
      return failIntegrity('failed to open file without following symlinks', err);
    }
    throw err;
  }
  try {
    const st = await handle.stat();
    if (
      !st.isFile()
      || st.isSymbolicLink()
      || st.nlink !== 1
      || (typeof process.getuid === 'function' && st.uid !== process.getuid())
      || (st.mode & 0o022) !== 0
      || st.size > maxBytes
    ) {
      return failIntegrity('file failed ownership, nlink, mode, or size check');
    }
    const buf = Buffer.allocUnsafe(st.size);
    let offset = 0;
    while (offset < st.size) {
      const { bytesRead } = await handle.read(buf, offset, st.size - offset, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== st.size || after.ino !== st.ino || after.dev !== st.dev || after.size !== st.size) {
      return failIntegrity('file changed during bounded read');
    }
    return buf;
  } finally {
    await handle.close();
  }
}

async function readRequiredStartupRecord(filePath: string, maxBytes: number): Promise<Buffer> {
  const bytes = await readRecordFileOrNull(filePath, maxBytes, 'startup');
  if (bytes === null) {
    throw new HardwareRunnerError('ARTIFACT_INVALID', 'expected CAS record missing during startup', filePath);
  }
  return bytes;
}

async function writeAllToFileHandle(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
    if (bytesWritten <= 0) {
      throw new Error('Zero bytes written to CAS temp file');
    }
    offset += bytesWritten;
  }
}

async function syncDir(dirPath: string): Promise<void> {
  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
  const dirHandle = await open(dirPath, constants.O_RDONLY | noFollow);
  try {
    await dirHandle.sync();
  } finally {
    await dirHandle.close();
  }
}

function assertTrustedAncestorStatSync(st: Stats, ancPath: string, myUid: number | null): void {
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new HardwareRunnerError('CONFIG_INVALID', `CAS ancestor "${ancPath}" is not a regular directory`, '/casDir');
  }
  if (myUid !== null) {
    const trustedRootSticky = st.uid === 0 && (st.mode & 0o1000) !== 0;
    if (st.uid === myUid) {
      if ((st.mode & 0o022) !== 0 && !trustedRootSticky) {
        throw new HardwareRunnerError(
          'CONFIG_INVALID',
          `CAS ancestor directory "${ancPath}" must not be group or world writable`,
          '/casDir',
        );
      }
    } else {
      const trustedRootDir = st.uid === 0 && ((st.mode & 0o022) === 0 || (st.mode & 0o1000) !== 0);
      if (!trustedRootDir) {
        throw new HardwareRunnerError(
          'CONFIG_INVALID',
          `CAS ancestor directory "${ancPath}" is owned by an untrusted principal or is non-sticky writable`,
          '/casDir',
        );
      }
    }
  }
}

function inspectExistingAncestorSync(ancPath: string, myUid: number | null): boolean {
  let st: Stats;
  try {
    st = lstatSync(ancPath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return false;
    }
    throw new HardwareRunnerError('CONFIG_INVALID', 'failed to inspect CAS directory ancestor', '/casDir');
  }
  if (st.isSymbolicLink()) {
    if (!isAllowedOsRootSymlink(ancPath) || (myUid !== null && st.uid !== 0)) {
      throw new HardwareRunnerError('CONFIG_INVALID', 'symlinked CAS ancestor is forbidden', '/casDir');
    }
    let realTarget: string;
    try {
      realTarget = realpathSync(ancPath);
    } catch {
      throw new HardwareRunnerError('CONFIG_INVALID', 'failed to resolve OS root symlink target', '/casDir');
    }
    const targetParent = dirname(realTarget);
    if (targetParent !== realTarget) {
      assertTrustedAncestorStatSync(lstatSync(targetParent), targetParent, myUid);
    }
    assertTrustedAncestorStatSync(lstatSync(realTarget), realTarget, myUid);
    return true;
  }
  assertTrustedAncestorStatSync(st, ancPath, myUid);
  return true;
}

async function verifyAndTightenCreatedDir(
  targetPath: string,
  myUid: number | null,
  requireExact0700: boolean,
): Promise<void> {
  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
  let dirHandle: Awaited<ReturnType<typeof open>>;
  try {
    dirHandle = await open(targetPath, constants.O_RDONLY | noFollow);
  } catch {
    throw new HardwareRunnerError('CONFIG_INVALID', 'CAS directory cannot be opened without following symlinks', '/casDir');
  }
  try {
    const info = await dirHandle.stat();
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new HardwareRunnerError('CONFIG_INVALID', 'CAS path is not a regular directory', '/casDir');
    }
    if (myUid !== null && info.uid !== myUid) {
      throw new HardwareRunnerError('CONFIG_INVALID', 'CAS directory is not owned by the current user', '/casDir');
    }
    if ((info.mode & 0o022) !== 0 || (info.mode & 0o700) !== 0o700) {
      throw new HardwareRunnerError(
        'CONFIG_INVALID',
        'CAS directory must be owner-accessible and not group/world writable',
        '/casDir',
      );
    }
    if ((info.mode & 0o077) !== 0) {
      await dirHandle.chmod(0o700);
    }
    if (requireExact0700 || (info.mode & 0o077) !== 0) {
      const after = await dirHandle.stat();
      if ((after.mode & 0o777) !== 0o700) {
        throw new HardwareRunnerError('CONFIG_INVALID', 'failed to enforce 0o700 mode on CAS directory', '/casDir');
      }
    }
  } finally {
    await dirHandle.close();
  }
}

async function ensurePrivateDir(dirPath: string): Promise<void> {
  const normalized = resolve(dirPath);
  await assertNoSymlinkAncestors(normalized, { checkLeaf: true, code: 'CONFIG_INVALID', diagPath: '/casDir' });

  const myUid = typeof process.getuid === 'function' ? process.getuid() : null;
  const allSegments: string[] = [];
  let cursor = normalized;
  while (true) {
    allSegments.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  allSegments.reverse();

  const missingChain: string[] = [];
  let missingStarted = false;
  for (let idx = 0; idx < allSegments.length - 1; idx += 1) {
    const seg = allSegments[idx]!;
    if (missingStarted) {
      missingChain.push(seg);
      continue;
    }
    if (!inspectExistingAncestorSync(seg, myUid)) {
      missingStarted = true;
      missingChain.push(seg);
    }
  }

  if (missingStarted) {
    missingChain.push(normalized);
  } else {
    let leafStat: Stats | null = null;
    try {
      leafStat = lstatSync(normalized);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        throw new HardwareRunnerError('CONFIG_INVALID', 'failed to inspect CAS directory', '/casDir');
      }
    }
    if (leafStat === null) {
      missingChain.push(normalized);
    } else {
      if (leafStat.isSymbolicLink() || !leafStat.isDirectory()) {
        throw new HardwareRunnerError('CONFIG_INVALID', 'CAS path is not a regular directory', '/casDir');
      }
      if (myUid !== null && leafStat.uid !== myUid) {
        throw new HardwareRunnerError('CONFIG_INVALID', 'CAS directory is not owned by the current user', '/casDir');
      }
      if ((leafStat.mode & 0o022) !== 0 || (leafStat.mode & 0o700) !== 0o700) {
        throw new HardwareRunnerError(
          'CONFIG_INVALID',
          'CAS directory must be owner-accessible and not group/world writable',
          '/casDir',
        );
      }
    }
  }

  for (const segPath of missingChain) {
    const parentPath = dirname(segPath);
    if (!inspectExistingAncestorSync(parentPath, myUid)) {
      throw new HardwareRunnerError('CONFIG_INVALID', 'missing parent during CAS directory creation', '/casDir');
    }
    let created = false;
    try {
      await mkdir(segPath, { mode: 0o700 });
      created = true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        throw new HardwareRunnerError('CONFIG_INVALID', 'failed to create private CAS directory', '/casDir');
      }
    }
    await verifyAndTightenCreatedDir(segPath, myUid, true);
    if (created && parentPath !== segPath) {
      const parentStat = lstatSync(parentPath);
      const syncTarget = parentStat.isSymbolicLink() && isAllowedOsRootSymlink(parentPath)
        ? realpathSync(parentPath)
        : parentPath;
      assertTrustedAncestorStatSync(lstatSync(syncTarget), syncTarget, myUid);
      await syncDir(syncTarget);
    }
  }

  await verifyAndTightenCreatedDir(normalized, myUid, true);
}

async function cleanStaleTempFiles(dirPath: string): Promise<void> {
  const dir = await opendir(dirPath);
  try {
    for await (const dirent of dir) {
      if (!dirent.name.startsWith('.tmp-')) continue;
      const target = join(dirPath, dirent.name);
      const st = await lstat(target).catch(() => null);
      if (st !== null && !st.isSymbolicLink() && st.isFile()) {
        await unlink(target).catch(() => {});
      }
    }
  } finally {
    await dir.close().catch(() => {});
  }
}

async function waitForDrainOrClose(res: ServerResponse, signal: AbortSignal): Promise<boolean> {
  if (res.destroyed || res.writableEnded || signal.aborted) return false;
  return new Promise<boolean>(resolveWait => {
    const cleanup = () => {
      res.removeListener('drain', onDrain);
      res.removeListener('close', onClose);
      res.removeListener('error', onClose);
      signal.removeEventListener('abort', onClose);
    };
    const onDrain = () => {
      cleanup();
      resolveWait(!res.destroyed && !res.writableEnded && !signal.aborted);
    };
    const onClose = () => {
      cleanup();
      resolveWait(false);
    };
    res.once('drain', onDrain);
    res.once('close', onClose);
    res.once('error', onClose);
    signal.addEventListener('abort', onClose, { once: true });
  });
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  if (res.headersSent || res.destroyed || res.writableEnded) return;
  const bytes = Buffer.from(canonicalJson(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(bytes.byteLength),
    ...(status === 413 ? { connection: 'close' } : {}),
    ...extraHeaders,
  });
  res.end(bytes);
}

function sendError(res: ServerResponse, scrubber: SecretScrubber, status: number, code: string, message: string): void {
  const safeMessage = scrubber.scrub(message);
  sendJson(res, status, {
    code,
    error: { code, message: safeMessage },
  });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HardwareRunnerError('ARTIFACT_INVALID', 'malformed URI component');
  }
}

interface ActiveOperationEntry {
  readonly request: BenchmarkRequest;
  readonly requestCanonical: string;
  readonly frozenInputs: ReadonlyMap<string, number>;
}

interface CachedTerminalOperation {
  readonly operationId: string;
  readonly verdict: BenchmarkVerdict;
  readonly verdictCanonical: string;
  readonly request: BenchmarkRequest | null;
  readonly requestCanonical: string | null;
  readonly frozenInputs: ReadonlyMap<string, number> | null;
  readonly committedOutputs: ReadonlyMap<string, number>;
  linkedOnDisk: boolean;
  durableOnDisk: boolean;
}

type DiskOperationResolution =
  | { readonly kind: 'terminal'; readonly entry: CachedTerminalOperation }
  | { readonly kind: 'descriptor_only'; readonly request: BenchmarkRequest; readonly requestCanonical: string }
  | { readonly kind: 'absent' };

const ACTIVE_CAS_DIR_LOCKS = new Set<string>();

export async function startRelayServer(options: RelayServerOptions): Promise<RelayServerHandle> {
  const config = normalizeRelayServerConfig(options);

  const casLockPath = join(config.casDir, '.relay.lock');
  const blobsDir = join(config.casDir, 'blobs');
  const sha256Dir = join(blobsDir, 'sha256');
  const tmpDir = join(config.casDir, 'tmp');
  const receiptsDir = join(config.casDir, 'receipts');
  const operationsDir = join(config.casDir, 'operations');

  await ensurePrivateDir(config.casDir);

  // Register Relay credentials into SecretScrubber and derive scan overlap from longest encoded form.
  const secretScrubber = new SecretScrubber();
  const registeredSecrets: string[] = [config.controllerSigningSecret, ...config.workerTokens];
  if (config.controllerAuthToken !== undefined) {
    registeredSecrets.push(config.controllerAuthToken);
  }
  for (const sec of registeredSecrets) {
    secretScrubber.register(sec);
  }
  const secretOverlapBytes = computeSecretScanOverlapBytes(registeredSecrets);

  const stagedInputBlobsByOperation = new Map<string, Map<string, number>>();
  const activeOperations = new Map<string, ActiveOperationEntry>();
  const terminalCache = new Map<string, CachedTerminalOperation>();
  const undurableTerminalByOperation = new Map<string, CachedTerminalOperation>();
  const inFlightReceiptWrites = new Map<string, Promise<void>>();
  const inFlightByOperation = new Map<string, Promise<void>>();
  const activeDurabilityTasks = new Set<Promise<void>>();
  const activeRequestTasks = new Set<Promise<void>>();
  const jobCompletionChains = new Map<string, Promise<void>>();
  const admissionChains = new Map<string, Promise<void>>();
  const openSockets = new Set<Socket>();
  const serverAbort = new AbortController();
  let casLockDb: DatabaseSync | null = null;
  let casLockInodeKey: string | null = null;

  const recordRecoveryFenceStrict = (operationId: string, reason: string): void => {
    if (casLockDb === null) {
      throw new HardwareRunnerError('QUEUE_STATE_INVALID', 'CAS lock database unavailable for recovery fence');
    }
    options.onBeforeFenceUpdate?.(operationId, reason);
    casLockDb
      .prepare(
        'INSERT OR REPLACE INTO recovery_fence (operation_id, reason, created_at_ms) VALUES (?, ?, ?)',
      )
      .run(operationId, reason, Date.now());
  };

  const recordRecoveryFence = (operationId: string, reason: string): void => {
    if (casLockDb === null) return;
    try {
      options.onBeforeFenceUpdate?.(operationId, reason);
      casLockDb
        .prepare(
          'INSERT OR REPLACE INTO recovery_fence (operation_id, reason, created_at_ms) VALUES (?, ?, ?)',
        )
        .run(operationId, reason, Date.now());
    } catch {
      // Pre-admission recovery_fence row is already persisted on disk before work begins;
      // shutdown also propagates persistence errors and fails closed.
    }
  };

  const clearRecoveryFence = (operationId: string): void => {
    if (casLockDb === null) return;
    try {
      casLockDb.prepare('DELETE FROM recovery_fence WHERE operation_id = ?').run(operationId);
    } catch {
      // Ignore cleanup errors if lock database is already closing.
    }
  };

  const withSerialLock = async <T>(
    map: Map<string, Promise<void>>,
    key: string,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const prev = map.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(r => {
      release = r;
    });
    const chained = prev.catch(() => {}).then(() => gate);
    map.set(key, chained);
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (map.get(key) === chained) {
        map.delete(key);
      }
    }
  };

  const withAdmissionLock = <T>(fn: () => Promise<T>): Promise<T> =>
    withSerialLock(admissionChains, '__global_admission__', fn);

  let maxRetainedTerminalOps = Math.max(4_096, config.maxJobs * 16);
  if (config.maxRetainedTerminalOps !== undefined) {
    maxRetainedTerminalOps = config.maxRetainedTerminalOps;
  }

  const countRetainedTerminalEntries = (): number => {
    let uniqueCount = terminalCache.size;
    for (const opId of undurableTerminalByOperation.keys()) {
      if (!terminalCache.has(opId)) uniqueCount += 1;
    }
    return uniqueCount;
  };

  const putBoundedTerminalCache = (entry: CachedTerminalOperation): void => {
    terminalCache.delete(entry.operationId);
    terminalCache.set(entry.operationId, entry);
    while (countRetainedTerminalEntries() > maxRetainedTerminalOps && terminalCache.size > 0) {
      let evictKey: string | undefined;
      for (const candidateKey of terminalCache.keys()) {
        if (!undurableTerminalByOperation.has(candidateKey)) {
          evictKey = candidateKey;
          break;
        }
      }
      if (evictKey === undefined) break;
      terminalCache.delete(evictKey);
    }
  };

  const buildTerminalEntry = (
    verdict: BenchmarkVerdict,
    request: BenchmarkRequest | null,
    flags: { readonly linkedOnDisk: boolean; readonly durableOnDisk: boolean },
  ): CachedTerminalOperation => {
    const committedOutputs = new Map<string, number>();
    for (const art of verdict.outputArtifacts ?? []) {
      committedOutputs.set(art.digest.hex, art.byteLength);
    }
    let frozenInputs: Map<string, number> | null = null;
    if (request !== null) {
      frozenInputs = new Map<string, number>();
      for (const item of collectDeclaredInputBlobs(request.candidateArtifacts)) {
        frozenInputs.set(item.digest.hex, item.byteLength);
      }
    }
    return {
      operationId: verdict.operationId,
      verdict,
      verdictCanonical: canonicalJson(verdict),
      request,
      requestCanonical: request !== null ? canonicalJson(request) : null,
      frozenInputs,
      committedOutputs,
      linkedOnDisk: flags.linkedOnDisk,
      durableOnDisk: flags.durableOnDisk,
    };
  };

  const recordCommittedTerminalTransition = (
    verdict: BenchmarkVerdict,
    flags: { readonly linkedOnDisk: boolean; readonly durableOnDisk: boolean },
  ): CachedTerminalOperation => {
    const vCanonical = canonicalJson(verdict);
    const existing = undurableTerminalByOperation.get(verdict.operationId) ?? terminalCache.get(verdict.operationId);
    if (existing !== undefined && existing.verdictCanonical === vCanonical) {
      if (flags.linkedOnDisk) existing.linkedOnDisk = true;
      if (flags.durableOnDisk) existing.durableOnDisk = true;
      if (existing.durableOnDisk) {
        undurableTerminalByOperation.delete(verdict.operationId);
      } else {
        undurableTerminalByOperation.set(verdict.operationId, existing);
      }
      activeOperations.delete(verdict.operationId);
      putBoundedTerminalCache(existing);
      return existing;
    }

    const active = activeOperations.get(verdict.operationId);
    activeOperations.delete(verdict.operationId);
    const entry = buildTerminalEntry(verdict, active?.request ?? null, flags);
    if (!entry.durableOnDisk) {
      undurableTerminalByOperation.set(verdict.operationId, entry);
    }
    putBoundedTerminalCache(entry);
    return entry;
  };

  const assertVerdictPublishable = (verdict: BenchmarkVerdict): string => {
    const canonical = canonicalJson(verdict);
    if (Buffer.byteLength(canonical, 'utf8') > MAX_CONTROL_BODY_BYTES) {
      throw new HardwareRunnerError('PAYLOAD_TOO_LARGE', `benchmark_verdict exceeds ${MAX_CONTROL_BODY_BYTES} bytes`);
    }
    if (secretScrubber.containsSecret(canonical)) {
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'completion verdict rejected by SecretScrubber');
    }
    return canonical;
  };

  const stageSignedVerdictReceiptTemp = async (
    verdict: BenchmarkVerdict,
  ): Promise<{ readonly operationId: string; readonly tmpReceiptPath: string; readonly finalReceiptPath: string; readonly receiptBytes: Buffer }> => {
    const operationId = parseOperationId(verdict.operationId, '/operationId');
    const verdictCanonical = assertVerdictPublishable(verdict);
    await assertNoSymlinkAncestors(receiptsDir, { checkLeaf: true, code: 'ARTIFACT_INVALID', diagPath: '/receipts' });
    const signature = signRelayPayload(config.controllerSigningSecret, verdictCanonical);
    const receiptObj: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(verdict)) {
      const val = (verdict as unknown as Record<string, unknown>)[key];
      if (val !== undefined) receiptObj[key] = val;
    }
    receiptObj.signature = signature;
    const receiptBytes = Buffer.from(canonicalJson(receiptObj), 'utf8');
    if (receiptBytes.byteLength > MAX_RECEIPT_FILE_BYTES) {
      throw new HardwareRunnerError('PAYLOAD_TOO_LARGE', `signed receipt exceeds ${MAX_RECEIPT_FILE_BYTES} bytes`);
    }

    const tmpReceiptPath = join(receiptsDir, `.tmp-${operationId}-${randomBytes(8).toString('hex')}.json`);
    const finalReceiptPath = join(receiptsDir, `${operationId}.json`);
    const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
    const handle = await open(
      tmpReceiptPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
      0o600,
    );
    let closed = false;
    try {
      await writeAllToFileHandle(handle, receiptBytes);
      await handle.sync();
      await handle.close();
      closed = true;
      return { operationId, tmpReceiptPath, finalReceiptPath, receiptBytes };
    } catch (err) {
      if (!closed) await handle.close().catch(() => {});
      await unlink(tmpReceiptPath).catch(() => {});
      throw err;
    }
  };

  const ensureReceiptDurable = (verdict: BenchmarkVerdict): Promise<void> => {
    const operationId = verdict.operationId;
    const vCanonical = canonicalJson(verdict);
    const writeKey = `${operationId}\0${vCanonical}`;

    const cached = undurableTerminalByOperation.get(operationId) ?? terminalCache.get(operationId);
    if (cached !== undefined && cached.verdictCanonical === vCanonical && cached.durableOnDisk) {
      putBoundedTerminalCache(cached);
      return Promise.resolve();
    }

    const existingTask = inFlightReceiptWrites.get(writeKey);
    if (existingTask !== undefined) {
      return existingTask;
    }

    // If the operation already left activeOperations and is not in undurableTerminalByOperation,
    // it was previously settled and evicted from terminalCache; reload full receipt + descriptor from disk.
    if (!activeOperations.has(operationId) && !undurableTerminalByOperation.has(operationId)) {
      const reloadTask = (async () => {
        const resolved = await resolveDiskOperationState(operationId);
        if (resolved.kind !== 'terminal' || resolved.entry.verdictCanonical !== vCanonical) {
          throw new Error('evicted terminal receipt missing or mismatched on disk');
        }
      })().finally(() => {
        if (inFlightReceiptWrites.get(writeKey) === reloadTask) {
          inFlightReceiptWrites.delete(writeKey);
        }
        activeDurabilityTasks.delete(reloadTask);
      });
      inFlightReceiptWrites.set(writeKey, reloadTask);
      activeDurabilityTasks.add(reloadTask);
      return reloadTask;
    }

    const entry = recordCommittedTerminalTransition(verdict, { linkedOnDisk: false, durableOnDisk: false });
    const task = (async () => {
      try {
        if (options.onBeforeReceiptPersist !== undefined) {
          await options.onBeforeReceiptPersist(operationId);
        }
        const finalReceiptPath = join(receiptsDir, `${operationId}.json`);
        if (!entry.linkedOnDisk) {
          const existingBytes = await readRecordFileOrNull(finalReceiptPath, MAX_RECEIPT_FILE_BYTES, 'runtime');
          if (existingBytes !== null) {
            let parsedExisting: BenchmarkVerdict;
            try {
              parsedExisting = parseAuthenticatedReceiptBytes(
                existingBytes,
                operationId,
                config.controllerSigningSecret,
                config.maxBlobBytes,
                secretScrubber,
              );
            } catch (parseErr) {
              throw new Error('corrupted persisted receipt on disk', { cause: parseErr });
            }
            if (canonicalJson(parsedExisting) !== vCanonical) {
              throw new Error('conflicting durable receipt already exists on disk');
            }
            entry.linkedOnDisk = true;
          } else {
            const staged = await stageSignedVerdictReceiptTemp(verdict);
            try {
              linkSync(staged.tmpReceiptPath, staged.finalReceiptPath);
              entry.linkedOnDisk = true;
            } catch (linkErr: unknown) {
              await unlink(staged.tmpReceiptPath).catch(() => {});
              if ((linkErr as NodeJS.ErrnoException)?.code === 'EEXIST') {
                const racedBytes = await readRecordFileOrNull(finalReceiptPath, MAX_RECEIPT_FILE_BYTES, 'runtime');
                if (racedBytes === null) {
                  throw linkErr;
                }
                let racedVerdict: BenchmarkVerdict;
                try {
                  racedVerdict = parseAuthenticatedReceiptBytes(
                    racedBytes,
                    operationId,
                    config.controllerSigningSecret,
                    config.maxBlobBytes,
                    secretScrubber,
                  );
                } catch (parseErr) {
                  throw new Error('corrupted persisted receipt after EEXIST', { cause: parseErr });
                }
                if (canonicalJson(racedVerdict) !== vCanonical) {
                  throw new Error('conflicting durable receipt already exists after EEXIST', { cause: linkErr });
                }
                entry.linkedOnDisk = true;
              } else {
                throw linkErr;
              }
            }
            await unlink(staged.tmpReceiptPath).catch(() => {});
          }
        }
        await syncDir(receiptsDir);
        entry.durableOnDisk = true;
        undurableTerminalByOperation.delete(operationId);
        clearRecoveryFence(operationId);
        putBoundedTerminalCache(entry);
      } catch (persistErr: unknown) {
        recordRecoveryFence(operationId, 'receipt_persistence_failed');
        throw persistErr;
      }
    })().finally(() => {
      if (inFlightReceiptWrites.get(writeKey) === task) {
        inFlightReceiptWrites.delete(writeKey);
      }
      if (inFlightByOperation.get(operationId) === task) {
        inFlightByOperation.delete(operationId);
      }
      activeDurabilityTasks.delete(task);
    });

    inFlightReceiptWrites.set(writeKey, task);
    inFlightByOperation.set(operationId, task);
    activeDurabilityTasks.add(task);
    return task;
  };

  const persistOperationRequestRecord = async (request: BenchmarkRequest): Promise<void> => {
    const operationId = parseOperationId(request.operationId, '/operationId');
    await assertNoSymlinkAncestors(operationsDir, { checkLeaf: true, code: 'ARTIFACT_INVALID', diagPath: '/operations' });
    const finalOpPath = join(operationsDir, `${operationId}.json`);
    const reqCanonical = canonicalJson(request);

    const checkExistingOperationBytes = async (rawBytes: Buffer): Promise<void> => {
      let existingReq: BenchmarkRequest;
      try {
        existingReq = parseAuthenticatedOperationBytes(
          rawBytes,
          operationId,
          config.controllerSigningSecret,
          config.maxBlobBytes,
        );
      } catch (parseErr) {
        throw new Error('corrupted persisted operation descriptor', { cause: parseErr });
      }
      if (canonicalJson(existingReq) !== reqCanonical) {
        throw new HardwareRunnerError('QUEUE_JOB_CONFLICT', 'conflicting durable operation record exists');
      }
      await syncDir(operationsDir);
    };

    const existingBytes = await readRecordFileOrNull(finalOpPath, MAX_OPERATION_FILE_BYTES, 'runtime');
    if (existingBytes !== null) {
      await checkExistingOperationBytes(existingBytes);
      return;
    }

    const signature = signRelayPayload(config.controllerSigningSecret, `REQ\n${reqCanonical}`);
    const recordBytes = Buffer.from(
      canonicalJson({
        version: 1,
        kind: 'benchmark_operation_request',
        request,
        signature,
      }),
      'utf8',
    );
    const tmpOpPath = join(operationsDir, `.tmp-${operationId}-${randomBytes(8).toString('hex')}.json`);
    const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
    const handle = await open(
      tmpOpPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
      0o600,
    );
    let closed = false;
    try {
      await writeAllToFileHandle(handle, recordBytes);
      await handle.sync();
      await handle.close();
      closed = true;
      try {
        linkSync(tmpOpPath, finalOpPath);
      } catch (linkErr: unknown) {
        await unlink(tmpOpPath).catch(() => {});
        if ((linkErr as NodeJS.ErrnoException)?.code === 'EEXIST') {
          const racedBytes = await readRecordFileOrNull(finalOpPath, MAX_OPERATION_FILE_BYTES, 'runtime');
          if (racedBytes === null) {
            throw linkErr;
          }
          await checkExistingOperationBytes(racedBytes);
          return;
        }
        throw linkErr;
      }
      await unlink(tmpOpPath).catch(() => {});
      await syncDir(operationsDir);
    } catch (err) {
      if (!closed) await handle.close().catch(() => {});
      await unlink(tmpOpPath).catch(() => {});
      throw err;
    }
  };

  const resolveDiskOperationState = async (operationId: string): Promise<DiskOperationResolution> => {
    const memTerminal = undurableTerminalByOperation.get(operationId) ?? terminalCache.get(operationId);
    if (memTerminal !== undefined) {
      if (memTerminal.durableOnDisk) {
        putBoundedTerminalCache(memTerminal);
      }
      return { kind: 'terminal', entry: memTerminal };
    }

    const receiptPath = join(receiptsDir, `${operationId}.json`);
    const opPath = join(operationsDir, `${operationId}.json`);
    const receiptBytes = await readRecordFileOrNull(receiptPath, MAX_RECEIPT_FILE_BYTES, 'runtime');
    const opBytes = await readRecordFileOrNull(opPath, MAX_OPERATION_FILE_BYTES, 'runtime');

    let diskVerdict: BenchmarkVerdict | null = null;
    if (receiptBytes !== null) {
      try {
        diskVerdict = parseAuthenticatedReceiptBytes(
          receiptBytes,
          operationId,
          config.controllerSigningSecret,
          config.maxBlobBytes,
          secretScrubber,
        );
      } catch (err) {
        throw new Error('corrupted persisted receipt record', { cause: err });
      }
    }

    let diskRequest: BenchmarkRequest | null = null;
    if (opBytes !== null) {
      try {
        diskRequest = parseAuthenticatedOperationBytes(
          opBytes,
          operationId,
          config.controllerSigningSecret,
          config.maxBlobBytes,
        );
      } catch (err) {
        throw new Error('corrupted persisted operation descriptor', { cause: err });
      }
    }

    if (diskVerdict !== null) {
      if (diskRequest !== null && !verdictMatchesRequestBinding(diskVerdict, diskRequest)) {
        throw new Error('persisted receipt and operation descriptor binding mismatch');
      }
      if (diskRequest !== null) {
        await syncDir(operationsDir);
      }
      await syncDir(receiptsDir);
      const entry = buildTerminalEntry(diskVerdict, diskRequest, {
        linkedOnDisk: true,
        durableOnDisk: true,
      });
      putBoundedTerminalCache(entry);
      return { kind: 'terminal', entry };
    }

    if (diskRequest !== null) {
      await syncDir(operationsDir);
      return {
        kind: 'descriptor_only',
        request: diskRequest,
        requestCanonical: canonicalJson(diskRequest),
      };
    }

    return { kind: 'absent' };
  };

  const hasCasBlobOnDisk = async (sha256: string): Promise<boolean> => {
    const st = await lstat(join(sha256Dir, sha256)).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw err;
    });
    return st !== null;
  };

  const verifyExistingCasBlob = async (
    sha256: string,
    expectedLength: number,
    verifyOptions: { readonly scrubSecrets?: boolean; readonly missingCode?: HardwareRunnerErrorCode } = {},
  ): Promise<void> => {
    const blobPath = join(sha256Dir, sha256);
    await assertNoSymlinkAncestors(blobPath, { checkLeaf: true, code: 'ARTIFACT_INVALID', diagPath: '/blob' });
    const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(blobPath, constants.O_RDONLY | noFollow);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT' && verifyOptions.missingCode !== undefined) {
        throw new HardwareRunnerError(verifyOptions.missingCode, `CAS blob ${sha256} is not staged`);
      }
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'CAS blob could not be opened safely');
    }
    try {
      const st = await handle.stat();
      if (
        !st.isFile()
        || st.isSymbolicLink()
        || st.nlink !== 1
        || (typeof process.getuid === 'function' && st.uid !== process.getuid())
        || (st.mode & 0o777) !== 0o400
        || st.size !== expectedLength
      ) {
        throw new HardwareRunnerError('ARTIFACT_INVALID', 'existing CAS blob failed inode/0o400/size verification');
      }
      const hasher = createHash('sha256');
      let scanTail: Buffer = Buffer.alloc(0);
      const buf = Buffer.allocUnsafe(Math.min(MAX_CAS_CHUNK_BYTES, Math.max(1, st.size)));
      let offset = 0;
      while (offset < st.size) {
        const maxStep = verifyOptions.scrubSecrets === true
          ? MAX_CAS_CHUNK_BYTES - scanTail.byteLength
          : buf.byteLength;
        const toRead = Math.min(maxStep, buf.byteLength, st.size - offset);
        const { bytesRead } = await handle.read(buf, 0, toRead, offset);
        if (bytesRead <= 0) break;
        const slice = buf.subarray(0, bytesRead);
        if (verifyOptions.scrubSecrets === true) {
          const windowBuf = scanTail.byteLength === 0 ? slice : Buffer.concat([scanTail, slice]);
          if (
            secretScrubber.containsSecret(windowBuf.toString('latin1'))
            || secretScrubber.containsSecret(windowBuf.toString('utf8'))
          ) {
            throw new HardwareRunnerError('ARTIFACT_INVALID', 'output blob rejected by SecretScrubber');
          }
          scanTail = windowBuf.byteLength > secretOverlapBytes
            ? Buffer.from(windowBuf.subarray(windowBuf.byteLength - secretOverlapBytes))
            : Buffer.from(windowBuf);
        }
        hasher.update(slice);
        offset += bytesRead;
      }
      const after = await handle.stat();
      if (
        offset !== st.size
        || after.ino !== st.ino
        || after.dev !== st.dev
        || after.size !== st.size
        || (after.mode & 0o777) !== 0o400
        || after.nlink !== 1
        || hasher.digest('hex') !== sha256
      ) {
        throw new HardwareRunnerError('ARTIFACT_INVALID', 'existing CAS blob failed sha256 verification');
      }
    } finally {
      await handle.close();
    }
  };

  const ingestStreamedCasBlob = async (
    req: IncomingMessage,
    sha256: string,
    expectedLength: number,
    optionsIngest: { readonly scrubSecrets: boolean },
  ): Promise<{ readonly created: boolean }> => {
    await assertNoSymlinkAncestors(sha256Dir, { checkLeaf: true, code: 'ARTIFACT_INVALID', diagPath: '/casDir' });
    await assertNoSymlinkAncestors(tmpDir, { checkLeaf: true, code: 'ARTIFACT_INVALID', diagPath: '/casDir' });

    const tmpPath = join(tmpDir, `.tmp-${randomBytes(16).toString('hex')}`);
    const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
    const tmpHandle = await open(
      tmpPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
      0o600,
    );
    let tmpClosed = false;
    let tmpUnlinked = false;
    const hasher = createHash('sha256');
    let receivedBytes = 0;
    let scanTail: Buffer = Buffer.alloc(0);

    try {
      for await (const rawChunk of req) {
        const buf = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
        let offset = 0;
        while (offset < buf.byteLength) {
          const maxSliceBytes = optionsIngest.scrubSecrets
            ? MAX_CAS_CHUNK_BYTES - scanTail.byteLength
            : MAX_CAS_CHUNK_BYTES;
          const slice = buf.subarray(offset, Math.min(buf.byteLength, offset + maxSliceBytes));
          if (slice.byteLength === 0) break;
          offset += slice.byteLength;
          receivedBytes += slice.byteLength;
          if (receivedBytes > config.maxBlobBytes) {
            throw new HardwareRunnerError('PAYLOAD_TOO_LARGE', `blob exceeds maxBlobBytes (${config.maxBlobBytes})`);
          }
          if (receivedBytes > expectedLength) {
            throw new HardwareRunnerError('ARTIFACT_INVALID', 'streamed blob exceeded declared x-loopwright-blob-length');
          }
          if (optionsIngest.scrubSecrets) {
            const windowBuf = scanTail.byteLength === 0 ? slice : Buffer.concat([scanTail, slice]);
            if (
              secretScrubber.containsSecret(windowBuf.toString('latin1'))
              || secretScrubber.containsSecret(windowBuf.toString('utf8'))
            ) {
              throw new HardwareRunnerError('ARTIFACT_INVALID', 'output blob rejected by SecretScrubber');
            }
            scanTail = windowBuf.byteLength > secretOverlapBytes
              ? Buffer.from(windowBuf.subarray(windowBuf.byteLength - secretOverlapBytes))
              : Buffer.from(windowBuf);
          }
          hasher.update(slice);
          await writeAllToFileHandle(tmpHandle, slice);
        }
      }

      if (receivedBytes !== expectedLength) {
        throw new HardwareRunnerError('ARTIFACT_INVALID', 'streamed blob shorter than declared x-loopwright-blob-length');
      }
      const observedHex = hasher.digest('hex');
      if (observedHex !== sha256) {
        throw new HardwareRunnerError('ARTIFACT_INVALID', 'streamed blob sha256 mismatch');
      }

      await tmpHandle.chmod(0o400);
      await tmpHandle.sync();
      const tmpStat = await tmpHandle.stat();
      if (!tmpStat.isFile() || tmpStat.isSymbolicLink() || tmpStat.nlink !== 1 || (tmpStat.mode & 0o777) !== 0o400) {
        throw new HardwareRunnerError('ARTIFACT_INVALID', 'sealed temp blob failed stat verification');
      }
      await tmpHandle.close();
      tmpClosed = true;

      const finalPath = join(sha256Dir, sha256);
      let linked = false;
      try {
        linkSync(tmpPath, finalPath);
        linked = true;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
      }

      // Drop the temp directory entry synchronously right after linkSync so concurrent Relay
      // requests staging or reading the same content-addressed blob never observe transient nlink === 2.
      try {
        unlinkSync(tmpPath);
        tmpUnlinked = true;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
          tmpUnlinked = true;
        } else if (!linked) {
          throw err;
        }
      }

      if (linked) {
        if (!tmpUnlinked) {
          await unlink(tmpPath);
          tmpUnlinked = true;
        }
        await syncDir(sha256Dir);
        await verifyExistingCasBlob(sha256, expectedLength);
        return { created: true };
      }

      for (let attempt = 0; attempt < 50; attempt += 1) {
        const st = await lstat(finalPath).catch(() => null);
        if (!st || st.isSymbolicLink() || !st.isFile() || st.nlink <= 1) break;
        await new Promise(r => setTimeout(r, 10));
      }
      await verifyExistingCasBlob(sha256, expectedLength, { scrubSecrets: optionsIngest.scrubSecrets });
      await syncDir(sha256Dir);
      return { created: false };
    } finally {
      if (!tmpClosed) await tmpHandle.close().catch(() => {});
      if (!tmpUnlinked) await unlink(tmpPath).catch(() => {});
    }
  };

  const streamCasBlobResponse = async (
    res: ServerResponse,
    sha256: string,
    expectedLength: number,
    extraHeaders: Readonly<Record<string, string>>,
  ): Promise<void> => {
    const blobPath = join(sha256Dir, sha256);
    await assertNoSymlinkAncestors(blobPath, { checkLeaf: true, code: 'ARTIFACT_INVALID', diagPath: '/blob' });
    const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(blobPath, constants.O_RDONLY | noFollow);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw new HardwareRunnerError('NOT_FOUND', 'CAS blob file missing');
      }
      throw new HardwareRunnerError('ARTIFACT_INVALID', 'CAS blob failed O_NOFOLLOW open');
    }
    try {
      const before = await handle.stat();
      if (
        !before.isFile()
        || before.isSymbolicLink()
        || before.nlink !== 1
        || (typeof process.getuid === 'function' && before.uid !== process.getuid())
        || (before.mode & 0o777) !== 0o400
        || before.size !== expectedLength
      ) {
        throw new HardwareRunnerError('ARTIFACT_INVALID', 'CAS blob failed O_NOFOLLOW/nlink/0o400 check');
      }
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(before.size),
        'x-loopwright-blob-sha256': sha256,
        'x-loopwright-blob-length': String(before.size),
        ...extraHeaders,
      });
      const buf = Buffer.allocUnsafe(Math.min(MAX_CAS_CHUNK_BYTES, Math.max(1, before.size)));
      let offset = 0;
      while (offset < before.size) {
        if (res.destroyed || res.writableEnded || serverAbort.signal.aborted) return;
        const { bytesRead } = await handle.read(buf, 0, Math.min(buf.byteLength, before.size - offset), offset);
        if (bytesRead <= 0) break;
        offset += bytesRead;
        const canContinue = res.write(buf.subarray(0, bytesRead));
        if (!canContinue) {
          const ok = await waitForDrainOrClose(res, serverAbort.signal);
          if (!ok) return;
        }
      }
      if (res.destroyed || res.writableEnded) return;
      const after = await handle.stat();
      if (
        offset !== before.size
        || after.ino !== before.ino
        || after.dev !== before.dev
        || after.size !== before.size
        || after.nlink !== 1
        || (after.mode & 0o777) !== 0o400
      ) {
        res.destroy();
        return;
      }
      res.end();
    } finally {
      await handle.close();
    }
  };

  const queue = new RelayPullQueue({
    leaseTtlMs: config.leaseTtlMs,
    sweepIntervalMs: config.sweepIntervalMs,
    verdictTtlMs: config.verdictTtlMs,
    maxJobs: config.maxJobs,
    ...(config.maxRetainedTerminalOps !== undefined ? { maxRetainedTerminalOps: config.maxRetainedTerminalOps } : {}),
    ...(options.clock !== undefined ? { clock: options.clock } : {}),
    onTerminalVerdict: verdict => {
      if (verdict.status === 'expired') {
        void ensureReceiptDurable(verdict).catch(() => {});
      }
    },
  });

  let server: HttpServer | HttpsServer | null = null;
  let scheme: 'http' | 'https' = 'http';

  const releaseCasLock = async (strict: boolean): Promise<void> => {
    const db = casLockDb;
    const inodeKey = casLockInodeKey;
    casLockDb = null;
    casLockInodeKey = null;
    let hasCloseErr = false;
    let closeErr: unknown;
    if (db !== null) {
      try {
        db.close();
      } catch (err: unknown) {
        hasCloseErr = true;
        closeErr = err;
      }
    }
    if (inodeKey !== null) {
      ACTIVE_CAS_DIR_LOCKS.delete(inodeKey);
    }
    if (strict && hasCloseErr) {
      throw closeErr;
    }
  };

  try {
    // 0. Establish process-lifetime exclusive CAS ownership (filesystem-identity dev:ino registry +
    //    OS kernel SQLite EXCLUSIVE lock) BEFORE any subdir creation, temp cleanup, recovery scan, or listen().
    const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
    const myUid = typeof process.getuid === 'function' ? process.getuid() : null;
    const casDirStat = statSync(config.casDir);
    const dirInodeKey = `${casDirStat.dev}:${casDirStat.ino}`;
    if (ACTIVE_CAS_DIR_LOCKS.has(dirInodeKey)) {
      throw new HardwareRunnerError(
        'QUEUE_STATE_INVALID',
        `CAS directory "${config.casDir}" is already locked by an active Relay instance`,
        '/casDir',
      );
    }
    ACTIVE_CAS_DIR_LOCKS.add(dirInodeKey);
    casLockInodeKey = dirInodeKey;

    // Inspect .relay.lock via lstat ONLY (never open/close an existing SQLite lockfile fd, which can cancel
    // POSIX fcntl locks on the same inode!). Only create with O_CREAT|O_EXCL when ENOENT, before DatabaseSync opens.
    let lockFileCreated = false;
    let existingLockStat: Stats | null = null;
    try {
      existingLockStat = await lstat(casLockPath);
    } catch (statErr: unknown) {
      if ((statErr as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        throw new HardwareRunnerError('CONFIG_INVALID', 'failed to inspect CAS lock file', '/casDir', { cause: statErr });
      }
    }
    if (existingLockStat === null) {
      try {
        const fh = await open(
          casLockPath,
          constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollow,
          0o600,
        );
        await fh.close();
        lockFileCreated = true;
      } catch (createErr: unknown) {
        if ((createErr as NodeJS.ErrnoException)?.code !== 'EEXIST') {
          throw new HardwareRunnerError('CONFIG_INVALID', 'failed to initialize CAS lock file', '/casDir', { cause: createErr });
        }
        existingLockStat = await lstat(casLockPath).catch(() => null);
      }
    }
    if (existingLockStat !== null) {
      if (!existingLockStat.isFile() || existingLockStat.isSymbolicLink() || (myUid !== null && existingLockStat.uid !== myUid)) {
        throw new HardwareRunnerError('CONFIG_INVALID', 'CAS lock file violates regular-file ownership invariants', '/casDir');
      }
      if ((existingLockStat.mode & 0o077) !== 0) {
        await chmod(casLockPath, 0o600);
        const tightenedStat = await lstat(casLockPath);
        if (!tightenedStat.isFile() || tightenedStat.isSymbolicLink() || (tightenedStat.mode & 0o077) !== 0) {
          throw new HardwareRunnerError('CONFIG_INVALID', 'failed to tighten CAS lock file permissions', '/casDir');
        }
      }
    }
    if (lockFileCreated) {
      await syncDir(config.casDir);
    }

    let db: DatabaseSync;
    try {
      db = new DatabaseSync(casLockPath);
    } catch (openErr: unknown) {
      throw new HardwareRunnerError('CONFIG_INVALID', 'failed to open exclusive CAS lock database', '/casDir', { cause: openErr });
    }
    casLockDb = db;
    try {
      db.exec('PRAGMA busy_timeout = 0;');
      db.exec('PRAGMA journal_mode = DELETE;');
      db.exec('PRAGMA locking_mode = EXCLUSIVE;');
      db.exec('BEGIN EXCLUSIVE;');
      db.exec(
        'CREATE TABLE IF NOT EXISTS relay_lock (id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER NOT NULL, relay_boot_id TEXT NOT NULL, acquired_at_ms INTEGER NOT NULL);',
      );
      db.exec(
        'CREATE TABLE IF NOT EXISTS recovery_fence (operation_id TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at_ms INTEGER NOT NULL);',
      );
      db.prepare(
        'INSERT OR REPLACE INTO relay_lock (id, pid, relay_boot_id, acquired_at_ms) VALUES (1, ?, ?, ?)',
      ).run(process.pid, queue.relayBootId, Date.now());
      db.exec('COMMIT;');
    } catch (lockErr: unknown) {
      const msg = lockErr instanceof Error ? lockErr.message : String(lockErr);
      if (msg.includes('locked') || msg.includes('BUSY')) {
        throw new HardwareRunnerError(
          'QUEUE_STATE_INVALID',
          `CAS directory "${config.casDir}" is already locked by an active Relay instance`,
          '/casDir',
          { cause: lockErr },
        );
      }
      throw new HardwareRunnerError(
        'QUEUE_STATE_INVALID',
        `failed to acquire exclusive CAS directory lock: ${msg}`,
        '/casDir',
        { cause: lockErr },
      );
    }
    await syncDir(config.casDir);

    await ensurePrivateDir(blobsDir);
    await ensurePrivateDir(sha256Dir);
    await ensurePrivateDir(tmpDir);
    await ensurePrivateDir(receiptsDir);
    await ensurePrivateDir(operationsDir);
    await syncDir(config.casDir);
    await syncDir(blobsDir);

    await cleanStaleTempFiles(tmpDir);
    await cleanStaleTempFiles(receiptsDir);
    await cleanStaleTempFiles(operationsDir);
    await syncDir(tmpDir);
    await syncDir(sha256Dir);
    await syncDir(operationsDir);
    await syncDir(receiptsDir);

    // 0b. Fail closed with QUEUE_STATE_INVALID if a prior Relay left a fenced operation without a valid authenticated receipt.
    const fencedRows = db.prepare('SELECT operation_id FROM recovery_fence').all() as Array<{ operation_id?: unknown }>;
    for (const row of fencedRows) {
      const fencedOpId = typeof row.operation_id === 'string' ? row.operation_id : '';
      if (fencedOpId.length === 0) {
        throw new HardwareRunnerError('QUEUE_STATE_INVALID', 'corrupt recovery fence entry in CAS lock database', '/casDir');
      }
      let receiptBytes: Buffer | null;
      try {
        receiptBytes = await readRecordFileOrNull(
          join(receiptsDir, `${fencedOpId}.json`),
          MAX_RECEIPT_FILE_BYTES,
          'startup',
        );
      } catch (readErr: unknown) {
        throw new HardwareRunnerError(
          'QUEUE_STATE_INVALID',
          `CAS recovery fence active for operation "${fencedOpId}" with unreadable receipt; operator recovery required`,
          '/casDir',
          { cause: readErr },
        );
      }
      if (receiptBytes === null) {
        throw new HardwareRunnerError(
          'QUEUE_STATE_INVALID',
          `CAS recovery fence active for unflushed terminal operation "${fencedOpId}"; operator recovery required`,
          '/casDir',
        );
      }
      try {
        parseAuthenticatedReceiptBytes(
          receiptBytes,
          fencedOpId,
          config.controllerSigningSecret,
          config.maxBlobBytes,
          secretScrubber,
        );
      } catch (parseErr: unknown) {
        throw new HardwareRunnerError(
          'QUEUE_STATE_INVALID',
          `CAS recovery fence active for operation "${fencedOpId}" with invalid or unauthenticated receipt; operator recovery required`,
          '/casDir',
          { cause: parseErr },
        );
      }
      clearRecoveryFence(fencedOpId);
    }

    // 1. Stream-validate existing sealed 0o400 CAS blobs at startup without materializing directory listings.
    const blobDirStream = await opendir(sha256Dir);
    try {
      for await (const dirent of blobDirStream) {
        const name = dirent.name;
        if (name.startsWith('.tmp-')) continue;
        if (!SHA256_HEX_RE.test(name)) {
          throw new HardwareRunnerError('ARTIFACT_INVALID', 'unexpected filename in CAS blobs/sha256 directory');
        }
        const fh = await open(join(sha256Dir, name), constants.O_RDONLY | noFollow).catch(() => {
          throw new HardwareRunnerError('ARTIFACT_INVALID', 'untrusted symlink or unreadable CAS blob at startup');
        });
        try {
          const st = await fh.stat();
          if (
            !st.isFile()
            || st.isSymbolicLink()
            || st.nlink !== 1
            || (myUid !== null && st.uid !== myUid)
            || (st.mode & 0o777) !== 0o400
          ) {
            throw new HardwareRunnerError('ARTIFACT_INVALID', 'existing CAS blob violates 0o400/nlink invariants');
          }
        } finally {
          await fh.close();
        }
      }
    } finally {
      await blobDirStream.close().catch(() => {});
    }

    // 2. Stream-authenticate terminal receipts (<casDir>/receipts/*.json) with on-demand operation pairing,
    //    keeping retained in-memory caches strictly bounded by maxRetainedTerminalOps.
    const receiptDirStream = await opendir(receiptsDir);
    try {
      for await (const dirent of receiptDirStream) {
        const fileName = dirent.name;
        if (fileName.startsWith('.tmp-')) continue;
        if (!fileName.endsWith('.json')) {
          throw new HardwareRunnerError('ARTIFACT_INVALID', 'unexpected file in CAS receipts directory');
        }
        const opId = parseOperationId(fileName.slice(0, -5), '/receipts');
        const rawBytes = await readRequiredStartupRecord(join(receiptsDir, fileName), MAX_RECEIPT_FILE_BYTES);
        const verdict = parseAuthenticatedReceiptBytes(
          rawBytes,
          opId,
          config.controllerSigningSecret,
          config.maxBlobBytes,
          secretScrubber,
        );

        let matchedReq: BenchmarkRequest | null = null;
        const opBytes = await readRecordFileOrNull(join(operationsDir, `${opId}.json`), MAX_OPERATION_FILE_BYTES, 'startup');
        if (opBytes !== null) {
          matchedReq = parseAuthenticatedOperationBytes(
            opBytes,
            opId,
            config.controllerSigningSecret,
            config.maxBlobBytes,
          );
          if (!verdictMatchesRequestBinding(verdict, matchedReq)) {
            throw new HardwareRunnerError(
              'ARTIFACT_INVALID',
              `recovered request does not match receipt for "${verdict.operationId}"`,
            );
          }
        }

        const entry = buildTerminalEntry(verdict, matchedReq, {
          linkedOnDisk: true,
          durableOnDisk: true,
        });
        putBoundedTerminalCache(entry);
        queue.restoreTerminalOperation({
          verdict,
          ...(matchedReq !== null ? { request: matchedReq } : {}),
        });
      }
    } finally {
      await receiptDirStream.close().catch(() => {});
    }

    // 3. Stream-authenticate remaining non-terminal operation descriptors (<casDir>/operations/*.json)
    //    without materializing directory listings or retaining per-operation staging maps at startup;
    //    descriptor_only input blob authority is verified on demand at POST time.
    const opDirStream = await opendir(operationsDir);
    try {
      for await (const dirent of opDirStream) {
        const fileName = dirent.name;
        if (fileName.startsWith('.tmp-')) continue;
        if (!fileName.endsWith('.json')) {
          throw new HardwareRunnerError('ARTIFACT_INVALID', 'unexpected file in CAS operations directory');
        }
        const opId = parseOperationId(fileName.slice(0, -5), '/operations');
        let receiptExists = false;
        try {
          await lstat(join(receiptsDir, `${opId}.json`));
          receiptExists = true;
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
            throw new HardwareRunnerError('ARTIFACT_INVALID', 'failed to inspect persisted receipt state at startup');
          }
        }
        if (receiptExists) continue;

        const rawBytes = await readRequiredStartupRecord(join(operationsDir, fileName), MAX_OPERATION_FILE_BYTES);
        parseAuthenticatedOperationBytes(
          rawBytes,
          opId,
          config.controllerSigningSecret,
          config.maxBlobBytes,
        );
      }
    } finally {
      await opDirStream.close().catch(() => {});
    }

    const checkControllerBearerIfConfigured = (req: IncomingMessage): boolean => {
      if (config.controllerAuthToken === undefined) return true;
      const token = extractBearerToken(req);
      if (token === null) return false;
      return timingSafeEqualStrings(token, config.controllerAuthToken);
    };

    const parseBlobLengthHeaders = (
      req: IncomingMessage,
      sha256: string,
    ): number => {
      const headerSha = singleHeader(req, 'x-loopwright-blob-sha256');
      const headerLenRaw = singleHeader(req, 'x-loopwright-blob-length');
      if (headerSha !== sha256 || headerLenRaw === null || !/^(?:0|[1-9][0-9]{0,14})$/.test(headerLenRaw)) {
        throw new HardwareRunnerError('ARTIFACT_INVALID', 'missing or mismatched x-loopwright-blob-sha256 / x-loopwright-blob-length');
      }
      const expectedLength = Number(headerLenRaw);
      if (!Number.isSafeInteger(expectedLength) || expectedLength < 0) {
        throw new HardwareRunnerError('ARTIFACT_INVALID', 'invalid x-loopwright-blob-length');
      }
      if (expectedLength > config.maxBlobBytes) {
        throw new HardwareRunnerError('PAYLOAD_TOO_LARGE', `blob length exceeds maxBlobBytes (${config.maxBlobBytes})`);
      }
      if ((expectedLength === 0) !== (sha256 === EMPTY_SHA256_HEX)) {
        throw new HardwareRunnerError('ARTIFACT_INVALID', 'empty blob sha256/byteLength mismatch');
      }
      const contentLengthRaw = singleHeader(req, 'content-length');
      if (contentLengthRaw !== null) {
        if (!/^(?:0|[1-9][0-9]{0,14})$/.test(contentLengthRaw) || Number(contentLengthRaw) !== expectedLength) {
          throw new HardwareRunnerError('ARTIFACT_INVALID', 'content-length does not match x-loopwright-blob-length');
        }
      }
      return expectedLength;
    };

    const parseControllerWaitMs = (req: IncomingMessage, parsedUrl: URL): number => {
      for (const key of parsedUrl.searchParams.keys()) {
        if (key !== 'waitMs') {
          throw new HardwareRunnerError('ARTIFACT_INVALID', 'unsupported query parameter on benchmark jobs endpoint');
        }
      }
      const queryValues = parsedUrl.searchParams.getAll('waitMs');
      if (queryValues.length > 1) {
        throw new HardwareRunnerError('ARTIFACT_INVALID', 'duplicate waitMs query parameter');
      }
      const rawWaitHeader = req.headers['x-loopwright-wait-ms'];
      if (Array.isArray(rawWaitHeader)) {
        throw new HardwareRunnerError('ARTIFACT_INVALID', 'duplicate x-loopwright-wait-ms header');
      }
      for (const candidate of [queryValues[0], rawWaitHeader]) {
        if (candidate !== undefined && !/^(?:0|[1-9][0-9]{0,7})$/.test(candidate)) {
          throw new HardwareRunnerError('ARTIFACT_INVALID', 'invalid waitMs parameter');
        }
      }
      const selected = queryValues[0] ?? rawWaitHeader;
      if (selected === undefined) return 0;
      return Math.min(MAX_ACQUIRE_WAIT_MS, Number(selected));
    };

    const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const method = req.method ?? 'GET';
      const rawUrl = req.url ?? '/';
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(rawUrl, 'http://localhost');
      } catch {
        sendError(res, secretScrubber, 400, 'ARTIFACT_INVALID', 'malformed request URL');
        return;
      }
      const pathname = parsedUrl.pathname;

      // -----------------------------------------------------------------------
      // A.1 POST /v1/benchmark/jobs
      // -----------------------------------------------------------------------
      if (pathname === '/v1/benchmark/jobs') {
        if (method !== 'POST') {
          sendError(res, secretScrubber, 405, 'NOT_FOUND', 'method not allowed');
          return;
        }
        const rawBody = await readBoundedRequestBody(req, MAX_CONTROL_BODY_BYTES);
        const sigHeader = singleHeader(req, 'x-loopwright-signature') ?? '';
        const bearerOk = checkControllerBearerIfConfigured(req);
        const sigOk = verifyRelaySignature(config.controllerSigningSecret, rawBody, sigHeader);
        if (!bearerOk || !sigOk) {
          sendError(res, secretScrubber, 401, 'AUTH_UNAUTHORIZED', 'invalid controller signature or bearer token');
          return;
        }

        // Validate polling parameters BEFORE parsing/admitting the job so invalid requests leave queue untouched.
        const waitMs = parseControllerWaitMs(req, parsedUrl);
        const jsonBody = parseStrictJsonBytes(rawBody, MAX_CONTROL_BODY_BYTES, 'ARTIFACT_INVALID', '/');
        const benchmarkReq = parseBenchmarkRequest(jsonBody, config.maxBlobBytes);

        let verdict = await withAdmissionLock(async () => {
          const reqCanonical = canonicalJson(benchmarkReq);

          const existingLookup = queue.lookupExistingOperation(benchmarkReq);
          if (existingLookup.found) {
            return existingLookup.verdict;
          }

          const resolved = await resolveDiskOperationState(benchmarkReq.operationId);
          if (resolved.kind === 'terminal') {
            const term = resolved.entry;
            if (term.request === null || term.requestCanonical === null) {
              throw new HardwareRunnerError(
                'QUEUE_JOB_CONFLICT',
                `operation "${benchmarkReq.operationId}" has a terminal receipt without an authenticated operation descriptor`,
              );
            }
            if (
              term.request.dispatchId !== benchmarkReq.dispatchId
              || term.request.requestDigest !== benchmarkReq.requestDigest
              || term.requestCanonical !== reqCanonical
            ) {
              throw new HardwareRunnerError(
                'QUEUE_JOB_CONFLICT',
                `conflicting benchmark_request for settled operationId "${benchmarkReq.operationId}"`,
              );
            }
            return term.verdict;
          }

          if (resolved.kind === 'descriptor_only') {
            if (
              resolved.request.dispatchId !== benchmarkReq.dispatchId
              || resolved.request.requestDigest !== benchmarkReq.requestDigest
              || resolved.requestCanonical !== reqCanonical
            ) {
              throw new HardwareRunnerError(
                'QUEUE_JOB_CONFLICT',
                `conflicting benchmark_request for persisted operationId "${benchmarkReq.operationId}"`,
              );
            }
          }

          const stagedForOp = stagedInputBlobsByOperation.get(benchmarkReq.operationId);
          const frozenMap = new Map<string, number>();
          for (const entry of collectDeclaredInputBlobs(benchmarkReq.candidateArtifacts)) {
            if (resolved.kind === 'absent') {
              const stagedLen = stagedForOp?.get(entry.digest.hex);
              if (stagedLen === undefined) {
                throw new HardwareRunnerError(
                  'ARTIFACT_MISSING',
                  `declared candidate input blob ${entry.digest.hex} has not been staged for operation`,
                );
              }
              if (stagedLen !== entry.byteLength) {
                throw new HardwareRunnerError('ARTIFACT_INVALID', 'staged candidate blob byteLength mismatch');
              }
            }
            await verifyExistingCasBlob(entry.digest.hex, entry.byteLength, { missingCode: 'ARTIFACT_MISSING' });
            frozenMap.set(entry.digest.hex, entry.byteLength);
          }

          const effectiveActiveCap = Math.min(config.maxJobs, maxRetainedTerminalOps);
          if (activeOperations.size + undurableTerminalByOperation.size >= effectiveActiveCap) {
            throw new HardwareRunnerError(
              'QUEUE_CAPACITY_EXCEEDED',
              'Relay queue capacity exceeded by active or pending-durability operations',
            );
          }
          queue.assertCanAdmitNewJob();
          if (resolved.kind === 'absent') {
            if (options.onBeforeOperationPersist !== undefined) {
              await options.onBeforeOperationPersist(benchmarkReq.operationId);
            }
            await persistOperationRequestRecord(benchmarkReq);
          }
          // Re-verify shutdown and queue admission synchronously after the final await so a concurrent
          // clean close() during descriptor I/O can never leave a fence for a rejected job!
          if (serverAbort.signal.aborted) {
            throw new HardwareRunnerError('QUEUE_STATE_INVALID', 'Relay server is shutting down');
          }
          queue.assertCanAdmitNewJob();
          // Persist the recovery obligation BEFORE allowing the job to run so even simultaneous
          // receipt + lock-DB storage failures at expiry/shutdown can never lose the fence!
          recordRecoveryFenceStrict(benchmarkReq.operationId, 'operation_admitted');
          let sub: ReturnType<RelayPullQueue['submitJob']>;
          try {
            sub = queue.submitJob(benchmarkReq);
          } catch (submitErr: unknown) {
            clearRecoveryFence(benchmarkReq.operationId);
            throw submitErr;
          }
          activeOperations.set(benchmarkReq.operationId, {
            request: benchmarkReq,
            requestCanonical: reqCanonical,
            frozenInputs: frozenMap,
          });
          stagedInputBlobsByOperation.delete(benchmarkReq.operationId);
          return sub.verdict;
        });
        if (waitMs > 0 && verdict.status === 'pending' && !res.destroyed && !res.writableEnded) {
          const disconnectController = new AbortController();
          const onClose = () => disconnectController.abort();
          res.once('close', onClose);
          try {
            verdict = await queue.waitForVerdict(
              benchmarkReq.operationId,
              waitMs,
              AbortSignal.any([serverAbort.signal, disconnectController.signal]),
            );
          } finally {
            res.removeListener('close', onClose);
          }
        }

        if (res.destroyed || res.writableEnded) return;

        if (verdict.status !== 'pending') {
          await ensureReceiptDurable(verdict);
        }

        const verdictCanonical = assertVerdictPublishable(verdict);
        const responseBytes = Buffer.from(verdictCanonical, 'utf8');
        const responseSig = signRelayPayload(config.controllerSigningSecret, responseBytes);
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(responseBytes.byteLength),
          'x-loopwright-signature': responseSig,
        });
        res.end(responseBytes);
        return;
      }

      // -----------------------------------------------------------------------
      // A.2 & A.3 PUT / GET /v1/benchmark/jobs/:operationId/blobs/:sha256
      // -----------------------------------------------------------------------
      const controllerBlobMatch = /^\/v1\/benchmark\/jobs\/([^/]+)\/blobs\/([^/]+)$/.exec(pathname);
      if (controllerBlobMatch !== null) {
        const operationId = parseOperationId(decodeSegment(controllerBlobMatch[1]!), '/operationId');
        const sha256 = parseSha256Hex(decodeSegment(controllerBlobMatch[2]!), '/sha256');
        const sigHeader = singleHeader(req, 'x-loopwright-signature') ?? '';
        const bearerOk = checkControllerBearerIfConfigured(req);

        if (method === 'PUT') {
          const expectedLength = parseBlobLengthHeaders(req, sha256);
          const canonicalSigningInput = `PUT\n${operationId}\n${sha256}\n${expectedLength}`;
          const sigOk = verifyRelaySignature(config.controllerSigningSecret, canonicalSigningInput, sigHeader);
          if (!bearerOk || !sigOk) {
            req.resume();
            sendError(res, secretScrubber, 401, 'AUTH_UNAUTHORIZED', 'invalid controller blob PUT signature or bearer token');
            return;
          }
          const assertCanStageInputBlob = async (): Promise<'pre_submit' | 'already_bound'> => {
            const activeOp = activeOperations.get(operationId);
            if (activeOp !== undefined) {
              if (activeOp.frozenInputs.get(sha256) !== expectedLength) {
                throw new HardwareRunnerError(
                  'QUEUE_JOB_CONFLICT',
                  'cannot stage undeclared input blob after job submission',
                );
              }
              return 'already_bound';
            }
            const resolved = await resolveDiskOperationState(operationId);
            if (resolved.kind === 'terminal') {
              if (resolved.entry.frozenInputs === null) {
                throw new HardwareRunnerError(
                  'QUEUE_JOB_CONFLICT',
                  `operation "${operationId}" has a terminal receipt without an authenticated operation descriptor`,
                );
              }
              if (resolved.entry.frozenInputs.get(sha256) !== expectedLength) {
                throw new HardwareRunnerError(
                  'QUEUE_JOB_CONFLICT',
                  'cannot stage undeclared input blob on settled operation',
                );
              }
              return 'already_bound';
            }
            if (resolved.kind === 'descriptor_only') {
              const matchesDeclared = collectDeclaredInputBlobs(resolved.request.candidateArtifacts).some(
                e => e.digest.hex === sha256 && e.byteLength === expectedLength,
              );
              if (!matchesDeclared) {
                throw new HardwareRunnerError(
                  'QUEUE_JOB_CONFLICT',
                  'cannot stage undeclared input blob on persisted operation descriptor',
                );
              }
            }
            return 'pre_submit';
          };

          await withAdmissionLock(() => assertCanStageInputBlob());
          const ingested = await ingestStreamedCasBlob(req, sha256, expectedLength, { scrubSecrets: false });
          await withAdmissionLock(async () => {
            const mode = await assertCanStageInputBlob();
            if (mode === 'pre_submit') {
              let opMap = stagedInputBlobsByOperation.get(operationId);
              if (!opMap) {
                opMap = new Map();
                stagedInputBlobsByOperation.set(operationId, opMap);
              }
              opMap.set(sha256, expectedLength);
            }
          });
          sendJson(res, ingested.created ? 201 : 200, { ok: true, sha256, byteLength: expectedLength });
          return;
        }

        if (method === 'GET') {
          const canonicalSigningInput = `GET\n${operationId}\n${sha256}`;
          const sigOk = verifyRelaySignature(config.controllerSigningSecret, canonicalSigningInput, sigHeader);
          if (!bearerOk || !sigOk) {
            sendError(res, secretScrubber, 401, 'AUTH_UNAUTHORIZED', 'invalid controller blob GET signature or bearer token');
            return;
          }
          const snap = queue.getJobByOperationId(operationId);
          if (snap && snap.verdict.status !== 'pending') {
            await ensureReceiptDurable(snap.verdict);
          }

          const resolved = await resolveDiskOperationState(operationId);
          if (resolved.kind === 'terminal' && !resolved.entry.durableOnDisk) {
            await ensureReceiptDurable(resolved.entry.verdict);
          }
          const committedLen = resolved.kind === 'terminal' ? resolved.entry.committedOutputs.get(sha256) : undefined;
          if (committedLen === undefined) {
            if (await hasCasBlobOnDisk(sha256)) {
              sendError(res, secretScrubber, 403, 'AUTH_FORBIDDEN', 'blob is not an authorized output of this operation');
            } else {
              sendError(res, secretScrubber, 404, 'NOT_FOUND', 'output blob not found');
            }
            return;
          }
          const blobSig = signRelayPayload(
            config.controllerSigningSecret,
            `BLOB\n${operationId}\n${sha256}\n${committedLen}`,
          );
          await streamCasBlobResponse(res, sha256, committedLen, {
            'x-loopwright-signature': blobSig,
          });
          return;
        }

        sendError(res, secretScrubber, 405, 'NOT_FOUND', 'method not allowed');
        return;
      }

      // -----------------------------------------------------------------------
      // B. Worker routes (/v1/runner/leases*)
      // -----------------------------------------------------------------------
      if (pathname === '/v1/runner/leases:acquire' || pathname.startsWith('/v1/runner/leases/')) {
        if (!verifyBearerAgainstList(req, config.workerTokens)) {
          req.resume();
          sendError(res, secretScrubber, 401, 'AUTH_UNAUTHORIZED', 'invalid or missing worker bearer token');
          return;
        }

        // B.1 POST /v1/runner/leases:acquire
        if (pathname === '/v1/runner/leases:acquire') {
          if (method !== 'POST') {
            sendError(res, secretScrubber, 405, 'NOT_FOUND', 'method not allowed');
            return;
          }
          const rawBody = await readBoundedRequestBody(req, MAX_CONTROL_BODY_BYTES);
          const jsonBody = parseStrictJsonBytes(rawBody, MAX_CONTROL_BODY_BYTES, 'ARTIFACT_INVALID', '/');
          const acquireInput = parseAcquireInput(jsonBody);

          const disconnectController = new AbortController();
          const onClose = () => disconnectController.abort();
          res.once('close', onClose);
          let grant;
          try {
            grant = await queue.acquireLease(
              acquireInput,
              AbortSignal.any([serverAbort.signal, disconnectController.signal]),
            );
          } finally {
            res.removeListener('close', onClose);
          }

          if (res.destroyed || res.writableEnded) return;
          if (grant === null) {
            res.writeHead(204);
            res.end();
            return;
          }
          sendJson(res, 200, grant);
          return;
        }

        // B.2 POST /v1/runner/leases/:jobId:heartbeat
        // B.4 POST /v1/runner/leases/:jobId:preempt
        // B.7 POST /v1/runner/leases/:jobId:complete
        const actionMatch = /^\/v1\/runner\/leases\/([^/:]+):(heartbeat|preempt|complete)$/.exec(pathname);
        if (actionMatch !== null) {
          if (method !== 'POST') {
            sendError(res, secretScrubber, 405, 'NOT_FOUND', 'method not allowed');
            return;
          }
          const jobId = parseSafeId(decodeSegment(actionMatch[1]!), '/jobId');
          const action = actionMatch[2]!;
          const rawBody = await readBoundedRequestBody(req, MAX_CONTROL_BODY_BYTES);
          const jsonBody = parseStrictJsonBytes(rawBody, MAX_CONTROL_BODY_BYTES, 'ARTIFACT_INVALID', '/');

          if (action === 'heartbeat') {
            const hbInput = parseHeartbeatInput(jsonBody);
            const hbRes = queue.heartbeatLease(jobId, hbInput);
            sendJson(res, 200, hbRes);
            return;
          }

          if (action === 'preempt') {
            const preemptInput = parsePreemptInput(jsonBody);
            const preemptRes = queue.preemptLease(jobId, preemptInput);
            const snap = queue.getJob(jobId);
            if (snap && snap.verdict.status !== 'pending') {
              await ensureReceiptDurable(snap.verdict);
            }
            sendJson(res, 200, preemptRes);
            return;
          }

          if (action === 'complete') {
            const completeInput = parseCompleteInput(jsonBody, config.maxBlobBytes, secretScrubber);
            await withSerialLock(jobCompletionChains, jobId, async () => {
              const prepared = queue.prepareCompleteLease(jobId, completeInput);
              let stagedReceipt: Awaited<ReturnType<typeof stageSignedVerdictReceiptTemp>> | null = null;
              let linkedReceipt = false;
              let committedEntry: CachedTerminalOperation | null = null;
              let dirSyncPromise: Promise<void> | null = null;
              let resolveDirSync!: () => void;
              let rejectDirSync!: (err: unknown) => void;
              let writeKey = '';

              try {
                assertVerdictPublishable(prepared.verdict);
                for (const art of prepared.outputArtifacts) {
                  queue.verifyActiveLease(jobId, completeInput);
                  await verifyExistingCasBlob(art.digest.hex, art.byteLength, { scrubSecrets: true });
                }

                queue.verifyActiveLease(jobId, completeInput);
                const preExistingReceipt = await readRecordFileOrNull(
                  join(receiptsDir, `${prepared.operationId}.json`),
                  MAX_RECEIPT_FILE_BYTES,
                  'runtime',
                );
                if (preExistingReceipt !== null) {
                  throw new Error('durable receipt already exists before lease completion commit');
                }

                if (options.onBeforeReceiptPersist !== undefined) {
                  await options.onBeforeReceiptPersist(prepared.operationId);
                }
                stagedReceipt = await stageSignedVerdictReceiptTemp(prepared.verdict);

                // Atomic synchronous publication boundary: validate live lease authority, link receipt without
                // overwriting any existing file, bind output authorization, and register durability state ONLY
                // after the completion wins in the queue.
                prepared.commit(() => {
                  linkSync(stagedReceipt!.tmpReceiptPath, stagedReceipt!.finalReceiptPath);
                  linkedReceipt = true;
                  try {
                    unlinkSync(stagedReceipt!.tmpReceiptPath);
                  } catch {
                    // Best-effort cleanup of temp link after finalReceiptPath is linked.
                  }

                  dirSyncPromise = new Promise<void>((resSync, rejSync) => {
                    resolveDirSync = resSync;
                    rejectDirSync = rejSync;
                  });
                  // Prevent unhandled rejection when no controller poll is concurrently awaiting dirSyncPromise.
                  void dirSyncPromise.catch(() => {});

                  committedEntry = recordCommittedTerminalTransition(prepared.verdict, {
                    linkedOnDisk: true,
                    durableOnDisk: false,
                  });
                  writeKey = `${prepared.operationId}\0${committedEntry.verdictCanonical}`;
                  inFlightReceiptWrites.set(writeKey, dirSyncPromise);
                  inFlightByOperation.set(prepared.operationId, dirSyncPromise);
                  activeDurabilityTasks.add(dirSyncPromise);
                });

                try {
                  await syncDir(receiptsDir);
                  committedEntry!.durableOnDisk = true;
                  undurableTerminalByOperation.delete(prepared.operationId);
                  clearRecoveryFence(prepared.operationId);
                  putBoundedTerminalCache(committedEntry!);
                  resolveDirSync();
                } catch (syncErr) {
                  // Receipt file was already linked into place; keep job committed (uncertain durability)
                  // rather than rolling back a published receipt, and withhold 200 until dir-sync succeeds.
                  rejectDirSync(syncErr);
                  throw syncErr;
                } finally {
                  if (dirSyncPromise !== null) {
                    if (inFlightReceiptWrites.get(writeKey) === dirSyncPromise) {
                      inFlightReceiptWrites.delete(writeKey);
                    }
                    if (inFlightByOperation.get(prepared.operationId) === dirSyncPromise) {
                      inFlightByOperation.delete(prepared.operationId);
                    }
                    activeDurabilityTasks.delete(dirSyncPromise);
                  }
                }
              } catch (err) {
                if (!linkedReceipt) {
                  prepared.abort();
                  if (stagedReceipt !== null) {
                    await unlink(stagedReceipt.tmpReceiptPath).catch(() => {});
                  }
                  const winningDurabilityTask = inFlightByOperation.get(prepared.operationId);
                  if (winningDurabilityTask !== undefined) {
                    await winningDurabilityTask.catch(() => {});
                  }
                }
                throw err;
              }

              sendJson(res, 200, {
                ok: true,
                operationId: prepared.operationId,
                status: completeInput.status,
              });
            });
            return;
          }
        }

        // B.3 GET /v1/runner/leases/:jobId/events (SSE cancel watch — headers only, never query tokens!)
        const eventsMatch = /^\/v1\/runner\/leases\/([^/]+)\/events$/.exec(pathname);
        if (eventsMatch !== null) {
          if (method !== 'GET') {
            sendError(res, secretScrubber, 405, 'NOT_FOUND', 'method not allowed');
            return;
          }
          if (parsedUrl.search !== '') {
            sendError(
              res,
              secretScrubber,
              400,
              'ARTIFACT_INVALID',
              'lease credentials must be passed via headers, not URL query parameters',
            );
            return;
          }
          const jobId = parseSafeId(decodeSegment(eventsMatch[1]!), '/jobId');
          const creds = parseLeaseHeaders(req);
          queue.verifyActiveLease(jobId, creds);

          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
          });
          res.write('event: state\ndata: {"desiredState":"running"}\n\n');

          let closed = false;
          const unsubscribe = queue.subscribeLeaseCancel(jobId, creds, reason => {
            if (closed) return;
            closed = true;
            if (reason === 'cancel' && !res.destroyed && !res.writableEnded) {
              res.write('event: cancel\ndata: {"desiredState":"cancel"}\n\n');
            }
            if (!res.destroyed && !res.writableEnded) {
              res.end();
            }
          });

          res.once('close', () => {
            closed = true;
            unsubscribe();
          });
          return;
        }

        // B.5 & B.6 GET / PUT /v1/runner/leases/:jobId/blobs/:sha256
        const workerBlobMatch = /^\/v1\/runner\/leases\/([^/]+)\/blobs\/([^/]+)$/.exec(pathname);
        if (workerBlobMatch !== null) {
          if (parsedUrl.search !== '') {
            req.resume();
            sendError(
              res,
              secretScrubber,
              400,
              'ARTIFACT_INVALID',
              'lease credentials must not be passed in URL query parameters',
            );
            return;
          }
          const jobId = parseSafeId(decodeSegment(workerBlobMatch[1]!), '/jobId');
          const sha256 = parseSha256Hex(decodeSegment(workerBlobMatch[2]!), '/sha256');
          const creds = parseLeaseHeaders(req);

          if (method === 'GET') {
            const active = queue.verifyActiveLease(jobId, creds);
            const frozenMap = activeOperations.get(active.operationId)?.frozenInputs;
            const expectedLen = frozenMap?.get(sha256);
            if (expectedLen === undefined) {
              if (await hasCasBlobOnDisk(sha256)) {
                sendError(res, secretScrubber, 403, 'AUTH_FORBIDDEN', 'blob is not an authorized input of this job');
              } else {
                sendError(res, secretScrubber, 404, 'NOT_FOUND', 'input blob not found');
              }
              return;
            }
            await streamCasBlobResponse(res, sha256, expectedLen, {});
            return;
          }

          if (method === 'PUT') {
            // Pre-flight active lease check, then stage/hash/scrub/seal/link/sync unbound CAS bytes first,
            // and finally execute the lease check + committed-output binding as ONE synchronous queue operation.
            queue.verifyActiveLease(jobId, creds);
            const expectedLen = parseBlobLengthHeaders(req, sha256);
            const ingested = await ingestStreamedCasBlob(req, sha256, expectedLen, {
              scrubSecrets: true,
            });
            queue.recordCommittedOutputBlob(jobId, creds, {
              sha256,
              byteLength: expectedLen,
            });
            sendJson(res, ingested.created ? 201 : 200, { ok: true, sha256, byteLength: expectedLen });
            return;
          }

          sendError(res, secretScrubber, 405, 'NOT_FOUND', 'method not allowed');
          return;
        }
      }

      req.resume();
      sendError(res, secretScrubber, 404, 'NOT_FOUND', 'route not found');
    };

    const requestListener = (req: IncomingMessage, res: ServerResponse): void => {
      const task = handleRequest(req, res)
        .catch((err: unknown) => {
          if (res.headersSent || res.destroyed || res.writableEnded) {
            if (!res.destroyed) res.destroy();
            return;
          }
          if (err instanceof HardwareRunnerError) {
            switch (err.code) {
              case 'PAYLOAD_TOO_LARGE':
                req.resume();
                sendError(res, secretScrubber, 413, err.code, err.message);
                return;
              case 'AUTH_UNAUTHORIZED':
                req.resume();
                sendError(res, secretScrubber, 401, err.code, err.message);
                return;
              case 'AUTH_FORBIDDEN':
                req.resume();
                sendError(res, secretScrubber, 403, err.code, err.message);
                return;
              case 'NOT_FOUND':
                req.resume();
                sendError(res, secretScrubber, 404, err.code, err.message);
                return;
              case 'ARTIFACT_MISSING':
              case 'QUEUE_LEASE_FENCED':
              case 'QUEUE_JOB_CONFLICT':
                req.resume();
                sendError(res, secretScrubber, 409, err.code, err.message);
                return;
              case 'QUEUE_CAPACITY_EXCEEDED':
                req.resume();
                sendError(res, secretScrubber, 429, err.code, err.message);
                return;
              case 'ARTIFACT_INVALID': {
                req.resume();
                const isUploadOrEvidenceValidation =
                  (req.method === 'PUT' && (req.url ?? '').includes('/blobs/'))
                  || err.message.includes('SecretScrubber')
                  || err.message.includes('outputArtifact')
                  || err.message.includes('targetCellId')
                  || err.message.includes('CAS blob')
                  || err.message.includes('byteLength mismatch')
                  || err.message.includes('sha256 mismatch')
                  || err.message.includes('shorter than declared')
                  || err.message.includes('exceeded declared');
                sendError(res, secretScrubber, isUploadOrEvidenceValidation ? 422 : 400, err.code, err.message);
                return;
              }
              default:
                req.resume();
                sendError(res, secretScrubber, 400, err.code, err.message);
                return;
            }
          }
          req.resume();
          sendError(res, secretScrubber, 500, 'INTERNAL_ERROR', 'internal server error');
        })
        .finally(() => {
          activeRequestTasks.delete(task);
        });
      activeRequestTasks.add(task);
    };

    if (config.tls !== false) {
      scheme = 'https';
      const readTlsPem = async (pemPath: string, diagPath: string): Promise<Buffer> => {
        await assertNoSymlinkAncestors(pemPath, { checkLeaf: true, code: 'CONFIG_INVALID', diagPath });
        const raw = await readBoundedRegularFile(pemPath, 262_144, msg => {
          throw new HardwareRunnerError('CONFIG_INVALID', msg, diagPath);
        });
        return Buffer.from(raw);
      };
      const cert = await readTlsPem(config.tls.certPath, '/tls/certPath');
      const key = await readTlsPem(config.tls.keyPath, '/tls/keyPath');
      const ca = config.tls.caPath !== undefined
        ? await readTlsPem(config.tls.caPath, '/tls/caPath')
        : undefined;
      server = createHttpsServer(
        {
          cert,
          key,
          ...(ca !== undefined ? { ca } : {}),
        },
        requestListener,
      );
    } else {
      server = createHttpServer(requestListener);
    }

    const boundServer = server;
    boundServer.on('connection', (socket: Socket) => {
      openSockets.add(socket);
      socket.once('close', () => {
        openSockets.delete(socket);
      });
    });

    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (err: Error) => {
        boundServer.removeListener('listening', onListening);
        rejectListen(err);
      };
      const onListening = () => {
        boundServer.removeListener('error', onError);
        resolveListen();
      };
      boundServer.once('error', onError);
      boundServer.once('listening', onListening);
      boundServer.listen(config.port, config.host);
    });

    const addr = boundServer.address() as AddressInfo | null;
    if (!addr || typeof addr !== 'object') {
      throw new HardwareRunnerError('CONFIG_INVALID', 'failed to bind relay server socket');
    }
    const boundHost = addr.family === 'IPv6' && !config.host.startsWith('[') && config.host.includes(':')
      ? `[${config.host}]`
      : config.host;
    const boundPort = addr.port;
    const baseUrl = `${scheme}://${boundHost}:${boundPort}`;

    let closePromise: Promise<void> | null = null;
    return Object.freeze({
      url: baseUrl,
      host: config.host,
      port: boundPort,
      relayBootId: queue.relayBootId,
      casDir: config.casDir,
      retainedTerminalCount(): number {
        return Math.max(queue.retainedTerminalCount, countRetainedTerminalEntries());
      },
      close(): Promise<void> {
        if (closePromise !== null) return closePromise;
        closePromise = (async () => {
          serverAbort.abort();
          const cleanPendingOpIds: string[] = [];
          for (const opId of activeOperations.keys()) {
            const snap = queue.getJobByOperationId(opId);
            if (snap !== null && snap.preemptionCount === 0 && snap.verdict.status === 'pending') {
              cleanPendingOpIds.push(opId);
            }
          }
          queue.close();
          if ('closeIdleConnections' in boundServer && typeof boundServer.closeIdleConnections === 'function') {
            boundServer.closeIdleConnections();
          }
          const serverClosePromise = new Promise<void>(resolveClose => {
            boundServer.close(() => resolveClose());
          });
          const forceTimer = setTimeout(() => {
            for (const sock of openSockets) {
              sock.destroy();
            }
          }, 200);
          forceTimer.unref();
          await serverClosePromise;
          clearTimeout(forceTimer);
          while (activeRequestTasks.size > 0 || activeDurabilityTasks.size > 0) {
            await Promise.allSettled([...activeRequestTasks, ...activeDurabilityTasks]);
          }
          let hasFlushError = false;
          let flushError: unknown;
          for (const pendingEntry of [...undurableTerminalByOperation.values()]) {
            try {
              await ensureReceiptDurable(pendingEntry.verdict);
            } catch (err: unknown) {
              recordRecoveryFence(pendingEntry.operationId, 'shutdown_flush_failed');
              if (!hasFlushError) {
                hasFlushError = true;
                flushError = err;
              }
            }
          }
          while (activeDurabilityTasks.size > 0) {
            await Promise.allSettled([...activeDurabilityTasks]);
          }
          for (const remainingOpId of undurableTerminalByOperation.keys()) {
            recordRecoveryFence(remainingOpId, 'shutdown_flush_failed');
          }
          // Only release pre-allocated fences for operations that never consumed a preemption or settled terminally.
          for (const pendingOpId of cleanPendingOpIds) {
            if (!undurableTerminalByOperation.has(pendingOpId) && activeOperations.has(pendingOpId)) {
              clearRecoveryFence(pendingOpId);
            }
          }
          let hasLockReleaseError = false;
          let lockReleaseError: unknown;
          try {
            await releaseCasLock(true);
          } catch (err: unknown) {
            hasLockReleaseError = true;
            lockReleaseError = err;
          }
          if (hasFlushError) {
            throw flushError;
          }
          if (hasLockReleaseError) {
            throw lockReleaseError;
          }
        })();
        return closePromise;
      },
    });
  } catch (err) {
    serverAbort.abort();
    queue.close();
    while (activeRequestTasks.size > 0 || activeDurabilityTasks.size > 0) {
      await Promise.allSettled([...activeRequestTasks, ...activeDurabilityTasks]);
    }
    if (server !== null) {
      try {
        server.close();
      } catch {
        // Ignore close error on unbound server.
      }
    }
    await releaseCasLock(false);
    throw err;
  }
}
