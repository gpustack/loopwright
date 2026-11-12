import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { CST, isAlias, isMap, isScalar, isSeq, Lexer, parseDocument } from 'yaml';
import { DecisionError, DECISION_MAX_CRITERIA, DECISION_MAX_OPTIONS, DECISION_MAX_QUESTIONS, DECISION_MIN_CRITERIA,
  DECISION_POLICY_DOCUMENT_API_VERSION, DECISION_POLICY_MAX_BYTES,
  DECISION_PROVIDER_DEFAULTS, DEFAULT_DECISION_POLICY } from './types.js';
import type {
  DecisionChoiceQuestion, DecisionDisclosurePolicy, DecisionFallbackUnavailableAction, DecisionNoulQuestion,
  DecisionPolicyConfig, DecisionProviderKind, DecisionQuestion, DecisionScoreQuestion, DecisionStartluxOptions,
} from './types.js';

export { DECISION_POLICY_DOCUMENT_API_VERSION, DECISION_POLICY_MAX_BYTES };

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function failInvalid(detail: string): never {
  throw new DecisionError('DECISION_POLICY_INVALID', detail);
}

const DISCLOSURE_POLICIES: readonly DecisionDisclosurePolicy[] = ['disabled', 'repo-approved-redacted-evidence', 'public-metadata-only'];
const FALLBACK_ACTIONS: readonly DecisionFallbackUnavailableAction[] = ['blocked', 'deterministic_default'];
const PROVIDER_KINDS: readonly DecisionProviderKind[] = ['typesafe-jev', 'openai-decisions', 'startlux-decision', 'microsoft-decision', 'perplexity-decider', 'cloudflare-clef', 'liquid-d1'];

function validateStartluxOptions(raw: unknown): DecisionStartluxOptions {
  if (!isPlainObject(raw)) failInvalid('startluxOptions must be a plain object when provided');
  const allowedStartluxKeys = new Set(['thinkMode', 'thinkBudget', 'gate', 'allowNone', 'noneCheck', 'noneProbabilityThreshold']);
  for (const key of Object.keys(raw)) {
    if (!allowedStartluxKeys.has(key)) failInvalid(`unknown startluxOptions field "${key}"`);
  }
  const thinkMode = raw['thinkMode'];
  if (thinkMode !== undefined && thinkMode !== 'instant' && thinkMode !== 'auto') failInvalid('startluxOptions.thinkMode must be instant or auto');
  const thinkBudget = raw['thinkBudget'];
  if (thinkBudget !== undefined && (!isFiniteNumber(thinkBudget) || !Number.isInteger(thinkBudget) || thinkBudget < 1 || thinkBudget > 4096)) {
    failInvalid('startluxOptions.thinkBudget must be an integer in [1, 4096]');
  }
  const gate = raw['gate'];
  if (gate !== undefined && (!isFiniteNumber(gate) || gate < 0 || gate > 1)) failInvalid('startluxOptions.gate must be a finite number in [0.00, 1.00]');
  const allowNone = raw['allowNone'];
  if (allowNone !== undefined && typeof allowNone !== 'boolean') failInvalid('startluxOptions.allowNone must be a boolean');
  const noneCheck = raw['noneCheck'];
  if (noneCheck !== undefined && typeof noneCheck !== 'boolean') failInvalid('startluxOptions.noneCheck must be a boolean');
  const noneProbabilityThreshold = raw['noneProbabilityThreshold'];
  if (noneProbabilityThreshold !== undefined && (!isFiniteNumber(noneProbabilityThreshold) || noneProbabilityThreshold <= 0 || noneProbabilityThreshold >= 1)) {
    failInvalid('startluxOptions.noneProbabilityThreshold must be a finite number strictly between 0 and 1');
  }
  return Object.freeze({ ...raw }) as DecisionStartluxOptions;
}

/**
 * Validate and normalize a `DecisionPolicyConfig`, applying spec defaults; any out-of-range or malformed
 * field fails closed with `DECISION_POLICY_INVALID`.
 */
