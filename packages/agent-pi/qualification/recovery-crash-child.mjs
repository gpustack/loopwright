/* global process, Buffer */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { reopenLocalRun } from '@loopwright/state';
import { constructAdapter, runtimePorts } from '../dist/adapter.js';
import { RuntimeSession } from '../dist/session-host.js';
import { Sender } from '../dist/sender.js';
import { Candidate } from '../dist/candidate.js';
import { ArtifactWriter } from '../dist/artifacts.js';
import { closedFailure } from './diagnostics.mjs';
const data = JSON.parse(await readFile(process.argv[2], 'utf8')), mode = data.mode, input = data.input;
for (const value of [...input.candidate.artifacts, ...input.resources]) value.bytes = Buffer.from(value.bytes, 'base64');
const opened = reopenLocalRun(data.identity); assert.equal(opened.ok, true); const store = opened.value, host = { ...data.host, store, runtime: input.policy.runtime, resolveCredential: async () => ({ bearerToken: 'SYNTHETIC_HOST_SECRET' }) };
const stop = phase => { process.send({ kind: 'boundary', phase }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); };
let base = false, sends = 0;
const writeCheckpoint = store.writeCheckpoint.bind(store); store.writeCheckpoint = (authority, value) => { if (value.checkpointId === 'target-1' && mode === 'before-checkpoint') stop('before-checkpoint'); const saved = writeCheckpoint(authority, value); if (value.checkpointId === 'target-1' && mode === 'after-checkpoint' && saved.ok) stop('after-checkpoint'); return saved; };
const finish = ArtifactWriter.prototype.finish; ArtifactWriter.prototype.finish = async function() { if (base && mode === 'before-artifact' && this.name.endsWith('.session.ndjson')) stop('before-artifact'); return finish.call(this); };
const commit = Candidate.prototype.commit; Candidate.prototype.commit = async function(...args) { const ref = await commit.apply(this, args); if (base && mode === 'tool-before-receipt') stop('tool-before-receipt'); return ref; };
let adapter;
try {
 const result = await constructAdapter(host, input, { ...runtimePorts, sender: (owner, value) => {
  const sender = new Sender(owner, value, { fetch: async (_url, init) => { const response = await globalThis.fetch(data.destination, init); sends++; if (base && mode === 'provider-before-receipt') stop('provider-before-receipt'); return response; } });
  const parsed = sender.parsed.bind(sender); sender.parsed = async value => { await parsed(value); if (base && mode === 'receipt-before-sdk-ack') stop('receipt-before-sdk-ack'); }; return sender;
 }, session: (owner, value, broker, directory) => {
  const runtime = new RuntimeSession(owner, value, broker, directory), start = runtime.start.bind(runtime); runtime.start = async () => { await writeFile(data.registry, JSON.stringify({ kind: 'restricted-roles-v1', dockerSocket: data.host.dockerSocket, dockerConfig: data.dockerConfig, roles: [{ directory, name: runtime.name, image: input.policy.runtime.imageDigest, labels: { 'org.loopwright.generation': String(owner.authority.generation), 'org.loopwright.run': value.lock.spec.runId, 'org.loopwright.session': value.sessionId, 'org.loopwright.nonce': runtime.nonce } }] })); return start(); }; return runtime;
 } }); assert.equal(result.ok, true); adapter = result.value;
 assert.equal((await adapter.execute({ commandId: 'baseline', text: 'baseline known request', purpose: 'task', repair: 'none' })).ok, true);
 const capture = await adapter.capture({ checkpointId: 'base-1' }); assert.equal(capture.ok, true); process.send({ kind: 'baseline', capture: capture.value }); base = true;
 assert.equal((await adapter.execute({ commandId: 'target', text: 'second controlled request', purpose: 'task', repair: 'none' })).ok, true);
 await adapter.capture({ checkpointId: 'target-1' }); throw new Error('Missed crash boundary');
} catch (error) { process.send({ kind: 'failed', failure: closedFailure(error), sends }); process.exitCode = 1; if (adapter) await adapter.close(); store.close(); process.disconnect(); }
