import { fail } from './diagnostics.js';
import { LIMITS } from './limits.js';

export function relativeName(value: string, path: string): string {
  if (!value.length || value.length > LIMITS.path) fail('PATH_INVALID', path);
  const segments = value.split('/');
  if (segments.length > LIMITS.segments) fail('PATH_INVALID', path);
  for (const segment of segments) {
    if (!/^[A-Za-z0-9._-]+$/.test(segment) || segment === '.' || segment === '..' || segment.endsWith('.')
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) fail('PATH_INVALID', path);
  }
  return value;
}
export function scopePattern(value: string, path: string): string {
  if (value === '**') return value;
  const literal = value.endsWith('/**') ? value.slice(0, -3) : value;
  if (/[*?{}[\]!]/.test(literal)) fail('PATTERN_UNSUPPORTED', path);
  relativeName(literal, path);
  if (value.length > LIMITS.path) fail('PATH_INVALID', path);
  return value;
}
export function matches(pattern: string, name: string): boolean {
  if (pattern === '**') return true;
  if (!pattern.endsWith('/**')) return pattern === name;
  const prefix = pattern.slice(0, -3);
  return name === prefix || name.startsWith(prefix + '/');
}
