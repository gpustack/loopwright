import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  LIMITS,
  SecretScrubber,
  validateRelativePath,
  type BucketMetricEntry,
  type Digest,
  type HardwareDiagnostics,
  type HardwareProvenance,
} from '@loopwright/core';
import {
  MAX_RECEIPT_FILE_BYTES,
  verifyBenchmarkVerdictSignature,
  type BenchmarkOutputArtifact,
  type SignedBenchmarkVerdictReceipt,
} from '@loopwright/hardware-runner';
import { computeNsga2Ranking } from './pareto.js';
import {
  canonicalizeJson,
  parseBucketMetricsJson,
  parseDispatchManifestV1,
  parseHardwareDiagnosticsJson,
  parseHardwareProvenanceJson,
  parseNullProtoJson,
  type NullProtoJson,
} from './schema.js';
import type { EvolutionCampaignStore } from './store.js';
import {
  DISPATCH_MANIFEST_MAX_BYTES,
  DISPATCH_MANIFEST_MAX_RULES,
  EvolutionError,
  type BundleCompatibilityTuple,
  type BundleLineageProvenance,
  type BundleMemberDigest,
  type BundleParetoEntry,
  type CampaignRecord,
  type DispatchDimensionRange,
  type DispatchManifestV1,
  type DispatchRuleV1,
  type EvolutionBundleManifestV1,
  type EvolutionExportFormat,
  type IndividualRecord,
} from './types.js';

export const EVOLUTION_BUNDLE_KIND = 'EvolutionBundle' as const;
export const EVOLUTION_BUNDLE_VERSION = 1 as const;
export const OCI_IMAGE_LAYOUT_VERSION = '1.0.0' as const;
export const OCI_IMAGE_INDEX_MEDIA_TYPE = 'application/vnd.oci.image.index.v1+json' as const;
export const OCI_IMAGE_MANIFEST_MEDIA_TYPE = 'application/vnd.oci.image.manifest.v1+json' as const;
export const OCI_EMPTY_CONFIG_MEDIA_TYPE = 'application/vnd.oci.empty.v1+json' as const;
export const EVOLUTION_BUNDLE_ARTIFACT_TYPE = 'application/vnd.loopwright.evolution-bundle.v1+json' as const;
export const EVOLUTION_MANIFEST_MEDIA_TYPE = 'application/vnd.loopwright.evolution-bundle.manifest.v1+json' as const;
export const EVOLUTION_DISPATCH_MANIFEST_MEDIA_TYPE = 'application/vnd.loopwright.evolution-bundle.dispatch.v1+json' as const;
export const EVOLUTION_RECEIPT_MEDIA_TYPE = 'application/vnd.loopwright.benchmark-verdict.v1+json' as const;
export const EVOLUTION_BLOB_DEFAULT_MEDIA_TYPE = 'application/octet-stream' as const;

const DEFAULT_SECRET_SCRUBBER = new SecretScrubber();
const DEFAULT_MAX_BLOB_BYTES = 67_108_864; // 64 MiB
const DEFAULT_ENTRYPOINT_SYMBOL = 'loopwright_entrypoint' as const;
const MAX_BUNDLE_MANIFEST_BYTES = 1_048_576;
const MAX_OCI_DOC_BYTES = 1_048_576;

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_FILENAME_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BUCKET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const DTYPE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const PRINTABLE_ASCII_RE = /^[\x20-\x7E]+$/;
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const FORBIDDEN_PROTOTYPE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const DARWIN_ROOT_SYMLINKS: ReadonlySet<string> = new Set(['/var', '/tmp', '/etc']);

const BINARY_ARTIFACT_EXTENSIONS: readonly string[] = Object.freeze([
  '.cubin',
  '.so',
  '.o',
  '.ptx',
  '.sass',
  '.hsaco',
  '.om',
  '.bin',
]);

const TEXT_ARTIFACT_EXTENSIONS: readonly string[] = Object.freeze([
  '.json',
  '.yaml',
  '.yml',
  '.txt',
  '.md',
  '.toml',
  '.cfg',
]);

const RECEIPT_ALLOWED_KEYS: ReadonlySet<string> = new Set([
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
  'outputArtifacts',
  'bucketMetrics',
  'hardwareDiagnostics',
  'heldOutWorkloadId',
  'signature',
]);

const RECEIPT_REQUIRED_KEYS: readonly string[] = Object.freeze([
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
]);

const ARTIFACT_ENTRY_KEYS: ReadonlySet<string> = new Set(['name', 'digest', 'byteLength', 'mediaType']);
const BUNDLE_MANIFEST_KEYS: ReadonlySet<string> = new Set([
  'kind',
  'version',
  'compatibility',
  'paretoSummary',
  'lineage',
  'members',
]);
const COMPATIBILITY_KEYS: ReadonlySet<string> = new Set([
  'accelerator',
  'isolationMode',
  'deviceCount',
  'driverVersion',
  'driverConstraint',
  'runtimeVersion',
  'topology',
  'workloadDigest',
  'modelDigest',
  'parallelismTags',
]);
const LINEAGE_KEYS: ReadonlySet<string> = new Set([
  'campaignId',
  'individualIds',
  'baseRevision',
  'lockHash',
]);
const MEMBER_KEYS: ReadonlySet<string> = new Set(['path', 'digest', 'byteLength', 'mediaType']);
const PARETO_ENTRY_KEYS: ReadonlySet<string> = new Set([
  'individualId',
  'paretoRank',
  'nicheKey',
  'metrics',
  'bucketMetrics',
  'hardwareDiagnostics',
]);

export type ReceiptSignatureVerifier = (
  receipt: SignedBenchmarkVerdictReceipt,
  rawReceiptBytes: Uint8Array,
  individualId: string,
) => boolean | Promise<boolean>;

export interface ExportEvolutionBundleOptions {
  readonly store: EvolutionCampaignStore;
  readonly campaignId: string;
  readonly outputDir: string;
  readonly format?: EvolutionExportFormat;
  readonly allowSyntheticProbe?: boolean;
  readonly individualIds?: readonly string[];
  readonly dispatchManifest?: DispatchManifestV1 | string | Uint8Array;
  readonly defaultEntrypoint?: string;
  readonly receiptSigningSecret?: string;
  readonly verifyReceiptSignature?: ReceiptSignatureVerifier;
  readonly expectedPortfolioWorkloadDigest?: Digest;
  readonly driverConstraint?: string;
  readonly modelDigest?: Digest;
  readonly parallelismTags?: readonly string[];
  readonly scrubber?: SecretScrubber;
  readonly maxBlobBytes?: number;
  readonly overwrite?: boolean;
}

export interface ExportEvolutionBundleResult {
  readonly format: EvolutionExportFormat;
  readonly outputDir: string;
  readonly manifestDigest: Digest;
  readonly dispatchManifestDigest: Digest;
  readonly ociIndexDigest?: Digest;
  readonly exportedIndividualIds: readonly string[];
  readonly blobCount: number;
}

export interface VerifyEvolutionBundleOptions {
  readonly bundleDir: string;
  readonly allowSyntheticProbe?: boolean;
  readonly receiptSigningSecret?: string;
  readonly verifyReceiptSignature?: ReceiptSignatureVerifier;
  readonly scrubber?: SecretScrubber;
  readonly maxBlobBytes?: number;
}

export interface VerifyEvolutionBundleResult {
  readonly format: EvolutionExportFormat;
  readonly bundleDir: string;
  readonly manifest: EvolutionBundleManifestV1;
  readonly dispatchManifest: DispatchManifestV1;
  readonly manifestDigest: Digest;
  readonly dispatchManifestDigest: Digest;
  readonly ociIndexDigest?: Digest;
  readonly receiptCount: number;
  readonly blobCount: number;
}

interface ParsedReceiptBundle {
  readonly receipt: SignedBenchmarkVerdictReceipt;
  readonly rawBytes: Buffer;
  readonly rawDigest: Digest;
  readonly provenance: HardwareProvenance;
  readonly outputArtifacts: readonly BenchmarkOutputArtifact[];
  readonly bucketMetrics?: readonly BucketMetricEntry[];
  readonly hardwareDiagnostics?: HardwareDiagnostics;
  readonly heldOutWorkloadId?: string;
}

interface VerifiedStageABlob {
  readonly digest: Digest;
  readonly byteLength: number;
  readonly bytes: Buffer;
  readonly mediaType: string;
  readonly artifactNames: readonly string[];
}

function createNullRecord<T extends Record<string, unknown>>(): T {
  return Object.create(null) as T;
}

function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function makeDigest(hex: string): Digest {
  if (!SHA256_HEX_RE.test(hex)) {
    throw new EvolutionError('ARTIFACT_INVALID', `invalid sha256 digest hex "${hex}"`);
  }
  const out = createNullRecord<{ algorithm: 'sha256'; hex: string }>();
  out.algorithm = 'sha256';
  out.hex = hex;
  return out;
}

function isAllowedOsRootSymlink(targetPath: string): boolean {
  return process.platform === 'darwin' && DARWIN_ROOT_SYMLINKS.has(targetPath);
}

function decodeUtf8Strict(bytes: Uint8Array, diagPath: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new EvolutionError('ARTIFACT_INVALID', 'payload bytes are not valid UTF-8', diagPath);
  }
}

function assertCleanSecretText(text: string, scrubber: SecretScrubber, diagPath: string): void {
  if (scrubber.containsSecret(text)) {
    throw new EvolutionError('SECRET_LEAK_DETECTED', `secret material detected at ${diagPath}`, diagPath);
  }
}

function validateAbsoluteFilesystemPath(rawPath: string, label: string): string {
  if (
    typeof rawPath !== 'string'
    || rawPath.length === 0
    || rawPath.length > 4_096
    || /[\0\r\n]/.test(rawPath)
    || LONE_SURROGATE_RE.test(rawPath)
  ) {
    throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', `${label} must be a clean non-empty path`, `/${label}`);
  }
  const resolved = resolve(rawPath);
  if (!isAbsolute(resolved)) {
    throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', `${label} must resolve to an absolute path`, `/${label}`);
  }
  return resolved;
}

async function assertNoSymlinkPath(
  targetPath: string,
  options: { readonly checkLeaf?: boolean; readonly diagPath?: string } = {},
): Promise<void> {
  const diagPath = options.diagPath ?? targetPath;
  const normalized = validateAbsoluteFilesystemPath(targetPath, 'path');
  let cursor = options.checkLeaf === false ? dirname(normalized) : normalized;
  let depth = 0;

  while (true) {
    if (++depth > 128) {
      throw new EvolutionError('ARTIFACT_INVALID', `path exceeds maximum directory depth: ${normalized}`, diagPath);
    }
    const st = await lstat(cursor).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      if (err.code === 'ELOOP') {
        throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `symlink forbidden along ${normalized}`, diagPath);
      }
      throw err;
    });

    if (st !== null) {
      if (st.isSymbolicLink() && !isAllowedOsRootSymlink(cursor)) {
        throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `symlink forbidden at ${cursor}`, diagPath);
      }
      const isCheckedLeaf = options.checkLeaf !== false && cursor === normalized;
      if (!isCheckedLeaf && !st.isDirectory() && !isAllowedOsRootSymlink(cursor)) {
        throw new EvolutionError('ARTIFACT_INVALID', `ancestor component is not a directory: ${cursor}`, diagPath);
      }
    }

    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

async function ensureDirectoryChainNoSymlink(targetDir: string, mode = 0o755): Promise<void> {
  const normalized = resolve(targetDir);
  await assertNoSymlinkPath(normalized, { checkLeaf: true, diagPath: normalized });

  const missing: string[] = [];
  let cursor = normalized;
  while (true) {
    const st = await lstat(cursor).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      if (err.code === 'ELOOP') {
        throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `symlink forbidden along ${cursor}`, cursor);
      }
      throw err;
    });
    if (st !== null) {
      if (st.isSymbolicLink() && !isAllowedOsRootSymlink(cursor)) {
        throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `directory cannot be a symlink: ${cursor}`, cursor);
      }
      if (!st.isDirectory() && !isAllowedOsRootSymlink(cursor)) {
        throw new EvolutionError('ARTIFACT_INVALID', `expected directory at ${cursor}`, cursor);
      }
      break;
    }
    missing.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  for (let i = missing.length - 1; i >= 0; i--) {
    const dirToMake = missing[i]!;
    await mkdir(dirToMake, { mode, recursive: false }).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'EEXIST') throw err;
    });
    const created = await lstat(dirToMake);
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `created path is not a regular directory: ${dirToMake}`, dirToMake);
    }
  }
}

