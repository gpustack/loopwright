import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDocument, LIMITS, DIAGNOSTIC_CODES } from '../src/index.js';
import { contract, code, value } from './fixtures.js';

test('boundary owns and freezes ordinary and null-prototype data', () => {
  const input = contract();
  const parsed = value(validateDocument(input, 'TaskContract'));
  input.spec.roles[0]!.tools.push('bash');
  assert.equal(parsed.spec.roles[0]!.tools.length, 2);
  assert.throws(() => (parsed.spec.roles[0]!.tools as string[]).push('bash'), TypeError);
  const nullProto = Object.assign(Object.create(null), contract()) as unknown;
  assert.equal(validateDocument(nullProto, 'TaskContract').ok, true);
});
test('boundary never calls getters or toJSON and sanitizes diagnostics', () => {
  let calls = 0;
  const input = contract();
  Object.defineProperty(input.spec, 'goal', { enumerable: true, get() { calls++; return 'secret-canary'; } });
  assert.equal(code(validateDocument(input, 'TaskContract')), 'INPUT_UNSUPPORTED');
  assert.equal(calls, 0);
  const serializer = { ...contract(), toJSON() { calls++; return contract(); } };
  assert.equal(code(validateDocument(serializer, 'TaskContract')), 'INPUT_UNSUPPORTED');
  assert.equal(calls, 0);
  const error = validateDocument({ ...contract(), 'secret-canary': 'secret-canary' }, 'TaskContract');
  assert.equal(code(error), 'FIELD_UNKNOWN');
  assert.equal(JSON.stringify(error).includes('secret-canary'), false);
});
test('boundary rejects unsupported objects, values, cycles and aliases', () => {
  const cyc: unknown[] = []; cyc.push(cyc);
  assert.equal(code(validateDocument(cyc, 'TaskContract')), 'INPUT_CYCLE');
  const item = {}; const aliases = [item, item];
  assert.equal(code(validateDocument(aliases, 'TaskContract')), 'INPUT_ALIAS');
  for (const invalid of [new Date(), new Map(), { x: undefined }, { x: 1n }, { x: Symbol() }, { x() {} }, new Array(2), Object.create({ apiVersion: 'x' }) as unknown]) {
    assert.equal(code(validateDocument(invalid, 'TaskContract')), 'INPUT_UNSUPPORTED');
  }
  const array = [1]; Object.defineProperty(array, '0', { get() { throw new Error('must not run'); } });
  assert.equal(code(validateDocument(array, 'TaskContract')), 'INPUT_UNSUPPORTED');
});
test('boundary rejects duplicate decoded JSON keys and malformed syntax', () => {
  assert.equal(code(validateDocument('{"x":1,"\\u0078":2}', 'TaskContract')), 'JSON_DUPLICATE_MEMBER');
  for (const invalid of ['{"x":1,}', '[1,]', '{"x" 1}', '[01]', 'true false', '{"x":"\\q"}', '', '[', '{', '"unterminated']) {
    assert.equal(code(validateDocument(invalid, 'TaskContract')), 'JSON_SYNTAX', invalid);
  }
  assert.equal(validateDocument(JSON.stringify(contract()), 'TaskContract').ok, true);
});
test('boundary numeric and Unicode domain is explicit', () => {
  for (const number of [NaN, Infinity, -Infinity, -0, Number.MAX_SAFE_INTEGER + 1, 1.5]) {
    const input = contract(); input.spec.budgets.totalTokens = number;
    assert.equal(code(validateDocument(input, 'TaskContract')), 'VALUE_RANGE');
  }
  const input = contract(); input.spec.goal = '\ud800';
  assert.equal(code(validateDocument(input, 'TaskContract')), 'INPUT_UNSUPPORTED');
  input.spec.goal = 'valid 😀';
  assert.equal(validateDocument(input, 'TaskContract').ok, true);
});
test('boundary limits reject before schema and avoid stack exhaustion', () => {
  assert.equal(code(validateDocument(' '.repeat(LIMITS.inputBytes + 1), 'TaskContract')), 'LIMIT_BYTES');
  assert.equal(code(validateDocument({ x: 'x'.repeat(LIMITS.string + 1) }, 'TaskContract')), 'LIMIT_STRING');
  assert.equal(code(validateDocument(Array(LIMITS.collection + 1).fill(null), 'TaskContract')), 'LIMIT_COLLECTION');
  assert.equal(code(validateDocument(Object.fromEntries(Array.from({ length: LIMITS.properties + 1 }, (_, i) => ['x' + i, null])), 'TaskContract')), 'LIMIT_COLLECTION');
  let deep: unknown = null;
  for (let i = 0; i < LIMITS.depth; i++) deep = [deep];
  assert.equal(code(validateDocument(deep, 'TaskContract')), 'LIMIT_DEPTH');
  assert.equal(code(validateDocument('['.repeat(LIMITS.depth) + '0' + ']'.repeat(LIMITS.depth), 'TaskContract')), 'LIMIT_DEPTH');
});

