import type { SubmittedCheck, TaskContract, ArtifactRef } from '@loopwright/core';
import { canonical, freeze, id, list, record, text, hash } from './schema.js';
import { parsePrivateJson } from './parser.js';
import { refuse } from './errors.js';
import type { CapturedRole } from './capture.js';
import type { Controls } from './types.js';
import type { ArtifactStore } from './storage.js';
export interface Submission { readonly version: 1; readonly status: 'completed' | 'no_change' | 'failed' | 'blocked'; readonly checks: readonly SubmittedCheck[]; readonly reason: string | null }
export interface RetainedSubmission { readonly version: 1; readonly origin: 'artifact' | 'assistant' | 'both' | 'controller'; readonly raw: ArtifactRef; readonly value: Submission }
function reason(value: unknown): string | null {
  if (value === null) return null; const result = text(value, '', 4096); if (!result) refuse('SUBMISSION_INVALID', '', 'verification');
  for (let index = 0; index < result.length; index++) { const code = result.charCodeAt(index); if (code <= 31 || code >= 127 && code <= 159) refuse('SUBMISSION_INVALID', '', 'verification'); }
  return result;
}
export function normalizeSubmission(bytes: Uint8Array, task: TaskContract): Submission {
  try {
    if (bytes.byteLength > 1048576) refuse('SUBMISSION_INVALID', '', 'verification');
    let source = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
    if (source.startsWith('```')) { const match = /^```json\r?\n([\s\S]*)\r?\n```$/.exec(source); if (!match) refuse('SUBMISSION_INVALID', '', 'verification'); source = match[1]!; }
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