async function verifyNonSymlinkDirectoryFd(dirPath: string): Promise<void> {
  const st = await lstat(dirPath).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') {
      throw new EvolutionError('ARTIFACT_MISSING', `directory not found: ${dirPath}`, dirPath);
    }
    if (err.code === 'ELOOP') {
      throw new EvolutionError('ARTIFACT_INVALID', `symlink forbidden along directory: ${dirPath}`, dirPath);
    }
    throw err;
  });
  if (st.isSymbolicLink()) {
    throw new EvolutionError('ARTIFACT_INVALID', `directory cannot be a symlink: ${dirPath}`, dirPath);
  }
  if (!st.isDirectory()) {
    throw new EvolutionError('ARTIFACT_INVALID', `expected directory at ${dirPath}`, dirPath);
  }
  const noFollow = 'O_NOFOLLOW' in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const dirFlag = 'O_DIRECTORY' in fsConstants ? fsConstants.O_DIRECTORY : 0;
  const handle = await open(dirPath, fsConstants.O_RDONLY | noFollow | dirFlag).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ELOOP' || err.code === 'EFTYPE') {
      throw new EvolutionError('ARTIFACT_INVALID', `symlink directory forbidden: ${dirPath}`, dirPath);
    }
    throw err;
  });
  try {
    const fdStat = await handle.stat();
    if (!fdStat.isDirectory() || fdStat.dev !== st.dev || fdStat.ino !== st.ino) {
      throw new EvolutionError('ARTIFACT_INVALID', `directory identity changed during open: ${dirPath}`, dirPath);
    }
  } finally {
    await handle.close();
  }
}

async function readVerifiedRegularFileNoFollow(
  filePath: string,
  options: {
    readonly expectedSha256Hex?: string;
    readonly expectedByteLength?: number;
    readonly maxBytes: number;
    readonly missingCode?: 'ARTIFACT_MISSING' | 'ARTIFACT_INVALID';
  },
): Promise<Buffer> {
  const missingCode = options.missingCode ?? 'ARTIFACT_MISSING';
  const st = await lstat(filePath).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') {
      throw new EvolutionError(missingCode, `file not found: ${filePath}`, filePath);
    }
    if (err.code === 'ELOOP') {
      throw new EvolutionError('ARTIFACT_INVALID', `symlink forbidden at ${filePath}`, filePath);
    }
    throw err;
  });

  if (st.isSymbolicLink()) {
    throw new EvolutionError('ARTIFACT_INVALID', `symlink artifact is forbidden: ${filePath}`, filePath);
  }
  if (!st.isFile()) {
    throw new EvolutionError('ARTIFACT_INVALID', `artifact must be a regular file: ${filePath}`, filePath);
  }
  if (st.nlink !== 1) {
    throw new EvolutionError(
      'ARTIFACT_INVALID',
      `artifact hardlink forbidden (nlink=${st.nlink}, expected 1): ${filePath}`,
      filePath,
    );
  }
  if (st.size > options.maxBytes) {
    throw new EvolutionError('ARTIFACT_INVALID', `artifact exceeds maximum size ${options.maxBytes}: ${filePath}`, filePath);
  }
  if (options.expectedByteLength !== undefined && st.size !== options.expectedByteLength) {
    throw new EvolutionError(
      'ARTIFACT_INVALID',
      `artifact byteLength mismatch (expected ${options.expectedByteLength}, observed ${st.size}): ${filePath}`,
      filePath,
    );
  }

  const noFollow = 'O_NOFOLLOW' in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(filePath, fsConstants.O_RDONLY | noFollow).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ELOOP' || err.code === 'EFTYPE') {
      throw new EvolutionError('ARTIFACT_INVALID', `symlink forbidden on open: ${filePath}`, filePath);
    }
    if (err.code === 'ENOENT') {
      throw new EvolutionError(missingCode, `file not found: ${filePath}`, filePath);
    }
    throw err;
  });

  try {
    const fdStat = await handle.stat();
    if (
      !fdStat.isFile()
      || fdStat.nlink !== 1
      || fdStat.size !== st.size
      || fdStat.dev !== st.dev
      || fdStat.ino !== st.ino
      || fdStat.size > options.maxBytes
    ) {
      throw new EvolutionError('ARTIFACT_INVALID', `artifact changed or failed fd stat verification: ${filePath}`, filePath);
    }
    if (options.expectedByteLength !== undefined && fdStat.size !== options.expectedByteLength) {
      throw new EvolutionError(
        'ARTIFACT_INVALID',
        `artifact byteLength mismatch on fd stat: ${filePath}`,
        filePath,
      );
    }

    const buf = Buffer.alloc(fdStat.size);
    let offset = 0;
    while (offset < fdStat.size) {
      const res = await handle.read(buf, offset, fdStat.size - offset, offset);
      if (res.bytesRead === 0) break;
      offset += res.bytesRead;
    }
    if (offset !== fdStat.size) {
      throw new EvolutionError('ARTIFACT_INVALID', `incomplete read for artifact: ${filePath}`, filePath);
    }
    if (options.expectedSha256Hex !== undefined) {
      const observedHex = sha256Hex(buf);
      if (observedHex !== options.expectedSha256Hex) {
        throw new EvolutionError(
          'ARTIFACT_INVALID',
          `artifact SHA-256 mismatch (expected ${options.expectedSha256Hex}, observed ${observedHex}): ${filePath}`,
          filePath,
        );
      }
    }
    return buf;
  } finally {
    await handle.close();
  }
}

async function readVerifiedCasBlob(
  campaignRoot: string,
  digestHex: string,
  options: {
    readonly expectedByteLength?: number;
    readonly maxBytes: number;
  },
): Promise<Buffer> {
  if (!SHA256_HEX_RE.test(digestHex)) {
    throw new EvolutionError('ARTIFACT_INVALID', `invalid CAS sha256 hex "${digestHex}"`);
  }
  await verifyNonSymlinkDirectoryFd(campaignRoot);
  const casDir = join(campaignRoot, 'cas');
  const shaDir = join(casDir, 'sha256');
  await verifyNonSymlinkDirectoryFd(casDir);
  await verifyNonSymlinkDirectoryFd(shaDir);

  const blobPath = join(shaDir, digestHex);
  return readVerifiedRegularFileNoFollow(blobPath, {
    expectedSha256Hex: digestHex,
    ...(options.expectedByteLength !== undefined ? { expectedByteLength: options.expectedByteLength } : {}),
    maxBytes: options.maxBytes,
    missingCode: 'ARTIFACT_MISSING',
  });
}

