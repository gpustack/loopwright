/* global process, Buffer, console, structuredClone, setInterval, clearInterval */
import { selectedCatalog } from '../dist/catalog.js';
import { dockerSocket } from './docker-socket.mjs';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { admitTask, digestArtifact } from '@loopwright/core';
import { createLocalRun } from '@loopwright/state';
import { sessionInput } from '../../../.test-build/packages/agent-pi/test/session-fixtures.js';
import { prepareInput } from '../dist/preflight.js';
import { digest } from '../dist/boundary.js';
import { RuntimeSession, profileIdentity } from '../dist/session-host.js';
import { Sender } from '../dist/sender.js';
import { openPiAdapter } from '../dist/index.js';
import { assessFinalRequestContext } from '../dist/context.js';
import { boundedState } from './diagnostics.mjs';
const good = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value; };
const directory = resolve('.claude/s03-t1-' + randomBytes(6).toString('hex')); await mkdir(directory, { mode: 0o700 });
const modelArg = process.argv.indexOf('--model'); const chosenModel = modelArg < 0 ? 'claude-sonnet-5.5' : process.argv[modelArg + 1];
assert.ok(['claude-sonnet-5.5', 'claude-opus-5.5'].includes(chosenModel)); const effort = chosenModel === 'claude-sonnet-5.5' ? 'xhigh' : 'high';
const input = sessionInput(), trustedBytes = Buffer.from('DECLARED_TRUSTED_RESOURCE_你好'), trustedRef = good(digestArtifact('trusted/context.md', trustedBytes));
const contract = structuredClone(input.lock.spec.contract); contract.spec.roles[0].model = chosenModel; contract.spec.roles[0].thinking = effort; input.policy.selection.model = chosenModel; input.policy.selection.thinking = effort;
contract.spec.trustedContext.resources = [{ id: 'trusted-doc', kind: 'document', path: trustedRef.name, digest: trustedRef.digest }];
input.lock = good(admitTask(contract, { admissionId: 'admission-1', runId: 'run-1' }));
input.resources = [{ id: 'trusted-doc', kind: 'document', ref: structuredClone(trustedRef), bytes: trustedBytes }];
input.policy.resources.push(structuredClone(contract.spec.trustedContext.resources[0]));
const ambient = Buffer.from('SYNTHETIC_AMBIENT_APPEND_CANARY');
input.candidate.artifacts.push({ name: '.pi/APPEND_SYSTEM.md', bytes: ambient });
input.candidate.manifest.spec.entries.push(good(digestArtifact('.pi/APPEND_SYSTEM.md', ambient)));
input.policy.runtime.imageDigest = (await readFile('.claude/s03-t0/runtime-image.id', 'utf8')).trim();
input.policy.runtime.graphDigest = digest(await readFile('package-lock.json')); input.policy.runtime.configDigest = await profileIdentity();
await mkdir(join(directory, 'runtime')); await mkdir(join(directory, 'artifacts'));
const store = good(createLocalRun({ directory: join(directory, 'state'), storeId: 'store-1', lock: input.lock, policy: { version: 1, leaseMs: 1000, cost: 'observe_only' },
  binding: { coreApiVersion: 'loopwright.dev/v1alpha1', hostVersion: 't1-qualification', adapters: [{ id: 'pi', version: '0.0.0' }], resourceVersion: input.policy.resourceVersion, clockEpoch: 't1-fixture-boot' } }));
const view = good(store.inspect()), claimed = good(store.claim({ ownerId: 'owner-1', expectedGeneration: view.owner.generation, expectedRevision: view.revision, mode: 'active' }));
const host = { store, authority: claimed.authority, directory: join(directory, 'runtime'), artifactsDirectory: join(directory, 'artifacts'),
  dockerExecutable: execFileSync('/usr/bin/which', ['docker'], { encoding: 'utf8' }).trim(), dockerSocket: dockerSocket(), runtime: structuredClone(input.policy.runtime), resolveCredential: async () => { throw new Error('No real credential permitted'); } };
