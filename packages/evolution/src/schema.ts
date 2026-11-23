import { lstat } from 'node:fs/promises';
import {
  HANDOFF_LIMITS,
  LIMITS,
  SecretScrubber,
  validateBucketMetrics,
  validateHardwareDiagnostics,
  validateRelativePath,
  type ArtifactRef,
  type BucketMetricEntry,
  type Digest,
  type FindingSeverity,
  type HardwareDiagnostics,
  type HardwareProvenance,
  type ReworkPolicy,
  type StepHandoffSelect,
  type StepHandoffSelector,
  type StepHandoffSource,
  type StructuredFinding,
} from '@loopwright/core';
import {
  parseYamlDocument,
  readBoundedRegularFile,
  TaskpackError,
} from '@loopwright/taskpack';
import {
  DISPATCH_MANIFEST_MAX_BYTES,
  DISPATCH_MANIFEST_MAX_RULES,
  EVOLUTION_API_VERSION,
  EVOLUTION_CAMPAIGN_KIND,
  EVOLUTION_CAMPAIGN_MAX_BYTES,
  EvolutionError,
  TEAM_PATCH_DIAGNOSIS_MAX_BYTES,
  TEAM_PATCH_KIND,
  TEAM_PATCH_MAX_BYTES,
  TEAM_PATCH_SCHEMA_VERSION,
  type DispatchDimensionRange,
  type DispatchManifestV1,
  type DispatchRuleV1,
  type EvolutionBudgetsSpec,
  type EvolutionCampaignManifest,
  type EvolutionCampaignMetadata,
  type EvolutionCampaignSpec,
  type EvolutionEnumNicheAxis,
  type EvolutionExportFormat,
  type EvolutionExportSpec,
  type EvolutionModelBanditStrategy,
  type EvolutionMutationWeights,
  type EvolutionNicheAxis,
  type EvolutionNumericBinsNicheAxis,
  type EvolutionPopulationSpec,
  type EvolutionSamplingSpec,
  type EvolutionSpecialistBucket,
  type EvolutionStagesSpec,
  type EvolutionTeamSpec,
  type ObjectiveDirectionSpec,
  type TeamPatchDiagnosis,
  type TeamPatchRole,
  type TeamPatchStep,
  type TeamPatchV1,
  type TeamPlateauCategory,
} from './types.js';

export type NullProtoJson =
  | null
  | boolean
  | number
  | string
  | readonly NullProtoJson[]
  | { readonly [key: string]: NullProtoJson };

const FORBIDDEN_PROTOTYPE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const IDENTIFIER_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const BUCKET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const METRIC_KEY_RE = /^[A-Za-z_][A-Za-z0-9._-]*$/;
const TOOL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:[.:-][A-Za-z0-9_]+)*$/;
const MODEL_LABEL_RE = /^[\x21-\x7E]{1,128}$/;
const ENTRYPOINT_SYMBOL_RE = /^[A-Za-z_][A-Za-z0-9_.:$-]{0,255}$/;
const DTYPE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const PRINTABLE_ASCII_RE = /^[\x20-\x7E]+$/;
const RESERVED_PATH_SEGMENT_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

const PLATEAU_CATEGORIES: ReadonlySet<TeamPlateauCategory> = new Set([
  'measurement_mismatch',
  'coupled_responsibilities',
  'local_optimum_anchor',
  'resource_spill_trap',
  'correctness_ping_pong',
  'other',
]);

const DEFAULT_SECRET_SCRUBBER = new SecretScrubber();

const MAX_JSON_NODES = 4_096;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_COLLECTION = 512;
const MAX_JSON_STRING = 16_384;

function schemaInvalid(message: string, path = '/'): never {
  throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', message, path);
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function hasDisallowedInlineControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function assertValidStringContent(value: string, maxChars: number, path: string): void {
  if (value.length > maxChars) {
    schemaInvalid(`string exceeds maximum length ${maxChars}`, path);
  }
  if (LONE_SURROGATE_RE.test(value)) {
    schemaInvalid('string contains lone UTF-16 surrogate', path);
  }
}

function createNullRecord<T extends Record<string, unknown>>(): T {
  return Object.create(null) as T;
}

function decodeUtf8Strict(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    schemaInvalid('input bytes are not valid UTF-8', path);
  }
}

export interface SanitizeUntrustedOptions {
  readonly maxBytes?: number;
  readonly maxNodes?: number;
  readonly maxDepth?: number;
  readonly maxCollection?: number;
  readonly maxString?: number;
  readonly path?: string;
}

/**
 * Strictly parse a JSON string into null-prototype objects, rejecting duplicate keys,
 * prototype keys (`__proto__`, `constructor`, `prototype`), lone surrogates, `NaN`, `Infinity`, and `-0`.
 */
export function parseNullProtoJson(
  source: string,
  maxBytes: number = EVOLUTION_CAMPAIGN_MAX_BYTES,
  diagPath = '/',
): NullProtoJson {
  if (typeof source !== 'string') {
    schemaInvalid('expected JSON string', diagPath);
  }
  if (Buffer.byteLength(source, 'utf8') > maxBytes) {
    schemaInvalid(`JSON payload exceeds ${maxBytes} bytes`, diagPath);
  }
  if (LONE_SURROGATE_RE.test(source)) {
    schemaInvalid('JSON payload contains lone UTF-16 surrogate', diagPath);
  }

  let offset = 0;
  let nodes = 0;

  const skipSpace = (): void => {
    while (offset < source.length) {
      const ch = source.charCodeAt(offset);
      if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) {
        offset++;
      } else {
        break;
      }
    }
  };

  const readString = (path: string): string => {
    const start = offset++;
    let closed = false;
    while (offset < source.length) {
      const ch = source.charAt(offset++);
      if (ch === '"') {
        closed = true;
        break;
      }
      if (ch === '\\') {
        if (offset >= source.length) schemaInvalid('unterminated JSON escape', path);
        offset++;
      }
    }
    if (!closed) schemaInvalid('unterminated JSON string', path);
    let parsed: unknown;
    try {
      parsed = JSON.parse(source.slice(start, offset));
    } catch {
      schemaInvalid('invalid JSON string literal', path);
    }
    if (typeof parsed !== 'string') {
      schemaInvalid('invalid JSON string literal', path);
    }
    assertValidStringContent(parsed, MAX_JSON_STRING, path);
    return parsed;
  };

  const readValue = (depth: number, path: string): NullProtoJson => {
    if (++nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
      schemaInvalid('JSON document exceeds node or depth limits', path);
    }
    skipSpace();
    const first = source.charAt(offset);
    if (first === '{') {
      offset++;
      const out = createNullRecord<Record<string, NullProtoJson>>();
      const seen = new Set<string>();
      skipSpace();
      if (source.charAt(offset) === '}') {
        offset++;
        return out;
      }
      while (true) {
        skipSpace();
        if (source.charAt(offset) !== '"') {
          schemaInvalid('JSON object member key must be a double-quoted string', path);
        }
        const key = readString(path);
        if (FORBIDDEN_PROTOTYPE_KEYS.has(key)) {
          schemaInvalid(`forbidden prototype key "${key}"`, `${path}/${key}`);
        }
        if (seen.has(key)) {
          schemaInvalid(`duplicate JSON key "${key}"`, `${path}/${key}`);
        }
        if (seen.size >= MAX_JSON_COLLECTION) {
          schemaInvalid('JSON object exceeds property limits', path);
        }
        seen.add(key);
        skipSpace();
        if (source.charAt(offset++) !== ':') {
          schemaInvalid('expected ":" after JSON key', `${path}/${key}`);
        }
        out[key] = readValue(depth + 1, `${path}/${key}`);
        skipSpace();
        const sep = source.charAt(offset++);
        if (sep === '}') return out;
        if (sep !== ',') schemaInvalid('expected "," or "}" in JSON object', path);
      }
    }
    if (first === '[') {
      offset++;
      const arr: NullProtoJson[] = [];
      skipSpace();
      if (source.charAt(offset) === ']') {
        offset++;
        return arr;
      }
      while (true) {
        if (arr.length >= MAX_JSON_COLLECTION) {
          schemaInvalid('JSON array exceeds collection limits', path);
        }
        arr.push(readValue(depth + 1, `${path}/${arr.length}`));
        skipSpace();
        const sep = source.charAt(offset++);
        if (sep === ']') return arr;
        if (sep !== ',') schemaInvalid('expected "," or "]" in JSON array', path);
      }
    }
    if (first === '"') {
      return readString(path);
    }
    const tokenMatch = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
      source.slice(offset),
    );
    if (tokenMatch === null) {
      schemaInvalid('invalid JSON token', path);
    }
    const rawToken = tokenMatch[0];
    offset += rawToken.length;
    if (rawToken === 'true') return true;
    if (rawToken === 'false') return false;
    if (rawToken === 'null') return null;
    const numeric = Number(rawToken);
    if (!Number.isFinite(numeric) || Object.is(numeric, -0)) {
      schemaInvalid('JSON number must be finite and non-negative-zero', path);
    }
    return numeric;
  };

  const root = readValue(1, diagPath);
  skipSpace();
  if (offset !== source.length) {
    schemaInvalid('unexpected trailing content after JSON value', diagPath);
  }
  return root;
}

/**
 * Convert an untrusted value into a deep null-prototype tree while enforcing byte,
 * depth, collection, prototype-key, surrogate, and finite non-`-0` number guards.
 */
