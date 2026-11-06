/* global process, console, Buffer, structuredClone, setTimeout, clearTimeout */
import { dockerSocket } from './docker-socket.mjs';
import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { admitTask } from '@loopwright/core';
import { constructAdapter, runtimePorts } from '../dist/adapter.js';
import { RuntimeSession, profileIdentity } from '../dist/session-host.js';
import { Sender } from '../dist/sender.js';
import { canonical, digest } from '../dist/boundary.js';
import { closedFailure, boundedState } from './diagnostics.mjs';
import { reclaimRoles } from './role-cleanup.mjs';
import { requestFixture, stateGood } from '../../../.test-build/packages/agent-pi/test/request-fixtures.js';
import { sessionInput } from '../../../.test-build/packages/agent-pi/test/session-fixtures.js';
const raw = resolve(process.argv[2]); await mkdir(raw, { recursive: true }); const image = (await readFile('.claude/s03-t0/runtime-image.id', 'utf8')).trim(), dockerExecutable = execFileSync('/usr/bin/which', ['docker'], { encoding: 'utf8' }).trim(), results = [];
function stream(tool = false) {
 const frames = [{ type: 'message_start', message: { id: 'fixture', role: 'assistant', model: 'claude-sonnet-5.5', content: [], usage: { input_tokens: 4, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }];
 if (tool) frames.push({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'crash-write', name: 'write', input: {} } }, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ path: 'packages/example.ts', content: 'CRASH_EFFECT_MARKER' }) } });
 else frames.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'KNOWN_BASELINE' } });
 frames.push({ type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' }); return frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join('');
}
function input() { const value = sessionInput(), task = structuredClone(value.lock.spec.contract); task.spec.roles[0].tools = ['read', 'write']; task.spec.budgets.wallTimeMs = 90000; const admitted = admitTask(task, { admissionId: 'admission-1', runId: 'run-1' }); assert.equal(admitted.ok, true); value.lock = admitted.value; value.policy.tools = task.spec.roles[0].tools; return value; }
for (const mode of process.argv[3] ? [process.argv[3]] : ['before-artifact', 'before-checkpoint', 'after-checkpoint', 'provider-before-receipt', 'receipt-before-sdk-ack', 'tool-before-receipt']) {
 const f = await requestFixture(call => ({ status: 200, body: stream(mode === 'tool-before-receipt' && call === 2) }), input), directory = join(raw, mode); await mkdir(directory, { recursive: true });
 const registryPath = join(directory, 'ownership.json'), facts = { mode, image, physical: 'unknown', state: { available: false }, baseline: false, boundary: null, exit: null }, persist = async () => { facts.physical = f.physical(); facts.state = boundedState(f.host.store); await writeFile(join(directory, 'facts.json'), JSON.stringify(facts)); };
 let child, adapter, baseline, activeAuthority = f.host.authority; const messages = [], waiters = []; let exit;
 const next = async () => { if (messages.length) return messages.shift(); let timer; try { return await new Promise((resolve, reject) => { waiters.push(resolve); timer = setTimeout(() => reject(new Error('Crash fixture boundary deadline')), 30000); }); } finally { clearTimeout(timer); } };
 try {
  f.input.policy.runtime = { ...f.input.policy.runtime, imageDigest: image, graphDigest: digest(await readFile('package-lock.json')), configDigest: await profileIdentity() };
  const host = { ...f.host, runtime: f.input.policy.runtime, dockerExecutable, dockerSocket: dockerSocket() }, serialized = { ...f.input, candidate: { ...f.input.candidate, artifacts: f.input.candidate.artifacts.map(value => ({ ...value, bytes: Buffer.from(value.bytes).toString('base64') })) }, resources: f.input.resources.map(value => ({ ...value, bytes: Buffer.from(value.bytes).toString('base64') })) };
  await writeFile(join(f.directory, 'child-input.json'), JSON.stringify({ mode, input: serialized, identity: f.identity, host: { authority: host.authority, directory: host.directory, artifactsDirectory: host.artifactsDirectory, dockerExecutable, dockerSocket: host.dockerSocket }, destination: f.destination, registry: registryPath, dockerConfig: resolve('.claude/s03-t0/docker-client') }), { mode: 0o600 });
  child = fork('packages/agent-pi/qualification/recovery-crash-child.mjs', [join(f.directory, 'child-input.json')], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: f.directory, LANG: 'C.UTF-8' } });
  child.on('message', message => { const waiter = waiters.shift(); if (waiter) waiter(message); else messages.push(message); }); exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const first = await next(); facts.first = first.kind; if (first.kind === 'baseline') { baseline = first.capture; facts.baseline = true; } await persist(); assert.equal(first.kind, 'baseline');
  const boundary = await next(); facts.boundary = boundary; await persist(); assert.equal(boundary.kind, 'boundary'); assert.equal(boundary.phase, mode); assert.equal(f.physical(), 2);
  if (!['provider-before-receipt', 'tool-before-receipt'].includes(mode)) {
   if (mode === 'before-checkpoint') { await new Promise(resolve => setTimeout(resolve, 1100)); const expired = stateGood(f.host.store.inspect()); activeAuthority = stateGood(f.host.store.claim({ ownerId: 'fenced-before-death', expectedGeneration: expired.owner.generation, expectedRevision: expired.revision, mode: 'active' })).authority; facts.oldOwnerStillAliveAfterLease = child.exitCode === null && child.signalCode === null; }
   await mkdir(join(f.directory, 'competing')); const competing = await constructAdapter({ ...host, authority: activeAuthority, directory: join(f.directory, 'competing') }, f.input, runtimePorts); facts.competing = competing.ok ? true : competing.error; await persist(); assert.equal(competing.ok, false); assert.equal(competing.error.code, 'SESSION_BUSY');
  }
  child.kill('SIGKILL'); facts.exit = await exit; await persist(); assert.equal(facts.exit.signal, 'SIGKILL');
  stateGood(f.host.store.release(activeAuthority)); const view = stateGood(f.host.store.inspect()), claim = stateGood(f.host.store.claim({ ownerId: 'replacement', expectedGeneration: view.owner.generation, expectedRevision: view.revision, mode: 'active' }));
  const checkpoint = f.host.store.getCheckpoint('target-1'); facts.targetPublished = checkpoint.ok; await persist(); assert.equal(checkpoint.ok, mode === 'after-checkpoint');
  const selected = checkpoint.ok ? { checkpointId: 'target-1', candidate: baseline.candidate, workspace: checkpoint.value.workspace, session: checkpoint.value.privateSession } : baseline;
  const restoredInput = { ...f.input, candidate: { ...f.input.candidate, manifest: selected.candidate }, restore: { checkpointId: selected.checkpointId, workspace: { ref: selected.workspace, bytes: await readFile(join(host.artifactsDirectory, selected.workspace.name)) }, session: { ref: selected.session, bytes: await readFile(join(host.artifactsDirectory, selected.session.name)) } } };
  await mkdir(join(f.directory, 'replacement')); const restored = await constructAdapter({ ...host, authority: claim.authority, directory: join(f.directory, 'replacement') }, restoredInput, { ...runtimePorts, sender: (owner, value) => new Sender(owner, value, { fetch: (_url, init) => globalThis.fetch(f.destination, init) }), session: (owner, value, broker, path) => { const runtime = new RuntimeSession(owner, value, broker, path), start = runtime.start.bind(runtime); runtime.start = async () => { const registry = JSON.parse(await readFile(registryPath, 'utf8')); registry.roles.push({ directory: path, name: runtime.name, image, labels: { 'org.loopwright.generation': String(owner.authority.generation), 'org.loopwright.run': value.lock.spec.runId, 'org.loopwright.session': value.sessionId, 'org.loopwright.nonce': runtime.nonce } }); await writeFile(registryPath, JSON.stringify(registry)); return start(); }; return runtime; } }); facts.restored = restored.ok ? true : restored.error; await persist();
  const uncertain = mode === 'provider-before-receipt' || mode === 'tool-before-receipt'; assert.equal(restored.ok, !uncertain); assert.equal(f.physical(), 2);
  if (restored.ok) { adapter = restored.value; const now = stateGood(f.host.store.inspect()); assert.equal(now.counts.requests, 2); assert.equal(canonical(now.clock.basis), canonical(view.clock.basis)); facts.recoveryFiles = (await readdir(host.artifactsDirectory)).filter(name => name.startsWith('pi-recovery-')); assert.equal(facts.recoveryFiles.length, 1); facts.recoveryReceipt = JSON.parse(await readFile(join(host.artifactsDirectory, facts.recoveryFiles[0]), 'utf8')); assert.equal(facts.recoveryReceipt.deathConfirmed, true); }
  else { assert.equal(restored.error.code, 'RECOVERY_REQUIRED'); assert.ok(facts.state.counts.unresolvedRequests > 0 || facts.state.counts.dispatchedRequests > 0 || facts.state.counts.unresolvedOperations > 0); }
  if (mode === 'tool-before-receipt') { facts.marker = await readFile(join(host.directory, 'sdk-session-1/candidate/packages/example.ts'), 'utf8') === 'CRASH_EFFECT_MARKER'; assert.equal(facts.marker, true); }
  facts.passed = true; await persist(); results.push(facts);
 } catch (error) { facts.exception = closedFailure(error); await persist(); process.exitCode = 1; }
 finally {
  if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); if (exit) facts.exit = await exit;
  try { if (adapter) { facts.closed = await adapter.close(); if (!facts.closed.ok) process.exitCode = 1; } await persist();
   try { reclaimRoles(registryPath); } catch (error) { facts.cleanupFailure = closedFailure(error); await persist(); process.exitCode = 1; }
  } finally { await f.cleanup(); }
 }
 if (process.exitCode) break;
}
await writeFile(join(raw, 'summary.json'), JSON.stringify({ passed: !process.exitCode, cases: results.length, results, level: 'real SIGKILL of native SDK owner at production capture/provider/parser/tool boundaries; retained original local S02 store; controlled HTTP only' })); console.log(JSON.stringify({ passed: !process.exitCode, cases: results.length }));
