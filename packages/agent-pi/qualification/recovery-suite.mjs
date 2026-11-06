/* global process, console */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve, join } from 'node:path';
import { reclaimRoles } from './role-cleanup.mjs';
const registry = resolve(process.argv[2] ?? '.claude/s03-t5-' + randomBytes(8).toString('hex') + '.json'), raw = registry + '.evidence', registries = [], results = []; mkdirSync(raw, { recursive: true });
const commands = [];
for (const mode of ['normal', 'followup', 'compact', 'tools', 'codemode']) { const path = join(raw, mode + '-ownership.json'); registries.push(path); commands.push(['recovery.mjs', path, join(raw, mode), mode]); }
for (const mode of ['slow', 'overflow', 'disconnect', 'history', 'transcript-overflow', 'diagnostic', 'deadline']) registries.push(join(raw, 'controls', mode, 'ownership.json'));
commands.push(['lifecycle-controls.mjs', join(raw, 'controls')]);
for (const mode of ['before-artifact', 'before-checkpoint', 'after-checkpoint', 'provider-before-receipt', 'receipt-before-sdk-ack', 'tool-before-receipt']) registries.push(join(raw, 'crashes', mode, 'ownership.json'));
commands.push(['recovery-crashes.mjs', join(raw, 'crashes')]); writeFileSync(registry, JSON.stringify({ kind: 'nested-roles-v1', registries }));
try {
 for (const args of commands) { const output = execFileSync(process.execPath, ['packages/agent-pi/qualification/' + args[0], ...args.slice(1)], { encoding: 'utf8', timeout: 110000, maxBuffer: 4194304 }); results.push({ script: args[0], result: JSON.parse(output) }); }
 writeFileSync(join(raw, 'summary.json'), JSON.stringify({ passed: true, results })); console.log(JSON.stringify({ passed: true, results, evidence: raw }));
} catch (error) { writeFileSync(join(raw, 'failure.json'), JSON.stringify({ passed: false, exitCode: Number.isInteger(error.status) ? error.status : null, signal: typeof error.signal === 'string' ? error.signal : null, results })); process.exitCode = 1; }
finally { for (const path of registries) if (existsSync(path)) { const data = JSON.parse(readFileSync(path, 'utf8')); if (data.kind === 'restricted-roles-v1') reclaimRoles(path, data); } }
