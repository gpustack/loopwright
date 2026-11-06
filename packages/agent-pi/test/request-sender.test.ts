import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Sender } from '../src/sender.js';
import { systemPrompt } from '../src/resources.js';
import { PROVIDER_DESTINATION, type FetchIdentity, type ParsedCandidate } from '../src/provider.js';
import { PiFailure } from '../src/errors.js';
import { requestFixture, stateGood } from './request-fixtures.js';
function stream(reason = 'end_turn'): string {
  const events = [{ type: 'message_start', message: { id: 'fixture', role: 'assistant', model: 'claude-sonnet-5.5', content: [], usage: { input_tokens: 4, output_tokens: 0, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } }, { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 2 } }, { type: 'message_stop' }];
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}
async function setup(plan: Parameters<typeof requestFixture>[0] = () => ({ status: 200, body: stream() })) {
  const f = await requestFixture(plan), sender = new Sender(f.host, f.input, { fetch: (_url, options) => globalThis.fetch(f.destination, options) });
  const command = { commandId: 'command-1', text: 'literal owner input', purpose: 'task' as const, repair: 'none' as const }; sender.begin('execute', command);
  const grant = await sender.invoke({ invocation: 1, ...f.input.policy.selection });
  const identity: FetchIdentity = { invocation: 1, slot: grant.slot, method: 'POST', url: PROVIDER_DESTINATION,
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-initiator': 'user', 'openai-intent': 'conversation-edits' } };
  const bytes = Buffer.from(JSON.stringify({ model: 'claude-sonnet-5.5', system: [{ type: 'text', text: systemPrompt(f.input) + '\n\n<cwd>\n/workspace/candidate\n</cwd>' }],
    messages: [{ role: 'user', content: command.text }], max_tokens: 1024, thinking: { type: 'adaptive' }, output_config: { effort: 'xhigh' }, stream: true }));
  const parsed: ParsedCandidate = { invocation: 1, slot: grant.slot, stopReason: 'stop', rawStopReason: 'end_turn', usage: { input: 4, output: 2, cacheRead: 2, cacheWrite: 3 }, toolCalls: [] };
  return { ...f, sender, identity, bytes, parsed };
}
test('real owner sender persists raw receipt before parser ACK and reports authenticated final counts once', async () => {
  const f = await setup();
  try {
    const response = await f.sender.send(f.identity, f.bytes); assert.equal(response.status, 200);
    const before = stateGood(f.host.store.inspect()); assert.equal(before.counts.dispatchedRequests, 1); assert.equal(before.ledger.heldSlots, 1);
    const directory = join(f.host.artifactsDirectory, 'pi-receipts'); const files = await readdir(directory); assert.equal(files.length, 2);
    const rawFile = files.find(name => name.endsWith('-raw.json')); assert.ok(rawFile); const raw = JSON.parse(await readFile(join(directory, rawFile), 'utf8'));
    const contextFile = files.find(name => name.endsWith('-context.json')); assert.ok(contextFile); const context = JSON.parse(await readFile(join(directory, contextFile), 'utf8'));
    assert.deepEqual(raw.context, context); assert.equal(context.decision, 'admitted'); assert.equal(context.assessment.bodyBytes, f.bytes.length); assert.equal(context.assessment.withinWindow, true); assert.equal(context.assessment.coverage, 'complete'); assert.equal(context.requestId, raw.requestId);
    await f.sender.parsed(f.parsed); await f.sender.parsed(f.parsed);
    const finalFile = (await readdir(directory)).find(name => name.endsWith('-final.json')); assert.ok(finalFile); const final = JSON.parse(await readFile(join(directory, finalFile), 'utf8')); assert.deepEqual(final.context, context);
    const after = stateGood(f.host.store.inspect()); assert.equal(after.ledger.reportedTokens.decimal, '11'); assert.equal(after.ledger.heldSlots, 0); assert.equal(after.ledger.admittedCalls, 1);
    assert.equal(f.sender.finish().status, 'execution_settled'); assert.equal(f.physical(), 1);
    for (const file of await readdir(directory)) assert.ok(!(await readFile(join(directory, file), 'utf8')).includes('SYNTHETIC_HOST_SECRET'));
  } finally { await f.cleanup(); }
});
test('the pinned native beta messages URL passes exact sender admission', async () => {
  const f = await setup();
  try {
    await f.sender.send({ ...f.identity, url: 'https://api.individual.githubcopilot.com/v1/messages?beta=true' }, f.bytes);
    await f.sender.parsed(f.parsed); assert.equal(f.physical(), 1); assert.equal(f.sender.finish().status, 'execution_settled');
  } finally { await f.cleanup(); }
});
test('alternate messages queries, destinations and methods send zero before reservation', async () => {
  for (const change of [{ url: 'https://api.individual.githubcopilot.com/v1/messages' }, { url: PROVIDER_DESTINATION + '&extra=true' },
    { url: PROVIDER_DESTINATION.replace('beta=true', 'beta=false') }, { url: PROVIDER_DESTINATION.replace('/messages?', '/messages/count_tokens?') },
    { url: PROVIDER_DESTINATION.replace('api.individual.githubcopilot.com', 'other.example') }, { method: 'GET' }]) {
    const f = await setup();
    try { await assert.rejects(f.sender.send({ ...f.identity, ...change }, f.bytes), PiFailure); assert.equal(f.physical(), 0); assert.equal(stateGood(f.host.store.inspect()).counts.requests, 0); }
    finally { f.sender.cancel(); await f.cleanup(); }
  }
});
test('underlying stale-owner code survives the sender finish boundary with zero sends', async () => {
  const f = await setup();
  try {
    assert.equal(f.host.store.release(f.host.authority).ok, true);
    const view = stateGood(f.host.store.inspect()); stateGood(f.host.store.claim({ ownerId: 'replacement', expectedGeneration: view.owner.generation, expectedRevision: view.revision, mode: 'active' }));
    let original: string | null = null;
    await assert.rejects(f.sender.send(f.identity, f.bytes), error => { if (!(error instanceof PiFailure)) return false; original = error.detail.stateErrorCode; return error.detail.code === 'AUTHORITY_REFUSED' && original !== null; });
    const outcome = f.sender.finish(); assert.equal(outcome.status, 'blocked'); assert.equal(outcome.error?.code, 'AUTHORITY_REFUSED'); assert.equal(outcome.error?.stateErrorCode, original);
    assert.equal(f.physical(), 0); assert.equal(stateGood(f.host.store.inspect()).counts.requests, 0);
  } finally { await f.cleanup(); }
});
test('terminal 429 retry consumes distinct persistent attempts and keeps unknown original charge', async () => {
  const f = await setup(call => call === 1 ? { status: 429, body: JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }), headers: { 'content-type': 'application/json', 'retry-after': '0' } } : { status: 200, body: stream() });
  try {
    await f.sender.send(f.identity, f.bytes); await f.sender.parsed(f.parsed); const result = f.sender.finish(); assert.equal(result.status, 'execution_settled'); assert.equal(result.usage, 'incomplete');
    const view = stateGood(f.host.store.inspect()), page = stateGood(f.host.store.listRequests({ limit: 10, cursor: null }));
    assert.equal(f.physical(), 2); assert.equal(view.ledger.admittedCalls, 2); assert.equal(view.ledger.transportRetries, 1); assert.equal(view.ledger.unknownTokenRequests, 1); assert.equal(view.ledger.heldSlots, 0);
    assert.equal(page.items[1]!.admission.transportRetryOf, page.items[0]!.admission.requestId); assert.notEqual(page.items[1]!.admission.attemptId, page.items[0]!.admission.attemptId);
    assert.equal(page.items[0]!.chargedTokens.safeValue, page.items[0]!.admission.totalUpperBound); assert.equal(page.items[1]!.chargedTokens.decimal, '11');
  } finally { await f.cleanup(); }
});
test('a simulated per-send timeout after real controlled HTTP dispatch retains DEADLINE and unknown charge', async context => {
  const f = await setup(), timer = new AbortController(), original = AbortSignal.timeout.bind(AbortSignal), durations: number[] = [];
  context.mock.method(AbortSignal, 'timeout', (ms: number) => { durations.push(ms); return ms > 10000 ? timer.signal : original(ms); });
  try {
    const sending = f.sender.send(f.identity, f.bytes); let failed = false; void sending.catch(() => { failed = true; });
    const waitUntil = Date.now() + 5000; while (!f.physical() && !failed && Date.now() < waitUntil) await new Promise<void>(resolve => setTimeout(resolve, 1)); assert.equal(f.physical(), 1);
    timer.abort(); await assert.rejects(sending);
    const outcome = f.sender.finish(); assert.equal(outcome.status, 'recovery_required'); assert.equal(outcome.error?.code, 'DEADLINE'); assert.equal(outcome.providerTermination, 'unknown'); assert.equal(outcome.usage, 'incomplete');
    assert.equal(outcome.requestIds.length, 1); assert.equal(stateGood(f.host.store.inspect()).ledger.heldSlots, 1); assert.equal(f.physical(), 1); assert.ok(durations.some(ms => ms > 10000 && ms <= 90000));
  } finally { context.mock.restoreAll(); await f.cleanup(); }
});
test('bad resource/header identities send zero before any reservation', async () => {
  for (const mutation of ['resource', 'header']) {
    const f = await setup();
    try {
      const bytes = mutation === 'resource' ? Buffer.from(f.bytes.toString().replace('Loopwright executes', 'Injected replacement')) : f.bytes;
      const identity = mutation === 'header' ? { ...f.identity, headers: { ...f.identity.headers, authorization: 'forbidden child credential' } } : f.identity;
      await assert.rejects(f.sender.send(identity, bytes), PiFailure); assert.equal(f.physical(), 0); assert.equal(stateGood(f.host.store.inspect()).counts.requests, 0);
    } finally { f.sender.cancel(); await f.cleanup(); }
  }
});
test('known context failure latches execution even when raw final usage is complete', async () => {
  const f = await setup(() => ({ status: 200, body: stream('model_context_window_exceeded') }));
  try {
    await f.sender.send(f.identity, f.bytes); await f.sender.parsed({ ...f.parsed, stopReason: 'error', rawStopReason: 'model_context_window_exceeded', usage: { ...f.parsed.usage, output: 0 } });
    const outcome = f.sender.finish(); assert.equal(outcome.status, 'failed'); assert.equal(outcome.error?.code, 'CONTEXT_LIMIT');
    assert.equal(stateGood(f.host.store.inspect()).ledger.reportedTokens.decimal, '11'); assert.equal(f.physical(), 1);
  } finally { await f.cleanup(); }
});
test('SDK counter disagreement preserves unknown charges and requires diagnosis', async () => {
  const f = await setup();
  try {
    await f.sender.send(f.identity, f.bytes); await f.sender.parsed({ ...f.parsed, usage: { ...f.parsed.usage, output: 0 } });
    assert.equal(f.sender.progress()?.usage, 'incomplete');
    const outcome = f.sender.finish(); assert.equal(outcome.status, 'recovery_required'); assert.equal(outcome.usage, 'incomplete');
    const final = JSON.parse(await readFile(join(f.host.artifactsDirectory, 'pi-receipts', outcome.requestIds[0]! + '-final.json'), 'utf8')); assert.equal(final.usage.inputTokens.provenance, 'unknown'); assert.equal(final.usage.outputTokens.provenance, 'unknown');
    const accepted = stateGood(f.host.store.getRequest(outcome.requestIds[0]!)).initialObservation; assert.ok(accepted); assert.deepEqual(accepted.usage, { requestId: outcome.requestIds[0], ...final.usage });
    const view = stateGood(f.host.store.inspect()); assert.equal(view.ledger.unknownTokenRequests, 1); assert.equal(view.ledger.reportedTokens.decimal, '0'); assert.ok((view.ledger.chargedTokens.safeValue ?? 0) > 11);
  } finally { await f.cleanup(); }
});
test('missing parser ACK cannot be turned into settled execution', async () => {
  const f = await setup();
  try { await f.sender.send(f.identity, f.bytes); assert.equal(f.sender.finish().status, 'recovery_required'); assert.equal(stateGood(f.host.store.inspect()).ledger.heldSlots, 1); }
  finally { await f.cleanup(); }
});
test('credential echo never reaches SDK reply or artifact receipts', async () => {
  const f = await setup(() => ({ status: 400, body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'SYNTHETIC_HOST_SECRET' } }), headers: { 'content-type': 'application/json' } }));
  try {
    await assert.rejects(f.sender.send(f.identity, f.bytes), error => error instanceof PiFailure && error.detail.code === 'PROVIDER_RESPONSE_INVALID');
    await f.sender.parsed({ ...f.parsed, stopReason: 'error' }); assert.equal(f.sender.finish().status, 'recovery_required');
    assert.equal(stateGood(f.host.store.inspect()).ledger.heldSlots, 1); const files = await readdir(join(f.host.artifactsDirectory, 'pi-receipts')); assert.equal(files.length, 1); assert.ok(files[0]!.endsWith('-context.json')); assert.ok(!(await readFile(join(f.host.artifactsDirectory, 'pi-receipts', files[0]!), 'utf8')).includes('SYNTHETIC_HOST_SECRET'));
  } finally { await f.cleanup(); }
});