async function writeNewFileNoFollow(filePath: string, bytes: Uint8Array, mode = 0o644): Promise<void> {
  const noFollow = 'O_NOFOLLOW' in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(
    filePath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | noFollow,
    mode,
  );
  try {
    let written = 0;
    while (written < bytes.byteLength) {
      const res = await handle.write(bytes, written, bytes.byteLength - written, written);
      if (res.bytesWritten <= 0) {
        throw new EvolutionError('EVOLUTION_STORE_ERROR', `short write staging file ${filePath}`, filePath);
      }
      written += res.bytesWritten;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function expectRecord(
  value: NullProtoJson | undefined,
  allowedKeys: ReadonlySet<string>,
  requiredKeys: readonly string[],
  code: 'ARTIFACT_INVALID' | 'EXPORT_UNVERIFIED_FORBIDDEN',
  diagPath: string,
): Record<string, NullProtoJson> {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new EvolutionError(code, 'expected object record', diagPath);
  }
  const obj = value as Record<string, NullProtoJson>;
  for (const key of Object.keys(obj)) {
    if (!Object.hasOwn(obj, key)) continue;
    if (FORBIDDEN_PROTOTYPE_KEYS.has(key) || !allowedKeys.has(key)) {
      throw new EvolutionError(code, `unknown or forbidden field "${key}"`, `${diagPath}/${key}`);
    }
  }
  for (const req of requiredKeys) {
    if (!Object.hasOwn(obj, req) || obj[req] === undefined) {
      throw new EvolutionError(code, `missing required field "${req}"`, `${diagPath}/${req}`);
    }
  }
  return obj;
}

function parseDigestValue(
  value: NullProtoJson | undefined,
  code: 'ARTIFACT_INVALID' | 'EXPORT_UNVERIFIED_FORBIDDEN',
  diagPath: string,
): Digest {
  const obj = expectRecord(value, new Set(['algorithm', 'hex']), ['algorithm', 'hex'], code, diagPath);
  if (obj['algorithm'] !== 'sha256') {
    throw new EvolutionError(code, 'digest algorithm must be "sha256"', `${diagPath}/algorithm`);
  }
  if (typeof obj['hex'] !== 'string' || !SHA256_HEX_RE.test(obj['hex'])) {
    throw new EvolutionError(code, 'digest hex must be 64 lowercase hex characters', `${diagPath}/hex`);
  }
  return makeDigest(obj['hex']);
}

function parseReceiptOutputArtifacts(
  raw: NullProtoJson | undefined,
  maxBlobBytes: number,
  diagPath: string,
): readonly BenchmarkOutputArtifact[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > LIMITS.manifest) {
    throw new EvolutionError('ARTIFACT_INVALID', 'receipt outputArtifacts must be a bounded array', diagPath);
  }
  const seenNames = new Set<string>();
  const out: BenchmarkOutputArtifact[] = [];
  for (let i = 0; i < raw.length; i++) {
    const itemPath = `${diagPath}/${i}`;
    const obj = expectRecord(raw[i], ARTIFACT_ENTRY_KEYS, ['name', 'digest', 'byteLength'], 'ARTIFACT_INVALID', itemPath);
    const rawName = obj['name'];
    if (typeof rawName !== 'string' || rawName.length < 1 || rawName.length > LIMITS.path) {
      throw new EvolutionError('ARTIFACT_INVALID', 'invalid artifact name', `${itemPath}/name`);
    }
    const validRel = validateRelativePath(rawName);
    if (!validRel.ok) {
      throw new EvolutionError('ARTIFACT_INVALID', `invalid artifact relative path "${rawName}"`, `${itemPath}/name`);
    }
    if (seenNames.has(validRel.value)) {
      throw new EvolutionError('ARTIFACT_INVALID', `duplicate receipt outputArtifact "${validRel.value}"`, `${itemPath}/name`);
    }
    seenNames.add(validRel.value);

    const digest = parseDigestValue(obj['digest'], 'ARTIFACT_INVALID', `${itemPath}/digest`);
    const byteLength = obj['byteLength'];
    if (
      typeof byteLength !== 'number'
      || !Number.isSafeInteger(byteLength)
      || Object.is(byteLength, -0)
      || byteLength < 0
      || byteLength > maxBlobBytes
    ) {
      throw new EvolutionError('ARTIFACT_INVALID', 'invalid artifact byteLength', `${itemPath}/byteLength`);
    }

    const entry = createNullRecord<{
      name: string;
      digest: Digest;
      byteLength: number;
      mediaType?: string | null;
    }>();
    entry.name = validRel.value;
    entry.digest = digest;
    entry.byteLength = byteLength;
    if (Object.hasOwn(obj, 'mediaType') && obj['mediaType'] !== undefined) {
      if (obj['mediaType'] === null) {
        entry.mediaType = null;
      } else if (
        typeof obj['mediaType'] === 'string'
        && obj['mediaType'].length >= 1
        && obj['mediaType'].length <= LIMITS.mediaType
        && PRINTABLE_ASCII_RE.test(obj['mediaType'])
      ) {
        entry.mediaType = obj['mediaType'];
      } else {
        throw new EvolutionError('ARTIFACT_INVALID', 'invalid artifact mediaType', `${itemPath}/mediaType`);
      }
    }
    out.push(entry as BenchmarkOutputArtifact);
  }
  return out;
}

function isTextualArtifact(name: string, mediaType: string | null | undefined): boolean {
  const lowerName = name.toLowerCase();
  if (TEXT_ARTIFACT_EXTENSIONS.some(ext => lowerName.endsWith(ext))) {
    return true;
  }
  if (typeof mediaType === 'string') {
    const lowerMt = mediaType.toLowerCase();
    if (lowerMt.startsWith('text/') || lowerMt.includes('json') || lowerMt.includes('yaml')) {
      return true;
    }
  }
  return false;
}

function inferBlobMediaType(name: string, declaredMediaType?: string | null): string {
  if (
    typeof declaredMediaType === 'string'
    && declaredMediaType.length >= 1
    && declaredMediaType.length <= LIMITS.mediaType
    && PRINTABLE_ASCII_RE.test(declaredMediaType)
  ) {
    return declaredMediaType;
  }
  const lower = name.toLowerCase();
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'application/yaml';
  if (lower.endsWith('.cubin')) return 'application/x-nvidia-cubin';
  if (lower.endsWith('.ptx')) return 'text/x-ptx';
  if (lower.endsWith('.so')) return 'application/x-sharedlib';
  if (lower.endsWith('.o')) return 'application/x-object';
  return EVOLUTION_BLOB_DEFAULT_MEDIA_TYPE;
}

async function parseAndVerifyReceiptBytes(
  rawBytes: Buffer,
  options: {
    readonly individualId: string;
    readonly expectedLockHash?: Digest;
    readonly expectedTargetCellId?: string;
    readonly allowSyntheticProbe: boolean;
    readonly receiptSigningSecret?: string;
    readonly verifyReceiptSignature?: ReceiptSignatureVerifier;
    readonly scrubber: SecretScrubber;
    readonly maxBlobBytes: number;
  },
): Promise<ParsedReceiptBundle> {
  const diagPath = `/receipts/${options.individualId}`;
  if (rawBytes.byteLength === 0 || rawBytes.byteLength > MAX_RECEIPT_FILE_BYTES) {
    throw new EvolutionError(
      'ARTIFACT_INVALID',
      `receipt exceeds bounds (1..${MAX_RECEIPT_FILE_BYTES} bytes) for ${options.individualId}`,
      diagPath,
    );
  }
  const text = decodeUtf8Strict(rawBytes, diagPath);
  assertCleanSecretText(text, options.scrubber, diagPath);

  let parsedRaw: NullProtoJson;
  try {
    parsedRaw = parseNullProtoJson(text, MAX_RECEIPT_FILE_BYTES, diagPath);
  } catch (err: unknown) {
    if (err instanceof EvolutionError) {
      throw new EvolutionError('ARTIFACT_INVALID', `malformed verdict receipt JSON: ${err.message}`, diagPath);
    }
    throw err;
  }

  const obj = expectRecord(
    parsedRaw,
    RECEIPT_ALLOWED_KEYS,
    RECEIPT_REQUIRED_KEYS,
    'ARTIFACT_INVALID',
    diagPath,
  );

  if (obj['version'] !== 1 || obj['kind'] !== 'benchmark_verdict') {
    throw new EvolutionError('ARTIFACT_INVALID', 'receipt must have version: 1 and kind: "benchmark_verdict"', diagPath);
  }
  if (typeof obj['storeId'] !== 'string' || !SAFE_ID_RE.test(obj['storeId'])) {
    throw new EvolutionError('ARTIFACT_INVALID', 'invalid receipt storeId', `${diagPath}/storeId`);
  }
  if (typeof obj['runId'] !== 'string' || obj['runId'].length < 1 || obj['runId'].length > LIMITS.identifier) {
    throw new EvolutionError('ARTIFACT_INVALID', 'invalid receipt runId', `${diagPath}/runId`);
  }
  if (typeof obj['operationId'] !== 'string' || !SAFE_FILENAME_ID_RE.test(obj['operationId'])) {
    throw new EvolutionError('ARTIFACT_INVALID', 'invalid receipt operationId', `${diagPath}/operationId`);
  }
  if (typeof obj['dispatchId'] !== 'string' || !SAFE_ID_RE.test(obj['dispatchId'])) {
    throw new EvolutionError('ARTIFACT_INVALID', 'invalid receipt dispatchId', `${diagPath}/dispatchId`);
  }
  if (
    typeof obj['dispatchGeneration'] !== 'number'
    || !Number.isSafeInteger(obj['dispatchGeneration'])
    || Object.is(obj['dispatchGeneration'], -0)
    || obj['dispatchGeneration'] < 0
  ) {
    throw new EvolutionError('ARTIFACT_INVALID', 'invalid receipt dispatchGeneration', `${diagPath}/dispatchGeneration`);
  }
  if (typeof obj['gateId'] !== 'string' || obj['gateId'].length < 1 || obj['gateId'].length > 128 || !PRINTABLE_ASCII_RE.test(obj['gateId'])) {
    throw new EvolutionError('ARTIFACT_INVALID', 'invalid receipt gateId', `${diagPath}/gateId`);
  }
  if (typeof obj['checkId'] !== 'string' || obj['checkId'].length < 1 || obj['checkId'].length > LIMITS.identifier) {
    throw new EvolutionError('ARTIFACT_INVALID', 'invalid receipt checkId', `${diagPath}/checkId`);
  }
  if (typeof obj['candidateDigest'] !== 'string' || !SHA256_HEX_RE.test(obj['candidateDigest'])) {
    throw new EvolutionError('ARTIFACT_INVALID', 'invalid receipt candidateDigest', `${diagPath}/candidateDigest`);
  }
  if (typeof obj['expiresAtMs'] !== 'string' || !/^(?:0|[1-9][0-9]{0,17})$/.test(obj['expiresAtMs'])) {
    throw new EvolutionError('ARTIFACT_INVALID', 'invalid receipt expiresAtMs', `${diagPath}/expiresAtMs`);
  }
  if (
    typeof obj['preemptionCount'] !== 'number'
    || !Number.isSafeInteger(obj['preemptionCount'])
    || Object.is(obj['preemptionCount'], -0)
    || obj['preemptionCount'] < 0
    || obj['preemptionCount'] > 16
  ) {
    throw new EvolutionError('ARTIFACT_INVALID', 'invalid receipt preemptionCount', `${diagPath}/preemptionCount`);
  }

  const lockHash = parseDigestValue(obj['lockHash'], 'ARTIFACT_INVALID', `${diagPath}/lockHash`);
  if (options.expectedLockHash !== undefined && lockHash.hex !== options.expectedLockHash.hex) {
    throw new EvolutionError(
      'EXPORT_UNVERIFIED_FORBIDDEN',
      `receipt lockHash mismatch for ${options.individualId}`,
      `${diagPath}/lockHash`,
    );
  }

  const signature = obj['signature'];
  if (typeof signature !== 'string' || !SHA256_HEX_RE.test(signature)) {
    throw new EvolutionError(
      'EXPORT_UNVERIFIED_FORBIDDEN',
      `receipt missing valid HMAC signature for ${options.individualId}`,
      `${diagPath}/signature`,
    );
  }

  if (options.receiptSigningSecret !== undefined) {
    const validHmac = verifyBenchmarkVerdictSignature(
      options.receiptSigningSecret,
      obj as Readonly<Record<string, unknown>>,
      signature,
    );
    if (!validHmac) {
      throw new EvolutionError(
        'EXPORT_UNVERIFIED_FORBIDDEN',
        `verdict receipt HMAC verification failed for ${options.individualId}`,
        `${diagPath}/signature`,
      );
    }
  }

  if (options.verifyReceiptSignature !== undefined) {
    const verifiedByCallback = await options.verifyReceiptSignature(
      obj as unknown as SignedBenchmarkVerdictReceipt,
      rawBytes,
      options.individualId,
    );
    if (!verifiedByCallback) {
      throw new EvolutionError(
        'EXPORT_UNVERIFIED_FORBIDDEN',
        `verdict receipt signature verifier rejected ${options.individualId}`,
        `${diagPath}/signature`,
      );
    }
  }

  const status = obj['status'];
  if (status !== 'approved') {
    throw new EvolutionError(
      'EXPORT_UNVERIFIED_FORBIDDEN',
      `verdict receipt status must be "approved" (got "${String(status)}") for ${options.individualId}`,
      `${diagPath}/status`,
    );
  }
  if (obj['reason'] !== null) {
    throw new EvolutionError(
      'EXPORT_UNVERIFIED_FORBIDDEN',
      `approved verdict receipt must have null reason for ${options.individualId}`,
      `${diagPath}/reason`,
    );
  }

  if (!Object.hasOwn(obj, 'hardwareProvenance') || obj['hardwareProvenance'] === undefined) {
    throw new EvolutionError(
      'EXPORT_UNVERIFIED_FORBIDDEN',
      `verdict receipt missing hardwareProvenance for ${options.individualId}`,
      `${diagPath}/hardwareProvenance`,
    );
  }

  let provenance: HardwareProvenance;
  try {
    provenance = parseHardwareProvenanceJson(
      obj['hardwareProvenance'] as unknown as HardwareProvenance,
      `${diagPath}/hardwareProvenance`,
    );
  } catch (err: unknown) {
    throw new EvolutionError(
      'EXPORT_UNVERIFIED_FORBIDDEN',
      `invalid hardwareProvenance on receipt for ${options.individualId}: ${err instanceof Error ? err.message : String(err)}`,
      `${diagPath}/hardwareProvenance`,
    );
  }

  if (options.expectedTargetCellId !== undefined && provenance.targetCellId !== options.expectedTargetCellId) {
    throw new EvolutionError(
      'EXPORT_UNVERIFIED_FORBIDDEN',
      `receipt targetCellId "${provenance.targetCellId}" does not match campaign targetCellId "${options.expectedTargetCellId}"`,
      `${diagPath}/hardwareProvenance/targetCellId`,
    );
  }

  if (provenance.probeKind !== 'physical' && !options.allowSyntheticProbe) {
    throw new EvolutionError(
      'EXPORT_UNVERIFIED_FORBIDDEN',
      `refusing to export "${provenance.probeKind}" hardware receipt for ${options.individualId} without allowSyntheticProbe: true`,
      `${diagPath}/hardwareProvenance/probeKind`,
    );
  }

  const outputArtifacts = parseReceiptOutputArtifacts(
    obj['outputArtifacts'],
    options.maxBlobBytes,
    `${diagPath}/outputArtifacts`,
  );

  let bucketMetrics: readonly BucketMetricEntry[] | undefined;
  if (Object.hasOwn(obj, 'bucketMetrics') && obj['bucketMetrics'] !== undefined) {
    bucketMetrics = parseBucketMetricsJson(
      obj['bucketMetrics'] as unknown as readonly BucketMetricEntry[],
      options.scrubber,
    );
  }

  let hardwareDiagnostics: HardwareDiagnostics | undefined;
  if (Object.hasOwn(obj, 'hardwareDiagnostics') && obj['hardwareDiagnostics'] !== undefined) {
    hardwareDiagnostics = parseHardwareDiagnosticsJson(
      obj['hardwareDiagnostics'] as unknown as HardwareDiagnostics,
      options.scrubber,
    );
  }

  let heldOutWorkloadId: string | undefined;
  if (Object.hasOwn(obj, 'heldOutWorkloadId') && obj['heldOutWorkloadId'] !== undefined) {
    const rawWl = obj['heldOutWorkloadId'];
    if (typeof rawWl !== 'string' || !BUCKET_ID_RE.test(rawWl) || rawWl.length > LIMITS.bucketId) {
      throw new EvolutionError('ARTIFACT_INVALID', 'invalid heldOutWorkloadId on receipt', `${diagPath}/heldOutWorkloadId`);
    }
    heldOutWorkloadId = rawWl;
  }

  return {
    receipt: obj as unknown as SignedBenchmarkVerdictReceipt,
    rawBytes,
    rawDigest: makeDigest(sha256Hex(rawBytes)),
    provenance,
    outputArtifacts,
    ...(bucketMetrics !== undefined ? { bucketMetrics } : {}),
    ...(hardwareDiagnostics !== undefined ? { hardwareDiagnostics } : {}),
    ...(heldOutWorkloadId !== undefined ? { heldOutWorkloadId } : {}),
  };
}

function assertCompatibleHardwareProvenance(
  base: HardwareProvenance,
  other: HardwareProvenance,
  requireSameWorkloadDigest: boolean,
  individualId: string,
): void {
  if (
    base.accelerator !== other.accelerator
    || base.isolationMode !== other.isolationMode
    || base.deviceCount !== other.deviceCount
    || base.driverVersion !== other.driverVersion
    || base.runtimeVersion !== other.runtimeVersion
    || (base.topology ?? null) !== (other.topology ?? null)
  ) {
    throw new EvolutionError(
      'ARTIFACT_INVALID',
      `selected individual "${individualId}" has incompatible hardwareProvenance compared to bundle compatibility tuple`,
    );
  }
  if (requireSameWorkloadDigest && base.workloadDigest.hex !== other.workloadDigest.hex) {
    throw new EvolutionError(
      'ARTIFACT_INVALID',
      `selected individual "${individualId}" has mismatched workloadDigest in single-target export`,
    );
  }
}

function assertIndividualArtifactsBoundToReceipt(
  individual: IndividualRecord,
  receiptArtifacts: readonly BenchmarkOutputArtifact[],
): void {
  if (individual.outputArtifacts.length === 0) return;
  const byDigest = new Map<string, number>();
  for (const art of receiptArtifacts) {
    byDigest.set(art.digest.hex, art.byteLength);
  }
  for (const ref of individual.outputArtifacts) {
    const expectedLen = byDigest.get(ref.digest.hex);
    if (expectedLen === undefined || expectedLen !== ref.byteLength) {
      throw new EvolutionError(
        'ARTIFACT_INVALID',
        `individual "${individual.individualId}" outputArtifact "${ref.name}" does not match signed verdict receipt`,
      );
    }
  }
}

function comparePortfolioCandidateBetter(a: IndividualRecord, b: IndividualRecord): number {
  const rankA = a.paretoRank ?? Number.MAX_SAFE_INTEGER;
  const rankB = b.paretoRank ?? Number.MAX_SAFE_INTEGER;
  if (rankA !== rankB) return rankA - rankB;
  const fitA = a.scalarFitness ?? Number.NEGATIVE_INFINITY;
  const fitB = b.scalarFitness ?? Number.NEGATIVE_INFINITY;
  if (fitA !== fitB) return fitB - fitA;
  return compareUtf16(a.individualId, b.individualId);
}

function isPortfolioCandidate(ind: IndividualRecord, portfolioHeldOutWorkloadId: string): boolean {
  return ind.mutationKind === 'portfolio' || ind.bucketId === portfolioHeldOutWorkloadId;
}

function selectPrimaryArtifactForRule(
  artifacts: readonly BenchmarkOutputArtifact[],
): BenchmarkOutputArtifact | null {
  if (artifacts.length === 0) return null;
  const sorted = [...artifacts].sort((a, b) => {
    const aBin = BINARY_ARTIFACT_EXTENSIONS.some(ext => a.name.toLowerCase().endsWith(ext)) ? 0 : 1;
    const bBin = BINARY_ARTIFACT_EXTENSIONS.some(ext => b.name.toLowerCase().endsWith(ext)) ? 0 : 1;
    if (aBin !== bBin) return aBin - bBin;
    const nameCmp = compareUtf16(a.name, b.name);
    if (nameCmp !== 0) return nameCmp;
    return compareUtf16(a.digest.hex, b.digest.hex);
  });
  return sorted[0]!;
}

function deriveRulePredicatesFromBucketEntry(
  entry: BucketMetricEntry,
): {
  readonly dimensionBounds?: Readonly<Record<string, DispatchDimensionRange>>;
  readonly dtypes?: readonly string[];
} {
  if (entry.dimensions === undefined) return {};
  const bounds = createNullRecord<Record<string, DispatchDimensionRange>>();
  let hasBound = false;
  let dtypes: string[] | undefined;

  for (const key of Object.keys(entry.dimensions).sort(compareUtf16)) {
    if (!Object.hasOwn(entry.dimensions, key)) continue;
    const val = entry.dimensions[key];
    if (typeof val === 'number' && Number.isFinite(val) && !Object.is(val, -0)) {
      const range = createNullRecord<{ min: number; max: number }>();
      range.min = val;
      range.max = val;
      bounds[key] = range;
      hasBound = true;
    } else if (key === 'dtype' && typeof val === 'string' && DTYPE_TOKEN_RE.test(val)) {
      dtypes = [val];
    }
  }

  return {
    ...(hasBound ? { dimensionBounds: bounds } : {}),
    ...(dtypes !== undefined ? { dtypes } : {}),
  };
}

function synthesizeDispatchManifest(
  campaign: CampaignRecord,
  selectedIndividuals: readonly IndividualRecord[],
  receiptsByIndividualId: ReadonlyMap<string, ParsedReceiptBundle>,
  defaultEntrypoint: string,
  scrubber: SecretScrubber,
): DispatchManifestV1 {
  const orderedIndividuals = [...selectedIndividuals].sort((a, b) => {
    const aHasBucket = a.bucketId !== null ? 0 : 1;
    const bHasBucket = b.bucketId !== null ? 0 : 1;
    if (aHasBucket !== bHasBucket) return aHasBucket - bHasBucket;
    const bucketCmp = compareUtf16(a.bucketId ?? '', b.bucketId ?? '');
    if (bucketCmp !== 0) return bucketCmp;
    const rankA = a.paretoRank ?? Number.MAX_SAFE_INTEGER;
    const rankB = b.paretoRank ?? Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) return rankA - rankB;
    return compareUtf16(a.individualId, b.individualId);
  });

  const rules: DispatchRuleV1[] = [];
  const seenRuleKey = new Set<string>();

  for (const ind of orderedIndividuals) {
    const receiptBundle = receiptsByIndividualId.get(ind.individualId);
    if (!receiptBundle) continue;
    const primaryArt = selectPrimaryArtifactForRule(receiptBundle.outputArtifacts);
    if (!primaryArt) continue;

    const buckets = ind.bucketMetrics ?? receiptBundle.bucketMetrics;
    if (ind.bucketId !== null) {
      const matchingBucket = buckets?.find(b => b.bucketId === ind.bucketId);
      const predicates = matchingBucket ? deriveRulePredicatesFromBucketEntry(matchingBucket) : {};
      const key = `${ind.bucketId}:${primaryArt.digest.hex}`;
      if (!seenRuleKey.has(key)) {
        seenRuleKey.add(key);
        const rule = createNullRecord<{
          bucketId: string;
          dimensionBounds?: Readonly<Record<string, DispatchDimensionRange>>;
          dtypes?: readonly string[];
          blobDigest: Digest;
          blobPath: string;
          entrypoint: string;
        }>();
        rule.bucketId = ind.bucketId;
        if (predicates.dimensionBounds !== undefined) rule.dimensionBounds = predicates.dimensionBounds;
        if (predicates.dtypes !== undefined) rule.dtypes = predicates.dtypes;
        rule.blobDigest = primaryArt.digest;
        rule.blobPath = `blobs/sha256/${primaryArt.digest.hex}`;
        rule.entrypoint = defaultEntrypoint;
        rules.push(rule as DispatchRuleV1);
      }
    } else if (buckets !== undefined && buckets.length > 0) {
      const sortedBuckets = [...buckets].sort((a, b) => compareUtf16(a.bucketId, b.bucketId));
      for (const bEntry of sortedBuckets) {
        const key = `${bEntry.bucketId}:${primaryArt.digest.hex}`;
        if (seenRuleKey.has(key)) continue;
        seenRuleKey.add(key);
        const predicates = deriveRulePredicatesFromBucketEntry(bEntry);
        const rule = createNullRecord<{
          bucketId: string;
          dimensionBounds?: Readonly<Record<string, DispatchDimensionRange>>;
          dtypes?: readonly string[];
          blobDigest: Digest;
          blobPath: string;
          entrypoint: string;
        }>();
        rule.bucketId = bEntry.bucketId;
        if (predicates.dimensionBounds !== undefined) rule.dimensionBounds = predicates.dimensionBounds;
        if (predicates.dtypes !== undefined) rule.dtypes = predicates.dtypes;
        rule.blobDigest = primaryArt.digest;
        rule.blobPath = `blobs/sha256/${primaryArt.digest.hex}`;
        rule.entrypoint = defaultEntrypoint;
        rules.push(rule as DispatchRuleV1);
      }
    } else {
      const fallbackBucket = campaign.manifest.spec.targetCellId;
      const key = `${fallbackBucket}:${primaryArt.digest.hex}`;
      if (!seenRuleKey.has(key)) {
        seenRuleKey.add(key);
        const rule = createNullRecord<{
          bucketId: string;
          blobDigest: Digest;
          blobPath: string;
          entrypoint: string;
        }>();
        rule.bucketId = fallbackBucket;
        rule.blobDigest = primaryArt.digest;
        rule.blobPath = `blobs/sha256/${primaryArt.digest.hex}`;
        rule.entrypoint = defaultEntrypoint;
        rules.push(rule as DispatchRuleV1);
      }
    }
  }

  if (rules.length === 0) {
    throw new EvolutionError(
      'ARTIFACT_MISSING',
      'no verified Stage A output artifacts available to synthesize dispatch-manifest.json',
    );
  }
  if (rules.length > DISPATCH_MANIFEST_MAX_RULES) {
    throw new EvolutionError(
      'EVOLUTION_SCHEMA_INVALID',
      `synthesized dispatch-manifest.json exceeds ${DISPATCH_MANIFEST_MAX_RULES} rules`,
    );
  }

  const rawManifest = createNullRecord<{
    version: 1;
    fallback: 'baseline';
    rules: readonly DispatchRuleV1[];
  }>();
  rawManifest.version = 1;
  rawManifest.fallback = 'baseline';
  rawManifest.rules = rules;
  return parseDispatchManifestV1(rawManifest, { scrubber });
}

