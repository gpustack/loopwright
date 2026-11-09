/* global process, console */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, lstatSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reclaimRoles } from './role-cleanup.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), registry = resolve(process.argv[2]), raw = registry + '.evidence'; mkdirSync(raw, { recursive: true });
const requested = process.argv.indexOf('--ledger-dir'); let ledger;
if (requested >= 0) ledger = resolve(process.argv[requested + 1]);
else {
 const location = join(root, '.claude/s03-limits-location.json');
 if (existsSync(location)) { const stat = lstatSync(location); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > 4096) throw new Error('Invalid explicit limits location'); ledger = JSON.parse(readFileSync(location, 'utf8')).ledgerDirectory; }
 else ledger = join(root, '.claude/s03-retained-cost');
}
if (typeof ledger !== 'string' || ledger !== resolve(ledger)) throw new Error('Invalid ledger directory');
const modes = ['slow', 'overflow', 'disconnect', 'history', 'transcript-overflow', 'diagnostic', 'deadline', 'response-flood'], registries = [...modes.map(mode => join(raw, 'controls', mode, mode, 'ownership.json')), join(raw, 'mcp-ownership.json')], results = [];
writeFileSync(registry, JSON.stringify({ kind: 'nested-roles-v1', registries }));
try {
 const metadata = join(ledger, 'identity.json');
 if (!existsSync(metadata) || !JSON.parse(readFileSync(metadata, 'utf8')).samples.some(sample => sample.retained === 1024 && sample.samples.length >= 5)) {
  const progress = JSON.parse(execFileSync(process.execPath, ['packages/agent-pi/qualification/retained-cost.mjs', ledger], { encoding: 'utf8', timeout: 60000, maxBuffer: 1048576 })); results.push({ population: progress });
  if (progress.status === 'population_pending') { console.log(JSON.stringify({ status: 'blocked', code: 'RETAINED_POPULATION_PENDING', ledgerDirectory: ledger, results, action: 'Rerun the same command to continue the same retained store; no reset.' })); process.exitCode = 2; }
 }
 if (!process.exitCode) {
  const stat = lstatSync(ledger); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o022 || realpathSync(ledger) !== ledger) throw new Error('Unsafe ledger directory');
  const original = JSON.parse(readFileSync(join(ledger, 'measurements.json'), 'utf8')); for (const count of [1, 128, 1024]) if (!original.samples.some(row => row.retained === count && row.samples.length >= 5)) throw new Error('Incomplete retained samples');
  const snapshot = join(raw, 'retained-current.json'); const sample = JSON.parse(execFileSync(process.execPath, ['packages/agent-pi/qualification/retained-cost.mjs', ledger, '--resample', snapshot], { encoding: 'utf8', timeout: 30000, maxBuffer: 1048576 })); results.push({ retained: sample });
  writeFileSync(join(raw, 'retained-historical.json'), JSON.stringify(original));
  for (const mode of modes) { const result = JSON.parse(execFileSync(process.execPath, ['packages/agent-pi/qualification/lifecycle-controls.mjs', join(raw, 'controls', mode), mode], { encoding: 'utf8', timeout: 30000, maxBuffer: 1048576 })); results.push({ mode, result }); }
  const mcp = JSON.parse(execFileSync(process.execPath, ['packages/agent-pi/qualification/mcp.mjs', join(raw, 'mcp-ownership.json'), join(raw, 'mcp')], { encoding: 'utf8', timeout: 240000, maxBuffer: 1048576 })); results.push({ mcp });
  const report = { passed: true, evidence: raw, results, limits: { responseBytes: 1048576, eventQueue: 128, eventQueueBytes: 524288, sessionBytes: 8388608, channelBytes: 262144, toolResultBytes: 65536, retainedRequests: 1024 }, level: 'real local retained-store APIs, native SDK/VM/MCP roles and controlled HTTP; synthetic usage; no live provider or throughput SLA' }; writeFileSync(join(raw, 'summary.json'), JSON.stringify(report)); console.log(JSON.stringify(report));
 }
} catch (error) { writeFileSync(join(raw, 'failure.json'), JSON.stringify({ status: 'failed', exitCode: Number.isInteger(error.status) ? error.status : null, results })); process.exitCode = 1; }
finally { for (const path of registries) if (existsSync(path)) reclaimRoles(path); }
