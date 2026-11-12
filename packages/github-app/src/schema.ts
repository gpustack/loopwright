import { CST, isAlias, isMap, isScalar, isSeq, Lexer, parseDocument } from 'yaml';
import {
  GitHubAppError, DEFAULT_COMMENT_PREFIXES, PROTECTED_AUTOMATION_PATHS, TASKPACK_COMMENT_COMMANDS,
  TASKPACK_MANIFEST_API_VERSION, TASKPACK_MANIFEST_BYTES,
  type SandboxBackendId, type SandboxCapability, type SandboxNetworkMode,
  type TaskpackCommentCommand, type TaskpackDecisionDisclosurePolicy, type TaskpackDecisionProviderKind,
  type TaskpackDecisionsDeclaration, type TaskpackManifest, type TaskpackModelDeclaration, type TaskpackSandboxDeclaration,
  type TaskpackUpstreamDescriptor,
} from './types.js';
import { validateTaskpackModelsDeclaration } from './models-config.js';

export const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const TARGET_BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const COMMENT_PREFIX_PATTERN = /^\/[A-Za-z0-9_-]{0,31}$/;
const FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
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

/** Validate a manifest-declared relative path: no traversal, no absolutes, no escapes. */
export function normalizeRelativePath(input: unknown, path: string): string {
  if (typeof input !== 'string' || input.length === 0 || input.length > 1024) {
    manifestInvalid('path must be a non-empty string of at most 1024 characters', path);
  }
  if (input.includes('\0') || input.includes('\\') || input.includes(':')) manifestInvalid('path contains forbidden characters', path);
  if (input.startsWith('/')) manifestInvalid('path must be relative', path);
  const segments = input.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') manifestInvalid(`path segment "${segment}" is not allowed`, path);
  }
  return input;
}

/** True when `candidate` equals `root` or lives underneath it. */
export function pathCoveredBy(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith('/') ? root : `${root}/`);
}

/** The manifest-protected set merged with the built-in automation paths. */
export function effectiveProtectedPaths(manifestProtected: readonly string[]): readonly string[] {
  return Object.freeze([...new Set([...PROTECTED_AUTOMATION_PATHS, ...manifestProtected])]);
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
  if (!writable.some(root => pathCoveredBy(candidate, root))) {
    throw new GitHubAppError('TASKPACK_SCOPE_VIOLATION', `path "${candidate}" is not inside spec.scope.writable`, path);
  }
  const overlap = protectedPaths.find(protectedPath => pathCoveredBy(candidate, protectedPath) || pathCoveredBy(protectedPath, candidate));
  if (overlap !== undefined) {
    throw new GitHubAppError('TASKPACK_SCOPE_VIOLATION', `path "${candidate}" overlaps protected path "${overlap}"`, path);
  }
}

/**
 * Validate a parsed manifest document against every Feature 1 constraint and return the frozen manifest.
 * Scope violations (writable overlapping the effective protected set, memory directory placement) throw
 * `TASKPACK_SCOPE_VIOLATION`; all other schema violations throw `TASKPACK_MANIFEST_INVALID`.
 */