let physical = 0, captured;
const server = http.createServer(async (request, response) => {
  let bytes = 0; for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes <= 65536); } physical++;
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const frames = [{ type: 'message_start', message: { id: 'fixture', type: 'message', role: 'assistant', model: chosenModel, content: [], usage: { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } }, { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }, { type: 'message_stop' }];
  response.end(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let adapter, native, positiveId, positiveController, positiveNonce, renewal;
let discoveryPositive;
try {
  const opened = await openPiAdapter(host, input); await writeFile(join(directory, 'public-result.json'), JSON.stringify(opened.ok ? opened.value.capabilities() : opened)); adapter = good(opened);
  assert.equal(adapter.capabilities().sessionEffective.thinking, effort); assert.equal(physical, 0);
  assert.equal((await adapter.execute({ commandId: 'preflight-denied', text: '/login', purpose: 'task', repair: 'none' })).ok, false); assert.equal(physical, 0);
  good(await adapter.close()); adapter = null;
  // Internal constructor-injected local fixture sender: deliberately not production S02 admission proof.
  const renewed = good(store.renew(host.authority)); assert.equal(renewed.authority.generation, host.authority.generation);
  renewal = setInterval(() => { good(store.renew(host.authority)); }, 250);
  const broker = new Sender({ ...host, resolveCredential: async () => ({ bearerToken: 'SYNTHETIC_HOST_CREDENTIAL' }) }, prepareInput(input), { fetch: async (_url, options) => {
    const bytes = Buffer.from(options.body); captured = JSON.parse(bytes.toString());
    const assessment = assessFinalRequestContext(bytes, input.policy.context, { modelId: input.policy.selection.model, effort: input.policy.selection.thinking, tools: input.policy.tools, contextWindow: selectedCatalog(input).contextWindow, perCallOutputTokens: 1024 });
    await writeFile(join(directory, 'context-assessment.json'), JSON.stringify(assessment.ok ? { ok: true } : { ok: false, error: assessment.error })); assert.equal(assessment.ok, true);
    assert.ok(JSON.stringify(captured).includes('DECLARED_TRUSTED_RESOURCE_你好')); assert.ok(!JSON.stringify(captured).includes('SYNTHETIC_AMBIENT_APPEND_CANARY'));
    return globalThis.fetch('http://127.0.0.1:' + server.address().port, options);
  } });
  native = new RuntimeSession(host, prepareInput(input), broker, join(host.directory, 'sdk-resource-check'));
  await native.start(); broker.begin('execute', { commandId: 'resource-check', text: 'literal fixture request', purpose: 'task', repair: 'none' }); const answer = await native.command('execute', { text: 'literal fixture request' });
  await writeFile(join(directory, 'native-outcome.json'), JSON.stringify({ stopReason: answer.stopReason, physical, state: boundedState(store) }));
  assert.equal(answer.stopReason, 'stop'); assert.equal(broker.finish().status, 'execution_settled'); await native.close(); native = null;
  const positiveDirectory = join(directory, 'discovery'); await mkdir(positiveDirectory);
  positiveController = new RuntimeSession(host, prepareInput(input), broker, positiveDirectory);
  positiveNonce = randomBytes(16).toString('hex'); const positiveName = 'lw-pi-discovery-' + positiveNonce;
  await writeFile(join(positiveDirectory, 'intent.json'), JSON.stringify({ name: positiveName, nonce: positiveNonce, image: input.policy.runtime.imageDigest }));
  positiveId = (await positiveController.docker(['create', '--pull=never', '--init', '--name', positiveName, '--label', 'org.loopwright.nonce=' + positiveNonce, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true', '--security-opt', 'seccomp=' + resolve('packages/agent-pi/runtime/seccomp.json'), '--user', '1000:1000', '--memory', '512m', '--memory-swap', '512m', '--cpus', '1', '--pids-limit', '64', '--log-driver', 'none', '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=33554432', '--tmpfs', '/scratch:rw,nosuid,nodev,noexec,size=134217728', '--env', 'HOME=/tmp/home', '--env', 'PI_OFFLINE=1', input.policy.runtime.imageDigest, '/opt/loopwright/packages/agent-pi/qualification/session-discovery-child.mjs'])).trim();
  await writeFile(join(positiveDirectory, 'id.json'), JSON.stringify({ id: positiveId, nonce: positiveNonce }));
  const positiveInspect = await positiveController.inspect(positiveId); assert.equal(positiveInspect.Config.Labels['org.loopwright.nonce'], positiveNonce); assert.equal(positiveInspect.Image, input.policy.runtime.imageDigest);
  discoveryPositive = JSON.parse(await positiveController.docker(['start', '--attach', positiveId])); assert.equal(discoveryPositive.actualSdkDiscoveryPositive, true);
  assert.equal(physical, 1); assert.equal(good(store.inspect()).counts.requests, 1);
  console.log(JSON.stringify({ status: 'passed', directory, image: input.policy.runtime.imageDigest, profileDigest: input.policy.runtime.configDigest, publicBootNoSend: true,
    requested: input.policy.selection, outboundModel: captured.model, outboundEffort: captured.output_config.effort, declaredResourcePresent: true, ambientAppendAbsent: true, actualFixtureHttpSends: physical,
    stateRequests: 1, discoveryPositive, level: 'actual public SDK boot; actual RuntimeSession/Sender/S02 resource path with constructor-injected controlled HTTP transport' }, null, 2));
} finally {
  if (positiveId) { const inspected = await positiveController.inspect(positiveId); assert.equal(inspected.Config.Labels['org.loopwright.nonce'], positiveNonce); assert.equal(inspected.Image, input.policy.runtime.imageDigest); if (inspected.State.Running) await positiveController.docker(['kill', positiveId]); const stopped = await positiveController.inspect(positiveId); assert.equal(stopped.State.Running, false); await positiveController.docker(['rm', positiveId]); await writeFile(join(directory, 'discovery/cleanup.json'), JSON.stringify({ id: positiveId, removed: true, state: stopped.State })); }
  clearInterval(renewal); if (adapter) await adapter.close(); if (native) await native.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close();
}
