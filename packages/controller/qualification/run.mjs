/* global process, console, Buffer, setTimeout, clearTimeout */
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { persist, owner, updateNativeTime } from './budget.mjs';
import { reclaimRoles } from '../../agent-pi/qualification/role-cleanup.mjs';
import { reclaimSessionRegistry } from '../../agent-pi/qualification/session-cleanup.mjs';
import { selection, leaves, validateUsage, allowance, QualificationRefusal, nativeActivationHeld, qualificationMaxima } from './schedule.mjs';

const directory = resolve('.claude/s04-qualification');
const budgetPath = join(directory, 'budget.json');
let selected;
try { selected = selection(process.argv.slice(2)); }
catch { console.error(JSON.stringify({ status: 'blocked', code: 'QUALIFICATION_ARGUMENT_INVALID', head: null, cleanup: 'not_started', evidenceLevel: 'static_inspection' })); process.exit(2); }
const { cases, phase } = selected;
if (cases.some(nativeActivationHeld)) { console.error(JSON.stringify({ status: 'blocked', code: 'NATIVE_ACTIVATION_HELD', cleanup: 'not_started', evidenceLevel: 'offline_preparation_only' })); process.exit(2); }
const nonce = randomBytes(12).toString('hex');
const receiptPath = join(directory, 'command-' + nonce + '.json');
const receipt = { version: 1, owner, nonce, phase, cases, cwd: process.cwd(), head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), argv: process.argv, state: 'intent', results: [] };
mkdirSync(directory, { recursive: true, mode: 0o700 }); persist(receiptPath, receipt);
function budget() {
  if (existsSync(budgetPath + '.lock')) throw new QualificationRefusal('QUALIFICATION_LOCK_HELD');
  if (!existsSync(budgetPath)) {
    if (readdirSync(directory, { withFileTypes: true }).some(entry => entry.isDirectory())) throw new Error('QUALIFICATION_BUDGET_MISSING');
    persist(budgetPath, { version: 1, providerSends: 0, mcpAttempts: 0, containers: [] });
  }
  return updateNativeTime(value=>{
  if (Object.hasOwn(value, 'qualificationReservations')) throw new QualificationRefusal('NATIVE_RESERVATION_ACTIVATION_HELD');
  if (value.version !== 1 || !Array.isArray(value.containers) || value.containers.length > qualificationMaxima.containers || !Number.isSafeInteger(value.providerSends) || value.providerSends < 0 || value.providerSends > qualificationMaxima.provider
    || !Number.isSafeInteger(value.mcpAttempts) || value.mcpAttempts < 0 || value.mcpAttempts > qualificationMaxima.mcp) throw new QualificationRefusal('QUALIFICATION_BUDGET_INVALID');
  if (!value.native && (value.providerSends || value.mcpAttempts || value.containers.length)) throw new Error('QUALIFICATION_NATIVE_USAGE_REQUIRED');
  value.native ??= { version: 1, seconds: { t0: 0, initial: 0, finalPi: 0, finalController: 0 }, leafSeconds: {}, cleanupSeconds: 0 };
  validateUsage(value.native);
  return value;
  });
}
function remaining(cap, key) {
  return allowance(budget().native, phase, key, cap);
}
async function run(key, script, seconds, extra = []) {
  const allowance = remaining(seconds, key);
  if (allowance <= 0) throw new Error('QUALIFICATION_LIMIT');
  const argv = [join('packages/controller/qualification', script), ...extra];
  const record = { key, argv: [process.execPath, ...argv], secondsLimit: allowance, state: 'intent' };
  receipt.results.push(record); persist(receiptPath, receipt);
  const started = performance.now();
  let child, timedOut = false, stdout = '', stderr = '', timer;
  try {
    child = spawn(process.execPath, argv, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    record.pid = child.pid; record.state = 'started'; persist(receiptPath, receipt);
    timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Exit is checked below. */ } }, allowance * 1000);
    child.stdout.on('data', part => { stdout += part.toString(); if (Buffer.byteLength(stdout) > 4194304) { timedOut = true; process.kill(-child.pid, 'SIGKILL'); } });
    child.stderr.on('data', part => { stderr += part.toString(); if (Buffer.byteLength(stderr) > 4194304) { timedOut = true; process.kill(-child.pid, 'SIGKILL'); } });
    const exit = await new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject); });
    record.exit = exit; record.timeout = timedOut;
    record.stdoutDigest = createHash('sha256').update(stdout).digest('hex'); record.stderrDigest = createHash('sha256').update(stderr).digest('hex');
    record.state = 'exited';
    const parsed = stdout.trim() ? JSON.parse(stdout) : null;
    record.result = parsed;
    if (timedOut || exit.code !== 0 || parsed?.status === 'failed') throw new Error('QUALIFICATION_FAILED');
  } finally {
    clearTimeout(timer);
    record.seconds = (performance.now() - started) / 1000;
    updateNativeTime(value=>{validateUsage(value.native);value.native.seconds[phase]+=record.seconds;value.native.leafSeconds[phase+':'+key]=(value.native.leafSeconds[phase+':'+key]??0)+record.seconds;validateUsage(value.native);return value;});persist(receiptPath, receipt);
    if (timedOut || record.exit?.code !== 0) {
      const cleanupStart = performance.now();
      record.cleanup = [];
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const path = join(directory, entry.name, 'ownership.json');
        if (!existsSync(path)) continue;
        const registry = JSON.parse(readFileSync(path, 'utf8'));
        if (registry.owner?.pid !== child?.pid || registry.owner?.boot !== owner.boot) continue;
        if (registry.kind === 'restricted-roles-v1') record.cleanup.push(reclaimRoles(path, registry));
        else if (registry.kind === 'runtime-session-v1') record.cleanup.push(reclaimSessionRegistry(path));
      }
      updateNativeTime(value=>{validateUsage(value.native);value.native.cleanupSeconds+=(performance.now()-cleanupStart)/1000;validateUsage(value.native);return value;});persist(receiptPath, receipt);
    }
  }
}
try {
  if (cases.some(key => key !== 'parser-descriptor') && (!existsSync('.test-build/packages/agent-pi/test/session-fixtures.js') || !existsSync('.claude/s03-t0/runtime-image.id') || !existsSync('.claude/s03-t0/docker-client'))) throw new QualificationRefusal('QUALIFICATION_PREREQUISITE_MISSING');
  for (const key of cases) {
    if (key === 'mcp-tls' && !existsSync(join(directory, 'tls/ownership.json'))) await run('tls-fixture', 'tls-fixtures/generate.mjs', 10);
    const [script, seconds, ...extra] = leaves[key]; await run(key, script, seconds, extra);
  }
  receipt.state = 'passed'; persist(receiptPath, receipt);
  console.log(JSON.stringify({ status: 'passed', receipt: receiptPath, cases, head: receipt.head, cleanup: 'verified_by_leaf_receipts', evidenceLevel: 'local_execution' }));
} catch (error) {
  receipt.state = error instanceof QualificationRefusal ? 'blocked' : 'failed'; receipt.code = error instanceof QualificationRefusal ? error.code : 'QUALIFICATION_FAILED'; persist(receiptPath, receipt);
  console.error(JSON.stringify({ status: receipt.state, receipt: receiptPath, code: receipt.code, head: receipt.head, cleanup: 'see_leaf_receipts', evidenceLevel: 'local_execution' })); process.exitCode = receipt.state === 'blocked' ? 2 : 1;
}
