import { failedExecution, settledExecution } from './outcome-checks.mjs';
/* global process, console, Buffer, structuredClone, AbortSignal */
import { dockerSocket } from './docker-socket.mjs';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { constructAdapter, runtimePorts } from '../dist/adapter.js';
import { RuntimeSession, profileIdentity } from '../dist/session-host.js';
import { OwnedContainer } from '../dist/containers.js';
import { Sender } from '../dist/sender.js';
import { McpProcess } from '../dist/mcp-process.js';
import { digest } from '../dist/boundary.js';
import { closedFailure, boundedState, receiptDigests } from './diagnostics.mjs';
import { reclaimRoles } from './role-cleanup.mjs';
import { requestFixture } from '../../../.test-build/packages/agent-pi/test/request-fixtures.js';
import { sessionInput } from '../../../.test-build/packages/agent-pi/test/session-fixtures.js';
import { admitTask, digestArtifact } from '@loopwright/core';
import { McpClient } from '@earendil-works/pi-mcp';
const nonce = randomBytes(8).toString('hex'), registryPath = resolve(process.argv[2] ?? '.claude/s03-mcp-' + nonce + '.json');
const raw = resolve(process.argv[3] ?? '.claude/s03-mcp-' + nonce); await mkdir(raw, { recursive: true });
const image = (await readFile('.claude/s03-t0/runtime-image.id', 'utf8')).trim(), scriptDigest = digest(await readFile('packages/agent-pi/dist/workspace-mcp.js')), dockerExecutable = execFileSync('/usr/bin/which', ['docker'], { encoding: 'utf8' }).trim();
const registry = { kind: 'restricted-roles-v1', dockerSocket: dockerSocket(), dockerConfig: resolve('.claude/s03-t0/docker-client'), roles: [] }, results = []; const persistRegistry = () => writeFile(registryPath, JSON.stringify(registry)); await persistRegistry();
const originalStart = OwnedContainer.prototype.start;
OwnedContainer.prototype.start = async function(signal) { registry.roles.push({ directory: this.directory, name: this.name, labels: this.labels, image }); await persistRegistry(); return originalStart.call(this, signal); };
const good = result => { assert.equal(result.ok, true); return result.value; };
function input() {
 const value = sessionInput(), task = structuredClone(value.lock.spec.contract); task.spec.roles[0].tools = ['read', 'codemode', 'mcp__workspace__read_file']; task.spec.budgets.wallTimeMs = 90000;
 value.lock = good(admitTask(task, { admissionId: 'admission-1', runId: 'run-1' })); value.policy.tools = task.spec.roles[0].tools;
 value.policy.mcp = { ...value.policy.mcp, scriptDigest, names: ['mcp__workspace__read_file'], effects: ['read_only'] }; value.policy.limits.toolWallMs = 2000;
 value.policy.mcp.absoluteTimeoutSeconds = 3;
 const bytes = Buffer.from('PROTECTED_BASELINE'); value.candidate.artifacts.push({ name: 'packages/policy/config.txt', bytes }); value.candidate.manifest.spec.entries.push(good(digestArtifact('packages/policy/config.txt', bytes))); return value;
}
function stream(call) {
 const frames = [{ type: 'message_start', message: { id: 'fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-5.5', content: [], usage: { input_tokens: 4, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }];
 if (call) frames.push({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'root-1', name: call.name, input: {} } }, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.args) } }, { type: 'content_block_stop', index: 0 });
 else frames.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } }, { type: 'content_block_stop', index: 0 });
 frames.push({ type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }, { type: 'message_stop' }); return frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join('');
}
const definitions = {
 direct: { name: 'mcp__workspace__read_file', args: { path: 'packages/example.ts' } },
 nested: { name: 'codemode', args: { code: 'text(await tools.mcp__workspace__read_file({path:"packages/example.ts"})); text(await tools.read({path:"packages/example.ts"})); text([typeof process,typeof require,typeof fetch,typeof WebSocket,typeof models]);' } },
 'denied-direct': { name: 'mcp__workspace__denied_write', args: { path: 'packages/policy/config.txt' } },
 'denied-nested': { name: 'codemode', args: { code: 'await tools.mcp__workspace__denied_write({path:"packages/policy/config.txt"});' } },
 'denied-search': { name: 'codemode', args: { code: 'text(searchTools("denied_write")); await tools.mcp__workspace__denied_write({path:"packages/policy/config.txt"});' } },
 'models-classify': { name: 'codemode', args: { code: 'await models.classify({input:"DENIED"});' } },
 'models-images': { name: 'codemode', args: { code: 'await models.generateImages({prompt:"DENIED"});' } },
 'globals-fs': { name: 'codemode', args: { code: 'await import("node:fs");' } },
 'globals-network': { name: 'codemode', args: { code: 'await fetch("http://host.docker.internal/");' } },
 'globals-process': { name: 'codemode', args: { code: 'process.exit(0);' } },
 infinite: { name: 'codemode', args: { code: 'while(true){}' } },
 output: { name: 'codemode', args: { code: '// @options: {"max_output_tokens":100000}\ntext("X".repeat(131072));' } },
};
const fixtureModes = { 'hidden-direct': 'hidden', 'hidden-nested': 'hidden', 'hidden-search': 'hidden', quiet: 'quiet', progress: 'progress', 'frame-flood': 'frame-flood', 'total-flood': 'total-flood', stubborn: 'stubborn' };
definitions['hidden-direct'] = definitions['denied-direct']; definitions['hidden-nested'] = definitions['denied-nested']; definitions['hidden-search'] = definitions['denied-search'];
for (const name of ['quiet', 'progress', 'frame-flood', 'total-flood', 'stubborn']) definitions[name] = definitions.direct;
class FixtureProcess extends McpProcess {
 constructor(host, value, directory, candidate, mode) {
  super(host, value, directory, candidate); assert.ok(Object.values(fixtureModes).includes(mode)); const docker = this.container.docker.bind(this.container);
  this.container.docker = args => { if (args[0] !== 'create') return docker(args); const changed = [...args]; assert.equal(changed.at(-2), '/opt/loopwright/packages/agent-pi/dist/workspace-mcp.js'); changed[changed.length - 2] = '/opt/loopwright/packages/agent-pi/qualification/mcp-fixture-' + mode + '.mjs'; return docker(changed); };
 }
 async marker() {
  const container = this.container, id = JSON.parse(await readFile(join(container.directory, 'container-id.json'), 'utf8')).id, inspected = await container.inspect(id); assert.equal(inspected.Name, '/' + container.name); assert.equal(inspected.Image, image); assert.deepEqual(inspected.Config.Labels, container.labels);
  return JSON.parse(await container.docker(['exec', id, 'node', '--input-type=module', '-e', "import fs from 'node:fs/promises'; let forbidden=false;try{await fs.lstat('/scratch/denied-write-marker');forbidden=true;}catch(error){if(error.code!=='ENOENT')throw error;}let descendant=null;try{descendant=JSON.parse(await fs.readFile('/scratch/descendant.json','utf8'));process.kill(descendant.pid,0);}catch(error){if(error.code!=='ENOENT')throw error;}console.log(JSON.stringify({forbidden,descendant}));"]));
 }
}
const selected = process.argv[4] ?? 'all', cases = selected === 'positive' ? ['direct', 'nested'] : selected === 'fixtures' ? Object.keys(fixtureModes) : selected === 'all' ? Object.keys(definitions) : [selected]; assert.ok(cases.every(mode => definitions[mode])); let passed = false;
async function fixtureEffectControl() {
 const f = await requestFixture(undefined, input), candidate = join(f.host.directory, 'fixture-control'); let pipe, client, absent = false;
 const facts = { level: 'Independent trusted fixture positive control: direct public MCP client into owned scratch; bypasses production task authorization only for this test', physical: 'unknown', marker: 'unknown' };
 try {
  await mkdir(candidate, { mode: 0o755 }); for (const artifact of f.input.candidate.artifacts) { await mkdir(join(candidate, artifact.name, '..'), { recursive: true, mode: 0o755 }); await writeFile(join(candidate, artifact.name), artifact.bytes, { mode: 0o444 }); }
  f.input.policy.runtime = { ...f.input.policy.runtime, imageDigest: image, graphDigest: digest(await readFile('package-lock.json')), configDigest: await profileIdentity() };
  const host = { ...f.host, dockerExecutable, dockerSocket: dockerSocket(), runtime: f.input.policy.runtime };
  pipe = new FixtureProcess(host, f.input, join(host.directory, 'control-mcp'), candidate, 'hidden');
  const transport = { start: () => pipe.ready(AbortSignal.timeout(10000)), send: (message, options) => pipe.send(message, () => options?.signal?.throwIfAborted()), close: async () => { await pipe.close(); },
   onMessage: listener => { pipe.on('message', listener); return () => pipe.off('message', listener); }, onError: listener => { const failed = () => listener(new Error('Owned fixture failed')); pipe.on('failed', failed); return () => pipe.off('failed', failed); }, onClose: listener => { pipe.on('failed', listener); return () => pipe.off('failed', listener); } };
  client = new McpClient({ name: 'loopwright-owned-control', version: '1', requestTimeoutMs: 2000 }); await client.connect(transport); assert.ok((await client.listTools()).some(tool => tool.name === 'denied_write'));
  const result = await client.callTool('denied_write', { path: 'packages/policy/config.txt' }); facts.marker = await pipe.marker(); facts.physical = f.physical(); await writeFile(join(raw, 'fixture-effect-control.json'), JSON.stringify(facts)); assert.equal(result.isError, undefined); assert.equal(facts.marker.forbidden, true); assert.equal(facts.physical, 0);
 } catch (error) { facts.failure = closedFailure(error); await writeFile(join(raw, 'fixture-effect-control.json'), JSON.stringify(facts)); throw error; }
 finally {
  try { if (client) await client.close(); else if (pipe) await pipe.close(); }
  finally {
   try { for (const intent of registry.roles.filter(role => role.directory.startsWith(f.directory + '/'))) for (const file of ['container-intent.json', 'container-id.json', 'inspect.json', 'cleanup.json']) { try { await writeFile(join(raw, 'fixture-control-' + file), await readFile(join(intent.directory, file))); } catch { /* Exact outer cleanup retains unknowns. */ } } reclaimRoles(registryPath, registry); absent = true; }
   finally { await f.cleanup(!absent); }
  }
 }
}
try {
 if (selected === 'fixtures' || selected === 'all') await fixtureEffectControl();
 for (const mode of cases) {
  const call = definitions[mode], f = await requestFixture(index => ({ status: 200, body: stream(index === 1 ? call : null) }), input); let adapter;
  const facts = { mode, image, scriptDigest, phase: 'setup', physical: 'unknown', state: { available: false }, operations: 'unknown', receipts: { available: false }, requests: [], faults: [], mcpSent: [], forwardedProgressFrames: 0, forwardedProgressBytes: 0, closed: 'unknown' }; let fixtureProcess;
  const persist = async () => { facts.physical = f.physical(); facts.state = boundedState(f.host.store); facts.receipts = await receiptDigests(f.host.artifactsDirectory); const operations = f.host.store.listOperations({ limit: 32, cursor: null }); facts.operations = operations.ok && operations.value.next === null ? operations.value.items.map(record => ({ id: record.intent.operationId, effect: record.intent.effect, state: record.state, target: record.intent.targetIdentity, outcome: record.initialReceipt?.outcome ?? null })) : 'unknown'; await writeFile(join(raw, mode + '.json'), JSON.stringify(facts)); };
  try {
   f.input.policy.runtime = { ...f.input.policy.runtime, imageDigest: image, graphDigest: digest(await readFile('package-lock.json')), configDigest: await profileIdentity() };
   const host = { ...f.host, dockerExecutable, dockerSocket: dockerSocket(), runtime: f.input.policy.runtime };
   const ports = { ...runtimePorts, ...(fixtureModes[mode] ? { mcp: (owner, value) => ({ process: () => { const pipe = new FixtureProcess(owner, value, join(owner.directory, 'mcp-' + value.sessionId), join(owner.directory, 'sdk-' + value.sessionId, 'candidate'), fixtureModes[mode]); fixtureProcess = pipe; const close = pipe.close.bind(pipe); let closing; pipe.close = () => closing ??= (async () => { if (['hidden-direct', 'hidden-nested', 'hidden-search', 'stubborn'].includes(mode) && !facts.marker) { try { facts.marker = await pipe.marker(); } catch (error) { facts.marker = { available: false, failure: closedFailure(error) }; } } return close(); })(); const send = pipe.send.bind(pipe); pipe.send = async (message, guard) => { await send(message, guard); facts.mcpSent.push({ method: message.method ?? null, tool: message.params?.name ?? null }); }; return pipe; } }) } : {}), sender: (owner, value) => { const sender = new Sender(owner, value, { fetch: (_url, options) => { const body = JSON.parse(String(options.body)); facts.requests.push({ bytes: Buffer.byteLength(String(options.body)), systemDigest: digest(Buffer.from(JSON.stringify(body.system))), tools: body.tools?.map(tool => tool.name) ?? [], results: body.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'tool_result').map(block => ({ id: block.tool_use_id, isError: block.is_error === true, text: typeof block.content === 'string' ? block.content : JSON.stringify(block.content) })) : []) }); return globalThis.fetch(f.destination, options); } }); const trip = sender.runtimeFault.bind(sender); sender.runtimeFault = code => { facts.faults.push(code); trip(code); }; const sendMcp = sender.mcp.bind(sender); sender.mcp = (identity, bytes, reply) => sendMcp(identity, bytes, async message => { await reply(message); if (message.method === 'notifications/progress') { facts.forwardedProgressFrames++; facts.forwardedProgressBytes += Buffer.byteLength(JSON.stringify(message)); } }); return sender; }, session: (owner, value, broker, directory) => {
    const session = new RuntimeSession(owner, value, broker, directory), start = session.start.bind(session); session.start = async () => { registry.roles.push({ directory, name: session.name, labels: { 'org.loopwright.generation': String(owner.authority.generation), 'org.loopwright.run': value.lock.spec.runId, 'org.loopwright.session': value.sessionId, 'org.loopwright.nonce': session.nonce }, image }); await persistRegistry(); return start(); }; return session;
   } };
   facts.phase = 'open'; const opened = await constructAdapter(host, f.input, ports); facts.opened = opened.ok ? true : opened.error; await persist(); assert.equal(opened.ok, true); adapter = opened.value;
   facts.phase = 'execute'; const started = performance.now(); const outcome = await adapter.execute({ commandId: 'mcp-' + mode, text: 'literal native MCP qualification', purpose: 'task', repair: 'none' }); facts.executionMs = performance.now() - started; facts.outcome = outcome; await persist();
   assert.equal(await readFile(join(host.directory, 'sdk-' + f.input.sessionId, 'candidate/packages/policy/config.txt'), 'utf8'), 'PROTECTED_BASELINE');
   if (mode === 'denied-direct' || mode === 'hidden-direct') { failedExecution(outcome, 'CONTEXT_UNSAFE'); assert.equal(f.physical(), 1); assert.equal(facts.operations.length, 1); }
   else if (['quiet', 'progress', 'frame-flood', 'total-flood'].includes(mode)) { failedExecution(outcome); assert.equal(f.physical(), 1); assert.equal(facts.state.counts.unresolvedOperations, 1); assert.equal(outcome.value.status, 'recovery_required'); assert.equal(outcome.value.providerTermination, 'confirmed'); assert.equal(outcome.value.usage, 'complete'); assert.ok(outcome.value.operationIds.some(id => facts.operations.some(operation => operation.id === id && operation.state !== 'confirmed'))); if (mode === 'progress') { assert.ok(facts.faults.includes('DEADLINE')); assert.ok(facts.executionMs >= 2800); assert.ok(facts.forwardedProgressFrames > 20); } else if (mode === 'quiet') { assert.ok(facts.executionMs >= 1800); assert.equal(facts.forwardedProgressFrames, 0); } else { assert.ok(facts.faults.includes('OUTPUT_LIMIT')); assert.ok(facts.forwardedProgressBytes <= 65536); if (mode === 'frame-flood') assert.equal(facts.forwardedProgressFrames, 0); } }
   else if (mode === 'infinite' || mode === 'output') { failedExecution(outcome); assert.equal(f.physical(), 1); assert.ok(facts.faults.includes(mode === 'infinite' ? 'DEADLINE' : 'OUTPUT_LIMIT')); }
   else {
    settledExecution(outcome); assert.equal(f.physical(), 2); const responses = facts.requests.at(-1).results; assert.equal(responses.length, 1);
    if (mode === 'direct' || mode === 'nested' || mode === 'stubborn') { assert.equal(responses[0].isError, false); assert.ok(responses[0].text.includes('export const value = 1;')); assert.equal(facts.operations.length, mode === 'nested' ? 4 : 3); assert.ok(facts.operations.every(operation => operation.state === 'confirmed')); if (mode === 'nested') assert.equal((responses[0].text.match(/"undefined"/g) ?? []).length, 5); }
    else { assert.equal(responses[0].isError, true); assert.equal(facts.operations.length, 2); }
   }
   if (fixtureProcess && ['hidden-direct', 'hidden-nested', 'hidden-search', 'stubborn'].includes(mode)) {
    facts.marker ??= await fixtureProcess.marker(); assert.equal(facts.marker.forbidden, false);
    if (mode === 'stubborn') { assert.equal(facts.marker.descendant.sigtermIgnored, true); assert.ok(facts.marker.descendant.pid > 1); } else assert.equal(facts.mcpSent.filter(message => message.method === 'tools/call').length, 0);
   }
   facts.phase = 'asserted'; results.push(facts); await persist();
  } catch (error) { facts.exception = closedFailure(error); await persist(); throw error; }
  finally {
   try { if (adapter) { const closed = await adapter.close(); facts.closed = closed.ok; await persist(); assert.equal(closed.ok, true); } }
   finally {
    let rolesAbsent = false;
    try { for (const [index, intent] of registry.roles.filter(role => role.directory.startsWith(f.directory + '/')).entries()) for (const file of ['container-intent.json', 'container-id.json', 'inspect.json', 'cleanup.json', 'cli-exit.json']) { try { await writeFile(join(raw, mode + '-' + index + '-' + file), await readFile(join(intent.directory, file))); } catch { /* Absence is not substituted for unavailable evidence. */ } } reclaimRoles(registryPath, registry); rolesAbsent = true; }
    finally { await f.cleanup(!rolesAbsent); }
   }
  }
 }
 passed = true;
} catch (error) { await writeFile(join(raw, 'failure.json'), JSON.stringify({ failure: closedFailure(error), image, results })); process.exitCode = 1; }
finally { OwnedContainer.prototype.start = originalStart; try { reclaimRoles(registryPath, registry); } catch (error) { passed = false; process.exitCode = 1; await writeFile(join(raw, 'cleanup-failure.json'), JSON.stringify({ failure: closedFailure(error) })); } }
if (passed && process.exitCode !== 1) { await writeFile(join(raw, 'summary.json'), JSON.stringify({ passed: true, image, cases: results.length, results, level: 'actual SDK/raw parser/native MCP extension/custom transport/native QuickJS with owner S02 and separate stdio server; controlled HTTP only' })); console.log(JSON.stringify({ passed: true, image, cases: results.length })); }
