/* global process, Buffer, console, structuredClone */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { admitTask } from '@loopwright/core';
import { createLocalRun } from '@loopwright/state';
import { decodePiCapture } from '@loopwright/agent-pi';
import { constructAdapter, runtimePorts } from '../../agent-pi/dist/adapter.js';
import { Sender } from '../../agent-pi/dist/sender.js';
import { RuntimeSession, profileIdentity } from '../../agent-pi/dist/session-host.js';
import { canonical, digest } from '../../agent-pi/dist/boundary.js';
import { dockerSocket } from '../../agent-pi/qualification/docker-socket.mjs';
import { reclaimSessionRegistry } from '../../agent-pi/qualification/session-cleanup.mjs';
import { sessionInput } from '../../../.test-build/packages/agent-pi/test/session-fixtures.js';
import { charge, persist, owner } from './budget.mjs';

const good = result => { assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result.error)); return result.value; };
const directory = await mkdtemp(resolve('.claude/s04-qualification/capture-'));
const registryPath = join(directory, 'ownership.json');
const image = (await readFile('.claude/s03-t0/runtime-image.id', 'utf8')).trim();
const socket = dockerSocket(), registry = { kind: 'runtime-session-v1', owner, dockerSocket: socket, dockerConfig: resolve('.claude/s03-t0/docker-client'), sessions: [], service: { nonce: randomBytes(16).toString('hex'), bind: '127.0.0.1', state: 'intent' } };
persist(registryPath, registry);
const input = sessionInput(), contract = structuredClone(input.lock.spec.contract);
contract.spec.budgets.wallTimeMs = 600000;
input.lock = good(admitTask(contract, { admissionId: 'admission-1', runId: 'run-1' }));
input.policy.runtime = { ...input.policy.runtime, imageDigest: image, graphDigest: digest(await readFile('package-lock.json')), configDigest: await profileIdentity() };
input.policy.limits.sessionBytes = 2097152;
await mkdir(join(directory, 'runtime'), { mode: 0o700 }); await mkdir(join(directory, 'artifacts'), { mode: 0o700 });
const identity = { directory: join(directory, 'state'), storeId: 'store-1', lock: input.lock, policy: { version: 1, leaseMs: 1000, cost: 'observe_only' },
  binding: { coreApiVersion: 'loopwright.dev/v1alpha1', hostVersion: 's04-capture', adapters: [{ id: 'pi', version: '0.0.0' }], resourceVersion: input.policy.resourceVersion,
    clockEpoch: 'boot-' + digest(Buffer.from(execFileSync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8', timeout: 2000 }))).hex.slice(0, 32) } };
const store = good(createLocalRun(identity)), initial = good(store.inspect());
const authority = good(store.claim({ ownerId: 'controller-probe', expectedGeneration: initial.owner.generation, expectedRevision: initial.revision, mode: 'active' })).authority;
const host = { store, authority, directory: join(directory, 'runtime'), artifactsDirectory: join(directory, 'artifacts'), dockerExecutable: '/usr/local/bin/docker', dockerSocket: socket,
  runtime: input.policy.runtime, resolveCredential: async () => ({ bearerToken: 'S04_SYNTHETIC_PROVIDER_CANARY' }) };
const submitted = JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null });
let physical = 0, authFailures = 0;
const server = http.createServer(async (request, response) => {
  let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > 65536) { response.destroy(); return; } }
  physical++;
  if (request.headers.authorization !== 'Bearer S04_SYNTHETIC_PROVIDER_CANARY') { authFailures++; response.writeHead(403); response.end(); return; }
  const frames = [{ type: 'message_start', message: { id: 's04-capture', type: 'message', role: 'assistant', model: 'claude-sonnet-5.5', content: [], usage: { input_tokens: 4, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: submitted } }, { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } }, { type: 'message_stop' }];
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''));
});
let adapter, failure = null, captured, decoded, outcome, closed, cleanup;
const refusals = [];
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  registry.service = { ...registry.service, state: 'listening', port: server.address().port }; persist(registryPath, registry);
  const endpoint = 'http://127.0.0.1:' + registry.service.port;
  const ports = { ...runtimePorts, sender: (ownerHost, value) => new Sender(ownerHost, value, { fetch: (_destination, options) => { charge('providerSends'); return globalThis.fetch(endpoint, options); } }),
    session: (ownerHost, value, sender, path) => {
      const session = new RuntimeSession(ownerHost, value, sender, path);
      const start = session.start.bind(session);
      session.start = async () => {
        const intent = { directory: path, name: session.name, nonce: session.nonce, image, runId: value.lock.spec.runId, sessionId: value.sessionId, generation: ownerHost.authority.generation };
        charge('container', intent); registry.sessions.push(intent); persist(registryPath, registry);
        return start();
      };
      return session;
    } };
  adapter = good(await constructAdapter(host, input, ports));
  const text = 'Produce one structured submission for the admitted candidate.';
  outcome = good(await adapter.execute({ commandId: 'capture-probe', text, purpose: 'task', repair: 'none' }));
  assert.equal(outcome.status, 'execution_settled'); assert.equal(outcome.usage, 'complete');
  captured = good(await adapter.capture({ checkpointId: 'capture-probe-1' }));
  const checkpoint = good(store.getCheckpoint(captured.checkpointId));
  const decodeInput = { version: 1, lock: input.lock, policy: input.policy, checkpoint, sessionId: input.sessionId, roleId: input.roleId, stepId: input.stepId,
    workspace: { ref: captured.workspace, bytes: await readFile(join(host.artifactsDirectory, captured.workspace.name)) },
    session: { ref: captured.session, bytes: await readFile(join(host.artifactsDirectory, captured.session.name)) }, command: { textDigest: digest(Buffer.from(text)), requestIds: outcome.requestIds } };
  decoded = good(await decodePiCapture(decodeInput));
  assert.equal(Buffer.from(decoded.submission).toString(), submitted);
  assert.equal(canonical(decoded.candidate), canonical(captured.candidate));
  assert.equal(decoded.artifacts.length, input.candidate.artifacts.length);
  assert.equal(Buffer.from(decoded.artifacts[0].bytes).toString(), Buffer.from(input.candidate.artifacts[0].bytes).toString());
  for (const [name, change] of [
    ['command', value => { value.command.textDigest.hex = '0'.repeat(64); }],
    ['role', value => { value.roleId = 'other'; }],
    ['workspace-bytes', value => { value.workspace.bytes[0] ^= 1; }],
    ['session-bytes', value => { value.session.bytes[0] ^= 1; }],
    ['policy', value => { value.policy.policyId = 'changed'; }],
    ['checkpoint', value => { value.checkpoint.checkpointId = 'other'; }],
  ]) {
    const mutated = structuredClone(decodeInput); change(mutated);
    const result = await decodePiCapture(mutated); assert.equal(result.ok, false); refusals.push({ name, code: result.error.code });
  }
  assert.equal(physical, 1); assert.equal(authFailures, 0);
} catch (error) { failure = { name: error.name, code: error.code ?? 'CAPTURE_QUALIFICATION_FAILED', message: String(error.message).slice(0, 1024) }; }
finally {
  if (adapter) { closed = await adapter.close(); if (!closed.ok) failure ??= { code: 'CLEANUP_FAILED' }; }
  server.closeAllConnections(); await new Promise(resolve => server.close(() => resolve()));
  registry.service.state = 'closed'; persist(registryPath, registry);
  try { cleanup = reclaimSessionRegistry(registryPath); } catch { failure ??= { code: 'CLEANUP_FAILED' }; }
  const view = store.inspect();
  persist(join(directory, 'result.json'), { status: failure ? 'failed' : 'passed', failure, outcome, captured, refusals, physical, authFailures, closed, cleanup,
    state: view.ok ? view.value : view.error, source: { image, policyRuntime: input.policy.runtime }, evidenceLevel: 'local_execution', providerEvidence: 'synthetic_fixture' });
  store.close();
}
console.log(JSON.stringify({ status: failure ? 'failed' : 'passed', case: 'capture-binding', directory, physical, negativeControls: refusals.length, cleanup, failure }));
if (failure) process.exitCode = 1;
