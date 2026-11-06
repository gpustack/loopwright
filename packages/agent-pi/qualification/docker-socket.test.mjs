import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dockerSocket, recordedDockerSocket } from './docker-socket.mjs';
test('qualification derives another user home or preserves one explicit local socket without fallback', () => {
  assert.equal(dockerSocket('/home/another user', null), '/home/another user/.docker/run/docker.sock');
  assert.equal(dockerSocket('/home/another user', '/run/user/2468/private.sock'), '/run/user/2468/private.sock');
  for (const socket of ['', 'relative.sock', 'tcp://host:2375', '/run/../other.sock', '/run/socket\n']) assert.throws(() => dockerSocket('/home/another user', socket));
});
test('cleanup requires its recorded daemon and cannot substitute a current default', () => {
  assert.equal(recordedDockerSocket('/run/user/2468/original.sock'), '/run/user/2468/original.sock');
  for (const missing of [undefined, null, 'relative.sock']) assert.throws(() => recordedDockerSocket(missing));
});