export function sanitizeUntrustedValue(
  input: unknown,
  options: SanitizeUntrustedOptions = {},
): NullProtoJson {
  const maxBytes = options.maxBytes ?? EVOLUTION_CAMPAIGN_MAX_BYTES;
  const maxNodes = options.maxNodes ?? MAX_JSON_NODES;
  const maxDepth = options.maxDepth ?? MAX_JSON_DEPTH;
  const maxCollection = options.maxCollection ?? MAX_JSON_COLLECTION;
  const maxString = options.maxString ?? MAX_JSON_STRING;
  const rootPath = options.path ?? '/';

  let nodes = 0;
  let estimatedBytes = 0;
  const active = new WeakSet<object>();

  const chargeBytes = (count: number, path: string): void => {
    estimatedBytes += count;
    if (estimatedBytes > maxBytes) {
      schemaInvalid(`payload exceeds ${maxBytes} bytes`, path);
    }
  };

  const visit = (val: unknown, depth: number, path: string): NullProtoJson => {
    if (++nodes > maxNodes || depth > maxDepth) {
      schemaInvalid('value exceeds node or depth limits', path);
    }
    if (val === null || typeof val === 'boolean') {
      chargeBytes(5, path);
      return val;
    }
    if (typeof val === 'number') {
      if (!Number.isFinite(val) || Object.is(val, -0)) {
        schemaInvalid('number must be finite and not -0', path);
      }
      chargeBytes(Buffer.byteLength(String(val), 'utf8'), path);
      return val;
    }
    if (typeof val === 'string') {
      assertValidStringContent(val, maxString, path);
      chargeBytes(Buffer.byteLength(val, 'utf8') + 2, path);
      return val;
    }
    if (typeof val !== 'object') {
      schemaInvalid(`unsupported value type "${typeof val}"`, path);
    }
    if (active.has(val)) {
      schemaInvalid('cyclic object reference is forbidden', path);
    }
    const proto: unknown = Object.getPrototypeOf(val);
    if (Array.isArray(val)) {
      if (proto !== Array.prototype) {
        schemaInvalid('unsupported array prototype', path);
      }
      const ownKeys = Reflect.ownKeys(val);
      if (ownKeys.some(k => typeof k === 'symbol') || ownKeys.length !== val.length + 1) {
        schemaInvalid('sparse or symbol-keyed arrays are forbidden', path);
      }
      if (val.length > maxCollection) {
        schemaInvalid(`array exceeds maximum length ${maxCollection}`, path);
      }
      active.add(val);
      try {
        chargeBytes(2, path);
        const out: NullProtoJson[] = [];
        for (let i = 0; i < val.length; i++) {
          const desc = Object.getOwnPropertyDescriptor(val, String(i));
          if (!desc || !('value' in desc) || !desc.enumerable) {
            schemaInvalid('array element must be an enumerable data property', `${path}/${i}`);
          }
          out.push(visit(desc.value, depth + 1, `${path}/${i}`));
        }
        return out;
      } finally {
        active.delete(val);
      }
    }
    if (proto !== Object.prototype && proto !== null) {
      schemaInvalid('unsupported object prototype', path);
    }
    const ownKeys = Reflect.ownKeys(val);
    if (ownKeys.some(k => typeof k === 'symbol')) {
      schemaInvalid('symbol keys are forbidden', path);
    }
    const stringKeys = ownKeys as string[];
    if (stringKeys.length > maxCollection) {
      schemaInvalid(`object exceeds maximum key count ${maxCollection}`, path);
    }
    active.add(val);
    try {
      chargeBytes(2, path);
      const out = createNullRecord<Record<string, NullProtoJson>>();
      for (const key of stringKeys) {
        if (FORBIDDEN_PROTOTYPE_KEYS.has(key)) {
          schemaInvalid(`forbidden prototype key "${key}"`, `${path}/${key}`);
        }
        assertValidStringContent(key, 256, `${path}/${key}`);
        const desc = Object.getOwnPropertyDescriptor(val, key);
        if (!desc || !('value' in desc) || !desc.enumerable) {
          schemaInvalid('object property must be an enumerable data property', `${path}/${key}`);
        }
        if (desc.value === undefined) continue;
        chargeBytes(Buffer.byteLength(key, 'utf8') + 3, `${path}/${key}`);
        out[key] = visit(desc.value, depth + 1, `${path}/${key}`);
      }
      return out;
    } finally {
      active.delete(val);
    }
  };

  return visit(input, 1, rootPath);
}

/** Deterministic canonical JSON serializer sorting object keys lexicographically. */
export function canonicalizeJson(value: unknown): string {
  const sanitized = sanitizeUntrustedValue(value, { maxBytes: 1_048_576, maxCollection: 2_048 });
  const render = (node: NullProtoJson): string => {
    if (node === null || typeof node === 'boolean' || typeof node === 'number' || typeof node === 'string') {
      return JSON.stringify(node);
    }
    if (Array.isArray(node)) {
      return `[${node.map(item => render(item)).join(',')}]`;
    }
    const recordNode = node as { readonly [key: string]: NullProtoJson };
    const keys = Object.keys(recordNode).sort();
    const pairs: string[] = [];
    for (const key of keys) {
      if (!Object.hasOwn(recordNode, key)) continue;
      const child = recordNode[key];
      if (child !== undefined) {
        pairs.push(`${JSON.stringify(key)}:${render(child)}`);
      }
    }
    return `{${pairs.join(',')}}`;
  };
  return render(sanitized);
}

function parseYamlOrJsonInput(
  input: unknown,
  maxBytes: number,
  rootPath = '/',
): NullProtoJson {
  if (typeof input === 'string' || input instanceof Uint8Array) {
    const text = typeof input === 'string' ? input : decodeUtf8Strict(input, rootPath);
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      schemaInvalid(`document exceeds ${maxBytes} bytes`, rootPath);
    }
    if (LONE_SURROGATE_RE.test(text)) {
      schemaInvalid('document contains lone UTF-16 surrogate', rootPath);
    }
    let rawParsed: unknown;
    try {
      rawParsed = parseYamlDocument(text);
    } catch (err) {
      if (err instanceof TaskpackError) {
        schemaInvalid(err.message, err.path ?? rootPath);
      }
      schemaInvalid(err instanceof Error ? err.message : 'invalid YAML/JSON syntax', rootPath);
    }
    return sanitizeUntrustedValue(rawParsed, { maxBytes, path: rootPath });
  }
  return sanitizeUntrustedValue(input, { maxBytes, path: rootPath });
}

function expectObject(
  value: NullProtoJson,
  allowedKeys: ReadonlySet<string>,
  requiredKeys: readonly string[],
  path: string,
): Record<string, NullProtoJson> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    schemaInvalid('expected mapping object', path);
  }
  const obj = value as Record<string, NullProtoJson>;
  for (const key of Object.keys(obj)) {
    if (!Object.hasOwn(obj, key)) continue;
    if (FORBIDDEN_PROTOTYPE_KEYS.has(key) || !allowedKeys.has(key)) {
      schemaInvalid(`unknown or forbidden field "${key}"`, `${path}/${key}`);
    }
  }
  for (const req of requiredKeys) {
    if (!Object.hasOwn(obj, req) || obj[req] === undefined) {
      schemaInvalid(`missing required field "${req}"`, `${path}/${req}`);
    }
  }
  return obj;
}

function expectString(value: NullProtoJson | undefined, minLen: number, maxLen: number, path: string): string {
  if (typeof value !== 'string') {
    schemaInvalid('expected string', path);
  }
  if (value.length < minLen || value.length > maxLen) {
    schemaInvalid(`string length must be within ${minLen}..${maxLen}`, path);
  }
  if (LONE_SURROGATE_RE.test(value)) {
    schemaInvalid('string contains lone UTF-16 surrogate', path);
  }
  return value;
}

function expectIdentifier(value: NullProtoJson | undefined, path: string): string {
  const s = expectString(value, 1, LIMITS.identifier, path);
  if (FORBIDDEN_PROTOTYPE_KEYS.has(s) || !IDENTIFIER_RE.test(s)) {
    schemaInvalid(`invalid identifier "${s}"`, path);
  }
  return s;
}

function expectBucketId(value: NullProtoJson | undefined, path: string): string {
  const s = expectString(value, 1, LIMITS.bucketId, path);
  if (FORBIDDEN_PROTOTYPE_KEYS.has(s) || !BUCKET_ID_RE.test(s)) {
    schemaInvalid(`invalid bucket id "${s}"`, path);
  }
  return s;
}

function expectMetricKey(value: NullProtoJson | undefined, path: string): string {
  const s = expectString(value, 1, LIMITS.metricKey, path);
  if (FORBIDDEN_PROTOTYPE_KEYS.has(s) || !METRIC_KEY_RE.test(s)) {
    schemaInvalid(`invalid metric key "${s}"`, path);
  }
  return s;
}

function expectBoolean(value: NullProtoJson | undefined, path: string): boolean {
  if (typeof value !== 'boolean') {
    schemaInvalid('expected boolean', path);
  }
  return value;
}

function expectInteger(value: NullProtoJson | undefined, min: number, max: number, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < min || value > max) {
    schemaInvalid(`expected integer within ${min}..${max}`, path);
  }
  return value;
}

function expectFiniteNumber(
  value: NullProtoJson | undefined,
  options: { readonly min?: number; readonly minExclusive?: number; readonly max?: number },
  path: string,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0)) {
    schemaInvalid('expected finite non-negative-zero number', path);
  }
  if (options.min !== undefined && value < options.min) {
    schemaInvalid(`number must be >= ${options.min}`, path);
  }
  if (options.minExclusive !== undefined && value <= options.minExclusive) {
    schemaInvalid(`number must be > ${options.minExclusive}`, path);
  }
  if (options.max !== undefined && value > options.max) {
    schemaInvalid(`number must be <= ${options.max}`, path);
  }
  return value;
}

function expectEnum<const T extends string>(
  value: NullProtoJson | undefined,
  allowed: readonly T[],
  path: string,
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    schemaInvalid(`expected one of [${allowed.join(', ')}]`, path);
  }
  return value as T;
}

function expectArray(
  value: NullProtoJson | undefined,
  minLen: number,
  maxLen: number,
  path: string,
): readonly NullProtoJson[] {
  if (!Array.isArray(value)) {
    schemaInvalid('expected array', path);
  }
  if (value.length < minLen || value.length > maxLen) {
    schemaInvalid(`array length must be within ${minLen}..${maxLen}`, path);
  }
  return value;
}

function expectSafeRelativePath(value: NullProtoJson | undefined, path: string): string {
  const raw = expectString(value, 1, LIMITS.path, path);
  if (raw.startsWith('/') || raw.endsWith('/') || raw.includes('\\') || hasControlChar(raw)) {
    schemaInvalid('expected normalized relative POSIX path', path);
  }
  const segments = raw.split('/');
  if (segments.length > LIMITS.segments) {
    schemaInvalid('path exceeds segment depth limit', path);
  }
  for (const segment of segments) {
    if (
      segment.length === 0
      || segment === '.'
      || segment === '..'
      || segment.endsWith('.')
      || FORBIDDEN_PROTOTYPE_KEYS.has(segment)
      || RESERVED_PATH_SEGMENT_RE.test(segment)
      || !PRINTABLE_ASCII_RE.test(segment)
    ) {
      schemaInvalid(`invalid relative path segment "${segment}"`, path);
    }
  }
  return raw;
}

function expectDigest(value: NullProtoJson | undefined, path: string): Digest {
  if (value === undefined) schemaInvalid('missing digest', path);
  const obj = expectObject(value, new Set(['algorithm', 'hex']), ['algorithm', 'hex'], path);
  const algorithm = expectEnum(obj['algorithm'], ['sha256'] as const, `${path}/algorithm`);
  const hex = expectString(obj['hex'], 64, 64, `${path}/hex`);
  if (!SHA256_HEX_RE.test(hex)) {
    schemaInvalid('digest hex must be 64 lowercase hexadecimal characters', `${path}/hex`);
  }
  const out = createNullRecord<{ algorithm: 'sha256'; hex: string }>();
  out.algorithm = algorithm;
  out.hex = hex;
  return out;
}

function assertCleanSecrets(serialized: string, scrubber: SecretScrubber, path: string): void {
  if (scrubber.containsSecret(serialized)) {
    throw new EvolutionError('SECRET_LEAK_DETECTED', `secret material detected at ${path}`, path);
  }
}

export interface ParseEvolutionCampaignOptions {
  readonly scrubber?: SecretScrubber;
}

