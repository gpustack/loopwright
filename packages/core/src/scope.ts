import { snapshot } from './boundary.js';
import { attempt, fail, type Result } from './diagnostics.js';
import { LIMITS } from './limits.js';

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function validSegmentBase(segment: string): boolean {
  return segment.length > 0 && segment !== '.' && segment !== '..'
    && !segment.endsWith('.') && !WINDOWS_RESERVED.test(segment);
}

export function relativeName(value: string, path: string): string {
  if (!value.length || value.length > LIMITS.path) fail('PATH_INVALID', path);
  const segments = value.split('/');
  if (segments.length > LIMITS.segments) fail('PATH_INVALID', path);
  for (const segment of segments) {
    if (!validSegmentBase(segment) || !/^[A-Za-z0-9._-]+$/.test(segment)) fail('PATH_INVALID', path);
  }
  return value;
}

export function scopePattern(value: string, path: string): string {
  if (!value.length || value.length > LIMITS.path) fail('PATH_INVALID', path);
  if (value === '**') return value;
  const recursive = value.endsWith('/**');
  const body = recursive ? value.slice(0, -3) : value;
  if (!body.length) fail('PATH_INVALID', path);
  if (/[{}[\]!]/.test(body) || body.includes('**')) fail('PATTERN_UNSUPPORTED', path);
  const segments = body.split('/');
  if (segments.length > LIMITS.segments) fail('PATH_INVALID', path);
  let wildcards = 0;
  for (const segment of segments) {
    if (!validSegmentBase(segment) || !/^[A-Za-z0-9._*?-]+$/.test(segment)) fail('PATH_INVALID', path);
    for (let index = 0; index < segment.length; index++) {
      const char = segment[index];
      if (char === '*' || char === '?') wildcards++;
    }
    if (wildcards > LIMITS.patternWildcards) fail('PATTERN_UNSUPPORTED', path);
  }
  return value;
}

// Linear-space, non-exponential single-segment '*'/'?' matcher (never crosses '/').
function matchSegment(pattern: string, text: string): boolean {
  let pi = 0;
  let ti = 0;
  let starPi = -1;
  let starTi = 0;
  while (ti < text.length) {
    if (pi < pattern.length && (pattern[pi] === '?' || pattern[pi] === text[ti])) {
      pi++;
      ti++;
    } else if (pi < pattern.length && pattern[pi] === '*') {
      starPi = pi++;
      starTi = ti;
    } else if (starPi !== -1) {
      pi = starPi + 1;
      ti = ++starTi;
    } else {
      return false;
    }
  }
  while (pi < pattern.length && pattern[pi] === '*') pi++;
  return pi === pattern.length;
}

export function matches(pattern: string, name: string): boolean {
  if (pattern === '**') return true;
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    if (!prefix.includes('*') && !prefix.includes('?')) {
      return name === prefix || name.startsWith(prefix + '/');
    }
    const patternSegments = prefix.split('/');
    const nameSegments = name.split('/');
    if (nameSegments.length < patternSegments.length) return false;
    return patternSegments.every((segment, index) => matchSegment(segment, nameSegments[index]!));
  }
  if (!pattern.includes('*') && !pattern.includes('?')) return pattern === name;
  const patternSegments = pattern.split('/');
  const nameSegments = name.split('/');
  if (nameSegments.length !== patternSegments.length) return false;
  return patternSegments.every((segment, index) => matchSegment(segment, nameSegments[index]!));
}

function ownedString(input: unknown, path: string): string {
  const boxed = snapshot({ value: input });
  const raw = (boxed as Record<string, unknown>).value;
  if (typeof raw !== 'string') fail('VALUE_TYPE', path);
  if (raw.length < 1 || raw.length > LIMITS.path) fail('VALUE_RANGE', path);
  return raw;
}

export function validateRelativePath(path: unknown): Result<string> {
  return attempt(() => relativeName(ownedString(path, '/path'), '/path'));
}

export function validateScopePattern(pattern: unknown): Result<string> {
  return attempt(() => scopePattern(ownedString(pattern, '/pattern'), '/pattern'));
}

export function matchesScopePattern(pattern: unknown, path: unknown): Result<boolean> {
  return attempt(() => {
    const validPattern = scopePattern(ownedString(pattern, '/pattern'), '/pattern');
    const validPath = relativeName(ownedString(path, '/path'), '/path');
    return matches(validPattern, validPath);
  });
}
