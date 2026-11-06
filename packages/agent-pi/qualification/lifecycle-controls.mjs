import { failedExecution, settledExecution } from './outcome-checks.mjs';
/* global process, console, performance, structuredClone, setTimeout, clearInterval, setInterval */
import { dockerSocket } from './docker-socket.mjs';
import { admitTask } from '@loopwright/core';
import { sessionInput } from '../../../.test-build/packages/agent-pi/test/session-fixtures.js';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { constructAdapter, runtimePorts } from '../dist/adapter.js';
import { RuntimeSession, profileIdentity } from '../dist/session-host.js';
import { Sender } from '../dist/sender.js';
import { Events } from '../dist/events.js';
import { canonical, digest } from '../dist/boundary.js';
import { boundedState, closedFailure } from './diagnostics.mjs';
import { reclaimRoles } from './role-cleanup.mjs';
import { requestFixture } from '../../../.test-build/packages/agent-pi/test/request-fixtures.js';
const raw = resolve(process.argv[2]); await mkdir(raw, { recursive: true }); const image = (await readFile('.claude/s03-t0/runtime-image.id', 'utf8')).trim(), dockerExecutable = execFileSync('/usr/bin/which', ['docker'], { encoding: 'utf8' }).trim(), results = [];
const frames = [{ type: 'message_start', message: { id: 'fixture', role: 'assistant', model: 'claude-sonnet-5.5', content: [], usage: { input_tokens: 4, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'PRIVATE_ASSISTANT_MARKER' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' }];
for (const mode of process.argv[3] ? [process.argv[3]] : ['slow', 'overflow', 'disconnect', 'history', 'transcript-overflow', 'diagnostic', 'deadline']) {
 const directory = join(raw, mode); await mkdir(directory, { recursive: true }); const registryPath = join(directory, 'ownership.json'), registry = { kind: 'restricted-roles-v1', dockerSocket: dockerSocket(), dockerConfig: resolve('.claude/s03-t0/docker-client'), roles: [] };
 let observed; const requestObserved = new Promise(resolve => { observed = resolve; }); const f = await requestFixture(() => { observed(); const selected = frames.map(frame => structuredClone(frame)); if ((mode === 'length' || mode === 'length-budget')) selected[4].delta.stop_reason = 'max_tokens'; if (mode === 'empty') { selected[2].delta.text = ''; selected[4].usage.output_tokens = 0; }
 return mode === 'ordinary-error' ? { status: 503, body: JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'controlled failure' } }), headers: { 'content-type': 'application/json' } } : { status: 200, body: mode === 'response-flood' ? 'X'.repeat(1048577) : selected.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join('') }; }, () => { const input = sessionInput(); if (mode === 'deadline' || mode === 'length-budget') { const task = structuredClone(input.lock.spec.contract); if (mode === 'deadline') task.spec.budgets.wallTimeMs = 2000; else { task.spec.budgets.maxModelCalls = 1; task.spec.budgets.maxConcurrency = 1; task.spec.budgets.maxImplementationRepairs = 0; task.spec.budgets.maxTransportRetries = 0; } const admitted = admitTask(task, { admissionId: 'admission-1', runId: 'run-1' }); writeFileSync(join(directory, 'policy-preflight.json'), JSON.stringify({ mode, image, valid: admitted.ok, errors: admitted.ok ? [] : admitted.errors.map(error => ({ code: error.code, path: error.path })) })); assert.equal(admitted.ok, true); input.lock = admitted.value; } return input; });
 const facts = { mode, image, physical: 'unknown', state: { available: false }, events: [], outcomes: [], eventQueueHighWater: 0, eventBytesHighWater: 0, publishMaxMs: 0, rssBefore: process.memoryUsage().rss, rssPeak: process.memoryUsage().rss }, timer = setInterval(() => { facts.rssPeak = Math.max(facts.rssPeak, process.memoryUsage().rss); }, 10), oldPush = Events.prototype.push;
 Events.prototype.push = async function(...args) { if (mode === 'slow' && args[0] === 'request_start') observed(); const began = performance.now(); try { return await oldPush.apply(this, args); } finally { facts.publishMaxMs = Math.max(facts.publishMaxMs, performance.now() - began); facts.eventQueueHighWater = Math.max(facts.eventQueueHighWater, this.highWaterEvents); facts.eventBytesHighWater = Math.max(facts.eventBytesHighWater, this.highWaterBytes); } };
 let adapter, runtime, consuming; const persist = async () => { facts.physical = f.physical(); facts.state = boundedState(f.host.store); await writeFile(join(directory, 'facts.json'), JSON.stringify(facts)); await writeFile(registryPath, JSON.stringify(registry)); };
 try {
  f.input.policy.runtime = { ...f.input.policy.runtime, imageDigest: image, graphDigest: digest(await readFile('package-lock.json')), configDigest: await profileIdentity() }; if (mode === 'slow') f.input.policy.limits.eventQueue = 2; if (mode === 'overflow') f.input.policy.limits.eventQueue = 5;
  const host = { ...f.host, runtime: f.input.policy.runtime, dockerExecutable, dockerSocket: dockerSocket() };
  const ports = { ...runtimePorts, sender: (owner, value) => new Sender(owner, value, { fetch: (_url, init) => globalThis.fetch(f.destination, init) }), session: (owner, value, broker, path) => {
   runtime = new RuntimeSession(owner, value, broker, path); const start = runtime.start.bind(runtime), docker = runtime.docker.bind(runtime), fixture = { history: 'history', 'transcript-overflow': 'overflow', diagnostic: 'diagnostic' }[mode];
   if (fixture) runtime.docker = args => { if (args[0] !== 'create') return docker(args); const changed = [...args]; assert.equal(changed.at(-2), '/opt/loopwright/packages/agent-pi/dist/sdk-worker.js'); changed[changed.length - 2] = '/opt/loopwright/packages/agent-pi/qualification/lifecycle-' + fixture + '-child.mjs'; return docker(changed); };
   registry.roles.push({ directory: path, name: runtime.name, image, labels: { 'org.loopwright.generation': String(owner.authority.generation), 'org.loopwright.run': value.lock.spec.runId, 'org.loopwright.session': value.sessionId, 'org.loopwright.nonce': runtime.nonce } }); runtime.start = async () => { await persist(); return start(); }; return runtime;
  } }; const opened = await constructAdapter(host, f.input, ports); facts.opened = opened.ok ? true : opened.error; await persist(); assert.equal(opened.ok, true); adapter = opened.value;
  if (mode === 'deadline') consuming = (async () => { for await (const event of adapter.events()) facts.events.push(event); })();
  if (mode === 'slow') consuming = (async () => { await requestObserved; await new Promise(resolve => setTimeout(resolve, 150)); for await (const event of adapter.events()) { facts.events.push(event); await new Promise(resolve => setTimeout(resolve, 75)); } })();
  const iterator = mode === 'disconnect' ? adapter.events()[Symbol.asyncIterator]() : null;
  const command = { commandId: 'first', text: 'PRIVATE_PROMPT_MARKER\n\u001b[31m::error::CANARY', purpose: 'task', repair: 'none' }, running = adapter.execute(command);
  if (mode === 'disconnect') { await requestObserved; const begin = performance.now(); await iterator.return(); facts.cancelMs = performance.now() - begin; }
  const outcome = await running; facts.outcomes.push(outcome); await persist();
  if (mode === 'empty') { settledExecution(outcome); assert.equal(f.physical(), 1); for (let index = 2; index <= 3; index++) { const explicit = await adapter.execute({ ...command, commandId: 'explicit-empty-' + index }); facts.outcomes.push(explicit); await persist(); settledExecution(explicit); assert.equal(f.physical(), index); } }
  else if (mode === 'length' || mode === 'length-budget' || mode === 'ordinary-error' || mode === 'response-flood') {
   failedExecution(outcome); assert.equal(f.physical(), 1); const reset = await adapter.execute({ ...command, commandId: 'reset-does-not-retry' }); facts.outcomes.push(reset); await persist(); assert.equal(reset.ok, false); assert.equal(f.physical(), 1); await adapter.close();
   const nextRoot = join(f.directory, 'next-session'); await mkdir(nextRoot); const reopened = await constructAdapter({ ...host, directory: nextRoot }, { ...f.input, sessionId: 'session-next' }, ports); facts.nextSession = reopened.ok ? true : reopened.error; await persist();
   if (mode === 'length' || mode === 'length-budget') { assert.equal(reopened.ok, true); adapter = reopened.value; const explicit = await adapter.execute({ ...command, commandId: 'new-explicit-length' }); facts.outcomes.push(explicit); await persist(); failedExecution(explicit); assert.equal(f.physical(), mode === 'length-budget' ? 1 : 2); assert.equal(facts.state.counts.requests, mode === 'length-budget' ? 1 : 2); if (mode === 'length-budget') assert.equal(explicit.value.error.stateErrorCode, 'BUDGET_EXHAUSTED'); }
   else { assert.equal(reopened.ok, false); assert.equal(reopened.error.code, 'RECOVERY_REQUIRED'); assert.equal(f.physical(), 1); }
  }
  else if (mode === 'overflow') {
   settledExecution(outcome); const second = await adapter.execute({ ...command, commandId: 'second' }); facts.outcomes.push(second); await persist(); failedExecution(second, 'EVENT_OVERFLOW'); assert.equal(f.physical(), 1);
   try { for await (const event of adapter.events()) facts.events.push(event); } catch (error) { facts.terminalEvent = closedFailure(error); } assert.equal(facts.terminalEvent.code, 'EVENT_OVERFLOW'); assert.equal(facts.events.length, 5);
  } else if (mode === 'disconnect') { failedExecution(outcome); assert.equal(f.physical(), 1); assert.ok(facts.state.counts.unresolvedRequests > 0 || facts.state.counts.dispatchedRequests > 0); const cancelled = await adapter.cancel({ reason: 'consumer_disconnected' }); facts.cancelled = cancelled; await persist(); assert.equal(cancelled.ok, true); assert.equal(cancelled.value.status, 'recovery_required'); assert.equal(cancelled.value.localCleanup, 'complete'); }
  else if (mode === 'deadline') { settledExecution(outcome); const begin = performance.now(); await consuming; facts.idleDeadlineWaitMs = performance.now() - begin; const after = await adapter.execute({ ...command, commandId: 'after-deadline' }); facts.outcomes.push(after); await persist(); assert.equal(after.ok, false); assert.equal(f.physical(), 1); assert.ok(facts.events.some(event => event.kind === 'cancellation' && event.code === 'DEADLINE')); assert.ok(facts.events.some(event => event.kind === 'process_exit')); }
  else if (mode === 'history') { settledExecution(outcome); const capture = await adapter.capture({ checkpointId: 'large-native' }); facts.capture = capture.ok ? { session: capture.value.session } : capture.error; await persist(); assert.equal(capture.ok, true); assert.ok(capture.value.session.byteLength > 1048576); assert.ok(capture.value.session.byteLength <= 8388608); }
  else if (mode === 'transcript-overflow' || mode === 'diagnostic') { failedExecution(outcome); assert.equal(f.physical(), 1); const again = await adapter.execute({ ...command, commandId: 'after-overflow' }); facts.outcomes.push(again); await persist(); assert.equal(again.ok, false); assert.equal(f.physical(), 1); }
  else { settledExecution(outcome); if (mode === 'slow') { assert.equal(facts.eventQueueHighWater, 2); assert.ok(facts.publishMaxMs >= 20); } }
  facts.passed = true;
 } catch (error) { facts.exception = closedFailure(error); process.exitCode = 1; await persist(); }
 finally {
  try { if (adapter) { facts.closed = await adapter.close(); if (!facts.closed.ok) process.exitCode = 1; } if (consuming) await consuming;
   if (mode === 'diagnostic' && runtime) { const bytes = await readFile(join(runtime.directory, 'private-sdk-stderr')); facts.diagnostic = { bytes: bytes.length, encoded: true, truncated: JSON.parse(bytes.toString()).truncated }; assert.ok(bytes.length <= f.input.policy.limits.diagnosticBytes); assert.equal(facts.diagnostic.truncated, true); assert.ok([...bytes.toString().trimEnd()].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)); assert.ok(!bytes.toString().includes('::error::')); }
   assert.ok(!canonical(facts.events).includes('PRIVATE_PROMPT_MARKER')); assert.ok(!canonical(facts.events).includes('PRIVATE_ASSISTANT_MARKER')); assert.ok(!canonical(facts.events).includes('SYNTHETIC_HOST_SECRET')); await persist();
   for (const [index, intent] of registry.roles.entries()) for (const file of ['container-intent.json', 'container-id.json', 'cleanup.json', 'cli-exit.json']) { try { await writeFile(join(directory, index + '-' + file), await readFile(join(intent.directory, file))); } catch { /* Missing evidence remains unknown. */ } }
   reclaimRoles(registryPath, registry);
  } finally { clearInterval(timer); Events.prototype.push = oldPush; await f.cleanup(); }
 }
 results.push(facts); if (process.exitCode) break;
}
await writeFile(join(raw, 'summary.json'), JSON.stringify({ passed: !process.exitCode, cases: results.length, results, level: 'actual SDK lifecycle with controlled HTTP; constructor-selected private native fixtures; no live provider' })); console.log(JSON.stringify({ passed: !process.exitCode, cases: results.length }));
