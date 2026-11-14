import type { Channel, ChannelMessage } from './protocol.js';
import type { FetchIdentity, InvocationIdentity, ParsedCandidate, RuntimeBroker } from './provider.js';
import type { ToolIdentity } from './tools.js';
import { object, integer, canonical } from './boundary.js';
import { toolArgumentsDigest } from './usage.js';
import { parseBoundedJson } from './context.js';
function identity(value: unknown, query: boolean): ToolIdentity & { query?: number } {
  const item = object(value, [...(query ? ['query'] : []), 'invocation', 'slot', 'callId', 'name', 'parentId']);
  integer(item.invocation, 1, Number.MAX_SAFE_INTEGER); if (query) integer(item.query, 1, Number.MAX_SAFE_INTEGER);
  for (const key of ['slot', 'callId', 'name'] as const) if (typeof item[key] !== 'string' || !(item[key] as string).length || (item[key] as string).length > 256 || (item[key] as string).includes('\0')) throw new Error('Invalid tool identity');
  if (item.parentId !== null && (typeof item.parentId !== 'string' || !item.parentId || item.parentId.length > 256)) throw new Error('Invalid parent');
  return item as unknown as ToolIdentity & { query?: number };
}
/** The host alone issues grants and acknowledgements. No provider text or secret crosses on denial. */
export async function receiveBrokerMessage(channel: Channel, broker: RuntimeBroker, message: ChannelMessage): Promise<boolean> {
  if (message.kind === 'tool-cancel') { broker.cancelTool?.(identity(message.body, false)); return true; }
  if (message.kind === 'tool') {
    const value = message.body as { metadata: ToolIdentity & { query: number }; bytes: Uint8Array };
    const parsed = identity(value.metadata, true), { query, ...call } = parsed;
    try {
      if (!broker.tool) throw new Error('No execution authority');
      const result = await broker.tool(call, value.bytes);
      await channel.sendBytes('tool-response', { query }, Buffer.from(JSON.stringify(result)));
    } catch { await channel.send('tool-denied', { query }); }
    return true;
  }
  if (message.kind === 'invoke') {
    const value = message.body as InvocationIdentity;
    try { const granted = await broker.invoke(value); await channel.send('invocation', { invocation: value.invocation, ...granted }); }
    catch { await channel.send('invocation-denied', { invocation: value.invocation }); }
    return true;
  }
  if (message.kind === 'fetch') {
    const value = message.body as { metadata: FetchIdentity; bytes: Uint8Array };
    try { const reply = await broker.send(value.metadata, value.bytes); await channel.sendBytes('response', { invocation: value.metadata.invocation, slot: value.metadata.slot, status: reply.status, headers: reply.headers }, reply.bytes); }
    catch { await channel.send('deny', { invocation: value.metadata.invocation, slot: value.metadata.slot }); }
    return true;
  }
  if (message.kind === 'parsed') {
    const value = message.body as ParsedCandidate;
    try { await broker.parsed(value); await channel.send('parsed-ack', { invocation: value.invocation }); }
    catch { await channel.send('parsed-denied', { invocation: value.invocation }); }
    return true;
  }
  if (message.kind === 'root-tool') {
    const value = message.body as { metadata: unknown; bytes: Uint8Array }, { query, ...call } = identity(value.metadata, true);
    let admitted = false; try { admitted = await broker.rootTool({ ...call, argumentsBytes: value.bytes, argumentsDigest: toolArgumentsDigest(parseBoundedJson(new TextDecoder('utf-8', { fatal: true }).decode(value.bytes), { nodes: 262144, array: 4096, properties: 512 })) }); } catch { /* no authority on uncertainty */ }
    await channel.sendBytes('root-tool-result', null, Buffer.from(JSON.stringify({ query, admitted })), 'json', admitted ? () => broker.guardRootTool?.(call) : undefined); return true;
  }
  if (message.kind === 'native-result') {
    const value = message.body as { metadata: unknown; bytes: Uint8Array }, { query, ...call } = identity(value.metadata, true);
    try { if (!broker.nativeResult) throw new Error('Native result unavailable'); await broker.nativeResult(call, value.bytes); await channel.send('native-result-ack', { query }); }
    catch { await channel.send('native-result-denied', { query }); } return true;
  }
  if (message.kind === 'mcp') {
    const value = message.body as { metadata: unknown; bytes: Uint8Array }, meta = object(value.metadata, ['identity']), call = meta.identity === null ? null : identity(meta.identity, false);
    try { if (!broker.mcp) throw new Error('MCP unavailable'); await broker.mcp(call, value.bytes, message => channel.sendBytes('mcp-message', null, Buffer.from(canonical(message)))); }
    catch { await channel.send('mcp-refused', null); } return true;
  }
  if (message.kind === 'mcp-cancel') { const value = object(message.body, ['id']); broker.cancelMcp?.(value.id); return true; }
  if (message.kind === 'mcp-close') { await broker.closeMcp?.(); return true; }
  if (message.kind === 'runtime-fault') { const value = object(message.body, ['code']); if (value.code !== 'OUTPUT_LIMIT' && value.code !== 'MCP_FAILED') throw new Error('Invalid runtime failure'); broker.runtimeFault?.(value.code); return true; }
  return false;
}
