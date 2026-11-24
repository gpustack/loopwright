import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  EVOLUTION_PACKAGE_NAME,
  EVOLUTION_SCAFFOLD_VERSION,
  getEvolutionPackageDescriptor,
  probeNodeSqliteSupport,
} from '../src/index.js';
import { expectedSchema } from '../../state/src/schema.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED_EVOLUTION_DEPS = new Set([
  '@loopwright/core',
  '@loopwright/state',
  '@loopwright/controller',
  '@loopwright/decisions',
  '@loopwright/memory',
  '@loopwright/taskpack',
  '@loopwright/hardware-runner',
]);

test('evolution scaffold: exports package descriptor and verifies built-in node:sqlite STRICT support', () => {
  assert.equal(EVOLUTION_PACKAGE_NAME, '@loopwright/evolution');
  assert.equal(EVOLUTION_SCAFFOLD_VERSION, 1);

  const descriptor = getEvolutionPackageDescriptor();
  assert.equal(Object.isFrozen(descriptor), true);
  assert.equal(descriptor.name, '@loopwright/evolution');
  assert.equal(descriptor.version, 1);
  assert.equal(descriptor.sqliteBuiltin, true);
  assert.match(descriptor.sqliteVersion, /^3\.\d+\.\d+/);

  const probe = probeNodeSqliteSupport();
  assert.equal(probe.strictTablesSupported, true);
  assert.equal(probe.journalMode, 'memory');
});

test('evolution scaffold: enforces zero third-party runtime dependencies and strict package layering', () => {
  const pkgPath = PACKAGE_ROOT.includes('.test-build')
    ? resolve(PACKAGE_ROOT, '..', '..', '..', 'packages', 'evolution', 'package.json')
    : join(PACKAGE_ROOT, 'package.json');
  const manifest = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    name: string;
    private: boolean;
    dependencies?: Record<string, string>;
  };

  assert.equal(manifest.name, '@loopwright/evolution');
  assert.equal(manifest.private, true);

  const depNames = Object.keys(manifest.dependencies ?? {});
  assert.ok(depNames.length > 0, 'must declare workspace dependencies');
  for (const dep of depNames) {
    assert.ok(dep.startsWith('@loopwright/'), `forbidden third-party runtime dependency: ${dep}`);
    assert.ok(ALLOWED_EVOLUTION_DEPS.has(dep), `disallowed workspace dependency for @loopwright/evolution: ${dep}`);
  }
  assert.equal(depNames.includes('@loopwright/github-app'), false);
  assert.equal(depNames.includes('@loopwright/cli'), false);
});

test('evolution scaffold: preserves @loopwright/state expectedSchema() digest format', () => {
  const digest = expectedSchema();
  assert.match(digest, /^[0-9a-f]{64}$/);
});