const ROOT_CAMPAIGN_KEYS = new Set(['apiVersion', 'kind', 'metadata', 'spec']);
const METADATA_KEYS = new Set(['name', 'description']);
const SPEC_KEYS = new Set([
  'taskpack',
  'targetCellId',
  'heldOutWorkloadId',
  'tracks',
  'stages',
  'population',
  'sampling',
  'teamEvolution',
  'objectives',
  'budgets',
  'export',
]);
const STAGES_KEYS = new Set(['mode', 'heldOutWorkloadId', 'specialistBuckets', 'portfolioHeldOutWorkloadId']);
const SPECIALIST_BUCKET_KEYS = new Set(['id', 'heldOutWorkloadId']);
const POPULATION_KEYS = new Set(['islands', 'migrationIntervalGenerations', 'maxMigrationElites', 'nicheAxes']);
const ENUM_AXIS_KEYS = new Set(['id', 'kind', 'field', 'values']);
const NUMERIC_BINS_AXIS_KEYS = new Set(['id', 'kind', 'field', 'edges']);
const SAMPLING_KEYS = new Set(['noveltyDecayLambda', 'mutationWeights', 'modelBandit', 'maxCrossoversPerPrompt']);
const MUTATION_WEIGHTS_KEYS = new Set(['diff_tune', 'full_rewrite', 'crossover']);
const TEAM_EVOLUTION_KEYS = new Set([
  'enabled',
  'supervisorRoleId',
  'allowedArchetypeRoles',
  'stallGenerations',
  'minHypervolumeDelta',
  'triggerOnRunEvalPathology',
  'trialGenerations',
  'maxTeamSize',
  'maxTeamSteps',
]);
const OBJECTIVE_KEYS = new Set(['metric', 'direction']);
const BUDGETS_KEYS = new Set([
  'maxGenerations',
  'maxEvaluations',
  'maxConcurrentEvaluations',
  'targetRooflineHeadroom',
  'scratchpadIntervalGenerations',
]);
const EXPORT_KEYS = new Set(['format', 'outputDir']);

