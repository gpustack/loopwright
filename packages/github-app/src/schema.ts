import { CST, isAlias, isMap, isScalar, isSeq, Lexer, parseDocument } from 'yaml';
import { STANDARD_PI_PROVIDER_ENV } from '@loopwright/agent-pi/catalog';
import {
  GitHubAppError, DEFAULT_COMMENT_PREFIXES, LOCAL_COMMAND_GATE_ENDPOINT_ID, PROTECTED_AUTOMATION_PATHS, TASKPACK_COMMENT_COMMANDS,
  TASKPACK_MANIFEST_API_VERSION, TASKPACK_MANIFEST_BYTES, TASKPACK_OUTPUT_FORMATS,
  type SandboxBackendId, type SandboxCapability, type SandboxNetworkMode,
  type TaskpackCheckDeclaration, type TaskpackCommentCommand, type TaskpackDecisionDisclosurePolicy, type TaskpackDecisionProviderKind,
  type TaskpackDecisionsDeclaration, type TaskpackHttpMcpServerDeclaration, type TaskpackLimitsDeclaration, type TaskpackManifest,
  type TaskpackMcpDeclaration, type TaskpackMcpServerDeclaration, type TaskpackModelDeclaration,
  type TaskpackOutputDeclaration, type TaskpackOutputFormat, type TaskpackSandboxDeclaration,
  type TaskpackStdioMcpServerDeclaration, type TaskpackUpstreamDescriptor,
} from './types.js';
import { validateTaskpackModelsDeclaration } from './models-config.js';

export const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const TARGET_BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const COMMENT_PREFIX_PATTERN = /^\/[A-Za-z0-9_-]{0,31}$/;
const FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const RESERVED_DEVICE_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const COMMAND_ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const MCP_SERVER_ID_PATTERN = /^[a-z][a-z0-9_]*(?:-[a-z0-9_]+)*$/;
const HTTP_HEADER_NAME_PATTERN = /^[A-Za-z0-9-]+$/;
const RESERVED_COMMAND_ENV_NAMES = new Set([
  'GH_TOKEN', 'GITHUB_TOKEN', 'BASH_ENV', 'ENV', 'NODE_OPTIONS',
  'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LLM_TOKEN',
  ...Object.values(STANDARD_PI_PROVIDER_ENV),
]);
const RESERVED_COMMAND_ENV_PREFIXES = [
  'LOOPWRIGHT_', 'INPUT_', 'GITHUB_APP_', 'ACTIONS_', 'RUNNER_', 'LD_', 'DYLD_', 'GIT_',
] as const;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// Twin yaml@2.9.0 AST traversal caps shared with packages/decisions/src/schema.ts (4096 nodes, depth 16, 512 collection items, 8192 string chars).
const MAX_NODES = 4096;
const MAX_DEPTH = 16;
const MAX_COLLECTION = 512;
const MAX_STRING = 8192;
const DEFAULT_DECISION_MIN_CONFIDENCE = 0.8;
const DEFAULT_DECISION_CONFIRM_THRESHOLD = 0.6;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type { Json };

function manifestInvalid(message: string, path: string): never {
  throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', message, path);
}

function decodeText(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', 'manifest bytes are not valid UTF-8', '/'); }
}

// ---------------------------------------------------------------------------
// Strict bounded JSON scanner (duplicate member names can never survive)
// ---------------------------------------------------------------------------

function parseJsonSubset(source: string): Json {
  let offset = 0, nodes = 0;
  const charAt = (index: number): string => source.charAt(index);
  const string = (): string => {
    const start = offset++;
    let closed = false;
    while (offset < source.length) {
      const char = charAt(offset++);
      if (char === '"') { closed = true; break; }
      if (char === '\\') offset++;
    }
    if (!closed) manifestInvalid('unterminated JSON string', '/');
    let value: unknown;
    try { value = JSON.parse(source.slice(start, offset)); } catch { manifestInvalid('invalid JSON string escape', '/'); }
    if (typeof value !== 'string' || value.length > MAX_STRING) manifestInvalid('JSON string out of bounds', '/');
    return value;
  };
  const value = (depth: number, path: string): Json => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) manifestInvalid('JSON document exceeds node or depth limits', path);
    skipSpace();
    const char = charAt(offset);
    if (char === '{') {
      offset++;
      const output: Record<string, Json> = {}, keys = new Set<string>();
      skipSpace();
      if (charAt(offset) === '}') { offset++; return output; }
      while (true) {
        skipSpace();
        if (charAt(offset) !== '"') manifestInvalid('JSON object keys must be strings', path);
        const key = string();
        if (keys.has(key)) manifestInvalid(`duplicate JSON member "${key}"`, `${path}/${key}`);
        if (FORBIDDEN_KEYS.has(key)) manifestInvalid(`forbidden JSON member "${key}"`, path);
        keys.add(key);
        skipSpace();
        if (charAt(offset++) !== ':') manifestInvalid('expected ":" after JSON member name', path);
        output[key] = value(depth + 1, `${path}/${key}`);
        skipSpace();
        const delimiter = charAt(offset++);
        if (delimiter === '}') return output;
        if (delimiter !== ',') manifestInvalid('expected "," or "}" in JSON object', path);
      }
    }
    if (char === '[') {
      offset++;
      const items: Json[] = [];
      skipSpace();
      if (charAt(offset) === ']') { offset++; return items; }
      while (true) {
        if (items.length >= MAX_COLLECTION) manifestInvalid('JSON array exceeds collection limits', path);
        items.push(value(depth + 1, `${path}/${items.length}`));
        skipSpace();
        const delimiter = charAt(offset++);
        if (delimiter === ']') return items;
        if (delimiter !== ',') manifestInvalid('expected "," or "]" in JSON array', path);
      }
    }
    if (char === '"') return string();
    const literal = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(offset));
    if (literal === null) manifestInvalid('invalid JSON value', path);
    offset += literal[0].length;
    if (literal[0] === 'true') return true;
    if (literal[0] === 'false') return false;
    if (literal[0] === 'null') return null;
    const number = Number(literal[0]);
    if (!Number.isFinite(number) || Object.is(number, -0)) manifestInvalid('JSON number out of bounds', path);
    return number;
  };
  const skipSpace = () => { while (offset < source.length && /[\x20\t\r\n]/.test(charAt(offset))) offset++; };
  const parsed = value(1, '/');
  skipSpace();
  if (offset !== source.length) manifestInvalid('trailing content after JSON document', '/');
  return parsed;
}

// ---------------------------------------------------------------------------
// Strict YAML 1.2 core-schema parser via `yaml` (rejecting anchors/aliases/merge/duplicate keys)
// ---------------------------------------------------------------------------

function parseYamlDocument(source: string): Json {
  let flow = 0, tokens = 0, scalar = false, inlineSequence = 0;
  for (const token of new Lexer().lex(source)) {
    if (scalar) { scalar = false; continue; }
    const kind = CST.tokenType(token);
    if (kind === 'scalar') scalar = true;
    if (kind === 'newline') inlineSequence = 0;
    if (kind === 'seq-item-ind' && ++inlineSequence > 32) manifestInvalid('YAML inline sequence exceeds depth limits', '/');
    if (kind === 'flow-map-start' || kind === 'flow-seq-start') { if (++flow > 32) manifestInvalid('YAML flow collection exceeds depth limits', '/'); }
    if (kind === 'flow-map-end' || kind === 'flow-seq-end') flow--;
    if (!['space', 'newline', 'comment'].includes(kind ?? '') && ++tokens > 65536) manifestInvalid('YAML document exceeds token limits', '/');
  }
  const document = parseDocument(source, { version: '1.2', schema: 'core', uniqueKeys: true, merge: false, strict: true, customTags: [] });
  if (document.errors.length > 0) {
    manifestInvalid(document.errors[0]?.message ?? 'invalid YAML syntax', '/');
  }
  let nodes = 0;
  function visit(node: unknown, depth: number, path: string): void {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) manifestInvalid('YAML document exceeds node or depth limits', path);
    if (node === null) return;
    if (
      isAlias(node) || !node || typeof node !== 'object' ||
      ('tag' in node && node.tag !== undefined) ||
      ('anchor' in node && node.anchor !== undefined)
    ) {
      manifestInvalid('YAML aliases, anchors, and tags are unsupported', path);
    }
    if (isMap(node)) {
      if (node.items.length > MAX_COLLECTION) manifestInvalid('YAML mapping exceeds collection limits', path);
      const seen = new Set<string>();
      for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || pair.key.value === '<<' || pair.key.value.length > MAX_STRING) {
          manifestInvalid('YAML mapping key must be a valid string', path);
        }
        const key = pair.key.value;
        if (FORBIDDEN_KEYS.has(key)) manifestInvalid(`forbidden key "${key}"`, path);
        if (seen.has(key)) manifestInvalid(`duplicate key "${key}"`, `${path}/${key}`);
        seen.add(key);
        visit(pair.key, depth + 1, `${path}/${key}`);
        visit(pair.value, depth + 1, `${path}/${key}`);
      }
    } else if (isSeq(node)) {
      if (node.items.length > MAX_COLLECTION) manifestInvalid('YAML sequence exceeds collection limits', path);
      for (const [idx, child] of node.items.entries()) visit(child, depth + 1, `${path}/${idx}`);
    } else {
      if (!isScalar(node) || (node.value !== null && !['string', 'boolean', 'number'].includes(typeof node.value))) {
        manifestInvalid('unsupported YAML scalar value', path);
      }
      if (typeof node.value === 'string' && node.value.length > MAX_STRING) {
        manifestInvalid('YAML string exceeds length limits', path);
      }
      if (typeof node.value === 'number' && (!Number.isFinite(node.value) || Object.is(node.value, -0))) {
        manifestInvalid('YAML number out of bounds', path);
      }
    }
  }
  visit(document.contents, 1, '/');
  return document.toJS({ maxAliasCount: 0 }) as Json;
}

