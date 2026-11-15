import { constants as fsConstants, lstatSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  formatByteCount,
  formatCostUsd,
  formatDurationMs,
  formatRunReport,
  formatTokenCount,
  parseReportOutputFormats,
  REPORT_OUTPUT_FORMATS,
  sanitizeReportText,
  type ReportMcpServerInfo,
  type ReportOutputFormat,
  type RunReportInput,
} from '@loopwright/controller';
import { SecretScrubber } from './token-broker.js';
import { GitHubAppError, type TaskpackManifest, type TurnkeyMemorySummary } from './types.js';

export {
  formatByteCount,
  formatCostUsd,
  formatDurationMs,
  formatRunReport,
  formatTokenCount,
  parseReportOutputFormats,
  REPORT_OUTPUT_FORMATS,
  sanitizeReportText,
  type ReportMcpServerInfo,
  type ReportOutputFormat,
  type RunReportInput,
};

export interface WriteActionOutputSinksOptions {
  readonly formats: readonly ReportOutputFormat[];
  readonly report: RunReportInput;
  readonly memory?: TurnkeyMemorySummary | undefined;
  readonly stepSummaryPath?: string | undefined;
  readonly githubOutputPath?: string | undefined;
  readonly actionResultJson: string;
  readonly scrubber?: SecretScrubber | undefined;
  readonly includeExtendedGithubOutputs?: boolean | undefined;
  readonly logSink?: ((chunk: string) => void) | undefined;
  readonly alwaysLogTextSummary?: boolean | undefined;
}

export interface WrittenActionOutputs {
  readonly rendered: Readonly<Partial<Record<ReportOutputFormat, string>>>;
  readonly stepSummaryWritten: boolean;
  readonly githubOutputWritten: boolean;
  readonly result: string;
  readonly prUrl: string;
  readonly memoryPrUrl: string;
  readonly totalTokens: string;
  readonly costUsd: string | null;
}

export function resolveActionOutputFormats(
  inputOutput: string | undefined,
  manifest: TaskpackManifest | null | undefined,
): readonly ReportOutputFormat[] {
  try {
    if (inputOutput !== undefined && inputOutput.trim().length > 0) {
      return parseReportOutputFormats(inputOutput);
    }
    if (manifest?.spec.output?.formats !== undefined && manifest.spec.output.formats.length > 0) {
      return parseReportOutputFormats(manifest.spec.output.formats);
    }
    return Object.freeze(['json'] as const);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new GitHubAppError('ACTION_INPUT_INVALID', detail);
  }
}

async function appendSymlinkSafe(filePath: string, content: string): Promise<void> {
  const resolved = resolve(filePath);
  const parent = dirname(resolved);
  await mkdir(parent, { recursive: true });
  const parentStats = lstatSync(parent);
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
    throw new GitHubAppError('ACTION_INPUT_INVALID', `output parent "${parent}" must be a non-symlink directory`);
  }
  const handle = await open(
    resolved,
    fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new GitHubAppError('ACTION_INPUT_INVALID', `output sink "${resolved}" must be a regular file`);
    }
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
}

function encodeGithubOutputField(name: string, value: string): string {
  const singleLine = value.replace(/[\r\n]/g, ' ');
  return `${name}<<LOOPWRIGHT_EOF\n${singleLine}\nLOOPWRIGHT_EOF\n`;
}

function formatMemorySummaryLine(
  memory: TurnkeyMemorySummary,
  format: 'text' | 'markdown' | 'github-step-summary',
  scrub: ((text: string) => string) | undefined,
): string {
  const safeStatus = sanitizeReportText(memory.status, { scrub, singleLine: true });
  const safeBranch = memory.branchName
    ? sanitizeReportText(memory.branchName, { scrub, singleLine: true })
    : '';
  const safePrUrl = memory.pullRequestUrl
    ? sanitizeReportText(memory.pullRequestUrl, { scrub, singleLine: true })
    : '';
  const safeReason = memory.reason
    ? sanitizeReportText(memory.reason, { scrub, singleLine: true })
    : '';
  const entryLabel = memory.entryCount === 1 ? '1 entry' : `${memory.entryCount} entries`;
  if (format === 'text') {
    const extras = [
      entryLabel,
      ...(safeBranch ? [`branch=${safeBranch}`] : []),
      ...(safePrUrl ? [`pr=${safePrUrl}`] : []),
    ].join(', ');
    return `Memory: ${safeStatus} (${extras})${safeReason ? ` — ${safeReason}` : ''}`;
  }
  const mdExtras = [
    entryLabel,
    ...(safeBranch ? [`branch: \`${safeBranch}\``] : []),
    ...(safePrUrl ? [`PR: ${safePrUrl}`] : []),
  ].join(', ');
  return `Memory: \`${safeStatus}\` (${mdExtras})${safeReason ? ` — ${safeReason}` : ''}`;
}

