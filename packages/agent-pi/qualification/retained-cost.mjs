/* global process, console, Buffer, performance, structuredClone */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createLocalRun, reopenLocalRun } from '@loopwright/state';
import { admitTask } from '@loopwright/core';
import { sessionInput } from '../../../.test-build/packages/agent-pi/test/session-fixtures.js';
import { canonical, digest } from '../dist/boundary.js';
import { closedFailure } from './diagnostics.mjs';
const resample = process.argv.indexOf('--resample'), resampleOutput = resample >= 0 ? resolve(process.argv[resample + 1]) : null;
const raw = resolve(process.argv[2]); await mkdir(raw, { recursive: true }); const metadataPath = join(raw, 'identity.json');
const good = value => { if (!value.ok) throw Object.assign(new Error('State refused'), { code: value.error.code }); return value.value; };
let saved;
try { saved = JSON.parse(await readFile(metadataPath, 'utf8')); } catch (error) {
 if (error.code !== 'ENOENT') throw error;
 const input = sessionInput(), task = structuredClone(input.lock.spec.contract); task.spec.budgets.maxModelCalls = 1024; task.spec.budgets.totalTokens = 1000000000; task.spec.budgets.wallTimeMs = 3600000; const lock = admitTask(task, { admissionId: 'cost-admission', runId: 'cost-run' }); assert.equal(lock.ok, true);
 saved = { identity: { directory: join(raw, 'store'), storeId: 'cost-store', lock: lock.value, policy: { version: 1, leaseMs: 60000, cost: 'observe_only' }, binding: { coreApiVersion: 'loopwright.dev/v1alpha1', hostVersion: 'retained-cost-fixture', adapters: [{ id: 'pi', version: '0.0.0' }], resourceVersion: input.policy.resourceVersion, clockEpoch: 'retained-cost-same-host-boot' } }, samples: [], population: [] }; await writeFile(metadataPath, JSON.stringify(saved), { mode: 0o600 });
}
const opened = saved.authority ? reopenLocalRun(saved.identity) : createLocalRun(saved.identity), initialStore = good(opened); let store = initialStore;
let authority = saved.authority, view = good(store.inspect());
if (!authority) authority = good(store.claim({ ownerId: 'cost-owner', expectedGeneration: view.owner.generation, expectedRevision: view.revision, mode: 'active' })).authority;
else { const renewed = store.renew(authority); if (!renewed.ok) { const current = good(store.inspect()); authority = good(store.claim({ ownerId: 'cost-owner-reopened', expectedGeneration: current.owner.generation, expectedRevision: current.revision, mode: (current.clock.remainingTaskMs.safeValue ?? 0) > 0 ? 'active' : 'recovery' })).authority; } }
saved.authority = authority; await writeFile(metadataPath, JSON.stringify(saved), { mode: 0o600 });
function admission(index) { return { requestId: 'cost-' + index, operationId: 'cost-op-' + index, attemptId: 'cost-attempt-' + index, roleId: 'builder', nodeId: 'build', purpose: 'task', repair: 'none', transportRetryOf: null, requestDigest: digest(Buffer.from('synthetic-performance-' + index)), inputUpperBound: 10, outputUpperBound: 10, totalUpperBound: 20, capability: { adapterId: 'pi', adapterVersion: '0.0.0', provider: 'github-copilot', model: 'claude-sonnet-5.5', kind: 'soft_only', coversAllBillableTokens: false, enforcesOutputBound: true }, targetIdentity: 'controlled/retained-cost-fixture' }; }
function observation(request, operation) { return { receiptId: 'cost-receipt-' + request.requestId, termination: 'confirmed', outcome: 'succeeded', usage: { requestId: request.requestId, inputTokens: { provenance: 'reported', value: 1 }, outputTokens: { provenance: 'reported', value: 1 }, costMicrousd: { provenance: 'unknown' } }, evidence: { evidenceId: 'cost-evidence-' + request.requestId, producerId: 'retained-cost-fixture', method: 'synthetic-metadata-only', subject: { storeId: saved.identity.storeId, runId: saved.identity.lock.spec.runId, lockHash: saved.identity.lock.spec.lockHash, operationId: request.operationId, requestId: request.requestId, intentDigest: operation.intentDigest, dispatchGeneration: operation.dispatch.generation, dispatchId: operation.dispatch.dispatchId }, artifact: { name: 'synthetic-cost-receipt', byteLength: 0, digest: digest(Buffer.alloc(0)) } } }; }
const began = performance.now(); let lastRenewal = began;
try {
 for (const target of [1, 128, 1024]) {
  view = good(store.inspect()); if (view.counts.requests > target || resample < 0 && saved.samples.some(sample => sample.retained === target)) continue;
  const populationStart = performance.now(), from = view.counts.requests;
  for (let index = from + 1; index <= target; index++) {
   if (performance.now() - lastRenewal > 5000) { good(store.renew(authority)); lastRenewal = performance.now(); }
   const request = admission(index); good(store.reserveRequest(authority, request)); const dispatched = good(store.authorizeRequestDispatch(authority, request.requestId)); assert.equal(dispatched.kind, 'new_dispatch'); const operation = good(store.getOperation(request.operationId)); good(store.observeRequest(authority, request.requestId, observation(request, operation)));
   if (performance.now() - began > 45000) { saved.population.push({ from, target, reached: index, ms: performance.now() - populationStart }); await writeFile(metadataPath, JSON.stringify(saved), { mode: 0o600 }); console.log(JSON.stringify({ passed: false, status: 'population_pending', retained: index, target })); good(store.close()); process.exit(0); }
   if (index % 64 === 0) await writeFile(join(raw, 'progress.json'), JSON.stringify({ target, retained: index, elapsedMs: performance.now() - began, rss: process.memoryUsage().rss }));
  }
  saved.population.push({ from, target, ms: performance.now() - populationStart }); view = good(store.inspect()); assert.equal(view.counts.requests, target); assert.equal(view.counts.observedRequests, target); assert.equal(view.counts.unresolvedRequests, 0);
  good(store.renew(authority)); const record = good(store.getRequest('cost-' + target)), operation = good(store.getOperation(record.admission.operationId)), receipt = observation(record.admission, operation), samples = [];
  // At the 1024-record cap fresh admission is impossible. Measure the same public retained-validation paths as exact idempotent lookups; they issue no new grant.
  for (let sample = 0; sample < 5; sample++) {
   good(store.close()); const reopenStart = performance.now(); store = good(reopenLocalRun(saved.identity)); const times = { reopenMs: performance.now() - reopenStart }, measure = (key, action) => { const begin = performance.now(), result = good(action()); times[key] = performance.now() - begin; return result; };
   assert.equal(measure('reserveMs', () => store.reserveRequest(authority, record.admission)).kind, 'existing'); const dispatch = measure('authorizeMs', () => store.authorizeRequestDispatch(authority, record.admission.requestId)); assert.equal(dispatch.kind, 'existing'); assert.equal('permit' in dispatch, false);
   const sameGeneration = operation.dispatch.generation === authority.generation; const settled = measure('receiptMs', () => sameGeneration ? store.observeRequest(authority, record.admission.requestId, receipt) : store.reconcileRequest(authority, record.admission.requestId, { kind: 'terminal_usage', observation: receipt })); assert.ok(['existing', 'applied'].includes(settled.kind)); times.receiptPath = sameGeneration ? 'observeRequest-existing' : 'reconcileRequest-terminal-usage'; const after = measure('inspectMs', () => store.inspect()); assert.equal(canonical(after.counts), canonical(view.counts)); assert.equal(canonical(after.ledger), canonical(view.ledger)); samples.push({ sample, ...times, memory: process.memoryUsage() });
  }
  if (resampleOutput) { await writeFile(resampleOutput, JSON.stringify({ retained: target, samples, counts: view.counts, ledger: view.ledger, originalClockBasis: view.clock.basis, source: 'five fresh-connection public idempotent validations; no new permit', historical: saved.samples })); continue; }
  saved.samples.push({ retained: target, samples, mode: 'five exact-idempotent public retained-store validation runs; no new permit, no live provider', counts: view.counts, ledger: view.ledger }); await writeFile(metadataPath, JSON.stringify(saved), { mode: 0o600 }); await writeFile(join(raw, 'measurements.json'), JSON.stringify({ samples: saved.samples, population: saved.population, environment: { node: process.version, platform: process.platform, arch: process.arch }, level: 'public S02 API population and local SQLite retained-validation timing; synthetic usage and no provider requests; no throughput SLA' }));
 }
 console.log(JSON.stringify({ passed: true, retained: good(store.inspect()).counts.requests, sizes: saved.samples.map(value => value.retained) }));
} catch (error) { await writeFile(join(raw, 'failure.json'), JSON.stringify({ failure: closedFailure(error), code: typeof error.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code) ? error.code : 'unknown', elapsedMs: performance.now() - began })); process.exitCode = 1; }
finally { good(store.close()); }
