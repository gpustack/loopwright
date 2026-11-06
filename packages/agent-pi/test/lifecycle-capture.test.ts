import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { digestArtifact } from '@loopwright/core';
import { constructAdapter, type FactoryPorts } from '../src/adapter.js';
import { Sender } from '../src/sender.js';
import { canonical, digest } from '../src/boundary.js';
import { systemPrompt } from '../src/resources.js';
import { PROVIDER_DESTINATION } from '../src/provider.js';
import { rowBytes } from '../src/snapshot.js';
import { requestFixture, stateGood } from './request-fixtures.js';
import type { PiCapabilities } from '../src/types.js';
const frames = [{ type: 'message_start', message: { id: 'fixture', role: 'assistant', model: 'claude-sonnet-5.5', content: [], usage: { input_tokens: 4, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'DONE' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' }];
const timestamp = '2026-11-05T00:00:00.000Z';
test('public capture durably binds actual candidate/session bytes to a real S02 checkpoint', async () => {
  const f = await requestFixture(() => ({ status: 200, body: frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join('') }), undefined, 10000);
  const ports: FactoryPorts = { environment: async () => {}, sender: (host, input) => new Sender(host, input, { fetch: (_url, init) => globalThis.fetch(f.destination, init) }), session: (_host, input, broker, directory) => ({
    start: async (): Promise<PiCapabilities> => {
      await mkdir(directory, { mode: 0o700 }); for (const artifact of input.candidate.artifacts) { await mkdir(join(directory, 'candidate', artifact.name, '..'), { recursive: true, mode: 0o755 }); await writeFile(join(directory, 'candidate', artifact.name), artifact.bytes, { mode: 0o444 }); }
      return { version: 1, policyDigest: digest(Buffer.from(canonical(input.policy))), runtime: input.policy.runtime, requested: input.policy.selection, catalogSupported: input.policy.selection, sessionEffective: input.policy.selection, outboundObserved: null, resources: input.policy.resources, accounting: 'soft_only', contextFit: 'unproven', defaultMode: 'proven_bound', liveProvenBoundAvailable: false, optInMode: 'estimated_guard', contextEstimator: { id: 'lw-pi-final-json-bytes-v1', version: 1, provenance: 'estimated' }, toolExecution: { candidate: 'read_only', candidateWrites: 'mediated', scratch: 'per_call' } };
    },
    command: async () => {
      const grant = await broker.invoke({ invocation: 1, ...input.policy.selection });
      await broker.send({ invocation: 1, slot: grant.slot, method: 'POST', url: PROVIDER_DESTINATION, headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-initiator': 'user', 'openai-intent': 'conversation-edits' } }, Buffer.from(JSON.stringify({ model: input.policy.selection.model, system: [{ type: 'text', text: systemPrompt(input) + '\n\n<cwd>\n/workspace/candidate\n</cwd>' }], messages: [{ role: 'user', content: 'literal task' }], stream: true, max_tokens: 1024, thinking: { type: 'adaptive' }, output_config: { effort: 'xhigh' } })));
      await broker.parsed({ invocation: 1, slot: grant.slot, stopReason: 'stop', rawStopReason: 'end_turn', usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0 }, toolCalls: [] });
    },
    capture: async (sink: (bytes: Uint8Array) => Promise<void>) => {
      for (const entry of [{ type: 'session', version: 3, id: 'native-session', cwd: '/workspace/candidate', timestamp }, { type: 'message', id: 'entry-1', parentId: null, timestamp, message: { role: 'user', content: 'literal task' } }, { type: 'message', id: 'entry-2', parentId: 'entry-1', timestamp, message: { role: 'assistant', model: input.policy.selection.model, provider: input.policy.selection.provider, api: input.policy.selection.api, content: [{ type: 'text', text: 'DONE' }], stopReason: 'stop' } }]) await sink(rowBytes(entry));
    }, close: async () => {},
  }) }; const opened = await constructAdapter(f.host, f.input, ports); assert.equal(opened.ok, true); if (!opened.ok) throw new Error('fixture adapter'); const adapter = opened.value;
  try {
    assert.equal((await adapter.execute({ commandId: 'first', text: 'literal task', purpose: 'task', repair: 'none' })).ok, true);
    const captured = await adapter.capture({ checkpointId: 'checkpoint-1' }); assert.equal(captured.ok, true, JSON.stringify(captured.ok ? { captured: true } : captured.error)); if (!captured.ok) throw new Error('capture failed');
    const saved = stateGood(f.host.store.getCheckpoint('checkpoint-1')); assert.equal(canonical(saved.workspace), canonical(captured.value.workspace)); assert.equal(canonical(saved.privateSession), canonical(captured.value.session)); assert.equal(saved.counts.requests, 1); assert.equal(f.physical(), 1);
    const again = await adapter.capture({ checkpointId: 'checkpoint-1' }); assert.equal(again.ok, true);
    for (const ref of [captured.value.workspace, captured.value.session]) { const bytes = await readFile(join(f.host.artifactsDirectory, ref.name)), actual = digestArtifact(ref.name, bytes); assert.equal(actual.ok, true); if (actual.ok) assert.equal(canonical(actual.value), canonical(ref)); assert.equal((await stat(join(f.host.artifactsDirectory, ref.name))).mode & 0o777, 0o600); assert.ok(!bytes.includes(Buffer.from('SYNTHETIC_HOST_SECRET'))); }
    assert.equal((await adapter.close()).ok, true);
    const restoredInput = { ...f.input, candidate: { ...f.input.candidate, manifest: captured.value.candidate }, restore: { checkpointId: 'checkpoint-1', workspace: { ref: captured.value.workspace, bytes: await readFile(join(f.host.artifactsDirectory, captured.value.workspace.name)) }, session: { ref: captured.value.session, bytes: await readFile(join(f.host.artifactsDirectory, captured.value.session.name)) } } };
    await mkdir(join(f.directory, 'restored-runtime'));
    const reopened = await constructAdapter({ ...f.host, directory: join(f.directory, 'restored-runtime') }, restoredInput, ports); assert.equal(reopened.ok, true, JSON.stringify(reopened.ok ? null : reopened.error));
    assert.equal(f.physical(), 1); if (reopened.ok) { assert.equal(stateGood(f.host.store.inspect()).counts.requests, 1); await reopened.value.close(); }
    const alteredPolicy = { ...restoredInput, policy: { ...restoredInput.policy, context: { ...restoredInput.policy.context, serviceMargin: restoredInput.policy.context.serviceMargin + 1 } } };
    await mkdir(join(f.directory, 'mismatched-runtime'));
    const mismatched = await constructAdapter({ ...f.host, directory: join(f.directory, 'mismatched-runtime') }, alteredPolicy, ports); if (mismatched.ok) await mismatched.value.close(); assert.equal(mismatched.ok, false); if (!mismatched.ok) assert.equal(mismatched.error.code, 'BINDING_MISMATCH'); assert.equal(f.physical(), 1);
    const tampered = { ...restoredInput, restore: { ...restoredInput.restore, session: { ...restoredInput.restore.session, bytes: Buffer.from('tampered') } } };
    assert.equal((await constructAdapter(f.host, tampered, ports)).ok, false); assert.equal(f.physical(), 1);
  } finally { await adapter.close(); await f.cleanup(); }
});