/** Parse manifest bytes in the named format; oversized or non-UTF-8 input is refused before parsing. */
export function parseTaskpackDocument(bytes: Uint8Array, format: 'json' | 'yaml'): Json {
  if (bytes.byteLength > TASKPACK_MANIFEST_BYTES) {
    throw new GitHubAppError('TASKPACK_MANIFEST_INVALID', `manifest exceeds ${TASKPACK_MANIFEST_BYTES} bytes`, '/');
  }
  const source = decodeText(bytes);
  // Any ${...} interpolation expression in an untrusted repository manifest is rejected outright.
  if (source.includes('${')) {
    throw new GitHubAppError('TASKPACK_UNTRUSTED_INTERPOLATION', 'manifest contains a ${...} interpolation expression', '/');
  }
  return format === 'json' ? parseJsonSubset(source) : parseYamlDocument(source);
}

// ---------------------------------------------------------------------------
// Path guards and scope helpers
// ---------------------------------------------------------------------------

/** Validate a manifest-declared relative path: strict `@loopwright/core` segment grammar, no traversal, no absolutes. */
export function normalizeRelativePath(input: unknown, path: string): string {
  // Cap at 1021 characters so appending `/**` during scope compilation never exceeds LIMITS.path (1024).
  if (typeof input !== 'string' || input.length === 0 || input.length > 1021) {
    manifestInvalid('path must be a non-empty string of at most 1021 characters', path);
  }
  if (input.includes('\0') || input.includes('\\') || input.includes(':')) manifestInvalid('path contains forbidden characters', path);
  if (input.startsWith('/')) manifestInvalid('path must be relative', path);
  const segments = input.split('/');
  if (segments.length > 64) manifestInvalid('path exceeds 64 segments', path);
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..' || segment.endsWith('.')) {
      manifestInvalid(`path segment "${segment}" is not allowed`, path);
    }
    if (!PATH_SEGMENT_PATTERN.test(segment)) {
      manifestInvalid(`path segment "${segment}" contains invalid characters`, path);
    }
    if (RESERVED_DEVICE_NAME_PATTERN.test(segment)) {
      manifestInvalid(`path segment "${segment}" is a reserved device name`, path);
    }
  }
  return input;
}

/** True when `candidate` equals `root` or lives underneath it. */
export function pathCoveredBy(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith('/') ? root : `${root}/`);
}

export interface EffectiveProtectedPathsOptions {
  readonly controlRoot?: string | undefined;
  readonly manifestPath?: string | undefined;
  readonly instructions?: readonly string[] | undefined;
  readonly commandScripts?: readonly string[] | undefined;
}

/** The manifest-protected set merged with built-in automation paths and the active control root. */
export function effectiveProtectedPaths(
  manifestProtected: readonly string[],
  options: EffectiveProtectedPathsOptions = {},
): readonly string[] {
  const controlRoot = options.controlRoot ?? '.loopwright';
  const items: string[] = [
    ...PROTECTED_AUTOMATION_PATHS,
    controlRoot,
    `${controlRoot}/policies`,
    `${controlRoot}/checks`,
    `${controlRoot}/memory`,
    `${controlRoot}/taskpack.yaml`,
    `${controlRoot}/taskpack.yml`,
    `${controlRoot}/taskpack.json`,
  ];
  if (options.manifestPath !== undefined) items.push(options.manifestPath);
  if (options.instructions !== undefined) items.push(...options.instructions);
  if (options.commandScripts !== undefined) items.push(...options.commandScripts);
  items.push(...manifestProtected);
  return Object.freeze([...new Set(items)]);
}

// ---------------------------------------------------------------------------
// TaskpackManifest validator
// ---------------------------------------------------------------------------

function requireObject(value: unknown, path: string, fields: readonly string[]): Record<string, Json> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) manifestInvalid('expected an object', path);
  const record = value as Record<string, Json>;
  for (const key of Object.keys(record)) {
    if (!fields.includes(key)) manifestInvalid(`unknown field "${key}"`, path);
  }
  return record;
}

function requireString(value: unknown, path: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    manifestInvalid(`expected a string of ${min}..${max} characters`, path);
  }
  if (/[\0\r\n]/.test(value)) manifestInvalid('string contains forbidden control characters', path);
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') manifestInvalid('expected a boolean', path);
  return value;
}

function requireIdentifier(value: unknown, path: string): string {
  const text = requireString(value, path, 1, 64);
  if (!IDENTIFIER_PATTERN.test(text)) manifestInvalid('expected a lowercase identifier', path);
  return text;
}

function requireStringList(value: unknown, path: string, min: number, max: number): readonly string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    manifestInvalid(`expected an array of ${min}..${max} items`, path);
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    const text = requireString(item, `${path}/${index}`, 1, MAX_STRING);
    if (seen.has(text)) manifestInvalid('duplicate list entry', path);
    seen.add(text);
    return text;
  });
}

function requireParameters(value: unknown, path: string): Readonly<Record<string, string | number | boolean | null>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) manifestInvalid('expected an object of scalar parameters', path);
  const record = value as Record<string, Json>;
  const output: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(record)) {
    if (FORBIDDEN_KEYS.has(key)) manifestInvalid(`forbidden parameter key "${key}"`, path);
    if (item !== null && typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
      manifestInvalid('parameter values must be scalars', path);
    }
    if (typeof item === 'string' && item.length > 1024) manifestInvalid('parameter string exceeds 1024 characters', path);
    output[key] = item as string | number | boolean | null;
  }
  return Object.freeze(output);
}

function pathInsideWritable(candidate: string, writable: readonly string[], protectedPaths: readonly string[], path: string): void {
  if (writable.length > 0 && !writable.some(root => pathCoveredBy(candidate, root))) {
    throw new GitHubAppError('TASKPACK_SCOPE_VIOLATION', `path "${candidate}" is not inside spec.scope.writable`, path);
  }
  const overlap = protectedPaths.find(protectedPath => pathCoveredBy(candidate, protectedPath) || pathCoveredBy(protectedPath, candidate));
  if (overlap !== undefined) {
    throw new GitHubAppError('TASKPACK_SCOPE_VIOLATION', `path "${candidate}" overlaps protected path "${overlap}"`, path);
  }
}

function isReservedCommandEnvName(name: string): boolean {
  if (RESERVED_COMMAND_ENV_NAMES.has(name)) return true;
  return RESERVED_COMMAND_ENV_PREFIXES.some(prefix => name.startsWith(prefix));
}

function requireSafeIntInRange(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value < min || value > max) {
    manifestInvalid(`expected an integer in ${min}..${max}`, path);
  }
  return value;
}

