import { settledExecution } from './outcome-checks.mjs';
/* global process, console, structuredClone */
import { dockerSocket } from './docker-socket.mjs';
import { admitTask } from '@loopwright/core';
import { sessionInput } from '../../../.test-build/packages/agent-pi/test/session-fixtures.js';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { constructAdapter, runtimePorts } from '../dist/adapter.js';
import { RuntimeSession, profileIdentity } from '../dist/session-host.js';
import { OwnedContainer } from '../dist/containers.js';
import { Sender } from '../dist/sender.js';
import { Channel } from '../dist/protocol.js';
import { canonical, digest } from '../dist/boundary.js';
import { boundedState, closedFailure } from './diagnostics.mjs';
import { reclaimRoles } from './role-cleanup.mjs';
import { requestFixture, stateGood } from '../../../.test-build/packages/agent-pi/test/request-fixtures.js';
const registryPath = resolve(process.argv[2]), raw = resolve(process.argv[3]); await mkdir(raw, { recursive: true });
const registry = { kind: 'restricted-roles-v1', dockerSocket: dockerSocket(), dockerConfig: resolve('.claude/s03-t0/docker-client'), roles: [] }, image = (await readFile('.claude/s03-t0/runtime-image.id', 'utf8')).trim();
const followup = process.argv[4] === 'followup', compact = process.argv[4] === 'compact', tools = process.argv[4] === 'tools', codemode = process.argv[4] === 'codemode', beforePhysical = followup || tools || codemode ? 2 : compact ? 3 : 1;
const facts = { image, physical: 'unknown', native: [], outcomes: [], events: [], state: { available: false }, closed: [] }, runtimes = new Map(), originalEmit = Channel.prototype.emit;
Channel.prototype.emit = function(event, message, ...rest) { if (runtimes.has(this.nonce) && event === 'message' && message?.kind === 'settled') facts.native.push(message.body.native); return originalEmit.call(this, event, message, ...rest); };
const frames = [{ type: 'message_start', message: { id: 'fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-5.5', content: [], usage: { input_tokens: 4, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'NATIVE_CAPTURE_MARKER' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' }];
const originalStart = OwnedContainer.prototype.start; OwnedContainer.prototype.start = async function(signal) { registry.roles.push({ directory: this.directory, name: this.name, image, labels: this.labels }); await writeFile(registryPath, JSON.stringify(registry)); return originalStart.call(this, signal); };
const scriptDigest = digest(await readFile('packages/agent-pi/dist/workspace-mcp.js'));
const toolFrames = [frames[0], { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'capture-write', name: codemode ? 'codemode' : 'write', input: {} } }, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(codemode ? { code: 'text(await tools.mcp__workspace__read_file({path: "packages/example.ts"})); text(await tools.read({path: "packages/example.ts"}));' } : { path: 'packages/new.txt', content: 'NATIVE_COMMITTED_CAPTURE' }) } }, frames[3], { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } }, frames[5]];
const f = await requestFixture(call => ({ status: 200, body: ((tools || codemode) && call === 1 ? toolFrames : frames).map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join('') }), () => { const value = sessionInput(); if (tools || codemode) { const task = structuredClone(value.lock.spec.contract); task.spec.roles[0].tools = codemode ? ['read', 'codemode', 'mcp__workspace__read_file'] : ['read', 'write']; const lock = admitTask(task, { admissionId: 'admission-1', runId: 'run-1' }); assert.equal(lock.ok, true); value.lock = lock.value; value.policy.tools = task.spec.roles[0].tools; if (codemode) value.policy.mcp = { ...value.policy.mcp, scriptDigest, names: ['mcp__workspace__read_file'], effects: ['read_only'] }; } return value; });
let adapter, restored; const consumers = [];
const persist = async () => { facts.physical = f.physical(); facts.state = boundedState(f.host.store); await writeFile(join(raw, 'facts.json'), JSON.stringify(facts)); await writeFile(registryPath, JSON.stringify(registry)); };
try {
 f.input.policy.runtime = { ...f.input.policy.runtime, imageDigest: image, graphDigest: digest(await readFile('package-lock.json')), configDigest: await profileIdentity() };
 const host = { ...f.host, runtime: f.input.policy.runtime, dockerExecutable: execFileSync('/usr/bin/which', ['docker'], { encoding: 'utf8' }).trim(), dockerSocket: dockerSocket() };
 const ports = { ...runtimePorts, sender: (owner, input) => new Sender(owner, input, { fetch: (_url, init) => globalThis.fetch(f.destination, init) }), session: (owner, input, broker, directory) => {
  const runtime = new RuntimeSession(owner, input, broker, directory); runtimes.set(runtime.nonce, runtime); registry.roles.push({ directory, name: runtime.name, image, labels: { 'org.loopwright.generation': String(owner.authority.generation), 'org.loopwright.run': input.lock.spec.runId, 'org.loopwright.session': input.sessionId, 'org.loopwright.nonce': runtime.nonce } }); if (followup) { const docker = runtime.docker.bind(runtime); runtime.docker = args => { if (args[0] !== 'create') return docker(args); const changed = [...args]; assert.equal(changed.at(-2), '/opt/loopwright/packages/agent-pi/dist/sdk-worker.js'); changed[changed.length - 2] = '/opt/loopwright/packages/agent-pi/qualification/lifecycle-followup-child.mjs'; return docker(changed); }; } const start = runtime.start.bind(runtime); runtime.start = async () => { await persist(); return start(); }; return runtime;
 } };
 const opened = await constructAdapter(host, f.input, ports); facts.opened = opened.ok ? true : opened.error; await persist(); assert.equal(opened.ok, true); adapter = opened.value;
 consumers.push((async () => { for await (const event of adapter.events()) facts.events.push(event); })()); assert.equal(f.physical(), 0);
 const outcome = await adapter.execute({ commandId: 'first', text: 'literal private capture input', purpose: 'task', repair: 'none' }); facts.outcomes.push(outcome); await persist(); settledExecution(outcome); assert.equal(f.physical(), followup || tools || codemode ? 2 : 1);
 if (compact) { const second = await adapter.execute({ commandId: 'before-compact', text: 'X'.repeat(16384), purpose: 'task', repair: 'none' }); facts.outcomes.push(second); await persist(); settledExecution(second); const summary = await adapter.compact({ commandId: 'manual-summary' }); facts.outcomes.push(summary); await persist(); settledExecution(summary); assert.equal(f.physical(), beforePhysical); }
 const capture = await adapter.capture({ checkpointId: 'safe-1' }); facts.capture = capture.ok ? capture.value : capture.error; await persist(); assert.equal(capture.ok, true);
 const again = await adapter.capture({ checkpointId: 'safe-1' }); facts.lookup = again.ok; await persist(); assert.equal(again.ok, true); assert.equal(canonical(again.value), canonical(capture.value));
 const input = { ...f.input, candidate: { ...f.input.candidate, manifest: capture.value.candidate, artifacts: await Promise.all(capture.value.candidate.spec.entries.map(async ref => ({ name: ref.name, bytes: await readFile(join(host.directory, 'sdk-' + f.input.sessionId, 'candidate', ref.name)) }))) }, restore: { checkpointId: 'safe-1', workspace: { ref: capture.value.workspace, bytes: await readFile(join(host.artifactsDirectory, capture.value.workspace.name)) }, session: { ref: capture.value.session, bytes: await readFile(join(host.artifactsDirectory, capture.value.session.name)) } } };
 const before = stateGood(f.host.store.inspect()); facts.countsBeforeRestore = before.counts; facts.clockBasis = before.clock.basis;
 const closed = await adapter.close(); facts.closed.push(closed); await persist(); assert.equal(closed.ok, true); await consumers[0];
 await mkdir(join(f.directory, 'restored-runtime')); const resumed = await constructAdapter({ ...host, directory: join(f.directory, 'restored-runtime') }, input, ports); facts.restored = resumed.ok ? true : resumed.error; await persist(); assert.equal(resumed.ok, true); restored = resumed.value;
 consumers.push((async () => { for await (const event of restored.events()) facts.events.push(event); })()); assert.equal(f.physical(), beforePhysical); const after = stateGood(f.host.store.inspect()); assert.equal(canonical(after.counts), canonical(before.counts)); assert.equal(canonical(after.clock.basis), canonical(before.clock.basis));
 const next = await restored.execute({ commandId: 'explicit-after-restore', text: 'explicit new request', purpose: 'task', repair: 'none' }); facts.outcomes.push(next); await persist(); settledExecution(next); assert.equal(f.physical(), beforePhysical + (followup ? 2 : 1));
 assert.ok(f.captured[beforePhysical].body.includes('NATIVE_CAPTURE_MARKER')); if (!compact) assert.ok(f.captured[beforePhysical].body.includes('literal private capture input')); else { assert.equal(facts.native[2].compactionEnds, 1); assert.equal(facts.native[2].compacted, true); } facts.originalNativeContextRetained = true; if (codemode) { assert.ok(f.captured[beforePhysical].body.includes('mcp__workspace__read_file')); facts.nativeVmMcpPairingRetained = true; } if (tools) { assert.equal(capture.value.candidate.spec.entries.length, 2); assert.ok(f.captured[beforePhysical].body.includes('NATIVE_COMMITTED_CAPTURE')); facts.completedToolPairingRetained = true; } if (followup) { assert.equal(facts.native[0].agentEnds, 2); assert.equal(facts.native[0].agentSettles, 1); assert.equal(facts.native[0].invocations, 2); assert.equal(facts.native[0].parserAcks, 2); assert.equal(facts.native[0].pending, 0); }
 assert.ok(facts.events.every((event, index) => index === 0 || event.sequence > facts.events[index - 1].sequence));
 facts.passed = true; facts.level = 'actual native SDK capture/entries restore and controlled HTTP with original S02 ledger; no live provider'; await persist();
} catch (error) { facts.exception = closedFailure(error); await persist(); process.exitCode = 1; }
finally {
 try { for (const value of [restored, adapter]) if (value) { const closed = await value.close(); facts.closed.push(closed); if (!closed.ok) process.exitCode = 1; } await Promise.allSettled(consumers); await persist();
  for (const [index, intent] of registry.roles.entries()) for (const file of ['container-intent.json', 'container-id.json', 'cleanup.json', 'cli-exit.json']) { try { await writeFile(join(raw, index + '-' + file), await readFile(join(intent.directory, file))); } catch { /* Missing evidence remains unknown. */ } }
  reclaimRoles(registryPath, registry);
 } finally { Channel.prototype.emit = originalEmit; OwnedContainer.prototype.start = originalStart; await f.cleanup(); }
}
console.log(JSON.stringify({ passed: facts.passed === true && !process.exitCode, physical: facts.physical }));
