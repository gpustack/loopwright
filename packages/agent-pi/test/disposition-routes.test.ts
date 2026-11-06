import assert from 'node:assert/strict';
import { test } from 'node:test';
import { constructAdapter } from '../src/adapter.js';
import { requestFixture, stateGood } from './request-fixtures.js';
import type { PiErrorCode } from '../src/types.js';
test('pi-retry and durable selectors refuse before credential, environment or session work', async () => {
  const f = await requestFixture(); let credentials = 0, environment = 0, starts = 0;
  try {
    for (const [policy, code] of [
      [{ ...f.input.policy, extensions: ['@monotykamary/pi-retry'] }, 'EXTENSION_UNSUPPORTED'],
      [{ ...f.input.policy, extensions: ['@earendil-works/pi-durable'] }, 'EXTENSION_UNSUPPORTED'],
      [{ ...f.input.policy, adapterId: 'pi-durable' }, 'RUNTIME_UNSUPPORTED'],
      [{ ...f.input.policy, durable: { resume: true, reset: true } }, 'INPUT_INVALID'],
    ] as const) {
      const result = await constructAdapter({ ...f.host, resolveCredential: async () => { credentials++; return { bearerToken: 'SYNTHETIC_HOST_SECRET' }; } }, { ...f.input, policy }, {
        environment: async () => { environment++; }, session: () => { starts++; throw new Error('Unselected runtime entered'); },
      }); assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, code as PiErrorCode);
    }
    assert.equal(credentials, 0); assert.equal(environment, 0); assert.equal(starts, 0); assert.equal(f.physical(), 0); assert.equal(stateGood(f.host.store.inspect()).counts.requests, 0);
  } finally { await f.cleanup(); }
});
