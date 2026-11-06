/* global process, console */
import { dockerSocket } from './docker-socket.mjs';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { reclaimSessionRegistry } from './session-cleanup.mjs';
import { reclaim } from './ownership.mjs';
import { reclaimRoles } from './role-cleanup.mjs';
import { execFileSync } from 'node:child_process';
const index = process.argv.indexOf('--case'), name = index < 0 ? undefined : process.argv[index + 1];
const cases = {
  'runtime-image': ['runtime-image.mjs', 120],
  session: ['session.mjs', 45],
  'session-opus': ['session.mjs', 45, '--model', 'claude-opus-5.5'],
  'physical-sends': ['physical-sends.mjs', 90],
  'context-guard': ['context-probe.mjs', 30],
  'parser-context-failures': ['sdk-probe.mjs', 180],
  'runtime-path': ['contained-probe.mjs', 60],
  containment: ['tools.mjs', 120],
  mcp: ['mcp.mjs', 120],
  recovery: ['recovery-suite.mjs', 120],
  dispositions: ['dispositions.mjs', 120],
  limits: ['limits.mjs', 120],
  cleanup: ['watchdog-probe.mjs', 60],
  mutations: ['mutation-probe.mjs', 60],
  'admission-mutations': ['admission-mutations.mjs', 30],
};
const selected = name === 'all' ? Object.keys(cases) : [name];
function prerequisite(key) {
  if (!existsSync('packages/agent-pi/dist/sdk-worker.js') || !existsSync('.test-build/packages/agent-pi/test/session-fixtures.js')) return 'COMPILED_FIXTURES_REQUIRED';
  if (['context-guard', 'parser-context-failures', 'mutations', 'admission-mutations'].includes(key)) return null;
  const config = process.cwd() + '/.claude/s03-t0/docker-client', socket = 'unix://' + dockerSocket();
  if (!existsSync(config)) return 'PRIVATE_DOCKER_CONFIG_REQUIRED';
  try {
    const docker = ['--config', config, '--host', socket];
    const profile = execFileSync('docker', [...docker, 'version', '--format', '{{.Server.Os}}/{{.Server.Arch}}'], { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (profile !== 'linux/arm64') return 'DOCKER_PROFILE_UNAVAILABLE';
    const image = key === 'runtime-image' ? 'sha256:067b2d425f1204b5a898ae3d3145f7524c1425a4096a62b0f67dd4344a494440' : readFileSync('.claude/s03-t0/runtime-image.id', 'utf8').trim();
    if (!/^sha256:[a-f0-9]{64}$/.test(image)) return 'PINNED_IMAGE_REQUIRED';
    execFileSync('docker', [...docker, 'image', 'inspect', image], { timeout: 5000, stdio: 'pipe' });
  } catch { return 'DOCKER_OR_PINNED_IMAGE_UNAVAILABLE'; }
  return null;
}
if (selected.some(key => !cases[key])) { console.error(JSON.stringify({ status: 'blocked', reason: 'unknown qualification case', case: name })); process.exitCode = 1; }
else for (const key of selected) {
  const missing = prerequisite(key);
  if (missing) { console.error(JSON.stringify({ case: key, status: 'blocked', code: missing })); process.exitCode = 2; break; }
  const [script, seconds, ...caseArguments] = cases[key];
  mkdirSync('.claude/s03-t0', { recursive: true });
  const ownership = process.cwd() + '/.claude/s03-t0/outer-' + randomBytes(6).toString('hex') + '.json';
  try {
    const extra = key === 'limits' && process.argv.includes('--ledger-dir') ? ['--ledger-dir', process.argv[process.argv.indexOf('--ledger-dir') + 1]] : [];
    const output = execFileSync(process.execPath, ['packages/agent-pi/qualification/' + script, ownership, ...caseArguments, ...extra], { timeout: seconds * 1000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4194304 });
    console.log(JSON.stringify({ case: key, result: JSON.parse(output) }, null, 2));
  } catch (error) {
    let cleanup = 'not_requested';
    try {
      if (existsSync(ownership)) {
        const registry = JSON.parse(readFileSync(ownership, 'utf8'));
        if (registry.kind === 'nested-roles-v1') { for (const path of registry.registries) if (existsSync(path)) reclaimRoles(path); }
        else if (registry.kind === 'restricted-roles-v1') reclaimRoles(ownership);
        else if (registry.kind === 'runtime-session-v1') reclaimSessionRegistry(ownership);
        else for (const path of registry.cleanupPaths ?? [ownership]) if (existsSync(path)) reclaim(path);
        cleanup = 'verified_owned_registry';
      }
    } catch { cleanup = 'failed'; }
    let child; try { child = JSON.parse(error.stdout); } catch { /* Unstructured stdout/stderr is not evidence. */ }
    const status = child?.status === 'blocked' ? 'blocked' : 'failed', code = typeof child?.code === 'string' && /^[A-Z_]{1,64}$/.test(child.code) ? child.code : 'QUALIFICATION_FAILED';
    console.error(JSON.stringify({ case: key, status, code: cleanup === 'failed' ? 'CLEANUP_FAILED' : code, cleanup, ownership }));
    process.exitCode = Number.isInteger(error.status) && error.status !== 0 ? error.status : 1; break;
  }
}