/** Parse and validate an `EvolutionCampaign` YAML/JSON document (`<= 65,536` bytes) into null-prototype records. */
export function parseEvolutionCampaignDocument(
  input: unknown,
  options: ParseEvolutionCampaignOptions = {},
): EvolutionCampaignManifest {
  const scrubber = options.scrubber ?? DEFAULT_SECRET_SCRUBBER;
  const rootVal = parseYamlOrJsonInput(input, EVOLUTION_CAMPAIGN_MAX_BYTES, '');
  const root = expectObject(rootVal, ROOT_CAMPAIGN_KEYS, ['apiVersion', 'kind', 'metadata', 'spec'], '');

  if (root['apiVersion'] !== EVOLUTION_API_VERSION) {
    schemaInvalid(`unsupported apiVersion "${String(root['apiVersion'])}"`, '/apiVersion');
  }
  if (root['kind'] !== EVOLUTION_CAMPAIGN_KIND) {
    schemaInvalid(`expected kind "${EVOLUTION_CAMPAIGN_KIND}"`, '/kind');
  }

  const metaObj = expectObject(root['metadata']!, METADATA_KEYS, ['name'], '/metadata');
  const metadata = createNullRecord<{ name: string; description?: string }>();
  metadata.name = expectIdentifier(metaObj['name'], '/metadata/name');
  if (Object.hasOwn(metaObj, 'description') && metaObj['description'] !== undefined) {
    const desc = expectString(metaObj['description'], 1, 1_024, '/metadata/description');
    if (hasDisallowedInlineControlChar(desc)) schemaInvalid('invalid control character in description', '/metadata/description');
    metadata.description = desc;
  }

  const specObj = expectObject(
    root['spec']!,
    SPEC_KEYS,
    ['taskpack', 'targetCellId', 'population', 'sampling', 'objectives', 'budgets'],
    '/spec',
  );

  const taskpack = expectSafeRelativePath(specObj['taskpack'], '/spec/taskpack');
  const targetCellId = expectIdentifier(specObj['targetCellId'], '/spec/targetCellId');

  let topHeldOutWorkloadId: string | undefined;
  if (Object.hasOwn(specObj, 'heldOutWorkloadId') && specObj['heldOutWorkloadId'] !== undefined) {
    topHeldOutWorkloadId = expectBucketId(specObj['heldOutWorkloadId'], '/spec/heldOutWorkloadId');
  }

  let tracks: readonly string[] | undefined;
  if (Object.hasOwn(specObj, 'tracks') && specObj['tracks'] !== undefined) {
    const rawTracks = expectArray(specObj['tracks'], 1, 32, '/spec/tracks');
    const seenTracks = new Set<string>();
    const parsedTracks: string[] = [];
    for (let i = 0; i < rawTracks.length; i++) {
      const trackId = expectIdentifier(rawTracks[i], `/spec/tracks/${i}`);
      if (seenTracks.has(trackId)) schemaInvalid(`duplicate track "${trackId}"`, `/spec/tracks/${i}`);
      seenTracks.add(trackId);
      parsedTracks.push(trackId);
    }
    tracks = parsedTracks;
  }

  // Stages
  let stages: EvolutionStagesSpec;
  if (!Object.hasOwn(specObj, 'stages') || specObj['stages'] === undefined) {
    const singleStages = createNullRecord<{ mode: 'single-target'; heldOutWorkloadId?: string }>();
    singleStages.mode = 'single-target';
    if (topHeldOutWorkloadId !== undefined) {
      singleStages.heldOutWorkloadId = topHeldOutWorkloadId;
    }
    stages = singleStages;
  } else {
    const stagesObj = expectObject(specObj['stages'], STAGES_KEYS, [], '/spec/stages');
    const mode = Object.hasOwn(stagesObj, 'mode') && stagesObj['mode'] !== undefined
      ? expectEnum(stagesObj['mode'], ['single-target', 'specialist-then-portfolio'] as const, '/spec/stages/mode')
      : 'single-target';
    if (mode === 'single-target') {
      if (Object.hasOwn(stagesObj, 'specialistBuckets') || Object.hasOwn(stagesObj, 'portfolioHeldOutWorkloadId')) {
        schemaInvalid('specialistBuckets and portfolioHeldOutWorkloadId require specialist-then-portfolio mode', '/spec/stages');
      }
      const singleStages = createNullRecord<{ mode: 'single-target'; heldOutWorkloadId?: string }>();
      singleStages.mode = 'single-target';
      if (Object.hasOwn(stagesObj, 'heldOutWorkloadId') && stagesObj['heldOutWorkloadId'] !== undefined) {
        singleStages.heldOutWorkloadId = expectBucketId(stagesObj['heldOutWorkloadId'], '/spec/stages/heldOutWorkloadId');
      } else if (topHeldOutWorkloadId !== undefined) {
        singleStages.heldOutWorkloadId = topHeldOutWorkloadId;
      }
      stages = singleStages;
    } else {
      if (Object.hasOwn(stagesObj, 'heldOutWorkloadId')) {
        schemaInvalid('heldOutWorkloadId is not valid on specialist-then-portfolio stages', '/spec/stages/heldOutWorkloadId');
      }
      if (!Object.hasOwn(stagesObj, 'specialistBuckets') || !Object.hasOwn(stagesObj, 'portfolioHeldOutWorkloadId')) {
        schemaInvalid('specialist-then-portfolio requires specialistBuckets and portfolioHeldOutWorkloadId', '/spec/stages');
      }
      const rawBuckets = expectArray(stagesObj['specialistBuckets'], 1, 64, '/spec/stages/specialistBuckets');
      const seenBucketIds = new Set<string>();
      const specialistBuckets: EvolutionSpecialistBucket[] = [];
      for (let i = 0; i < rawBuckets.length; i++) {
        const bPath = `/spec/stages/specialistBuckets/${i}`;
        const bObj = expectObject(rawBuckets[i]!, SPECIALIST_BUCKET_KEYS, ['id', 'heldOutWorkloadId'], bPath);
        const id = expectBucketId(bObj['id'], `${bPath}/id`);
        if (seenBucketIds.has(id)) schemaInvalid(`duplicate specialist bucket "${id}"`, `${bPath}/id`);
        seenBucketIds.add(id);
        const heldOutWorkloadId = expectBucketId(bObj['heldOutWorkloadId'], `${bPath}/heldOutWorkloadId`);
        const bucketRec = createNullRecord<{ id: string; heldOutWorkloadId: string }>();
        bucketRec.id = id;
        bucketRec.heldOutWorkloadId = heldOutWorkloadId;
        specialistBuckets.push(bucketRec);
      }
      const portfolioHeldOutWorkloadId = expectBucketId(
        stagesObj['portfolioHeldOutWorkloadId'],
        '/spec/stages/portfolioHeldOutWorkloadId',
      );
      const portfolioStages = createNullRecord<{
        mode: 'specialist-then-portfolio';
        specialistBuckets: readonly EvolutionSpecialistBucket[];
        portfolioHeldOutWorkloadId: string;
      }>();
      portfolioStages.mode = 'specialist-then-portfolio';
      portfolioStages.specialistBuckets = specialistBuckets;
      portfolioStages.portfolioHeldOutWorkloadId = portfolioHeldOutWorkloadId;
      stages = portfolioStages;
    }
  }

  // Population
  const popObj = expectObject(
    specObj['population']!,
    POPULATION_KEYS,
    ['islands', 'migrationIntervalGenerations', 'maxMigrationElites', 'nicheAxes'],
    '/spec/population',
  );
  const islands = expectInteger(popObj['islands'], 1, 16, '/spec/population/islands');
  const migrationIntervalGenerations = expectInteger(
    popObj['migrationIntervalGenerations'],
    1,
    1_024,
    '/spec/population/migrationIntervalGenerations',
  );
  const maxMigrationElites = expectInteger(
    popObj['maxMigrationElites'],
    0,
    16,
    '/spec/population/maxMigrationElites',
  );
  const rawAxes = expectArray(popObj['nicheAxes'], 1, 4, '/spec/population/nicheAxes');
  const seenAxisIds = new Set<string>();
  const nicheAxes: EvolutionNicheAxis[] = [];
  for (let i = 0; i < rawAxes.length; i++) {
    const aPath = `/spec/population/nicheAxes/${i}`;
    const rawAxis = rawAxes[i]!;
    if (rawAxis === null || typeof rawAxis !== 'object' || Array.isArray(rawAxis)) {
      schemaInvalid('niche axis must be an object', aPath);
    }
    const axisRecord = rawAxis as Record<string, NullProtoJson>;
    const kind = expectEnum(axisRecord['kind'], ['enum', 'numeric_bins'] as const, `${aPath}/kind`);
    if (kind === 'enum') {
      const enumObj = expectObject(rawAxis, ENUM_AXIS_KEYS, ['id', 'kind', 'values'], aPath);
      const id = expectMetricKey(enumObj['id'], `${aPath}/id`);
      if (seenAxisIds.has(id)) schemaInvalid(`duplicate niche axis "${id}"`, `${aPath}/id`);
      seenAxisIds.add(id);
      const rawValues = expectArray(enumObj['values'], 1, 32, `${aPath}/values`);
      const seenValues = new Set<string>();
      const values: string[] = [];
      for (let j = 0; j < rawValues.length; j++) {
        const val = expectMetricKey(rawValues[j], `${aPath}/values/${j}`);
        if (seenValues.has(val)) schemaInvalid(`duplicate enum value "${val}"`, `${aPath}/values/${j}`);
        seenValues.add(val);
        values.push(val);
      }
      const axis = createNullRecord<{
        id: string;
        kind: 'enum';
        field?: string;
        values: readonly string[];
      }>();
      axis.id = id;
      axis.kind = 'enum';
      if (Object.hasOwn(enumObj, 'field') && enumObj['field'] !== undefined) {
        axis.field = expectMetricKey(enumObj['field'], `${aPath}/field`);
      }
      axis.values = values;
      nicheAxes.push(axis as EvolutionEnumNicheAxis);
    } else {
      const binsObj = expectObject(rawAxis, NUMERIC_BINS_AXIS_KEYS, ['id', 'kind', 'edges'], aPath);
      const id = expectMetricKey(binsObj['id'], `${aPath}/id`);
      if (seenAxisIds.has(id)) schemaInvalid(`duplicate niche axis "${id}"`, `${aPath}/id`);
      seenAxisIds.add(id);
      const rawEdges = expectArray(binsObj['edges'], 2, 32, `${aPath}/edges`);
      const edges: number[] = [];
      for (let j = 0; j < rawEdges.length; j++) {
        const edge = expectFiniteNumber(rawEdges[j], {}, `${aPath}/edges/${j}`);
        if (j > 0 && edge <= edges[j - 1]!) {
          schemaInvalid('numeric_bins edges must be strictly increasing', `${aPath}/edges/${j}`);
        }
        edges.push(edge);
      }
      const axis = createNullRecord<{
        id: string;
        kind: 'numeric_bins';
        field?: string;
        edges: readonly number[];
      }>();
      axis.id = id;
      axis.kind = 'numeric_bins';
      if (Object.hasOwn(binsObj, 'field') && binsObj['field'] !== undefined) {
        axis.field = expectMetricKey(binsObj['field'], `${aPath}/field`);
      }
      axis.edges = edges;
      nicheAxes.push(axis as EvolutionNumericBinsNicheAxis);
    }
  }
  const population = createNullRecord<{
    islands: number;
    migrationIntervalGenerations: number;
    maxMigrationElites: number;
    nicheAxes: readonly EvolutionNicheAxis[];
  }>();
  population.islands = islands;
  population.migrationIntervalGenerations = migrationIntervalGenerations;
  population.maxMigrationElites = maxMigrationElites;
  population.nicheAxes = nicheAxes;

  // Sampling
  const sampObj = expectObject(
    specObj['sampling']!,
    SAMPLING_KEYS,
    ['noveltyDecayLambda', 'mutationWeights', 'maxCrossoversPerPrompt'],
    '/spec/sampling',
  );
  const noveltyDecayLambda = expectFiniteNumber(
    sampObj['noveltyDecayLambda'],
    { minExclusive: 0, max: 100 },
    '/spec/sampling/noveltyDecayLambda',
  );
  const weightsObj = expectObject(
    sampObj['mutationWeights']!,
    MUTATION_WEIGHTS_KEYS,
    ['diff_tune', 'full_rewrite', 'crossover'],
    '/spec/sampling/mutationWeights',
  );
  const diffTune = expectFiniteNumber(weightsObj['diff_tune'], { min: 0, max: 1_000 }, '/spec/sampling/mutationWeights/diff_tune');
  const fullRewrite = expectFiniteNumber(weightsObj['full_rewrite'], { min: 0, max: 1_000 }, '/spec/sampling/mutationWeights/full_rewrite');
  const crossover = expectFiniteNumber(weightsObj['crossover'], { min: 0, max: 1_000 }, '/spec/sampling/mutationWeights/crossover');
  if (diffTune + fullRewrite + crossover <= 0) {
    schemaInvalid('mutationWeights sum must be > 0', '/spec/sampling/mutationWeights');
  }
  const mutationWeights = createNullRecord<{
    diff_tune: number;
    full_rewrite: number;
    crossover: number;
  }>();
  mutationWeights.diff_tune = diffTune;
  mutationWeights.full_rewrite = fullRewrite;
  mutationWeights.crossover = crossover;

  const modelBandit: EvolutionModelBanditStrategy = Object.hasOwn(sampObj, 'modelBandit') && sampObj['modelBandit'] !== undefined
    ? expectEnum(sampObj['modelBandit'], ['deterministic-round-robin', 'ucb1'] as const, '/spec/sampling/modelBandit')
    : 'deterministic-round-robin';
  const maxCrossoversPerPrompt = expectInteger(
    sampObj['maxCrossoversPerPrompt'],
    0,
    4,
    '/spec/sampling/maxCrossoversPerPrompt',
  );
  const sampling = createNullRecord<{
    noveltyDecayLambda: number;
    mutationWeights: EvolutionMutationWeights;
    modelBandit: EvolutionModelBanditStrategy;
    maxCrossoversPerPrompt: number;
  }>();
  sampling.noveltyDecayLambda = noveltyDecayLambda;
  sampling.mutationWeights = mutationWeights;
  sampling.modelBandit = modelBandit;
  sampling.maxCrossoversPerPrompt = maxCrossoversPerPrompt;

  // Optional teamEvolution
  let teamEvolution: EvolutionTeamSpec | undefined;
  if (Object.hasOwn(specObj, 'teamEvolution') && specObj['teamEvolution'] !== undefined) {
    const teamObj = expectObject(
      specObj['teamEvolution'],
      TEAM_EVOLUTION_KEYS,
      ['enabled', 'supervisorRoleId', 'allowedArchetypeRoles'],
      '/spec/teamEvolution',
    );
    const enabled = expectBoolean(teamObj['enabled'], '/spec/teamEvolution/enabled');
    const supervisorRoleId = expectIdentifier(teamObj['supervisorRoleId'], '/spec/teamEvolution/supervisorRoleId');
    const rawArchetypes = expectArray(
      teamObj['allowedArchetypeRoles'],
      enabled ? 1 : 0,
      16,
      '/spec/teamEvolution/allowedArchetypeRoles',
    );
    const seenArchetypes = new Set<string>();
    const allowedArchetypeRoles: string[] = [];
    for (let i = 0; i < rawArchetypes.length; i++) {
      const roleId = expectIdentifier(rawArchetypes[i], `/spec/teamEvolution/allowedArchetypeRoles/${i}`);
      if (seenArchetypes.has(roleId)) {
        schemaInvalid(`duplicate archetype role "${roleId}"`, `/spec/teamEvolution/allowedArchetypeRoles/${i}`);
      }
      seenArchetypes.add(roleId);
      allowedArchetypeRoles.push(roleId);
    }
    const stallGenerations = Object.hasOwn(teamObj, 'stallGenerations') && teamObj['stallGenerations'] !== undefined
      ? expectInteger(teamObj['stallGenerations'], 1, 32, '/spec/teamEvolution/stallGenerations')
      : 4;
    const minHypervolumeDelta = Object.hasOwn(teamObj, 'minHypervolumeDelta') && teamObj['minHypervolumeDelta'] !== undefined
      ? expectFiniteNumber(teamObj['minHypervolumeDelta'], { min: 0 }, '/spec/teamEvolution/minHypervolumeDelta')
      : 0.001;
    const triggerOnRunEvalPathology = Object.hasOwn(teamObj, 'triggerOnRunEvalPathology') && teamObj['triggerOnRunEvalPathology'] !== undefined
      ? expectBoolean(teamObj['triggerOnRunEvalPathology'], '/spec/teamEvolution/triggerOnRunEvalPathology')
      : true;
    const trialGenerations = Object.hasOwn(teamObj, 'trialGenerations') && teamObj['trialGenerations'] !== undefined
      ? expectInteger(teamObj['trialGenerations'], 1, 8, '/spec/teamEvolution/trialGenerations')
      : 2;
    const maxTeamSize = Object.hasOwn(teamObj, 'maxTeamSize') && teamObj['maxTeamSize'] !== undefined
      ? expectInteger(teamObj['maxTeamSize'], 1, 4, '/spec/teamEvolution/maxTeamSize')
      : 4;
    const maxTeamSteps = Object.hasOwn(teamObj, 'maxTeamSteps') && teamObj['maxTeamSteps'] !== undefined
      ? expectInteger(teamObj['maxTeamSteps'], 1, 6, '/spec/teamEvolution/maxTeamSteps')
      : 6;

    const teamRec = createNullRecord<{
      enabled: boolean;
      supervisorRoleId: string;
      allowedArchetypeRoles: readonly string[];
      stallGenerations: number;
      minHypervolumeDelta: number;
      triggerOnRunEvalPathology: boolean;
      trialGenerations: number;
      maxTeamSize: number;
      maxTeamSteps: number;
    }>();
    teamRec.enabled = enabled;
    teamRec.supervisorRoleId = supervisorRoleId;
    teamRec.allowedArchetypeRoles = allowedArchetypeRoles;
    teamRec.stallGenerations = stallGenerations;
    teamRec.minHypervolumeDelta = minHypervolumeDelta;
    teamRec.triggerOnRunEvalPathology = triggerOnRunEvalPathology;
    teamRec.trialGenerations = trialGenerations;
    teamRec.maxTeamSize = maxTeamSize;
    teamRec.maxTeamSteps = maxTeamSteps;
    teamEvolution = teamRec;
  }

  // Objectives
  const rawObjectives = expectArray(specObj['objectives'], 1, 8, '/spec/objectives');
  const seenMetrics = new Set<string>();
  const objectives: ObjectiveDirectionSpec[] = [];
  for (let i = 0; i < rawObjectives.length; i++) {
    const oPath = `/spec/objectives/${i}`;
    const oObj = expectObject(rawObjectives[i]!, OBJECTIVE_KEYS, ['metric', 'direction'], oPath);
    const metric = expectMetricKey(oObj['metric'], `${oPath}/metric`);
    if (seenMetrics.has(metric)) {
      schemaInvalid(`duplicate objective metric "${metric}"`, `${oPath}/metric`);
    }
    seenMetrics.add(metric);
    const direction = expectEnum(oObj['direction'], ['minimize', 'maximize'] as const, `${oPath}/direction`);
    const objRec = createNullRecord<{ metric: string; direction: 'minimize' | 'maximize' }>();
    objRec.metric = metric;
    objRec.direction = direction;
    objectives.push(objRec);
  }

  // Budgets
  const budObj = expectObject(
    specObj['budgets']!,
    BUDGETS_KEYS,
    ['maxGenerations', 'maxEvaluations', 'maxConcurrentEvaluations'],
    '/spec/budgets',
  );
  const maxGenerations = expectInteger(budObj['maxGenerations'], 1, 10_000, '/spec/budgets/maxGenerations');
  const maxEvaluations = expectInteger(budObj['maxEvaluations'], 1, 100_000, '/spec/budgets/maxEvaluations');
  const maxConcurrentEvaluations = expectInteger(
    budObj['maxConcurrentEvaluations'],
    1,
    64,
    '/spec/budgets/maxConcurrentEvaluations',
  );
  if (maxConcurrentEvaluations > maxEvaluations) {
    schemaInvalid('maxConcurrentEvaluations cannot exceed maxEvaluations', '/spec/budgets/maxConcurrentEvaluations');
  }
  const scratchpadIntervalGenerations = Object.hasOwn(budObj, 'scratchpadIntervalGenerations') && budObj['scratchpadIntervalGenerations'] !== undefined
    ? expectInteger(budObj['scratchpadIntervalGenerations'], 1, 32, '/spec/budgets/scratchpadIntervalGenerations')
    : 5;
  const budgets = createNullRecord<{
    maxGenerations: number;
    maxEvaluations: number;
    maxConcurrentEvaluations: number;
    targetRooflineHeadroom?: number;
    scratchpadIntervalGenerations: number;
  }>();
  budgets.maxGenerations = maxGenerations;
  budgets.maxEvaluations = maxEvaluations;
  budgets.maxConcurrentEvaluations = maxConcurrentEvaluations;
  if (Object.hasOwn(budObj, 'targetRooflineHeadroom') && budObj['targetRooflineHeadroom'] !== undefined) {
    budgets.targetRooflineHeadroom = expectFiniteNumber(
      budObj['targetRooflineHeadroom'],
      { min: 1.0 },
      '/spec/budgets/targetRooflineHeadroom',
    );
  }
  budgets.scratchpadIntervalGenerations = scratchpadIntervalGenerations;

  // Optional export
  let exportSpec: EvolutionExportSpec | undefined;
  if (Object.hasOwn(specObj, 'export') && specObj['export'] !== undefined) {
    const expObj = expectObject(specObj['export'], EXPORT_KEYS, ['outputDir'], '/spec/export');
    const format: EvolutionExportFormat = Object.hasOwn(expObj, 'format') && expObj['format'] !== undefined
      ? expectEnum(expObj['format'], ['dir', 'oci-layout'] as const, '/spec/export/format')
      : 'dir';
    const outputDir = expectSafeRelativePath(expObj['outputDir'], '/spec/export/outputDir');
    const expRec = createNullRecord<{ format: EvolutionExportFormat; outputDir: string }>();
    expRec.format = format;
    expRec.outputDir = outputDir;
    exportSpec = expRec;
  }

  const spec = createNullRecord<{
    taskpack: string;
    targetCellId: string;
    heldOutWorkloadId?: string;
    tracks?: readonly string[];
    stages: EvolutionStagesSpec;
    population: EvolutionPopulationSpec;
    sampling: EvolutionSamplingSpec;
    teamEvolution?: EvolutionTeamSpec;
    objectives: readonly ObjectiveDirectionSpec[];
    budgets: EvolutionBudgetsSpec;
    export?: EvolutionExportSpec;
  }>();
  spec.taskpack = taskpack;
  spec.targetCellId = targetCellId;
  if (topHeldOutWorkloadId !== undefined) spec.heldOutWorkloadId = topHeldOutWorkloadId;
  if (tracks !== undefined) spec.tracks = tracks;
  spec.stages = stages;
  spec.population = population as EvolutionPopulationSpec;
  spec.sampling = sampling as EvolutionSamplingSpec;
  if (teamEvolution !== undefined) spec.teamEvolution = teamEvolution;
  spec.objectives = objectives;
  spec.budgets = budgets as EvolutionBudgetsSpec;
  if (exportSpec !== undefined) spec.export = exportSpec;

  const manifest = createNullRecord<{
    apiVersion: typeof EVOLUTION_API_VERSION;
    kind: typeof EVOLUTION_CAMPAIGN_KIND;
    metadata: EvolutionCampaignMetadata;
    spec: EvolutionCampaignSpec;
  }>();
  manifest.apiVersion = EVOLUTION_API_VERSION;
  manifest.kind = EVOLUTION_CAMPAIGN_KIND;
  manifest.metadata = metadata;
  manifest.spec = spec as EvolutionCampaignSpec;

  assertCleanSecrets(canonicalizeJson(manifest), scrubber, '/');
  return manifest as EvolutionCampaignManifest;
}