function normalizeAndVerifyDispatchManifest(
  input: DispatchManifestV1 | string | Uint8Array,
  verifiedBlobsByHex: ReadonlyMap<string, VerifiedStageABlob>,
  scrubber: SecretScrubber,
): DispatchManifestV1 {
  const parsed = parseDispatchManifestV1(input, { scrubber });
  const normalizedRules: DispatchRuleV1[] = [];

  for (let i = 0; i < parsed.rules.length; i++) {
    const rule = parsed.rules[i]!;
    if (!verifiedBlobsByHex.has(rule.blobDigest.hex)) {
      throw new EvolutionError(
        'ARTIFACT_INVALID',
        `dispatch rule ${i} references unverified blob digest ${rule.blobDigest.hex}`,
        `/dispatchManifest/rules/${i}/blobDigest`,
      );
    }
    const normalized = createNullRecord<{
      bucketId: string;
      dimensionBounds?: Readonly<Record<string, DispatchDimensionRange>>;
      dtypes?: readonly string[];
      alignmentBytes?: number;
      blobDigest: Digest;
      blobPath: string;
      entrypoint: string;
    }>();
    normalized.bucketId = rule.bucketId;
    if (rule.dimensionBounds !== undefined) normalized.dimensionBounds = rule.dimensionBounds;
    if (rule.dtypes !== undefined) normalized.dtypes = rule.dtypes;
    if (rule.alignmentBytes !== undefined) normalized.alignmentBytes = rule.alignmentBytes;
    normalized.blobDigest = rule.blobDigest;
    normalized.blobPath = `blobs/sha256/${rule.blobDigest.hex}`;
    normalized.entrypoint = rule.entrypoint;
    normalizedRules.push(normalized as DispatchRuleV1);
  }

  const out = createNullRecord<{
    version: 1;
    fallback: 'baseline';
    rules: readonly DispatchRuleV1[];
  }>();
  out.version = 1;
  out.fallback = 'baseline';
  out.rules = normalizedRules;
  return parseDispatchManifestV1(out, { scrubber });
}

function buildCompatibilityTuple(
  anchorProvenance: HardwareProvenance,
  options: ExportEvolutionBundleOptions,
  scrubber: SecretScrubber,
): BundleCompatibilityTuple {
  const compat = createNullRecord<{
    accelerator: string;
    isolationMode: 'whole_device' | 'sliced';
    deviceCount: number;
    driverVersion: string;
    driverConstraint?: string;
    runtimeVersion: string;
    topology?: string;
    workloadDigest: Digest;
    modelDigest?: Digest;
    parallelismTags?: readonly string[];
  }>();

  compat.accelerator = anchorProvenance.accelerator;
  compat.isolationMode = anchorProvenance.isolationMode;
  compat.deviceCount = anchorProvenance.deviceCount;
  compat.driverVersion = anchorProvenance.driverVersion;

  if (options.driverConstraint !== undefined) {
    if (
      typeof options.driverConstraint !== 'string'
      || options.driverConstraint.length < 1
      || options.driverConstraint.length > 128
      || !PRINTABLE_ASCII_RE.test(options.driverConstraint)
    ) {
      throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'invalid driverConstraint', '/driverConstraint');
    }
    assertCleanSecretText(options.driverConstraint, scrubber, '/driverConstraint');
    compat.driverConstraint = options.driverConstraint;
  }

  compat.runtimeVersion = anchorProvenance.runtimeVersion;
  if (anchorProvenance.topology !== undefined) {
    compat.topology = anchorProvenance.topology;
  }
  compat.workloadDigest = makeDigest(anchorProvenance.workloadDigest.hex);

  if (options.modelDigest !== undefined) {
    if (options.modelDigest.algorithm !== 'sha256' || !SHA256_HEX_RE.test(options.modelDigest.hex)) {
      throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'invalid modelDigest', '/modelDigest');
    }
    compat.modelDigest = makeDigest(options.modelDigest.hex);
  }

  if (options.parallelismTags !== undefined) {
    if (options.parallelismTags.length > 16) {
      throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'parallelismTags cannot exceed 16 entries', '/parallelismTags');
    }
    const deduped = new Set<string>();
    for (let i = 0; i < options.parallelismTags.length; i++) {
      const tag = options.parallelismTags[i]!;
      if (typeof tag !== 'string' || tag.length < 1 || tag.length > 64 || !PRINTABLE_ASCII_RE.test(tag)) {
        throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', `invalid parallelism tag "${String(tag)}"`, `/parallelismTags/${i}`);
      }
      assertCleanSecretText(tag, scrubber, `/parallelismTags/${i}`);
      deduped.add(tag);
    }
    compat.parallelismTags = [...deduped].sort(compareUtf16);
  }

  return compat as BundleCompatibilityTuple;
}

