/* global process */
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { owner, persist } from '../budget.mjs';

const directory = resolve('.claude/s04-qualification/tls');
mkdirSync(directory, { mode: 0o700 });
const intent = { version: 1, kind: 'synthetic-local-tls-fixture', owner, directory, state: 'intent', commands: [] };
const record = () => persist(join(directory, 'ownership.json'), intent);
record();
writeFileSync(join(directory, 'ca.cnf'), '[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=Loopwright S04 synthetic fixture CA\n[ca]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\n', { mode: 0o600 });
writeFileSync(join(directory, 'leaf.cnf'), '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=mirror.loopwright.test\n[leaf]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:mirror.loopwright.test\n', { mode: 0o600 });
const commands = [
  ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-config', 'ca.cnf', '-keyout', 'ca.key', '-out', 'ca.crt'],
  ['req', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-config', 'leaf.cnf', '-keyout', 'leaf.key', '-out', 'leaf.csr'],
  ['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-set_serial', '1', '-days', '1', '-sha256', '-extfile', 'leaf.cnf', '-extensions', 'leaf', '-out', 'leaf.crt'],
];
for (const argv of commands) {
  const command = { executable: '/usr/bin/openssl', argv, state: 'intent' }; intent.commands.push(command); record();
  execFileSync(command.executable, argv, { cwd: directory, timeout: 10000, maxBuffer: 65536, stdio: 'pipe', env: { PATH: '/usr/bin:/bin' } });
  command.state = 'exited'; command.exit = 0; record();
}
for (const name of ['ca.key', 'ca.crt', 'leaf.key', 'leaf.crt', 'leaf.csr']) {
  const info = statSync(join(directory, name));
  if (info.size > 8192 || info.uid !== process.getuid()) throw new Error('TLS_FIXTURE_BOUND');
}
intent.state = 'complete'; record();
