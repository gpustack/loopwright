/* global process, structuredClone */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { selection, validateUsage, allowance } from './schedule.mjs';
const fresh = () => ({ version: 1, seconds: { t0: 0, initial: 0, finalPi: 0, finalController: 0 }, leafSeconds: {}, cleanupSeconds: 0 });
function usage(entries) {
  const value = fresh();
  for (const [key, amount] of entries) { value.leafSeconds[key] = amount; value.seconds[key.split(':')[0]] += amount; }
  return value;
}
test('qualification selection is closed, duplicate-free and expands each registered alias once', () => {
  assert.deepEqual(selection(['--case', 'feasibility']), { cases: ['parser-descriptor', 'capture-binding'], phase: 'finalController' });
  assert.deepEqual(selection(['--phase', 't0', '--case', 'mcp-auth']), { cases: ['mcp-http', 'mcp-tls', 'mcp-credentials'], phase: 't0' });
  for (const args of [[], ['--case'], ['--case', 'unknown'], ['--case', 'feasibility', '--case', 'feasibility'], ['--case', 'feasibility', '--phase', 'finalController', '--phase', 't0'], ['--case', 'feasibility', 'extra', 'value']]) assert.throws(() => selection(args));
});
test('native totals must retain the complete leaf history and finite original phases', () => {
  const value = usage([['t0:mcp-http', 50], ['t0:tls-fixture', 0.25], ['t0:mcp-tls', 17]]);
  assert.equal(validateUsage(value), value);
  for (const mutate of [v => { v.seconds.t0 = 0; }, v => { delete v.leafSeconds['t0:mcp-http']; }, v => { v.seconds.other = 0; }, v => { v.leafSeconds['t0:unknown'] = 0; }, v => { v.cleanupSeconds = -1; }, v => { v.seconds.t0 = Infinity; }]) { const changed = structuredClone(value); mutate(changed); assert.throws(() => validateUsage(changed)); }
});
test('a later invocation consumes remaining leaf, group and phase time without reset', () => {
  const value = usage([['t0:mcp-http', 49.5], ['t0:tls-fixture', 1], ['t0:mcp-tls', 48.75], ['t0:mcp-credentials', 99.5]]);
  assert.equal(allowance(value, 't0', 'mcp-http', 180), 121.25);
  assert.equal(allowance(value, 't0', 'mcp-tls', 180), 121.25);
  const exhausted = usage([['t0:mcp-http', 180]]); assert.throws(() => allowance(exhausted, 't0', 'mcp-http', 180));
});
test('TLS fixture work shares the TLS allowance and cannot inflate its leaf cap', () => {
  const value = usage([['t0:tls-fixture', 1], ['t0:mcp-tls', 178.75]]);
  assert.equal(allowance(value, 't0', 'tls-fixture', 10), 0.25);
  assert.equal(allowance(fresh(), 't0', 'tls-fixture', 100000), 10);
  assert.equal(allowance(fresh(), 't0', 'mcp-http', 100000), 180);
});
test('the original phase and cumulative cleanup reserve prevent additional work', () => {
  const phaseFull = usage([['t0:capture-binding', 720]]); assert.throws(() => allowance(phaseFull, 't0', 'parser-descriptor', 60));
  const allWork = usage([['t0:capture-binding', 720], ['initial:capture-binding', 1500], ['finalPi:capture-binding', 1500], ['finalController:capture-binding', 1380]]);
  assert.throws(() => allowance(allWork, 'finalController', 'parser-descriptor', 60));
  const cleanup = usage([['t0:capture-binding', 100]]); cleanup.cleanupSeconds = 5300; assert.throws(() => allowance(cleanup, 't0', 'parser-descriptor', 60));
});
test('invalid CLI selection refuses without touching retained native counters or invoking a leaf', () => {
  const path = '.claude/s04-qualification/budget.json';
  let before = null; try { before = readFileSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const result = spawnSync(process.execPath, ['packages/controller/qualification/run.mjs', '--case', 'unknown'], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
  assert.equal(result.status, 2); assert.equal(result.stdout, '');
  const output = JSON.parse(result.stderr); assert.equal(output.status, 'blocked'); assert.equal(output.cleanup, 'not_started');
  if (before) assert.deepEqual(readFileSync(path), before);
});

test('preflight cumulative750 preserves original173.961 spend, per-attempt60 and near/exhausted balance', () => {
  const current=usage([['initial:image-preflight',173.961]]);
  assert.equal(allowance(current,'initial','image-preflight',100000),60);
  assert.equal(allowance(current,'initial','image-preflight',20),20);
  assert.equal(current.leafSeconds['initial:image-preflight'],173.961);
  assert.equal(allowance(usage([['initial:image-preflight',740]]),'initial','image-preflight',120),10);
  assert.throws(()=>allowance(usage([['initial:image-preflight',750]]),'initial','image-preflight',60));
});
test('expanded preflight remains clipped to original phase, global work and total time', () => {
  const phase=usage([['initial:image-preflight',173.961],['initial:capture-binding',1325.039]]);
  assert.equal(allowance(phase,'initial','image-preflight',60),1);
  const total=usage([['t0:capture-binding',720],['initial:image-preflight',173.961],['initial:capture-binding',1325.039],['finalPi:capture-binding',1500],['finalController:capture-binding',1380]]);
  assert.equal(allowance(total,'initial','image-preflight',60),1);
  total.cleanupSeconds=300.5;assert.equal(allowance(total,'initial','image-preflight',60),0.5);
  total.cleanupSeconds=301;assert.throws(()=>allowance(total,'initial','image-preflight',60));
});


test('initial repair cumulative240 subtracts original spend before the independent120 attempt cap', () => {
  const value=usage([['initial:repair',89.646]]);
  assert.equal(allowance(value,'initial','repair',120),120);
  assert.equal(allowance(value,'initial','repair',100000),120);
  assert.equal(allowance(value,'initial','repair',60),60);
  assert.equal(allowance(usage([['initial:repair',230]]),'initial','repair',120),10);
  assert.throws(()=>allowance(usage([['initial:repair',240]]),'initial','repair',120));
  assert.equal(allowance(usage([['finalController:repair',89.646]]),'finalController','repair',120),30.354);
});

test('recovery keeps cumulative810 and limits cumulative820 with 300 attempt clips while other s03 leaves stay 120', () => {
  assert.equal(allowance(usage([]),'finalPi','s03-recovery',300),300);
  assert.equal(allowance(usage([]),'finalPi','s03-recovery',100000),300);
  assert.equal(allowance(usage([['finalPi:s03-recovery',120]]),'finalPi','s03-recovery',300),300);
  assert.equal(allowance(usage([['finalPi:s03-recovery',520]]),'finalPi','s03-recovery',300),290);
  assert.throws(()=>allowance(usage([['finalPi:s03-recovery',810]]),'finalPi','s03-recovery',300));
  assert.equal(allowance(usage([]),'finalPi','s03-limits',300),300);
  assert.equal(allowance(usage([['finalPi:s03-limits',630]]),'finalPi','s03-limits',300),290);
  assert.equal(allowance(usage([]),'finalPi','s03-dispositions',120),120);
  assert.equal(allowance(usage([['finalPi:s03-dispositions',10]]),'finalPi','s03-dispositions',120),110);
  assert.equal(allowance(usage([]),'finalPi','s03-mutations',100000),120);
  assert.throws(()=>allowance(usage([]),'initial','s03-recovery',300));
});

test('initial repair expansion stays inside original phase, global work and total balances', () => {
  const phase=usage([['initial:repair',89.646],['initial:capture-binding',1400]]);
  assert.ok(Math.abs(allowance(phase,'initial','repair',120)-10.354)<0.000001);
  const total=usage([['t0:capture-binding',720],['initial:repair',89.646],['initial:capture-binding',1360.354],['finalPi:capture-binding',1500],['finalController:capture-binding',1380]]);
  total.cleanupSeconds=349;assert.equal(allowance(total,'initial','repair',120),1);
  total.cleanupSeconds=350;assert.throws(()=>allowance(total,'initial','repair',120));
  const full=usage([['t0:capture-binding',720],['initial:repair',89.646],['initial:capture-binding',1410.354],['finalPi:capture-binding',1500],['finalController:capture-binding',1380]]);
  assert.throws(()=>allowance(full,'initial','repair',120));
});
