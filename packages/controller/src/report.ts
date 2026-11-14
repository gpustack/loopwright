import type { UsageSummary } from '@loopwright/core';

export const REPORT_OUTPUT_FORMATS = Object.freeze(['json', 'github-step-summary', 'markdown', 'text'] as const);
export type ReportOutputFormat = (typeof REPORT_OUTPUT_FORMATS)[number];

export interface SanitizeReportTextOptions {
  readonly scrub?: ((text: string) => string) | undefined;
  readonly singleLine?: boolean | undefined;
}

export interface ReportCheckItem {
  readonly checkId: string;
  readonly status: string;
  readonly code?: string | null | undefined;
  readonly detail?: string | null | undefined;
}

export interface ReportDiscoveryInfo {
  readonly disposition: string;
  readonly updatesCount?: number | undefined;
  readonly summary?: string | null | undefined;
}

export interface ReportModelInfo {
  readonly provider: string;
  readonly model: string;
  readonly thinking?: string | null | undefined;
  readonly contextWindow?: number | undefined;
  readonly tokenRotations?: number | undefined;
}

export interface ReportMcpServerInfo {
  readonly id: string;
  readonly transport: 'stdio' | 'http';
  readonly status: 'connected' | 'failed';
  readonly toolCount: number;
  readonly error?: string | null | undefined;
}

export interface RunReportInput {
  readonly runId: string;
  readonly status: string;
  readonly reasonCode?: string | null | undefined;
  readonly phase?: string | null | undefined;
  readonly detail?: string | null | undefined;
  readonly discovery?: ReportDiscoveryInfo | null | undefined;
  readonly checks?: readonly ReportCheckItem[] | undefined;
  readonly model?: ReportModelInfo | null | undefined;
  readonly mcpServers?: readonly ReportMcpServerInfo[] | undefined;
  readonly usage?: UsageSummary | null | undefined;
  readonly elapsedMs?: number | null | undefined;
  readonly externalUrl?: string | null | undefined;
  readonly scrub?: ((text: string) => string) | undefined;
}

/** Parse a single format, comma-separated list, or array of output format names, preserving order without duplicates. */
export function parseReportOutputFormats(
  raw: string | readonly string[] | undefined,
  defaultFormats: readonly ReportOutputFormat[] = [],
): readonly ReportOutputFormat[] {
  if (raw === undefined) return Object.freeze([...defaultFormats]);
  const tokens: string[] = [];
  if (typeof raw === 'string') {
    if (raw.trim().length === 0) {
      throw new Error(`Output format must not be empty; expected one or more of: ${REPORT_OUTPUT_FORMATS.join(', ')}`);
    }
    for (const part of raw.split(',')) tokens.push(part.trim());
  } else if (Array.isArray(raw)) {
    if (raw.length === 0) {
      throw new Error(`Output format must not be empty; expected one or more of: ${REPORT_OUTPUT_FORMATS.join(', ')}`);
    }
    for (const item of raw) {
      if (typeof item !== 'string' || item.trim().length === 0) {
        throw new Error(`Output format must not contain empty values; expected one or more of: ${REPORT_OUTPUT_FORMATS.join(', ')}`);
      }
      for (const part of item.split(',')) tokens.push(part.trim());
    }
  } else {
    throw new Error(`Invalid output format specification; expected string or string array`);
  }

  const seen = new Set<ReportOutputFormat>();
  const result: ReportOutputFormat[] = [];
  for (const token of tokens) {
    if (token.length === 0) {
      throw new Error(`Output format must not contain empty tokens; expected one or more of: ${REPORT_OUTPUT_FORMATS.join(', ')}`);
    }
    if (!REPORT_OUTPUT_FORMATS.includes(token as ReportOutputFormat)) {
      throw new Error(`Unsupported output format "${token}"; expected one of: ${REPORT_OUTPUT_FORMATS.join(', ')}`);
    }
    const format = token as ReportOutputFormat;
    if (!seen.has(format)) {
      seen.add(format);
      result.push(format);
    }
  }
  return Object.freeze(result);
}

