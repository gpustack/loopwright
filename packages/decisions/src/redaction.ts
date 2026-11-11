import {
  DECISION_IMAGE_MEDIA_TYPES, DECISION_MAX_IMAGES, DECISION_MAX_IMAGE_BASE64_CHARS, DECISION_MAX_PUBLIC_METADATA_CHARS,
  DECISION_MAX_STATE_BYTES, DECISION_MAX_STATE_DEPTH,
} from './types.js';
import { DecisionError } from './types.js';
import { isPlainObject } from './schema.js';
import type { DecisionImageAsset, DecisionPolicyConfig } from './types.js';

/**
 * Structural scrubber contract (coordinator ruling REVIEW-001): any object exposing `scrub` plus an
 * optional `containsSecret` interoperates, so both `@loopwright/core` and GitHub App scrubbers work.
 * Without `containsSecret`, a value counts as secret material when `scrub` would change it.
 */
export interface DecisionScrubber {
  scrub(value: string): string;
  containsSecret?(value: string): boolean;
}

const PROTOTYPE_POLLUTION_KEYS: readonly string[] = Object.freeze(['__proto__', 'constructor', 'prototype']);

const FORBIDDEN_CONTENT_KEYS: readonly string[] = Object.freeze([
  'rawFileContent', 'fileBody', 'fullTranscript', 'rawTranscript', 'envDump', 'processEnv',
  'privateKey', 'secret', 'token', 'authorization', 'cookie',
]);

const FORBIDDEN_METADATA_KEYS: readonly string[] = Object.freeze(['diffPatch', 'rawDiff', 'patchBody', 'stdout', 'stderr']);

const SECRET_VALUE_PATTERNS: readonly RegExp[] = Object.freeze([
  /TYPESAFE_API_KEY/,
  /ghs_[A-Za-z0-9]{20,}/,
  /ghu_[A-Za-z0-9]{20,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /github_app_[A-Za-z0-9_]{16,}/,
  /Bearer /,
  /-----BEGIN /,
  /AWS_SECRET_ACCESS_KEY/,
  /OPENAI_API_KEY/,
  /ANTHROPIC_API_KEY/,
  /STARTLUX_API_KEY/,
  /PERPLEXITY_API_KEY/,
  /CLOUDFLARE_API_TOKEN/,
  /LIQUID_API_KEY/,
  /AZURE_API_KEY/,
  /MICROSOFT_DECISION_API_KEY/,
  /\$\{[^}]{0,256}\}/,
]);

function failDisclosure(detail: string): never {
  throw new DecisionError('DECISION_DISCLOSURE_VIOLATION', detail);
}

function failSchema(detail: string): never {
  throw new DecisionError('DECISION_SCHEMA_INVALID', detail);
}

/**
 * Validate image assets for multimodal decisions (REVIEW-003): only usable when the policy enables
 * `allowImages` under `repo-approved-redacted-evidence` disclosure; anything else is a disclosure
 * violation. Enforces bounded base64 payloads and the fixed media-type allowlist.
 */
export function validateDecisionImages(images: readonly DecisionImageAsset[] | undefined, policy: DecisionPolicyConfig): readonly DecisionImageAsset[] {
  if (images === undefined) return [];
  if (!policy.allowImages || policy.disclosurePolicy !== 'repo-approved-redacted-evidence') {
    failDisclosure('image assets require policy.allowImages === true under the repo-approved-redacted-evidence disclosure policy');
  }
  if (images.length > DECISION_MAX_IMAGES) failDisclosure(`image batch exceeds the ${DECISION_MAX_IMAGES}-asset cap`);
  const seen = new Set<string>();
  return Object.freeze(images.map(asset => {
    if (typeof asset?.id !== 'string' || asset.id.trim().length === 0 || asset.id.length > 128) {
      failDisclosure('image asset id must be a non-empty string of at most 128 characters');
    }
    if (seen.has(asset.id)) failDisclosure(`image asset id ${asset.id} is duplicated`);
    seen.add(asset.id);
    if (!DECISION_IMAGE_MEDIA_TYPES.includes(asset.mediaType)) failDisclosure(`image asset ${asset.id} mediaType is not in the png/jpeg/webp allowlist`);
    if (typeof asset.data !== 'string' || asset.data.length === 0 || asset.data.length > DECISION_MAX_IMAGE_BASE64_CHARS) {
      failDisclosure(`image asset ${asset.id} data exceeds the ${DECISION_MAX_IMAGE_BASE64_CHARS}-character base64 cap`);
    }
    return Object.freeze({ id: asset.id, mediaType: asset.mediaType, data: asset.data });
  }));
}

