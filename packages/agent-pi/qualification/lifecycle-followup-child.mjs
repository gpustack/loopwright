/* global process */
import { runSdkWorker } from '../dist/sdk-worker.js';
let followed = false;
runSdkWorker(process.argv[2], { onAgentEnd: async session => { if (!followed) { followed = true; await session.followUp('fixed controlled follow-up queued by native agent_end'); } } });
