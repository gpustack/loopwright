import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createLocalRun, type StateResult, type RequestAdmission } from '@loopwright/state';
import { admitTask } from '@loopwright/core';
import type { PiHost } from '../src/types.js';
import { sessionInput } from './session-fixtures.js';
import { digest } from '../src/boundary.js';
import { daemonFixture } from './daemon-fixtures.js';
export function stateGood<T>(result: StateResult<T>): T { assert.equal(result.ok, true, JSON.stringify(result)); if (!result.ok) throw new Error('fixture state failed'); return result.value; }
export async function requestFixture(plan?: (call: number) => { status: number; body: string; headers?: Record<string, string> }, createInput = sessionInput, leaseMs = 1000) {
  let input = createInput(); const directory = mkdtempSync(join(realpathSync(tmpdir()), 'loopwright-pi-request-'));
  mkdirSync(join(directory, 'runtime')); mkdirSync(join(directory, 'artifacts')); const daemon = daemonFixture(directory);
  // REVIEW-072: under S03 qualification the s03-io supervisor instrumentation stretches constructAdapter past a
  // 2000ms task wall; calibrate only that frozen fixture value (deadline mode) before the store is created.
  if (process.env.S04_S03_SCOPE && input.lock.spec.contract.spec.budgets.wallTimeMs === 2000) {
    const task = structuredClone(input.lock.spec.contract) as { spec: { budgets: { wallTimeMs: number } } };
    task.spec.budgets.wallTimeMs = 5000;
    const admitted = admitTask(task, { admissionId: 'admission-1', runId: input.lock.spec.runId });
    assert.equal(admitted.ok, true);
    if (admitted.ok) input = { ...input, lock: admitted.value };
  }
  const identity = { directory: join(directory, 'state'), storeId: 'store-1', lock: input.lock, policy: { version: 1 as const, leaseMs, cost: 'observe_only' as const },
    binding: { coreApiVersion: 'loopwright.dev/v1alpha1' as const, hostVersion: 'fixture', adapters: [{ id: 'pi', version: '0.0.0' }], resourceVersion: input.policy.resourceVersion, clockEpoch: 'fixture-boot' } };
  const store = stateGood(createLocalRun(identity)), view = stateGood(store.inspect());
  const claimed = stateGood(store.claim({ ownerId: 'owner-1', expectedGeneration: view.owner.generation, expectedRevision: view.revision, mode: 'active' }));
  const host: PiHost = { store, authority: claimed.authority, directory: join(directory, 'runtime'), artifactsDirectory: join(directory, 'artifacts'), dockerExecutable: daemon.dockerExecutable, dockerSocket: daemon.dockerSocket, runtime: input.policy.runtime,
    resolveCredential: async () => ({ bearerToken: 'SYNTHETIC_HOST_SECRET' }) };
  let physical = 0; const captured: { authorization: string | undefined; body: string }[] = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); physical++;
    captured.push({ authorization: request.headers.authorization, body: Buffer.concat(chunks).toString() });
    const selected = plan?.(physical) ?? { status: 200, body: 'OK', headers: { 'content-type': 'text/plain' } };
    setTimeout(() => { response.writeHead(selected.status, selected.headers ?? { 'content-type': 'text/event-stream' }); response.end(selected.body); }, 50);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture address');
  const destination = 'http://127.0.0.1:' + address.port, body = Buffer.from('controlled request body'), abort = new AbortController();
  const request: RequestAdmission = { requestId: 'request-1', roleId: 'builder', nodeId: 'build', attemptId: 'attempt-1', purpose: 'task', repair: 'none', transportRetryOf: null,
    requestDigest: digest(body), inputUpperBound: 100, outputUpperBound: 20, totalUpperBound: 120,
    capability: { adapterId: 'pi', adapterVersion: '0.0.0', provider: 'github-copilot', model: 'claude-sonnet-5.5', kind: 'soft_only', coversAllBillableTokens: false, enforcesOutputBound: true }, operationId: 'operation-1', targetIdentity: destination };
  return { host, input, identity, directory, destination, body, abort, request, captured, daemon, physical: () => physical,
    payload: { destination, headers: { authorization: 'Bearer SYNTHETIC_HOST_SECRET', 'content-type': 'application/json' }, body, signal: abort.signal },
    cleanup: async (retainDirectory = false) => { abort.abort(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); if (!retainDirectory) rmSync(directory, { recursive: true, force: true }); } };
}
