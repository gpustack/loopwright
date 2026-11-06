/* global process */
import { runSdkWorker } from '../dist/sdk-worker.js';
runSdkWorker(process.argv[2], { onAgentEnd: async () => { process.stderr.write(('\u001b[31m\n::error::CONTROL_MARKER\r').repeat(128)); } });
