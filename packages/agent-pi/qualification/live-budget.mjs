/* global process, Buffer, TextDecoder */
import { constants } from 'node:fs';
import { open, mkdir, lstat, realpath } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
export const liveRefusal = code => Object.assign(new Error('Live qualification refused'), { code });
export async function readyToken(path) { try { return await readReadyToken(path); } catch { throw liveRefusal('READY_TOKEN_REQUIRED'); } }
async function readReadyToken(path) {
 if (!path || path !== resolve(path) || await realpath(dirname(path)) !== dirname(path)) throw liveRefusal('READY_TOKEN_REQUIRED');
 const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 try { const info = await fd.stat(); if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid() || info.mode & 0o077 || info.size > 16385) throw liveRefusal('READY_TOKEN_REQUIRED');
  const bytes = Buffer.alloc(info.size + 1), read = await fd.read(bytes, 0, bytes.length, 0); if (read.bytesRead !== info.size) throw liveRefusal('READY_TOKEN_REQUIRED');
  const token = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, read.bytesRead)).trim();
  if (token.length < 16 || token.length > 16384 || [...token].some(character => { const code = character.charCodeAt(0); return code < 33 || code > 126 || character === '"' || character === '\\'; })) throw liveRefusal('READY_TOKEN_REQUIRED'); return token;
 } finally { await fd.close(); }
}
/** The live driver holds the retained S02/execution owner while reserving conservative attempts here. */
export class LiveAllowance {
 #fd; #used = 0; #uncertain = false;
 get used() { return this.#uncertain ? null : this.#used; }
 constructor(root, identity) { this.root = root; this.identity = identity; }
 async start() {
  await mkdir(this.root, { recursive: true, mode: 0o700 }); const info = await lstat(this.root);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || info.mode & 0o077 || await realpath(this.root) !== resolve(this.root)) throw liveRefusal('LIVE_COUNTER_INVALID');
  const path = join(this.root, 'allowance.ndjson'), header = { type: 'allowance', version: 1, limit: 8, identity: this.identity }; let created = false;
  try { this.#fd = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600); created = true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; this.#fd = await open(path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  try {
   if (created) { await this.#fd.writeFile(JSON.stringify(header) + '\n'); await this.#fd.sync(); const parent = await open(this.root, constants.O_RDONLY | constants.O_NOFOLLOW); try { await parent.sync(); } finally { await parent.close(); } }
   const stat = await this.#fd.stat(); if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > 8192) throw liveRefusal('LIVE_COUNTER_INVALID');
   const bytes = Buffer.alloc(stat.size); if ((await this.#fd.read(bytes, 0, bytes.length, 0)).bytesRead !== bytes.length) throw liveRefusal('LIVE_COUNTER_INVALID'); const text = bytes.toString('utf8'); if (!text.endsWith('\n')) throw liveRefusal('LIVE_COUNTER_INVALID');
   const rows = text.slice(0, -1).split('\n').map(row => JSON.parse(row)); if (JSON.stringify(rows[0]) !== JSON.stringify(header) || rows.length > 9) throw liveRefusal('LIVE_COUNTER_INVALID');
   for (const [index, row] of rows.slice(1).entries()) if (JSON.stringify(row) !== JSON.stringify({ type: 'attempt', ordinal: index + 1 })) throw liveRefusal('LIVE_COUNTER_INVALID'); this.#used = rows.length - 1;
  } catch (error) { await this.close(); throw error; }
 }
 async take() {
  if (this.#uncertain) throw liveRefusal('LIVE_COUNTER_INVALID');
  if (!this.#fd || this.#used >= 8) throw liveRefusal('LIVE_ALLOWANCE_EXHAUSTED');
  // Spend before credential delivery, therefore before any S02 issue/final physical-send check. Never refund.
  this.#uncertain = true; await this.#fd.writeFile(JSON.stringify({ type: 'attempt', ordinal: this.#used + 1 }) + '\n'); await this.#fd.sync(); this.#used++; this.#uncertain = false;
 }
 async close() { if (this.#fd) { await this.#fd.close(); this.#fd = null; } }
}
