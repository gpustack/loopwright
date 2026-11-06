/* global process, queueMicrotask */
import { setTimeout as delay } from 'node:timers/promises';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp } from 'node:fs/promises';
import { createAgentSession, ModelRuntime, SettingsManager, SessionManager, DefaultResourceLoader, createMcpExtension, createCodemodeExtension } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
const lines = createInterface({ input: process.stdin });
const send = frame => process.stdout.write(JSON.stringify(frame) + '\n');
const events = new EventEmitter();
lines.on('line', line => { if (line.length > 65536) throw new Error('frame cap'); const frame = JSON.parse(line); if (frame.kind === 'mcp-reply') events.emit('message', frame.message); });
const transport = { start: async () => {}, send: async message => { send({ kind: 'mcp', message }); }, close: async () => { events.emit('close'); },
  onMessage: listener => { events.on('message', listener); return () => events.off('message', listener); },
  onError: listener => { events.on('error', listener); return () => events.off('error', listener); },
  onClose: listener => { events.on('close', listener); return () => events.off('close', listener); } };
let parentComplete = true;
const checks = [];
const authorization = pi => pi.on('tool_call', event => {
  checks.push({ tool: event.toolName, parentToolCallId: event.parentToolCallId ?? null, parentComplete });
  if (!parentComplete || !['codemode', 'mcp__workspace__read_file'].includes(event.toolName)) return { block: true, reason: 'frozen fixture parent/tool policy' };
});
const directory = await mkdtemp('/tmp/s03-mcp-');
const runtime = await ModelRuntime.create({ credentials: { read: async () => ({ type: 'api_key', key: 'non-secret-fixture' }), list: async () => [], modify: async () => undefined, delete: async () => {} }, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
const model = runtime.getModel('github-copilot', 'claude-sonnet-5.5');
const settings = SettingsManager.inMemory({ retry: { enabled: false, maxRetries: 0 }, compaction: { enabled: false }, cacheWarming: 'off' });
const mcp = createMcpExtension({ createTransport: () => transport, loadConfig: () => ({ servers: [{ name: 'workspace', source: directory + '/frozen-config', scope: 'global', config: { command: 'owner-pipe-only', timeout: 2, exposure: 'hidden', toolExposure: { read_file: 'codemode' } } }], errors: [], autoEnableCodemode: false }), logPath: directory + '/mcp.log' });
const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: settings, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true,
  appendSystemPromptOverride: () => [], agentsFilesOverride: () => ({ agentsFiles: [] }), systemPrompt: 'Controlled SDK fake-model feasibility fixture.', extensionFactories: [mcp, createCodemodeExtension({ models: false }), authorization] });
await loader.reload();
const { session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime: runtime, model, thinkingLevel: 'xhigh', tools: ['codemode', 'mcp__workspace__read_file'], resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(directory) });
await session.bindExtensions({});
const readyDeadline = Date.now() + 5000;
while (!session.getAllTools().some(tool => tool.name === 'mcp__workspace__read_file')) {
  if (Date.now() > readyDeadline) throw new Error('actual MCP tool startup deadline');
  await delay(10);
}
const run = async code => {
  let turn = 0;
  session.agent.streamFunction = () => {
    const stream = createAssistantMessageEventStream(); const first = turn++ === 0;
    const message = fauxAssistantMessage(first ? [fauxToolCall('codemode', { code }, { id: 'parent-' + Date.now() })] : 'DONE', { stopReason: first ? 'toolUse' : 'stop' });
    queueMicrotask(() => { stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(message); }); return stream;
  };
  await session.prompt('Owned fake-model native codemode fixture');
  return session.messages.filter(message => message.role === 'toolResult').at(-1);
};
try {
  const allowed = await run('const r = await tools.mcp__workspace__read_file({path:"allowed.txt"}); text(r); text(typeof process); text(typeof fetch); text(typeof models);');
  if (!JSON.stringify(allowed).includes('ALLOWED_OK')) throw new Error('native allowed nested read failed: ' + JSON.stringify(allowed));
  const denied = await run('await tools.mcp__workspace__denied_write({path:"protected.txt"});');
  if (!denied.isError) throw new Error('hidden nested tool was not denied');
  parentComplete = false;
  const failedParent = await run('await tools.mcp__workspace__read_file({path:"allowed.txt"});');
  if (!failedParent.isError) throw new Error('failed parent did not block native root tool');
  send({ kind: 'result', result: { level: 'actual native SDK/MCP/codemode with fake model and owned separate stdio server', allowedNestedRead: true, hiddenDenied: true, failedParentDenied: true, checks } });
} finally { await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'exit' }); session.dispose(); lines.close(); process.stdin.pause(); }
process.stdout.write('', () => process.exit(0));
