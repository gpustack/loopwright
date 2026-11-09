import { refuse } from './errors.js';
import { DOCUMENT_BYTES } from './parser.js';
import type { Json } from './schema.js';
import type { TrustedRegistry } from './types.js';
export interface Part { readonly literal: string | null; readonly name: string | null }
export function template(value: string, path: string): readonly Part[] {
  const parts: Part[] = []; let literal = '';
  const flush = () => { if (literal) { parts.push({ literal, name: null }); literal = ''; } };
  for (let i = 0; i < value.length;) {
    if (value[i] !== '$') { literal += value[i++]; continue; }
    if (value[i + 1] === '$') { literal += '$'; i += 2; continue; }
    if (value[i + 1] !== '{') { literal += '$'; i++; continue; }
    const end = value.indexOf('}', i + 2); if (end < 0) refuse('CONFIG_ENV_SYNTAX', path);
    const name = value.slice(i + 2, end); if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) refuse('CONFIG_ENV_SYNTAX', path);
    flush(); parts.push({ literal: null, name }); i = end + 1;
  }
  flush(); return parts;
}
export function expand(parts: readonly Part[], lookup: (name: string) => string | undefined, path: string): string {
  let result = '';
  for (const part of parts) {
    const next = part.name === null ? part.literal! : lookup(part.name);
    if (next === undefined) refuse('CONFIG_ENV_MISSING', path);
    result += next; if (result.length > 16384) refuse('CONFIG_LIMIT', path);
  }
  return result;
}
export function interpolate(source: Json, registry: TrustedRegistry, lookup: (name: string) => string | undefined): Json {
  const authorized = new Map<string, readonly Part[]>();
  const walk = (value: Json, path: string, apply: boolean): Json => {
    if (typeof value === 'string') {
      const parts = apply ? authorized.get(path)! : template(value, path);
      if (!apply) {
        for (const part of parts) if (part.name !== null) {
          const binding = registry.spec.environmentBindings.find(item => item.name === part.name);
          const credentialPath = /^\/spec\/credentials\/(?:0|[1-9][0-9]*)\/template$/.test(path);
          if (!binding || !binding.paths.includes(path) || binding.classification === 'credential' && !credentialPath || binding.classification === 'nonsecret' && credentialPath) refuse('CONFIG_ENV_DENIED', path);
        }
        authorized.set(path, parts); return value;
      }
      return expand(parts, lookup, path);
    }
    if (Array.isArray(value)) return value.map((item, index) => walk(item, path + '/' + index, apply));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item, path + '/' + key.replace(/~/g, '~0').replace(/\//g, '~1'), apply)]));
    return value;
  };
  walk(source, '', false); const expanded = walk(source, '', true);
  if (Buffer.byteLength(JSON.stringify(expanded)) > DOCUMENT_BYTES) refuse('CONFIG_LIMIT'); return expanded;
}