test('boundary exact structural limits are distinct from one-over-limit rejection', () => {
  const check = (input: unknown, expected: string) => assert.equal(code(validateDocument(input, 'TaskContract')), expected);
  // These trees are intentionally not contracts. VALUE_TYPE/FIELD_REQUIRED proves
  // structural scanning completed; it does not claim domain validity.
  check(' '.repeat(LIMITS.inputBytes - 4) + 'null', 'VALUE_TYPE');
  check(' '.repeat(LIMITS.inputBytes - 3) + 'null', 'LIMIT_BYTES');
  check({ x: 'x'.repeat(LIMITS.string) }, 'FIELD_REQUIRED');
  check({ x: 'x'.repeat(LIMITS.string + 1) }, 'LIMIT_STRING');
  check(Array(LIMITS.collection).fill(null), 'VALUE_TYPE');
  check(Array(LIMITS.collection + 1).fill(null), 'LIMIT_COLLECTION');
  check(Object.fromEntries(Array.from({ length: LIMITS.properties }, (_, i) => ['x' + i, null])), 'FIELD_REQUIRED');
  check(Object.fromEntries(Array.from({ length: LIMITS.properties + 1 }, (_, i) => ['x' + i, null])), 'LIMIT_COLLECTION');
  const nested = (depth: number) => '['.repeat(depth - 1) + '0' + ']'.repeat(depth - 1);
  check(nested(LIMITS.depth), 'VALUE_TYPE');
  check(nested(LIMITS.depth + 1), 'LIMIT_DEPTH');
  const nodes = Array.from({ length: 64 }, (_, i) => Array(i === 63 ? 1_022 : 1_023).fill(null));
  check(nodes, 'VALUE_TYPE');
  check(JSON.stringify(nodes), 'VALUE_TYPE');
  nodes[63]!.push(null);
  check(nodes, 'LIMIT_NODES');
  check(JSON.stringify(nodes), 'LIMIT_NODES');
  const bytes = Array.from({ length: 64 }, (_, i) => 'x'.repeat(i === 63 ? 16_191 : 16_384));
  assert.equal(Buffer.byteLength(JSON.stringify(bytes)), LIMITS.inputBytes);
  check(bytes, 'VALUE_TYPE');
  bytes[63] += 'x';
  check(bytes, 'LIMIT_BYTES');
});

test('review R1 diagnostic code export is immutable at runtime', () => {
  assert.equal(Object.isFrozen(DIAGNOSTIC_CODES), true);
  assert.throws(() => (DIAGNOSTIC_CODES as unknown as string[]).push('MUTATED'), TypeError);
  assert.equal(Reflect.defineProperty(DIAGNOSTIC_CODES, '0', { value: 'MUTATED' }), false);
  assert.equal(DIAGNOSTIC_CODES[0], 'INPUT_TYPE');
});