export function validateDecisionPolicy(input: unknown): DecisionPolicyConfig {
  const raw = (input ?? {}) as Record<string, unknown>;
  if (input !== undefined && input !== null && !isPlainObject(input)) failInvalid('policy must be a plain object');
  const enabled = raw['enabled'] ?? DEFAULT_DECISION_POLICY.enabled;
  if (typeof enabled !== 'boolean') failInvalid('enabled must be a boolean');
  const disclosurePolicy = raw['disclosurePolicy'] ?? DEFAULT_DECISION_POLICY.disclosurePolicy;
  if (typeof disclosurePolicy !== 'string' || !DISCLOSURE_POLICIES.includes(disclosurePolicy as DecisionDisclosurePolicy)) {
    failInvalid(`disclosurePolicy must be one of ${DISCLOSURE_POLICIES.join(' | ')}`);
  }
  const minConfidence = raw['minConfidence'] ?? DEFAULT_DECISION_POLICY.minConfidence;
  if (!isFiniteNumber(minConfidence) || minConfidence < 0.5 || minConfidence > 1) {
    failInvalid('minConfidence must be a finite number in [0.50, 1.00]');
  }
  const confirmThreshold = raw['confirmThreshold'] ?? DEFAULT_DECISION_POLICY.confirmThreshold;
  if (!isFiniteNumber(confirmThreshold) || confirmThreshold < 0 || confirmThreshold > 1) {
    failInvalid('confirmThreshold must be a finite number in [0.00, 1.00]');
  }
  if (confirmThreshold > minConfidence) failInvalid('confirmThreshold must not exceed minConfidence');
  const hardDeadlineMs = raw['hardDeadlineMs'] ?? DEFAULT_DECISION_POLICY.hardDeadlineMs;
  if (!isFiniteNumber(hardDeadlineMs) || !Number.isInteger(hardDeadlineMs) || hardDeadlineMs < 100 || hardDeadlineMs > 30_000) {
    failInvalid('hardDeadlineMs must be an integer in [100, 30000]');
  }
  const maxAttempts = raw['maxAttempts'] ?? DEFAULT_DECISION_POLICY.maxAttempts;
  if (maxAttempts !== 1 && maxAttempts !== 2) failInvalid('maxAttempts must be 1 or 2');
  const fallbackRole = raw['fallbackRole'] === undefined ? DEFAULT_DECISION_POLICY.fallbackRole : raw['fallbackRole'];
  if (fallbackRole !== null && (typeof fallbackRole !== 'string' || fallbackRole.trim().length === 0)) {
    failInvalid('fallbackRole must be a non-empty string or null');
  }
  const onFallbackUnavailable = raw['onFallbackUnavailable'] ?? DEFAULT_DECISION_POLICY.onFallbackUnavailable;
  if (typeof onFallbackUnavailable !== 'string' || !FALLBACK_ACTIONS.includes(onFallbackUnavailable as DecisionFallbackUnavailableAction)) {
    failInvalid(`onFallbackUnavailable must be one of ${FALLBACK_ACTIONS.join(' | ')}`);
  }
  const allowImages = raw['allowImages'] ?? DEFAULT_DECISION_POLICY.allowImages;
  if (typeof allowImages !== 'boolean') failInvalid('allowImages must be a boolean');
  const provider = raw['provider'] ?? 'typesafe-jev';
  if (typeof provider !== 'string' || !PROVIDER_KINDS.includes(provider as DecisionProviderKind)) {
    failInvalid(`provider must be one of ${PROVIDER_KINDS.join(' | ')}`);
  }
  const providerDefaults = DECISION_PROVIDER_DEFAULTS[provider as DecisionProviderKind];
  const endpoint = raw['endpoint'] === undefined ? providerDefaults.endpoint : raw['endpoint'];
  if (typeof endpoint !== 'string' || endpoint.trim().length === 0 || !/^https?:\/\//.test(endpoint)) {
    failInvalid('endpoint must be an http(s) URL string');
  }
  const model = raw['model'] === undefined ? providerDefaults.model : raw['model'];
  if (typeof model !== 'string' || model.trim().length === 0) failInvalid('model must be a non-empty string');
  const startluxOptions = raw['startluxOptions'] === undefined || raw['startluxOptions'] === null ? null : validateStartluxOptions(raw['startluxOptions']);
  return Object.freeze({
    enabled,
    disclosurePolicy,
    minConfidence,
    confirmThreshold,
    hardDeadlineMs,
    maxAttempts,
    fallbackRole,
    onFallbackUnavailable,
    provider,
    endpoint,
    model,
    startluxOptions,
    allowImages,
  }) as DecisionPolicyConfig;
}