export function validateTaskpackManifest(value: Json): TaskpackManifest {
  const root = requireObject(value, '/', ['apiVersion', 'kind', 'metadata', 'spec']);
  if (root['apiVersion'] !== TASKPACK_MANIFEST_API_VERSION) manifestInvalid('unsupported apiVersion', '/apiVersion');
  if (root['kind'] !== 'Taskpack') manifestInvalid('kind must be Taskpack', '/kind');
  const metadata = requireObject(root['metadata'], '/metadata', ['name']);
  const name = requireIdentifier(metadata['name'], '/metadata/name');

  const spec = requireObject(root['spec'], '/spec', ['goal', 'scope', 'upstreams', 'proposal', 'verification', 'publication', 'memory', 'triggers', 'sandbox', 'decisions', 'models']);
  const goal = requireObject(spec['goal'], '/spec/goal', ['candidate', 'noChange']);
  const goalCandidate = requireString(goal['candidate'], '/spec/goal/candidate', 1, 1024);
  const goalNoChange = requireString(goal['noChange'], '/spec/goal/noChange', 1, 1024);

  const scope = requireObject(spec['scope'], '/spec/scope', ['writable', 'protected']);
  const writable = requireStringList(scope['writable'], '/spec/scope/writable', 1, 128).map((entry, index) => normalizeRelativePath(entry, `/spec/scope/writable/${index}`));
  const manifestProtected = requireStringList(scope['protected'], '/spec/scope/protected', 0, 128).map((entry, index) => normalizeRelativePath(entry, `/spec/scope/protected/${index}`));
  const protectedPaths = effectiveProtectedPaths(manifestProtected);
  for (const [index, entry] of writable.entries()) {
    // A writable path must neither live inside a protected path nor encompass one: the second direction
    // keeps built-in automation paths (e.g. `.loopwright/policies` under a writable `.loopwright`) safe.
    const covering = protectedPaths.find(protectedPath => pathCoveredBy(entry, protectedPath));
    if (covering !== undefined) {
      throw new GitHubAppError('TASKPACK_SCOPE_VIOLATION', `writable path "${entry}" overlaps protected path "${covering}"`, `/spec/scope/writable/${index}`);
    }
    const encompassed = PROTECTED_AUTOMATION_PATHS.find(protectedPath => pathCoveredBy(protectedPath, entry));
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
  const localChecks = localChecksValue.map((item, index) => {
    const check = requireObject(item, `/spec/verification/localChecks/${index}`, ['id', 'implementation', 'parameters']);
    const checkId = requireIdentifier(check['id'], `/spec/verification/localChecks/${index}/id`);
    if (checkIds.has(checkId)) manifestInvalid('duplicate check id across localChecks and externalGates', `/spec/verification/localChecks/${index}/id`);
    if (reservedIds.has(checkId)) manifestInvalid(`check id "${checkId}" is reserved by the compiler`, `/spec/verification/localChecks/${index}/id`);
    checkIds.add(checkId);
    const implementation = requireString(check['implementation'], `/spec/verification/localChecks/${index}/implementation`, 1, 32);
    if (!['json-artifact.v1', 'scope.v1', 'no-change.v1'].includes(implementation)) {
      manifestInvalid('unsupported local check implementation', `/spec/verification/localChecks/${index}/implementation`);
    }
    const parametersKey = Object.hasOwn(check, 'parameters') ? 'parameters' : '';
    const record: { id: string; implementation: TaskpackCheckImplementationKind; parameters?: Readonly<Record<string, string | number | boolean | null>> } = {
      id: checkId, implementation: implementation as TaskpackCheckImplementationKind,
    };
    if (parametersKey !== '') record.parameters = requireParameters(check['parameters'], `/spec/verification/localChecks/${index}/parameters`);
    return record;
  });
  const externalGates = externalGatesValue.map((item, index) => {
    const gate = requireObject(item, `/spec/verification/externalGates/${index}`, ['id', 'gateId', 'endpointId', 'required']);
    const gateId = requireIdentifier(gate['id'], `/spec/verification/externalGates/${index}/id`);
    if (checkIds.has(gateId)) manifestInvalid('duplicate check id across localChecks and externalGates', `/spec/verification/externalGates/${index}/id`);
    if (reservedIds.has(gateId)) manifestInvalid(`check id "${gateId}" is reserved by the compiler`, `/spec/verification/externalGates/${index}/id`);
    checkIds.add(gateId);
    return {
      id: gateId,
      gateId: requireIdentifier(gate['gateId'], `/spec/verification/externalGates/${index}/gateId`),
      endpointId: requireIdentifier(gate['endpointId'], `/spec/verification/externalGates/${index}/endpointId`),
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
  const memoryRoot = `.loopwright/memory/${name}`;
  if (!pathCoveredBy(memoryDirectory, memoryRoot)) {
    throw new GitHubAppError('TASKPACK_SCOPE_VIOLATION', `memory directory must be under ${memoryRoot}`, '/spec/memory/directory');
  }
  const memoryOverlap = writable.find(entry => pathCoveredBy(memoryDirectory, entry) || pathCoveredBy(entry, memoryDirectory));
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
  }

  const baseSpec = {
    goal: Object.freeze({ candidate: goalCandidate, noChange: goalNoChange }),
    scope: Object.freeze({ writable: Object.freeze(writable), protected: Object.freeze(manifestProtected) }),
    upstreams: Object.freeze(upstreams),
    proposal: Object.freeze({ path: proposalPath, requiredFields: Object.freeze(requiredFields), schemaVersion }),
    verification: Object.freeze({ localChecks: Object.freeze(localChecks), externalGates: Object.freeze(externalGates) }),
    publication: Object.freeze({ mode: publicationMode as 'pull_request' | 'disabled', targetBranch, headBranchPrefix, titleTemplate }),
    memory: Object.freeze({ directory: memoryDirectory, apply: 'separate-pull-request' as const, onNoModelBudget: 'deterministic-observations-only' as const }),
    triggers: Object.freeze({ schedule, workflowDispatch, releasePublished, commentCommands: Object.freeze(commentCommands), commentPrefixes: Object.freeze(commentPrefixes) }),
    ...(sandbox === undefined ? {} : { sandbox }),
    ...(decisions === undefined ? {} : { decisions }),
    ...(models === undefined ? {} : { models }),
  };
  const specRecord: TaskpackManifest['spec'] = Object.freeze(baseSpec);

  return Object.freeze({
    apiVersion: TASKPACK_MANIFEST_API_VERSION,
    kind: 'Taskpack',
    metadata: Object.freeze({ name }),
    spec: specRecord,
  });
}

type TaskpackCheckImplementationKind = TaskpackManifest['spec']['verification']['localChecks'][number]['implementation'];