test('a mixed turn exposes only accepted usage when the second parser disagrees', async () => {
  const f = await setup();
  try {
    await f.sender.send(f.identity, f.bytes); await f.sender.parsed(f.parsed); assert.equal(f.sender.progress()?.usage, 'complete');
    const next = await f.sender.invoke({ invocation: 2, ...f.input.policy.selection }), identity = { ...f.identity, invocation: 2, slot: next.slot };
    await f.sender.send(identity, f.bytes); await f.sender.parsed({ ...f.parsed, invocation: 2, slot: next.slot, usage: { ...f.parsed.usage, output: 0 } });
    assert.equal(f.sender.progress()?.usage, 'incomplete'); const outcome = f.sender.finish(); assert.equal(outcome.status, 'recovery_required'); assert.equal(outcome.usage, 'incomplete'); assert.equal(outcome.requestIds.length, 2);
    const records = stateGood(f.host.store.listRequests({ limit: 10, cursor: null })).items; assert.equal(records.length, 2);
    const finals = await Promise.all(outcome.requestIds.map(id => readFile(join(f.host.artifactsDirectory, 'pi-receipts', id + '-final.json'), 'utf8').then(text => JSON.parse(text))));
    assert.equal(finals[0].usage.inputTokens.provenance, 'reported'); assert.equal(finals[1].usage.inputTokens.provenance, 'unknown');
    for (let index = 0; index < 2; index++) { const accepted = records.find(record => record.admission.requestId === outcome.requestIds[index])!.initialObservation; assert.ok(accepted); assert.deepEqual(accepted.usage, { requestId: outcome.requestIds[index], ...finals[index].usage }); }
    const view = stateGood(f.host.store.inspect()); assert.equal(view.ledger.unknownTokenRequests, 1); assert.equal(view.ledger.reportedTokens.decimal, '11'); assert.equal(f.physical(), 2);
  } finally { await f.cleanup(); }
});
for (const commit of ['not_committed', 'unknown'] as const) test('an unaccepted ' + commit + ' observation cannot promote published candidate usage', async context => {
  const f = await setup();
  try {
    await f.sender.send(f.identity, f.bytes); await f.sender.parsed(f.parsed);
    const next = await f.sender.invoke({ invocation: 2, ...f.input.policy.selection }), identity = { ...f.identity, invocation: 2, slot: next.slot }; await f.sender.send(identity, f.bytes);
    // Controlled state-result fault: publish succeeds, but S02 never accepts this observation.
    context.mock.method(f.host.store, 'observeRequest', () => ({ ok: false, error: { code: commit === 'unknown' ? 'COMMIT_UNKNOWN' : 'STALE_OWNER', path: '', retryable: false, commit, diagnostics: [] } }));
    await assert.rejects(f.sender.parsed({ ...f.parsed, invocation: 2, slot: next.slot }), PiFailure);
    assert.equal(f.sender.progress()?.usage, 'incomplete'); const outcome = f.sender.finish(); assert.equal(outcome.status, 'recovery_required'); assert.equal(outcome.usage, 'incomplete'); assert.equal(outcome.requestIds.length, 2); assert.equal(outcome.error?.stateErrorCode, commit === 'unknown' ? 'COMMIT_UNKNOWN' : 'STALE_OWNER');
    const published = JSON.parse(await readFile(join(f.host.artifactsDirectory, 'pi-receipts', outcome.requestIds[1]! + '-final.json'), 'utf8')); assert.equal(published.usage.inputTokens.provenance, 'reported');
    const accepted = stateGood(f.host.store.getRequest(outcome.requestIds[1]!)); assert.equal(accepted.state, 'dispatch_authorized'); assert.equal(accepted.initialObservation, null);
    const view = stateGood(f.host.store.inspect()); assert.equal(view.ledger.reportedTokens.decimal, '11'); assert.equal(view.ledger.heldSlots, 1); assert.equal(f.physical(), 2);
  } finally { context.mock.restoreAll(); await f.cleanup(); }
});