function buildParetoSummary(
  campaign: CampaignRecord,
  selectedIndividuals: readonly IndividualRecord[],
  receiptsByIndividualId: ReadonlyMap<string, ParsedReceiptBundle>,
): readonly BundleParetoEntry[] {
  const rankByIndividualId = new Map<string, number>();
  const needsRanking = selectedIndividuals.some(ind => ind.paretoRank === null);

  if (needsRanking) {
    const rankable = selectedIndividuals.filter(ind =>
      campaign.manifest.spec.objectives.every(obj => Object.hasOwn(ind.metrics, obj.metric)),
    );
    if (rankable.length > 0) {
      const ranked = computeNsga2Ranking(
        rankable.map(ind => ({ individualId: ind.individualId, metrics: ind.metrics })),
        campaign.manifest.spec.objectives,
      );
      for (const r of ranked) {
        rankByIndividualId.set(r.individualId, r.paretoRank);
      }
    }
  }

  const summary: BundleParetoEntry[] = selectedIndividuals.map(ind => {
    const receiptBundle = receiptsByIndividualId.get(ind.individualId);
    const rawBuckets = ind.bucketMetrics ?? receiptBundle?.bucketMetrics;
    const sortedBuckets = rawBuckets !== undefined
      ? [...rawBuckets].sort((a, b) => compareUtf16(a.bucketId, b.bucketId))
      : undefined;
    const diagnostics = ind.hardwareDiagnostics ?? receiptBundle?.hardwareDiagnostics;

    const entry = createNullRecord<{
      individualId: string;
      paretoRank: number;
      nicheKey: string | null;
      metrics: Readonly<Record<string, number>>;
      bucketMetrics?: readonly BucketMetricEntry[];
      hardwareDiagnostics?: HardwareDiagnostics;
    }>();
    entry.individualId = ind.individualId;
    entry.paretoRank = ind.paretoRank ?? rankByIndividualId.get(ind.individualId) ?? 1;
    entry.nicheKey = ind.nicheKey;
    entry.metrics = ind.metrics;
    if (sortedBuckets !== undefined) entry.bucketMetrics = sortedBuckets;
    if (diagnostics !== undefined) entry.hardwareDiagnostics = diagnostics;
    return entry as BundleParetoEntry;
  });

  summary.sort((a, b) => {
    if (a.paretoRank !== b.paretoRank) return a.paretoRank - b.paretoRank;
    return compareUtf16(a.individualId, b.individualId);
  });

  return summary;
}

interface OciDescriptor {
  readonly mediaType: string;
  readonly digest: string;
  readonly size: number;
  readonly artifactType?: string;
  readonly annotations?: Readonly<Record<string, string>>;
}

interface OciLayoutArtifacts {
  readonly ociLayoutBytes: Buffer;
  readonly ociIndexBytes: Buffer;
  readonly ociIndexDigest: Digest;
  readonly extraBlobsByHex: ReadonlyMap<string, Buffer>;
}

function buildOciLayoutArtifacts(params: {
  readonly campaign: CampaignRecord;
  readonly compatibility: BundleCompatibilityTuple;
  readonly manifestBytes: Buffer;
  readonly manifestDigest: Digest;
  readonly dispatchBytes: Buffer;
  readonly dispatchDigest: Digest;
  readonly receipts: readonly { readonly relPath: string; readonly bytes: Buffer; readonly digest: Digest }[];
  readonly stageABlobs: readonly { readonly relPath: string; readonly bytes: Buffer; readonly digest: Digest; readonly mediaType: string }[];
}): OciLayoutArtifacts {
  const extraBlobsByHex = new Map<string, Buffer>();

  const emptyConfigBytes = Buffer.from('{}', 'utf8');
  const emptyConfigHex = sha256Hex(emptyConfigBytes);
  extraBlobsByHex.set(emptyConfigHex, emptyConfigBytes);

  extraBlobsByHex.set(params.manifestDigest.hex, params.manifestBytes);
  extraBlobsByHex.set(params.dispatchDigest.hex, params.dispatchBytes);
  for (const rec of params.receipts) {
    extraBlobsByHex.set(rec.digest.hex, rec.bytes);
  }

  const layers: OciDescriptor[] = [];

  const makeLayer = (
    mediaType: string,
    digestHex: string,
    size: number,
    title: string,
  ): OciDescriptor => {
    const ann = createNullRecord<Record<string, string>>();
    ann['org.opencontainers.image.title'] = title;
    const desc = createNullRecord<{
      mediaType: string;
      digest: string;
      size: number;
      annotations: Readonly<Record<string, string>>;
    }>();
    desc.mediaType = mediaType;
    desc.digest = `sha256:${digestHex}`;
    desc.size = size;
    desc.annotations = ann;
    return desc;
  };

  layers.push(
    makeLayer(
      EVOLUTION_MANIFEST_MEDIA_TYPE,
      params.manifestDigest.hex,
      params.manifestBytes.byteLength,
      'manifest.json',
    ),
  );
  layers.push(
    makeLayer(
      EVOLUTION_DISPATCH_MANIFEST_MEDIA_TYPE,
      params.dispatchDigest.hex,
      params.dispatchBytes.byteLength,
      'dispatch-manifest.json',
    ),
  );
  for (const rec of params.receipts) {
    layers.push(
      makeLayer(
        EVOLUTION_RECEIPT_MEDIA_TYPE,
        rec.digest.hex,
        rec.bytes.byteLength,
        rec.relPath,
      ),
    );
  }
  for (const blob of params.stageABlobs) {
    layers.push(
      makeLayer(
        blob.mediaType,
        blob.digest.hex,
        blob.bytes.byteLength,
        blob.relPath,
      ),
    );
  }

  const configDesc = createNullRecord<{ mediaType: string; digest: string; size: number }>();
  configDesc.mediaType = OCI_EMPTY_CONFIG_MEDIA_TYPE;
  configDesc.digest = `sha256:${emptyConfigHex}`;
  configDesc.size = emptyConfigBytes.byteLength;

  const ociManifestAnnotations = createNullRecord<Record<string, string>>();
  ociManifestAnnotations['dev.loopwright.accelerator'] = params.compatibility.accelerator;
  ociManifestAnnotations['dev.loopwright.campaign.id'] = params.campaign.campaignId;
  ociManifestAnnotations['dev.loopwright.lock.hash'] = `sha256:${params.campaign.lockHash.hex}`;

  const ociManifestObj = createNullRecord<{
    schemaVersion: 2;
    mediaType: typeof OCI_IMAGE_MANIFEST_MEDIA_TYPE;
    artifactType: typeof EVOLUTION_BUNDLE_ARTIFACT_TYPE;
    config: OciDescriptor;
    layers: readonly OciDescriptor[];
    annotations: Readonly<Record<string, string>>;
  }>();
  ociManifestObj.schemaVersion = 2;
  ociManifestObj.mediaType = OCI_IMAGE_MANIFEST_MEDIA_TYPE;
  ociManifestObj.artifactType = EVOLUTION_BUNDLE_ARTIFACT_TYPE;
  ociManifestObj.config = configDesc;
  ociManifestObj.layers = layers;
  ociManifestObj.annotations = ociManifestAnnotations;

  const ociManifestBytes = Buffer.from(canonicalizeJson(ociManifestObj), 'utf8');
  const ociManifestHex = sha256Hex(ociManifestBytes);
  extraBlobsByHex.set(ociManifestHex, ociManifestBytes);

  const indexManifestAnnotations = createNullRecord<Record<string, string>>();
  indexManifestAnnotations['dev.loopwright.campaign.id'] = params.campaign.campaignId;
  indexManifestAnnotations['org.opencontainers.image.ref.name'] = params.campaign.name;

  const indexManifestDesc = createNullRecord<{
    mediaType: typeof OCI_IMAGE_MANIFEST_MEDIA_TYPE;
    artifactType: typeof EVOLUTION_BUNDLE_ARTIFACT_TYPE;
    digest: string;
    size: number;
    annotations: Readonly<Record<string, string>>;
  }>();
  indexManifestDesc.mediaType = OCI_IMAGE_MANIFEST_MEDIA_TYPE;
  indexManifestDesc.artifactType = EVOLUTION_BUNDLE_ARTIFACT_TYPE;
  indexManifestDesc.digest = `sha256:${ociManifestHex}`;
  indexManifestDesc.size = ociManifestBytes.byteLength;
  indexManifestDesc.annotations = indexManifestAnnotations;

  const ociIndexObj = createNullRecord<{
    schemaVersion: 2;
    mediaType: typeof OCI_IMAGE_INDEX_MEDIA_TYPE;
    manifests: readonly OciDescriptor[];
  }>();
  ociIndexObj.schemaVersion = 2;
  ociIndexObj.mediaType = OCI_IMAGE_INDEX_MEDIA_TYPE;
  ociIndexObj.manifests = [indexManifestDesc];

  const ociIndexBytes = Buffer.from(canonicalizeJson(ociIndexObj), 'utf8');
  const ociIndexDigest = makeDigest(sha256Hex(ociIndexBytes));

  const ociLayoutObj = createNullRecord<{ imageLayoutVersion: typeof OCI_IMAGE_LAYOUT_VERSION }>();
  ociLayoutObj.imageLayoutVersion = OCI_IMAGE_LAYOUT_VERSION;
  const ociLayoutBytes = Buffer.from(canonicalizeJson(ociLayoutObj), 'utf8');

  return {
    ociLayoutBytes,
    ociIndexBytes,
    ociIndexDigest,
    extraBlobsByHex,
  };
}

async function publishStagingDirectoryAtomically(
  stagingDir: string,
  targetDir: string,
  overwrite: boolean,
): Promise<void> {
  const existing = await lstat(targetDir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    if (err.code === 'ELOOP') {
      throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `symlink forbidden at outputDir: ${targetDir}`, targetDir);
    }
    throw err;
  });

  if (existing === null) {
    await rename(stagingDir, targetDir);
    return;
  }

  if (existing.isSymbolicLink()) {
    throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `outputDir cannot be a symlink: ${targetDir}`, targetDir);
  }
  if (!existing.isDirectory()) {
    throw new EvolutionError('ARTIFACT_INVALID', `outputDir exists and is not a directory: ${targetDir}`, targetDir);
  }
  if (!overwrite) {
    throw new EvolutionError('EVOLUTION_CONFLICT', `outputDir already exists: ${targetDir}`, targetDir);
  }

  const backupDir = join(dirname(targetDir), `.evolution-bundle-backup-${randomBytes(8).toString('hex')}`);
  await rename(targetDir, backupDir);
  try {
    await rename(stagingDir, targetDir);
  } catch (err) {
    await rename(backupDir, targetDir).catch(() => undefined);
    throw err;
  }
  await rm(backupDir, { recursive: true, force: true }).catch(async () => {
    await chmod(backupDir, 0o700).catch(() => undefined);
    await rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
  });
}

/**
 * Deterministically export verified, compatibility-pinned `evolution-bundle.v1` artifacts
 * (`dir` or `oci-layout`) after enforcing fail-closed hardware provenance, HMAC receipt,
 * portfolio holdout, CAS `O_NOFOLLOW`/`nlink === 1`/SHA-256, and `SecretScrubber` gates.
 */