function failSchema(detail: string): never {
  throw new DecisionError('DECISION_SCHEMA_INVALID', detail);
}

function failBatch(detail: string): never {
  throw new DecisionError('DECISION_BATCH_SIZE_INVALID', detail);
}

function failUnsupported(detail: string): never {
  throw new DecisionError('DECISION_PRIMITIVE_UNSUPPORTED', detail);
}

function validateQuestionIdentity(raw: Record<string, unknown>, index: number): { id: string; prompt: string } {
  const id = raw['id'];
  if (typeof id !== 'string' || id.trim().length === 0 || id.length > 128) {
    failSchema(`question ${index} id must be a non-empty string of at most 128 characters`);
  }
  const prompt = raw['prompt'];
  if (typeof prompt !== 'string' || prompt.trim().length === 0 || prompt.length > 2048) {
    failSchema(`question ${index} prompt must be a non-empty string of at most 2048 characters`);
  }
  return { id, prompt };
}

function normalizeChoiceOptions(raw: Record<string, unknown>, id: string): Readonly<Record<string, string>> {
  const options = raw['options'];
  let entries: readonly [string, string][];
  if (Array.isArray(options)) {
    entries = options.map(option => {
      if (typeof option !== 'string' || option.trim().length === 0) failSchema(`choice question ${id} option entries must be non-empty strings`);
      return [option, option] as [string, string];
    });
  } else if (isPlainObject(options)) {
    entries = Object.keys(options).map(key => {
      const label = options[key];
      if (typeof key !== 'string' || key.trim().length === 0 || typeof label !== 'string' || label.trim().length === 0) {
        failSchema(`choice question ${id} options must map non-empty keys to non-empty descriptions`);
      }
      return [key, label] as [string, string];
    });
  } else {
    failSchema(`choice question ${id} options must be a plain object or a non-empty string array`);
  }
  if (entries.length < 1 || entries.length > DECISION_MAX_OPTIONS) {
    failSchema(`choice question ${id} must declare between 1 and ${DECISION_MAX_OPTIONS} options`);
  }
  const keys = new Set(entries.map(([key]) => key));
  if (keys.size !== entries.length) failSchema(`choice question ${id} option keys must be distinct`);
  return Object.freeze(Object.fromEntries(entries));
}

function normalizeScoreCriteria(raw: Record<string, unknown>, id: string): readonly string[] {
  const criteria = raw['criteria'];
  if (!Array.isArray(criteria) || criteria.length < DECISION_MIN_CRITERIA || criteria.length > DECISION_MAX_CRITERIA) {
    failSchema(`score question ${id} must declare between ${DECISION_MIN_CRITERIA} and ${DECISION_MAX_CRITERIA} criteria levels`);
  }
  return Object.freeze(criteria.map((level, levelIndex) => {
    if (typeof level !== 'string' || level.trim().length === 0) {
      failSchema(`score question ${id} criteria level ${levelIndex} must be a non-empty description`);
    }
    return level;
  }));
}

/**
 * Validate a batch of `choice` / `score` / `noul` / `box` questions (AC-2.1, REVIEW-003): batch size
 * `1..100`, unique ids, bounded prompts, bounded option and criteria cardinalities. Binary `predicate`
 * inputs canonicalize to `noul`. The `box` primitive requires an image-capable policy (`allowImages`,
 * non-OpenAI provider) and is refused pre-send with `DECISION_PRIMITIVE_UNSUPPORTED` otherwise.
 */
