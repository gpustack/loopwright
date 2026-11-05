import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isWritablePath, validateDocument, LIMITS } from '../src/index.js';
import { contract, code, value } from './fixtures.js';

test('scope protected paths win and prefix boundaries are exact', () => {
  const input = contract();
  assert.equal(value(isWritablePath(input, 'packages/core/index.ts')), true);
  assert.equal(value(isWritablePath(input, 'packages/policy/secret.ts')), false);
  assert.equal(value(isWritablePath(input, 'packages-other/index.ts')), false);
  assert.equal(value(isWritablePath(input, 'packages')), true);
});
test('scope rejects traversal, ambiguous platform names and unsupported globs', () => {
  for (const path of ['/tmp/file', '../x', 'a/../b', 'a\\b', 'C:/x', 'a//b', './a', 'a/', 'NUL.txt', 'a/COM1', 'a.', 'a b', 'a%2fb', 'x\0y']) {
    assert.equal(code(isWritablePath(contract(), path)), 'PATH_INVALID', path);
  }
  for (const pattern of ['packages/*', 'a/**/b', '!a', 'a?.ts', '{a,b}', '[ab]']) {
    const input = contract(); input.spec.scope.writable = [pattern];
    assert.equal(code(validateDocument(input, 'TaskContract')), 'PATTERN_UNSUPPORTED', pattern);
  }
  const input = contract(); input.spec.scope.writable = ['**'];
  assert.equal(value(isWritablePath(input, 'a/b')), true);
});

test('scope name length and segment caps are explicit', () => {
  assert.equal(value(isWritablePath(contract(), 'a'.repeat(LIMITS.path))), false);
  assert.equal(code(isWritablePath(contract(), 'a'.repeat(LIMITS.path + 1))), 'VALUE_RANGE');
  assert.equal(value(isWritablePath(contract(), Array(LIMITS.segments).fill('a').join('/'))), false);
  assert.equal(code(isWritablePath(contract(), Array(LIMITS.segments + 1).fill('a').join('/'))), 'PATH_INVALID');
});