/** Load an `EvolutionCampaign` file (`O_NOFOLLOW`, `<= 65,536` bytes), rejecting symlinks fail-closed. */
export async function loadEvolutionCampaignFile(
  filePath: string,
  options: ParseEvolutionCampaignOptions = {},
): Promise<EvolutionCampaignManifest> {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    schemaInvalid('filePath must be a non-empty string', '/filePath');
  }
  const st = await lstat(filePath).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ELOOP') {
      throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `symlink forbidden along ${filePath}`, filePath);
    }
    return null;
  });
  if (st !== null && st.isSymbolicLink()) {
    throw new EvolutionError('EVOLUTION_SYMLINK_FORBIDDEN', `campaign manifest cannot be a symlink: ${filePath}`, filePath);
  }
  const bytes = await readBoundedRegularFile(filePath, EVOLUTION_CAMPAIGN_MAX_BYTES, message => {
    throw new EvolutionError('EVOLUTION_SCHEMA_INVALID', message, filePath);
  });
  return parseEvolutionCampaignDocument(bytes, options);
}

// ---------------------------------------------------------------------------
// TeamPatchV1 (`team-patch.v1`) parser & strict acyclic DAG validator
// ---------------------------------------------------------------------------

export interface ParseTeamPatchOptions {
  readonly maxTeamSize?: number;
  readonly maxTeamSteps?: number;
  readonly scrubber?: SecretScrubber;
}

const TEAM_PATCH_ROOT_KEYS = new Set(['kind', 'schemaVersion', 'diagnosis', 'roles', 'steps']);
const TEAM_DIAGNOSIS_KEYS = new Set(['summary', 'plateauCategory', 'rationale']);
const TEAM_ROLE_KEYS = new Set([
  'id',
  'archetypeRoleId',
  'purpose',
  'prompt',
  'model',
  'thinking',
  'tools',
  'resourceIds',
  'timeoutSeconds',
]);
const TEAM_STEP_KEYS = new Set(['id', 'roleId', 'dependsOn', 'handoffs', 'onRework']);
const REWORK_POLICY_KEYS = new Set(['rejectTo', 'maxReworks']);
const HANDOFF_SELECTOR_KEYS = new Set(['id', 'fromStep', 'source', 'select', 'maxBytes', 'required']);

function parseHandoffHeading(raw: string, path: string): string {
  if (raw.length < 1 || raw.length > HANDOFF_LIMITS.maxHeadingChars || hasControlChar(raw) || raw.trim().length === 0) {
    schemaInvalid('invalid markdown handoff heading', path);
  }
  const trimmed = raw.trim();
  const headingBody = /^(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(trimmed)?.[2] ?? trimmed;
  const cleaned = headingBody.replace(/[ \t]+$/, '');
  const title = /^#+$/.test(cleaned) ? '' : cleaned.replace(/[ \t]+#+$/, '').trim();
  if (title.length === 0) {
    schemaInvalid('markdown heading title cannot be empty', path);
  }
  return raw;
}

function parseRfc6901JsonPointer(raw: string, path: string): string {
  if (raw.length > HANDOFF_LIMITS.maxPointerChars || hasControlChar(raw)) {
    schemaInvalid('invalid JSON pointer', path);
  }
  if (raw === '') return raw;
  if (!raw.startsWith('/')) {
    schemaInvalid('non-empty JSON pointer must start with "/"', path);
  }
  const segments = raw.slice(1).split('/');
  if (segments.length > LIMITS.segments) {
    schemaInvalid('JSON pointer exceeds segment depth limit', path);
  }
  for (const seg of segments) {
    let decoded = '';
    for (let i = 0; i < seg.length; i++) {
      const ch = seg.charAt(i);
      if (ch === '~') {
        const next = seg.charAt(i + 1);
        if (next === '0') {
          decoded += '~';
          i++;
        } else if (next === '1') {
          decoded += '/';
          i++;
        } else {
          schemaInvalid('invalid JSON pointer "~" escape', path);
        }
      } else {
        decoded += ch;
      }
    }
    if (FORBIDDEN_PROTOTYPE_KEYS.has(decoded)) {
      schemaInvalid(`forbidden prototype key in JSON pointer "${decoded}"`, path);
    }
  }
  return raw;
}

function parseStepHandoffSelectorValue(value: NullProtoJson, path: string): StepHandoffSelector {
  const obj = expectObject(value, HANDOFF_SELECTOR_KEYS, ['fromStep', 'source', 'select'], path);
  const fromStep = expectIdentifier(obj['fromStep'], `${path}/fromStep`);

  const srcVal = obj['source']!;
  if (srcVal === null || typeof srcVal !== 'object' || Array.isArray(srcVal)) {
    schemaInvalid('handoff source must be an object', `${path}/source`);
  }
  const srcKind = expectEnum(
    (srcVal as Record<string, NullProtoJson>)['kind'],
    ['artifact', 'submission', 'verdict'] as const,
    `${path}/source/kind`,
  );
  let source: StepHandoffSource;
  if (srcKind === 'artifact') {
    const artObj = expectObject(srcVal, new Set(['kind', 'path']), ['kind', 'path'], `${path}/source`);
    const relPath = expectString(artObj['path'], 1, LIMITS.path, `${path}/source/path`);
    const vRes = validateRelativePath(relPath);
    if (!vRes.ok) schemaInvalid('invalid handoff artifact relative path', `${path}/source/path`);
    const rec = createNullRecord<{ kind: 'artifact'; path: string }>();
    rec.kind = 'artifact';
    rec.path = vRes.value;
    source = rec;
  } else if (srcKind === 'submission') {
    expectObject(srcVal, new Set(['kind']), ['kind'], `${path}/source`);
    const rec = createNullRecord<{ kind: 'submission' }>();
    rec.kind = 'submission';
    source = rec;
  } else {
    expectObject(srcVal, new Set(['kind']), ['kind'], `${path}/source`);
    const rec = createNullRecord<{ kind: 'verdict' }>();
    rec.kind = 'verdict';
    source = rec;
  }

  const selVal = obj['select']!;
  if (selVal === null || typeof selVal !== 'object' || Array.isArray(selVal)) {
    schemaInvalid('handoff select must be an object', `${path}/select`);
  }
  const selKind = expectEnum(
    (selVal as Record<string, NullProtoJson>)['kind'],
    ['markdown_heading', 'json_pointer', 'full'] as const,
    `${path}/select/kind`,
  );
  let select: StepHandoffSelect;
  if (selKind === 'markdown_heading') {
    const mhObj = expectObject(
      selVal,
      new Set(['kind', 'heading', 'includeSubheadings']),
      ['kind', 'heading'],
      `${path}/select`,
    );
    const heading = parseHandoffHeading(
      expectString(mhObj['heading'], 1, HANDOFF_LIMITS.maxHeadingChars, `${path}/select/heading`),
      `${path}/select/heading`,
    );
    const rec = createNullRecord<{ kind: 'markdown_heading'; heading: string; includeSubheadings?: boolean }>();
    rec.kind = 'markdown_heading';
    rec.heading = heading;
    if (Object.hasOwn(mhObj, 'includeSubheadings') && mhObj['includeSubheadings'] !== undefined) {
      rec.includeSubheadings = expectBoolean(mhObj['includeSubheadings'], `${path}/select/includeSubheadings`);
    }
    select = rec;
  } else if (selKind === 'json_pointer') {
    const jpObj = expectObject(selVal, new Set(['kind', 'pointers']), ['kind', 'pointers'], `${path}/select`);
    const rawPtrs = expectArray(jpObj['pointers'], 1, HANDOFF_LIMITS.maxPointers, `${path}/select/pointers`);
    const seenPtrs = new Set<string>();
    const pointers: string[] = [];
    for (let i = 0; i < rawPtrs.length; i++) {
      const ptr = parseRfc6901JsonPointer(
        expectString(rawPtrs[i], 0, HANDOFF_LIMITS.maxPointerChars, `${path}/select/pointers/${i}`),
        `${path}/select/pointers/${i}`,
      );
      if (seenPtrs.has(ptr)) schemaInvalid(`duplicate JSON pointer "${ptr}"`, `${path}/select/pointers/${i}`);
      seenPtrs.add(ptr);
      pointers.push(ptr);
    }
    const rec = createNullRecord<{ kind: 'json_pointer'; pointers: readonly string[] }>();
    rec.kind = 'json_pointer';
    rec.pointers = pointers;
    select = rec;
  } else {
    expectObject(selVal, new Set(['kind']), ['kind'], `${path}/select`);
    const rec = createNullRecord<{ kind: 'full' }>();
    rec.kind = 'full';
    select = rec;
  }

  const out = createNullRecord<{
    id?: string;
    fromStep: string;
    source: StepHandoffSource;
    select: StepHandoffSelect;
    maxBytes?: number;
    required?: boolean;
  }>();
  if (Object.hasOwn(obj, 'id') && obj['id'] !== undefined) {
    out.id = expectIdentifier(obj['id'], `${path}/id`);
  }
  out.fromStep = fromStep;
  out.source = source;
  out.select = select;
  if (Object.hasOwn(obj, 'maxBytes') && obj['maxBytes'] !== undefined) {
    out.maxBytes = expectInteger(obj['maxBytes'], HANDOFF_LIMITS.minBytes, HANDOFF_LIMITS.maxBytes, `${path}/maxBytes`);
  }
  if (Object.hasOwn(obj, 'required') && obj['required'] !== undefined) {
    out.required = expectBoolean(obj['required'], `${path}/required`);
  }
  return out as StepHandoffSelector;
}

export function parseTeamDiagnosisValue(value: NullProtoJson, path: string): TeamPatchDiagnosis {
  const diagObj = expectObject(value, TEAM_DIAGNOSIS_KEYS, ['summary', 'plateauCategory', 'rationale'], path);
  const summary = expectString(diagObj['summary'], 1, TEAM_PATCH_DIAGNOSIS_MAX_BYTES, `${path}/summary`);
  if (hasDisallowedInlineControlChar(summary) || summary.trim().length === 0) {
    schemaInvalid('diagnosis.summary must be non-empty printable text', `${path}/summary`);
  }
  const plateauCategoryRaw = expectString(diagObj['plateauCategory'], 1, 64, `${path}/plateauCategory`);
  if (!PLATEAU_CATEGORIES.has(plateauCategoryRaw as TeamPlateauCategory)) {
    schemaInvalid(`invalid plateauCategory "${plateauCategoryRaw}"`, `${path}/plateauCategory`);
  }
  const rationale = expectString(diagObj['rationale'], 1, TEAM_PATCH_DIAGNOSIS_MAX_BYTES, `${path}/rationale`);
  if (hasDisallowedInlineControlChar(rationale) || rationale.trim().length === 0) {
    schemaInvalid('diagnosis.rationale must be non-empty printable text', `${path}/rationale`);
  }

  const diagnosis = createNullRecord<{
    summary: string;
    plateauCategory: TeamPlateauCategory;
    rationale: string;
  }>();
  diagnosis.summary = summary;
  diagnosis.plateauCategory = plateauCategoryRaw as TeamPlateauCategory;
  diagnosis.rationale = rationale;

  if (Buffer.byteLength(canonicalizeJson(diagnosis), 'utf8') > TEAM_PATCH_DIAGNOSIS_MAX_BYTES) {
    schemaInvalid(`diagnosis exceeds ${TEAM_PATCH_DIAGNOSIS_MAX_BYTES} bytes`, path);
  }
  return diagnosis;
}

export function parseTeamDiagnosisJson(rawJson: string): TeamPatchDiagnosis {
  const parsed = parseNullProtoJson(rawJson, TEAM_PATCH_DIAGNOSIS_MAX_BYTES, '/diagnosis');
  return parseTeamDiagnosisValue(parsed, '/diagnosis');
}

function collectStrictAncestors(
  stepId: string,
  depsByStep: ReadonlyMap<string, readonly string[]>,
): ReadonlySet<string> {
  const ancestors = new Set<string>();
  const stack = [...(depsByStep.get(stepId) ?? [])];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (ancestors.has(cur)) continue;
    ancestors.add(cur);
    for (const parent of depsByStep.get(cur) ?? []) {
      stack.push(parent);
    }
  }
  return ancestors;
}