export function validateDecisionQuestions(questions: unknown, policy?: DecisionPolicyConfig): readonly DecisionQuestion[] {
  if (!Array.isArray(questions)) failBatch('questions must be an array');
  if (questions.length < 1 || questions.length > DECISION_MAX_QUESTIONS) {
    failBatch(`questions batch length must be between 1 and ${DECISION_MAX_QUESTIONS}`);
  }
  const seen = new Set<string>();
  return Object.freeze(questions.map((entry, index): DecisionQuestion => {
    if (!isPlainObject(entry)) failSchema(`question ${index} must be a plain object`);
    const rawType = entry['type'];
    // The OpenAI Decisions API calls binary questions `predicate`, some providers `boolean`; canonicalize to `noul`.
    const type = rawType === 'predicate' || rawType === 'boolean' ? 'noul' : rawType;
    if (type !== 'choice' && type !== 'score' && type !== 'noul' && type !== 'box') {
      failSchema(`question ${index} type must be choice, score, noul (predicate/boolean alias), or box`);
    }
    if (type === 'box' && (policy === undefined || !policy.allowImages)) {
      failUnsupported('box primitive requires policy.allowImages === true');
    }
    if (type === 'box' && policy !== undefined && policy.provider === 'openai-decisions') {
      failUnsupported('box primitive is not supported on the openai-decisions provider');
    }
    const { id, prompt } = validateQuestionIdentity(entry, index);
    if (seen.has(id)) failSchema(`question id ${id} is duplicated`);
    seen.add(id);
    if (type === 'choice') {
      const allowNone = entry['allowNone'];
      if (allowNone !== undefined && typeof allowNone !== 'boolean') failSchema(`choice question ${id} allowNone must be a boolean`);
      const options = normalizeChoiceOptions(entry, id);
      const question: DecisionChoiceQuestion = allowNone === undefined
        ? { type, id, prompt, options }
        : { type, id, prompt, options, allowNone };
      return Object.freeze(question);
    }
    if (type === 'score') {
      const question: DecisionScoreQuestion = { type, id, prompt, criteria: normalizeScoreCriteria(entry, id) };
      return Object.freeze(question);
    }
    if (type === 'box') return Object.freeze({ type, id, prompt });
    const threshold = entry['threshold'];
    if (threshold !== undefined && (!isFiniteNumber(threshold) || threshold <= 0 || threshold >= 1)) {
      failSchema(`noul question ${id} threshold must be a finite number strictly between 0 and 1`);
    }
    const question: DecisionNoulQuestion = threshold === undefined
      ? Object.freeze({ type, id, prompt })
      : Object.freeze({ type, id, prompt, threshold });
    return question;
  }));
}

// ---------------------------------------------------------------------------
// Strict bounded YAML 1.2 (`yaml`) / JSON policy document parser
// ---------------------------------------------------------------------------

type PolicyJson = null | boolean | number | string | PolicyJson[] | { [key: string]: PolicyJson };

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
// Twin yaml@2.9.0 AST traversal caps shared with packages/github-app/src/schema.ts (4096 nodes, depth 16, 512 collection items, 8192 string chars).
const MAX_NODES = 4096;
const MAX_DEPTH = 16;
const MAX_COLLECTION = 512;
const MAX_STRING = 8192;
const ALLOWED_POLICY_KEYS = new Set([
  'enabled', 'disclosurePolicy', 'minConfidence', 'confirmThreshold',
  'hardDeadlineMs', 'maxAttempts', 'fallbackRole', 'onFallbackUnavailable',
  'provider', 'endpoint', 'model', 'startluxOptions', 'allowImages',
]);

function decodePolicyText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    failInvalid('decision policy bytes are not valid UTF-8');
  }
}