function stringIsSecret(value: string, scrubber: DecisionScrubber | undefined): boolean {
  if (SECRET_VALUE_PATTERNS.some(pattern => pattern.test(value))) return true;
  if (scrubber === undefined) return false;
  if (typeof scrubber.containsSecret === 'function') return scrubber.containsSecret(value);
  return scrubber.scrub(value) !== value;
}

function walk(value: unknown, path: string, depth: number, policy: DecisionPolicyConfig, scrubber: DecisionScrubber | undefined, ancestors: Set<object>): void {
  if (typeof value === 'string') {
    if (policy.disclosurePolicy === 'public-metadata-only' && value.length > DECISION_MAX_PUBLIC_METADATA_CHARS) {
      failDisclosure(`string value at ${path} exceeds the ${DECISION_MAX_PUBLIC_METADATA_CHARS}-character public-metadata cap`);
    }
    if (stringIsSecret(value, scrubber)) failDisclosure(`secret-shaped value at ${path} must never reach the decision API`);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) failSchema(`state value at ${path} is not a finite number`);
    return;
  }
  if (typeof value === 'boolean' || value === null) return;
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol' || value === undefined) {
    failSchema(`state value at ${path} is not JSON-representable (${typeof value})`);
  }
  if (depth > DECISION_MAX_STATE_DEPTH) {
    failSchema(`state nesting at ${path} exceeds the ${DECISION_MAX_STATE_DEPTH}-level depth cap`);
  }
  if (typeof value === 'object') {
    if (ancestors.has(value)) failSchema(`state contains a circular reference at ${path}`);
    if (!isPlainObject(value) && !Array.isArray(value)) {
      failSchema(`state value at ${path} must be a plain object or array`);
    }
    ancestors.add(value);
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${path}[${index}]`, depth + 1, policy, scrubber, ancestors));
    } else {
      for (const key of Object.keys(value)) {
        if (PROTOTYPE_POLLUTION_KEYS.includes(key)) {
          failDisclosure(`prototype-pollution key "${key}" at ${path}`);
        }
        if (FORBIDDEN_CONTENT_KEYS.includes(key)) {
          failDisclosure(`forbidden raw-content key "${key}" at ${path}`);
        }
        if (policy.disclosurePolicy === 'public-metadata-only' && FORBIDDEN_METADATA_KEYS.includes(key)) {
          failDisclosure(`key "${key}" at ${path} carries raw evidence denied under the public-metadata-only policy`);
        }
        walk(value[key], `${path}.${key}`, depth + 1, policy, scrubber, ancestors);
      }
    }
    ancestors.delete(value);
    return;
  }
  failSchema(`state value at ${path} is not JSON-representable`);
}

/**
 * Validate a decision `state` payload before any transport call (AC-1.3): plain-object roots only, JSON-safe
 * values, depth and byte-size caps, prototype-pollution and forbidden raw-content key refusal, secret-pattern
 * and scrubber-registered secret refusal, plus the stricter `public-metadata-only` denials. Returns the
 * serialized state body ready for the transport request.
 */
export function sanitizeDecisionState(state: unknown, policy: DecisionPolicyConfig, scrubber?: DecisionScrubber): string {
  if (!isPlainObject(state)) failSchema('state root must be a plain JSON object');
  walk(state, '$', 1, policy, scrubber, new Set());
  let body: string;
  try {
    body = JSON.stringify(state);
  } catch {
    failSchema('state is not JSON-serializable');
  }
  if (Buffer.byteLength(body, 'utf8') > DECISION_MAX_STATE_BYTES) {
    throw new DecisionError('DECISION_STATE_TOO_LARGE', `serialized state exceeds the ${DECISION_MAX_STATE_BYTES}-byte cap`);
  }
  return body;
}