/**
 * Parse and validate `team-patch.v1` (`<= 32,768` bytes, `diagnosis <= 4,096` bytes),
 * enforcing role references, strict acyclic DAG steps, and strict-ancestor handoff/rework edges.
 */
export function parseTeamPatchV1(
  input: unknown,
  options: ParseTeamPatchOptions = {},
): TeamPatchV1 {
  const maxTeamSize = options.maxTeamSize ?? 4;
  const maxTeamSteps = options.maxTeamSteps ?? 6;
  const scrubber = options.scrubber ?? DEFAULT_SECRET_SCRUBBER;

  if (!Number.isSafeInteger(maxTeamSize) || maxTeamSize < 1 || maxTeamSize > 4) {
    schemaInvalid('maxTeamSize must be within 1..4', '/options/maxTeamSize');
  }
  if (!Number.isSafeInteger(maxTeamSteps) || maxTeamSteps < 1 || maxTeamSteps > 6) {
    schemaInvalid('maxTeamSteps must be within 1..6', '/options/maxTeamSteps');
  }

  const rootVal = parseYamlOrJsonInput(input, TEAM_PATCH_MAX_BYTES, '');
  const root = expectObject(rootVal, TEAM_PATCH_ROOT_KEYS, ['kind', 'schemaVersion', 'diagnosis', 'roles', 'steps'], '');

  if (root['kind'] !== TEAM_PATCH_KIND) {
    schemaInvalid(`expected kind "${TEAM_PATCH_KIND}"`, '/kind');
  }
  if (root['schemaVersion'] !== TEAM_PATCH_SCHEMA_VERSION) {
    schemaInvalid(`expected schemaVersion "${TEAM_PATCH_SCHEMA_VERSION}"`, '/schemaVersion');
  }

  const diagnosis = parseTeamDiagnosisValue(root['diagnosis']!, '/diagnosis');

  const rawRoles = expectArray(root['roles'], 1, maxTeamSize, '/roles');
  const seenRoleIds = new Set<string>();
  const roles: TeamPatchRole[] = [];
  for (let i = 0; i < rawRoles.length; i++) {
    const rPath = `/roles/${i}`;
    const rObj = expectObject(
      rawRoles[i]!,
      TEAM_ROLE_KEYS,
      ['id', 'archetypeRoleId', 'purpose', 'prompt', 'tools'],
      rPath,
    );
    const id = expectIdentifier(rObj['id'], `${rPath}/id`);
    if (seenRoleIds.has(id)) schemaInvalid(`duplicate role id "${id}"`, `${rPath}/id`);
    seenRoleIds.add(id);

    const archetypeRoleId = expectIdentifier(rObj['archetypeRoleId'], `${rPath}/archetypeRoleId`);
    const purpose = expectEnum(rObj['purpose'], ['task', 'review'] as const, `${rPath}/purpose`);
    const prompt = expectString(rObj['prompt'], 1, LIMITS.string, `${rPath}/prompt`);
    if (hasDisallowedInlineControlChar(prompt) || prompt.trim().length === 0) {
      schemaInvalid('role prompt must be non-empty text', `${rPath}/prompt`);
    }

    const rawTools = expectArray(rObj['tools'], 0, LIMITS.tools, `${rPath}/tools`);
    const seenTools = new Set<string>();
    const tools: string[] = [];
    for (let j = 0; j < rawTools.length; j++) {
      const tool = expectString(rawTools[j], 1, LIMITS.toolName, `${rPath}/tools/${j}`);
      if (FORBIDDEN_PROTOTYPE_KEYS.has(tool) || !TOOL_NAME_RE.test(tool)) {
        schemaInvalid(`invalid tool name "${tool}"`, `${rPath}/tools/${j}`);
      }
      if (seenTools.has(tool)) schemaInvalid(`duplicate tool "${tool}"`, `${rPath}/tools/${j}`);
      seenTools.add(tool);
      tools.push(tool);
    }

    const roleRec = createNullRecord<{
      id: string;
      archetypeRoleId: string;
      purpose: 'task' | 'review';
      prompt: string;
      model?: string;
      thinking?: string;
      tools: readonly string[];
      resourceIds?: readonly string[];
      timeoutSeconds?: number;
    }>();
    roleRec.id = id;
    roleRec.archetypeRoleId = archetypeRoleId;
    roleRec.purpose = purpose;
    roleRec.prompt = prompt;
    if (Object.hasOwn(rObj, 'model') && rObj['model'] !== undefined) {
      const model = expectString(rObj['model'], 1, 128, `${rPath}/model`);
      if (!MODEL_LABEL_RE.test(model)) schemaInvalid('invalid model label', `${rPath}/model`);
      roleRec.model = model;
    }
    if (Object.hasOwn(rObj, 'thinking') && rObj['thinking'] !== undefined) {
      const thinking = expectString(rObj['thinking'], 1, 64, `${rPath}/thinking`);
      if (!MODEL_LABEL_RE.test(thinking)) schemaInvalid('invalid thinking level', `${rPath}/thinking`);
      roleRec.thinking = thinking;
    }
    roleRec.tools = tools;
    if (Object.hasOwn(rObj, 'resourceIds') && rObj['resourceIds'] !== undefined) {
      const rawRes = expectArray(rObj['resourceIds'], 0, LIMITS.resources, `${rPath}/resourceIds`);
      const seenRes = new Set<string>();
      const resourceIds: string[] = [];
      for (let j = 0; j < rawRes.length; j++) {
        const resId = expectIdentifier(rawRes[j], `${rPath}/resourceIds/${j}`);
        if (seenRes.has(resId)) schemaInvalid(`duplicate resourceId "${resId}"`, `${rPath}/resourceIds/${j}`);
        seenRes.add(resId);
        resourceIds.push(resId);
      }
      roleRec.resourceIds = resourceIds;
    }
    if (Object.hasOwn(rObj, 'timeoutSeconds') && rObj['timeoutSeconds'] !== undefined) {
      roleRec.timeoutSeconds = expectInteger(rObj['timeoutSeconds'], 1, 86_400, `${rPath}/timeoutSeconds`);
    }
    roles.push(roleRec as TeamPatchRole);
  }

  const rawSteps = expectArray(root['steps'], 1, maxTeamSteps, '/steps');
  const seenStepIds = new Set<string>();
  const steps: TeamPatchStep[] = [];
  for (let i = 0; i < rawSteps.length; i++) {
    const sPath = `/steps/${i}`;
    const sObj = expectObject(rawSteps[i]!, TEAM_STEP_KEYS, ['id', 'roleId', 'dependsOn'], sPath);
    const id = expectIdentifier(sObj['id'], `${sPath}/id`);
    if (seenStepIds.has(id)) schemaInvalid(`duplicate step id "${id}"`, `${sPath}/id`);
    seenStepIds.add(id);

    const roleId = expectIdentifier(sObj['roleId'], `${sPath}/roleId`);
    if (!seenRoleIds.has(roleId)) {
      schemaInvalid(`step "${id}" references unknown roleId "${roleId}"`, `${sPath}/roleId`);
    }

    const rawDeps = expectArray(sObj['dependsOn'], 0, maxTeamSteps, `${sPath}/dependsOn`);
    const seenDeps = new Set<string>();
    const dependsOn: string[] = [];
    for (let j = 0; j < rawDeps.length; j++) {
      const dep = expectIdentifier(rawDeps[j], `${sPath}/dependsOn/${j}`);
      if (dep === id) schemaInvalid(`step "${id}" cannot depend on itself`, `${sPath}/dependsOn/${j}`);
      if (seenDeps.has(dep)) schemaInvalid(`duplicate dependency "${dep}"`, `${sPath}/dependsOn/${j}`);
      seenDeps.add(dep);
      dependsOn.push(dep);
    }

    const stepRec = createNullRecord<{
      id: string;
      roleId: string;
      dependsOn: readonly string[];
      handoffs?: readonly StepHandoffSelector[];
      onRework?: ReworkPolicy;
    }>();
    stepRec.id = id;
    stepRec.roleId = roleId;
    stepRec.dependsOn = dependsOn;

    if (Object.hasOwn(sObj, 'handoffs') && sObj['handoffs'] !== undefined) {
      const rawHandoffs = expectArray(sObj['handoffs'], 1, HANDOFF_LIMITS.maxPerStep, `${sPath}/handoffs`);
      const seenHandoffIds = new Set<string>();
      let aggregateBytes = 0;
      const handoffs: StepHandoffSelector[] = [];
      for (let j = 0; j < rawHandoffs.length; j++) {
        const handoff = parseStepHandoffSelectorValue(rawHandoffs[j]!, `${sPath}/handoffs/${j}`);
        const effectiveId = handoff.id ?? `handoff-${j + 1}`;
        if (seenHandoffIds.has(effectiveId)) {
          schemaInvalid(`duplicate handoff id "${effectiveId}"`, `${sPath}/handoffs/${j}/id`);
        }
        seenHandoffIds.add(effectiveId);
        aggregateBytes += handoff.maxBytes ?? HANDOFF_LIMITS.defaultBytes;
        if (aggregateBytes > HANDOFF_LIMITS.maxAggregateBytes) {
          schemaInvalid('step handoffs exceed aggregate byte limit', `${sPath}/handoffs/${j}`);
        }
        handoffs.push(handoff);
      }
      stepRec.handoffs = handoffs;
    }

    if (Object.hasOwn(sObj, 'onRework') && sObj['onRework'] !== undefined) {
      const rwObj = expectObject(sObj['onRework'], REWORK_POLICY_KEYS, ['rejectTo', 'maxReworks'], `${sPath}/onRework`);
      const rework = createNullRecord<{ rejectTo: string; maxReworks: number }>();
      rework.rejectTo = expectIdentifier(rwObj['rejectTo'], `${sPath}/onRework/rejectTo`);
      rework.maxReworks = expectInteger(rwObj['maxReworks'], 1, LIMITS.maxReworks, `${sPath}/onRework/maxReworks`);
      stepRec.onRework = rework;
    }
    steps.push(stepRec as TeamPatchStep);
  }

  // Verify dependsOn references and strict DAG acyclicity via Kahn topological sort
  const inDegree = new Map<string, number>();
  const childrenByStep = new Map<string, string[]>();
  const depsByStep = new Map<string, readonly string[]>();
  for (const step of steps) {
    inDegree.set(step.id, step.dependsOn.length);
    childrenByStep.set(step.id, []);
    depsByStep.set(step.id, step.dependsOn);
  }
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    for (let j = 0; j < step.dependsOn.length; j++) {
      const dep = step.dependsOn[j]!;
      if (!seenStepIds.has(dep)) {
        schemaInvalid(`step "${step.id}" depends on unknown step "${dep}"`, `/steps/${i}/dependsOn/${j}`);
      }
      childrenByStep.get(dep)!.push(step.id);
    }
  }

  const ready: string[] = [];
  for (const [stepId, deg] of inDegree) {
    if (deg === 0) ready.push(stepId);
  }
  let visitedCount = 0;
  while (ready.length > 0) {
    const current = ready.shift()!;
    visitedCount++;
    for (const child of childrenByStep.get(current) ?? []) {
      const nextDeg = (inDegree.get(child) ?? 0) - 1;
      inDegree.set(child, nextDeg);
      if (nextDeg === 0) ready.push(child);
    }
  }
  if (visitedCount !== steps.length) {
    schemaInvalid('team-patch.v1 steps[] contains a dependency cycle', '/steps');
  }

  // Verify handoffs and onRework reference strict DAG ancestors
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (step.handoffs === undefined && step.onRework === undefined) continue;
    const ancestors = collectStrictAncestors(step.id, depsByStep);
    if (step.onRework !== undefined) {
      if (!seenStepIds.has(step.onRework.rejectTo) || !ancestors.has(step.onRework.rejectTo)) {
        schemaInvalid('onRework.rejectTo must reference a strict ancestor step', `/steps/${i}/onRework/rejectTo`);
      }
    }
    if (step.handoffs !== undefined) {
      for (let j = 0; j < step.handoffs.length; j++) {
        const fromStep = step.handoffs[j]!.fromStep;
        if (!seenStepIds.has(fromStep) || !ancestors.has(fromStep)) {
          schemaInvalid('handoff.fromStep must reference a strict ancestor step', `/steps/${i}/handoffs/${j}/fromStep`);
        }
      }
    }
  }

  const patch = createNullRecord<{
    kind: typeof TEAM_PATCH_KIND;
    schemaVersion: typeof TEAM_PATCH_SCHEMA_VERSION;
    diagnosis: TeamPatchDiagnosis;
    roles: readonly TeamPatchRole[];
    steps: readonly TeamPatchStep[];
  }>();
  patch.kind = TEAM_PATCH_KIND;
  patch.schemaVersion = TEAM_PATCH_SCHEMA_VERSION;
  patch.diagnosis = diagnosis;
  patch.roles = roles;
  patch.steps = steps;

  const serialized = canonicalizeJson(patch);
  if (Buffer.byteLength(serialized, 'utf8') > TEAM_PATCH_MAX_BYTES) {
    schemaInvalid(`team-patch.v1 exceeds ${TEAM_PATCH_MAX_BYTES} bytes`, '/');
  }
  assertCleanSecrets(serialized, scrubber, '/');
  return patch as TeamPatchV1;
}

