import { PiFailure } from '../dist/errors.js';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
export function closedFailure(error) {
 if (error instanceof PiFailure) return { code: error.detail.code, phase: error.detail.phase, stateErrorCode: error.detail.stateErrorCode };
 return { code: error?.code === 'ERR_ASSERTION' ? 'ASSERTION_FAILED' : 'UNKNOWN', phase: 'unknown', stateErrorCode: null };
}
export function boundedState(store) {
 const result = store.inspect(); if (!result.ok) return { available: false, failure: { code: result.error.code } };
 const { counts, ledger, clockStatus } = result.value;
 const page = store.listRequests({ limit: 32, cursor: null });
 const requests = page.ok && page.value.next === null ? page.value.items.map(record => ({ requestId: record.admission.requestId, attemptId: record.admission.attemptId, dispatchId: record.dispatch?.dispatchId ?? null, state: record.state })) : 'unknown';
 return { available: true, clockStatus, requests, counts: { requests: counts.requests, dispatchedRequests: counts.dispatchedRequests, observedRequests: counts.observedRequests, unresolvedRequests: counts.unresolvedRequests, unresolvedOperations: counts.unresolvedOperations },
 ledger: { admittedCalls: ledger.admittedCalls, heldSlots: ledger.heldSlots, unknownTokenRequests: ledger.unknownTokenRequests, reportedTokens: ledger.reportedTokens, chargedTokens: ledger.chargedTokens, violations: ledger.violations.length } };
}
export async function receiptDigests(directory) {
 let files; try { files = await readdir(join(directory, 'pi-receipts')); } catch (error) { if (error.code === 'ENOENT') return { available: true, receipts: [] }; throw error; }
 if (files.length > 512) throw new Error('Diagnostic receipt bound');
 const receipts = [], assessments = [], contextualReceipts = [];
 for (const file of files) {
  if (!/^(?:ctx-[a-f0-9]{32}-context|req-[a-f0-9]{32}-(?:raw|final)|tool-[a-f0-9]{32}-final)\.json$/.test(file)) throw new Error('Unexpected receipt name');
  const bytes = await readFile(join(directory, 'pi-receipts', file)); if (bytes.length > 4096) throw new Error('Diagnostic receipt bound');
  receipts.push({ file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  const metadata = JSON.parse(bytes.toString('utf8'));
  if (file.endsWith('-context.json')) assessments.push(metadata);
  else if (metadata.context) contextualReceipts.push({ file, context: metadata.context });
 }
 return { available: true, receipts, assessments, contextualReceipts };
}
