import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDocumentBytes } from '../src/parser.js';
import { ControllerFailure } from '../src/errors.js';
const parse = (text: string, format: 'json' | 'yaml' = 'json') => parseDocumentBytes(Buffer.from(text), format);
test('JSON and YAML preserve bounded JSON values and escaped duplicate-key identity', () => {
  assert.deepEqual(parse('{"nested":[true,null,"\\u0061",3]}'), { nested: [true, null, 'a', 3] });
  assert.deepEqual(parse('nested: [true, null, "a", 3]', 'yaml'), { nested: [true, null, 'a', 3] });
  for (const [value, format] of [['{"x":1,"\\u0078":2}', 'json'], ['x: 1\nx: 2', 'yaml']] as const) assert.throws(() => parse(value, format), (error: unknown) => error instanceof ControllerFailure && error.diagnostic.code === 'CONFIG_DUPLICATE_KEY');
});
test('strict JSON rejects YAML, trailing input, unsafe numbers, malformed strings and non-UTF8', () => {
  for (const value of ['x: 1', '1 2', '{"x":1,}', '9007199254740992', '-0', '1e999', '"unclosed', '{"x":"\\uZZZZ"}']) assert.throws(() => parse(value));
  assert.throws(() => parseDocumentBytes(new Uint8Array([0xc0, 0x80]), 'json'));
});
test('YAML aliases, anchors, tags, merge keys and extra documents refuse before conversion', () => {
  for (const value of ['x: &a [1]\ny: *a', 'x: &a 1', 'x: !!str 1', '!!str x: 1', 'x: { <<: { a: 1 }}', 'x: .inf', 'x: 1\n---\ny: 2', '? [x,y]\n: value']) assert.throws(() => parse(value, 'yaml'));
});
test('parser depth, collection, string and complete encoded-byte bounds fail closed', () => {
  for (const value of ['['.repeat(33) + '0' + ']'.repeat(33), '[' + Array(129).fill('0').join(',') + ']', JSON.stringify('x'.repeat(16385)), ' '.repeat(1048577)]) assert.throws(() => parse(value));
  assert.equal(parse('0' + ' '.repeat(1048575)), 0);
});