test('a later accounted turn excludes an earlier retained request with incomplete usage', async () => {
  const f = await setup(call => ({ status: 200, body: call === 1 ? stream().replace(',"cache_creation_input_tokens":3', '') : stream() }));
  try {
    await f.sender.send(f.identity, f.bytes); await f.sender.parsed(f.parsed); const earlier = f.sender.finish(); assert.equal(earlier.status, 'execution_settled'); assert.equal(earlier.usage, 'incomplete');
    f.sender.begin('execute', { commandId: 'later', text: 'literal', purpose: 'task', repair: 'none' }); const next = await f.sender.invoke({ invocation: 2, ...f.input.policy.selection });
    await f.sender.send({ ...f.identity, invocation: 2, slot: next.slot }, f.bytes); await f.sender.parsed({ ...f.parsed, invocation: 2, slot: next.slot }); assert.equal(f.sender.progress()?.usage, 'complete');
    const later = f.sender.finish(); assert.equal(later.status, 'execution_settled'); assert.equal(later.usage, 'complete'); assert.equal(later.requestIds.length, 1); assert.notDeepEqual(later.requestIds, earlier.requestIds);
    const view = stateGood(f.host.store.inspect()); assert.equal(view.ledger.unknownTokenRequests, 1); assert.equal(view.ledger.admittedCalls, 2); assert.equal(f.physical(), 2);
  } finally { await f.cleanup(); }
});