export function validateTaskpackLimitsDeclaration(value: unknown, path: string): TaskpackLimitsDeclaration {
  const raw = requireObject(value, path, [
    'wallTimeSeconds', 'wallTimeMs', 'totalTokens', 'contextWindow', 'maxOutputTokens', 'perCallOutputTokens',
    'maxModelCalls', 'maxAttempts', 'maxFormatRepairs', 'maxImplementationRepairs', 'maxTransportRetries',
    'toolTimeoutSeconds', 'toolWallMs', 'commandTimeoutSeconds', 'responseBytes', 'toolResultBytes',
    'toolArgsBytes', 'promptBytes', 'maxRequestBytes', 'workingWindowBytes', 'fileBytes',
    'sessionBytes', 'candidateEntries',
  ]);
  const out: Record<string, number> = {};
  const setOpt = (key: string, min: number, max: number): void => {
    if (raw[key] !== undefined) {
      out[key] = requireSafeIntInRange(raw[key], `${path}/${key}`, min, max);
    }
  };
  setOpt('wallTimeSeconds', 60, 21_600);
  setOpt('wallTimeMs', 60_000, 21_600_000);
  if (out['wallTimeSeconds'] !== undefined && out['wallTimeMs'] !== undefined && out['wallTimeSeconds'] * 1000 !== out['wallTimeMs']) {
    manifestInvalid('wallTimeSeconds and wallTimeMs conflict', `${path}/wallTimeMs`);
  }
  setOpt('totalTokens', 1_000, 1_000_000_000);
  setOpt('contextWindow', 1_024, 10_000_000);
  setOpt('maxOutputTokens', 256, 262_144);
  setOpt('perCallOutputTokens', 256, 262_144);
  if (out['maxOutputTokens'] !== undefined && out['perCallOutputTokens'] !== undefined && out['maxOutputTokens'] !== out['perCallOutputTokens']) {
    manifestInvalid('maxOutputTokens and perCallOutputTokens conflict', `${path}/perCallOutputTokens`);
  }
  setOpt('maxModelCalls', 1, 1_024);
  setOpt('maxAttempts', 1, 16);
  setOpt('maxFormatRepairs', 0, 1_024);
  setOpt('maxImplementationRepairs', 0, 1_024);
  setOpt('maxTransportRetries', 0, 8);
  setOpt('toolTimeoutSeconds', 1, 1_800);
  setOpt('toolWallMs', 1_000, 1_800_000);
  if (out['toolTimeoutSeconds'] !== undefined && out['toolWallMs'] !== undefined && out['toolTimeoutSeconds'] * 1000 !== out['toolWallMs']) {
    manifestInvalid('toolTimeoutSeconds and toolWallMs conflict', `${path}/toolWallMs`);
  }
  setOpt('commandTimeoutSeconds', 1, 3_600);
  setOpt('responseBytes', 65_536, 67_108_864);
  setOpt('toolResultBytes', 16_384, 4_194_304);
  setOpt('toolArgsBytes', 16_384, 4_194_304);
  setOpt('promptBytes', 4_096, 1_048_576);
  setOpt('maxRequestBytes', 65_536, 16_777_216);
  setOpt('workingWindowBytes', 131_072, 16_777_216);
  setOpt('fileBytes', 65_536, 67_108_864);
  setOpt('sessionBytes', 524_288, 67_108_864);
  setOpt('candidateEntries', 16, 4_096);
  return Object.freeze(out) as TaskpackLimitsDeclaration;
}

export interface ValidateMcpServersOptions {
  readonly allowLoopbackHttp?: boolean | undefined;
}

