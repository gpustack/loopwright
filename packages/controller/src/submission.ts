import { LIMITS, validateRelativePath, type SubmittedCheck, type TaskContract, type ArtifactRef, type FindingSeverity, type StructuredFinding } from '@loopwright/core';
import { canonical, freeze, id, integer, isRecord, list, record, text, hash } from './schema.js';
import { parsePrivateJson } from './parser.js';
import { refuse, type ControllerDiagnostic } from './errors.js';
import type { CapturedRole } from './capture.js';
import type { CompiledPlan, Controls, RecordedStepVerdict, StepVerdict, StepVerdictDisposition, StoredStepVerdict } from './types.js';
import type { ArtifactReader, ArtifactStore } from './storage.js';
export interface Submission { readonly version: 1; readonly status: 'completed' | 'no_change' | 'failed' | 'blocked'; readonly checks: readonly SubmittedCheck[]; readonly reason: string | null }
export interface RetainedSubmission { readonly version: 1; readonly origin: 'artifact' | 'assistant' | 'both' | 'controller'; readonly raw: ArtifactRef; readonly value: Submission }
export interface RetainedStepVerdict { readonly version: 1; readonly origin: 'artifact' | 'assistant' | 'both' | 'controller'; readonly raw: ArtifactRef; readonly value: StepVerdict }
export type CapturedStepOutput =
  | { readonly kind: 'submission'; readonly retained: RetainedSubmission }
  | { readonly kind: 'verdict'; readonly retained: RetainedStepVerdict };