function appendSummaryLine(base: string, line: string): string {
  const trimmedEnd = base.replace(/\n+$/, '');
  const hadTrailingNewline = base.endsWith('\n');
  return `${trimmedEnd}\n${line}${hadTrailingNewline ? '\n' : ''}`;
}

export async function writeActionOutputSinks(options: WriteActionOutputSinksOptions): Promise<WrittenActionOutputs> {
  const scrub = options.report.scrub ?? (options.scrubber !== undefined ? (text: string) => options.scrubber!.scrub(text) : undefined);
  const effectiveReport: RunReportInput = scrub !== undefined && options.report.scrub === undefined
    ? { ...options.report, scrub }
    : options.report;

  const renderFormat = (format: ReportOutputFormat): string => {
    const base = formatRunReport(effectiveReport, format);
    if (options.memory === undefined || format === 'json') {
      return base;
    }
    return appendSummaryLine(base, formatMemorySummaryLine(options.memory, format, scrub));
  };

  const rendered: Partial<Record<ReportOutputFormat, string>> = {};
  for (const format of options.formats) {
    rendered[format] = renderFormat(format);
  }

  const emitLog = options.logSink ?? ((chunk: string) => {
    process.stderr.write(chunk);
  });
  for (const sinkFormat of ['markdown', 'text'] as const) {
    if (options.formats.includes(sinkFormat)) {
      const renderedText = rendered[sinkFormat] ?? renderFormat(sinkFormat);
      emitLog(renderedText.endsWith('\n') ? renderedText : `${renderedText}\n`);
    }
  }
  if (
    options.alwaysLogTextSummary === true
    && !options.formats.includes('markdown')
    && !options.formats.includes('text')
  ) {
    const fallbackText = renderFormat('text');
    emitLog(fallbackText.endsWith('\n') ? fallbackText : `${fallbackText}\n`);
  }

  let stepSummaryWritten = false;
  if (
    options.formats.includes('github-step-summary')
    && options.stepSummaryPath !== undefined
    && options.stepSummaryPath.trim().length > 0
  ) {
    const summaryText = rendered['github-step-summary'] ?? renderFormat('github-step-summary');
    await appendSymlinkSafe(options.stepSummaryPath, summaryText.endsWith('\n') ? summaryText : `${summaryText}\n`);
    stepSummaryWritten = true;
  }

  const prUrl = effectiveReport.externalUrl
    ? sanitizeReportText(effectiveReport.externalUrl, { scrub, singleLine: true })
    : '';
  const memoryPrUrl =
    (options.memory?.status === 'published' || options.memory?.status === 'updated')
    && options.memory.pullRequestUrl
      ? sanitizeReportText(options.memory.pullRequestUrl, { scrub, singleLine: true })
      : '';
  const totalTokens = effectiveReport.usage
    ? String(effectiveReport.usage.totalTokens.knownSubtotal)
    : '0';
  const costUsd = effectiveReport.usage
    && (effectiveReport.usage.costMicrousd.provenance === 'reported'
      || effectiveReport.usage.costMicrousd.provenance === 'estimated')
    ? formatCostUsd(effectiveReport.usage.costMicrousd.knownSubtotal)
    : null;

  let githubOutputWritten = false;
  if (options.githubOutputPath !== undefined && options.githubOutputPath.trim().length > 0) {
    let payload = encodeGithubOutputField('result', options.actionResultJson);
    if (options.includeExtendedGithubOutputs === true) {
      payload += encodeGithubOutputField('pr-url', prUrl);
      payload += encodeGithubOutputField('memory-pr-url', memoryPrUrl);
      payload += encodeGithubOutputField('total-tokens', totalTokens);
      if (costUsd !== null) {
        payload += encodeGithubOutputField('cost-usd', costUsd);
      }
    }
    await appendSymlinkSafe(options.githubOutputPath, payload);
    githubOutputWritten = true;
  }

  return {
    rendered: Object.freeze(rendered),
    stepSummaryWritten,
    githubOutputWritten,
    result: options.actionResultJson,
    prUrl,
    memoryPrUrl,
    totalTokens,
    costUsd,
  };
}