function parsePolicyJsonSubset(source: string): PolicyJson {
  let offset = 0, nodes = 0;
  const charAt = (index: number): string => source.charAt(index);
  const skipSpace = () => {
    while (offset < source.length && /[\x20\t\r\n]/.test(charAt(offset))) offset++;
  };
  const string = (): string => {
    const start = offset++;
    let closed = false;
    while (offset < source.length) {
      const char = charAt(offset++);
      if (char === '"') { closed = true; break; }
      if (char === '\\') offset++;
    }
    if (!closed) failInvalid('unterminated JSON string');
    let parsed: unknown;
    try { parsed = JSON.parse(source.slice(start, offset)); } catch { failInvalid('invalid JSON string escape'); }
    if (typeof parsed !== 'string' || parsed.length > MAX_STRING) failInvalid('JSON string out of bounds');
    return parsed;
  };
  const value = (depth: number): PolicyJson => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) failInvalid('JSON document exceeds node or depth limits');
    skipSpace();
    const char = charAt(offset);
    if (char === '{') {
      offset++;
      const output: Record<string, PolicyJson> = {}, keys = new Set<string>();
      skipSpace();
      if (charAt(offset) === '}') { offset++; return output; }
      while (true) {
        skipSpace();
        if (charAt(offset) !== '"') failInvalid('JSON object keys must be strings');
        const key = string();
        if (keys.has(key)) failInvalid(`duplicate JSON member "${key}"`);
        if (FORBIDDEN_KEYS.has(key)) failInvalid(`forbidden JSON member "${key}"`);
        keys.add(key);
        skipSpace();
        if (charAt(offset++) !== ':') failInvalid('expected ":" after JSON member name');
        output[key] = value(depth + 1);
        skipSpace();
        const delimiter = charAt(offset++);
        if (delimiter === '}') return output;
        if (delimiter !== ',') failInvalid('expected "," or "}" in JSON object');
      }
    }
    if (char === '[') {
      offset++;
      const items: PolicyJson[] = [];
      skipSpace();
      if (charAt(offset) === ']') { offset++; return items; }
      while (true) {
        if (items.length >= MAX_COLLECTION) failInvalid('JSON array exceeds collection limits');
        items.push(value(depth + 1));
        skipSpace();
        const delimiter = charAt(offset++);
        if (delimiter === ']') return items;
        if (delimiter !== ',') failInvalid('expected "," or "]" in JSON array');
      }
    }
    if (char === '"') return string();
    const literal = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(offset));
    if (literal === null) failInvalid('invalid JSON value');
    offset += literal[0].length;
    if (literal[0] === 'true') return true;
    if (literal[0] === 'false') return false;
    if (literal[0] === 'null') return null;
    const number = Number(literal[0]);
    if (!Number.isFinite(number) || Object.is(number, -0)) failInvalid('JSON number out of bounds');
    return number;
  };
  const parsed = value(1);
  skipSpace();
  if (offset !== source.length) failInvalid('trailing content after JSON document');
  return parsed;
}

function parsePolicyYamlDocument(source: string): PolicyJson {
  let flow = 0, tokens = 0, scalar = false, inlineSequence = 0;
  for (const token of new Lexer().lex(source)) {
    if (scalar) { scalar = false; continue; }
    const kind = CST.tokenType(token);
    if (kind === 'scalar') scalar = true;
    if (kind === 'newline') inlineSequence = 0;
    if (kind === 'seq-item-ind' && ++inlineSequence > 32) failInvalid('YAML inline sequence exceeds depth limits');
    if (kind === 'flow-map-start' || kind === 'flow-seq-start') { if (++flow > 32) failInvalid('YAML flow collection exceeds depth limits'); }
    if (kind === 'flow-map-end' || kind === 'flow-seq-end') flow--;
    if (!['space', 'newline', 'comment'].includes(kind ?? '') && ++tokens > 65536) failInvalid('YAML document exceeds token limits');
  }
  const document = parseDocument(source, { version: '1.2', schema: 'core', uniqueKeys: true, merge: false, strict: true, customTags: [] });
  if (document.errors.length > 0) {
    failInvalid(document.errors[0]?.message ?? 'invalid YAML syntax');
  }
  let nodes = 0;
  function visit(node: unknown, depth: number): void {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) failInvalid('YAML document exceeds node or depth limits');
    if (node === null) return;
    if (
      isAlias(node) || !node || typeof node !== 'object' ||
      ('tag' in node && node.tag !== undefined) ||
      ('anchor' in node && node.anchor !== undefined)
    ) {
      failInvalid('YAML aliases, anchors, and tags are unsupported');
    }
    if (isMap(node)) {
      if (node.items.length > MAX_COLLECTION) failInvalid('YAML mapping exceeds collection limits');
      const seen = new Set<string>();
      for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || pair.key.value === '<<' || pair.key.value.length > MAX_STRING) {
          failInvalid('YAML mapping key must be a valid string');
        }
        const key = pair.key.value;
        if (FORBIDDEN_KEYS.has(key)) failInvalid(`forbidden key "${key}"`);
        if (seen.has(key)) failInvalid(`duplicate key "${key}"`);
        seen.add(key);
        visit(pair.key, depth + 1);
        visit(pair.value, depth + 1);
      }
    } else if (isSeq(node)) {
      if (node.items.length > MAX_COLLECTION) failInvalid('YAML sequence exceeds collection limits');
      for (const child of node.items) visit(child, depth + 1);
    } else {
      if (!isScalar(node) || (node.value !== null && !['string', 'boolean', 'number'].includes(typeof node.value))) {
        failInvalid('unsupported YAML scalar value');
      }
      if (typeof node.value === 'string' && node.value.length > MAX_STRING) {
        failInvalid('YAML string exceeds length limits');
      }
      if (typeof node.value === 'number' && (!Number.isFinite(node.value) || Object.is(node.value, -0))) {
        failInvalid('YAML number out of bounds');
      }
    }
  }
  visit(document.contents, 1);
  return document.toJS({ maxAliasCount: 0 }) as PolicyJson;
}

