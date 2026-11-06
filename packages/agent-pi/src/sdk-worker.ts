import { createAgentSession, ModelRuntime, SessionManager, type ExtensionFactory, type ToolDefinition, type FileEntry, type AgentSession } from '@earendil-works/pi-coding-agent';
import { mkdtemp } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Channel, type ChannelMessage } from './protocol.js';
import { compileTrustedFactories } from './factory-bootstrap.js';
import { toolArgumentsDigest } from './usage.js';
import { bridgedTools, type LocalToolName, type ToolResult } from './tools.js';
import { parseBoundedJson } from './context.js';
import { nativeMcpFactories, OwnerMcpTransport } from './mcp-transport.js';
import { parseJsonRpcMessage } from '@earendil-works/pi-mcp';
import type { AdapterPolicy } from './types.js';
import type { ParsedCandidate } from './provider.js';
import { SnapshotTransfer } from './snapshot-transfer.js';
import { rowBytes, NativeSnapshot, type SnapshotPolicy } from './snapshot.js';
import { verifyNativeCompletion } from './lifecycle.js';
import type { NativeCompletion } from './lifecycle.js';
/** Internal trusted constructor; fixture tools are supplied only by separate test entrypoints. */
export function runSdkWorker(nonce: string, options: { customTools?: ToolDefinition[]; onSettled?: () => unknown; onToolCall?: () => void; onAgentEnd?: (session: AgentSession) => Promise<void> } = {}): void {
  const channel = new Channel(nonce, process.stdin, process.stdout), snapshots = new SnapshotTransfer(channel);
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | null = null;
  let runtime: ModelRuntime, active = false, outputTokens = 1024, ordinal = 0, toolOrdinal = 0, commandOrdinal = 0;
  let receipts: Promise<void>[] = [];
  let toolResultBytes = 65536, sessionBytes = 8388608, safeSnapshot = false; let snapshotPolicy: SnapshotPolicy | null = null;
  let native: Omit<NativeCompletion, 'idle' | 'invocations' | 'pending'> = { agentEnds: 0, agentSettles: 0, aborted: false, compactionEnds: 0, compacted: false, parserAcks: 0 };
  let queued = 0, restoredEntries: FileEntry[] | null = null, restoring = false;
  const invocationWaiters = new Map<number, { resolve: (slot: string) => void; reject: (error: Error) => void }>();
  const parsedWaiters = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  const toolWaiters = new Map<number, (admitted: boolean) => void>();
  const executionWaiters = new Map<number, { resolve: (result: ToolResult) => void; reject: (error: Error) => void }>();
  const roots = new Map<string, { invocation: number; slot: string; parentId: string | null }>();
  const codemodeRoots = new Set<string>(); const nativeWaiters = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  const mcp = new OwnerMcpTransport(channel, () => { void channel.send('runtime-fault', { code: 'MCP_FAILED' }).catch(() => channel.fail()); });
  let pendingFetch: { invocation: number; slot: string; resolve: (value: Response) => void; reject: (error: Error) => void } | null = null;
  const rejectPending = () => { snapshots.close(); for (const waiter of invocationWaiters.values()) waiter.reject(new Error('owner channel closed')); invocationWaiters.clear(); for (const waiter of parsedWaiters.values()) waiter.reject(new Error('owner receipt unavailable')); parsedWaiters.clear(); pendingFetch?.reject(new Error('owner channel closed')); pendingFetch = null; for (const waiter of toolWaiters.values()) waiter(false); toolWaiters.clear(); for (const waiter of executionWaiters.values()) waiter.reject(new Error('owner execution unavailable')); executionWaiters.clear(); for (const waiter of nativeWaiters.values()) waiter.reject(new Error('Owner native result unavailable')); nativeWaiters.clear(); };
  channel.on('failed', (reason: string) => { process.stderr.write(JSON.stringify({ protocolFailure: reason }) + '\n'); rejectPending(); void session?.abort(); process.exitCode = 1; process.stdin.destroy(); });
  const authorization: ExtensionFactory = pi => { if (options.onAgentEnd) pi.on('agent_end', async () => { if (session) await options.onAgentEnd!(session); }); pi.on('tool_call', async event => {
    options.onToolCall?.();
    const parent = event.parentToolCallId ?? event.toolCallId, producer = roots.get(parent);
    if (!producer) return { block: true, reason: 'No admitted model parent' };
    const query = ++toolOrdinal, call = { invocation: producer.invocation, slot: producer.slot, callId: event.toolCallId, name: event.toolName, parentId: event.parentToolCallId ?? null };
    const args = Buffer.from(JSON.stringify(event.input)); if (args.length > 65536) return { block: true, reason: 'Argument bound' };
    const answer = new Promise<boolean>(resolve => { toolWaiters.set(query, resolve); });
    await channel.sendBytes('root-tool', { query, ...call }, args);
    if (!await answer) return { block: true, reason: 'Model parent not admitted' };
    roots.set(event.toolCallId, { invocation: producer.invocation, slot: producer.slot, parentId: call.parentId });
    if (event.toolName === 'codemode' && call.parentId === null) codemodeRoots.add(event.toolCallId);
    if (event.toolName === 'mcp__workspace__read_file') mcp.admit(call, event.input);
  });
  pi.on('tool_result', async event => {
    const result = { content: event.content, details: event.details ?? null, isError: event.isError, ...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }) };
    const body = Buffer.from(JSON.stringify({ argumentsDigest: toolArgumentsDigest(event.input), result }));
    if (body.length > toolResultBytes || event.content.some(block => block.type !== 'text')) { await channel.send('runtime-fault', { code: 'OUTPUT_LIMIT' }); return { content: [{ type: 'text', text: 'OUTPUT_LIMIT' }], details: null, isError: true }; }
    if (!codemodeRoots.has(event.toolCallId)) return;
    const producer = roots.get(event.toolCallId); if (!producer) throw new Error('Missing native result parent');
    const query = ++toolOrdinal, answer = new Promise<void>((resolve, reject) => { nativeWaiters.set(query, { resolve, reject }); }); void answer.catch(() => {});
    try { await channel.sendBytes('native-result', { query, invocation: producer.invocation, slot: producer.slot, callId: event.toolCallId, name: event.toolName, parentId: null }, body); await answer; }
    finally { nativeWaiters.delete(query); codemodeRoots.delete(event.toolCallId); }
  }); };
  const executeTool = async (name: LocalToolName, id: string, args: unknown, signal?: AbortSignal): Promise<ToolResult> => {
    const producer = roots.get(id); if (!active || !producer || executionWaiters.size >= 32) throw new Error('No admitted tool parent');
    const bytes = Buffer.from(JSON.stringify(args)); if (bytes.length > 65536) throw new Error('Tool argument bound');
    const query = ++toolOrdinal, answer = new Promise<ToolResult>((resolve, reject) => { executionWaiters.set(query, { resolve, reject }); }); void answer.catch(() => {});
    const call = { invocation: producer.invocation, slot: producer.slot, callId: id, name, parentId: producer.parentId }, cancel = () => { void channel.send('tool-cancel', call).catch(() => channel.fail()); }; signal?.addEventListener('abort', cancel, { once: true });
    try { await channel.sendBytes('tool', { query, ...call }, bytes); if (signal?.aborted) cancel(); return await answer; }
    finally { executionWaiters.delete(query); signal?.removeEventListener('abort', cancel); }
  };
  function historyBound(): void {
    if (!session) return; let bytes = 0;
    for (const entry of [session.sessionManager.getHeader(), ...session.sessionManager.getEntries()]) { if (!entry) throw new Error('Missing native history'); bytes += Buffer.byteLength(JSON.stringify(entry)) + 1; if (bytes > sessionBytes) { void channel.send('runtime-fault', { code: 'OUTPUT_LIMIT' }).catch(() => channel.fail()); throw new Error('Native transcript bound'); } }
  }
  async function handle(message: ChannelMessage): Promise<void> {
    if (await snapshots.receive(message)) return;
    if (message.kind === 'restore-start') {
      if (session || active || restoring || restoredEntries) throw new Error('Duplicate restore'); restoring = true;
      const value = message.body as { selection: AdapterPolicy['selection']; sessionBytes: number; toolNames: string[] };
      if (!Number.isSafeInteger(value.sessionBytes) || value.sessionBytes < 1 || value.sessionBytes > 8388608) throw new Error('Restore bound');
      const validator = new NativeSnapshot({ selection: value.selection, tools: value.toolNames, limits: { sessionBytes: value.sessionBytes } }), expected = snapshots.expect(async bytes => { validator.push(bytes); }, value.sessionBytes, 90000);
      void expected.done.then(async () => { restoredEntries = validator.finish(); restoring = false; await channel.send('restore-complete', null); }).catch(() => channel.fail());
      await channel.send('restore-ready', null); return;
    }
    if (message.kind === 'capture') {
      if (!session || active || !safeSnapshot || !session.isIdle || !snapshotPolicy) throw new Error('Unsafe snapshot'); active = true;
      const query = (message.body as { query: number }).query; if (!Number.isSafeInteger(query) || query < 1) throw new Error('Snapshot query');
      const validator = new NativeSnapshot(snapshotPolicy, sessionBytes, false), current = session;
      async function* rows() { const header = current.sessionManager.getHeader(); if (!header) throw new Error('Missing snapshot header'); for (const entry of [header, ...current.sessionManager.getEntries()]) { const bytes = rowBytes(entry); validator.push(bytes); yield bytes; } validator.finish(); }
      try { await snapshots.send(query, rows(), sessionBytes, () => { active = false; }); } finally { active = false; } return;
    }
    if (message.kind === 'init') {
      if (session || restoring) throw new Error('duplicate init');
      const value = message.body as { selection: AdapterPolicy['selection']; systemPrompt: string; outputTokens: number; toolNames: string[]; mcp: AdapterPolicy['mcp']; toolResultBytes: number; sessionBytes: number };
      if (!Array.isArray(value.toolNames) || value.toolNames.length > 6 || new Set(value.toolNames).size !== value.toolNames.length || value.toolNames.some(name => !['read', 'bash', 'write', 'edit', 'codemode', 'mcp__workspace__read_file'].includes(name))) throw new Error('Tool allowlist');
      if (!Number.isSafeInteger(value.sessionBytes) || value.sessionBytes < 1 || value.sessionBytes > 8388608) throw new Error('Session bound'); sessionBytes = value.sessionBytes; snapshotPolicy = { selection: value.selection, tools: value.toolNames, limits: { sessionBytes } };
      if (!Number.isSafeInteger(value.toolResultBytes) || value.toolResultBytes < 1 || value.toolResultBytes > 65536) throw new Error('Tool result bound'); toolResultBytes = value.toolResultBytes;
      if (!Number.isSafeInteger(value.outputTokens) || value.outputTokens < 1 || value.outputTokens > 1024) throw new Error('output bound'); outputTokens = value.outputTokens;
      const directory = await mkdtemp('/tmp/loopwright-sdk-');
      runtime = await ModelRuntime.create({ credentials: { read: async () => ({ type: 'api_key', key: 'loopwright-non-secret-placeholder' }), list: async () => [], modify: async () => undefined, delete: async () => {} }, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
      const model = runtime.getModel(value.selection.provider, value.selection.model);
      if (!model || model.api !== 'anthropic-messages') { await channel.send('refused', { code: 'MODEL_UNAVAILABLE' }); return; }
      const compiled = await compileTrustedFactories([{ name: 'loopwright-authorization', factory: authorization }, ...(value.toolNames.includes('codemode') || value.mcp.names.length ? nativeMcpFactories({ tools: value.toolNames, mcp: value.mcp }, mcp) : [])], value.systemPrompt);
      const customTools = options.customTools ?? bridgedTools(value.toolNames, executeTool);
      const created = await createAgentSession({ cwd: '/workspace/candidate', agentDir: directory, modelRuntime: runtime, model, thinkingLevel: value.selection.thinking as 'high' | 'xhigh', tools: options.customTools ? customTools.map(tool => tool.name) : value.toolNames, customTools,
        resourceLoader: compiled.loader, settingsManager: compiled.settings, sessionManager: SessionManager.inMemory('/workspace/candidate', undefined, restoredEntries ?? undefined) });
      session = created.session; safeSnapshot = restoredEntries !== null; restoredEntries = null;
      session.subscribe(event => {
        if (event.type === 'agent_end') native = { ...native, agentEnds: native.agentEnds + 1 };
        if (event.type === 'agent_settled') native = { ...native, agentSettles: native.agentSettles + 1, aborted: event.aborted };
        if (event.type === 'compaction_end' && event.reason === 'manual') native = { ...native, compactionEnds: native.compactionEnds + 1, compacted: !!event.result && !event.aborted && !event.willRetry, aborted: event.aborted };
        if (event.type === 'queue_update') queued = event.steering.length + event.followUp.length;
      });
      if (created.extensionsResult !== compiled.extensions || created.extensionsResult.runtime !== compiled.extensions.runtime) throw new Error('native runtime binding');
      if (session.thinkingLevel !== value.selection.thinking || session.model?.id !== model.id) { await channel.send('refused', { code: 'THINKING_UNSUPPORTED' }); return; }
      session.agent.streamFunction = (selectedModel, context, streamOptions = {}) => {
        historyBound(); const invocation = ++ordinal; let used = false, slot: string | null = null;
        const grant = new Promise<string>((resolve, reject) => { invocationWaiters.set(invocation, { resolve, reject }); });
        void grant.catch(() => {});
        void channel.send('invoke', { invocation, ...value.selection }).catch(() => channel.fail());
        const fetch = async (url: unknown, init: { body?: unknown; method?: string; headers?: HeadersInit } | undefined): Promise<Response> => {
          if (used || !active || pendingFetch) throw new Error('unadmitted fetch'); used = true; slot = await grant;
          if (typeof init?.body !== 'string') throw new Error('unsupported final body'); const bytes = Buffer.from(init.body); if (bytes.length > 65536) throw new Error('request bytes');
          const headers = new Headers(init.headers); const auth = headers.get('authorization');
          if (auth && auth !== 'Bearer loopwright-non-secret-placeholder') throw new Error('unexpected SDK credential'); headers.delete('authorization');
          const response = new Promise<Response>((resolve, reject) => { pendingFetch = { invocation, slot: slot!, resolve, reject }; });
          const [, answer] = await Promise.all([channel.sendBytes('fetch', { invocation, slot, url: String(url), method: init.method, headers: Object.fromEntries(headers) }, bytes), response]); return answer;
        };
        const native = runtime.streamSimple(selectedModel, context, { ...streamOptions, fetch: fetch as typeof globalThis.fetch, apiKey: 'loopwright-non-secret-placeholder', env: {}, reasoning: value.selection.thinking as 'high' | 'xhigh', maxTokens: outputTokens, maxRetries: 0, cacheRetention: 'short' });
        const receipt = native.result().then(async message => {
          const toolCalls = message.content.filter(block => block.type === 'toolCall').map(call => ({ id: call.id, name: call.name, argumentsDigest: toolArgumentsDigest(call.arguments) }));
          if (slot) for (const call of toolCalls) roots.set(call.id, { invocation, slot, parentId: null });
          let granted: string; try { granted = await grant; } catch { return; }
          const candidate: ParsedCandidate = { invocation, slot: granted, stopReason: message.stopReason, rawStopReason: message.rawStopReason ?? null,
            usage: { input: message.usage.input, output: message.usage.output, cacheRead: message.usage.cacheRead, cacheWrite: message.usage.cacheWrite }, toolCalls };
          const acknowledged = new Promise<void>((resolve, reject) => { parsedWaiters.set(invocation, { resolve, reject }); });
          void acknowledged.catch(() => {});
          await channel.send('parsed', candidate); await acknowledged;
        });
        receipts.push(receipt); void receipt.catch(() => {}); return native;
      };
      await session.bindExtensions({});
      await channel.send('ready', { selection: value.selection, contextWindow: model.contextWindow, maxTokens: model.maxTokens, thinkingLevel: session.thinkingLevel, node: process.version, platform: process.platform, architecture: process.arch }); return;
    }
    if (message.kind === 'invocation' || message.kind === 'invocation-denied') {
      const value = message.body as { invocation: number; slot: string }, waiter = invocationWaiters.get(value.invocation); if (!waiter) throw new Error('unknown invocation'); invocationWaiters.delete(value.invocation);
      if (message.kind === 'invocation') waiter.resolve(value.slot); else waiter.reject(new Error('Owner refused invocation')); return;
    }
    if (message.kind === 'parsed-ack' || message.kind === 'parsed-denied') {
      const value = message.body as { invocation: number }, waiter = parsedWaiters.get(value.invocation); if (!waiter) throw new Error('unknown parser ack'); parsedWaiters.delete(value.invocation);
      if (message.kind === 'parsed-ack') { native = { ...native, parserAcks: native.parserAcks + 1 }; waiter.resolve(); } else waiter.reject(new Error('Owner rejected parser receipt')); return;
    }
    if (message.kind === 'root-tool-result') { const value = message.body as { query: number; admitted: boolean }, waiter = toolWaiters.get(value.query); if (!waiter) throw new Error('unknown tool ack'); toolWaiters.delete(value.query); waiter(value.admitted === true); return; }
    if (message.kind === 'native-result-ack' || message.kind === 'native-result-denied') { const value = message.body as { query: number }, waiter = nativeWaiters.get(value.query); if (!waiter) throw new Error('Unknown native result'); nativeWaiters.delete(value.query); if (message.kind === 'native-result-ack') waiter.resolve(); else waiter.reject(new Error('Owner refused native result')); return; }
    if (message.kind === 'mcp-message') { const value = message.body as { bytes: Uint8Array }; if (value.bytes.length > 65536) throw new Error('MCP message bound'); mcp.receive(parseJsonRpcMessage(parseBoundedJson(new TextDecoder('utf-8', { fatal: true }).decode(value.bytes)))); return; }
    if (message.kind === 'mcp-refused') { mcp.refused(); return; }
    if (message.kind === 'tool-response') {
      const value = message.body as { metadata: { query: number }; bytes: Uint8Array }, waiter = executionWaiters.get(value.metadata.query); if (!waiter || value.bytes.length > 65536) throw new Error('Unknown or oversized tool result');
      executionWaiters.delete(value.metadata.query); waiter.resolve(parseBoundedJson(new TextDecoder('utf-8', { fatal: true }).decode(value.bytes)) as unknown as ToolResult); return;
    }
    if (message.kind === 'tool-denied') { const value = message.body as { query: number }, waiter = executionWaiters.get(value.query); if (!waiter) throw new Error('Unknown tool denial'); executionWaiters.delete(value.query); waiter.reject(new Error('Owner refused tool execution')); return; }
    if (message.kind === 'response') {
      if (!pendingFetch) throw new Error('unexpected response'); const value = message.body as { metadata: { invocation: number; slot: string; status: number; headers: Record<string, string> }; bytes: Uint8Array };
      if (value.metadata.invocation !== pendingFetch.invocation || value.metadata.slot !== pendingFetch.slot) throw new Error('response binding'); const pending = pendingFetch; pendingFetch = null;
      pending.resolve(new Response(Buffer.from(value.bytes), { status: value.metadata.status, headers: value.metadata.headers })); return;
    }
    if (message.kind === 'deny') { if (!pendingFetch) throw new Error('unexpected denial'); const pending = pendingFetch; pendingFetch = null; pending.reject(new Error('Owner refused send')); return; }
    if (message.kind === 'cancel') { rejectPending(); await session?.abort(); return; }
    if (message.kind === 'close') { rejectPending(); await session?.abort(); session?.dispose(); channel.close(); process.stdin.destroy(); return; }
    if (message.kind === 'execute' || message.kind === 'compact') {
      if (!session || active) throw new Error('session not ready'); active = true; safeSnapshot = false; receipts = []; const firstInvocation = ordinal, command = ++commandOrdinal;
      native = { agentEnds: 0, agentSettles: 0, aborted: false, compactionEnds: 0, compacted: false, parserAcks: 0 };
      try {
        if (message.kind === 'compact') await session.compact();
        else { const value = message.body as { text: string }; if (typeof value.text !== 'string' || value.text.trimStart().startsWith('/')) throw new Error('literal text only'); await session.prompt(value.text); }
        await Promise.all(receipts); const final = session.messages.filter(item => item.role === 'assistant').at(-1);
        const completion: NativeCompletion = { ...native, idle: session.isIdle, invocations: ordinal - firstInvocation,
          pending: queued + invocationWaiters.size + parsedWaiters.size + toolWaiters.size + executionWaiters.size + nativeWaiters.size + codemodeRoots.size + (pendingFetch ? 1 : 0) };
        historyBound(); verifyNativeCompletion(completion, message.kind); safeSnapshot = true; active = false; await channel.send('settled', { stopReason: final?.stopReason ?? null, native: completion, fixture: options.onSettled?.() ?? null });
      } finally { if (command === commandOrdinal) active = false; }
      return;
    }
    throw new Error('unsupported owner command');
  }
  channel.on('message', (message: ChannelMessage) => { void handle(message).catch(() => channel.send('refused', { code: 'PROVIDER_RESPONSE_INVALID' }).catch(() => channel.fail())); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runSdkWorker(process.argv[2] ?? '');
