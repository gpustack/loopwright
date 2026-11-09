import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { NativeLedger, validateBudget } from './native-ledger.mjs';
import { copiedS03Fixture } from './pi-copied-fixture.mjs';
import { s03Identity, s03PriorIdentity, s03ActiveIdentity } from './pi-scope.mjs';
import { exclusive, canonical, sha } from './native-context.mjs';

const actualPath = resolve('.claude/s04-qualification/budget.json');
const actualBefore = readFileSync(actualPath);

test('the unchanged original book with historical identities still validates read-only', () => {
  const value = JSON.parse(actualBefore);
  validateBudget(value);
  const stamped = value.qualificationReservations.entries.map(row => row.context.dispatchId);
  assert.ok(stamped.includes(s03Identity.dispatchId), 'the historical Codex identity is stored in the book');
  assert.ok(stamped.includes(s03PriorIdentity.dispatchId), 'the historical Qwen identity is stored in the book');
  for (const dispatch of stamped) assert.ok([s03Identity.dispatchId, s03PriorIdentity.dispatchId, s03ActiveIdentity.dispatchId].includes(dispatch), 'every stored dispatch is a recorded qualification identity');
  assert.deepEqual([...readFileSync(actualPath)], [...actualBefore]);
});

test('new copied issuance carries the exact active dispatch on the plan and the stored entry', () => {
  assert.equal(s03ActiveIdentity.dispatchId, 'ctx_242594ec6fb9');
  const f = copiedS03Fixture('session');
  const stored = JSON.parse(readFileSync(f.path)).qualificationReservations.entries.find(row => row.id === f.handle.id);
  assert.equal(stored.state, 'held');
  assert.deepEqual({ runId: stored.context.runId, taskId: stored.context.taskId, dispatchId: stored.context.dispatchId }, { ...s03ActiveIdentity });
  const plan = JSON.parse(readFileSync(f.ref.path, 'utf8'));
  assert.deepEqual(plan.identity, { ...s03ActiveIdentity });
});

test('the fenced historical dispatches cannot mint a new s03 reservation', () => {
  assert.throws(() => copiedS03Fixture('session', 100000, s03Identity), /QUALIFICATION_IDENTITY/);
  assert.throws(() => copiedS03Fixture('session', 100000, s03PriorIdentity), /QUALIFICATION_IDENTITY/);
});

test('unrelated or partially matching identities cannot mint new s03 reservations', () => {
  const identities = [
    { runId: 'run_other', taskId: s03ActiveIdentity.taskId, dispatchId: s03ActiveIdentity.dispatchId },
    { runId: s03ActiveIdentity.runId, taskId: 'task_other', dispatchId: s03ActiveIdentity.dispatchId },
    { runId: s03ActiveIdentity.runId, taskId: s03ActiveIdentity.taskId, dispatchId: 'ctx_other_' + randomBytes(4).toString('hex') },
  ];
  for (const identity of identities) assert.throws(() => copiedS03Fixture('session', 100000, identity), /QUALIFICATION_IDENTITY/);
});

test('a stored historical-style s03 entry still validates while its identity cannot be reissued', () => {
  for (const historical of [s03Identity, s03PriorIdentity]) {
    const f = copiedS03Fixture('session');
    const book = JSON.parse(readFileSync(f.path));
    const entry = book.qualificationReservations.entries.find(row => row.id === f.handle.id);
    const plan = JSON.parse(readFileSync(f.ref.path, 'utf8'));
    plan.identity = { ...historical };
    entry.context = { ...entry.context, ...historical, recipeDigest: sha(canonical(plan)) };
    entry.s03.plan = exclusive(join(f.directory, 'plan-historical.json'), plan);
    exclusive(join(f.directory, 'budget-historical.json'), book);
    validateBudget(JSON.parse(readFileSync(join(f.directory, 'budget-historical.json'))));
  }
});

test('a native-mode book refuses stored foreign identities and admits the active one structurally', () => {
  const directory = mkdtempSync(resolve('.claude/s04-development/s03-identity-'));
  const held = caps => ({ id: randomBytes(16).toString('hex'), owner: { pid: 1, birth: 'unit-parent', boot: 'unit-boot' },
    context: { runId: s03ActiveIdentity.runId, taskId: s03ActiveIdentity.taskId, dispatchId: s03ActiveIdentity.dispatchId,
      sourceDigest: 'a'.repeat(64), image: 'sha256:' + 'a'.repeat(64), leafCutoff: '1', qualificationVersion: 2, recipeDigest: 'b'.repeat(64) }, caps, state: 'held', actual: null, seal: null });
  const foreign = JSON.parse(actualBefore);
  foreign.qualificationReservations.entries.push(held({ provider: 1, mcp: 0, containers: 1 }));
  foreign.qualificationReservations.entries.at(-1).context.dispatchId = 'ctx_foreign_' + randomBytes(4).toString('hex');
  const path = join(directory, 'budget-native-copy.json');
  exclusive(path, foreign);
  assert.throws(() => validateBudget(JSON.parse(readFileSync(path))), /QUALIFICATION_IDENTITY/);
  const admitted = JSON.parse(actualBefore);
  admitted.qualificationReservations.entries.push(held({ provider: 1, mcp: 0, containers: 1 }));
  const admittedPath = join(directory, 'budget-native-admitted.json');
  exclusive(admittedPath, admitted);
  validateBudget(JSON.parse(readFileSync(admittedPath)));
});

test('the actual native book stays byte-for-byte unchanged by every control', () => {
  assert.deepEqual([...readFileSync(actualPath)], [...actualBefore]);
  new NativeLedger(actualPath).read();
  assert.deepEqual([...readFileSync(actualPath)], [...actualBefore]);
});