/** Format non-negative integer micro-USD (10^-6 USD) as a deterministic 6-decimal USD string. */
export function formatCostUsd(costMicrousd: number): string {
  if (!Number.isSafeInteger(costMicrousd) || costMicrousd < 0) {
    throw new RangeError(`costMicrousd must be a non-negative safe integer, got ${String(costMicrousd)}`);
  }
  const whole = Math.floor(costMicrousd / 1_000_000);
  const frac = String(costMicrousd % 1_000_000).padStart(6, '0');
  return `${whole}.${frac}`;
}

function trimFixed(value: number, decimals: number): string {
  const fixed = value.toFixed(decimals);
  if (!fixed.includes('.')) return fixed;
  return fixed.replace(/\.?0+$/, '');
}

/** Format a non-negative token count using K / M / B units (e.g. 850, 1.25K, 14.2K, 1.28M, 2.1B). */
export function formatTokenCount(count: number): string {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RangeError(`count must be a non-negative safe integer, got ${String(count)}`);
  }
  if (count < 1_000) return String(count);
  if (count < 1_000_000) {
    const scaled = Math.round((count / 1_000) * 100) / 100;
    if (scaled >= 1_000) return '1M';
    return `${trimFixed(scaled, 2)}K`;
  }
  if (count < 1_000_000_000) {
    const scaled = Math.round((count / 1_000_000) * 100) / 100;
    if (scaled >= 1_000) return '1B';
    return `${trimFixed(scaled, 2)}M`;
  }
  return `${trimFixed(count / 1_000_000_000, 2)}B`;
}

/** Format a non-negative duration in milliseconds using ms / s / m / h units (e.g. 420ms, 8.4s, 2m 28s, 1h 12m). */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new RangeError(`ms must be a non-negative finite number, got ${String(ms)}`);
  }
  if (ms < 1_000) {
    const rounded = Math.round(ms);
    return rounded >= 1_000 ? '1s' : `${rounded}ms`;
  }
  if (ms < 60_000) {
    const tenths = Math.round(ms / 100);
    if (tenths >= 600) return '1m';
    return `${trimFixed(tenths / 10, 1)}s`;
  }
  const totalSeconds = Math.round(ms / 1_000);
  if (totalSeconds < 3_600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** Format a non-negative byte count using B / KB / MB / GB units (e.g. 512 B, 64 KB, 1.5 MB, 2 GB). */
export function formatByteCount(bytes: number): string {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new RangeError(`bytes must be a non-negative safe integer, got ${String(bytes)}`);
  }
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) {
    const kb = Math.round((bytes / 1_024) * 10) / 10;
    if (kb >= 1_024) return '1 MB';
    return `${trimFixed(kb, 1)} KB`;
  }
  if (bytes < 1_073_741_824) {
    const mb = Math.round((bytes / 1_048_576) * 10) / 10;
    if (mb >= 1_024) return '1 GB';
    return `${trimFixed(mb, 1)} MB`;
  }
  return `${trimFixed(bytes / 1_073_741_824, 2)} GB`;
}

function stripAnsiAndControl(input: string): string {
  const normalized = input.replace(/\r\n?/g, '\n');
  let result = '';
  let index = 0;
  while (index < normalized.length) {
    const code = normalized.charCodeAt(index);
    if (code === 0x1b) {
      const next = normalized.charCodeAt(index + 1);
      if (next === 0x5b) {
        let cursor = index + 2;
        while (cursor < normalized.length && normalized.charCodeAt(cursor) >= 0x30 && normalized.charCodeAt(cursor) <= 0x3f) cursor++;
        while (cursor < normalized.length && normalized.charCodeAt(cursor) >= 0x20 && normalized.charCodeAt(cursor) <= 0x2f) cursor++;
        if (cursor < normalized.length && normalized.charCodeAt(cursor) >= 0x40 && normalized.charCodeAt(cursor) <= 0x7e) {
          index = cursor + 1;
          continue;
        }
      } else if (next === 0x5d) {
        let cursor = index + 2;
        let terminated = false;
        while (cursor < normalized.length) {
          const current = normalized.charCodeAt(cursor);
          if (current === 0x07) {
            index = cursor + 1;
            terminated = true;
            break;
          }
          if (current === 0x1b && normalized.charCodeAt(cursor + 1) === 0x5c) {
            index = cursor + 2;
            terminated = true;
            break;
          }
          cursor++;
        }
        if (terminated) continue;
      } else if ((next >= 0x40 && next <= 0x5a) || (next >= 0x5c && next <= 0x5f)) {
        index += 2;
        continue;
      }
      index++;
      continue;
    }
    if (
      code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f) ||
      (code >= 0x7f && code <= 0x9f)
    ) {
      index++;
      continue;
    }
    result += normalized[index];
    index++;
  }
  return result;
}

