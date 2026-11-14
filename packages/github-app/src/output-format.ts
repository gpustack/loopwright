import { constants as fsConstants, lstatSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  formatCostUsd,
  formatRunReport,
  parseReportOutputFormats,
  REPORT_OUTPUT_FORMATS,
  sanitizeReportText,
  type ReportOutputFormat,
  type RunReportInput,
} from '@loopwright/controller';
import { SecretScrubber } from './token-broker.js';
import { GitHubAppError, type TaskpackManifest } from './types.js';

export {
  formatCostUsd,
  formatRunReport,
  parseReportOutputFormats,
  REPORT_OUTPUT_FORMATS,
  sanitizeReportText,
  type ReportOutputFormat,
  type RunReportInput,
};

export interface WriteActionOutputSinksOptions {
  readonly formats: readonly ReportOutputFormat[];
  readonly report: RunReportInput;
  readonly stepSummaryPath?: string | undefined;
  readonly githubOutputPath?: string | undefined;
  readonly actionResultJson: string;
  readonly scrubber?: SecretScrubber | undefined;
  readonly includeExtendedGithubOutputs?: boolean | undefined;
  readonly logSink?: ((chunk: string) => void) | undefined;
}

export interface WrittenActionOutputs {
  readonly rendered: Readonly<Partial<Record<ReportOutputFormat, string>>>;
  readonly stepSummaryWritten: boolean;
  readonly githubOutputWritten: boolean;
  readonly result: string;
  readonly prUrl: string;
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

export async function writeActionOutputSinks(options: WriteActionOutputSinksOptions): Promise<WrittenActionOutputs> {
  const scrub = options.report.scrub ?? (options.scrubber !== undefined ? (text: string) => options.scrubber!.scrub(text) : undefined);
  const effectiveReport: RunReportInput = scrub !== undefined && options.report.scrub === undefined
    ? { ...options.report, scrub }
    : options.report;

  const rendered: Partial<Record<ReportOutputFormat, string>> = {};
  for (const format of options.formats) {
    rendered[format] = formatRunReport(effectiveReport, format);
  }

  const emitLog = options.logSink ?? ((chunk: string) => {
    process.stderr.write(chunk);
  });
  for (const sinkFormat of ['markdown', 'text'] as const) {
    if (options.formats.includes(sinkFormat)) {
      const renderedText = rendered[sinkFormat] ?? formatRunReport(effectiveReport, sinkFormat);
      emitLog(renderedText.endsWith('\n') ? renderedText : `${renderedText}\n`);
    }
  }

  let stepSummaryWritten = false;
  if (
    options.formats.includes('github-step-summary')
    && options.stepSummaryPath !== undefined
    && options.stepSummaryPath.trim().length > 0
  ) {
    const summaryText = rendered['github-step-summary'] ?? formatRunReport(effectiveReport, 'github-step-summary');
    await appendSymlinkSafe(options.stepSummaryPath, `${summaryText}\n`);
    stepSummaryWritten = true;
  }

  const prUrl = effectiveReport.externalUrl
    ? sanitizeReportText(effectiveReport.externalUrl, { scrub, singleLine: true })
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
    totalTokens,
    costUsd,
  };
}