// ---------------------------------------------------------------------------
// DispatchManifestV1 (`dispatch-manifest.json`) parser
// ---------------------------------------------------------------------------

export interface ParseDispatchManifestOptions {
  readonly scrubber?: SecretScrubber;
}

const DISPATCH_ROOT_KEYS = new Set(['version', 'fallback', 'rules']);
const DISPATCH_RULE_KEYS = new Set([
  'bucketId',
  'dimensionBounds',
  'dtypes',
  'alignmentBytes',
  'blobDigest',
  'blobPath',
  'entrypoint',
]);
const DIMENSION_RANGE_KEYS = new Set(['min', 'max']);

/** Parse and validate `dispatch-manifest.json` (`1..64` rules, mandatory `fallback: 'baseline'`). */
export function parseDispatchManifestV1(
  input: unknown,
  options: ParseDispatchManifestOptions = {},
): DispatchManifestV1 {
  const scrubber = options.scrubber ?? DEFAULT_SECRET_SCRUBBER;
  const rootVal = typeof input === 'string'
    ? parseNullProtoJson(input, DISPATCH_MANIFEST_MAX_BYTES, '')
    : input instanceof Uint8Array
      ? parseNullProtoJson(decodeUtf8Strict(input, ''), DISPATCH_MANIFEST_MAX_BYTES, '')
      : sanitizeUntrustedValue(input, { maxBytes: DISPATCH_MANIFEST_MAX_BYTES, path: '' });

  const root = expectObject(rootVal, DISPATCH_ROOT_KEYS, ['version', 'fallback', 'rules'], '');
  if (root['version'] !== 1) {
    schemaInvalid('dispatch manifest version must be 1', '/version');
  }
  if (root['fallback'] !== 'baseline') {
    schemaInvalid('dispatch manifest fallback must be "baseline"', '/fallback');
  }

  const rawRules = expectArray(root['rules'], 1, DISPATCH_MANIFEST_MAX_RULES, '/rules');
  const rules: DispatchRuleV1[] = [];
  for (let i = 0; i < rawRules.length; i++) {
    const rPath = `/rules/${i}`;
    const rObj = expectObject(rawRules[i]!, DISPATCH_RULE_KEYS, ['bucketId', 'blobDigest', 'entrypoint'], rPath);
    const bucketId = expectBucketId(rObj['bucketId'], `${rPath}/bucketId`);
    const blobDigest = expectDigest(rObj['blobDigest'], `${rPath}/blobDigest`);
    const entrypoint = expectString(rObj['entrypoint'], 1, 256, `${rPath}/entrypoint`);
    if (!ENTRYPOINT_SYMBOL_RE.test(entrypoint)) {
      schemaInvalid(`invalid entrypoint symbol "${entrypoint}"`, `${rPath}/entrypoint`);
    }

    const ruleRec = createNullRecord<{
      bucketId: string;
      dimensionBounds?: Readonly<Record<string, DispatchDimensionRange>>;
      dtypes?: readonly string[];
      alignmentBytes?: number;
      blobDigest: Digest;
      blobPath?: string;
      entrypoint: string;
    }>();
    ruleRec.bucketId = bucketId;

    if (Object.hasOwn(rObj, 'dimensionBounds') && rObj['dimensionBounds'] !== undefined) {
      const dimVal = rObj['dimensionBounds'];
      if (dimVal === null || typeof dimVal !== 'object' || Array.isArray(dimVal)) {
        schemaInvalid('dimensionBounds must be an object', `${rPath}/dimensionBounds`);
      }
      const dimObj = dimVal as Record<string, NullProtoJson>;
      const dimKeys = Object.keys(dimObj).sort();
      if (dimKeys.length > LIMITS.bucketDimensionEntries) {
        schemaInvalid('dimensionBounds exceeds maximum dimension keys', `${rPath}/dimensionBounds`);
      }
      const boundsMap = createNullRecord<Record<string, DispatchDimensionRange>>();
      for (const dimKey of dimKeys) {
        if (!Object.hasOwn(dimObj, dimKey)) continue;
        expectMetricKey(dimKey, `${rPath}/dimensionBounds/${dimKey}`);
        const rangeObj = expectObject(dimObj[dimKey]!, DIMENSION_RANGE_KEYS, [], `${rPath}/dimensionBounds/${dimKey}`);
        const hasMin = Object.hasOwn(rangeObj, 'min') && rangeObj['min'] !== undefined;
        const hasMax = Object.hasOwn(rangeObj, 'max') && rangeObj['max'] !== undefined;
        if (!hasMin && !hasMax) {
          schemaInvalid('dimension range must specify min and/or max', `${rPath}/dimensionBounds/${dimKey}`);
        }
        const rangeRec = createNullRecord<{ min?: number; max?: number }>();
        if (hasMin) {
          rangeRec.min = expectFiniteNumber(rangeObj['min'], {}, `${rPath}/dimensionBounds/${dimKey}/min`);
        }
        if (hasMax) {
          rangeRec.max = expectFiniteNumber(rangeObj['max'], {}, `${rPath}/dimensionBounds/${dimKey}/max`);
        }
        if (rangeRec.min !== undefined && rangeRec.max !== undefined && rangeRec.min > rangeRec.max) {
          schemaInvalid('dimension range min cannot exceed max', `${rPath}/dimensionBounds/${dimKey}`);
        }
        boundsMap[dimKey] = rangeRec;
      }
      ruleRec.dimensionBounds = boundsMap;
    }

    if (Object.hasOwn(rObj, 'dtypes') && rObj['dtypes'] !== undefined) {
      const rawDtypes = expectArray(rObj['dtypes'], 1, 16, `${rPath}/dtypes`);
      const seenDtypes = new Set<string>();
      const dtypes: string[] = [];
      for (let j = 0; j < rawDtypes.length; j++) {
        const dt = expectString(rawDtypes[j], 1, 32, `${rPath}/dtypes/${j}`);
        if (!DTYPE_TOKEN_RE.test(dt)) schemaInvalid(`invalid dtype "${dt}"`, `${rPath}/dtypes/${j}`);
        if (seenDtypes.has(dt)) schemaInvalid(`duplicate dtype "${dt}"`, `${rPath}/dtypes/${j}`);
        seenDtypes.add(dt);
        dtypes.push(dt);
      }
      ruleRec.dtypes = dtypes;
    }

    if (Object.hasOwn(rObj, 'alignmentBytes') && rObj['alignmentBytes'] !== undefined) {
      ruleRec.alignmentBytes = expectInteger(rObj['alignmentBytes'], 1, 4_096, `${rPath}/alignmentBytes`);
    }

    ruleRec.blobDigest = blobDigest;
    if (Object.hasOwn(rObj, 'blobPath') && rObj['blobPath'] !== undefined) {
      const blobPath = expectString(rObj['blobPath'], 1, 128, `${rPath}/blobPath`);
      const expectedPath = `blobs/sha256/${blobDigest.hex}`;
      if (blobPath !== expectedPath) {
        schemaInvalid(`blobPath must equal "${expectedPath}"`, `${rPath}/blobPath`);
      }
      ruleRec.blobPath = blobPath;
    }
    ruleRec.entrypoint = entrypoint;
    rules.push(ruleRec as DispatchRuleV1);
  }

  const manifest = createNullRecord<{
    version: 1;
    fallback: 'baseline';
    rules: readonly DispatchRuleV1[];
  }>();
  manifest.version = 1;
  manifest.fallback = 'baseline';
  manifest.rules = rules;

  assertCleanSecrets(canonicalizeJson(manifest), scrubber, '/');
  return manifest as DispatchManifestV1;
}