export async function exportEvolutionBundle(
  options: ExportEvolutionBundleOptions,
): Promise<ExportEvolutionBundleResult> {
  if (!options || typeof options !== 'object') {
    throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'exportEvolutionBundle options must be an object');
  }
  const scrubber = options.scrubber ?? DEFAULT_SECRET_SCRUBBER;
  const allowSyntheticProbe = options.allowSyntheticProbe === true;
  const maxBlobBytes = options.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
  const overwrite = options.overwrite !== false;
  const defaultEntrypoint = options.defaultEntrypoint ?? DEFAULT_ENTRYPOINT_SYMBOL;

  if (!Number.isSafeInteger(maxBlobBytes) || maxBlobBytes < 1) {
    throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', 'maxBlobBytes must be a positive integer', '/maxBlobBytes');
  }

  const resolvedOutputDir = validateAbsoluteFilesystemPath(options.outputDir, 'outputDir');
  await assertNoSymlinkPath(resolvedOutputDir, { checkLeaf: true, diagPath: resolvedOutputDir });

  // Pre-check existing outputDir state before doing staging work
  const preOutStat = await lstat(resolvedOutputDir).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    if (err.code === 'ELOOP') {
      throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `symlink forbidden at outputDir: ${resolvedOutputDir}`, resolvedOutputDir);
    }
    throw err;
  });
  if (preOutStat !== null) {
    if (preOutStat.isSymbolicLink()) {
      throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `outputDir cannot be a symlink: ${resolvedOutputDir}`, resolvedOutputDir);
    }
    if (!preOutStat.isDirectory()) {
      throw new EvolutionError('ARTIFACT_INVALID', `outputDir exists and is not a directory: ${resolvedOutputDir}`, resolvedOutputDir);
    }
    if (!overwrite) {
      throw new EvolutionError('EVOLUTION_CONFLICT', `outputDir already exists: ${resolvedOutputDir}`, resolvedOutputDir);
    }
  }

  const campaign = await options.store.getCampaign(options.campaignId);
  if (!campaign) {
    throw new EvolutionError('EVOLUTION_NOT_FOUND', `campaign "${options.campaignId}" not found`, '/campaignId');
  }

  const format: EvolutionExportFormat = options.format ?? campaign.manifest.spec.export?.format ?? 'dir';
  if (format !== 'dir' && format !== 'oci-layout') {
    throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', `unsupported export format "${String(format)}"`, '/format');
  }

  const allIndividuals = await options.store.listIndividuals(options.campaignId);
  const individualsById = new Map<string, IndividualRecord>();
  for (const ind of allIndividuals) {
    individualsById.set(ind.individualId, ind);
  }

  const receiptCache = new Map<string, ParsedReceiptBundle>();
  const loadAndVerifyReceipt = async (ind: IndividualRecord): Promise<ParsedReceiptBundle> => {
    const cached = receiptCache.get(ind.individualId);
    if (cached) return cached;

    if (ind.status !== 'passed') {
      throw new EvolutionError(
        'EXPORT_UNVERIFIED_FORBIDDEN',
        `individual "${ind.individualId}" has status "${ind.status}" (expected "passed")`,
      );
    }
    if (ind.verdictReceiptCasDigest === null) {
      throw new EvolutionError(
        'EXPORT_UNVERIFIED_FORBIDDEN',
        `individual "${ind.individualId}" lacks a hardware_execution verdict receipt`,
      );
    }

    const rawBytes = await readVerifiedCasBlob(options.store.campaignRoot, ind.verdictReceiptCasDigest.hex, {
      maxBytes: MAX_RECEIPT_FILE_BYTES,
    });
    const parsed = await parseAndVerifyReceiptBytes(rawBytes, {
      individualId: ind.individualId,
      expectedLockHash: campaign.lockHash,
      expectedTargetCellId: campaign.manifest.spec.targetCellId,
      allowSyntheticProbe,
      ...(options.receiptSigningSecret !== undefined ? { receiptSigningSecret: options.receiptSigningSecret } : {}),
      ...(options.verifyReceiptSignature !== undefined ? { verifyReceiptSignature: options.verifyReceiptSignature } : {}),
      scrubber,
      maxBlobBytes,
    });

    if (ind.hardwareProvenance !== undefined) {
      if (canonicalizeJson(ind.hardwareProvenance) !== canonicalizeJson(parsed.provenance)) {
        throw new EvolutionError(
          'ARTIFACT_INVALID',
          `individual "${ind.individualId}" persisted hardwareProvenance diverges from signed verdict receipt`,
        );
      }
    }

    receiptCache.set(ind.individualId, parsed);
    return parsed;
  };

  // Gate: under specialist-then-portfolio mode, verify portfolioHeldOutWorkloadId passed!
  let verifiedPortfolioAnchor: { readonly individual: IndividualRecord; readonly receipt: ParsedReceiptBundle } | null = null;
  if (campaign.manifest.spec.stages.mode === 'specialist-then-portfolio') {
    const portfolioWorkloadId = campaign.manifest.spec.stages.portfolioHeldOutWorkloadId;
    const passingPortfolioCandidates = allIndividuals
      .filter(ind => isPortfolioCandidate(ind, portfolioWorkloadId) && ind.status === 'passed')
      .sort(comparePortfolioCandidateBetter);

    if (passingPortfolioCandidates.length === 0) {
      throw new EvolutionError(
        'EXPORT_UNVERIFIED_FORBIDDEN',
        `specialist-then-portfolio campaign "${campaign.campaignId}" has no passing portfolio evaluation on "${portfolioWorkloadId}"`,
      );
    }

    let lastFailure: unknown = null;
    for (const candidate of passingPortfolioCandidates) {
      if (
        candidate.bucketId !== null
        && candidate.bucketId !== 'portfolio'
        && candidate.bucketId !== portfolioWorkloadId
      ) {
        continue;
      }
      try {
        const receipt = await loadAndVerifyReceipt(candidate);
        if (receipt.heldOutWorkloadId !== undefined && receipt.heldOutWorkloadId !== portfolioWorkloadId) {
          lastFailure = new EvolutionError(
            'EXPORT_UNVERIFIED_FORBIDDEN',
            `portfolio receipt heldOutWorkloadId "${receipt.heldOutWorkloadId}" does not match "${portfolioWorkloadId}"`,
          );
          continue;
        }
        if (
          options.expectedPortfolioWorkloadDigest !== undefined
          && receipt.provenance.workloadDigest.hex !== options.expectedPortfolioWorkloadDigest.hex
        ) {
          lastFailure = new EvolutionError(
            'EXPORT_UNVERIFIED_FORBIDDEN',
            `portfolio receipt workloadDigest does not match expectedPortfolioWorkloadDigest`,
          );
          continue;
        }
        verifiedPortfolioAnchor = { individual: candidate, receipt };
        break;
      } catch (err: unknown) {
        lastFailure = err;
      }
    }

    if (verifiedPortfolioAnchor === null) {
      if (lastFailure instanceof EvolutionError) throw lastFailure;
      throw new EvolutionError(
        'EXPORT_UNVERIFIED_FORBIDDEN',
        `specialist-then-portfolio campaign "${campaign.campaignId}" failed portfolio verification on "${portfolioWorkloadId}"`,
      );
    }
  }

  // Select individuals deterministically
  let selectedIndividuals: IndividualRecord[];
  if (options.individualIds !== undefined) {
    if (options.individualIds.length === 0 || options.individualIds.length > DISPATCH_MANIFEST_MAX_RULES) {
      throw new EvolutionError(
        'EVOLUTION_SCHEMA_INVALID',
        `individualIds must contain 1..${DISPATCH_MANIFEST_MAX_RULES} entries`,
        '/individualIds',
      );
    }
    const seen = new Set<string>();
    selectedIndividuals = [];
    for (const id of options.individualIds) {
      if (typeof id !== 'string' || !SAFE_FILENAME_ID_RE.test(id)) {
        throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', `invalid individualId "${String(id)}"`, '/individualIds');
      }
      if (seen.has(id)) {
        throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', `duplicate individualId "${id}"`, '/individualIds');
      }
      seen.add(id);
      const found = individualsById.get(id);
      if (!found) {
        throw new EvolutionError('EVOLUTION_NOT_FOUND', `individual "${id}" not found in campaign "${campaign.campaignId}"`);
      }
      selectedIndividuals.push(found);
    }
  } else if (campaign.manifest.spec.stages.mode === 'specialist-then-portfolio') {
    const portfolioWorkloadId = campaign.manifest.spec.stages.portfolioHeldOutWorkloadId;
    const passingPortfolio = allIndividuals
      .filter(ind => isPortfolioCandidate(ind, portfolioWorkloadId) && ind.status === 'passed')
      .sort(comparePortfolioCandidateBetter);
    const rank1Portfolio = passingPortfolio.filter(ind => ind.paretoRank === 1);
    const chosenPortfolio = rank1Portfolio.length > 0 ? rank1Portfolio : [verifiedPortfolioAnchor!.individual];

    const selectedMap = new Map<string, IndividualRecord>();
    for (const p of chosenPortfolio) {
      selectedMap.set(p.individualId, p);
    }

    const portfolioEdges = await options.store.listLineageEdges(campaign.campaignId, { role: 'portfolio_member' });
    let addedPortfolioMember = false;
    for (const edge of portfolioEdges) {
      if (!selectedMap.has(edge.childIndividualId)) continue;
      const member = individualsById.get(edge.parentIndividualId);
      if (member) {
        selectedMap.set(member.individualId, member);
        addedPortfolioMember = true;
      }
    }

    if (!addedPortfolioMember) {
      for (const specBucket of campaign.manifest.spec.stages.specialistBuckets) {
        const passingSpec = allIndividuals
          .filter(ind => ind.bucketId === specBucket.id && ind.status === 'passed')
          .sort(comparePortfolioCandidateBetter);
        if (passingSpec.length > 0) {
          selectedMap.set(passingSpec[0]!.individualId, passingSpec[0]!);
        }
      }
    }
    selectedIndividuals = [...selectedMap.values()];
  } else {
    const passing = allIndividuals.filter(ind => ind.status === 'passed');
    if (passing.length === 0) {
      throw new EvolutionError(
        'EXPORT_UNVERIFIED_FORBIDDEN',
        `campaign "${campaign.campaignId}" has no passing individuals eligible for export`,
      );
    }
    const rank1 = passing.filter(ind => ind.paretoRank === 1);
    if (rank1.length > 0) {
      selectedIndividuals = rank1;
    } else {
      const rankable = passing.filter(ind =>
        campaign.manifest.spec.objectives.every(obj => Object.hasOwn(ind.metrics, obj.metric)),
      );
      if (rankable.length > 0) {
        const ranked = computeNsga2Ranking(
          rankable.map(ind => ({ individualId: ind.individualId, metrics: ind.metrics })),
          campaign.manifest.spec.objectives,
        );
        const rank1Ids = new Set(ranked.filter(r => r.paretoRank === 1).map(r => r.individualId));
        selectedIndividuals = passing.filter(ind => rank1Ids.has(ind.individualId));
      } else {
        selectedIndividuals = passing;
      }
    }
  }

  selectedIndividuals.sort((a, b) => compareUtf16(a.individualId, b.individualId));
  for (const ind of selectedIndividuals) {
    if (!SAFE_FILENAME_ID_RE.test(ind.individualId) || ind.individualId === '.' || ind.individualId === '..') {
      throw new EvolutionError('ARTIFACT_INVALID', `unsafe individualId for receipt filename: "${ind.individualId}"`);
    }
  }

  // Verify every selected individual's receipt, hardware compatibility, and CAS Stage A output blobs
  const verifiedBlobsByHex = new Map<string, VerifiedStageABlob>();
  const anchorProvenance = verifiedPortfolioAnchor?.receipt.provenance ?? null;
  let resolvedAnchorProvenance: HardwareProvenance | null = anchorProvenance;
  const isSingleTarget = campaign.manifest.spec.stages.mode === 'single-target';

  for (const ind of selectedIndividuals) {
    const receiptBundle = await loadAndVerifyReceipt(ind);

    if (resolvedAnchorProvenance === null) {
      resolvedAnchorProvenance = receiptBundle.provenance;
    } else {
      assertCompatibleHardwareProvenance(
        resolvedAnchorProvenance,
        receiptBundle.provenance,
        isSingleTarget,
        ind.individualId,
      );
    }

    assertIndividualArtifactsBoundToReceipt(ind, receiptBundle.outputArtifacts);

    const sortedReceiptArtifacts = [...receiptBundle.outputArtifacts].sort((a, b) => {
      const nameCmp = compareUtf16(a.name, b.name);
      return nameCmp !== 0 ? nameCmp : compareUtf16(a.digest.hex, b.digest.hex);
    });

    for (const art of sortedReceiptArtifacts) {
      const existing = verifiedBlobsByHex.get(art.digest.hex);
      if (existing !== undefined) {
        if (existing.byteLength !== art.byteLength) {
          throw new EvolutionError(
            'ARTIFACT_INVALID',
            `conflicting byteLength for blob ${art.digest.hex}`,
          );
        }
        if (isTextualArtifact(art.name, art.mediaType)) {
          const text = decodeUtf8Strict(existing.bytes, `/blobs/sha256/${art.digest.hex}`);
          assertCleanSecretText(text, scrubber, `/blobs/sha256/${art.digest.hex}`);
        }
        continue;
      }

      const blobBytes = await readVerifiedCasBlob(options.store.campaignRoot, art.digest.hex, {
        expectedByteLength: art.byteLength,
        maxBytes: maxBlobBytes,
      });

      if (isTextualArtifact(art.name, art.mediaType)) {
        const text = decodeUtf8Strict(blobBytes, `/blobs/sha256/${art.digest.hex}`);
        assertCleanSecretText(text, scrubber, `/blobs/sha256/${art.digest.hex}`);
      }

      verifiedBlobsByHex.set(art.digest.hex, {
        digest: art.digest,
        byteLength: art.byteLength,
        bytes: blobBytes,
        mediaType: inferBlobMediaType(art.name, art.mediaType),
        artifactNames: [art.name],
      });
    }
  }

  if (resolvedAnchorProvenance === null) {
    throw new EvolutionError('EXPORT_UNVERIFIED_FORBIDDEN', 'no verified hardware provenance available for bundle export');
  }

  // Build & validate dispatch-manifest.json
  const dispatchManifest = options.dispatchManifest !== undefined
    ? normalizeAndVerifyDispatchManifest(options.dispatchManifest, verifiedBlobsByHex, scrubber)
    : synthesizeDispatchManifest(campaign, selectedIndividuals, receiptCache, defaultEntrypoint, scrubber);

  const dispatchCanonical = canonicalizeJson(dispatchManifest);
  assertCleanSecretText(dispatchCanonical, scrubber, '/dispatch-manifest.json');
  const dispatchBytes = Buffer.from(dispatchCanonical, 'utf8');
  const dispatchManifestDigest = makeDigest(sha256Hex(dispatchBytes));

  // Prepare deterministic sorted receipts and Stage A blobs
  const sortedReceipts = selectedIndividuals.map(ind => {
    const rec = receiptCache.get(ind.individualId)!;
    return {
      individualId: ind.individualId,
      relPath: `receipts/${ind.individualId}.verdict.json`,
      bytes: rec.rawBytes,
      digest: rec.rawDigest,
    };
  }).sort((a, b) => compareUtf16(a.relPath, b.relPath));

  const sortedStageABlobs = [...verifiedBlobsByHex.values()]
    .map(blob => ({
      relPath: `blobs/sha256/${blob.digest.hex}`,
      bytes: blob.bytes,
      digest: blob.digest,
      mediaType: blob.mediaType,
    }))
    .sort((a, b) => compareUtf16(a.relPath, b.relPath));

  // Build members list (sorted lexicographically by path)
  const members: BundleMemberDigest[] = [];
  const pushMember = (path: string, digest: Digest, byteLength: number, mediaType: string): void => {
    const m = createNullRecord<{
      path: string;
      digest: Digest;
      byteLength: number;
      mediaType: string;
    }>();
    m.path = path;
    m.digest = makeDigest(digest.hex);
    m.byteLength = byteLength;
    m.mediaType = mediaType;
    members.push(m);
  };

  pushMember(
    'dispatch-manifest.json',
    dispatchManifestDigest,
    dispatchBytes.byteLength,
    EVOLUTION_DISPATCH_MANIFEST_MEDIA_TYPE,
  );
  for (const rec of sortedReceipts) {
    pushMember(rec.relPath, rec.digest, rec.bytes.byteLength, EVOLUTION_RECEIPT_MEDIA_TYPE);
  }
  for (const blob of sortedStageABlobs) {
    pushMember(blob.relPath, blob.digest, blob.bytes.byteLength, blob.mediaType);
  }
  members.sort((a, b) => compareUtf16(a.path, b.path));

  // Build compatibility, paretoSummary, lineage, and manifest.json
  const compatibility = buildCompatibilityTuple(resolvedAnchorProvenance, options, scrubber);
  const paretoSummary = buildParetoSummary(campaign, selectedIndividuals, receiptCache);
  const exportedIndividualIds = selectedIndividuals.map(ind => ind.individualId).sort(compareUtf16);

  const lineage = createNullRecord<{
    campaignId: string;
    individualIds: readonly string[];
    baseRevision: string;
    lockHash: Digest;
  }>();
  lineage.campaignId = campaign.campaignId;
  lineage.individualIds = exportedIndividualIds;
  lineage.baseRevision = campaign.baseRevision;
  lineage.lockHash = makeDigest(campaign.lockHash.hex);

  const bundleManifest = createNullRecord<{
    kind: typeof EVOLUTION_BUNDLE_KIND;
    version: typeof EVOLUTION_BUNDLE_VERSION;
    compatibility: BundleCompatibilityTuple;
    paretoSummary: readonly BundleParetoEntry[];
    lineage: BundleLineageProvenance;
    members: readonly BundleMemberDigest[];
  }>();
  bundleManifest.kind = EVOLUTION_BUNDLE_KIND;
  bundleManifest.version = EVOLUTION_BUNDLE_VERSION;
  bundleManifest.compatibility = compatibility;
  bundleManifest.paretoSummary = paretoSummary;
  bundleManifest.lineage = lineage;
  bundleManifest.members = members;

  const manifestCanonical = canonicalizeJson(bundleManifest);
  assertCleanSecretText(manifestCanonical, scrubber, '/manifest.json');
  const manifestBytes = Buffer.from(manifestCanonical, 'utf8');
  const manifestDigest = makeDigest(sha256Hex(manifestBytes));

  const ociArtifacts = format === 'oci-layout'
    ? buildOciLayoutArtifacts({
      campaign,
      compatibility,
      manifestBytes,
      manifestDigest,
      dispatchBytes,
      dispatchDigest: dispatchManifestDigest,
      receipts: sortedReceipts,
      stageABlobs: sortedStageABlobs,
    })
    : null;

  // Atomically stage into sibling temp directory and rename into resolvedOutputDir
  const parentDir = dirname(resolvedOutputDir);
  await ensureDirectoryChainNoSymlink(parentDir, 0o755);

  const stagingDir = join(parentDir, `.evolution-bundle-stage-${randomBytes(8).toString('hex')}`);
  let published = false;
  try {
    await mkdir(stagingDir, { mode: 0o755, recursive: false });
    await mkdir(join(stagingDir, 'receipts'), { mode: 0o755, recursive: false });
    await mkdir(join(stagingDir, 'blobs'), { mode: 0o755, recursive: false });
    await mkdir(join(stagingDir, 'blobs', 'sha256'), { mode: 0o755, recursive: false });

    await writeNewFileNoFollow(join(stagingDir, 'manifest.json'), manifestBytes, 0o644);
    await writeNewFileNoFollow(join(stagingDir, 'dispatch-manifest.json'), dispatchBytes, 0o644);

    for (const rec of sortedReceipts) {
      await writeNewFileNoFollow(join(stagingDir, rec.relPath), rec.bytes, 0o644);
    }

    const writtenBlobHexes = new Set<string>();
    for (const blob of sortedStageABlobs) {
      if (writtenBlobHexes.has(blob.digest.hex)) continue;
      writtenBlobHexes.add(blob.digest.hex);
      await writeNewFileNoFollow(join(stagingDir, blob.relPath), blob.bytes, 0o644);
    }

    if (ociArtifacts !== null) {
      const sortedExtraHexes = [...ociArtifacts.extraBlobsByHex.keys()].sort(compareUtf16);
      for (const hex of sortedExtraHexes) {
        if (writtenBlobHexes.has(hex)) continue;
        writtenBlobHexes.add(hex);
        const bytes = ociArtifacts.extraBlobsByHex.get(hex)!;
        await writeNewFileNoFollow(join(stagingDir, 'blobs', 'sha256', hex), bytes, 0o644);
      }
      await writeNewFileNoFollow(join(stagingDir, 'oci-layout'), ociArtifacts.ociLayoutBytes, 0o644);
      await writeNewFileNoFollow(join(stagingDir, 'index.json'), ociArtifacts.ociIndexBytes, 0o644);
    }

    await publishStagingDirectoryAtomically(stagingDir, resolvedOutputDir, overwrite);
    published = true;
  } finally {
    if (!published) {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return Object.freeze({
    format,
    outputDir: resolvedOutputDir,
    manifestDigest,
    dispatchManifestDigest,
    ...(ociArtifacts !== null ? { ociIndexDigest: ociArtifacts.ociIndexDigest } : {}),
    exportedIndividualIds: Object.freeze(exportedIndividualIds),
    blobCount: sortedStageABlobs.length,
  });
}

function parseBundleManifestJson(
  manifestBytes: Buffer,
  scrubber: SecretScrubber,
): EvolutionBundleManifestV1 {
  const text = decodeUtf8Strict(manifestBytes, '/manifest.json');
  assertCleanSecretText(text, scrubber, '/manifest.json');

  let parsedRaw: NullProtoJson;
  try {
    parsedRaw = parseNullProtoJson(text, MAX_BUNDLE_MANIFEST_BYTES, '/manifest.json');
  } catch (err: unknown) {
    throw new EvolutionError(
      'ARTIFACT_INVALID',
      `invalid manifest.json: ${err instanceof Error ? err.message : String(err)}`,
      '/manifest.json',
    );
  }

  const root = expectRecord(
    parsedRaw,
    BUNDLE_MANIFEST_KEYS,
    ['kind', 'version', 'compatibility', 'paretoSummary', 'lineage', 'members'],
    'ARTIFACT_INVALID',
    '/manifest.json',
  );
  if (root['kind'] !== EVOLUTION_BUNDLE_KIND || root['version'] !== EVOLUTION_BUNDLE_VERSION) {
    throw new EvolutionError('ARTIFACT_INVALID', 'manifest.json must have kind: "EvolutionBundle" and version: 1', '/manifest.json');
  }

  const compatObj = expectRecord(
    root['compatibility'],
    COMPATIBILITY_KEYS,
    ['accelerator', 'isolationMode', 'deviceCount', 'driverVersion', 'runtimeVersion', 'workloadDigest'],
    'ARTIFACT_INVALID',
    '/manifest.json/compatibility',
  );
  if (compatObj['isolationMode'] !== 'whole_device' && compatObj['isolationMode'] !== 'sliced') {
    throw new EvolutionError('ARTIFACT_INVALID', 'invalid compatibility.isolationMode', '/manifest.json/compatibility/isolationMode');
  }
  if (
    typeof compatObj['deviceCount'] !== 'number'
    || !Number.isSafeInteger(compatObj['deviceCount'])
    || compatObj['deviceCount'] < 1
    || compatObj['deviceCount'] > 64
  ) {
    throw new EvolutionError('ARTIFACT_INVALID', 'invalid compatibility.deviceCount', '/manifest.json/compatibility/deviceCount');
  }
  parseDigestValue(compatObj['workloadDigest'], 'ARTIFACT_INVALID', '/manifest.json/compatibility/workloadDigest');
  if (Object.hasOwn(compatObj, 'modelDigest') && compatObj['modelDigest'] !== undefined) {
    parseDigestValue(compatObj['modelDigest'], 'ARTIFACT_INVALID', '/manifest.json/compatibility/modelDigest');
  }

  const lineageObj = expectRecord(
    root['lineage'],
    LINEAGE_KEYS,
    ['campaignId', 'individualIds', 'baseRevision', 'lockHash'],
    'ARTIFACT_INVALID',
    '/manifest.json/lineage',
  );
  if (typeof lineageObj['campaignId'] !== 'string' || !SAFE_ID_RE.test(lineageObj['campaignId'])) {
    throw new EvolutionError('ARTIFACT_INVALID', 'invalid lineage.campaignId', '/manifest.json/lineage/campaignId');
  }
  if (!Array.isArray(lineageObj['individualIds']) || lineageObj['individualIds'].length === 0) {
    throw new EvolutionError('ARTIFACT_INVALID', 'lineage.individualIds must be non-empty', '/manifest.json/lineage/individualIds');
  }
  parseDigestValue(lineageObj['lockHash'], 'ARTIFACT_INVALID', '/manifest.json/lineage/lockHash');

  const rawPareto = root['paretoSummary'];
  if (!Array.isArray(rawPareto) || rawPareto.length === 0) {
    throw new EvolutionError('ARTIFACT_INVALID', 'paretoSummary must be a non-empty array', '/manifest.json/paretoSummary');
  }
  for (let i = 0; i < rawPareto.length; i++) {
    expectRecord(
      rawPareto[i],
      PARETO_ENTRY_KEYS,
      ['individualId', 'paretoRank', 'nicheKey', 'metrics'],
      'ARTIFACT_INVALID',
      `/manifest.json/paretoSummary/${i}`,
    );
  }

  const rawMembers = root['members'];
  if (!Array.isArray(rawMembers) || rawMembers.length === 0) {
    throw new EvolutionError('ARTIFACT_INVALID', 'members must be a non-empty array', '/manifest.json/members');
  }
  const seenPaths = new Set<string>();
  for (let i = 0; i < rawMembers.length; i++) {
    const mPath = `/manifest.json/members/${i}`;
    const mObj = expectRecord(rawMembers[i], MEMBER_KEYS, ['path', 'digest', 'byteLength'], 'ARTIFACT_INVALID', mPath);
    const relPath = mObj['path'];
    if (typeof relPath !== 'string' || !validateRelativePath(relPath).ok) {
      throw new EvolutionError('ARTIFACT_INVALID', 'invalid member path', `${mPath}/path`);
    }
    if (seenPaths.has(relPath)) {
      throw new EvolutionError('ARTIFACT_INVALID', `duplicate member path "${relPath}"`, `${mPath}/path`);
    }
    seenPaths.add(relPath);
    parseDigestValue(mObj['digest'], 'ARTIFACT_INVALID', `${mPath}/digest`);
    const byteLength = mObj['byteLength'];
    if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new EvolutionError('ARTIFACT_INVALID', 'invalid member byteLength', `${mPath}/byteLength`);
    }
  }

  return root as unknown as EvolutionBundleManifestV1;
}

