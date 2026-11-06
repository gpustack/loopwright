import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
/** Counted synthetic CLI and a socket inode; never connects to or starts a Docker daemon. */
export function daemonFixture(directory: string) {
  const socket = join(directory, 'fixture.sock'), executable = join(directory, 'docker-fixture'), identity = join(directory, 'daemon-id'), log = join(directory, 'daemon-calls');
  execFileSync(process.execPath, ['-e', "require('node:net').createServer().listen(process.argv[1],()=>process.exit(0))", socket], { timeout: 3000, stdio: 'pipe' });
  writeFileSync(identity, 'fixture-daemon-1'); writeFileSync(log, '');
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(executable, `#!/bin/sh
printf '%s\\n' "$@" >> ${quote(log)}
[ "$#" -eq 7 ] && [ "$1" = --config ] && [ "$3" = --host ] && [ "$4" = ${quote('unix://' + socket)} ] && [ "$5" = info ] && [ "$6" = --format ] && [ "$7" = '{{.ID}}' ] || exit 64
[ "$(/bin/cat ${quote(identity)})" != unavailable ] || exit 7
/bin/cat ${quote(identity)}
printf '\\n'
`); chmodSync(executable, 0o700);
  return { dockerSocket: socket, dockerExecutable: executable, setIdentity: (value: string) => writeFileSync(identity, value), clearCalls: () => writeFileSync(log, ''), calls: (): string[][] => { const value = readFileSync(log, 'utf8'), args = value ? value.trimEnd().split('\n') : []; assert.equal(args.length % 7, 0); const rows: string[][] = []; for (let index = 0; index < args.length; index += 7) rows.push(args.slice(index, index + 7)); return rows; } };
}