export function isVerdictStep(node: CompiledPlan['orderedDAG'][number] | undefined): boolean {
  return node !== undefined && node.kind === 'agent' && (node.onRework !== undefined || node.handler.parameters.purpose === 'review');
}
function reason(value: unknown): string | null {
  if (value === null) return null; const result = text(value, '', 4096); if (!result) refuse('SUBMISSION_INVALID', '', 'verification');
  for (let index = 0; index < result.length; index++) { const code = result.charCodeAt(index); if (code <= 31 || code >= 127 && code <= 159) refuse('SUBMISSION_INVALID', '', 'verification'); }
  return result;
}
export function checkedVerdictText(
  value: unknown,
  maxLength: number,
  allowMultiline = true,
  code: ControllerDiagnostic['code'] = 'SUBMISSION_INVALID',
  phase: ControllerDiagnostic['phase'] = 'verification',
): string {
  const result = text(value, '', maxLength);
  if (!result) refuse(code, '', phase);
  for (let index = 0; index < result.length; index++) {
    const codePoint = result.charCodeAt(index);
    if (allowMultiline && (codePoint === 9 || codePoint === 10 || codePoint === 13)) continue;
    if (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)) refuse(code, '', phase);
  }
  return result;
}
export function summarizeStepVerdictPreview(summary: string): string {
  const collapsed = summary.replace(/[\r\n\t]+/g, ' ').trim();
  const preview = Array.from(collapsed).slice(0, 256).join('');
  return preview.length > 0 ? preview : 'verdict';
}
export function validateStepVerdictObject(
  raw: unknown,
  code: ControllerDiagnostic['code'] = 'SUBMISSION_INVALID',
  phase: ControllerDiagnostic['phase'] = 'verification',
): StepVerdict {
  try {
    const value = record(raw, ['verdict', 'summary', 'findings']);
    const verdictRaw = text(value.verdict, '', 16);
    if (!['pass', 'rework', 'fail', 'human'].includes(verdictRaw)) refuse(code, '', phase);
    const summary = checkedVerdictText(value.summary, 4096, true, code, phase);
    const findings: StructuredFinding[] = list(value.findings, '', LIMITS.findings).map(rawFinding => {
      if (!isRecord(rawFinding)) refuse(code, '', phase);
      const hasPath = Object.hasOwn(rawFinding, 'path');
      const hasLine = Object.hasOwn(rawFinding, 'line');
      const item = record(rawFinding, [
        'title',
        'severity',
        'evidence',
        ...(hasPath ? ['path' as const] : []),
        ...(hasLine ? ['line' as const] : []),
      ]);
      const title = checkedVerdictText(item.title, LIMITS.findingTitle, false, code, phase);
      const severityRaw = text(item.severity, '', 16);
      if (!['critical', 'high', 'medium', 'low'].includes(severityRaw)) refuse(code, '', phase);
      const evidence = checkedVerdictText(item.evidence, LIMITS.findingEvidence, true, code, phase);
      let validatedPath: string | null | undefined;
      if (hasPath && item.path !== undefined) {
        if (item.path === null) validatedPath = null;
        else {
          const pathRes = validateRelativePath(item.path);
          if (!pathRes.ok) refuse(code, '', phase);
          validatedPath = pathRes.value;
        }
      }
      let validatedLine: number | null | undefined;
      if (hasLine && item.line !== undefined) {
        validatedLine = item.line === null ? null : integer(item.line, 1, Number.MAX_SAFE_INTEGER);
      }
      return freeze({
        title,
        severity: severityRaw as FindingSeverity,
        ...(validatedPath !== undefined ? { path: validatedPath } : {}),
        ...(validatedLine !== undefined ? { line: validatedLine } : {}),
        evidence,
      });
    });
    return freeze({
      verdict: verdictRaw as StepVerdictDisposition,
      summary,
      findings: freeze(findings),
    });
  } catch {
    refuse(code, '', phase);
  }
}
export async function hydrateStepVerdicts(
  artifacts: ArtifactReader,
  stored: readonly StoredStepVerdict[] | undefined,
): Promise<readonly RecordedStepVerdict[]> {
  if (!stored || stored.length === 0) return [];
  const hydrated: RecordedStepVerdict[] = [];
  for (const entry of stored) {
    let verdict: StepVerdict;
    try {
      verdict = parseStepVerdict(await artifacts.read(entry.raw, 1_048_576));
    } catch {
      refuse('RECOVERY_REQUIRED', '', 'recovery');
    }
    if (
      verdict.verdict !== entry.verdict ||
      verdict.findings.length !== entry.findingCount ||
      summarizeStepVerdictPreview(verdict.summary) !== entry.summaryPreview
    ) {
      refuse('RECOVERY_REQUIRED', '', 'recovery');
    }
    hydrated.push(
      freeze({
        attemptId: entry.attemptId,
        stepId: entry.stepId,
        roleId: entry.roleId,
        reworkEpoch: entry.reworkEpoch,
        generation: entry.generation,
        raw: entry.raw,
        verdict,
      }),
    );
  }
  return freeze(hydrated);
}
export function boundFindingsForObservations(findings: readonly StructuredFinding[]): {
  readonly findings: readonly StructuredFinding[];
  readonly findingsTruncated: boolean;
  readonly totalFindingsCount: number;
} {
  const MAX_ITEMS = 256;
  const MAX_BYTES = 200_000;
  const bounded: StructuredFinding[] = [];
  let totalBytes = 2;
  for (const item of findings) {
    if (bounded.length >= MAX_ITEMS) break;
    const itemBytes = Buffer.byteLength(canonical(item), 'utf8') + (bounded.length > 0 ? 1 : 0);
    if (totalBytes + itemBytes > MAX_BYTES) break;
    bounded.push(item);
    totalBytes += itemBytes;
  }
  return {
    findings: freeze(bounded),
    findingsTruncated: bounded.length < findings.length,
    totalFindingsCount: findings.length,
  };
}
function decodeJsonSource(bytes: Uint8Array): string {
  if (bytes.byteLength > 1048576) refuse('SUBMISSION_INVALID', '', 'verification');
  let source = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
  if (source.startsWith('```')) {
    const match = /^```json\r?\n([\s\S]*)\r?\n```$/.exec(source);
    if (!match) refuse('SUBMISSION_INVALID', '', 'verification');
    source = match[1]!;
  }
  return source;
}
export function normalizeSubmission(bytes: Uint8Array, task: TaskContract): Submission {
  try {
    const source = decodeJsonSource(bytes);
    const value = record(parsePrivateJson(Buffer.from(source), 1048576), ['version', 'status', 'checks', 'reason']);
    if (value.version !== 1 || !['completed', 'no_change', 'failed', 'blocked'].includes(text(value.status))) refuse('SUBMISSION_INVALID', '', 'verification');
    const checks = list(value.checks, '', 256).map(raw => {
      const check = record(raw, ['checkId', 'status', 'evidenceId', 'reason']), checkId = id(check.checkId), why = reason(check.reason), evidenceId = check.evidenceId === null ? null : id(check.evidenceId);
      if (!task.spec.acceptance.checks.some(item => item.id === checkId) || !['passed', 'failed', 'blocked', 'not_run'].includes(text(check.status)) || (check.status === 'passed') !== (why === null) || check.status === 'not_run' && evidenceId !== null) refuse('SUBMISSION_INVALID', '', 'verification');
      return { checkId, status: check.status as SubmittedCheck['status'], evidenceId, reason: why };
    });
    if (new Set(checks.map(check => check.checkId)).size !== checks.length) refuse('SUBMISSION_INVALID', '', 'verification');
    return freeze({ version: 1, status: value.status as Submission['status'], checks, reason: reason(value.reason) });
  } catch { refuse('SUBMISSION_INVALID', '', 'verification'); }
}
export const parseSubmission = normalizeSubmission;
export function parseStepVerdict(bytes: Uint8Array): StepVerdict {
  try {
    const source = decodeJsonSource(bytes);
    const parsed = parsePrivateJson(Buffer.from(source), 1048576);
    return validateStepVerdictObject(parsed, 'SUBMISSION_INVALID', 'verification');
  } catch {
    refuse('SUBMISSION_INVALID', '', 'verification');
  }
}
export function isStepVerdictBytes(bytes: Uint8Array): boolean {
  try {
    const source = decodeJsonSource(bytes);
    const parsed = parsePrivateJson(Buffer.from(source), 1048576);
    return isRecord(parsed) && Object.hasOwn(parsed, 'verdict') && !Object.hasOwn(parsed, 'version');
  } catch {
    return false;
  }
}
export async function retainSubmission(capture: CapturedRole, controls: Controls['submission'], task: TaskContract, artifacts: ArtifactStore): Promise<RetainedSubmission> {
  const artifact = controls.path === null ? undefined : capture.artifacts.find(file => file.name === controls.path)?.bytes;
  const assistant = capture.submission === null ? null : await artifacts.read(capture.submission, 1048576);
  if (artifact !== undefined && assistant !== null && !Buffer.from(artifact).equals(Buffer.from(assistant))) refuse('SUBMISSION_AMBIGUOUS', '', 'verification');
  const bytes = artifact ?? assistant; if (bytes === null || bytes === undefined) refuse('SUBMISSION_INVALID', '', 'verification');
  const value = normalizeSubmission(bytes, task), raw = await artifacts.put('submission', bytes, 1048576), origin = artifact !== undefined ? assistant !== null ? 'both' : 'artifact' : 'assistant';
  // Digest and byte lengths describe the original response, including its original fencing/whitespace.
  if (raw.byteLength !== bytes.byteLength || raw.digest.hex !== hash(bytes).hex || Buffer.byteLength(canonical(value)) > 1048576) refuse('SUBMISSION_INVALID', '', 'verification');
  return freeze({ version: 1, origin, raw, value });
}
export async function retainStepOutput(
  capture: CapturedRole,
  controls: Controls['submission'],
  task: TaskContract,
  artifacts: ArtifactStore,
  options?: {
    readonly ignoreArtifactPath?: boolean;
    readonly previousFiles?: readonly { readonly name: string; readonly bytes: Uint8Array }[];
    readonly expectedKind?: 'submission' | 'verdict';
  },
): Promise<CapturedStepOutput> {
  let artifact = options?.ignoreArtifactPath || controls.path === null
    ? undefined
    : capture.artifacts.find(file => file.name === controls.path)?.bytes;
  if (artifact !== undefined && capture.submission !== null && options?.previousFiles !== undefined) {
    const prior = options.previousFiles.find(file => file.name === controls.path);
    if (prior !== undefined && Buffer.from(prior.bytes).equals(Buffer.from(artifact))) {
      artifact = undefined;
    }
  }
  const assistant = capture.submission === null ? null : await artifacts.read(capture.submission, 1048576);
  if (artifact !== undefined && assistant !== null && !Buffer.from(artifact).equals(Buffer.from(assistant))) {
    refuse('SUBMISSION_AMBIGUOUS', '', 'verification');
  }
  const bytes = artifact ?? assistant;
  if (bytes === null || bytes === undefined) refuse('SUBMISSION_INVALID', '', 'verification');
  const origin: 'artifact' | 'assistant' | 'both' = artifact !== undefined ? (assistant !== null ? 'both' : 'artifact') : 'assistant';
  const parseAsVerdict =
    options?.expectedKind === 'verdict'
      ? true
      : options?.expectedKind === 'submission'
        ? false
        : isStepVerdictBytes(bytes);
  if (parseAsVerdict) {
    const value = parseStepVerdict(bytes);
    const raw = await artifacts.put('step-verdict', bytes, 1048576);
    if (raw.byteLength !== bytes.byteLength || raw.digest.hex !== hash(bytes).hex || Buffer.byteLength(canonical(value)) > 1048576) {
      refuse('SUBMISSION_INVALID', '', 'verification');
    }
    return { kind: 'verdict', retained: freeze({ version: 1, origin, raw, value }) };
  }
  const value = normalizeSubmission(bytes, task);
  const raw = await artifacts.put('submission', bytes, 1048576);
  if (raw.byteLength !== bytes.byteLength || raw.digest.hex !== hash(bytes).hex || Buffer.byteLength(canonical(value)) > 1048576) {
    refuse('SUBMISSION_INVALID', '', 'verification');
  }
  return { kind: 'submission', retained: freeze({ version: 1, origin, raw, value }) };
}