// ---------------------------------------------------------------------------
// Strict SQLite JSON column validators into null-prototype records
// ---------------------------------------------------------------------------

export function parseMetricsRecordJson(rawJson: string | Readonly<Record<string, number>>, path = '/metrics'): Readonly<Record<string, number>> {
  const val = typeof rawJson === 'string'
    ? parseNullProtoJson(rawJson, 16_384, path)
    : sanitizeUntrustedValue(rawJson, { maxBytes: 16_384, path });
  if (val === null || typeof val !== 'object' || Array.isArray(val)) {
    schemaInvalid('metrics must be an object', path);
  }
  const rec = val as Record<string, NullProtoJson>;
  const keys = Object.keys(rec).sort();
  if (keys.length > LIMITS.metricEntries) {
    schemaInvalid('metrics exceeds maximum entry count', path);
  }
  const out = createNullRecord<Record<string, number>>();
  for (const key of keys) {
    if (!Object.hasOwn(rec, key)) continue;
    expectMetricKey(key, `${path}/${key}`);
    out[key] = expectFiniteNumber(rec[key], {}, `${path}/${key}`);
  }
  return out;
}

const ARTIFACT_REF_KEYS = new Set(['name', 'digest', 'byteLength', 'uri', 'mediaType']);

export function parseArtifactRefsJson(rawJson: string | readonly ArtifactRef[], path = '/outputArtifacts'): readonly ArtifactRef[] {
  const val = typeof rawJson === 'string'
    ? parseNullProtoJson(rawJson, 65_536, path)
    : sanitizeUntrustedValue(rawJson, { maxBytes: 65_536, path });
  const arr = expectArray(val, 0, LIMITS.manifest, path);
  const out: ArtifactRef[] = [];
  for (let i = 0; i < arr.length; i++) {
    const aPath = `${path}/${i}`;
    const obj = expectObject(arr[i]!, ARTIFACT_REF_KEYS, ['name', 'digest', 'byteLength'], aPath);
    const rawName = expectString(obj['name'], 1, LIMITS.path, `${aPath}/name`);
    const vPath = validateRelativePath(rawName);
    if (!vPath.ok) schemaInvalid('invalid artifact relative path', `${aPath}/name`);
    const digest = expectDigest(obj['digest'], `${aPath}/digest`);
    const byteLength = expectInteger(obj['byteLength'], 0, Number.MAX_SAFE_INTEGER, `${aPath}/byteLength`);
    const ref = createNullRecord<{
      name: string;
      digest: Digest;
      byteLength: number;
      uri?: string | null;
      mediaType?: string | null;
    }>();
    ref.name = vPath.value;
    ref.digest = digest;
    ref.byteLength = byteLength;
    if (Object.hasOwn(obj, 'uri')) {
      ref.uri = obj['uri'] === null ? null : expectString(obj['uri'], 1, LIMITS.artifactUri, `${aPath}/uri`);
    }
    if (Object.hasOwn(obj, 'mediaType')) {
      ref.mediaType = obj['mediaType'] === null ? null : expectString(obj['mediaType'], 1, LIMITS.mediaType, `${aPath}/mediaType`);
    }
    out.push(ref as ArtifactRef);
  }
  return out;
}

export function parseBucketMetricsJson(
  rawJson: string | readonly BucketMetricEntry[],
  scrubber: SecretScrubber = DEFAULT_SECRET_SCRUBBER,
): readonly BucketMetricEntry[] {
  const val = typeof rawJson === 'string'
    ? parseNullProtoJson(rawJson, 49_152, '/bucketMetrics')
    : sanitizeUntrustedValue(rawJson, { maxBytes: 49_152, path: '/bucketMetrics' });
  const res = validateBucketMetrics(val, scrubber);
  if (!res.ok) {
    schemaInvalid(`invalid bucketMetrics (${res.errors[0]?.code ?? 'INVALID'})`, res.errors[0]?.path ?? '/bucketMetrics');
  }
  return res.value;
}

export function parseHardwareDiagnosticsJson(
  rawJson: string | HardwareDiagnostics,
  scrubber: SecretScrubber = DEFAULT_SECRET_SCRUBBER,
): HardwareDiagnostics {
  const val = typeof rawJson === 'string'
    ? parseNullProtoJson(rawJson, 16_384, '/hardwareDiagnostics')
    : sanitizeUntrustedValue(rawJson, { maxBytes: 16_384, path: '/hardwareDiagnostics' });
  const res = validateHardwareDiagnostics(val, scrubber);
  if (!res.ok) {
    schemaInvalid(`invalid hardwareDiagnostics (${res.errors[0]?.code ?? 'INVALID'})`, res.errors[0]?.path ?? '/hardwareDiagnostics');
  }
  return res.value;
}

const HARDWARE_PROVENANCE_KEYS = new Set([
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

export function parseHardwareProvenanceJson(rawJson: string | HardwareProvenance, path = '/hardwareProvenance'): HardwareProvenance {
  const val = typeof rawJson === 'string'
    ? parseNullProtoJson(rawJson, 16_384, path)
    : sanitizeUntrustedValue(rawJson, { maxBytes: 16_384, path });
  const obj = expectObject(
    val,
    HARDWARE_PROVENANCE_KEYS,
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
    path,
  );
  const prov = createNullRecord<{
    targetCellId: string;
    probeKind: 'physical' | 'synthetic_fixture';
    vendor: string;
    deviceModel: string;
    accelerator: string;
    isolationMode: 'whole_device' | 'sliced';
    deviceCount: number;
    driverVersion: string;
    runtimeVersion: string;
    topology?: string;
    workloadDigest: Digest;
    clockLockMode: 'locked' | 'unlocked' | 'unknown';
  }>();
  prov.targetCellId = expectIdentifier(obj['targetCellId'], `${path}/targetCellId`);
  prov.probeKind = expectEnum(obj['probeKind'], ['physical', 'synthetic_fixture'] as const, `${path}/probeKind`);
  prov.vendor = expectString(obj['vendor'], 1, 128, `${path}/vendor`);
  prov.deviceModel = expectString(obj['deviceModel'], 1, 128, `${path}/deviceModel`);
  prov.accelerator = expectString(obj['accelerator'], 1, 64, `${path}/accelerator`);
  prov.isolationMode = expectEnum(obj['isolationMode'], ['whole_device', 'sliced'] as const, `${path}/isolationMode`);
  prov.deviceCount = expectInteger(obj['deviceCount'], 1, 64, `${path}/deviceCount`);
  prov.driverVersion = expectString(obj['driverVersion'], 1, 128, `${path}/driverVersion`);
  prov.runtimeVersion = expectString(obj['runtimeVersion'], 1, 128, `${path}/runtimeVersion`);
  if (Object.hasOwn(obj, 'topology') && obj['topology'] !== undefined) {
    prov.topology = expectString(obj['topology'], 1, 128, `${path}/topology`);
  }
  prov.workloadDigest = expectDigest(obj['workloadDigest'], `${path}/workloadDigest`);
  prov.clockLockMode = expectEnum(obj['clockLockMode'], ['locked', 'unlocked', 'unknown'] as const, `${path}/clockLockMode`);
  return prov as HardwareProvenance;
}

const FINDING_KEYS = new Set(['title', 'severity', 'path', 'line', 'evidence']);

export function parseStructuredFindingsJson(
  rawJson: string | readonly StructuredFinding[],
  path = '/findings',
): readonly StructuredFinding[] {
  const val = typeof rawJson === 'string'
    ? parseNullProtoJson(rawJson, 65_536, path)
    : sanitizeUntrustedValue(rawJson, { maxBytes: 65_536, path });
  const arr = expectArray(val, 0, LIMITS.findings, path);
  const out: StructuredFinding[] = [];
  for (let i = 0; i < arr.length; i++) {
    const fPath = `${path}/${i}`;
    const obj = expectObject(arr[i]!, FINDING_KEYS, ['title', 'severity', 'evidence'], fPath);
    const f = createNullRecord<{
      title: string;
      severity: FindingSeverity;
      path?: string | null;
      line?: number | null;
      evidence: string;
    }>();
    f.title = expectString(obj['title'], 1, LIMITS.findingTitle, `${fPath}/title`);
    f.severity = expectEnum(obj['severity'], ['critical', 'high', 'medium', 'low'] as const, `${fPath}/severity`);
    if (Object.hasOwn(obj, 'path')) {
      if (obj['path'] === null) {
        f.path = null;
      } else {
        const rel = expectString(obj['path'], 1, LIMITS.path, `${fPath}/path`);
        const vRes = validateRelativePath(rel);
        if (!vRes.ok) schemaInvalid('invalid finding path', `${fPath}/path`);
        f.path = vRes.value;
      }
    }
    if (Object.hasOwn(obj, 'line')) {
      f.line = obj['line'] === null ? null : expectInteger(obj['line'], 1, Number.MAX_SAFE_INTEGER, `${fPath}/line`);
    }
    f.evidence = expectString(obj['evidence'], 1, LIMITS.findingEvidence, `${fPath}/evidence`);
    out.push(f as StructuredFinding);
  }
  return out;
}
