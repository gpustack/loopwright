import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { object, freeze } from './boundary.js';
import { refuse } from './errors.js';
import type { PiHost } from './types.js';
const exec = promisify(execFile);
export interface DaemonBinding { readonly socket: string; readonly id: string }
function validIdentity(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(value); }
async function canonicalSocket(path: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path || /[\0\r\n]/.test(path) || await realpath(path) !== path || !(await lstat(path)).isSocket()) refuse('RECOVERY_REQUIRED');
  return path;
}
async function identity(host: PiHost, socket: string): Promise<string> {
  const config = join(host.directory, 'guard-docker-client'); await mkdir(config, { recursive: true, mode: 0o700 });
  const info = await lstat(config); if (!info.isDirectory() || info.uid !== process.getuid?.() || info.mode & 0o077 || await realpath(config) !== config) refuse('RECOVERY_REQUIRED');
  const result = await exec(host.dockerExecutable, ['--config', config, '--host', 'unix://' + socket, 'info', '--format', '{{.ID}}'], { timeout: 5000, maxBuffer: 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin', HOME: host.directory, LANG: 'C' } });
  const id = result.stdout.trim(); if (result.stderr || !validIdentity(id)) refuse('RECOVERY_REQUIRED'); return id;
}
/** Supported Engine ID is local consistency evidence, not attestation against an administrator or malicious daemon. */
export async function selectedDaemon(host: PiHost): Promise<DaemonBinding> {
  try { const socket = await canonicalSocket(host.dockerSocket); return freeze({ socket, id: await identity(host, socket) }); }
  catch { refuse('RECOVERY_REQUIRED'); }
}
export async function verifiedDaemon(host: PiHost, retained: unknown): Promise<DaemonBinding> {
  try {
    const value = object(retained, ['socket', 'id']);
    if (typeof value.socket !== 'string' || !validIdentity(value.id)) refuse('RECOVERY_REQUIRED');
    // Reject endpoint/header drift before even a read-only daemon call.
    const socket = await canonicalSocket(host.dockerSocket); if (socket !== value.socket) refuse('RECOVERY_REQUIRED');
    if (await identity(host, socket) !== value.id) refuse('RECOVERY_REQUIRED');
    return freeze({ socket, id: value.id });
  } catch { refuse('RECOVERY_REQUIRED'); }
}