/**
 * Parse a `DecisionPolicy` document (`loopwright.dev/v1alpha1` envelope or flat policy mapping)
 * from bounded YAML or JSON bytes and validate with `validateDecisionPolicy`.
 */
export function parseDecisionPolicyDocument(bytes: Uint8Array, format: 'yaml' | 'json'): DecisionPolicyConfig {
  if (bytes.byteLength > DECISION_POLICY_MAX_BYTES) {
    failInvalid(`decision policy exceeds ${DECISION_POLICY_MAX_BYTES} bytes`);
  }
  const source = decodePolicyText(bytes);
  const parsed = format === 'json' ? parsePolicyJsonSubset(source) : parsePolicyYamlDocument(source);
  if (!isPlainObject(parsed)) failInvalid('decision policy document must be a mapping');

  const isEnvelope = 'apiVersion' in parsed || 'kind' in parsed || 'spec' in parsed || 'metadata' in parsed;
  let policyInput: Record<string, unknown>;
  if (isEnvelope) {
    const allowedEnvelopeKeys = new Set(['apiVersion', 'kind', 'spec']);
    for (const key of Object.keys(parsed)) {
      if (!allowedEnvelopeKeys.has(key)) failInvalid(`unknown envelope field "${key}"`);
    }
    if (parsed['apiVersion'] !== DECISION_POLICY_DOCUMENT_API_VERSION) {
      failInvalid(`apiVersion must be ${DECISION_POLICY_DOCUMENT_API_VERSION}`);
    }
    if (parsed['kind'] !== 'DecisionPolicy') {
      failInvalid('kind must be DecisionPolicy');
    }
    if (!isPlainObject(parsed['spec'])) {
      failInvalid('DecisionPolicy envelope requires a spec mapping');
    }
    policyInput = parsed['spec'];
  } else {
    policyInput = parsed;
  }

  for (const key of Object.keys(policyInput)) {
    if (!ALLOWED_POLICY_KEYS.has(key)) {
      failInvalid(`unknown decision policy field "${key}"`);
    }
  }
  return validateDecisionPolicy(policyInput);
}

/**
 * Load a standalone `decisions.yaml` (`.yml` / `.json`) policy file using bounded `O_NOFOLLOW` non-symlink reads.
 */
export async function loadDecisionPolicyFile(filePath: string): Promise<DecisionPolicyConfig> {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.split(/[\\/]/).includes('..')) {
    failInvalid('decision policy path must be a non-empty path without .. traversal');
  }
  const full = resolve(filePath);
  const ext = extname(full).toLowerCase();
  if (ext !== '.yaml' && ext !== '.yml' && ext !== '.json') {
    failInvalid('decision policy file extension must be .yaml, .yml, or .json');
  }
  const before = await lstat(full).catch(() => null);
  if (before === null || before.isSymbolicLink() || !before.isFile()) {
    failInvalid('decision policy must be a regular non-symlink file');
  }
  if (before.size > DECISION_POLICY_MAX_BYTES) {
    failInvalid(`decision policy exceeds ${DECISION_POLICY_MAX_BYTES} bytes`);
  }
  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(full, constants.O_RDONLY | noFollow).catch(() => null);
  if (handle === null) failInvalid('decision policy file could not be opened');
  let bytes: Buffer;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size !== before.size || info.size > DECISION_POLICY_MAX_BYTES) {
      failInvalid('decision policy file changed size while loading or exceeds the byte limit');
    }
    const buf = Buffer.alloc(info.size + 1);
    let size = 0;
    while (size < buf.length) {
      const read = await handle.read(buf, size, buf.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size !== info.size) failInvalid('decision policy file changed while loading');
    bytes = buf.subarray(0, size);
  } finally {
    await handle.close();
  }
  return parseDecisionPolicyDocument(bytes, ext === '.json' ? 'json' : 'yaml');
}
