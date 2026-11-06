/* global process */
import { runSdkWorker } from '../dist/sdk-worker.js';
runSdkWorker(process.argv[2], { onAgentEnd: async session => { for (let index = 0; index < 72; index++) session.sessionManager.appendCustomEntry('overflow-private-fixture', { index, text: 'X'.repeat(120000) }); } });
