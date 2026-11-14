import { createAgentSession, ModelRuntime, SessionManager, type ExtensionFactory, type ToolDefinition, type FileEntry, type AgentSession } from '@earendil-works/pi-coding-agent';
import type { Context } from '@earendil-works/pi-ai';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Channel, type ChannelMessage } from './protocol.js';
import { compileTrustedFactories } from './factory-bootstrap.js';
import { toolArgumentsDigest } from './usage.js';
import { bridgedTools, type BridgedToolName, type ToolResult } from './tools.js';
import { parseBoundedJson } from './context.js';
import { isExternalMcpToolName, type ExternalMcpToolSchema } from './external-mcp.js';
import { nativeMcpFactories, OwnerMcpTransport } from './mcp-transport.js';
import { parseJsonRpcMessage } from '@earendil-works/pi-mcp';
import type { AdapterPolicy } from './types.js';
import type { ParsedCandidate } from './provider.js';
import { SnapshotTransfer } from './snapshot-transfer.js';
import { rowBytes, NativeSnapshot, type SnapshotPolicy } from './snapshot.js';
import { verifyNativeCompletion } from './lifecycle.js';
import type { NativeCompletion } from './lifecycle.js';

function sliceCodepoints(text: string, maxChars: number): string {
  return Array.from(text).slice(0, maxChars).join('');
}

function compactToolArguments<T extends Record<string, unknown>>(args: T, maxStrChars: number): T {
  let modified = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && v.length > maxStrChars + 64) {
      out[k] = sliceCodepoints(v, maxStrChars) + '...[compacted]';
      modified = true;
    } else {
      out[k] = v;
    }
  }
  return modified ? (out as T) : args;
}

/**
 * Compact older bulky toolResult / non-signed thinking blocks in a shallow-cloned outbound Context
 * when multi-turn history approaches the finalized request byte budget, leaving SessionManager untouched.
 */
