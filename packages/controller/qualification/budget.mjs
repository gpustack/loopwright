/* global process */
import { mkdirSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { qualificationMaxima } from './schedule.mjs';
import { mutateLegacyBudget } from './native-lock.mjs';

const directory = resolve('.claude/s04-qualification');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const path = directory + '/budget.json';
export function charge(kind, identity) {
  return mutateLegacyBudget(path,owner,value=>{
  if (value.version !== 1 || !Array.isArray(value.containers)) throw new Error('QUALIFICATION_BUDGET_INVALID');
  if (Object.hasOwn(value, 'qualificationReservations')) throw new Error('NATIVE_RESERVATION_ACTIVATION_HELD');
  if (kind === 'container') {
    if (value.containers.length >= qualificationMaxima.containers || value.containers.some(item => item.name === identity.name)) throw new Error('QUALIFICATION_CONTAINER_LIMIT');
    value.containers.push(identity);
  } else {
    const maximum = kind === 'providerSends' ? qualificationMaxima.provider : kind === 'mcpAttempts' ? qualificationMaxima.mcp : 0;
    if (!Number.isSafeInteger(value[kind]) || value[kind] >= maximum) throw new Error('QUALIFICATION_REQUEST_LIMIT');
    value[kind]++;
  }
  return value;
  });
}
export function updateNativeTime(change){return mutateLegacyBudget(path,owner,change);}
export function persist(path, value) {
  if (resolve(path) === resolve(directory, 'budget.json')) {
    return mutateLegacyBudget(path,owner,()=>value);
  }
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flush: true });
  const parent = openSync(resolve(path, '..'), 'r');
  try { fsyncSync(parent); } finally { closeSync(parent); }
}

export const owner = { pid: process.pid, version: 1, birth: execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2000 }).trim(), boot: execFileSync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8', timeout: 2000 }).trim() };
