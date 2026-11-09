/* global process, console */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--case' || !['config', 'progress', 'verification', 'scheduling', 'recovery', 'artifacts', 'cli'].includes(args[1])) {
  console.error('Expected --case config|progress|verification|scheduling|recovery|artifacts|cli'); process.exit(2);
}
for (const argv of [...['core', 'state', 'agent-pi', 'controller', 'cli'].map(name => ['node_modules/typescript/bin/tsc', '-p', 'packages/' + name + '/tsconfig.json']), ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.test.json']]) {
  const built = spawnSync(process.execPath, argv, { stdio: 'inherit', timeout: 30000 }); if (built.status !== 0) process.exit(built.status ?? 1);
}
const root = args[1] === 'cli' ? '.test-build/packages/cli/test/' : '.test-build/packages/controller/test/';
const files = readdirSync(root).filter(name => (args[1] === 'cli' || name.startsWith(args[1] + '-')) && name.endsWith('.test.js')).sort().map(name => root + name);
if (!files.length) { console.error('No registered test group'); process.exit(2); }
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { stdio: 'inherit', timeout: 120000 }); process.exitCode = result.status ?? 1;
