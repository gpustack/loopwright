/* global process */
import { runSdkWorker } from '../dist/sdk-worker.js';
let hooks = 0, effects = 0;
runSdkWorker(process.argv[2], { onToolCall: () => { hooks++; }, onSettled: () => ({ hooks, effects }), customTools: [{ name: 'read', label: 'Fixture read', description: 'Count a constructor-injected local effect; no filesystem operation.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }, execute: async () => { effects++; return { content: [{ type: 'text', text: 'FIXTURE_EFFECT' }], details: {} }; } }] });
