import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateUsage, LIMITS } from '../src/index.js';
import { value, code } from './fixtures.js';

test('usage partial totals preserve unknown requests and missing prices', () => {
  const result = value(aggregateUsage([
    { requestId: 'request-1', inputTokens: { provenance: 'reported', value: 20 }, outputTokens: { provenance: 'estimated', value: 5 }, costMicrousd: { provenance: 'unknown' } },
    { requestId: 'request-2', inputTokens: { provenance: 'unknown' }, outputTokens: { provenance: 'unknown' }, costMicrousd: { provenance: 'unknown' } },
  ]));
  assert.deepEqual(result.totalTokens, { knownSubtotal: 25, unknownCount: 2, completeness: 'partial', provenance: 'estimated' });
  assert.deepEqual(result.costMicrousd, { knownSubtotal: 0, unknownCount: 2, completeness: 'partial', provenance: 'unknown' });
  assert.equal(result.inputTokens.provenance, 'reported');
  assert.equal(result.requests[1]!.inputTokens.provenance, 'unknown');
  assert.equal(Object.isFrozen(result.requests[0]!.inputTokens), true);
});
test('usage zero is reported explicitly and empty trusted inventory is complete zero', () => {
  const zero = value(aggregateUsage([{ requestId: 'free', inputTokens: { provenance: 'reported', value: 0 }, outputTokens: { provenance: 'reported', value: 0 }, costMicrousd: { provenance: 'reported', value: 0 } }]));
  assert.equal(zero.totalTokens.completeness, 'complete');
  assert.equal(zero.totalTokens.provenance, 'reported');
  assert.equal(value(aggregateUsage([])).totalTokens.knownSubtotal, 0);
});
test('usage rejects forged totals, unknown-as-zero, duplicate requests, and overflow', () => {
  const request = () => ({ requestId: 'request-1', inputTokens: { provenance: 'reported', value: Number.MAX_SAFE_INTEGER }, outputTokens: { provenance: 'reported', value: 1 }, costMicrousd: { provenance: 'unknown' } });
  assert.equal(code(aggregateUsage([request()])), 'USAGE_OVERFLOW');
  const unknown = request(); Object.assign(unknown, { inputTokens: { provenance: 'unknown', value: 0 } });
  assert.equal(code(aggregateUsage([unknown])), 'FIELD_UNKNOWN');
  const duplicate = request(); duplicate.inputTokens.value = 0; duplicate.outputTokens.value = 0;
  assert.equal(code(aggregateUsage([duplicate, structuredClone(duplicate)])), 'DUPLICATE_ID');
  assert.equal(code(aggregateUsage({ requests: [], totalTokens: 0 })), 'VALUE_TYPE');
});

test('usage request collection limit is exact', () => {
  const requests = Array.from({ length: LIMITS.requests }, (_, i) => ({ requestId: 'request-' + i, inputTokens: { provenance: 'unknown' }, outputTokens: { provenance: 'unknown' }, costMicrousd: { provenance: 'unknown' } }));
  assert.equal(value(aggregateUsage(requests)).totalTokens.unknownCount, 2 * LIMITS.requests);
  requests.push({ ...requests[0]!, inputTokens: { provenance: 'unknown' }, outputTokens: { provenance: 'unknown' }, costMicrousd: { provenance: 'unknown' } });
  assert.equal(code(aggregateUsage(requests)), 'LIMIT_COLLECTION');
});

test('review R2 direct usage diagnostics use the array input root', () => {
  const request = { requestId: 'request-1', inputTokens: { provenance: 'reported', value: 0 }, outputTokens: { provenance: 'reported', value: 0 }, costMicrousd: { provenance: 'unknown' } };
  const duplicate = aggregateUsage([request, structuredClone(request)]);
  assert.equal(code(duplicate), 'DUPLICATE_ID');
  if (!duplicate.ok) assert.equal(duplicate.errors[0]!.path, '/1');
  request.inputTokens.value = Number.MAX_SAFE_INTEGER; request.outputTokens.value = 1;
  const overflow = aggregateUsage([request]);
  assert.equal(code(overflow), 'USAGE_OVERFLOW');
  if (!overflow.ok) assert.equal(overflow.errors[0]!.path, '');
  Object.assign(request, { inputTokens: 'not-a-quantity' });
  const malformed = aggregateUsage([request]);
  assert.equal(code(malformed), 'VALUE_TYPE');
  if (!malformed.ok) assert.equal(malformed.errors[0]!.path, '/0/inputTokens');
});
