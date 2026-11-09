/* global process, Buffer, console, structuredClone, AbortSignal, clearTimeout, setInterval, clearInterval */
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { mkdir, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { admitTask } from '@loopwright/core';
import { createLocalRun } from '@loopwright/state';
import { decodePiCapture } from '@loopwright/agent-pi';
import { constructAdapterV2 } from '../../agent-pi/dist/adapter-v2.js';
import { runtimePorts } from '../../agent-pi/dist/adapter.js';
import { Sender } from '../../agent-pi/dist/sender.js';
import { RuntimeSession, profileIdentity } from '../../agent-pi/dist/session-host.js';
import { OwnedContainer } from '../../agent-pi/dist/containers.js';
import { WORKSPACE_TOOL } from '../../agent-pi/dist/workspace-mcp.js';
import { digest } from '../../agent-pi/dist/boundary.js';
import { dockerSocket } from '../../agent-pi/qualification/docker-socket.mjs';
import { reclaimRoles } from '../../agent-pi/qualification/role-cleanup.mjs';
import { sessionInput } from '../../../.test-build/packages/agent-pi/test/session-fixtures.js';
import { charge, persist, owner } from './budget.mjs';

const good = result => { assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result.error)); return result.value; };
const selected = process.argv[2];
const groups = {
  http: ['direct', 'nested', 'denied-direct', 'denied-nested', 'denied-search', 'parent', 'owner', 'bad401', 'bad403', 'redirect', 'session', 'sse', 'echo', 'bytes', 'headers', 'idle', 'absolute'],
  tls: ['tls-direct', 'tls-name', 'tls-chain', 'tls-address', 'tls-peer', 'tls-redirect'],
  auth: ['rotation', 'empty', 'missing', 'resolver-deadline', 'resolver-abort', 'interruption', 'cancellation'],
};
assert.ok(Object.hasOwn(groups, selected));
const directory = await mkdtemp(resolve('.claude/s04-qualification/mcp-' + selected + '-'));
const registryPath = join(directory, 'ownership.json');
const image = (await readFile('.claude/s03-t0/runtime-image.id', 'utf8')).trim(), socket = dockerSocket();
const registry = { kind: 'restricted-roles-v1', owner, dockerSocket: socket, dockerConfig: resolve('.claude/s03-t0/docker-client'), roles: [], services: [] };
persist(registryPath, registry);
const originalStart = OwnedContainer.prototype.start;
OwnedContainer.prototype.start = async function(signal) {
  const intent = { directory: this.directory, name: this.name, labels: this.labels, image };
  charge('container', intent); registry.roles.push(intent); persist(registryPath, registry);
  return originalStart.call(this, signal);
};
const boot = 'boot-' + digest(Buffer.from(execFileSync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8', timeout: 2000 }))).hex.slice(0, 32);
const results = [];
function stream(call, callId) {
  const frames = [{ type: 'message_start', message: { id: 's04-mcp', type: 'message', role: 'assistant', model: 'claude-sonnet-5.5', content: [], usage: { input_tokens: 4, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }];
  if (call) frames.push({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: callId, name: call.name, input: {} } }, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.args) } }, { type: 'content_block_stop', index: 0 });
  else frames.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } }, { type: 'content_block_stop', index: 0 });
  frames.push({ type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }, { type: 'message_stop' });
  return frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join('');
}
function definition(mode) {
  if (mode === 'nested') return { name: 'codemode', args: { code: 'text(await tools.mcp__workspace__read_file({path:"packages/example.ts"}));' } };
  if (mode === 'denied-direct') return { name: 'mcp__workspace__denied_write', args: { path: 'packages/example.ts' } };
  if (mode === 'denied-nested' || mode === 'denied-search') return { name: 'codemode', args: { code: (mode === 'denied-search' ? 'text(searchTools("denied_write")); ' : '') + 'await tools.mcp__workspace__denied_write({path:"packages/example.ts"});' } };
  return { name: 'mcp__workspace__read_file', args: { path: 'packages/example.ts' } };
}
async function listen(server, kind, mode) {
  const intent = { nonce: randomBytes(16).toString('hex'), kind, mode, bind: '127.0.0.1', state: 'intent', owner };
  registry.services.push(intent); persist(registryPath, registry);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  intent.port = server.address().port; intent.state = 'listening'; persist(registryPath, registry);
  return intent;
}
async function closeServer(server, intent) {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await new Promise((resolve, reject) => {
    const probe = net.connect({ host: '127.0.0.1', port: intent.port });
    probe.once('connect', () => { probe.destroy(); reject(new Error('SERVICE_STILL_LISTENING')); });
    probe.once('error', error => error.code === 'ECONNREFUSED' ? resolve() : reject(error));
    probe.setTimeout(1000, () => { probe.destroy(); reject(new Error('SERVICE_ABSENCE_UNKNOWN')); });
  });
  intent.state = 'closed'; intent.absenceConfirmed = true; persist(registryPath, registry);
}
async function scanFiles(root, forms) {
  let files = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files += await scanFiles(path, forms);
    else if (entry.isFile()) { const bytes = await readFile(path); assert.ok(!forms.some(form => bytes.includes(Buffer.from(form))), 'CREDENTIAL_IN_PRIVATE_SINK'); files++; }
  }
  return files;
}
let failure = null;
try {
  for (const mode of groups[selected]) {
    const local = join(directory, mode); await mkdir(local, { mode: 0o700 });
    await mkdir(join(local, 'runtime'), { mode: 0o700 }); await mkdir(join(local, 'artifacts'), { mode: 0o700 });
    let token = 'S04_MCP_' + randomBytes(24).toString('base64url');
    const forms = [token, encodeURIComponent(token), JSON.stringify(token).slice(1, -1), Buffer.from(token).toString('base64')];
    const facts = { mode, phase: 'setup', provider: 0, mcp: 0, calls: 0, anonymous: 0, wrongAuth: 0, trap: 0, otherMethod: 0, dials: 0, tlsErrors: 0, sni: [], resolver: [], providerResults: [], faults: [], canaryFilesScanned: 0 };
    const value = sessionInput(), contract = structuredClone(value.lock.spec.contract);
    contract.spec.roles[0].tools = ['read', 'codemode', 'mcp__workspace__read_file']; contract.spec.budgets.wallTimeMs = 600000;
    value.lock = good(admitTask(contract, { admissionId: 'admission-1', runId: 'run-1' }));
    value.version = 2; value.policy.version = 2; value.policy.tools = contract.spec.roles[0].tools;
    value.policy.runtime = { ...value.policy.runtime, imageDigest: image, graphDigest: digest(await readFile('package-lock.json')), configDigest: await profileIdentity() };
    value.policy.limits.sessionBytes = 2097152;
    const store = good(createLocalRun({ directory: join(local, 'state'), storeId: 'store-1', lock: value.lock,
      policy: { version: 1, leaseMs: 3000, cost: 'observe_only' }, binding: { coreApiVersion: 'loopwright.dev/v1alpha1', hostVersion: 's04-mcp', adapters: [{ id: 'pi', version: '0.0.0' }], resourceVersion: value.policy.resourceVersion, clockEpoch: boot } }));
    const initial = good(store.inspect()), authority = good(store.claim({ ownerId: 'controller-probe', expectedGeneration: initial.owner.generation, expectedRevision: initial.revision, mode: 'active' })).authority;
    let adapter, outcome, opened, cancelled, cleanup, closed, providerIntent, mcpIntent, waitForTool;
    const toolReached = new Promise(resolve => { waitForTool = resolve; });
    const timers = new Set();
    const provider = http.createServer(async (request, response) => {
      const chunks = []; let size = 0;
      for await (const chunk of request) { if ((size += chunk.length) > 65536) { response.destroy(); return; } chunks.push(chunk); }
      const body = Buffer.concat(chunks).toString(); assert.ok(!forms.some(form => body.includes(form)), 'CREDENTIAL_IN_PROVIDER');
      facts.provider++;
      const parsed = JSON.parse(body); facts.providerResults.push(parsed.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(block => block.type === 'tool_result').map(block => ({ error: block.is_error === true, candidateSeen: JSON.stringify(block.content).includes('export const value = 1;') })) : []));
      if (facts.provider > (mode === 'rotation' ? 4 : 2) || request.headers.authorization !== 'Bearer S04_SYNTHETIC_PROVIDER_CANARY') { response.writeHead(403); response.end(); return; }
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(stream(facts.provider === 1 || mode === 'rotation' && facts.provider === 3 ? definition(mode) : null, 'root-' + facts.provider));
    });
    const handleMcp = async (request, response) => {
      facts.mcp++;
      if (request.method !== 'POST') facts.otherMethod++;
      if (request.url !== '/mcp') { facts.trap++; response.writeHead(404); response.end(); return; }
      if (!request.headers.authorization) facts.anonymous++;
      if (request.headers.authorization !== 'Bearer ' + token) { facts.wrongAuth++; response.writeHead(403); response.end(); return; }
      const chunks = []; let size = 0;
      for await (const chunk of request) { if ((size += chunk.length) > 65536) { response.destroy(); return; } chunks.push(chunk); }
      const rpc = JSON.parse(Buffer.concat(chunks).toString());
      if (mode === 'bad401' || mode === 'bad403') { response.writeHead(mode === 'bad401' ? 401 : 403, { 'www-authenticate': 'Bearer secret-challenge' }); response.end('UNTRUSTED_AUTH_BODY'); return; }
      if (mode === 'redirect' || mode === 'tls-redirect') { response.writeHead(307, { location: '/credential-trap' }); response.end(); return; }
      if (mode === 'session') { response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'forbidden' }); response.end('{}'); return; }
      if (mode === 'sse') { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end('data: {}\n\n'); return; }
      if (mode === 'echo') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: Buffer.from(token).toString('base64') }] } })); return; }
      if (mode === 'headers') { response.writeHead(200, { 'content-type': 'application/json', 'x-oversize': 'x'.repeat(9000) }); response.end('{}'); return; }
      if (mode === 'bytes') { response.writeHead(200, { 'content-type': 'application/json' }); response.end('x'.repeat(65537)); return; }
      if (mode === 'idle') return;
      if (mode === 'absolute') {
        response.writeHead(200, { 'content-type': 'application/json' }); response.write(' ');
        const timer = setInterval(() => response.write(' '), 100); timers.add(timer); response.once('close', () => { clearInterval(timer); timers.delete(timer); }); return;
      }
      if (rpc.method === 'notifications/initialized') { response.writeHead(202); response.end(); return; }
      let result;
      if (rpc.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'loopwright-workspace', version: '1' } };
      else if (rpc.method === 'tools/list') result = { tools: [WORKSPACE_TOOL] };
      else if (rpc.method === 'tools/call') {
        facts.calls++; waitForTool();
        assert.equal(rpc.params.name, 'read_file'); assert.equal(rpc.params.arguments.path, 'packages/example.ts');
        if (mode === 'interruption') { request.socket.destroy(); return; }
        if (mode === 'cancellation') return;
        result = { content: [{ type: 'text', text: Buffer.from(value.candidate.artifacts[0].bytes).toString() }] };
      } else throw new Error('UNEXPECTED_MCP_METHOD');
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    };
    const secure = selected === 'tls';
    const mcp = secure ? https.createServer({ key: await readFile('.claude/s04-qualification/tls/leaf.key'), cert: await readFile('.claude/s04-qualification/tls/leaf.crt') }, handleMcp) : http.createServer(handleMcp);
    mcp.on('tlsClientError', () => { facts.tlsErrors++; }); mcp.on('secureConnection', socket => { facts.sni.push(socket.servername); });
    try {
      providerIntent = await listen(provider, 'provider', mode); mcpIntent = await listen(mcp, secure ? 'mcp-https' : 'mcp-http', mode);
      value.policy.mcp = { serverId: 'workspace', transport: 'sessionless-http-json-v1', destinationRef: 'mirror-1', endpoint: (secure ? 'https://' + (mode === 'tls-name' ? 'wrong.loopwright.test' : 'mirror.loopwright.test') : 'http://127.0.0.1') + ':' + mcpIntent.port + '/mcp', approvedAddresses: ['127.0.0.1'], credentialRef: 'mcp-token', names: ['mcp__workspace__read_file'], effects: ['read_only'], idleTimeoutSeconds: 2, absoluteTimeoutSeconds: mode === 'absolute' ? 3 : 10 };
      const host = { store, authority, directory: join(local, 'runtime'), artifactsDirectory: join(local, 'artifacts'), dockerExecutable: '/usr/local/bin/docker', dockerSocket: socket,
        runtime: value.policy.runtime, resolveCredential: async binding => { assert.equal(binding.provider, 'github-copilot'); return { bearerToken: 'S04_SYNTHETIC_PROVIDER_CANARY' }; },
        resolveMcpCredential: async binding => {
          assert.equal(binding.serverId, 'workspace'); assert.equal(binding.destinationRef, 'mirror-1'); assert.equal(binding.endpoint, value.policy.mcp.endpoint); assert.equal(binding.credentialRef, 'mcp-token');
          assert.equal(binding.method, 'POST'); assert.equal(binding.runId, 'run-1'); assert.equal(binding.roleId, 'builder'); assert.equal(binding.stepId, 'build');
          assert.equal(typeof binding.notAfterMonotonicMs, 'string'); assert.ok(binding.signal instanceof AbortSignal);
          assert.equal(binding.parentRequestId === null, binding.managementOperationId !== null);
          facts.resolver.push({ parentRequestId: binding.parentRequestId, managementOperationId: binding.managementOperationId, purpose: binding.purpose });
          if (mode === 'empty') return { bearerToken: '' };
          if (mode === 'missing') throw new Error('MISSING_REFERENCE');
          if (mode === 'resolver-deadline') return new Promise(() => {});
          if (mode === 'resolver-abort') { good(store.release(authority)); return { bearerToken: token }; }
          return { bearerToken: token };
        } };
      const ports = { ...runtimePorts, http: {
        ...(secure && mode !== 'tls-chain' ? { ca: [await readFile('.claude/s04-qualification/tls/ca.crt', 'utf8')] } : {}),
        ...(mode === 'tls-address' ? { selectAddress: () => '127.0.0.2' } : {}),
        ...(mode === 'tls-peer' ? { observePeer: () => '127.0.0.2' } : {}),
        observeDial: () => { charge('mcpAttempts'); facts.dials++; },
        beforeWrite: context => {
          if (!context.identity) return;
          if (mode === 'parent') context.identity = { ...context.identity, parentRequestId: 'absent-parent' };
          if (mode === 'owner') good(store.release(authority));
        },
      }, sender: (ownerHost, input) => {
        const sender = new Sender(ownerHost, input, { fetch: (_destination, options) => { charge('providerSends'); return globalThis.fetch('http://127.0.0.1:' + providerIntent.port, options); } });
        const fault = sender.runtimeFault.bind(sender); sender.runtimeFault = code => { facts.faults.push(code); fault(code); }; return sender;
      }, session: (ownerHost, input, sender, path) => {
        const session = new RuntimeSession(ownerHost, input, sender, path), start = session.start.bind(session);
        session.start = async () => {
          const intent = { directory: path, name: session.name, labels: { 'org.loopwright.generation': String(ownerHost.authority.generation), 'org.loopwright.run': input.lock.spec.runId, 'org.loopwright.session': input.sessionId, 'org.loopwright.nonce': session.nonce }, image };
          charge('container', intent); registry.roles.push(intent); persist(registryPath, registry); return start();
        }; return session;
      } };
      facts.phase = 'open'; opened = await constructAdapterV2(host, value, ports); facts.opened = opened.ok ? true : opened.error;
      if (opened.ok) {
        adapter = opened.value; facts.phase = 'execute';
        const command = adapter.execute({ commandId: 'mcp-' + mode, text: 'literal native MCP qualification', purpose: 'task', repair: 'none' });
        if (mode === 'cancellation') { await toolReached; cancelled = await adapter.cancel({ reason: 'operator' }); facts.cancelled = cancelled; }
        outcome = await command; facts.outcome = outcome;
        if (mode === 'rotation') {
          assert.equal(outcome.ok, true); assert.equal(outcome.value.status, 'execution_settled');
          const captured = good(await adapter.capture({ checkpointId: 'mcp-rotation-capture' }));
          const checkpoint = good(store.getCheckpoint(captured.checkpointId));
          const workspace = { ref: captured.workspace, bytes: await readFile(join(host.artifactsDirectory, captured.workspace.name)) };
          const session = { ref: captured.session, bytes: await readFile(join(host.artifactsDirectory, captured.session.name)) };
          const decoded = good(await decodePiCapture({ version: 1, lock: value.lock, policy: value.policy, checkpoint, sessionId: value.sessionId, roleId: value.roleId, stepId: value.stepId,
            workspace, session, command: { textDigest: digest(Buffer.from('literal native MCP qualification')), requestIds: outcome.value.requestIds } }));
          assert.equal(Buffer.from(decoded.submission).toString(), 'OK');
          const before = good(store.inspect()); good(await adapter.close()); adapter = undefined;
          token = 'S04_MCP_' + randomBytes(24).toString('base64url'); forms.push(token, encodeURIComponent(token), JSON.stringify(token).slice(1, -1), Buffer.from(token).toString('base64'));
          const resumedDirectory = join(local, 'runtime-resume'); await mkdir(resumedDirectory, { mode: 0o700 });
          opened = await constructAdapterV2({ ...host, directory: resumedDirectory }, { ...value, restore: { checkpointId: captured.checkpointId, workspace, session } }, ports);
          assert.equal(opened.ok, true); adapter = opened.value; assert.equal(facts.provider, 2);
          const restored = good(store.inspect()); assert.deepEqual(restored.clock.basis, before.clock.basis); assert.equal(restored.ledger.admittedCalls, before.ledger.admittedCalls);
          facts.rotation = { restoredWithoutModelSend: true, originalClock: restored.clock.basis, beforeLedger: before.ledger };
          outcome = await adapter.execute({ commandId: 'mcp-rotation-resumed', text: 'Read the same frozen candidate after authorized credential rotation.', purpose: 'task', repair: 'none' });
          facts.outcome = outcome; facts.rotation.afterLedger = good(store.inspect()).ledger;
        }
      }
      facts.phase = 'assert';
      const positive = ['direct', 'nested', 'tls-direct', 'rotation'].includes(mode), denied = mode.startsWith('denied-');
      if (positive) {
        assert.equal(opened.ok, true); assert.equal(outcome.ok, true); assert.equal(outcome.value.status, 'execution_settled');
        assert.equal(outcome.value.usage, 'complete'); assert.equal(facts.provider, mode === 'rotation' ? 4 : 2); assert.equal(facts.calls, mode === 'rotation' ? 2 : 1);
        assert.equal(facts.providerResults.at(-1)[0].candidateSeen, true); assert.equal(facts.providerResults.at(-1)[0].error, false);
        if (secure) assert.ok(facts.sni.length > 0 && facts.sni.every(name => name === 'mirror.loopwright.test'));
      } else if (denied) {
        assert.equal(opened.ok, true); assert.equal(facts.calls, 0); assert.ok(facts.provider > 0);
        if (mode !== 'denied-direct') { assert.equal(outcome.ok, true); assert.equal(outcome.value.status, 'execution_settled'); assert.equal(facts.providerResults.at(-1)[0].error, true); }
        else assert.ok(!outcome.ok || outcome.value.status !== 'execution_settled');
      } else {
        assert.ok(!opened.ok || !outcome.ok || outcome.value.status !== 'execution_settled');
        if (['bad401', 'bad403'].includes(mode)) { assert.equal(facts.mcp, 1); assert.equal(facts.dials, 1); assert.equal((opened.ok ? outcome.ok ? outcome.value.error : outcome.error : opened.error).code, 'MCP_AUTHENTICATION_REQUIRED'); }
        if (['tls-name', 'tls-chain', 'tls-peer'].includes(mode)) { assert.equal(facts.dials, 1); assert.equal(facts.mcp, 0); }
        if (['empty', 'missing', 'resolver-deadline', 'resolver-abort', 'tls-address'].includes(mode)) { assert.equal(facts.dials, 0); assert.equal(facts.mcp, 0); }
        if (['parent', 'owner'].includes(mode)) assert.equal(facts.calls, 0);
        if (['interruption', 'cancellation'].includes(mode)) { assert.equal(facts.calls, 1); assert.equal(facts.provider, 1); assert.ok(good(store.inspect()).counts.unresolvedOperations > 0); }
      }
      assert.equal(facts.anonymous, 0); assert.equal(facts.wrongAuth, 0); assert.equal(facts.trap, 0); assert.equal(facts.otherMethod, 0);
      facts.phase = 'asserted';
    } finally {
      if (adapter) { closed = await adapter.close(); facts.closed = closed; assert.equal(closed.ok, true); }
      for (const timer of timers) { clearInterval(timer); clearTimeout(timer); }
      if (providerIntent) await closeServer(provider, providerIntent);
      if (mcpIntent) await closeServer(mcp, mcpIntent);
      cleanup = reclaimRoles(registryPath, registry); facts.cleanup = cleanup;
      facts.state = good(store.inspect()); facts.operations = store.listOperations({ limit: 256, cursor: null });
      facts.canaryFilesScanned = await scanFiles(join(local, 'runtime'), forms) + await scanFiles(join(local, 'artifacts'), forms);
      if (mode === 'rotation') facts.canaryFilesScanned += await scanFiles(join(local, 'runtime-resume'), forms);
      persist(join(local, 'result.json'), facts); store.close();
    }
    results.push(facts); persist(join(directory, 'partial.json'), { results });
  }
} catch (error) { failure = { name: error.name, code: error.code ?? 'MCP_QUALIFICATION_FAILED', message: String(error.message).replace(/S04_MCP_[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 1024), stack: String(error.stack).split('\n').slice(1, 5).join('\n') }; }
finally {
  OwnedContainer.prototype.start = originalStart;
  try { reclaimRoles(registryPath, registry); } catch { failure ??= { code: 'CLEANUP_FAILED' }; }
  persist(join(directory, 'summary.json'), { status: failure ? 'failed' : 'passed', group: selected, results, failure, image, evidenceLevel: 'local_execution', providerEvidence: 'synthetic_fixture' });
}
console.log(JSON.stringify({ status: failure ? 'failed' : 'passed', group: selected, directory, cases: results.length, failure }));
if (failure) process.exitCode = 1;
