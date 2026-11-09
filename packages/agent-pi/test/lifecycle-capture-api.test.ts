import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePiCapture, type PiCaptureDecodeInput } from '../src/index.js';

test('passive capture decoder never accepts missing original checkpoint and bytes', async () => {
  const decoded = await decodePiCapture({ version: 1 } as PiCaptureDecodeInput);
  assert.equal(decoded.ok, false);
});