function parseOciDigestString(raw: unknown, diagPath: string): string {
  if (typeof raw !== 'string' || !raw.startsWith('sha256:')) {
    throw new EvolutionError('ARTIFACT_INVALID', 'OCI digest must start with "sha256:"', diagPath);
  }
  const hex = raw.slice(7);
  if (!SHA256_HEX_RE.test(hex)) {
    throw new EvolutionError('ARTIFACT_INVALID', 'OCI digest must contain 64 lowercase hex characters', diagPath);
  }
  return hex;
}

/**
 * Verify an exported `evolution-bundle.v1` directory (`dir` or `oci-layout`) on disk,
 * enforcing `O_NOFOLLOW`, `nlink === 1`, exact SHA-256 + `byteLength` member digests,
 * `dispatch-manifest.json` rules, signed `receipts/*.verdict.json` proofs, and OCI layout integrity.
 */
export async function verifyEvolutionBundle(
  options: VerifyEvolutionBundleOptions,
): Promise<VerifyEvolutionBundleResult> {
  const scrubber = options.scrubber ?? DEFAULT_SECRET_SCRUBBER;
  const allowSyntheticProbe = options.allowSyntheticProbe === true;
  const maxBlobBytes = options.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;

  const resolvedBundleDir = validateAbsoluteFilesystemPath(options.bundleDir, 'bundleDir');
  await assertNoSymlinkPath(resolvedBundleDir, { checkLeaf: true, diagPath: resolvedBundleDir });
  await verifyNonSymlinkDirectoryFd(resolvedBundleDir);

  const manifestBytes = await readVerifiedRegularFileNoFollow(join(resolvedBundleDir, 'manifest.json'), {
    maxBytes: MAX_BUNDLE_MANIFEST_BYTES,
    missingCode: 'ARTIFACT_MISSING',
  });
  const manifestDigest = makeDigest(sha256Hex(manifestBytes));
  const manifest = parseBundleManifestJson(manifestBytes, scrubber);

  // Verify every member listed in manifest.json
  const verifiedMemberBytes = new Map<string, Buffer>();
  const verifiedBlobHexes = new Set<string>();
  let receiptCount = 0;

  for (const member of manifest.members) {
    const absMemberPath = join(resolvedBundleDir, member.path);
    await assertNoSymlinkPath(absMemberPath, { checkLeaf: true, diagPath: absMemberPath });
    const bytes = await readVerifiedRegularFileNoFollow(absMemberPath, {
      expectedSha256Hex: member.digest.hex,
      expectedByteLength: member.byteLength,
      maxBytes: maxBlobBytes,
      missingCode: 'ARTIFACT_MISSING',
    });
    verifiedMemberBytes.set(member.path, bytes);
    if (member.path.startsWith('blobs/sha256/')) {
      const hexFromPath = member.path.slice('blobs/sha256/'.length);
      if (hexFromPath !== member.digest.hex) {
        throw new EvolutionError('ARTIFACT_INVALID', `blob path "${member.path}" does not match digest ${member.digest.hex}`);
      }
      verifiedBlobHexes.add(member.digest.hex);
    }
  }

  // Verify dispatch-manifest.json
  const dispatchBytes = verifiedMemberBytes.get('dispatch-manifest.json');
  if (!dispatchBytes) {
    throw new EvolutionError('ARTIFACT_MISSING', 'manifest.json does not list dispatch-manifest.json');
  }
  const dispatchManifest = parseDispatchManifestV1(dispatchBytes, { scrubber });
  if (dispatchBytes.byteLength > DISPATCH_MANIFEST_MAX_BYTES) {
    throw new EvolutionError('ARTIFACT_INVALID', 'dispatch-manifest.json exceeds max byte size');
  }
  for (let i = 0; i < dispatchManifest.rules.length; i++) {
    const rule = dispatchManifest.rules[i]!;
    if (!verifiedBlobHexes.has(rule.blobDigest.hex)) {
      throw new EvolutionError(
        'ARTIFACT_INVALID',
        `dispatch-manifest.json rule ${i} references missing blob ${rule.blobDigest.hex}`,
      );
    }
  }
  const dispatchManifestDigest = makeDigest(sha256Hex(dispatchBytes));

  // Verify every receipt listed in manifest.lineage.individualIds
  const verifiedReceiptDigests = new Map<string, string>();
  for (const individualId of manifest.lineage.individualIds) {
    const relPath = `receipts/${individualId}.verdict.json`;
    const receiptBytes = verifiedMemberBytes.get(relPath);
    if (!receiptBytes) {
      throw new EvolutionError('EXPORT_UNVERIFIED_FORBIDDEN', `missing receipt member "${relPath}"`);
    }
    const parsedReceipt = await parseAndVerifyReceiptBytes(receiptBytes, {
      individualId,
      expectedLockHash: manifest.lineage.lockHash,
      allowSyntheticProbe,
      ...(options.receiptSigningSecret !== undefined ? { receiptSigningSecret: options.receiptSigningSecret } : {}),
      ...(options.verifyReceiptSignature !== undefined ? { verifyReceiptSignature: options.verifyReceiptSignature } : {}),
      scrubber,
      maxBlobBytes,
    });
    if (
      parsedReceipt.provenance.accelerator !== manifest.compatibility.accelerator
      || parsedReceipt.provenance.isolationMode !== manifest.compatibility.isolationMode
      || parsedReceipt.provenance.deviceCount !== manifest.compatibility.deviceCount
      || parsedReceipt.provenance.driverVersion !== manifest.compatibility.driverVersion
      || parsedReceipt.provenance.runtimeVersion !== manifest.compatibility.runtimeVersion
      || (parsedReceipt.provenance.topology ?? null) !== (manifest.compatibility.topology ?? null)
    ) {
      throw new EvolutionError(
        'ARTIFACT_INVALID',
        `receipt "${individualId}" hardwareProvenance does not match manifest.json compatibility tuple`,
      );
    }
    for (const art of parsedReceipt.outputArtifacts) {
      if (!verifiedBlobHexes.has(art.digest.hex)) {
        throw new EvolutionError(
          'ARTIFACT_INVALID',
          `receipt "${individualId}" references blob ${art.digest.hex} missing from bundle members`,
        );
      }
    }
    verifiedReceiptDigests.set(relPath, parsedReceipt.rawDigest.hex);
    receiptCount++;
  }

  // Detect and verify optional OCI Image Layout
  const ociLayoutPath = join(resolvedBundleDir, 'oci-layout');
  const ociLayoutStat = await lstat(ociLayoutPath).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    if (err.code === 'ELOOP') {
      throw new EvolutionError('ARTIFACT_INVALID', 'oci-layout cannot be a symlink', ociLayoutPath);
    }
    throw err;
  });

  let format: EvolutionExportFormat = 'dir';
  let ociIndexDigest: Digest | undefined;

  if (ociLayoutStat !== null) {
    format = 'oci-layout';
    const ociLayoutBytes = await readVerifiedRegularFileNoFollow(ociLayoutPath, {
      maxBytes: 1_024,
      missingCode: 'ARTIFACT_MISSING',
    });
    const layoutObj = expectRecord(
      parseNullProtoJson(decodeUtf8Strict(ociLayoutBytes, '/oci-layout'), 1_024, '/oci-layout'),
      new Set(['imageLayoutVersion']),
      ['imageLayoutVersion'],
      'ARTIFACT_INVALID',
      '/oci-layout',
    );
    if (layoutObj['imageLayoutVersion'] !== OCI_IMAGE_LAYOUT_VERSION) {
      throw new EvolutionError('ARTIFACT_INVALID', `unsupported oci-layout version "${String(layoutObj['imageLayoutVersion'])}"`);
    }

    const indexBytes = await readVerifiedRegularFileNoFollow(join(resolvedBundleDir, 'index.json'), {
      maxBytes: MAX_OCI_DOC_BYTES,
      missingCode: 'ARTIFACT_MISSING',
    });
    ociIndexDigest = makeDigest(sha256Hex(indexBytes));
    const indexObj = expectRecord(
      parseNullProtoJson(decodeUtf8Strict(indexBytes, '/index.json'), MAX_OCI_DOC_BYTES, '/index.json'),
      new Set(['schemaVersion', 'mediaType', 'manifests', 'annotations']),
      ['schemaVersion', 'mediaType', 'manifests'],
      'ARTIFACT_INVALID',
      '/index.json',
    );
    if (indexObj['schemaVersion'] !== 2 || indexObj['mediaType'] !== OCI_IMAGE_INDEX_MEDIA_TYPE) {
      throw new EvolutionError('ARTIFACT_INVALID', 'invalid OCI index.json schemaVersion or mediaType', '/index.json');
    }
    const manifestsArr = indexObj['manifests'];
    if (!Array.isArray(manifestsArr) || manifestsArr.length === 0) {
      throw new EvolutionError('ARTIFACT_INVALID', 'OCI index.json manifests[] must be non-empty', '/index.json/manifests');
    }

    const descKeys = new Set(['mediaType', 'artifactType', 'digest', 'size', 'annotations']);
    for (let i = 0; i < manifestsArr.length; i++) {
      const mDesc = expectRecord(
        manifestsArr[i],
        descKeys,
        ['mediaType', 'digest', 'size'],
        'ARTIFACT_INVALID',
        `/index.json/manifests/${i}`,
      );
      if (mDesc['mediaType'] !== OCI_IMAGE_MANIFEST_MEDIA_TYPE) {
        throw new EvolutionError('ARTIFACT_INVALID', 'unexpected OCI manifest mediaType', `/index.json/manifests/${i}/mediaType`);
      }
      const ociManifestHex = parseOciDigestString(mDesc['digest'], `/index.json/manifests/${i}/digest`);
      const ociManifestSize = mDesc['size'];
      if (typeof ociManifestSize !== 'number' || !Number.isSafeInteger(ociManifestSize) || ociManifestSize < 2) {
        throw new EvolutionError('ARTIFACT_INVALID', 'invalid OCI manifest size', `/index.json/manifests/${i}/size`);
      }

      const ociManifestBytes = await readVerifiedRegularFileNoFollow(
        join(resolvedBundleDir, 'blobs', 'sha256', ociManifestHex),
        {
          expectedSha256Hex: ociManifestHex,
          expectedByteLength: ociManifestSize,
          maxBytes: MAX_OCI_DOC_BYTES,
          missingCode: 'ARTIFACT_MISSING',
        },
      );
      const ociManifestObj = expectRecord(
        parseNullProtoJson(decodeUtf8Strict(ociManifestBytes, '/oci-manifest'), MAX_OCI_DOC_BYTES, '/oci-manifest'),
        new Set(['schemaVersion', 'mediaType', 'artifactType', 'config', 'layers', 'annotations']),
        ['schemaVersion', 'mediaType', 'config', 'layers'],
        'ARTIFACT_INVALID',
        '/oci-manifest',
      );
      if (ociManifestObj['schemaVersion'] !== 2 || ociManifestObj['mediaType'] !== OCI_IMAGE_MANIFEST_MEDIA_TYPE) {
        throw new EvolutionError('ARTIFACT_INVALID', 'invalid OCI manifest schemaVersion or mediaType', '/oci-manifest');
      }

      const configDesc = expectRecord(
        ociManifestObj['config'],
        descKeys,
        ['mediaType', 'digest', 'size'],
        'ARTIFACT_INVALID',
        '/oci-manifest/config',
      );
      const configHex = parseOciDigestString(configDesc['digest'], '/oci-manifest/config/digest');
      const configSize = configDesc['size'];
      if (typeof configSize !== 'number' || !Number.isSafeInteger(configSize) || configSize < 0) {
        throw new EvolutionError('ARTIFACT_INVALID', 'invalid OCI config size', '/oci-manifest/config/size');
      }
      await readVerifiedRegularFileNoFollow(join(resolvedBundleDir, 'blobs', 'sha256', configHex), {
        expectedSha256Hex: configHex,
        expectedByteLength: configSize,
        maxBytes: MAX_OCI_DOC_BYTES,
        missingCode: 'ARTIFACT_MISSING',
      });

      const layersArr = ociManifestObj['layers'];
      if (!Array.isArray(layersArr) || layersArr.length === 0) {
        throw new EvolutionError('ARTIFACT_INVALID', 'OCI manifest layers[] must be non-empty', '/oci-manifest/layers');
      }
      const ociLayerHexes = new Set<string>();
      for (let j = 0; j < layersArr.length; j++) {
        const lDesc = expectRecord(
          layersArr[j],
          descKeys,
          ['mediaType', 'digest', 'size'],
          'ARTIFACT_INVALID',
          `/oci-manifest/layers/${j}`,
        );
        const layerHex = parseOciDigestString(lDesc['digest'], `/oci-manifest/layers/${j}/digest`);
        const layerSize = lDesc['size'];
        if (typeof layerSize !== 'number' || !Number.isSafeInteger(layerSize) || layerSize < 0) {
          throw new EvolutionError('ARTIFACT_INVALID', 'invalid OCI layer size', `/oci-manifest/layers/${j}/size`);
        }
        await readVerifiedRegularFileNoFollow(join(resolvedBundleDir, 'blobs', 'sha256', layerHex), {
          expectedSha256Hex: layerHex,
          expectedByteLength: layerSize,
          maxBytes: maxBlobBytes,
          missingCode: 'ARTIFACT_MISSING',
        });
        ociLayerHexes.add(layerHex);
      }
      if (!ociLayerHexes.has(manifestDigest.hex) || !ociLayerHexes.has(dispatchManifestDigest.hex)) {
        throw new EvolutionError(
          'ARTIFACT_INVALID',
          'OCI manifest layers do not cover root manifest.json and dispatch-manifest.json',
          '/oci-manifest/layers',
        );
      }
      for (const receiptHex of verifiedReceiptDigests.values()) {
        if (!ociLayerHexes.has(receiptHex)) {
          throw new EvolutionError(
            'ARTIFACT_INVALID',
            `OCI manifest layers omit receipt blob ${receiptHex}`,
            '/oci-manifest/layers',
          );
        }
      }
      for (const blobHex of verifiedBlobHexes) {
        if (!ociLayerHexes.has(blobHex)) {
          throw new EvolutionError(
            'ARTIFACT_INVALID',
            `OCI manifest layers omit Stage A blob ${blobHex}`,
            '/oci-manifest/layers',
          );
        }
      }
    }
  }

  return Object.freeze({
    format,
    bundleDir: resolvedBundleDir,
    manifest,
    dispatchManifest,
    manifestDigest,
    dispatchManifestDigest,
    ...(ociIndexDigest !== undefined ? { ociIndexDigest } : {}),
    receiptCount,
    blobCount: verifiedBlobHexes.size,
  });
}