export function pruneContextForBudget(context: Context, maxBodyBytes: number, api: string): Context {
  if (maxBodyBytes < 8192 || !context.messages.some(msg => msg.role === 'toolResult')) return context;
  const toolCount = context.tools?.length ?? 0;
  const wireHeadroom = Math.min(9_216, Math.max(4_096, Math.floor(maxBodyBytes / 7) + toolCount * 48));
  const rawTargetBytes = Math.max(4_096, maxBodyBytes - wireHeadroom);
  const baseBytes = Buffer.byteLength(JSON.stringify({ ...context, messages: [] }));
  const minWireMargin = Math.min(4_096, 512 + toolCount * 40);
  const targetBytes = baseBytes + 2_048 > rawTargetBytes
    ? Math.max(rawTargetBytes, maxBodyBytes - minWireMargin)
    : rawTargetBytes;
  if (Buffer.byteLength(JSON.stringify(context)) <= targetBytes) return context;

  const availableMessageBytes = Math.max(1_024, targetBytes - baseBytes);

  const messages = structuredClone(context.messages);
  const candidate = (): Context => ({ ...context, messages });
  const withinBudget = (): boolean => Buffer.byteLength(JSON.stringify(candidate())) <= targetBytes;

  const toolResultIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === 'toolResult') toolResultIndices.push(i);
  }
  // Pass 1: compact older tool results first while keeping the 2 most recent tool results intact.
  const olderIndices = toolResultIndices.length > 2 ? toolResultIndices.slice(0, -2) : [];
  for (const idx of olderIndices) {
    const msg = messages[idx];
    if (!msg || msg.role !== 'toolResult') continue;
    let changed = false;
    for (const block of msg.content) {
      if (block.type === 'text' && block.text.length > 360) {
        block.text = sliceCodepoints(block.text, 220) + '\n...[earlier tool output compacted to fit context budget; re-read specific lines with offset/limit if needed]...';
        changed = true;
      }
    }
    if (changed && withinBudget()) return candidate();
  }

  // Pass 2: on APIs without signed thinking blocks, compact older assistant reasoning traces.
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') { lastAssistant = i; break; }
  }
  if (api !== 'anthropic-messages') {
    for (let i = 0; i < lastAssistant; i++) {
      const msg = messages[i];
      if (!msg || msg.role !== 'assistant') continue;
      let changed = false;
      for (const block of msg.content) {
        if (block.type === 'thinking' && block.thinking.length > 200) {
          block.thinking = sliceCodepoints(block.thinking, 120) + '...';
          changed = true;
        }
      }
      if (changed && withinBudget()) return candidate();
    }
  }

  // Pass 3: if still above budget (e.g. parallel large reads or heavy MCP tool schemas on a tight window),
  // size recent tool results against availableMessageBytes after subtracting fixed tools + systemPrompt overhead.
  const recentIndices = toolResultIndices.slice(-2);
  const perRecentChars = Math.max(240, Math.floor((availableMessageBytes / 3) / Math.max(1, recentIndices.length)));
  for (const idx of recentIndices) {
    const msg = messages[idx];
    if (!msg || msg.role !== 'toolResult') continue;
    let changed = false;
    for (const block of msg.content) {
      if (block.type === 'text' && block.text.length > perRecentChars + 120) {
        block.text = sliceCodepoints(block.text, perRecentChars) + '\n...[tool output compacted to fit context budget; use smaller limit or filter output]...';
        changed = true;
      }
    }
    if (changed && withinBudget()) return candidate();
  }

  // Pass 4 fallback: tighten remaining toolResult stubs (160 chars) and compact older non-final assistant blocks/arguments
  // so outbound context stays within targetBytes whenever baseBytes < targetBytes.
  if (!withinBudget()) {
    for (const idx of toolResultIndices) {
      const msg = messages[idx];
      if (!msg || msg.role !== 'toolResult') continue;
      let changed = false;
      for (const block of msg.content) {
        if (block.type === 'text' && block.text.length > 180) {
          block.text = sliceCodepoints(block.text, 160) + '\n...[compacted]...';
          changed = true;
        }
      }
      if (changed && withinBudget()) return candidate();
    }
    for (let i = 0; i < lastAssistant; i++) {
      const msg = messages[i];
      if (!msg || msg.role !== 'assistant') continue;
      let changed = false;
      for (const block of msg.content) {
        if (block.type === 'text' && block.text.length > 180) {
          block.text = sliceCodepoints(block.text, 160) + '...';
          changed = true;
        } else if (block.type === 'thinking' && api !== 'anthropic-messages' && block.thinking.length > 0) {
          block.thinking = '';
          changed = true;
        } else if (block.type === 'toolCall' && block.arguments && typeof block.arguments === 'object') {
          const compactedArgs = compactToolArguments(block.arguments, 160);
          if (compactedArgs !== block.arguments) {
            block.arguments = compactedArgs;
            changed = true;
          }
        }
      }
      if (changed && withinBudget()) return candidate();
    }
    // If many accumulated turns still exceed targetBytes while baseBytes < targetBytes,
    // drop the oldest complete (assistant + matching toolResult*) turn groups, preserving at least the last 2 turns.
    if (!withinBudget() && baseBytes + 512 < targetBytes) {
      let safety = 64;
      while (!withinBudget() && safety-- > 0) {
        const assistantIndices = messages
          .map((m, i) => (m?.role === 'assistant' ? i : -1))
          .filter(i => i >= 0);
        if (assistantIndices.length <= 2) break;
        const dropStart = assistantIndices[0]!;
        let dropEnd = dropStart + 1;
        while (dropEnd < messages.length && messages[dropEnd]?.role === 'toolResult') {
          dropEnd++;
        }
        // Only drop a clean paired assistant + toolResult+ span so role alternation and callId pairing stay intact.
        if (dropEnd <= dropStart + 1) break;
        messages.splice(dropStart, dropEnd - dropStart);
      }
    }
  }

  return candidate();
}