/** Scrub secrets, strip ANSI/control bytes, and neutralize GitHub workflow commands in untrusted report text. */
export function sanitizeReportText(value: string, options?: SanitizeReportTextOptions): string {
  const scrub = options?.scrub;
  const preScrubbed = scrub ? scrub(value) : value;
  const stripped = stripAnsiAndControl(preScrubbed);
  const postScrubbed = scrub ? scrub(stripped) : stripped;
  const neutralized = postScrubbed.replace(/:(?=:)/g, ': ').replace(/##\[/g, '# #[');
  if (options?.singleLine) {
    return neutralized.replace(/[\t\n]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  }
  return neutralized;
}

function formatDiscoverySummary(discovery: ReportDiscoveryInfo, clean: (text: string) => string): string {
  const parts = [clean(discovery.disposition)];
  if (discovery.updatesCount !== undefined) parts.push(`(${discovery.updatesCount} updates)`);
  if (discovery.summary != null && discovery.summary.length > 0) parts.push(`- ${clean(discovery.summary)}`);
  return parts.join(' ');
}

function formatModelSummary(model: ReportModelInfo, clean: (text: string) => string): string {
  let summary = `${clean(model.provider)}/${clean(model.model)}`;
  const attrs: string[] = [];
  if (model.thinking != null && model.thinking.length > 0) attrs.push(`thinking: ${clean(model.thinking)}`);
  if (model.contextWindow !== undefined && Number.isSafeInteger(model.contextWindow) && model.contextWindow >= 0) {
    attrs.push(`contextWindow=${formatTokenCount(model.contextWindow)}`);
  }
  if (attrs.length > 0) summary += ` (${attrs.join(', ')})`;
  if (model.tokenRotations !== undefined) summary += ` [rotations: ${model.tokenRotations}]`;
  return summary;
}

function formatMcpServersSummary(servers: readonly ReportMcpServerInfo[], clean: (text: string) => string): string {
  return servers
    .map(server => {
      if (server.status === 'connected') {
        return `${clean(server.id)} (${clean(server.transport)}, ${server.toolCount} tools)`;
      }
      const errSuffix = server.error != null && server.error.length > 0 ? `: ${clean(server.error)}` : '';
      return `${clean(server.id)} (${clean(server.transport)}, failed${errSuffix})`;
    })
    .join('; ');
}

/** Render a sanitized, deterministic run report in JSON, Markdown/Step Summary, or plain text format. */
export function formatRunReport(input: RunReportInput, format: ReportOutputFormat): string {
  const usage = input.usage ?? null;
  const hasKnownCost = usage != null && (usage.costMicrousd.provenance === 'reported' || usage.costMicrousd.provenance === 'estimated');
  const costUsd = hasKnownCost ? formatCostUsd(usage.costMicrousd.knownSubtotal) : null;

  if (format === 'json') {
    const clean = (text: string): string => sanitizeReportText(text, { scrub: input.scrub });
    const payload = {
      runId: clean(input.runId),
      status: clean(input.status),
      reasonCode: input.reasonCode != null ? clean(input.reasonCode) : null,
      phase: input.phase != null ? clean(input.phase) : null,
      ...(input.detail !== undefined ? { detail: input.detail != null ? clean(input.detail) : null } : {}),
      discovery: input.discovery
        ? {
            disposition: clean(input.discovery.disposition),
            ...(input.discovery.updatesCount !== undefined ? { updatesCount: input.discovery.updatesCount } : {}),
            summary: input.discovery.summary != null ? clean(input.discovery.summary) : null,
          }
        : null,
      checks: (input.checks ?? []).map(check => ({
        checkId: clean(check.checkId),
        status: clean(check.status),
        code: check.code != null ? clean(check.code) : null,
        detail: check.detail != null ? clean(check.detail) : null,
      })),
      model: input.model
        ? {
            provider: clean(input.model.provider),
            model: clean(input.model.model),
            thinking: input.model.thinking != null ? clean(input.model.thinking) : null,
            ...(input.model.contextWindow !== undefined && Number.isSafeInteger(input.model.contextWindow) && input.model.contextWindow >= 0
              ? {
                  contextWindow: input.model.contextWindow,
                  formattedContextWindow: formatTokenCount(input.model.contextWindow),
                }
              : {}),
            ...(input.model.tokenRotations !== undefined ? { tokenRotations: input.model.tokenRotations } : {}),
          }
        : null,
      ...(input.mcpServers !== undefined
        ? {
            mcpServers: input.mcpServers.map(server => ({
              id: clean(server.id),
              transport: clean(server.transport),
              status: clean(server.status),
              toolCount: server.toolCount,
              error: server.error != null ? clean(server.error) : null,
            })),
          }
        : {}),
      usage: usage
        ? {
            requestCount: usage.requests.length,
            inputTokens: usage.inputTokens.knownSubtotal,
            outputTokens: usage.outputTokens.knownSubtotal,
            totalTokens: usage.totalTokens.knownSubtotal,
            formattedInputTokens: formatTokenCount(usage.inputTokens.knownSubtotal),
            formattedOutputTokens: formatTokenCount(usage.outputTokens.knownSubtotal),
            formattedTotalTokens: formatTokenCount(usage.totalTokens.knownSubtotal),
            tokenProvenance: usage.totalTokens.provenance,
            tokenCompleteness: usage.totalTokens.completeness,
            tokenUnknownCount: usage.totalTokens.unknownCount,
            costMicrousd: hasKnownCost ? usage.costMicrousd.knownSubtotal : null,
            costUsd,
            costProvenance: usage.costMicrousd.provenance,
            costCompleteness: usage.costMicrousd.completeness,
            costUnknownCount: usage.costMicrousd.unknownCount,
          }
        : null,
      elapsedMs: input.elapsedMs ?? null,
      formattedElapsed: input.elapsedMs != null ? formatDurationMs(input.elapsedMs) : null,
      externalUrl: input.externalUrl != null ? clean(input.externalUrl) : null,
    };
    return JSON.stringify(payload);
  }

  const cleanLine = (text: string): string => sanitizeReportText(text, { scrub: input.scrub, singleLine: true });

  if (format === 'github-step-summary' || format === 'markdown') {
    const cell = (text: string): string =>
      cleanLine(text)
        .replace(/\|/g, '\\|')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\[/g, '\\[');
    const lines: string[] = [
      '## Loopwright Run Report',
      '',
      '| Field | Value |',
      '| --- | --- |',
      `| Run ID | ${cell(input.runId)} |`,
      `| Status | ${cell(input.status)} |`,
    ];
    if (input.reasonCode != null && input.reasonCode.length > 0) lines.push(`| Reason | ${cell(input.reasonCode)} |`);
    if (input.phase != null && input.phase.length > 0) lines.push(`| Phase | ${cell(input.phase)} |`);
    if (input.detail != null && input.detail.length > 0) lines.push(`| Detail | ${cell(input.detail)} |`);
    if (input.discovery) lines.push(`| Discovery | ${formatDiscoverySummary(input.discovery, cell)} |`);
    if (input.model) lines.push(`| Model | ${formatModelSummary(input.model, cell)} |`);
    if (input.mcpServers && input.mcpServers.length > 0) {
      lines.push(`| MCP Servers | ${formatMcpServersSummary(input.mcpServers, cell)} |`);
    }
    if (usage != null) {
      const tokenPrefix = usage.totalTokens.completeness === 'partial' ? '>= ' : '';
      const tokenSuffix =
        usage.totalTokens.completeness === 'partial' ? `, partial: ${usage.totalTokens.unknownCount} unknown` : '';
      lines.push(
        `| Tokens | ${tokenPrefix}${formatTokenCount(usage.totalTokens.knownSubtotal)} total (${formatTokenCount(usage.inputTokens.knownSubtotal)} in / ${formatTokenCount(usage.outputTokens.knownSubtotal)} out, ${usage.totalTokens.provenance}${tokenSuffix}) |`,
      );
    } else {
      lines.push('| Tokens | unavailable |');
    }
    if (hasKnownCost && costUsd !== null) {
      const costPrefix = usage.costMicrousd.completeness === 'partial' ? '>= ' : '';
      const costSuffix =
        usage.costMicrousd.completeness === 'partial' ? `, partial: ${usage.costMicrousd.unknownCount} unknown` : '';
      lines.push(`| Cost (USD) | ${costPrefix}$${costUsd} (${usage.costMicrousd.provenance}${costSuffix}) |`);
    }
    if (input.elapsedMs != null) lines.push(`| Elapsed | ${formatDurationMs(input.elapsedMs)} |`);
    if (input.externalUrl != null && input.externalUrl.length > 0) lines.push(`| External URL | ${cell(input.externalUrl)} |`);

    if (input.checks && input.checks.length > 0) {
      lines.push('', '### Verification Checks', '', '| Check ID | Status | Code | Detail |', '| --- | --- | --- | --- |');
      for (const check of input.checks) {
        const codeCell = check.code != null && check.code.length > 0 ? cell(check.code) : '-';
        const detailCell = check.detail != null && check.detail.length > 0 ? cell(check.detail) : '-';
        lines.push(`| ${cell(check.checkId)} | ${cell(check.status)} | ${codeCell} | ${detailCell} |`);
      }
    }
    return lines.join('\n');
  }

  if (format === 'text') {
    const lines: string[] = [`Run ID: ${cleanLine(input.runId)}`];
    const statusAnnotations: string[] = [];
    if (input.reasonCode != null && input.reasonCode.length > 0) statusAnnotations.push(`reason=${cleanLine(input.reasonCode)}`);
    if (input.phase != null && input.phase.length > 0) statusAnnotations.push(`phase=${cleanLine(input.phase)}`);
    lines.push(statusAnnotations.length > 0 ? `Status: ${cleanLine(input.status)} (${statusAnnotations.join(', ')})` : `Status: ${cleanLine(input.status)}`);
    if (input.detail != null && input.detail.length > 0) lines.push(`Detail: ${cleanLine(input.detail)}`);
    if (input.discovery) lines.push(`Discovery: ${formatDiscoverySummary(input.discovery, cleanLine)}`);
    if (input.model) lines.push(`Model: ${formatModelSummary(input.model, cleanLine)}`);
    if (input.mcpServers && input.mcpServers.length > 0) {
      lines.push(`MCP Servers: ${formatMcpServersSummary(input.mcpServers, cleanLine)}`);
    }
    if (usage != null) {
      const tokenPrefix = usage.totalTokens.completeness === 'partial' ? '>= ' : '';
      const tokenSuffix =
        usage.totalTokens.completeness === 'partial' ? `, partial: ${usage.totalTokens.unknownCount} unknown` : '';
      lines.push(
        `Tokens: ${tokenPrefix}${formatTokenCount(usage.totalTokens.knownSubtotal)} total (${formatTokenCount(usage.inputTokens.knownSubtotal)} in / ${formatTokenCount(usage.outputTokens.knownSubtotal)} out${tokenSuffix})`,
      );
    } else {
      lines.push('Tokens: unavailable');
    }
    if (hasKnownCost && costUsd !== null) {
      const costPrefix = usage.costMicrousd.completeness === 'partial' ? '>= ' : '';
      const costSuffix =
        usage.costMicrousd.completeness === 'partial' ? `, partial: ${usage.costMicrousd.unknownCount} unknown` : '';
      lines.push(`Cost: ${costPrefix}$${costUsd} USD (${usage.costMicrousd.provenance}${costSuffix})`);
    }
    if (input.checks && input.checks.length > 0) {
      lines.push('Checks:');
      for (const check of input.checks) {
        let checkLine = `- ${cleanLine(check.checkId)}: ${cleanLine(check.status)}`;
        if (check.code != null && check.code.length > 0) checkLine += ` (${cleanLine(check.code)})`;
        if (check.detail != null && check.detail.length > 0) checkLine += ` - ${cleanLine(check.detail)}`;
        lines.push(checkLine);
      }
    }
    if (input.externalUrl != null && input.externalUrl.length > 0) lines.push(`External URL: ${cleanLine(input.externalUrl)}`);
    if (input.elapsedMs != null) lines.push(`Elapsed: ${formatDurationMs(input.elapsedMs)}`);
    return lines.join('\n');
  }

  const exhaustive: never = format;
  throw new Error(`Unsupported report output format: ${String(exhaustive)}`);
}
