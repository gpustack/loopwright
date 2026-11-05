import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API_VERSION } from '../src/index.js';

test('core exposes its alpha API version', () => {
  assert.equal(API_VERSION, 'loopwright.dev/v1alpha1');
});
