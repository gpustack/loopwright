import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isWritablePath,
  matchesScopePattern,
  validateRelativePath,
  validateScopePattern,
  validateDocument,
  LIMITS,
} from '../src/index.js';
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
    assert.equal(code(validateRelativePath(path)), 'PATH_INVALID', path);
  }
  for (const pattern of ['a/**/b', '!a', '{a,b}', '[ab]', 'foo**', '**foo', 'packages/**/**', 'a/**/']) {
    const input = contract(); input.spec.scope.writable = [pattern];
    assert.equal(code(validateDocument(input, 'TaskContract')), 'PATTERN_UNSUPPORTED', pattern);
    assert.equal(code(validateScopePattern(pattern)), 'PATTERN_UNSUPPORTED', pattern);
  }
  for (const invalidPattern of ['/**', '../a/*', 'a/../b', 'a\\*', 'a/NUL.*', 'a/b*.', '/abs/*', 'a/*\0b']) {
    const input = contract(); input.spec.scope.writable = [invalidPattern];
    assert.equal(code(validateDocument(input, 'TaskContract')), 'PATH_INVALID', invalidPattern);
    assert.equal(code(validateScopePattern(invalidPattern)), 'PATH_INVALID', invalidPattern);
  }
  const input = contract(); input.spec.scope.writable = ['**'];
  assert.equal(value(isWritablePath(input, 'a/b')), true);
});

test('scope explicit /** recursive directory and bounded single-segment */? globs', () => {
  const input = contract();
  input.spec.scope.writable = ['package.json', 'packages/*/package.json', 'src/foo?.ts', 'docs/**'];
  input.spec.scope.protected = ['packages/secret/package.json', 'docs/private/**'];
  assert.equal(validateDocument(input, 'TaskContract').ok, true);

  assert.equal(value(isWritablePath(input, 'package.json')), true);
  assert.equal(value(isWritablePath(input, 'package.json/nested')), false);
  assert.equal(value(isWritablePath(input, 'packages/core/package.json')), true);
  assert.equal(value(isWritablePath(input, 'packages/core/sub/package.json')), false);
  assert.equal(value(isWritablePath(input, 'packages/package.json')), false);
  assert.equal(value(isWritablePath(input, 'packages/secret/package.json')), false);
  assert.equal(value(isWritablePath(input, 'packages/core/src/index.ts')), false);
  assert.equal(value(isWritablePath(input, 'src/foo1.ts')), true);
  assert.equal(value(isWritablePath(input, 'src/fooA.ts')), true);
  assert.equal(value(isWritablePath(input, 'src/foo12.ts')), false);
  assert.equal(value(isWritablePath(input, 'src/foo.ts')), false);
  assert.equal(value(isWritablePath(input, 'src/foo/.ts')), false);
  assert.equal(value(isWritablePath(input, 'docs/a.md')), true);
  assert.equal(value(isWritablePath(input, 'docs/sub/b.md')), true);
  assert.equal(value(isWritablePath(input, 'docs-extra/a.md')), false);
  assert.equal(value(isWritablePath(input, 'docs/private/secret.md')), false);

  assert.equal(value(matchesScopePattern('packages/*/docs/**', 'packages/core/docs/guide/intro.md')), true);
  assert.equal(value(matchesScopePattern('packages/*/docs/**', 'packages/core/src/index.ts')), false);
  assert.equal(value(matchesScopePattern('packages/*', 'packages/core')), true);
  assert.equal(value(matchesScopePattern('packages/*', 'packages/core/index.ts')), false);
  assert.equal(value(matchesScopePattern('a?.ts', 'a1.ts')), true);
  assert.equal(value(matchesScopePattern('a?.ts', 'a12.ts')), false);
  assert.equal(value(matchesScopePattern('docs', 'docs')), true);
  assert.equal(value(matchesScopePattern('docs', 'docs/a.md')), false);
  assert.equal(code(matchesScopePattern(123, 'docs/a.md')), 'VALUE_TYPE');
  assert.equal(code(matchesScopePattern('docs/**', null)), 'VALUE_TYPE');
});

test('scope bounds wildcard complexity and avoids regex backtracking', () => {
  const tooMany = Array.from({ length: LIMITS.patternWildcards + 1 }, () => '*').join('/');
  assert.equal(code(validateScopePattern(tooMany)), 'PATTERN_UNSUPPORTED');

  const atLimit = Array.from({ length: LIMITS.patternWildcards }, () => '*').join('/');
  assert.equal(validateScopePattern(atLimit).ok, true);

  const start = performance.now();
  assert.equal(value(matchesScopePattern('a*a*a*a*a*a*a*a*b', 'a'.repeat(500))), false);
  assert.equal(performance.now() - start < 200, true);
});

test('scope name length and segment caps are explicit', () => {
  assert.equal(value(isWritablePath(contract(), 'a'.repeat(LIMITS.path))), false);
  assert.equal(code(isWritablePath(contract(), 'a'.repeat(LIMITS.path + 1))), 'VALUE_RANGE');
  assert.equal(value(isWritablePath(contract(), Array(LIMITS.segments).fill('a').join('/'))), false);
  assert.equal(code(isWritablePath(contract(), Array(LIMITS.segments + 1).fill('a').join('/'))), 'PATH_INVALID');
});
