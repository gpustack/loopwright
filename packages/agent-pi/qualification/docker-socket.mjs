/* global process */
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
/** Trusted operator selection only. Failure never falls back to another daemon or credential configuration. */
export function dockerSocket(home = homedir(), selected = process.env.LOOPWRIGHT_PI_DOCKER_SOCKET) {
  const socket = selected ?? join(home, '.docker/run/docker.sock');
  if (typeof socket !== 'string' || !isAbsolute(socket) || resolve(socket) !== socket || /[\0\r\n]/.test(socket)) throw new Error('Invalid local Docker socket');
  return socket;
}
export function recordedDockerSocket(selected) {
  if (typeof selected !== 'string') throw new Error('Owned registry lacks its original Docker socket');
  return dockerSocket(undefined, selected);
}
