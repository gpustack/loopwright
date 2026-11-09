import { parentPort, workerData } from 'node:worker_threads';
import { evaluatePacket, AllocationQuota } from './verifier-protocol.js';
import { canonical } from './schema.js';
// Fixed trusted code only. The sole payload is a transferred packet; no repository/module path is accepted.
if (parentPort) {
  try {
    const observed = evaluatePacket(workerData as Uint8Array), quota = new AllocationQuota(); let reply = observed, size = Buffer.byteLength(canonical(reply));
    for (let index = 0; index < 3; index++) { reply = { ...observed, allocationBytes: observed.allocationBytes + size }; const next = Buffer.byteLength(canonical(reply)); if (next === size) break; size = next; }
    const text = canonical(reply); quota.charge(observed.allocationBytes); if (size > 65536 || Buffer.byteLength(text) !== size) throw new Error('output'); const bytes = quota.allocate(size); Buffer.from(bytes.buffer).write(text, 'utf8');
    parentPort.postMessage(bytes, [bytes.buffer]);
  } catch { parentPort.postMessage({ version: 1, error: 'INVALID_JOB' }); }
  finally { parentPort.close(); }
}
