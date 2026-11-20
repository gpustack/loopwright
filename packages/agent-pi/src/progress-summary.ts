import { object } from './boundary.js';
import { parseBoundedJson } from './context.js';

const SUMMARY_MAX_CHARS = 80;
const FILE_SUMMARY_TOOLS = new Set(['read', 'write', 'edit', 'delete']);
const SAFE_MCP_SUMMARY_KEYS = ['owner', 'repo', 'repoName', 'branch', 'ref', 'issue_number', 'pull_number', 'number', 'id', 'name', 'query', 'question'] as const;
const BASH_LEADING_ENV_ASSIGN_RE = /^(?:(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=(?:"(?:\\.|[^"\\])*"|'(?:[^']*)'|(?:\\.|[^\s\\])*))(?:\s+|$)/;
const CREDENTIAL_HEADER_RE = /((?:authorization|x-api-key|x-auth-token|api-key|token)\s*:\s*)(?:Bearer\s+[^\s"']+|[^\s"']+)/gi;
const BEARER_TOKEN_RE = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{4,}/gi;
const URL_USERINFO_RE = /(:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/g;
const QUERY_SECRET_RE = /([?&](?:access_)?(?:token|api_key|key|secret|password)=)[^\s&#"']+/gi;
const TOKEN_SHAPE_RE = /\b(?:gh[pousr]_[A-Za-z0-9_]{6,}|github_pat_[A-Za-z0-9_]{6,}|sk-[A-Za-z0-9_-]{6,}|sk_[A-Za-z0-9_-]{6,}|xox[baprs]-[A-Za-z0-9-]{6,})\b/g;
const INLINE_ENV_ASSIGN_RE = /(^|\s)(export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(?:"(?:\\.|[^"\\])*"|'(?:[^']*)'|(?:\\.|[^\s\\;])+)/g;
const CLI_SECRET_FLAG_RE = /(\s(?:--password|--token|--api-key|--secret)\s+)(?:"(?:\\.|[^"\\])*"|'(?:[^']*)'|(?:\\.|[^\s\\])+)/gi;

function redactInlineSecrets(raw: string, redactEnvAssigns: boolean): string {
  let out = raw
    .replace(CREDENTIAL_HEADER_RE, '$1[scrubbed]')
    .replace(BEARER_TOKEN_RE, '$1[scrubbed]')
    .replace(URL_USERINFO_RE, '$1[scrubbed]@')
    .replace(QUERY_SECRET_RE, '$1[scrubbed]')
    .replace(TOKEN_SHAPE_RE, '[scrubbed]');
  if (redactEnvAssigns) {
    out = out
      .replace(INLINE_ENV_ASSIGN_RE, '$1$2$3=[scrubbed]')
      .replace(CLI_SECRET_FLAG_RE, '$1[scrubbed]');
  }
  return out;
}

function sanitizeSingleLineSummary(
  raw: string,
  scrub?: (text: string) => string,
  redactEnvAssigns = false,
  maxChars = SUMMARY_MAX_CHARS,
): string | undefined {
  let redacted = redactInlineSecrets(raw, redactEnvAssigns);
  if (scrub) {
    try {
      redacted = scrub(redacted);
    } catch {
      return undefined;
    }
  }
  let normalized = '';
  for (const ch of redacted) {
    const code = ch.codePointAt(0) ?? 0;
    normalized += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  const cleaned = normalized.replace(/\s+/g, ' ').trim();
  if (!cleaned) return undefined;
  const chars = Array.from(cleaned);
  if (chars.length <= maxChars) return cleaned;
  return chars.slice(0, Math.max(1, maxChars - 3)).join('') + '...';
}

export function summarizeToolProgressArgs(
  toolName: string,
  bytes: Uint8Array,
  maxBytes = 65536,
  normalizePath?: (raw: string) => string | null,
  scrub?: (text: string) => string,
): string | undefined {
  if (bytes.byteLength > maxBytes) return undefined;
  let args: Record<string, unknown>;
  try {
    const parsed = parseBoundedJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), { nodes: 262144, array: 4096, properties: 512 });
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    args = object(parsed, Object.keys(parsed));
  } catch {
    return undefined;
  }

  if (FILE_SUMMARY_TOOLS.has(toolName)) {
    if (typeof args.path !== 'string' || !args.path.trim()) return undefined;
    let resolved = args.path;
    if (normalizePath) {
      try {
        const normalized = normalizePath(args.path);
        if (normalized && normalized.trim().length > 0) resolved = normalized;
      } catch {
        // Fall back to sanitized raw path on invalid/denied target paths.
      }
    }
    return sanitizeSingleLineSummary(resolved, scrub);
  }

  if (toolName === 'bash') {
    if (typeof args.command !== 'string') return undefined;
    const firstLine = args.command.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0);
    if (!firstLine) return undefined;
    let stripped = firstLine;
    while (BASH_LEADING_ENV_ASSIGN_RE.test(stripped)) {
      stripped = stripped.replace(BASH_LEADING_ENV_ASSIGN_RE, '');
    }
    stripped = stripped.trim();
    if (!stripped) return undefined;
    return sanitizeSingleLineSummary(stripped, scrub, true);
  }

  if (typeof args.path === 'string' && args.path.trim().length > 0) {
    return sanitizeSingleLineSummary(args.path, scrub);
  }
  const parts: string[] = [];
  for (const key of SAFE_MCP_SUMMARY_KEYS) {
    if (!Object.hasOwn(args, key)) continue;
    const val = args[key];
    if (typeof val === 'string' && val.trim().length > 0) {
      const safeVal = redactInlineSecrets(val, true);
      parts.push(parts.length === 0 && (key === 'query' || key === 'question' || key === 'repoName') ? safeVal : `${key}=${safeVal}`);
    } else if (typeof val === 'number' && Number.isFinite(val)) {
      parts.push(`${key}=${String(val)}`);
    } else if (typeof val === 'boolean') {
      parts.push(`${key}=${String(val)}`);
    }
    if (parts.length >= 2) break;
  }
  if (parts.length === 0) return undefined;
  return sanitizeSingleLineSummary(parts.join(' '), scrub);
}
