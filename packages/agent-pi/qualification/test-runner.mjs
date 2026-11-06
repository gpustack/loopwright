/* global process */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
const argument = process.argv.indexOf('--case'), name = argument < 0 ? 'all' : process.argv[argument + 1];
const prefixes = { session: 'session-', requests: 'request-', tools: 'tool-', mcp: 'mcp-', lifecycle: 'lifecycle-', dispositions: 'disposition-' };
if (name !== 'all' && !prefixes[name]) throw new Error('unknown test case');
execFileSync('node_modules/.bin/tsc', ['-p', 'tsconfig.test.json'], { stdio: 'inherit', timeout: 30000 });
const directory = '.test-build/packages/agent-pi/test';
const files = readdirSync(directory).filter(file => file.endsWith('.test.js') && (name === 'all' || file.startsWith(prefixes[name]))).map(file => directory + '/' + file);
if (!files.length) throw new Error('requested test case is not implemented');
execFileSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { stdio: 'inherit', timeout: 90000 });
