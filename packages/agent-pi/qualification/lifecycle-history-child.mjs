/* global process */
import { runSdkWorker } from '../dist/sdk-worker.js';
let appended = false;
runSdkWorker(process.argv[2], { onAgentEnd: async session => { if (!appended) { appended = true; for (let index = 0; index < 18; index++) session.sessionManager.appendCustomEntry('bounded-private-fixture', { index, text: 'H'.repeat(70000), $ref: 'https://passive.example.invalid/data' }); } } });
