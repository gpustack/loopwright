import { failedExecution, settledExecution } from './outcome-checks.mjs';
/* global process, console, Buffer, structuredClone */
import { dockerSocket } from './docker-socket.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdir, writeFile, readdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { constructAdapter, runtimePorts } from '../dist/adapter.js';
import { RuntimeSession, profileIdentity } from '../dist/session-host.js';
import { OwnedContainer } from '../dist/containers.js';
import { Sender } from '../dist/sender.js';
import { digest } from '../dist/boundary.js';
import { closedFailure, boundedState, receiptDigests } from './diagnostics.mjs';
import { reclaimRoles } from './role-cleanup.mjs';
import { requestFixture } from '../../../.test-build/packages/agent-pi/test/request-fixtures.js';
import { sessionInput } from '../../../.test-build/packages/agent-pi/test/session-fixtures.js';
import { admitTask, digestArtifact } from '@loopwright/core';
const nonce = randomBytes(8).toString('hex'), registryPath = resolve(process.argv[2] ?? '.claude/s03-tools-' + nonce + '.json');
const raw = resolve(process.argv[3] ?? '.claude/s03-tools-' + nonce); await mkdir(raw, { recursive: true });
const image = (await readFile('.claude/s03-t0/runtime-image.id', 'utf8')).trim(), dockerExecutable = execFileSync('/usr/bin/which', ['docker'], { encoding: 'utf8' }).trim();
const registry = { kind: 'restricted-roles-v1', dockerSocket: dockerSocket(), dockerConfig: resolve('.claude/s03-t0/docker-client'), roles: [] }, results = []; const persistRegistry = () => writeFile(registryPath, JSON.stringify(registry)); await persistRegistry();
const originalStart = OwnedContainer.prototype.start;
OwnedContainer.prototype.start = async function(signal) { registry.roles.push({ directory: this.directory, name: this.name, labels: this.labels, image }); await persistRegistry(); return originalStart.call(this, signal); };
const good = result => { assert.equal(result.ok, true); return result.value; };
function input() {
 const value = sessionInput(), task = structuredClone(value.lock.spec.contract); task.spec.roles[0].tools = ['read', 'bash', 'write', 'edit']; task.spec.budgets.wallTimeMs = 90000;
 value.lock = good(admitTask(task, { admissionId: 'admission-1', runId: 'run-1' })); value.policy.tools = task.spec.roles[0].tools;
 const bytes = Buffer.from('PROTECTED_BASELINE'); value.candidate.artifacts.push({ name: 'packages/policy/config.txt', bytes }); value.candidate.manifest.spec.entries.push(good(digestArtifact('packages/policy/config.txt', bytes))); return value;
}
function stream(calls) {
 const frames = [{ type: 'message_start', message: { id: 'fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-5.5', content: [], usage: { input_tokens: 4, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }];
 for (const [index, call] of calls.entries()) frames.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: 'call-' + index, name: call.name, input: {} } }, { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.args) } }, { type: 'content_block_stop', index });
 if (!calls.length) frames.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } }, { type: 'content_block_stop', index: 0 });
 frames.push({ type: 'message_delta', delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }, { type: 'message_stop' });
 return frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join('');
}
let controls = 0; const control = http.createServer((_request, response) => { controls++; response.end('KNOWN_REACHABLE'); });
await new Promise(resolve => control.listen(0, '0.0.0.0', resolve)); const port = control.address().port;
assert.equal(await (await globalThis.fetch('http://127.0.0.1:' + port)).text(), 'KNOWN_REACHABLE'); const baseline = controls;
let passed = false;
const selected = process.argv[4] ?? 'all';
const cases = selected === 'positive' ? ['positive'] : ['positive', 'protected', 'new-protected', 'case-alias', 'traversal', 'absolute-host', 'rename-shape', 'oversized-output', 'stubborn-descendants'];
try {
 for (const mode of cases) {
  let calls = [], f;
  const facts = { mode, image, physical: 'unknown', state: { available: false }, operations: 'unknown', receipts: { available: false }, requests: [], closed: 'unknown' };
  f = await requestFixture(call => ({ status: 200, body: stream(call === 1 ? calls : []) }), input);
  let adapter;
  const persist = async () => { facts.physical = f.physical(); facts.state = boundedState(f.host.store); facts.receipts = await receiptDigests(f.host.artifactsDirectory); const operations = f.host.store.listOperations({ limit: 32, cursor: null }); facts.operations = operations.ok && operations.value.next === null ? operations.value.items.map(record => ({ id: record.intent.operationId, effect: record.intent.effect, state: record.state, target: record.intent.targetIdentity, outcome: record.initialReceipt?.outcome ?? null, dispatchId: record.dispatch?.dispatchId ?? null, parent: record.initialReceipt?.evidence.subject.requestId ?? null })) : 'unknown'; await writeFile(join(raw, mode + '.json'), JSON.stringify(facts)); };
  try {
   await writeFile(join(f.directory, 'host-canary'), 'SYNTHETIC_HOST_ONLY_CANARY');
   const script = `import assert from 'node:assert/strict'; import fs from 'node:fs/promises'; import net from 'node:net'; import dns from 'node:dns/promises';
await fs.writeFile('/scratch/allowed', 'SCRATCH_OK'); assert.equal(await fs.readFile('/scratch/allowed', 'utf8'), 'SCRATCH_OK');
for (const path of ['/etc/lw-probe','/opt/loopwright/lw-probe','/workspace/candidate/packages/example.ts','/workspace/candidate/packages/policy/config.txt','/workspace/candidate/packages/policy/new.txt','/workspace/candidate/packages/new-from-shell.txt']) await assert.rejects(fs.writeFile(path,'DENIED'));
await fs.symlink('/workspace/candidate/packages/policy/config.txt','/scratch/link'); await assert.rejects(fs.writeFile('/scratch/link','DENIED'));
await assert.rejects(fs.link('/workspace/candidate/packages/policy/config.txt','/scratch/hard')); await assert.rejects(fs.rename('/scratch/allowed','/workspace/candidate/packages/policy/config.txt'));
await assert.rejects(fs.readFile(${JSON.stringify(join(f.directory, 'host-canary'))})); assert.equal(process.env.LW_SYNTHETIC_SECRET, undefined); assert.equal(process.env.GITHUB_TOKEN, undefined); assert.equal(process.env.ANTHROPIC_API_KEY, undefined); assert.equal(process.getuid(),1000);
const denied = (host,port) => new Promise((resolve,reject) => { const socket=net.connect({host,port}); const timer=setTimeout(()=>{socket.destroy(); resolve();},300); socket.once('connect',()=>{clearTimeout(timer);socket.destroy();reject(new Error('unexpected egress'));});socket.once('error',()=>{clearTimeout(timer);socket.destroy();resolve();}); });
await denied('1.1.1.1',80); await denied('2606:4700:4700::1111',80); await denied('host.docker.internal',${port}); await assert.rejects(dns.lookup('example.com'));
assert.equal(await fs.readFile('/workspace/candidate/packages/new.txt','utf8'),'ALLOWED_2'); console.log('REAL_SCRATCH_AND_CONTAINMENT_OK');`;
   if (mode === 'positive') calls = [{ name: 'write', args: { path: 'packages/new.txt', content: 'ALLOWED_1' } }, { name: 'edit', args: { path: 'packages/new.txt', edits: [{ oldText: 'ALLOWED_1', newText: 'ALLOWED_2' }] } }, { name: 'read', args: { path: 'packages/new.txt' } }, { name: 'bash', args: { command: "node --input-type=module <<'LW_EOF'\n" + script + '\nLW_EOF', timeout: 5 } }, { name: 'bash', args: { command: 'test ! -e /scratch/allowed && echo FRESH_SCRATCH_OK', timeout: 5 } }];
   else if (mode === 'oversized-output') calls = [{ name: 'bash', args: { command: "node -e 'process.stdout.write(\"X\".repeat(131072))'", timeout: 5 } }];
   else if (mode === 'stubborn-descendants') calls = [{ name: 'bash', args: { command: "node -e 'const {spawn}=require(\"node:child_process\"); const child=spawn(process.execPath,[\"-e\",\"process.on(\\\"SIGTERM\\\",()=>{});setInterval(()=>{},1000)\"],{detached:true,stdio:\"ignore\"});child.unref();console.log(\"DESCENDANT_STARTED\")'", timeout: 5 } }];
   else if (mode === 'rename-shape') calls = [{ name: 'write', args: { path: 'packages/new.txt', content: 'DENIED', rename: 'packages/policy/config.txt' } }];
   else calls = [{ name: mode === 'absolute-host' ? 'read' : 'write', args: { path: { protected: 'packages/policy/config.txt', 'new-protected': 'packages/policy/new.txt', 'case-alias': 'packages/Policy/new.txt', traversal: 'packages/../escape.txt', 'absolute-host': join(f.directory, 'host-canary') }[mode], ...(mode === 'absolute-host' ? {} : { content: 'DENIED' }) } }];
   f.input.policy.runtime = { ...f.input.policy.runtime, imageDigest: image, graphDigest: digest(await readFile('package-lock.json')), configDigest: await profileIdentity() };
   const host = { ...f.host, dockerExecutable, dockerSocket: dockerSocket(), runtime: f.input.policy.runtime };
   const ports = { ...runtimePorts, sender: (owner, value) => new Sender(owner, value, { fetch: (_url, options) => { const body = JSON.parse(String(options.body)); facts.requests.push({ tools: body.tools?.map(tool => tool.name) ?? [], results: body.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'tool_result').map(block => ({ tool_use_id: block.tool_use_id, is_error: block.is_error === true, text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content) })) : []) }); return globalThis.fetch(f.destination, options); } }), session: (owner, value, broker, directory) => {
    const session = new RuntimeSession(owner, value, broker, directory), start = session.start.bind(session); session.start = async () => { registry.roles.push({ directory, name: session.name, labels: { 'org.loopwright.generation': String(owner.authority.generation), 'org.loopwright.run': value.lock.spec.runId, 'org.loopwright.session': value.sessionId, 'org.loopwright.nonce': session.nonce }, image }); await persistRegistry(); return start(); }; return session;
   } };
   const opened = await constructAdapter(host, f.input, ports); facts.opened = opened.ok ? true : opened.error; await persist(); assert.equal(opened.ok, true); adapter = opened.value;
   facts.capabilities = adapter.capabilities().toolExecution; await persist();
   const outcome = await adapter.execute({ commandId: 'tools-' + mode, text: 'literal tool qualification', purpose: 'task', repair: 'none' }); facts.outcome = outcome; await persist();
   const candidate = join(host.directory, 'sdk-' + f.input.sessionId, 'candidate');
   assert.equal(await readFile(join(candidate, 'packages/policy/config.txt'), 'utf8'), 'PROTECTED_BASELINE'); assert.equal(await readFile(join(f.directory, 'host-canary'), 'utf8'), 'SYNTHETIC_HOST_ONLY_CANARY'); assert.equal(controls, baseline);
   if (mode === 'positive') {
    settledExecution(outcome); assert.equal(await readFile(join(candidate, 'packages/new.txt'), 'utf8'), 'ALLOWED_2'); assert.equal(f.physical(), 2); assert.equal(facts.operations.length, 7); assert.ok(facts.operations.every(record => record.state === 'confirmed'));
    const responses = facts.requests.at(-1).results; assert.equal(responses.length, 5); assert.ok(responses.every(result => !result.is_error)); assert.ok(responses.some(result => result.text.includes('ALLOWED_2'))); assert.ok(responses.some(result => result.text.includes('REAL_SCRATCH_AND_CONTAINMENT_OK'))); assert.ok(responses.some(result => result.text.includes('FRESH_SCRATCH_OK')));
   } else if (mode === 'stubborn-descendants') { settledExecution(outcome); assert.equal(f.physical(), 2); assert.equal(facts.operations.length, 3); }
   else { failedExecution(outcome, mode === 'oversized-output' ? 'OUTPUT_LIMIT' : undefined); assert.equal(f.physical(), 1); await assert.rejects(readFile(join(candidate, 'packages/policy/new.txt'))); if (mode !== 'oversized-output') assert.equal(facts.operations.length, 1); }
   results.push(facts);
  } catch (error) { facts.exception = closedFailure(error); await persist(); throw error; }
  finally {
   try { if (adapter) { const closed = await adapter.close(); facts.closed = closed.ok; await persist(); assert.equal(closed.ok, true); } }
   finally {
    let rolesAbsent = false;
    try {
     for (const [index, intent] of registry.roles.filter(role => role.directory.startsWith(f.directory + '/')).entries()) for (const file of ['container-intent.json', 'container-id.json', 'inspect.json', 'cleanup.json', 'cli-exit.json']) { try { await writeFile(join(raw, mode + '-' + index + '-' + file), await readFile(join(intent.directory, file))); } catch { /* Missing evidence remains explicit in the case facts and registry. */ } }
     facts.remainingArtifacts = await readdir(f.host.artifactsDirectory); await persist(); reclaimRoles(registryPath, registry); rolesAbsent = true;
    } finally { await f.cleanup(!rolesAbsent); }
   }
  }
 }
 passed = true;
} catch (error) { await writeFile(join(raw, 'failure.json'), JSON.stringify({ failure: closedFailure(error), image, results })); process.exitCode = 1; }
finally { OwnedContainer.prototype.start = originalStart; control.closeAllConnections(); await new Promise(resolve => control.close(resolve)); try { reclaimRoles(registryPath, registry); } catch (error) { passed = false; process.exitCode = 1; await writeFile(join(raw, 'cleanup-failure.json'), JSON.stringify({ failure: closedFailure(error) })); } }
if (passed && process.exitCode !== 1) { await writeFile(join(raw, 'summary.json'), JSON.stringify({ passed: true, image, cases: results.length, results, controlRequestsFromContainers: controls - baseline, level: 'actual SDK/raw parser/owner S02/native read/bash in separate tool containers; host mediated write/edit; controlled HTTP only' })); console.log(JSON.stringify({ passed: true, image, cases: results.length })); }