export function validateMcpServerDeclarations(
  value: unknown,
  path: string,
  options: ValidateMcpServersOptions = {},
): readonly TaskpackMcpServerDeclaration[] {
  if (!Array.isArray(value) || value.length > 16) {
    manifestInvalid('mcp.servers must be an array of 0..16 server declarations', path);
  }
  const seenIds = new Set<string>();
  const servers: TaskpackMcpServerDeclaration[] = [];

  for (const [idx, item] of value.entries()) {
    const serverPath = `${path}/${idx}`;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      manifestInvalid('expected an MCP server declaration object', serverPath);
    }
    const rawAny = item as Record<string, unknown>;
    if (rawAny['oauth'] !== undefined) {
      throw new GitHubAppError('MCP_OAUTH_UNSUPPORTED', 'MCP OAuth authentication is unsupported', `${serverPath}/oauth`);
    }
    if (rawAny['auth'] !== undefined && rawAny['auth'] !== null && typeof rawAny['auth'] === 'object') {
      const authType = (rawAny['auth'] as Record<string, unknown>)['type'];
      if (typeof authType === 'string' && authType.trim().toLowerCase() === 'oauth') {
        throw new GitHubAppError('MCP_OAUTH_UNSUPPORTED', 'MCP OAuth authentication is unsupported', `${serverPath}/auth`);
      }
    }
    const transportRaw = rawAny['transport'];
    if (transportRaw !== 'stdio' && transportRaw !== 'http') {
      manifestInvalid('mcp server transport must be "stdio" or "http"', `${serverPath}/transport`);
    }
    const serverId = requireString(rawAny['id'], `${serverPath}/id`, 1, 24);
    if (!MCP_SERVER_ID_PATTERN.test(serverId) || serverId === 'workspace') {
      manifestInvalid('mcp server id must match ^[a-z][a-z0-9_]*(?:-[a-z0-9_]+)*$ and must not be "workspace"', `${serverPath}/id`);
    }
    if (seenIds.has(serverId)) {
      manifestInvalid(`duplicate mcp server id "${serverId}"`, `${serverPath}/id`);
    }
    seenIds.add(serverId);

    if (transportRaw === 'stdio') {
      const raw = requireObject(item, serverPath, [
        'id', 'transport', 'command', 'args', 'env', 'envFrom', 'timeoutSeconds', 'includeTools', 'readOnly', 'required',
      ]);
      const command = requireString(raw['command'], `${serverPath}/command`, 1, 512);
      const isBareCommand = !command.includes('/') && !command.includes('\\');
      const isAbsoluteCommand = command.startsWith('/') && !command.includes('..') && !command.includes('\\');
      if (!isBareCommand && !isAbsoluteCommand) {
        manifestInvalid('stdio mcp command must be a bare executable name on PATH or an absolute path', `${serverPath}/command`);
      }
      let args: readonly string[] | undefined;
      if (raw['args'] !== undefined) {
        if (!Array.isArray(raw['args']) || raw['args'].length > 64) {
          manifestInvalid('stdio mcp args must be an array of 0..64 strings', `${serverPath}/args`);
        }
        args = Object.freeze(raw['args'].map((arg, aIdx) => requireString(arg, `${serverPath}/args/${aIdx}`, 0, 1024)));
      }
      let env: Readonly<Record<string, string>> | undefined;
      if (raw['env'] !== undefined) {
        if (raw['env'] === null || typeof raw['env'] !== 'object' || Array.isArray(raw['env'])) {
          manifestInvalid('stdio mcp env must be an object of string entries', `${serverPath}/env`);
        }
        const entries = Object.entries(raw['env'] as Record<string, unknown>);
        if (entries.length > 32) manifestInvalid('stdio mcp env exceeds 32 entries', `${serverPath}/env`);
        const envOut: Record<string, string> = {};
        for (const [k, v] of entries) {
          if (FORBIDDEN_KEYS.has(k) || !COMMAND_ENV_NAME_PATTERN.test(k)) {
            manifestInvalid(`invalid env variable name "${k}"`, `${serverPath}/env/${k}`);
          }
          envOut[k] = requireString(v, `${serverPath}/env/${k}`, 0, 2048);
        }
        env = Object.freeze(envOut);
      }
      let envFrom: Readonly<Record<string, string>> | undefined;
      if (raw['envFrom'] !== undefined) {
        if (raw['envFrom'] === null || typeof raw['envFrom'] !== 'object' || Array.isArray(raw['envFrom'])) {
          manifestInvalid('stdio mcp envFrom must be an object mapping target env names to host env names', `${serverPath}/envFrom`);
        }
        const entries = Object.entries(raw['envFrom'] as Record<string, unknown>);
        if (entries.length > 32) manifestInvalid('stdio mcp envFrom exceeds 32 entries', `${serverPath}/envFrom`);
        const envFromOut: Record<string, string> = {};
        for (const [targetName, sourceName] of entries) {
          if (FORBIDDEN_KEYS.has(targetName) || !COMMAND_ENV_NAME_PATTERN.test(targetName)) {
            manifestInvalid(`invalid target env variable name "${targetName}"`, `${serverPath}/envFrom/${targetName}`);
          }
          const src = requireString(sourceName, `${serverPath}/envFrom/${targetName}`, 1, 64);
          if (!COMMAND_ENV_NAME_PATTERN.test(src) && !/^INPUT_[A-Z0-9_-]{1,63}$/.test(src)) {
            manifestInvalid(`invalid source env variable name "${src}"`, `${serverPath}/envFrom/${targetName}`);
          }
          envFromOut[targetName] = src;
        }
        envFrom = Object.freeze(envFromOut);
      }
      const timeoutSeconds = raw['timeoutSeconds'] === undefined ? undefined : requireSafeIntInRange(raw['timeoutSeconds'], `${serverPath}/timeoutSeconds`, 1, 600);
      const includeTools = raw['includeTools'] === undefined ? undefined : requireStringList(raw['includeTools'], `${serverPath}/includeTools`, 1, 64);
      const readOnly = raw['readOnly'] === undefined ? undefined : requireBoolean(raw['readOnly'], `${serverPath}/readOnly`);
      const required = raw['required'] === undefined ? undefined : requireBoolean(raw['required'], `${serverPath}/required`);
      const decl: TaskpackStdioMcpServerDeclaration = Object.freeze({
        id: serverId,
        transport: 'stdio',
        command,
        ...(args === undefined ? {} : { args }),
        ...(env === undefined ? {} : { env }),
        ...(envFrom === undefined ? {} : { envFrom }),
        ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
        ...(includeTools === undefined ? {} : { includeTools }),
        ...(readOnly === undefined ? {} : { readOnly }),
        ...(required === undefined ? {} : { required }),
      });
      servers.push(decl);
    } else {
      const raw = requireObject(item, serverPath, [
        'id', 'transport', 'url', 'headers', 'headersFrom', 'bearerTokenEnv', 'timeoutSeconds', 'includeTools', 'readOnly', 'required',
      ]);
      const urlStr = requireString(raw['url'], `${serverPath}/url`, 1, 2048);
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(urlStr);
      } catch {
        manifestInvalid('http mcp url is not a valid URL', `${serverPath}/url`);
      }
      if (parsedUrl.username !== '' || parsedUrl.password !== '' || parsedUrl.hash !== '') {
        manifestInvalid('http mcp url must not contain credentials or fragments', `${serverPath}/url`);
      }
      const isLoopback = parsedUrl.hostname === '127.0.0.1' || parsedUrl.hostname === '[::1]' || parsedUrl.hostname === 'localhost';
      if (parsedUrl.protocol !== 'https:' && !(options.allowLoopbackHttp === true && parsedUrl.protocol === 'http:' && isLoopback)) {
        manifestInvalid('http mcp url must use https://', `${serverPath}/url`);
      }
      let headers: Readonly<Record<string, string>> | undefined;
      if (raw['headers'] !== undefined) {
        if (raw['headers'] === null || typeof raw['headers'] !== 'object' || Array.isArray(raw['headers'])) {
          manifestInvalid('http mcp headers must be an object of string entries', `${serverPath}/headers`);
        }
        const entries = Object.entries(raw['headers'] as Record<string, unknown>);
        if (entries.length > 32) manifestInvalid('http mcp headers exceeds 32 entries', `${serverPath}/headers`);
        const headersOut: Record<string, string> = {};
        for (const [k, v] of entries) {
          if (FORBIDDEN_KEYS.has(k) || !HTTP_HEADER_NAME_PATTERN.test(k)) {
            manifestInvalid(`invalid header name "${k}"`, `${serverPath}/headers/${k}`);
          }
          if (k.toLowerCase() === 'authorization') {
            manifestInvalid('use bearerTokenEnv or headersFrom instead of literal authorization header', `${serverPath}/headers/${k}`);
          }
          headersOut[k] = requireString(v, `${serverPath}/headers/${k}`, 0, 2048);
        }
        headers = Object.freeze(headersOut);
      }
      let headersFrom: Readonly<Record<string, string>> | undefined;
      if (raw['headersFrom'] !== undefined) {
        if (raw['headersFrom'] === null || typeof raw['headersFrom'] !== 'object' || Array.isArray(raw['headersFrom'])) {
          manifestInvalid('http mcp headersFrom must be an object mapping header names to host env names', `${serverPath}/headersFrom`);
        }
        const entries = Object.entries(raw['headersFrom'] as Record<string, unknown>);
        if (entries.length > 32) manifestInvalid('http mcp headersFrom exceeds 32 entries', `${serverPath}/headersFrom`);
        const headersFromOut: Record<string, string> = {};
        for (const [headerName, sourceName] of entries) {
          if (FORBIDDEN_KEYS.has(headerName) || !HTTP_HEADER_NAME_PATTERN.test(headerName)) {
            manifestInvalid(`invalid header name "${headerName}"`, `${serverPath}/headersFrom/${headerName}`);
          }
          const src = requireString(sourceName, `${serverPath}/headersFrom/${headerName}`, 1, 64);
          if (!COMMAND_ENV_NAME_PATTERN.test(src) && !/^INPUT_[A-Z0-9_-]{1,63}$/.test(src)) {
            manifestInvalid(`invalid source env variable name "${src}"`, `${serverPath}/headersFrom/${headerName}`);
          }
          headersFromOut[headerName] = src;
        }
        headersFrom = Object.freeze(headersFromOut);
      }
      let bearerTokenEnv: string | undefined;
      if (raw['bearerTokenEnv'] !== undefined) {
        const src = requireString(raw['bearerTokenEnv'], `${serverPath}/bearerTokenEnv`, 1, 64);
        if (!COMMAND_ENV_NAME_PATTERN.test(src) && !/^INPUT_[A-Z0-9_-]{1,63}$/.test(src)) {
          manifestInvalid(`invalid bearerTokenEnv "${src}"`, `${serverPath}/bearerTokenEnv`);
        }
        bearerTokenEnv = src;
      }
      const timeoutSeconds = raw['timeoutSeconds'] === undefined ? undefined : requireSafeIntInRange(raw['timeoutSeconds'], `${serverPath}/timeoutSeconds`, 1, 600);
      const includeTools = raw['includeTools'] === undefined ? undefined : requireStringList(raw['includeTools'], `${serverPath}/includeTools`, 1, 64);
      const readOnly = raw['readOnly'] === undefined ? undefined : requireBoolean(raw['readOnly'], `${serverPath}/readOnly`);
      const required = raw['required'] === undefined ? undefined : requireBoolean(raw['required'], `${serverPath}/required`);
      const decl: TaskpackHttpMcpServerDeclaration = Object.freeze({
        id: serverId,
        transport: 'http',
        url: urlStr,
        ...(headers === undefined ? {} : { headers }),
        ...(headersFrom === undefined ? {} : { headersFrom }),
        ...(bearerTokenEnv === undefined ? {} : { bearerTokenEnv }),
        ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
        ...(includeTools === undefined ? {} : { includeTools }),
        ...(readOnly === undefined ? {} : { readOnly }),
        ...(required === undefined ? {} : { required }),
      });
      servers.push(decl);
    }
  }
  return Object.freeze(servers);
}

export function collectMcpReferencedEnvNames(servers: readonly TaskpackMcpServerDeclaration[] | undefined): ReadonlySet<string> {
  const names = new Set<string>();
  if (!servers) return names;
  for (const server of servers) {
    if (server.transport === 'stdio' && server.envFrom !== undefined) {
      for (const src of Object.values(server.envFrom)) names.add(src);
    } else if (server.transport === 'http') {
      if (server.headersFrom !== undefined) {
        for (const src of Object.values(server.headersFrom)) names.add(src);
      }
      if (server.bearerTokenEnv !== undefined) {
        names.add(server.bearerTokenEnv);
      }
    }
  }
  return names;
}

export interface ValidateTaskpackManifestOptions {
  readonly controlRoot?: string | undefined;
  readonly manifestPath?: string | undefined;
}

/**
 * Validate a parsed manifest document against every Feature 1 constraint and return the frozen manifest.
 * Scope violations (writable overlapping the effective protected set, memory directory placement) throw
 * `TASKPACK_SCOPE_VIOLATION`; all other schema violations throw `TASKPACK_MANIFEST_INVALID`.
 */
