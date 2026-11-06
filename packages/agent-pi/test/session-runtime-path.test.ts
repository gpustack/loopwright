import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { restrictedArguments } from '../src/runtime-profile.js';
test('a runtime URL containing spaces produces the exact decoded seccomp argv path', () => {
  const source = new URL('file:///tmp/owned%20runtime/packages/agent-pi/runtime/seccomp.json');
  const args = restrictedArguments('owned', {}, '/tmp/candidate space', 'sha256:' + 'a'.repeat(64), 'sdk', 'nonce', source);
  assert.ok(args.includes('seccomp=' + fileURLToPath(source))); assert.ok(!args.join('\0').includes('%20'));
  assert.ok(args.includes('type=bind,src=/tmp/candidate space,dst=/workspace/candidate,readonly'));
});
