import assert from 'node:assert/strict';
import { test } from 'node:test';
import { digestArtifact } from '@loopwright/core';
import { prepareInput } from '../src/preflight.js';
import { sessionInput } from './session-fixtures.js';
test('case-aliased directory prefixes refuse before materialization', () => {
  const input = sessionInput() as unknown as { candidate: { artifacts: { name: string; bytes: Uint8Array }[]; manifest: { spec: { entries: unknown[] } } } };
  for (const name of ['packages/other/one.ts', 'packages/OTHER/two.ts']) { const bytes = Buffer.from('owned candidate fixture'); const ref = digestArtifact(name, bytes); assert.equal(ref.ok, true); if (ref.ok) input.candidate.manifest.spec.entries.push(ref.value); input.candidate.artifacts.push({ name, bytes }); }
  assert.throws(() => prepareInput(input));
});
