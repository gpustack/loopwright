import { randomBytes } from 'node:crypto';
import type { DispatchPermit, OperationRecord } from '@loopwright/state';
import { canonical } from './boundary.js';
import { stateValue } from './admission.js';
import { refuse } from './errors.js';
import { publishReceipt } from './receipt.js';
import type { PiHost } from './types.js';
/** Current original permission, checked at the final owner-mediated OS dispatch boundary. */
export function guardLocalOperation(host: PiHost, record: OperationRecord, permit: DispatchPermit, signal: AbortSignal, closed: boolean): void {
  if (signal.aborted || closed) refuse('CANCELLED', '', { phase: 'tool', operationId: record.intent.operationId });
  const renewed = stateValue(host.store.renew(host.authority), 'tool');
  if (canonical(renewed.authority) !== canonical(host.authority)) refuse('AUTHORITY_REFUSED', '', { phase: 'tool' });
  const current = stateValue(host.store.getOperation(record.intent.operationId), 'tool'), view = stateValue(host.store.inspect(), 'tool');
  if (current.state !== 'dispatch_uncertain' || current.dispatch?.dispatchId !== permit.dispatchId || current.dispatch.generation !== permit.generation || canonical(current.intent) !== canonical(record.intent)
    || view.clockStatus !== 'trusted' || view.owner.mode !== 'active' || view.owner.ownerId !== host.authority.ownerId || view.owner.generation !== host.authority.generation
    || permit.storeId !== view.storeId || permit.runId !== view.runId || canonical(permit.lockHash) !== canonical(view.lockHash) || permit.generation !== host.authority.generation || permit.clockEpoch !== view.clock.basis.clockEpoch
    || BigInt(view.clock.sampledNow.monotonicMs) >= BigInt(permit.notAfterMonotonicMs) || BigInt(view.clock.sampledNow.monotonicMs) >= BigInt(view.clock.basis.taskDeadlineMonotonicMs)) refuse('AUTHORITY_REFUSED', '', { phase: 'tool', operationId: record.intent.operationId });
}
export async function recordLocalOperation(host: PiHost, record: OperationRecord, outcome: 'succeeded' | 'failed' | 'not_executed', metadata: Readonly<Record<string, unknown>>): Promise<void> {
  if (!record.dispatch) refuse('RECOVERY_REQUIRED', '', { phase: 'tool' });
  const view = stateValue(host.store.inspect(), 'tool'); const subject = { storeId: view.storeId, runId: view.runId, lockHash: { ...view.lockHash }, operationId: record.intent.operationId, requestId: null, intentDigest: { ...record.intentDigest }, dispatchGeneration: record.dispatch.generation, dispatchId: record.dispatch.dispatchId };
  const artifact = await publishReceipt(host.artifactsDirectory, record.intent.operationId, 'final', { ...metadata, version: 1, subject, outcome });
  stateValue(host.store.recordOperationReceipt(host.authority, record.intent.operationId, { receiptId: 'tool-receipt-' + randomBytes(12).toString('hex'), outcome,
    evidence: { evidenceId: 'tool-evidence-' + randomBytes(12).toString('hex'), producerId: 'pi-owner', method: 'local-tool-v1', subject, artifact } }), 'tool');
}