export function validateTaskpackManifest(value: Json, options: ValidateTaskpackManifestOptions = {}): TaskpackManifest {
  const controlRoot = options.controlRoot !== undefined ? normalizeRelativePath(options.controlRoot, '/') : '.loopwright';
  const manifestPath = options.manifestPath !== undefined ? normalizeRelativePath(options.manifestPath, '/') : undefined;
  const root = requireObject(value, '/', ['apiVersion', 'kind', 'metadata', 'spec']);
  if (root['apiVersion'] !== TASKPACK_MANIFEST_API_VERSION) manifestInvalid('unsupported apiVersion', '/apiVersion');
  if (root['kind'] !== 'Taskpack') manifestInvalid('kind must be Taskpack', '/kind');
  const metadata = requireObject(root['metadata'], '/metadata', ['name']);
  const name = requireIdentifier(metadata['name'], '/metadata/name');

  const spec = requireObject(root['spec'], '/spec', [
    'goal', 'scope', 'instructions', 'upstreams', 'proposal', 'verification',
    'publication', 'memory', 'triggers', 'sandbox', 'decisions', 'models', 'mcp', 'limits', 'output',
  ]);
  const limits: TaskpackLimitsDeclaration | undefined = spec['limits'] === undefined
    ? undefined
    : validateTaskpackLimitsDeclaration(spec['limits'], '/spec/limits');
  const goal = requireObject(spec['goal'], '/spec/goal', ['candidate', 'noChange']);
  const goalCandidate = requireString(goal['candidate'], '/spec/goal/candidate', 1, 1024);
  const goalNoChange = requireString(goal['noChange'], '/spec/goal/noChange', 1, 1024);

  let instructions: readonly string[] | undefined;
  if (spec['instructions'] !== undefined) {
    if (typeof spec['instructions'] === 'string') {
      instructions = Object.freeze([normalizeRelativePath(spec['instructions'], '/spec/instructions')]);
    } else {
      instructions = Object.freeze(
        requireStringList(spec['instructions'], '/spec/instructions', 1, 16)
          .map((entry, idx) => normalizeRelativePath(entry, `/spec/instructions/${idx}`)),
      );
    }
  }

  let writable: readonly string[] = [];
  let manifestProtected: readonly string[] = [];
  if (spec['scope'] !== undefined) {
    const scope = requireObject(spec['scope'], '/spec/scope', ['writable', 'protected']);
    if (scope['writable'] !== undefined) {
      writable = requireStringList(scope['writable'], '/spec/scope/writable', 1, 128)
        .map((entry, index) => normalizeRelativePath(entry, `/spec/scope/writable/${index}`));
    }
    if (scope['protected'] !== undefined) {
      manifestProtected = requireStringList(scope['protected'], '/spec/scope/protected', 0, 128)
        .map((entry, index) => normalizeRelativePath(entry, `/spec/scope/protected/${index}`));
    }
  }
  const builtInProtected = effectiveProtectedPaths([], { controlRoot, manifestPath });
  const protectedPaths = effectiveProtectedPaths(manifestProtected, { controlRoot, manifestPath, instructions });
  for (const [index, entry] of writable.entries()) {
    // A writable entry may encompass manifest-declared `protected` exclusions (blacklist wins),
    // but must never live inside any effective protected path or encompass built-in/control-root paths.
    const covering = protectedPaths.find(protectedPath => pathCoveredBy(entry, protectedPath));
    if (covering !== undefined) {
      throw new GitHubAppError('TASKPACK_SCOPE_VIOLATION', `writable path "${entry}" overlaps protected path "${covering}"`, `/spec/scope/writable/${index}`);
    }
    if (entry === controlRoot || pathCoveredBy(controlRoot, entry)) {
      throw new GitHubAppError('TASKPACK_SCOPE_VIOLATION', `writable path "${entry}" encompasses protected control root "${controlRoot}"`, `/spec/scope/writable/${index}`);
    }
    const encompassed = builtInProtected.find(protectedPath => pathCoveredBy(protectedPath, entry));
    if (encompassed !== undefined) {
      throw new GitHubAppError('TASKPACK_SCOPE_VIOLATION', `writable path "${entry}" encompasses built-in protected path "${encompassed}"`, `/spec/scope/writable/${index}`);
    }
  }

  const upstreamsValue = spec['upstreams'];
  if (!Array.isArray(upstreamsValue) || upstreamsValue.length < 1 || upstreamsValue.length > 32) {
    manifestInvalid('spec.upstreams must contain 1..32 entries', '/spec/upstreams');
  }
  const upstreamIds = new Set<string>();
  const upstreams = upstreamsValue.map((item, index) => {
    const upstream = requireObject(item, `/spec/upstreams/${index}`, ['id', 'kind', 'source', 'watchedPaths', 'allowPrerelease']);
    const upstreamId = requireIdentifier(upstream['id'], `/spec/upstreams/${index}/id`);
    if (upstreamIds.has(upstreamId)) manifestInvalid('duplicate upstream id', `/spec/upstreams/${index}/id`);
    upstreamIds.add(upstreamId);
    const kindText = requireString(upstream['kind'], `/spec/upstreams/${index}/kind`, 1, 32);
    if (!['github-release', 'git-tag', 'git-commit', 'http-json', 'custom-table'].includes(kindText)) {
      manifestInvalid('unsupported upstream kind', `/spec/upstreams/${index}/kind`);
    }
    const source = requireString(upstream['source'], `/spec/upstreams/${index}/source`, 1, 512);
    const watchedPaths = requireStringList(upstream['watchedPaths'], `/spec/upstreams/${index}/watchedPaths`, 0, 64)
      .map((entry, entryIndex) => normalizeRelativePath(entry, `/spec/upstreams/${index}/watchedPaths/${entryIndex}`));
    const allowPrerelease = upstream['allowPrerelease'] === undefined ? undefined : requireBoolean(upstream['allowPrerelease'], `/spec/upstreams/${index}/allowPrerelease`);
    const descriptor: TaskpackUpstreamDescriptor = allowPrerelease === undefined
      ? { id: upstreamId, kind: kindText as TaskpackUpstreamDescriptor['kind'], source, watchedPaths }
      : { id: upstreamId, kind: kindText as TaskpackUpstreamDescriptor['kind'], source, watchedPaths, allowPrerelease };
    return descriptor;
  });

  const proposal = requireObject(spec['proposal'], '/spec/proposal', ['path', 'requiredFields', 'schemaVersion']);
  const proposalPath = normalizeRelativePath(proposal['path'], '/spec/proposal/path');
  pathInsideWritable(proposalPath, writable, protectedPaths, '/spec/proposal/path');
  if (!/\.(?:yaml|yml|json)$/i.test(proposalPath)) {
    manifestInvalid('spec.proposal.path must end in .yaml, .yml, or .json', '/spec/proposal/path');
  }
  const requiredFields = requireStringList(proposal['requiredFields'], '/spec/proposal/requiredFields', 1, 32);
  for (const [index, field] of requiredFields.entries()) {
    if (!FIELD_NAME_PATTERN.test(field)) manifestInvalid(`required field "${field}" is not a valid field name`, `/spec/proposal/requiredFields/${index}`);
  }
  const schemaVersion = proposal['schemaVersion'];
  if (typeof schemaVersion !== 'number' || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
    manifestInvalid('schemaVersion must be a positive integer', '/spec/proposal/schemaVersion');
  }

  const verification = requireObject(spec['verification'], '/spec/verification', ['localChecks', 'externalGates']);
  const localChecksValue = verification['localChecks'];
  if (!Array.isArray(localChecksValue) || localChecksValue.length > 32) manifestInvalid('spec.verification.localChecks must contain 0..32 entries', '/spec/verification/localChecks');
  const externalGatesValue = verification['externalGates'];
  if (!Array.isArray(externalGatesValue) || externalGatesValue.length > 32) manifestInvalid('spec.verification.externalGates must contain 0..32 entries', '/spec/verification/externalGates');
  const checkIds = new Set<string>();
  const reservedIds = new Set(['scope', 'no-change', 'taskpack-author', 'taskpack-no-change']);
  const localChecks: TaskpackCheckDeclaration[] = localChecksValue.map((item, index) => {
    const check = requireObject(item, `/spec/verification/localChecks/${index}`, ['id', 'implementation', 'parameters']);
    const checkId = requireIdentifier(check['id'], `/spec/verification/localChecks/${index}/id`);
    if (checkIds.has(checkId)) manifestInvalid('duplicate check id across localChecks and externalGates', `/spec/verification/localChecks/${index}/id`);
    if (reservedIds.has(checkId)) manifestInvalid(`check id "${checkId}" is reserved by the compiler`, `/spec/verification/localChecks/${index}/id`);
    checkIds.add(checkId);
    const implementation = requireString(check['implementation'], `/spec/verification/localChecks/${index}/implementation`, 1, 32);
    if (!['json-artifact.v1', 'scope.v1', 'no-change.v1', 'command.v1'].includes(implementation)) {
      manifestInvalid('unsupported local check implementation', `/spec/verification/localChecks/${index}/implementation`);
    }
    if (implementation === 'command.v1') {
      const paramPath = `/spec/verification/localChecks/${index}/parameters`;
      const params = requireObject(check['parameters'], paramPath, ['script', 'timeoutSeconds', 'allowReadOnlyGitHubToken', 'env']);
      const script = normalizeRelativePath(params['script'], `${paramPath}/script`);
      if (!protectedPaths.some(protectedPath => pathCoveredBy(script, protectedPath))) {
        throw new GitHubAppError('TASKPACK_SCOPE_VIOLATION', `command.v1 script "${script}" must reside inside a protected path`, `${paramPath}/script`);
      }
      let explicitTimeoutSeconds: number | undefined;
      if (params['timeoutSeconds'] !== undefined) {
        const rawTimeout = params['timeoutSeconds'];
        if (typeof rawTimeout !== 'number' || !Number.isSafeInteger(rawTimeout) || rawTimeout < 1 || rawTimeout > 3_600) {
          manifestInvalid('command.v1 timeoutSeconds must be an integer in 1..3600', `${paramPath}/timeoutSeconds`);
        }
        explicitTimeoutSeconds = rawTimeout;
      }
      const allowReadOnlyGitHubToken = params['allowReadOnlyGitHubToken'] === undefined
        ? false
        : requireBoolean(params['allowReadOnlyGitHubToken'], `${paramPath}/allowReadOnlyGitHubToken`);
      let env: readonly string[] = Object.freeze([]);
      if (params['env'] !== undefined) {
        const rawEnv = requireStringList(params['env'], `${paramPath}/env`, 0, 16);
        for (const [envIdx, envName] of rawEnv.entries()) {
          if (!COMMAND_ENV_NAME_PATTERN.test(envName)) {
            manifestInvalid(`command.v1 env "${envName}" must match ^[A-Z][A-Z0-9_]{0,63}$`, `${paramPath}/env/${envIdx}`);
          }
          if (isReservedCommandEnvName(envName)) {
            manifestInvalid(`command.v1 env "${envName}" is reserved`, `${paramPath}/env/${envIdx}`);
          }
        }
        env = Object.freeze([...rawEnv]);
      }
      return Object.freeze({
        id: checkId,
        implementation: 'command.v1' as const,
        parameters: Object.freeze({
          script,
          ...(explicitTimeoutSeconds !== undefined ? { timeoutSeconds: explicitTimeoutSeconds } : {}),
          allowReadOnlyGitHubToken,
          env,
        }),
      });
    }
    const parametersKey = Object.hasOwn(check, 'parameters') ? 'parameters' : '';
    const record: { id: string; implementation: 'json-artifact.v1' | 'scope.v1' | 'no-change.v1'; parameters?: Readonly<Record<string, string | number | boolean | null>> } = {
      id: checkId, implementation: implementation as 'json-artifact.v1' | 'scope.v1' | 'no-change.v1',
    };
    if (parametersKey !== '') record.parameters = requireParameters(check['parameters'], `/spec/verification/localChecks/${index}/parameters`);
    return Object.freeze(record);
  });
  const commandScripts = localChecks
    .filter(c => c.implementation === 'command.v1')
    .map(c => String(c.parameters?.['script'] ?? ''))
    .filter(s => s.length > 0);
  const allProtected = effectiveProtectedPaths(manifestProtected, {
    controlRoot,
    manifestPath,
    instructions,
    commandScripts,
  });
  if (allProtected.length > 128) {
    manifestInvalid('effective protected path set exceeds 128 entries', '/spec/scope/protected');
  }
  const externalGates = externalGatesValue.map((item, index) => {
    const gate = requireObject(item, `/spec/verification/externalGates/${index}`, ['id', 'gateId', 'endpointId', 'required']);
    const gateId = requireIdentifier(gate['id'], `/spec/verification/externalGates/${index}/id`);
    if (checkIds.has(gateId)) manifestInvalid('duplicate check id across localChecks and externalGates', `/spec/verification/externalGates/${index}/id`);
    if (reservedIds.has(gateId)) manifestInvalid(`check id "${gateId}" is reserved by the compiler`, `/spec/verification/externalGates/${index}/id`);
    checkIds.add(gateId);
    const endpointId = requireIdentifier(gate['endpointId'], `/spec/verification/externalGates/${index}/endpointId`);
    if (endpointId === LOCAL_COMMAND_GATE_ENDPOINT_ID) {
      manifestInvalid(
        `endpointId "${LOCAL_COMMAND_GATE_ENDPOINT_ID}" is reserved for command.v1 local checks`,
        `/spec/verification/externalGates/${index}/endpointId`,
      );
    }
    return {
      id: gateId,
      gateId: requireIdentifier(gate['gateId'], `/spec/verification/externalGates/${index}/gateId`),
      endpointId,
      required: requireBoolean(gate['required'], `/spec/verification/externalGates/${index}/required`),
    };
  });

  const publication = requireObject(spec['publication'], '/spec/publication', ['mode', 'targetBranch', 'headBranchPrefix', 'titleTemplate']);
  const publicationMode = requireString(publication['mode'], '/spec/publication/mode', 1, 16);
  if (publicationMode !== 'pull_request' && publicationMode !== 'disabled') manifestInvalid('publication mode must be pull_request or disabled', '/spec/publication/mode');
  const targetBranch = requireString(publication['targetBranch'], '/spec/publication/targetBranch', 1, 128);
  if (!TARGET_BRANCH_PATTERN.test(targetBranch)) manifestInvalid('targetBranch is not a valid branch name', '/spec/publication/targetBranch');
  const headBranchPrefix = requireString(publication['headBranchPrefix'], '/spec/publication/headBranchPrefix', 1, 64);
  if (headBranchPrefix.includes('//') || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(headBranchPrefix.replace(/\/$/, ''))) {
    manifestInvalid('headBranchPrefix is not a valid branch prefix', '/spec/publication/headBranchPrefix');
  }
  const titleTemplate = requireString(publication['titleTemplate'], '/spec/publication/titleTemplate', 1, 256);

  const memory = requireObject(spec['memory'], '/spec/memory', ['directory', 'apply', 'onNoModelBudget']);
  const memoryDirectory = normalizeRelativePath(memory['directory'], '/spec/memory/directory');
  const memoryRoot = `${controlRoot}/memory`;
  if (!pathCoveredBy(memoryDirectory, memoryRoot)) {
    throw new GitHubAppError('TASKPACK_SCOPE_VIOLATION', `memory directory must be under ${memoryRoot}`, '/spec/memory/directory');
  }
  const memoryOverlap = writable.find(entry => pathCoveredBy(entry, memoryDirectory));
  if (memoryOverlap !== undefined) {
    throw new GitHubAppError('TASKPACK_SCOPE_VIOLATION', `memory directory "${memoryDirectory}" overlaps writable path "${memoryOverlap}"`, '/spec/memory/directory');
  }
  const apply = requireString(memory['apply'], '/spec/memory/apply', 1, 32);
  if (apply !== 'separate-pull-request') manifestInvalid('memory apply must be separate-pull-request', '/spec/memory/apply');
  const onNoModelBudget = requireString(memory['onNoModelBudget'], '/spec/memory/onNoModelBudget', 1, 48);
  if (onNoModelBudget !== 'deterministic-observations-only') manifestInvalid('onNoModelBudget must be deterministic-observations-only', '/spec/memory/onNoModelBudget');

  const triggers = requireObject(spec['triggers'], '/spec/triggers', ['schedule', 'workflowDispatch', 'releasePublished', 'commentCommands', 'commentPrefixes']);
  const schedule = requireBoolean(triggers['schedule'], '/spec/triggers/schedule');
  const workflowDispatch = requireBoolean(triggers['workflowDispatch'], '/spec/triggers/workflowDispatch');
  const releasePublished = requireBoolean(triggers['releasePublished'], '/spec/triggers/releasePublished');
  const commentCommandsValue = triggers['commentCommands'];
  if (!Array.isArray(commentCommandsValue) || commentCommandsValue.length > TASKPACK_COMMENT_COMMANDS.length) {
    manifestInvalid(`commentCommands must contain 0..${TASKPACK_COMMENT_COMMANDS.length} entries`, '/spec/triggers/commentCommands');
  }
  const seenCommands = new Set<string>();
  const commentCommands = commentCommandsValue.map((item, index) => {
    const command = requireString(item, `/spec/triggers/commentCommands/${index}`, 1, 8);
    if (!(TASKPACK_COMMENT_COMMANDS as readonly string[]).includes(command)) manifestInvalid(`unsupported comment command "${command}"`, '/spec/triggers/commentCommands');
    if (seenCommands.has(command)) manifestInvalid('duplicate comment command', '/spec/triggers/commentCommands');
    seenCommands.add(command);
    return command as TaskpackCommentCommand;
  });
  const commentPrefixesValue = triggers['commentPrefixes'];
  const commentPrefixes = commentPrefixesValue === undefined
    ? DEFAULT_COMMENT_PREFIXES
    : requireStringList(commentPrefixesValue, '/spec/triggers/commentPrefixes', 1, 8).map((entry, index) => {
      if (!COMMENT_PREFIX_PATTERN.test(entry)) manifestInvalid(`comment prefix "${entry}" must match /<token>`, `/spec/triggers/commentPrefixes/${index}`);
      return entry;
    });

  let sandbox: TaskpackSandboxDeclaration | undefined;
  if (spec['sandbox'] !== undefined) {
    const rawSandbox = requireObject(spec['sandbox'], '/spec/sandbox', ['preferredBackends', 'networkMode', 'requiredCapabilities', 'deniedReadPaths']);
    const allowedBackends: readonly SandboxBackendId[] = ['macos-seatbelt', 'linux-bwrap', 'linux-landlock', 'docker', 'direct-dedicated'];
    const allowedCapabilities: readonly SandboxCapability[] = [
      'filesystemReadContainment', 'filesystemWriteContainment', 'protectedPathReadOnlyMask',
      'networkIsolation', 'processTreeCleanup', 'syscallFiltering',
    ];
    let preferredBackends: readonly SandboxBackendId[] | undefined;
    if (rawSandbox['preferredBackends'] !== undefined) {
      preferredBackends = Object.freeze(
        requireStringList(rawSandbox['preferredBackends'], '/spec/sandbox/preferredBackends', 1, 5).map((item, idx) => {
          if (!(allowedBackends as readonly string[]).includes(item)) {
            manifestInvalid(`unsupported sandbox backend "${item}"`, `/spec/sandbox/preferredBackends/${idx}`);
          }
          return item as SandboxBackendId;
        }),
      );
    }
    let networkMode: SandboxNetworkMode | undefined;
    if (rawSandbox['networkMode'] !== undefined) {
      const modeStr = requireString(rawSandbox['networkMode'], '/spec/sandbox/networkMode', 1, 32);
      if (modeStr !== 'none' && modeStr !== 'loopback-only' && modeStr !== 'allow-outbound') {
        manifestInvalid(`unsupported sandbox networkMode "${modeStr}"`, '/spec/sandbox/networkMode');
      }
      networkMode = modeStr;
    } else {
      networkMode = 'none';
    }
    let requiredCapabilities: readonly SandboxCapability[] | undefined;
    if (rawSandbox['requiredCapabilities'] !== undefined) {
      requiredCapabilities = Object.freeze(
        requireStringList(rawSandbox['requiredCapabilities'], '/spec/sandbox/requiredCapabilities', 0, 6).map((item, idx) => {
          if (!(allowedCapabilities as readonly string[]).includes(item)) {
            manifestInvalid(`unsupported sandbox capability "${item}"`, `/spec/sandbox/requiredCapabilities/${idx}`);
          }
          return item as SandboxCapability;
        }),
      );
    }
    let deniedReadPaths: readonly string[] | undefined;
    if (rawSandbox['deniedReadPaths'] !== undefined) {
      deniedReadPaths = Object.freeze(
        requireStringList(rawSandbox['deniedReadPaths'], '/spec/sandbox/deniedReadPaths', 0, 64).map((entry, idx) => {
          const itemPath = `/spec/sandbox/deniedReadPaths/${idx}`;
          if (entry.startsWith('~/')) {
            return `~/${normalizeRelativePath(entry.slice(2), itemPath)}`;
          }
          return normalizeRelativePath(entry, itemPath);
        }),
      );
    }
    const sandboxObj: {
      preferredBackends?: readonly SandboxBackendId[];
      networkMode?: SandboxNetworkMode;
      requiredCapabilities?: readonly SandboxCapability[];
      deniedReadPaths?: readonly string[];
    } = { networkMode };
    if (preferredBackends !== undefined) sandboxObj.preferredBackends = preferredBackends;
    if (requiredCapabilities !== undefined) sandboxObj.requiredCapabilities = requiredCapabilities;
    if (deniedReadPaths !== undefined) sandboxObj.deniedReadPaths = deniedReadPaths;
    sandbox = Object.freeze(sandboxObj);
  }

  let decisions: TaskpackDecisionsDeclaration | undefined;
  if (spec['decisions'] !== undefined) {
    const rawDecisions = requireObject(spec['decisions'], '/spec/decisions', [
      'enabled', 'provider', 'disclosurePolicy', 'minConfidence', 'confirmThreshold',
      'hardDeadlineMs', 'maxAttempts', 'allowImages',
    ]);
    const enabled = requireBoolean(rawDecisions['enabled'], '/spec/decisions/enabled');
    const allowedProviders: readonly TaskpackDecisionProviderKind[] = [
      'typesafe-jev', 'openai-decisions', 'startlux-decision', 'microsoft-decision',
      'perplexity-decider', 'cloudflare-clef', 'liquid-d1',
    ];
    const allowedDisclosures: readonly TaskpackDecisionDisclosurePolicy[] = [
      'disabled', 'repo-approved-redacted-evidence', 'public-metadata-only',
    ];
    const decisionsObj: {
      enabled: boolean;
      provider?: TaskpackDecisionProviderKind;
      disclosurePolicy?: TaskpackDecisionDisclosurePolicy;
      minConfidence?: number;
      confirmThreshold?: number;
      hardDeadlineMs?: number;
      maxAttempts?: 1 | 2;
      allowImages?: boolean;
    } = { enabled };
    if (rawDecisions['provider'] !== undefined) {
      const providerStr = requireString(rawDecisions['provider'], '/spec/decisions/provider', 1, 64);
      if (!(allowedProviders as readonly string[]).includes(providerStr)) {
        manifestInvalid(`unsupported decisions provider "${providerStr}"`, '/spec/decisions/provider');
      }
      decisionsObj.provider = providerStr as TaskpackDecisionProviderKind;
    }
    if (rawDecisions['disclosurePolicy'] !== undefined) {
      const disclosureStr = requireString(rawDecisions['disclosurePolicy'], '/spec/decisions/disclosurePolicy', 1, 64);
      if (!(allowedDisclosures as readonly string[]).includes(disclosureStr)) {
        manifestInvalid(`unsupported decisions disclosurePolicy "${disclosureStr}"`, '/spec/decisions/disclosurePolicy');
      }
      decisionsObj.disclosurePolicy = disclosureStr as TaskpackDecisionDisclosurePolicy;
    }
    if (rawDecisions['minConfidence'] !== undefined) {
      const minConf = rawDecisions['minConfidence'];
      if (typeof minConf !== 'number' || !Number.isFinite(minConf) || minConf < 0.5 || minConf > 1) {
        manifestInvalid('decisions.minConfidence must be a finite number in [0.5, 1.0]', '/spec/decisions/minConfidence');
      }
      decisionsObj.minConfidence = minConf;
    }
    if (rawDecisions['confirmThreshold'] !== undefined) {
      const confirmThresh = rawDecisions['confirmThreshold'];
      if (typeof confirmThresh !== 'number' || !Number.isFinite(confirmThresh) || confirmThresh < 0 || confirmThresh > 1) {
        manifestInvalid('decisions.confirmThreshold must be a finite number in [0.0, 1.0]', '/spec/decisions/confirmThreshold');
      }
      decisionsObj.confirmThreshold = confirmThresh;
    }
    const effectiveConfirmThresh = decisionsObj.confirmThreshold ?? DEFAULT_DECISION_CONFIRM_THRESHOLD;
    const effectiveMinConf = decisionsObj.minConfidence ?? DEFAULT_DECISION_MIN_CONFIDENCE;
    if (effectiveConfirmThresh > effectiveMinConf) {
      manifestInvalid('decisions.confirmThreshold must not exceed minConfidence', '/spec/decisions/confirmThreshold');
    }
    if (rawDecisions['hardDeadlineMs'] !== undefined) {
      const deadline = rawDecisions['hardDeadlineMs'];
      if (typeof deadline !== 'number' || !Number.isSafeInteger(deadline) || deadline < 100 || deadline > 30_000) {
        manifestInvalid('decisions.hardDeadlineMs must be an integer in [100, 30000]', '/spec/decisions/hardDeadlineMs');
      }
      decisionsObj.hardDeadlineMs = deadline;
    }
    if (rawDecisions['maxAttempts'] !== undefined) {
      const attempts = rawDecisions['maxAttempts'];
      if (attempts !== 1 && attempts !== 2) {
        manifestInvalid('decisions.maxAttempts must be 1 or 2', '/spec/decisions/maxAttempts');
      }
      decisionsObj.maxAttempts = attempts;
    }
    if (rawDecisions['allowImages'] !== undefined) {
      decisionsObj.allowImages = requireBoolean(rawDecisions['allowImages'], '/spec/decisions/allowImages');
    }
    decisions = Object.freeze(decisionsObj);
  }

  let models: readonly TaskpackModelDeclaration[] | undefined;
  if (spec['models'] !== undefined) {
    models = validateTaskpackModelsDeclaration(spec['models'], '/spec/models');
    const modelApiKeyEnvs = new Set(
      models.map(m => m.apiKeyEnv).filter((v): v is string => v !== undefined),
    );
    if (modelApiKeyEnvs.size > 0) {
      for (const [checkIdx, check] of localChecks.entries()) {
        if (check.implementation !== 'command.v1') continue;
        const envList = check.parameters?.['env'];
        if (!Array.isArray(envList)) continue;
        for (const [envIdx, envName] of envList.entries()) {
          if (typeof envName === 'string' && modelApiKeyEnvs.has(envName)) {
            manifestInvalid(
              `command.v1 env "${envName}" conflicts with spec.models apiKeyEnv`,
              `/spec/verification/localChecks/${checkIdx}/parameters/env/${envIdx}`,
            );
          }
        }
      }
    }
  }

  let mcp: TaskpackMcpDeclaration | undefined;
  if (spec['mcp'] !== undefined) {
    const rawMcp = Array.isArray(spec['mcp'])
      ? { servers: spec['mcp'] }
      : requireObject(spec['mcp'], '/spec/mcp', ['servers']);
    const servers = validateMcpServerDeclarations(
      rawMcp['servers'],
      Array.isArray(spec['mcp']) ? '/spec/mcp' : '/spec/mcp/servers',
    );
    mcp = Object.freeze({ servers });
    const mcpSecretEnvs = collectMcpReferencedEnvNames(servers);
    if (mcpSecretEnvs.size > 0) {
      for (const [checkIdx, check] of localChecks.entries()) {
        if (check.implementation !== 'command.v1') continue;
        const envList = check.parameters?.['env'];
        if (!Array.isArray(envList)) continue;
        for (const [envIdx, envName] of envList.entries()) {
          if (typeof envName === 'string' && mcpSecretEnvs.has(envName)) {
            manifestInvalid(
              `command.v1 env "${envName}" conflicts with spec.mcp secret env binding`,
              `/spec/verification/localChecks/${checkIdx}/parameters/env/${envIdx}`,
            );
          }
        }
      }
    }
  }

  let output: TaskpackOutputDeclaration | undefined;
  if (spec['output'] !== undefined) {
    const parseOutputFormats = (rawFormats: unknown, fmtPath: string): readonly TaskpackOutputFormat[] => {
      const asOutputFormat = (token: string, tokenPath: string): TaskpackOutputFormat => {
        const matched = TASKPACK_OUTPUT_FORMATS.find(fmt => fmt === token);
        if (matched === undefined) {
          manifestInvalid(`unsupported output format "${token}"`, tokenPath);
        }
        return matched;
      };
      if (typeof rawFormats === 'string') {
        if (rawFormats.length === 0 || /[\0\r\n]/.test(rawFormats)) {
          manifestInvalid('output formats string must be non-empty without control characters', fmtPath);
        }
        const parts = rawFormats.split(',').map(part => part.trim());
        if (parts.length > TASKPACK_OUTPUT_FORMATS.length) {
          manifestInvalid(`expected 1..${TASKPACK_OUTPUT_FORMATS.length} output formats`, fmtPath);
        }
        const seen = new Set<TaskpackOutputFormat>();
        const parsed: TaskpackOutputFormat[] = [];
        for (const part of parts) {
          if (part.length === 0) {
            manifestInvalid('output formats must not contain empty tokens', fmtPath);
          }
          const fmt = asOutputFormat(part, fmtPath);
          if (seen.has(fmt)) {
            manifestInvalid(`duplicate output format "${fmt}"`, fmtPath);
          }
          seen.add(fmt);
          parsed.push(fmt);
        }
        return Object.freeze(parsed);
      }
      const list = requireStringList(rawFormats, fmtPath, 1, TASKPACK_OUTPUT_FORMATS.length);
      const seen = new Set<string>();
      const formats: TaskpackOutputFormat[] = [];
      for (const [idx, fmt] of list.entries()) {
        const normalized = asOutputFormat(fmt, `${fmtPath}/${idx}`);
        if (seen.has(normalized)) {
          manifestInvalid(`duplicate output format "${normalized}"`, `${fmtPath}/${idx}`);
        }
        seen.add(normalized);
        formats.push(normalized);
      }
      return Object.freeze(formats);
    };

    const rawSpecOutput = spec['output'];
    const formats = typeof rawSpecOutput === 'string' || Array.isArray(rawSpecOutput)
      ? parseOutputFormats(rawSpecOutput, '/spec/output')
      : parseOutputFormats(requireObject(rawSpecOutput, '/spec/output', ['formats'])['formats'], '/spec/output/formats');
    output = Object.freeze({ formats });
  }

  const baseSpec = {
    goal: Object.freeze({ candidate: goalCandidate, noChange: goalNoChange }),
    scope: Object.freeze({ writable: Object.freeze(writable), protected: Object.freeze(manifestProtected) }),
    ...(instructions === undefined ? {} : { instructions }),
    upstreams: Object.freeze(upstreams),
    proposal: Object.freeze({ path: proposalPath, requiredFields: Object.freeze(requiredFields), schemaVersion }),
    verification: Object.freeze({ localChecks: Object.freeze(localChecks), externalGates: Object.freeze(externalGates) }),
    publication: Object.freeze({ mode: publicationMode as 'pull_request' | 'disabled', targetBranch, headBranchPrefix, titleTemplate }),
    memory: Object.freeze({ directory: memoryDirectory, apply: 'separate-pull-request' as const, onNoModelBudget: 'deterministic-observations-only' as const }),
    triggers: Object.freeze({ schedule, workflowDispatch, releasePublished, commentCommands: Object.freeze(commentCommands), commentPrefixes: Object.freeze(commentPrefixes) }),
    ...(sandbox === undefined ? {} : { sandbox }),
    ...(decisions === undefined ? {} : { decisions }),
    ...(models === undefined ? {} : { models }),
    ...(mcp === undefined ? {} : { mcp }),
    ...(limits === undefined ? {} : { limits }),
    ...(output === undefined ? {} : { output }),
  };
  const specRecord: TaskpackManifest['spec'] = Object.freeze(baseSpec);

  const manifest: TaskpackManifest = {
    apiVersion: TASKPACK_MANIFEST_API_VERSION,
    kind: 'Taskpack',
    metadata: Object.freeze({ name }),
    spec: specRecord,
  };
  // Keep controlRoot and manifestPath non-enumerable so JSON.stringify round-trips cleanly.
  Object.defineProperty(manifest, 'controlRoot', { value: controlRoot, enumerable: false });
  if (manifestPath !== undefined) {
    Object.defineProperty(manifest, 'manifestPath', { value: manifestPath, enumerable: false });
  }
  return Object.freeze(manifest);
}
