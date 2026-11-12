import { readSync, writeSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
/** A fixed trusted reader waits until its PID/birth intent is durable, then execs Git with the same PID. */
export const GIT_ENVIRONMENT = Object.freeze({ PATH: '/usr/bin:/bin:/usr/sbin', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1',
  GIT_NO_REPLACE_OBJECTS: '1', GIT_OPTIONAL_LOCKS: '0', GIT_ATTR_NOSYSTEM: '1', GIT_ALLOW_PROTOCOL: '', GIT_PROTOCOL_FROM_USER: '0' });
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const nonce = process.argv[2], encoded = process.argv[3];
  if (!nonce || !/^[a-f0-9]{32}$/.test(nonce) || !encoded || encoded.length > 8192 || !process.execve) process.exit(2);
  const input = JSON.parse(encoded) as { repository: string; args: string[] };
  if (!isAbsolute(input.repository) || /[\0\r\n]/.test(input.repository) || !Array.isArray(input.args) || input.args.length > 8
    || input.args.some(arg => typeof arg !== 'string' || arg.length > 1024 || /[\0\r\n]/.test(arg))
    || !['rev-parse', 'ls-tree', 'cat-file', '--version'].includes(input.args[0] ?? '')) process.exit(2);
  writeSync(3, JSON.stringify({ version: 1, nonce, pid: process.pid }) + '\n');
  // Read fd 0 via blocking POSIX readSync so libuv never leaves O_NONBLOCK set across execve.
  const requestBuffer = Buffer.alloc(129);
  let requestBytes = 0;
  while (requestBytes < requestBuffer.length) {
    let chunk = 0;
    try { chunk = readSync(0, requestBuffer, requestBytes, 1, null); } catch { process.exit(2); }
    if (chunk <= 0) process.exit(2);
    requestBytes += chunk;
    if (requestBuffer[requestBytes - 1] === 10) break;
  }
  if (requestBuffer.subarray(0, requestBytes).toString('utf8') !== nonce + '\n') process.exit(2);
  process.execve!('/usr/bin/git', ['git', '--no-pager', '--no-optional-locks', '--literal-pathspecs',
    '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.attributesFile=/dev/null',
    '-c', 'credential.helper=', '-c', 'protocol.allow=never', '-C', input.repository, ...input.args], GIT_ENVIRONMENT);
}
