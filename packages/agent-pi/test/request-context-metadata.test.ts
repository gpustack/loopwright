import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { Sender } from '../src/sender.js';
import { digest } from '../src/boundary.js';
import { systemPrompt } from '../src/resources.js';
import { PROVIDER_DESTINATION } from '../src/provider.js';
import { requestFixture, stateGood } from './request-fixtures.js';
async function fixture(window: number) {
  const f = await requestFixture(() => ({ status: 503, body: '{}', headers: { 'content-type': 'application/json' } }));
  const sender = new Sender(f.host, f.input, { catalog: { contextWindow: window, digest: digest(Buffer.from('controlled smaller catalog')) }, fetch: (_url, init) => globalThis.fetch(f.destination, init) });
  const events: unknown[] = []; sender.installEvents(async (kind, fields) => { events.push({ kind, ...fields }); });
  sender.begin('execute', { commandId: 'context', text: 'literal', purpose: 'task', repair: 'none' }); const slot = await sender.invoke({ invocation: 1, ...f.input.policy.selection });
  const bytes = Buffer.from(JSON.stringify({ model: 'claude-sonnet-5.5', system: [{ type: 'text', text: systemPrompt(f.input) + '\n\n<cwd>\n/workspace/candidate\n</cwd>' }], messages: [{ role: 'user', content: 'X'.repeat(12000) }], max_tokens: 1024, thinking: { type: 'adaptive' }, output_config: { effort: 'xhigh' }, stream: true }));
  const identity = { invocation: 1, slot: slot.slot, method: 'POST', url: PROVIDER_DESTINATION, headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-initiator': 'user', 'openai-intent': 'conversation-edits' } };
  return { ...f, sender, bytes, identity, events };
}
test('a controlled smaller frozen catalog window refuses the actual sender before reservation or HTTP', async () => {
  const f = await fixture(60000);
  try { await assert.rejects(f.sender.send(f.identity, f.bytes)); assert.equal(f.physical(), 0); assert.equal(stateGood(f.host.store.inspect()).counts.requests, 0); }
  finally { f.sender.cancel(); await f.cleanup(); }
});
test('context audit records expose numeric refused assessment without prompt or credential content', async () => {
  const f = await fixture(60000);
  try {
    await f.sender.send(f.identity, f.bytes).catch(() => {});
    const folder = join(f.host.artifactsDirectory, 'pi-receipts'), files = await readdir(folder); assert.equal(files.length, 1);
    const record = JSON.parse(await readFile(join(folder, files[0]!), 'utf8')) as { decision: string; model: { model: string }; catalogWindow: number; assessment: { bodyBytes: number; inputReservation: number; workingWindow: number; withinWindow: boolean; coverage: string; contextFit: string }; policyDigest: unknown; catalogDigest: unknown };
    assert.equal(record.decision, 'refused'); assert.equal(record.model.model, 'claude-sonnet-5.5'); assert.equal(record.catalogWindow, 60000); assert.equal(record.assessment.workingWindow, 60000); assert.equal(record.assessment.bodyBytes, f.bytes.length); assert.equal(record.assessment.inputReservation, f.bytes.length + 32768); assert.equal(record.assessment.withinWindow, false); assert.equal(record.assessment.coverage, 'complete'); assert.equal(record.assessment.contextFit, 'unproven'); assert.ok(record.policyDigest); assert.ok(record.catalogDigest);
    const event = f.events as { kind: string; context?: unknown }[]; assert.equal(event[0]!.kind, 'context_assessment'); assert.deepEqual(event[0]!.context, record);
    const serialized = JSON.stringify(record); assert.ok(!serialized.includes('XXXX')); assert.ok(!serialized.includes('SYNTHETIC_HOST_SECRET')); assert.ok(Buffer.byteLength(serialized) < 4096);
  } finally { f.sender.cancel(); await f.cleanup(); }
});
