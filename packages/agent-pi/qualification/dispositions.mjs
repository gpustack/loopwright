/* global process, console */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { reclaimRoles } from './role-cleanup.mjs';
const registry = resolve(process.argv[2]), raw = registry + '.evidence', modes = ['empty', 'length', 'length-budget', 'ordinary-error', 'response-flood'], registries = modes.map(mode => join(raw, mode, mode, 'ownership.json')), results = []; mkdirSync(raw, { recursive: true }); writeFileSync(registry, JSON.stringify({ kind: 'nested-roles-v1', registries }));
try {
 for (const mode of modes) { const output = execFileSync(process.execPath, ['packages/agent-pi/qualification/lifecycle-controls.mjs', join(raw, mode), mode], { encoding: 'utf8', timeout: 30000, maxBuffer: 1048576 }); results.push({ mode, result: JSON.parse(output) }); }
 console.log(JSON.stringify({ passed: true, results, evidence: raw }));
} catch (error) { writeFileSync(join(raw, 'failure.json'), JSON.stringify({ status: 'failed', exitCode: Number.isInteger(error.status) ? error.status : null, results })); process.exitCode = 1; }
finally { for (const path of registries) if (existsSync(path)) reclaimRoles(path); }
