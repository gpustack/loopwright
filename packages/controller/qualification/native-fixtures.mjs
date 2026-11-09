/* global process, console */
import { pathToFileURL } from 'node:url';
export function nativeEntry() { return { status: 'blocked', code: 'NATIVE_ACTIVATION_HELD', cleanup: 'not_started', evidenceLevel: 'offline_preparation_only' }; }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { console.error(JSON.stringify(nativeEntry())); process.exitCode = 2; }