/** Internal trusted constructor; fixture tools are supplied only by separate test entrypoints. */
export function runSdkWorker(nonce: string, options: { customTools?: ToolDefinition[]; onSettled?: () => unknown; onToolCall?: () => void; onAgentEnd?: (session: AgentSession) => Promise<void> } = {}): void {
  const channel = new Channel(nonce, process.stdin, process.stdout), snapshots = new SnapshotTransfer(channel);
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | null = null;
  let runtime: ModelRuntime, active = false, outputTokens = 1024, ordinal = 0, toolOrdinal = 0, commandOrdinal = 0;
  let receipts: Promise<void>[] = [];
  let toolArgsBytes = 65536, toolResultBytes = 65536, sessionBytes = 8388608, safeSnapshot = false; let snapshotPolicy: SnapshotPolicy | null = null;
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
    const args = Buffer.from(JSON.stringify(event.input)); if (args.length > toolArgsBytes) return { block: true, reason: 'Argument bound' };
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
  const executeTool = async (name: BridgedToolName, id: string, args: unknown, signal?: AbortSignal): Promise<ToolResult> => {
    const producer = roots.get(id); if (!active || !producer || executionWaiters.size >= 32) throw new Error('No admitted tool parent');
    const bytes = Buffer.from(JSON.stringify(args)); if (bytes.length > toolArgsBytes) throw new Error('Tool argument bound');
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
      if (!Number.isSafeInteger(value.sessionBytes) || value.sessionBytes < 1 || value.sessionBytes > 67108864) throw new Error('Restore bound');
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
      const value = message.body as {
        selection: AdapterPolicy['selection'];
        systemPrompt: string;
        outputTokens: number;
        toolNames: string[];
        mcp: AdapterPolicy['mcp'];
        toolArgsBytes?: number;
        toolResultBytes: number;
        sessionBytes: number;
        contextPolicy?: Partial<AdapterPolicy['context']>;
        externalMcpTools?: readonly ExternalMcpToolSchema[];
      };
      if (
        !Array.isArray(value.toolNames)
        || value.toolNames.length > 128
        || new Set(value.toolNames).size !== value.toolNames.length
        || value.toolNames.some(name => !['read', 'bash', 'write', 'edit', 'delete', 'codemode', 'mcp__workspace__read_file'].includes(name) && !isExternalMcpToolName(name))
      ) throw new Error('Tool allowlist');
      if (!Number.isSafeInteger(value.sessionBytes) || value.sessionBytes < 1 || value.sessionBytes > 67108864) throw new Error('Session bound'); sessionBytes = value.sessionBytes; snapshotPolicy = { selection: value.selection, tools: value.toolNames, limits: { sessionBytes } };
      const initToolArgsBytes = value.toolArgsBytes ?? 65536;
      if (!Number.isSafeInteger(initToolArgsBytes) || initToolArgsBytes < 1 || initToolArgsBytes > 4194304) throw new Error('Tool argument bound'); toolArgsBytes = initToolArgsBytes;
      if (!Number.isSafeInteger(value.toolResultBytes) || value.toolResultBytes < 1 || value.toolResultBytes > 4194304) throw new Error('Tool result bound'); toolResultBytes = value.toolResultBytes;
      if (!Number.isSafeInteger(value.outputTokens) || value.outputTokens < 1 || value.outputTokens > 262144) throw new Error('output bound'); outputTokens = value.outputTokens;
      const maxRequestBytes = value.contextPolicy?.maxRequestBytes ?? 65536;
      const workingWindowCeiling = value.contextPolicy?.workingWindowCeiling ?? 98304;
      const serviceMargin = value.contextPolicy?.serviceMargin ?? 32768;
      const toolReserve = value.contextPolicy?.toolReserve ?? 16384;
      if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1 || maxRequestBytes > 16777216) throw new Error('request byte bound');
      if (!Number.isSafeInteger(workingWindowCeiling) || workingWindowCeiling < 1 || workingWindowCeiling > 16777216) throw new Error('window bound');
      if (!Number.isSafeInteger(serviceMargin) || serviceMargin < 32768 || !Number.isSafeInteger(toolReserve) || toolReserve < 16384) throw new Error('margin bound');
      const directory = await mkdtemp(join(process.env.TMPDIR || '/tmp', 'loopwright-sdk-'));
      runtime = await ModelRuntime.create({ credentials: { read: async () => ({ type: 'api_key', key: 'loopwright-non-secret-placeholder' }), list: async () => [], modify: async () => undefined, delete: async () => {} }, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
      if (value.selection.customProvider) {
        const cp = value.selection.customProvider;
        runtime.registerProvider(value.selection.provider, {
          baseUrl: cp.baseUrl,
          api: value.selection.api,
          apiKey: 'loopwright-non-secret-placeholder',
          ...(cp.authHeader !== undefined ? { authHeader: cp.authHeader } : {}),
          ...(cp.headers ? { headers: { ...cp.headers } } : {}),
          models: [{
            id: value.selection.model,
            name: value.selection.model,
            reasoning: cp.reasoning,
            input: ['text'],
            cost: {
              input: cp.cost?.input ?? 0,
              output: cp.cost?.output ?? 0,
              cacheRead: cp.cost?.cacheRead ?? 0,
              cacheWrite: cp.cost?.cacheWrite ?? 0,
            },
            contextWindow: cp.contextWindow,
            maxTokens: cp.maxTokens,
            ...(cp.thinkingLevelMap ? { thinkingLevelMap: { ...cp.thinkingLevelMap } as never } : {}),
            ...(cp.compat ? { compat: { ...cp.compat } } : {}),
            ...(cp.samplingParams ? { samplingParams: { ...cp.samplingParams } } : {}),
            ...(cp.samplingParamsByThinkingLevel ? { samplingParamsByThinkingLevel: structuredClone(cp.samplingParamsByThinkingLevel) as never } : {}),
          }],
        });
      }
      const model = runtime.getModel(value.selection.provider, value.selection.model);
      if (!model || model.api !== value.selection.api) { await channel.send('refused', { code: 'MODEL_UNAVAILABLE' }); return; }
      const compiled = await compileTrustedFactories([{ name: 'loopwright-authorization', factory: authorization }, ...(value.toolNames.includes('codemode') || value.mcp.names.length ? nativeMcpFactories({ tools: value.toolNames, mcp: value.mcp }, mcp) : [])], value.systemPrompt);
      const customTools = options.customTools ?? bridgedTools(value.toolNames, executeTool, value.externalMcpTools ?? []);
      const created = await createAgentSession({ cwd: '/workspace/candidate', agentDir: directory, modelRuntime: runtime, model, thinkingLevel: value.selection.thinking as never, tools: options.customTools ? customTools.map(tool => tool.name) : value.toolNames, customTools,
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
      const maxBodyBytes = Math.min(maxRequestBytes, Math.min(model.contextWindow, workingWindowCeiling) - serviceMargin - outputTokens - toolReserve);
      session.agent.streamFunction = (selectedModel, context, streamOptions = {}) => {
        historyBound(); const invocation = ++ordinal; let used = false, slot: string | null = null;
        const grant = new Promise<string>((resolve, reject) => { invocationWaiters.set(invocation, { resolve, reject }); });
        void grant.catch(() => {});
        void channel.send('invoke', { invocation, provider: value.selection.provider, model: value.selection.model, thinking: value.selection.thinking, api: value.selection.api }).catch(() => channel.fail());
        const fetch = async (url: unknown, init: { body?: unknown; method?: string; headers?: HeadersInit } | undefined): Promise<Response> => {
          if (used || !active || pendingFetch) throw new Error('unadmitted fetch'); used = true; slot = await grant;
          if (typeof init?.body !== 'string') throw new Error('unsupported final body'); const bytes = Buffer.from(init.body); if (bytes.length > maxRequestBytes) throw new Error('request bytes');
          const headers = new Headers(init.headers);
          const auth = headers.get('authorization');
          if (auth && auth !== 'Bearer loopwright-non-secret-placeholder') throw new Error('unexpected SDK credential');
          headers.delete('authorization');
          const xApiKey = headers.get('x-api-key');
          if (xApiKey && xApiKey !== 'loopwright-non-secret-placeholder') throw new Error('unexpected SDK credential');
          headers.delete('x-api-key');
          const response = new Promise<Response>((resolve, reject) => { pendingFetch = { invocation, slot: slot!, resolve, reject }; });
          const [, answer] = await Promise.all([channel.sendBytes('fetch', { invocation, slot, url: String(url), method: init.method, headers: Object.fromEntries(headers) }, bytes), response]); return answer;
        };
        const restStreamOptions = { ...streamOptions };
        delete restStreamOptions.reasoning;
        const reasoningPart = value.selection.thinking === 'off' ? {} : { reasoning: value.selection.thinking as Exclude<typeof value.selection.thinking, 'off'> };
        const sendContext = pruneContextForBudget(context, maxBodyBytes, value.selection.api);
        const native = runtime.streamSimple(selectedModel, sendContext, { ...restStreamOptions, ...reasoningPart, fetch: fetch as typeof globalThis.fetch, apiKey: 'loopwright-non-secret-placeholder', env: {}, maxTokens: outputTokens, maxRetries: 0, cacheRetention: 'short' });
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
      const value = message.body as { metadata: { query: number }; bytes: Uint8Array }, waiter = executionWaiters.get(value.metadata.query); if (!waiter || value.bytes.length > Math.max(65536, toolResultBytes * 2)) throw new Error('Unknown or oversized tool result');
      executionWaiters.delete(value.metadata.query); waiter.resolve(parseBoundedJson(new TextDecoder('utf-8', { fatal: true }).decode(value.bytes), { nodes: 262144, array: 4096, properties: 512 }) as unknown as ToolResult); return;
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
