import assert from 'node:assert/strict';
export function settledExecution(result) {
  assert.equal(result.ok, true); assert.equal(result.value.status, 'execution_settled');
  assert.equal(result.value.error, null); assert.equal(result.value.localCleanup, 'complete'); return result.value;
}
export function failedExecution(result, code) {
  assert.equal(result.ok, true); assert.ok(['failed', 'cancelled', 'blocked', 'recovery_required'].includes(result.value.status));
  assert.ok(result.value.error); if (code) assert.equal(result.value.error.code, code);
  assert.ok(Array.isArray(result.value.requestIds)); assert.ok(Array.isArray(result.value.operationIds));
  assert.equal(result.value.localCleanup, 'complete'); assert.equal(result.value.cleanupError, null); return result.value;
}
