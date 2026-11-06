import { failedExecution, settledExecution } from './outcome-checks.mjs';
/* global process, console, Buffer, structuredClone */
import { dockerSocket } from './docker-socket.mjs';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { constructAdapter, runtimePorts } from '../dist/adapter.js';
import { RuntimeSession, profileIdentity } from '../dist/session-host.js';
import { Sender } from '../dist/sender.js';
import { selectedCatalog } from '../dist/catalog.js';
import { canonical, digest } from '../dist/boundary.js';
import { Channel } from '../dist/protocol.js';
import { closedFailure, boundedState, receiptDigests } from './diagnostics.mjs';
import { reclaimSessionRegistry } from './session-cleanup.mjs';
import { requestFixture, stateGood } from '../../../.test-build/packages/agent-pi/test/request-fixtures.js';
import { sessionInput } from '../../../.test-build/packages/agent-pi/test/session-fixtures.js';
import { admitTask, digestArtifact } from '@loopwright/core';
const nonce = randomBytes(8).toString('hex'), registryPath = resolve(process.argv[2] ?? '.claude/s03-t2-physical-' + nonce + '.json');
const raw = resolve(process.argv[3] ?? '.claude/s03-t2-physical-' + nonce); await mkdir(raw, { recursive: true });
const image = (await readFile('.claude/s03-t0/runtime-image.id', 'utf8')).trim(), dockerExecutable = execFileSync('/usr/bin/which', ['docker'], { encoding: 'utf8' }).trim();
const registry = { kind: 'runtime-session-v1', dockerSocket: dockerSocket(), dockerConfig: resolve('.claude/s03-t0/docker-client'), sessions: [] }, results = []; await writeFile(registryPath, JSON.stringify(registry));
const nativeSinks = new Map(), originalEmit = Channel.prototype.emit;
Channel.prototype.emit = function(event, message, ...rest) {
 const sink = nativeSinks.get(this.nonce); if (sink && event === 'message' && message?.kind === 'settled') { const input = message.body?.native, value = {}; for (const key of ['agentEnds','agentSettles','aborted','compactionEnds','compacted','idle','invocations','parserAcks','pending']) value[key] = typeof input?.[key] === 'boolean' || Number.isSafeInteger(input?.[key]) ? input[key] : 'unknown'; sink.native.push(value); }
 return originalEmit.call(this, event, message, ...rest);
};
const good = result => { assert.equal(result.ok, true); return result.value; };
function inputWithResources() {
 const input = sessionInput(), bytes = Buffer.from('DECLARED_T2_RESOURCE'), ref = good(digestArtifact('trusted/context.md', bytes));
 const contract = structuredClone(input.lock.spec.contract); contract.spec.trustedContext.resources = [{ id: 'trusted-doc', kind: 'document', path: ref.name, digest: structuredClone(ref.digest) }];
 input.lock = good(admitTask(contract, { admissionId: 'admission-1', runId: 'run-1' })); input.policy.resources.push(structuredClone(contract.spec.trustedContext.resources[0])); input.resources = [{ id: 'trusted-doc', kind: 'document', ref: structuredClone(ref), bytes }];
 const poison = Buffer.from('POISON_CANDIDATE_APPEND'); input.candidate.artifacts.push({ name: '.pi/APPEND_SYSTEM.md', bytes: poison }); input.candidate.manifest.spec.entries.push(good(digestArtifact('.pi/APPEND_SYSTEM.md', poison))); return input;
}
const stream = (mode = 'normal') => {
 const frames = [{ type: 'message_start', message: { id: 'fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-5.5', content: [], usage: { input_tokens: 4, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
 { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } }, { type: 'content_block_stop', index: 0 },
 { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }, ...(mode === 'partial' ? [] : [{ type: 'message_stop' }])];
 return frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join('');
};
try {
 for (const mode of (process.argv[4] ? [process.argv[4]] : ['normal', 'http-context', 'partial', 'stale'])) {
  const f = await requestFixture(call => call === 3 && mode === 'http-context' ? { status: 400, body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: synthetic compaction fixture' } }), headers: { 'content-type': 'application/json' } } : { status: 200, body: stream(call === 3 ? mode : 'normal') }, inputWithResources);
  let adapter, consuming; const facts = { mode, image, physical: 'unknown', state: { available: false }, outcomes: [], receipts: { available: false }, declaredResourceOnRequests: [], native: [], contextEvents: [] };
  const persist = async () => { facts.physical = f.physical(); facts.state = boundedState(f.host.store); facts.receipts = await receiptDigests(f.host.artifactsDirectory); await writeFile(join(raw, mode + '.json'), JSON.stringify(facts)); };
  try {
   f.input.policy.runtime = { ...f.input.policy.runtime, imageDigest: image, graphDigest: digest(await readFile('package-lock.json')), configDigest: await profileIdentity() };
   const host = { ...f.host, dockerExecutable, dockerSocket: dockerSocket(), runtime: f.input.policy.runtime };
   const ports = { ...runtimePorts, sender: (owner, input) => new Sender(owner, input, { fetch: (_url, options) => {
    const wire = String(options.body); assert.ok(!wire.includes('POISON_CANDIDATE_APPEND')); const ordinal = f.physical() + 1;
    if (ordinal !== 3) { assert.ok(wire.includes('DECLARED_T2_RESOURCE')); facts.declaredResourceOnRequests.push(ordinal); } return globalThis.fetch(f.destination, options);
   } }), session: (owner, input, broker, directory) => {
    const runtime = new RuntimeSession(owner, input, broker, directory); nativeSinks.set(runtime.nonce, facts);
    registry.sessions.push({ directory, name: runtime.name, nonce: runtime.nonce, generation: owner.authority.generation, runId: input.lock.spec.runId, sessionId: input.sessionId, image });
    // Persist intent before start/create; ID or name + labels can recover the creation-to-ID gap.
    const start = runtime.start.bind(runtime); runtime.start = async () => { await writeFile(registryPath, JSON.stringify(registry)); return start(); }; return runtime;
   } };
   const opened = await constructAdapter(host, f.input, ports); facts.opened = opened.ok ? { ready: true } : { ready: false, failure: opened.error }; await persist(); assert.equal(opened.ok, true); adapter = opened.value;
   consuming = (async () => { for await (const event of adapter.events()) if (event.kind === 'context_assessment') facts.contextEvents.push(event.context); })();
   void consuming.catch(() => {}); assert.deepEqual(adapter.capabilities().contextEstimator, { id: 'lw-pi-final-json-bytes-v1', version: 1, provenance: 'estimated' });
   assert.equal(f.physical(), 0);
   if (mode === 'stale') { stateGood(f.host.store.release(f.host.authority)); const current = stateGood(f.host.store.inspect()); stateGood(f.host.store.claim({ ownerId: 'replacement', expectedGeneration: current.owner.generation, expectedRevision: current.revision, mode: 'active' })); }
   const first = await adapter.execute({ commandId: 'first', text: 'first literal request', purpose: 'task', repair: 'none' }); facts.outcomes.push(first); await persist();
   if (mode === 'stale') { assert.equal(first.ok, false); assert.ok(first.error.stateErrorCode); assert.equal(f.physical(), 0); results.push(facts); continue; }
   settledExecution(first); assert.equal(f.physical(), 1);
   const second = await adapter.execute({ commandId: 'second', text: 'X'.repeat(16384), purpose: 'task', repair: 'none' }); facts.outcomes.push(second); await persist(); settledExecution(second); assert.equal(f.physical(), 2);
   const compacted = await adapter.compact({ commandId: 'explicit-summary' }); facts.outcomes.push(compacted); await persist(); assert.equal(f.physical(), 3);
   const page = stateGood(f.host.store.listRequests({ limit: 16, cursor: null })); facts.purposes = page.items.map(record => record.admission.purpose); facts.attemptIds = page.items.map(record => record.admission.attemptId); await persist();
   assert.deepEqual(facts.purposes, ['task', 'task', 'compaction']); assert.equal(new Set(facts.attemptIds).size, 3);
   if (mode === 'normal') {
    settledExecution(compacted); const after = await adapter.execute({ commandId: 'after-summary', text: 'continue frozen role after summary', purpose: 'task', repair: 'none' }); facts.outcomes.push(after); await persist();
    facts.outboundObserved = adapter.capabilities().outboundObserved; await persist();
    settledExecution(after); assert.equal(f.physical(), 4); assert.equal(facts.state.ledger.heldSlots, 0); assert.equal(facts.state.ledger.reportedTokens.decimal, '24');
    // Frozen adapter snapshots use null-prototype records. Compare their exact JSON identity, not prototypes.
    assert.equal(canonical(facts.outboundObserved), canonical(f.input.policy.selection));
   } else { failedExecution(compacted); assert.notEqual(compacted.value.error.code, 'INPUT_INVALID'); const after = await adapter.execute({ commandId: 'after-failed-summary', text: 'explicit later request', purpose: 'task', repair: 'none' }); facts.outcomes.push(after); await persist(); assert.equal(after.ok, false); assert.equal(f.physical(), 3); }
   const assessments = facts.receipts.assessments.filter(record => record.decision === 'admitted'); assert.equal(assessments.length, f.physical());
   assert.equal(facts.contextEvents.length, facts.receipts.assessments.length);
   const catalog = selectedCatalog(f.input);
   for (const captured of f.captured) {
    const body = Buffer.from(captured.body), hash = createHash('sha256').update('loopwright.dev/pi-context/v1\0').update(body).digest('hex');
    const record = assessments.find(record => record.assessment.bodyDigest === hash); assert.ok(record); assert.equal(record.assessment.bodyBytes, body.length); assert.equal(record.assessment.inputReservation, body.length + f.input.policy.context.serviceMargin); assert.equal(record.catalogWindow, catalog.contextWindow); assert.equal(canonical(record.catalogDigest), canonical(catalog.digest)); assert.equal(canonical(record.policyDigest), canonical(digest(Buffer.from(canonical(f.input.policy))))); assert.equal(record.assessment.workingWindow, Math.min(record.catalogWindow, f.input.policy.context.workingWindowCeiling)); assert.equal(record.assessment.withinWindow, true); assert.equal(record.assessment.coverage, 'complete'); assert.equal(record.assessment.contextFit, 'unproven'); assert.equal(record.model.model, f.input.policy.selection.model);
    const bindings = facts.receipts.contextualReceipts.filter(receipt => receipt.context.requestId === record.requestId); assert.ok(bindings.length >= 1);
    if (mode === 'normal') assert.equal(bindings.length, 2);
    assert.ok(facts.contextEvents.some(event => canonical(event) === canonical(record))); assert.ok(bindings.every(receipt => canonical(receipt.context) === canonical(record)));
   }
   results.push(facts);
  } catch (error) { facts.exception = closedFailure(error); await persist(); throw error; }
  finally {
   try { if (adapter) { const closed = await adapter.close(); if (consuming) await consuming; facts.closed = closed.ok; await persist(); assert.equal(closed.ok, true); } }
   finally {
    for (const intent of registry.sessions.filter(item => item.directory.startsWith(f.directory + '/'))) {
     try { intent.id = JSON.parse(await readFile(join(intent.directory, 'container-id.json'), 'utf8')).id; } catch { /* recovery retains the original named intent */ }
     for (const file of ['container-intent.json', 'container-id.json', 'cleanup.json', 'cli-exit.json']) {
      try { await writeFile(join(raw, mode + '-' + file), await readFile(join(intent.directory, file))); } catch { /* absence is kept distinct from successful cleanup */ }
     }
    }
    await writeFile(registryPath, JSON.stringify(registry)); await f.cleanup();
   }
  }
 }
 await writeFile(join(raw, 'summary.json'), JSON.stringify({ passed: true, image, results, level: 'actual production adapter/RuntimeSession/broker/S02 with real isolated SDK/parser/compaction; constructor-injected host HTTP transport to a real controlled endpoint; no live provider' })); console.log(JSON.stringify({ passed: true, image, cases: results.length }));
} catch (error) { await writeFile(join(raw, 'failure.json'), JSON.stringify({ failure: closedFailure(error), image, results })); process.exitCode = 1; }
finally { Channel.prototype.emit = originalEmit; reclaimSessionRegistry(registryPath); }
