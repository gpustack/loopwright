import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_VERSION, type TaskContract } from '@loopwright/core';
import { parseYamlDocument, readBoundedRegularFile, TaskpackError } from '@loopwright/taskpack';
import {
  HARDWARE_RUNNER_PACKAGE_NAME,
  HARDWARE_RUNNER_SCAFFOLD_VERSION,
  type HardwareRunnerDescriptor,
} from '../src/index.js';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = existsSync(resolve(THIS_DIR, '../../../package.json'))
  ? resolve(THIS_DIR, '../../..')
  : resolve(THIS_DIR, '../../../..');

test('@loopwright/hardware-runner scaffold exposes typed public boundary and uses core + taskpack without direct yaml dep', async () => {
  const descriptor: HardwareRunnerDescriptor = {
    name: HARDWARE_RUNNER_PACKAGE_NAME,
    version: HARDWARE_RUNNER_SCAFFOLD_VERSION,
  };
  assert.equal(descriptor.name, '@loopwright/hardware-runner');
  assert.equal(descriptor.version, 1);
  assert.equal(typeof API_VERSION, 'string');

  const pkgJson = JSON.parse(
    readFileSync(join(REPO_ROOT, 'packages', 'hardware-runner', 'package.json'), 'utf8'),
  ) as {
    name: string;
    private: boolean;
    type: string;
    dependencies: Record<string, string>;
  };
  assert.equal(pkgJson.name, '@loopwright/hardware-runner');
  assert.equal(pkgJson.private, true);
  assert.equal(pkgJson.type, 'module');
  assert.deepEqual(Object.keys(pkgJson.dependencies).sort(), [
    '@loopwright/core',
    '@loopwright/taskpack',
  ]);

  const dir = await mkdtemp(join(tmpdir(), 'lw-hw-runner-scaffold-'));
  try {
    const configPath = join(dir, 'relay.yaml');
    await writeFile(configPath, 'relay:\n  port: 0\n  tls: false\n', 'utf8');
    const rawBytes = await readBoundedRegularFile(configPath, 1024, msg => {
      throw new TaskpackError('TASKPACK_MANIFEST_INVALID', msg, '/');
    });
    const parsed = parseYamlDocument(Buffer.from(rawBytes).toString('utf8')) as {
      relay: { port: number; tls: boolean };
    };
    assert.equal(parsed.relay.port, 0);
    assert.equal(parsed.relay.tls, false);

    // Ensure @loopwright/core contract type is consumable at compile time
    const contractApiVersion: TaskContract['apiVersion'] = API_VERSION;
    assert.equal(contractApiVersion, API_VERSION);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
