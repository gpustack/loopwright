import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, lstat, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SecretScrubber, type ResourceActivationRule } from '@loopwright/core';
import type { PiAdapterV2, PiErrorV2, PiHostV2, PiOpenInput, PiOpenInputV2, PiOutcomeV2 } from '@loopwright/agent-pi';
import { effectivePolicyV2 } from '../../agent-pi/src/policy-v2.js';
import { prepareInput } from '../../agent-pi/src/preflight.js';
import { recoverSnapshot } from '../../agent-pi/src/recovery.js';
import {
  compilePlan,
  inspectRun,
  installedHandlerDigests,
  resumeCycleWithPorts,
  runCycleWithPorts,
  stepNext,
  stepSubmit,
  type ControllerAttempt,
  type StepHandoffSelector,
  type StepTickResult,
  type StepYield,
} from '../src/index.js';
import { createCycle, Cycle, roleResourcesFor } from '../src/controller.js';
import {
  MAX_STEP_CONTEXT_FILES,
  appendHandoffPromptBlock,
  decodeJsonPointer,
  evaluateStepHandoffSelectors,
  extractFullSection,
  extractJsonPointerSection,
  extractMarkdownHeadingSection,
  materializeContextFilesDir,
} from '../src/handoff.js';
import { CONTROLLER_LIMITS } from '../src/types.js';
import { evaluateResourceActivationRules, resolveActivationPhase } from '../src/rules.js';
import { ControllerFailure, refuse } from '../src/errors.js';
import { ProgressStore, journal, validateProgress } from '../src/progress.js';
import { canonical, hash } from '../src/schema.js';
import { stateValue } from '../src/storage.js';
import { reopenLocalRun } from '@loopwright/state';
import { configurationFixture, TOKEN } from './config-fixtures.js';
import { retainedFixture, setFixture } from './progress-fixtures.js';

function sha256Hex(input: Uint8Array | string): string {
  return createHash('sha256').update(input).digest('hex');
}

function assertOk<T>(res: { readonly ok: boolean; readonly value?: T; readonly error?: unknown }, msg = ''): T {
  assert.equal(res.ok, true, `${msg}: ${JSON.stringify(res.error)}`);
  return res.value as T;
}

function assertStepYield(tick: StepTickResult, msg = ''): StepYield {
  assert.equal(tick.kind, 'step', `${msg}: expected step yield, got ${JSON.stringify(tick)}`);
  if (tick.kind !== 'step') throw new Error('expected step');
  return tick;
}

test('extractMarkdownHeadingSection handles code fences, ## C# closing hashes, includeSubheadings, UTF-8 truncation, and digests', () => {
  const doc = [
    '# Document Title',
    '',
    '```markdown',
    '## File Changes',
    '# Fake fenced heading inside backticks',
    '~~~~',
    '## Still inside backticks because fence char is backtick',
    '```',
    '',
    '~~~python',
    '## File Changes',
    '# Python comment that looks like a heading',
    '```',
    '~~~',
    '',
    '````md',
    '```',
    '## Nested 3-backtick inside 4-backtick fence',
    '````',
    '',
    '## File Changes ###',
    '- Update `packages/result.json`',
    '',
    '### Details',
    '- Subheading bullet',
    '',
    '## C#',
    'Keep trailing hash in C# title!',
    '',
    '### C# Sub',
    'C# subheading details.',
    '',
    '## ###',
    'Empty closing-hash heading body.',
    '',
    '## Emoji Section',
    'ASCII prefix then multi-byte: 🚀🚀🚀€€€漢漢漢ééé end.',
  ].join('\n');
  const raw = Buffer.from(doc, 'utf8');
  const expectedSourceSha = sha256Hex(raw);

  // 1. Fence-ignored first occurrence + closing-hash stripping (`## File Changes ###` matches `## File Changes`) + includeSubheadings default true
  const withSub = extractMarkdownHeadingSection(raw, '## File Changes', { maxBytes: 8_192 });
  assert.notEqual(withSub, null);
  assert.equal(withSub!.sourceSha256, expectedSourceSha);
  assert.equal(withSub!.truncated, false);
  assert.equal(withSub!.extractSha256, sha256Hex(Buffer.from(withSub!.content, 'utf8')));
  assert.equal(withSub!.byteLength, Buffer.byteLength(withSub!.content, 'utf8'));
  assert.match(withSub!.content, /^## File Changes ###\n- Update `packages\/result\.json`\n\n### Details\n- Subheading bullet\n$/);
  assert.equal(withSub!.content.includes('Fake fenced heading'), false);

  // 2. includeSubheadings: false stops before `### Details`
  const withoutSub = extractMarkdownHeadingSection(raw, '## File Changes', { includeSubheadings: false, maxBytes: 8_192 });
  assert.notEqual(withoutSub, null);
  assert.equal(withoutSub!.content, '## File Changes ###\n- Update `packages/result.json`\n');

  // 3. `## C#` preserves `#` because there is no whitespace before `#`
  const cSharp = extractMarkdownHeadingSection(raw, '## C#', { includeSubheadings: false, maxBytes: 8_192 });
  assert.notEqual(cSharp, null);
  assert.equal(cSharp!.content, '## C#\nKeep trailing hash in C# title!\n');

  const cSharpLevelAgnostic = extractMarkdownHeadingSection(raw, 'C#', { includeSubheadings: true, maxBytes: 8_192 });
  assert.notEqual(cSharpLevelAgnostic, null);
  assert.match(cSharpLevelAgnostic!.content, /### C# Sub/);

  // Explicit level mismatch does not match (`### C#` does not exist; `### C# Sub` has different title)
  assert.equal(extractMarkdownHeadingSection(raw, '### C#', { maxBytes: 8_192 }), null);
  assert.equal(extractMarkdownHeadingSection(raw, '## Nonexistent', { maxBytes: 8_192 }), null);

  // 4. Clean multi-byte UTF-8 boundary truncation
  const emojiFull = extractMarkdownHeadingSection(raw, '## Emoji Section', { maxBytes: 8_192 });
  assert.notEqual(emojiFull, null);
  // Choose maxBytes=64 which lands mid-sequence in multi-byte UTF-8
  const emojiTrunc = extractMarkdownHeadingSection(raw, '## Emoji Section', { maxBytes: 64 });
  assert.notEqual(emojiTrunc, null);
  assert.equal(emojiTrunc!.truncated, true);
  assert.ok(emojiTrunc!.byteLength <= 64 && emojiTrunc!.byteLength >= 61);
  assert.equal(emojiTrunc!.content.includes('\uFFFD'), false);
  assert.equal(Buffer.from(emojiTrunc!.content, 'utf8').byteLength, emojiTrunc!.byteLength);
  assert.equal(emojiTrunc!.extractSha256, sha256Hex(Buffer.from(emojiTrunc!.content, 'utf8')));
  assert.equal(emojiTrunc!.sourceSha256, expectedSourceSha);
});

test('extractJsonPointerSection, extractFullSection, and evaluateStepHandoffSelectors enforce RFC 6901, prototype rejection, and required vs optional provenance', () => {
  assert.deepEqual(decodeJsonPointer(''), []);
  assert.deepEqual(decodeJsonPointer('/'), ['']);
  assert.deepEqual(decodeJsonPointer('/a~1b/m~0n/~01/~10'), ['a/b', 'm~n', '~1', '/0']);

  for (const protoPtr of ['/__proto__', '/nested/constructor/x', '/prototype', '/a/__proto__/b']) {
    assert.throws(() => decodeJsonPointer(protoPtr), /CONFIG_SCHEMA|ARTIFACT_INVALID/);
  }
  for (const malformedPtr of ['no-leading-slash', '/bad~2escape', '/dangling~']) {
    assert.throws(() => decodeJsonPointer(malformedPtr));
  }

  const payload = {
    zebra: 1,
    constraints: { maxFiles: 3, allowNewFiles: false },
    'a/b': { 'm~n': 'escaped-ok' },
    '~1': 'tilde-one-literal',
    items: ['first', 'second'],
    '': 'empty-key-val',
  };
  const rawJson = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');

  const extracted = extractJsonPointerSection(
    rawJson,
    ['/constraints', '/a~1b/m~0n', '/~01', '/items/1', '/'],
    { maxBytes: 8_192 },
  );
  assert.notEqual(extracted, null);
  assert.equal(extracted!.truncated, false);
  assert.equal(extracted!.sourceSha256, sha256Hex(rawJson));
  assert.equal(extracted!.extractSha256, sha256Hex(Buffer.from(extracted!.content, 'utf8')));
  // Deterministic JCS canonical key order in rendered JSON
  assert.equal(
    extracted!.content,
    canonical({
      '/': 'empty-key-val',
      '/a~1b/m~0n': 'escaped-ok',
      '/constraints': { allowNewFiles: false, maxFiles: 3 },
      '/items/1': 'second',
      '/~01': 'tilde-one-literal',
    }) + '\n',
  );

  // Leading-zero array index `/items/01` and missing keys return null
  assert.equal(extractJsonPointerSection(rawJson, ['/items/01'], { maxBytes: 8_192 }), null);
  assert.equal(extractJsonPointerSection(rawJson, ['/constraints', '/missing'], { maxBytes: 8_192 }), null);

  // Prototype-key rejection inside extractJsonPointerSection even if JSON has own `__proto__`
  const rawWithProto = Buffer.from('{"__proto__":{"polluted":true},"ok":1}', 'utf8');
  assert.throws(() => extractJsonPointerSection(rawWithProto, ['/__proto__'], { maxBytes: 8_192 }));

  // Full slice UTF-8 boundary check
  const fullUtf8 = Buffer.from('A'.repeat(62) + '🚀B', 'utf8'); // 62 + 4 + 1 = 67 bytes; cut at 64 drops partial 🚀
  const fullSliced = extractFullSection(fullUtf8, { maxBytes: 64 });
  assert.equal(fullSliced.truncated, true);
  assert.equal(fullSliced.byteLength, 62);
  assert.equal(fullSliced.content, 'A'.repeat(62));

  // Missing required vs optional (`required: false`) provenance in evaluateStepHandoffSelectors
  const selectors: readonly StepHandoffSelector[] = [
    {
      id: 'opt-missing-source',
      fromStep: 'plan',
      source: { kind: 'artifact', path: 'docs/missing.md' },
      select: { kind: 'full' },
      required: false,
    },
    {
      id: 'opt-missing-heading',
      fromStep: 'plan',
      source: { kind: 'artifact', path: 'docs/present.md' },
      select: { kind: 'markdown_heading', heading: '## Absent' },
      required: false,
    },
    {
      id: 'opt-missing-ptr',
      fromStep: 'plan',
      source: { kind: 'submission' },
      select: { kind: 'json_pointer', pointers: ['/absent'] },
      required: false,
    },
  ];
  const presentMd = Buffer.from('# Intro\nHello\n', 'utf8');
  const presentJson = Buffer.from('{"version":1}', 'utf8');
  const resolvedOpt = evaluateStepHandoffSelectors(selectors, sel => {
    if (sel.source.kind === 'artifact' && sel.source.path === 'docs/missing.md') {
      return { found: false, bytes: null, fromAttemptId: 'attempt.1', reworkEpoch: 0 };
    }
    if (sel.source.kind === 'artifact') {
      return { found: true, bytes: presentMd, fromAttemptId: 'attempt.1', reworkEpoch: 0 };
    }
    return { found: true, bytes: presentJson, fromAttemptId: 'attempt.1', reworkEpoch: 0 };
  });
  assert.equal(resolvedOpt.length, 3);
  assert.equal(resolvedOpt[0]!.provenance.status, 'omitted');
  assert.equal(resolvedOpt[0]!.provenance.omittedReason, 'source_missing');
  assert.equal(resolvedOpt[0]!.provenance.sourceSha256, null);
  assert.equal(resolvedOpt[1]!.provenance.status, 'omitted');
  assert.equal(resolvedOpt[1]!.provenance.omittedReason, 'heading_missing');
  assert.equal(resolvedOpt[1]!.provenance.sourceSha256, sha256Hex(presentMd));
  assert.equal(resolvedOpt[2]!.provenance.status, 'omitted');
  assert.equal(resolvedOpt[2]!.provenance.omittedReason, 'pointer_missing');
  assert.equal(resolvedOpt[2]!.provenance.sourceSha256, sha256Hex(presentJson));

  // Required !== false fails closed with deterministic EVIDENCE_UNAVAILABLE diagnostic
  assert.throws(
    () =>
      evaluateStepHandoffSelectors(
        [{ fromStep: 'plan', source: { kind: 'artifact', path: 'docs/missing.md' }, select: { kind: 'full' } }],
        () => ({ found: false, bytes: null, fromAttemptId: 'attempt.1', reworkEpoch: 0 }),
      ),
    err => err instanceof ControllerFailure && err.diagnostic.code === 'EVIDENCE_UNAVAILABLE',
  );
  assert.throws(
    () =>
      evaluateStepHandoffSelectors(
        [{ fromStep: 'plan', source: { kind: 'artifact', path: 'docs/present.md' }, select: { kind: 'markdown_heading', heading: '## Missing' } }],
        () => ({ found: true, bytes: presentMd, fromAttemptId: 'attempt.1', reworkEpoch: 0 }),
      ),
    err => err instanceof ControllerFailure && err.diagnostic.code === 'EVIDENCE_UNAVAILABLE',
  );
  assert.throws(
    () =>
      evaluateStepHandoffSelectors(
        [{ fromStep: 'plan', source: { kind: 'submission' }, select: { kind: 'json_pointer', pointers: ['/missing'] } }],
        () => ({ found: true, bytes: presentJson, fromAttemptId: 'attempt.1', reworkEpoch: 0 }),
      ),
    err => err instanceof ControllerFailure && err.diagnostic.code === 'EVIDENCE_UNAVAILABLE',
  );
});

test('evaluateResourceActivationRules enforces AND/OR logic, phase precedence, watchedPaths fallback, and declaration order', () => {
  // Phase precedence: format > implementation(repair) > rework(reworkEpoch>0) > review > author
  assert.equal(resolveActivationPhase({ repair: 'format', reworkEpoch: 2, purpose: 'reviewer' }), 'format');
  assert.equal(resolveActivationPhase({ repair: 'implementation', reworkEpoch: 2, purpose: 'reviewer' }), 'repair');
  assert.equal(resolveActivationPhase({ repair: 'none', reworkEpoch: 1, purpose: 'reviewer' }), 'rework');
  assert.equal(resolveActivationPhase({ repair: 'none', reworkEpoch: 0, purpose: 'reviewer' }), 'review');
  assert.equal(resolveActivationPhase({ repair: 'none', reworkEpoch: 0, purpose: 'task' }), 'author');

  const nullProtoWhen = Object.assign(Object.create(null) as Record<string, unknown>, {
    changedPaths: ['packages/controller/**', 'docs/**'],
    extensions: ['.ts', '.md'],
    phases: ['author', 'repair'],
  }) as unknown as ResourceActivationRule;

  const resources = [
    { id: 'r1-unconditional' },
    { id: 'r2-ts-author-repair', when: nullProtoWhen },
    {
      id: 'r3-repair-check',
      when: {
        phases: ['repair'],
        failedChecks: ['tests', 'lint'],
        failureCodes: ['equal_mismatch', 'non_zero_exit'],
      },
    },
    { id: 'r4-rework-only', when: { phases: ['rework'] } },
    { id: 'r5-review-only', when: { phases: ['review'] } },
    { id: 'r6-always-second' },
  ] as const;

  // 1. Format repair mounts ZERO conditional rules while keeping all unconditional resources in order
  assert.deepEqual(
    evaluateResourceActivationRules(resources, {
      repair: 'format',
      reworkEpoch: 1,
      changedPaths: ['packages/controller/src/Foo.TS'],
      failedChecks: ['tests'],
      failureCodes: ['equal_mismatch'],
    }).map(r => r.id),
    ['r1-unconditional', 'r6-always-second'],
  );

  // 2. Initial author turn with empty changedPaths uses watchedPaths fallback (and case-insensitive extension check)
  assert.deepEqual(
    evaluateResourceActivationRules(resources, {
      repair: 'none',
      reworkEpoch: 0,
      purpose: 'task',
      changedPaths: [],
      watchedPaths: ['docs/GUIDE.MD'],
    }).map(r => r.id),
    ['r1-unconditional', 'r2-ts-author-repair', 'r6-always-second'],
  );

  // 3. Once candidate has changedPaths, watchedPaths is NOT used
  assert.deepEqual(
    evaluateResourceActivationRules(resources, {
      repair: 'none',
      reworkEpoch: 0,
      purpose: 'task',
      changedPaths: ['packages/memory/index.json'],
      watchedPaths: ['docs/GUIDE.MD'],
    }).map(r => r.id),
    ['r1-unconditional', 'r6-always-second'],
  );

  // 4. Implementation repair activates r2 (AND: controller/** + .ts + repair) and r3 (AND: repair + tests + equal_mismatch)
  assert.deepEqual(
    evaluateResourceActivationRules(resources, {
      repair: 'implementation',
      reworkEpoch: 0,
      purpose: 'task',
      changedPaths: ['packages/controller/src/index.ts'],
      failedChecks: ['tests'],
      failureCodes: ['equal_mismatch'],
    }).map(r => r.id),
    ['r1-unconditional', 'r2-ts-author-repair', 'r3-repair-check', 'r6-always-second'],
  );

  // 5. Partial AND mismatch on r3 (failureCodes doesn't match) excludes r3
  assert.deepEqual(
    evaluateResourceActivationRules(resources, {
      repair: 'implementation',
      reworkEpoch: 0,
      purpose: 'task',
      changedPaths: ['packages/controller/src/index.ts'],
      failedChecks: ['tests'],
      failureCodes: ['other_code'],
    }).map(r => r.id),
    ['r1-unconditional', 'r2-ts-author-repair', 'r6-always-second'],
  );

  // 6. Rework and Review phases
  assert.deepEqual(
    evaluateResourceActivationRules(resources, {
      repair: 'none',
      reworkEpoch: 1,
      purpose: 'task',
      changedPaths: ['packages/controller/src/index.ts'],
    }).map(r => r.id),
    ['r1-unconditional', 'r4-rework-only', 'r6-always-second'],
  );
  assert.deepEqual(
    evaluateResourceActivationRules(resources, {
      repair: 'none',
      reworkEpoch: 0,
      purpose: 'reviewer',
    }).map(r => r.id),
    ['r1-unconditional', 'r5-review-only', 'r6-always-second'],
  );
});

test('config.ts, compile.ts, errors.ts, and progress.ts validate when stripping, multi-segment headBranchPrefix, compaction handoff refusal, and progress schema', async () => {
  // 1. Diagnostic path tokens preserved in errors.ts
  const diagPath = '/spec/task/spec/steps/1/handoffs/0/select/pointers/0';
  try {
    refuse('CONFIG_SCHEMA', diagPath, 'configuration');
  } catch (err) {
    assert.ok(err instanceof ControllerFailure);
    assert.equal(err.diagnostic.path, diagPath);
  }
  const whenDiagPath = '/spec/task/spec/trustedContext/resources/0/when/failedChecks/0';
  try {
    refuse('CONFIG_SCHEMA', whenDiagPath, 'configuration');
  } catch (err) {
    assert.ok(err instanceof ControllerFailure);
    assert.equal(err.diagnostic.path, whenDiagPath);
  }

  // 2. config.ts strips `when` against TrustedRegistry, compile.ts strips `when` on PlannedRole.policy.resources, and multi-segment headBranchPrefix works
  const f = await configurationFixture();
  try {
    const installed = await installedHandlerDigests();
    const ruleBytes = Buffer.from('Conditional rule body.\n', 'utf8');
    await writeFile(join(f.operator, 'cond-rule.md'), ruleBytes, { mode: 0o600 });
    const regRes = { id: 'cond-rule', kind: 'instruction' as const, path: 'cond-rule.md', digest: hash(ruleBytes) };
    setFixture(f.registry, ['spec', 'resources'], [regRes]);
    setFixture(f.config, ['spec', 'task', 'spec', 'trustedContext', 'resources'], [
      { ...regRes, when: { phases: ['repair'], extensions: ['.json'] } },
    ]);

    f.environment.PUB_SIGN = 'PUB_SIGN_SECRET_112233';
    setFixture(f.registry, ['spec', 'credentialBindings'], [
      ...f.registry.spec.credentialBindings,
      { id: 'pub-sign', consumer: 'publisher', destinationRef: 'pub-dest', environmentNames: ['PUB_SIGN'], template: '${PUB_SIGN}' },
    ]);
    setFixture(f.registry, ['spec', 'environmentBindings'], [
      ...f.registry.spec.environmentBindings,
      { name: 'PUB_SIGN', classification: 'credential', paths: ['/spec/credentials/1/template'] },
    ]);
    setFixture(f.registry, ['spec', 'publicationEndpoints'], [
      { id: 'pr-pub', url: 'https://api.github.example/publish', signingCredentialRef: 'pub-sign', authCredentialRef: null, timeoutMs: 2000 },
    ]);
    setFixture(f.config, ['spec', 'credentials'], [
      ...f.config.spec.credentials,
      { ref: 'pub-sign', template: '${PUB_SIGN}' },
    ]);
    setFixture(f.config, ['spec', 'publication'], {
      mode: 'pull_request',
      endpointRef: 'pr-pub',
      targetBranch: 'main',
      headBranchPrefix: 'loopwright/docs/',
      titleTemplate: 'Docs sync PR',
    });
    await f.save();
    const loaded = assertOk(await f.load(), 'load multi-segment prefix + conditional resource');
    const plan = assertOk(await compilePlan(loaded), 'compile plan');
    assert.equal(plan.publication.mode, 'pull_request');
    if (plan.publication.mode === 'pull_request') {
      assert.equal(plan.publication.headBranchPrefix, 'loopwright/docs/');
    }
    // PlannedRole.policy.resources has preamble + 4-field ResourceIdentity WITHOUT `when`
    assert.equal(plan.roles[0]!.policy.resources.length, 2);
    assert.deepEqual(Object.keys(plan.roles[0]!.policy.resources[1]!).sort(), ['digest', 'id', 'kind', 'path']);

    // Invalid headBranchPrefix cases fail closed with CONFIG_SCHEMA
    for (const badPrefix of ['/leading/', 'loopwright//docs/', 'loopwright/./docs/', 'loopwright/../docs/', 'loopwright/docs.lock/', 'a'.repeat(65)]) {
      setFixture(f.config, ['spec', 'publication', 'headBranchPrefix'], badPrefix);
      await f.save();
      const badLoaded = await f.load();
      assert.equal(badLoaded.ok, false, `expected ${badPrefix} to fail`);
      if (!badLoaded.ok) assert.equal(badLoaded.error.code, 'CONFIG_SCHEMA');
    }

    // Compaction step declaring handoffs via custom handler alias fails compile with CAPABILITY_UNSUPPORTED
    setFixture(f.config, ['spec', 'publication'], { mode: 'disabled' });
    setFixture(f.config, ['spec', 'credentials'], [f.config.spec.credentials[0]!]);
    setFixture(f.registry, ['spec', 'handlers'], [
      ...f.registry.spec.handlers,
      {
        id: 'compact.step',
        kind: 'agent',
        implementation: 'pi.compact.v1',
        version: 1,
        digest: installed['pi.compact.v1'],
        parameters: {},
        capabilities: ['pi', 'compaction'],
      },
    ]);
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'build', kind: 'agent', uses: 'package.patch', roleId: 'builder', dependsOn: [] },
      {
        id: 'compact-turn',
        kind: 'agent',
        uses: 'compact.step',
        roleId: 'builder',
        dependsOn: ['build'],
        handoffs: [{ fromStep: 'build', source: { kind: 'submission' }, select: { kind: 'full' } }],
      },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'build', handlerRef: 'package.patch' },
      { stepId: 'compact-turn', handlerRef: 'compact.step' },
    ]);
    await f.save();
    const loadedCompact = assertOk(await f.load(), 'load compact alias');
    const compiledCompact = await compilePlan(loadedCompact);
    assert.equal(compiledCompact.ok, false);
    if (!compiledCompact.ok) {
      assert.equal(compiledCompact.error.code, 'CAPABILITY_UNSUPPORTED');
    }

    // Downstream step referencing a compaction step via `fromStep` also fails compile with CAPABILITY_UNSUPPORTED
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'build', kind: 'agent', uses: 'package.patch', roleId: 'builder', dependsOn: [] },
      { id: 'compact-turn', kind: 'agent', uses: 'compact.step', roleId: 'builder', dependsOn: ['build'] },
      {
        id: 'post-compact',
        kind: 'agent',
        uses: 'package.patch',
        roleId: 'builder',
        dependsOn: ['compact-turn'],
        handoffs: [{ fromStep: 'compact-turn', source: { kind: 'submission' }, select: { kind: 'full' } }],
      },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'build', handlerRef: 'package.patch' },
      { stepId: 'compact-turn', handlerRef: 'compact.step' },
      { stepId: 'post-compact', handlerRef: 'package.patch' },
    ]);
    await f.save();
    const loadedFromCompact = assertOk(await f.load(), 'load fromStep compact alias');
    const compiledFromCompact = await compilePlan(loadedFromCompact);
    assert.equal(compiledFromCompact.ok, false);
    if (!compiledFromCompact.ok) {
      assert.equal(compiledFromCompact.error.code, 'CAPABILITY_UNSUPPORTED');
    }
  } finally {
    await f.cleanup();
  }

  // 3. Progress backward compatibility on version: 2
  const pf = await retainedFixture();
  try {
    await pf.progress.publish(pf.draft, 'bootstrap');
    const head = await pf.progress.read();
    assert.notEqual(head, null);
    const validated = validateProgress(head!.progress, pf.plan, pf.lock);
    assert.equal(validated.version, 2);
  } finally {
    await pf.close();
  }
});

function createPiTestPort(
  onStep: (ctx: {
    readonly host: PiHostV2;
    readonly input: PiOpenInputV2;
    readonly stepId: string;
    readonly roleId: string;
    readonly prompt: string;
    readonly repair: 'none' | 'format' | 'implementation';
    readonly resourceIds: readonly string[];
  }) => Promise<{
    readonly files?: Readonly<Record<string, string>>;
    readonly responseJson: unknown;
  }> | {
    readonly files?: Readonly<Record<string, string>>;
    readonly responseJson: unknown;
  },
) {
  let seq = 0;
  const cancelledErr: PiErrorV2 = {
    code: 'CANCELLED',
    phase: 'session',
    path: '',
    retryable: false,
    effect: 'none',
    requestId: null,
    operationId: null,
    stateErrorCode: null,
  };
  const cancelledOut: PiOutcomeV2 = {
    status: 'cancelled',
    requestIds: [],
    operationIds: [],
    providerTermination: 'none',
    usage: 'none',
    localCleanup: 'complete',
    error: cancelledErr,
    cleanupError: null,
  };

  return async (host: PiHostV2, input: PiOpenInputV2) => {
    // Exercise real agent-pi effectivePolicyV2 + preflight + snapshot recovery on every Pi open!
    const { native: v1Policy } = await effectivePolicyV2(input.policy);
    const prepared: PiOpenInput = prepareInput(
      { ...input, version: 1, policy: v1Policy },
      host.artifactsDirectory,
    );
    if (prepared.restore !== null) {
      const recovered = await recoverSnapshot(host, prepared);
      assert.notEqual(recovered, null, 'expected recoverSnapshot to succeed across conditional rule activation');
    }

    let lastCommandText = '';
    let lastReqId = '';
    let lastOpId = '';
    let currentFiles = new Map<string, Uint8Array>(
      await Promise.all(
        input.candidate.artifacts.map(async a => [
          a.name,
          'bytes' in a ? new Uint8Array(a.bytes) : new Uint8Array(await readFile(a.blobPath)),
        ] as const),
      ),
    );
    let responseText = '';

    const adapter: PiAdapterV2 = {
      capabilities: () => {
        throw new Error('unused');
      },
      events: () => ({
        async *[Symbol.asyncIterator]() {
          yield* [];
        },
      }),
      cancel: async () => ({ ok: true, value: cancelledOut }),
      close: async () => ({ ok: true, value: { closed: true } }),
      compact: async () => ({
        ok: true,
        value: {
          status: 'execution_settled',
          requestIds: [],
          operationIds: [],
          providerTermination: 'confirmed',
          usage: 'complete',
          localCleanup: 'complete',
          error: null,
          cleanupError: null,
        },
      }),
      execute: async cmd => {
        seq += 1;
        lastCommandText = cmd.text;
        lastReqId = `pi-req-${seq}`;
        lastOpId = `pi-op-${seq}`;
        const decision = await onStep({
          host,
          input,
          stepId: input.stepId,
          roleId: input.roleId,
          prompt: cmd.text,
          repair: cmd.repair,
          resourceIds: input.resources.map(r => r.id),
        });
        if (decision.files) {
          currentFiles = new Map(currentFiles);
          for (const [name, content] of Object.entries(decision.files)) {
            currentFiles.set(name, new Uint8Array(Buffer.from(content, 'utf8')));
          }
        }
        responseText = typeof decision.responseJson === 'string' ? decision.responseJson : JSON.stringify(decision.responseJson);
        const mappedPurpose: 'task' | 'reviewer' | 'compaction' =
          cmd.purpose === 'reviewer' || cmd.purpose === 'compaction' ? cmd.purpose : 'task';
        stateValue(
          host.store.reserveRequest(host.authority, {
            requestId: lastReqId,
            roleId: input.roleId,
            nodeId: input.stepId,
            attemptId: cmd.commandId,
            purpose: mappedPurpose,
            repair: cmd.repair,
            transportRetryOf: null,
            requestDigest: hash(`req-${seq}`),
            inputUpperBound: 100,
            outputUpperBound: 50,
            totalUpperBound: 150,
            capability: {
              adapterId: 'pi',
              adapterVersion: '0.0.0',
              provider: input.policy.selection.provider,
              model: input.policy.selection.model,
              kind: 'soft_only',
              coversAllBillableTokens: false,
              enforcesOutputBound: false,
            },
            operationId: lastOpId,
            targetIdentity: 'fixture:pi-handoff',
          }),
        );
        stateValue(host.store.authorizeRequestDispatch(host.authority, lastReqId));
        const op = stateValue(host.store.getOperation(lastOpId));
        const view = stateValue(host.store.inspect());
        const usageBytes = Buffer.from(canonical({ seq }));
        const usageName = `usage-${hash(usageBytes).hex}.bin`;
        await writeFile(join(host.artifactsDirectory, usageName), usageBytes, { mode: 0o600 });
        const usageArtifact = { name: usageName, byteLength: usageBytes.byteLength, digest: hash(usageBytes) };
        stateValue(
          host.store.observeRequest(host.authority, lastReqId, {
            receiptId: `rec-${seq}`,
            termination: 'confirmed',
            outcome: 'succeeded',
            evidence: {
              evidenceId: `ev-${seq}`,
              producerId: 'mock-pi',
              method: 'synthetic',
              artifact: usageArtifact,
              subject: {
                storeId: view.storeId,
                runId: view.runId,
                lockHash: view.lockHash,
                operationId: lastOpId,
                requestId: lastReqId,
                intentDigest: op.intentDigest,
                dispatchGeneration: op.dispatch!.generation,
                dispatchId: op.dispatch!.dispatchId,
              },
            },
            usage: {
              requestId: lastReqId,
              inputTokens: { provenance: 'reported', value: 20 },
              outputTokens: { provenance: 'reported', value: 10 },
              costMicrousd: { provenance: 'reported', value: 500 },
            },
          }),
        );
        return {
          ok: true,
          value: {
            status: 'execution_settled',
            requestIds: [lastReqId],
            operationIds: [lastOpId],
            providerTermination: 'confirmed',
            usage: 'complete',
            localCleanup: 'complete',
            error: null,
            cleanupError: null,
          },
        };
      },
      capture: async ({ checkpointId }) => {
        const sortedEntries = [...currentFiles.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([name, bytes]) => ({
            name,
            bytes,
            ref: { name, byteLength: bytes.byteLength, digest: hash(bytes) },
          }));
        const manifest = {
          apiVersion: 'loopwright.dev/v1alpha1' as const,
          kind: 'ArtifactManifest' as const,
          metadata: { id: 'candidate' },
          spec: input.candidate.manifest.spec.baseTree
            ? {
                baseTree: input.candidate.manifest.spec.baseTree,
                entries: sortedEntries.map(e => e.ref),
                deleted: input.candidate.manifest.spec.deleted ?? [],
              }
            : { entries: sortedEntries.map(e => e.ref) },
        };
        const current = stateValue(host.store.inspect());
        const nativePolicy = v1Policy;
        const candidateDigest = hash('loopwright.dev/artifact-manifest/v1alpha1\0' + canonical(manifest));
        const binding = {
          version: 1,
          checkpointId,
          storeId: current.storeId,
          runId: current.runId,
          lockHash: current.lockHash,
          sessionId: input.sessionId,
          roleId: input.roleId,
          stepId: input.stepId,
          runtime: input.policy.runtime,
          policyDigest: hash(canonical(nativePolicy)),
          resourcesDigest: hash(canonical(input.policy.resources)),
          candidateDigest,
          clockBasis: current.clock.basis,
          accountingDigest: hash(
            canonical({
              ledger: current.ledger,
              requests: current.counts.requests,
              operations: current.counts.operations,
            }),
          ),
          sequence: 1,
        };
        const line = (v: unknown) => JSON.stringify(v) + '\n';
        let wsBody = line({ type: 'workspace_snapshot', version: 1, binding, manifest });
        for (const item of sortedEntries) {
          wsBody += line({ type: 'file', ref: item.ref });
          if (item.bytes.byteLength > 0) {
            wsBody += line({ type: 'chunk', index: 0, data: Buffer.from(item.bytes).toString('base64') });
          }
          wsBody += line({ type: 'file_end', byteLength: item.bytes.byteLength, digest: item.ref.digest.hex });
        }
        wsBody += line({ type: 'end', files: sortedEntries.length });
        const wsBytes = Buffer.from(wsBody, 'utf8');
        const wsName = `ws-${hash(wsBytes).hex}.bin`;
        await writeFile(join(host.artifactsDirectory, wsName), wsBytes, { mode: 0o600 });
        const workspaceRef = { name: wsName, byteLength: wsBytes.byteLength, digest: hash(wsBytes) };

        const ts = '2026-11-21T00:00:00.000Z';
        const sessBody =
          line({ type: 'session_snapshot', version: 1, binding }) +
          line({ type: 'session', version: 3, id: 'sess_1', cwd: '/workspace/candidate', timestamp: ts }) +
          line({ type: 'message', id: 'u1', parentId: null, timestamp: ts, message: { role: 'user', content: lastCommandText } }) +
          line({
            type: 'message',
            id: 'a1',
            parentId: 'u1',
            timestamp: ts,
            message: {
              role: 'assistant',
              ...input.policy.selection,
              content: [{ type: 'text', text: responseText }],
              stopReason: 'stop',
            },
          });
        const sessBytes = Buffer.from(sessBody, 'utf8');
        const sessName = `sess-${hash(sessBytes).hex}.bin`;
        await writeFile(join(host.artifactsDirectory, sessName), sessBytes, { mode: 0o600 });
        const sessionRef = { name: sessName, byteLength: sessBytes.byteLength, digest: hash(sessBytes) };

        stateValue(
          host.store.writeCheckpoint(host.authority, {
            checkpointId,
            expectedRevision: stateValue(host.store.inspect()).revision,
            candidateManifest: manifest,
            workspace: workspaceRef,
            privateSession: sessionRef,
            additionalArtifacts: [],
          }),
        );
        return {
          ok: true,
          value: { checkpointId, candidate: manifest, workspace: workspaceRef, session: sessionRef },
        };
      },
    };
    return { ok: true as const, value: adapter };
  };
}

async function setupMultiRoleHandoffFixture(adapterMode: 'pi' | 'delegated', extraResourcesCount = 0) {
  const f = await configurationFixture();
  const repository = join(f.root, 'repository');
  const runRoot = join(f.root, 'runs');
  await mkdir(join(repository, 'packages'), { recursive: true, mode: 0o700 });
  await mkdir(join(repository, 'docs'), { recursive: true, mode: 0o700 });
  await writeFile(join(repository, 'packages', 'result.json'), JSON.stringify({ ok: false }), { mode: 0o600 });
  await writeFile(join(repository, 'docs', 'guide.md'), '# Baseline Guide\n', { mode: 0o600 });
  const git = (args: string[]) =>
    execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: repository,
      env: {
        PATH: '/usr/bin:/bin',
        LANG: 'C',
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        HOME: '/nonexistent',
        GIT_TERMINAL_PROMPT: '0',
      },
      encoding: 'utf8',
    });
  git(['init', '-q']);
  git(['add', '.']);
  git(['-c', 'user.name=Handoff Fixture', '-c', 'user.email=fixture@localhost.invalid', 'commit', '-qm', 'baseline']);
  const rev = git(['rev-parse', 'HEAD']).trim();

  const baseRuleBytes = Buffer.from('Unconditional repository invariant rule.\n', 'utf8');
  const repairRuleBytes = Buffer.from('Repair-only JSON check rule.\n', 'utf8');
  const reviewRuleBytes = Buffer.from('Review-only audit checklist.\n', 'utf8');
  await writeFile(join(f.operator, 'base-rule.md'), baseRuleBytes, { mode: 0o600 });
  await writeFile(join(f.operator, 'repair-rule.md'), repairRuleBytes, { mode: 0o600 });
  await writeFile(join(f.operator, 'review-rule.md'), reviewRuleBytes, { mode: 0o600 });

  const registryResources: { id: string; kind: 'instruction' | 'skill' | 'document'; path: string; digest: ReturnType<typeof hash> }[] = [
    { id: 'base-rule', kind: 'instruction', path: 'base-rule.md', digest: hash(baseRuleBytes) },
    { id: 'repair-rule', kind: 'skill', path: 'repair-rule.md', digest: hash(repairRuleBytes) },
    { id: 'review-rule', kind: 'instruction', path: 'review-rule.md', digest: hash(reviewRuleBytes) },
  ];
  const taskResources: Record<string, unknown>[] = [
    { ...registryResources[0]! },
    {
      ...registryResources[1]!,
      when: {
        phases: ['repair'],
        changedPaths: ['packages/**'],
        extensions: ['.json'],
        failedChecks: ['tests'],
        failureCodes: ['property_mismatch'],
      },
    },
    {
      ...registryResources[2]!,
      when: { phases: ['review'] },
    },
  ];

  for (let i = 0; i < extraResourcesCount; i += 1) {
    const extraBytes = Buffer.from(`Extra unconditional resource ${i}\n`, 'utf8');
    const rel = `extra-${i}.md`;
    await writeFile(join(f.operator, rel), extraBytes, { mode: 0o600 });
    const entry = { id: `extra-${i}`, kind: 'document' as const, path: rel, digest: hash(extraBytes) };
    registryResources.push(entry);
    taskResources.push({ ...entry });
  }

  setFixture(f.registry, ['spec', 'resources'], registryResources);
  setFixture(f.config, ['spec', 'task', 'spec', 'trustedContext', 'resources'], taskResources);
  setFixture(f.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], rev);
  setFixture(f.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], rev);
  setFixture(f.config, ['spec', 'task', 'spec', 'scope'], {
    writable: ['packages/**'],
    protected: ['docs/**'],
  });
  setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'maxModelCalls'], 16);
  setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'maxFormatRepairs'], 2);
  setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'maxImplementationRepairs'], 2);
  setFixture(f.config, ['spec', 'controls', 'maxAttempts'], 16);

  const installed = await installedHandlerDigests();
  setFixture(f.registry, ['spec', 'handlers'], [
    {
      id: 'plan.step',
      version: 1,
      digest: installed['pi.agent.v1'],
      kind: 'agent',
      implementation: 'pi.agent.v1',
      parameters: { purpose: 'task', prompt: 'Draft packages/plan.md and packages/plan.json.' },
      capabilities: ['pi'],
    },
    {
      id: 'audit.step',
      version: 1,
      digest: installed['pi.agent.v1'],
      kind: 'agent',
      implementation: 'pi.agent.v1',
      parameters: { purpose: 'task', prompt: 'Sibling audit step touching candidate files.' },
      capabilities: ['pi'],
    },
    {
      id: 'implement.step',
      version: 1,
      digest: installed['pi.agent.v1'],
      kind: 'agent',
      implementation: 'pi.agent.v1',
      parameters: { purpose: 'task', prompt: 'Implement the planned changes in packages/result.json.' },
      capabilities: ['pi'],
    },
    {
      id: 'review.step',
      version: 1,
      digest: installed['pi.agent.v1'],
      kind: 'agent',
      implementation: 'pi.agent.v1',
      parameters: { purpose: 'review', prompt: 'Review the implementation and emit verdict.' },
      capabilities: ['pi'],
    },
    {
      id: 'tests',
      version: 1,
      digest: installed['json-artifact.v1'],
      kind: 'check',
      implementation: 'json-artifact.v1',
      parameters: { checkId: 'tests', path: 'packages/result.json', required: ['ok'], equals: { ok: true } },
      capabilities: ['inert_bytes', 'read_only'],
    },
    ...f.registry.spec.handlers.filter(h => h.id === 'scope' || h.id === 'no-change').map(h => ({ ...h })),
  ]);

  if (adapterMode === 'pi') {
    const baseProfile = f.registry.spec.roleProfiles[0]!;
    setFixture(f.registry, ['spec', 'roleProfiles'], [
      { ...baseProfile, id: 'builder', tools: ['read', 'write', 'edit'] },
      { ...baseProfile, id: 'reviewer', tools: ['read'] },
    ]);
    setFixture(f.config, ['spec', 'task', 'spec', 'roles'], [
      {
        ...f.config.spec.task.spec.roles[0]!,
        id: 'builder',
        tools: ['read', 'write', 'edit'],
      },
      {
        ...f.config.spec.task.spec.roles[0]!,
        id: 'reviewer',
        tools: ['read'],
      },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'roles'], [
      { roleId: 'builder', profileRef: 'builder' },
      { roleId: 'reviewer', profileRef: 'reviewer' },
    ]);
  } else {
    setFixture(f.registry, ['spec', 'runtimeProfiles'], []);
    setFixture(f.registry, ['spec', 'credentialBindings'], []);
    setFixture(f.registry, ['spec', 'environmentBindings'], []);
    setFixture(f.config, ['spec', 'credentials'], []);
    setFixture(f.registry, ['spec', 'roleProfiles'], [
      {
        id: 'builder',
        adapter: 'delegated',
        runtimeRef: null,
        providerCredentialRef: null,
        selection: { provider: 'antigravity', model: 'gemini-4-carbon', thinking: 'high' },
        tools: ['read', 'write', 'edit'],
        mcp: null,
      },
      {
        id: 'reviewer',
        adapter: 'delegated',
        runtimeRef: null,
        providerCredentialRef: null,
        selection: { provider: 'antigravity', model: 'gemini-4-argon', thinking: 'low' },
        tools: ['read'],
        mcp: null,
      },
    ]);
    setFixture(f.config, ['spec', 'task', 'spec', 'roles'], [
      {
        id: 'builder',
        adapter: 'delegated',
        provider: 'antigravity',
        model: 'gemini-4-carbon',
        thinking: 'high',
        tools: ['read', 'write', 'edit'],
      },
      {
        id: 'reviewer',
        adapter: 'delegated',
        provider: 'antigravity',
        model: 'gemini-4-argon',
        thinking: 'low',
        tools: ['read'],
      },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'roles'], [
      { roleId: 'builder', profileRef: 'builder' },
      { roleId: 'reviewer', profileRef: 'reviewer' },
    ]);
  }

  const implementHandoffs: readonly StepHandoffSelector[] = [
    {
      id: 'plan-changes',
      fromStep: 'plan',
      source: { kind: 'artifact', path: 'packages/plan.md' },
      select: { kind: 'markdown_heading', heading: '## File Changes', includeSubheadings: false },
      maxBytes: 4_096,
    },
    {
      id: 'plan-csharp',
      fromStep: 'plan',
      source: { kind: 'artifact', path: 'packages/plan.md' },
      select: { kind: 'markdown_heading', heading: '## C#', includeSubheadings: false },
      maxBytes: 4_096,
    },
    {
      id: 'plan-constraints',
      fromStep: 'plan',
      source: { kind: 'artifact', path: 'packages/plan.json' },
      select: { kind: 'json_pointer', pointers: ['/constraints'] },
      maxBytes: 4_096,
    },
    {
      id: 'optional-absent',
      fromStep: 'plan',
      source: { kind: 'artifact', path: 'packages/optional-notes.md' },
      select: { kind: 'full' },
      required: false,
      maxBytes: 1_024,
    },
  ];

  const reviewHandoffs: readonly StepHandoffSelector[] = [
    {
      id: 'impl-submission',
      fromStep: 'implement',
      source: { kind: 'submission' },
      select: { kind: 'json_pointer', pointers: ['/status'] },
      maxBytes: 1_024,
    },
  ];

  setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
    { id: 'plan', kind: 'agent', uses: 'plan.step', roleId: 'builder', dependsOn: [] },
    { id: 'audit', kind: 'agent', uses: 'audit.step', roleId: 'builder', dependsOn: ['plan'] },
    { id: 'implement', kind: 'agent', uses: 'implement.step', roleId: 'builder', dependsOn: ['plan', 'audit'], handoffs: implementHandoffs },
    { id: 'review', kind: 'agent', uses: 'review.step', roleId: 'reviewer', dependsOn: ['implement'], handoffs: reviewHandoffs },
    { id: 'verify', kind: 'check', uses: 'tests', roleId: null, dependsOn: ['review'] },
  ]);
  setFixture(f.config, ['spec', 'profiles', 'steps'], [
    { stepId: 'plan', handlerRef: 'plan.step' },
    { stepId: 'audit', handlerRef: 'audit.step' },
    { stepId: 'implement', handlerRef: 'implement.step' },
    { stepId: 'review', handlerRef: 'review.step' },
    { stepId: 'verify', handlerRef: 'tests' },
  ]);

  await f.save();
  return { ...f, repository, runRoot };
}

test('Pi DAG run isolates nodeCandidates across sibling branches, activates repair rule with recoverSnapshot intact, guards prompt hash, and refuses secret handoffs', async () => {
  const f = await setupMultiRoleHandoffFixture('pi');
  try {
    const loaded = assertOk(await f.load(), 'load pi fixture');
    const dispatches: {
      readonly stepId: string;
      readonly repair: string;
      readonly resourceIds: readonly string[];
      readonly prompt: string;
    }[] = [];
    const rolePreSnapshots: ControllerAttempt[] = [];
    let implCalls = 0;

    const openAdapter = createPiTestPort(async ctx => {
      dispatches.push({
        stepId: ctx.stepId,
        repair: ctx.repair,
        resourceIds: ctx.resourceIds,
        prompt: ctx.prompt,
      });

      // Verify 0o400 context files mounted outside candidate overlay in hostDirectory/context
      if (ctx.repair !== 'format') {
        const contextDir = join(ctx.host.directory, 'context');
        const st = await lstat(contextDir);
        assert.equal(st.isDirectory(), true);
      }

      const okSub = {
        version: 1,
        status: 'completed',
        checks: [{ checkId: 'tests', status: 'passed', evidenceId: null, reason: null }],
        reason: null,
      };

      if (ctx.stepId === 'plan') {
        return {
          files: {
            'packages/plan.md': [
              '# Plan',
              '```md',
              '## File Changes',
              'FAKE FENCED CHANGE',
              '```',
              '## File Changes',
              'Set ok=true in packages/result.json.',
              '## C#',
              'Preserve C#interop compatibility.',
              '## Unrelated Tail',
              'Should not appear in implement handoff.',
            ].join('\n'),
            'packages/plan.json': JSON.stringify({
              constraints: { strict: true, maxEdits: 1 },
              hugeNoise: 'ignore-me',
            }),
          },
          responseJson: okSub,
        };
      }

      if (ctx.stepId === 'audit') {
        // Sibling branch mutates BOTH plan.md and plan.json BEFORE `implement` runs!
        return {
          files: {
            'packages/plan.md': '## File Changes\nCORRUPTED BY SIBLING AUDIT\n## C#\nCORRUPTED C#\n',
            'packages/plan.json': JSON.stringify({ constraints: { strict: false, corrupted: true } }),
          },
          responseJson: okSub,
        };
      }

      if (ctx.stepId === 'implement') {
        implCalls += 1;
        if (implCalls === 1) {
          // First author turn: emit malformed submission first to ALSO exercise format repair skipping handoffs & conditional rules!
          return {
            files: { 'packages/result.json': JSON.stringify({ ok: false }) },
            responseJson: 'not valid json submission',
          };
        }
        if (ctx.repair === 'format') {
          return { responseJson: okSub };
        }
        // Implementation repair turn!
        return {
          files: { 'packages/result.json': JSON.stringify({ ok: true }) },
          responseJson: okSub,
        };
      }

      // review step
      return {
        responseJson: { verdict: 'pass', summary: 'Verified clean handoff and repair.', findings: [] },
      };
    });

    const runRes = assertOk(
      await runCycleWithPorts(
        { configuration: loaded, repository: f.repository, runRoot: f.runRoot, runId: 'pi-handoff-1' },
        {
          openAdapter,
          afterCheckpoint: async (phase, head) => {
            if (phase.endsWith('.pre') && phase.startsWith('role.')) {
              rolePreSnapshots.push(structuredClone(head.progress.attempts.at(-1)!));
            }
          },
        },
      ),
      'runCycleWithPorts pi-handoff-1',
    );
    assert.equal(runRes.kind, 'result');
    if (runRes.kind === 'result') {
      assert.equal(runRes.result.spec.status, 'completed');
    }

    // 1. Initial `implement` turn (author): conditional `repair-rule` is INACTIVE, `plan` snapshot is isolated from `audit`!
    const implAuthor = dispatches.find(d => d.stepId === 'implement' && d.repair === 'none')!;
    assert.deepEqual(implAuthor.resourceIds, ['base-rule']);
    assert.match(implAuthor.prompt, /Set ok=true in packages\/result\.json\./);
    assert.match(implAuthor.prompt, /Preserve C#interop compatibility\./);
    assert.match(implAuthor.prompt, /"\/constraints":\{"maxEdits":1,"strict":true\}/);
    assert.equal(implAuthor.prompt.includes('FAKE FENCED CHANGE'), false);
    assert.equal(implAuthor.prompt.includes('Unrelated Tail'), false);
    assert.equal(implAuthor.prompt.includes('CORRUPTED BY SIBLING AUDIT'), false);
    assert.equal(implAuthor.prompt.includes('corrupted'), false);

    // 2. Format repair on `implement`: mounts ONLY unconditional resources (`base-rule`) and NO handoff summary block!
    const implFormat = dispatches.find(d => d.stepId === 'implement' && d.repair === 'format')!;
    assert.deepEqual(implFormat.resourceIds, ['base-rule']);
    assert.equal(implFormat.prompt.includes('Upstream Step Handoffs'), false);

    // 3. Implementation repair on `implement`: `repair-rule` activates automatically AND `recoverSnapshot` succeeded!
    const implRepair = dispatches.find(d => d.stepId === 'implement' && d.repair === 'implementation')!;
    assert.deepEqual(implRepair.resourceIds, ['base-rule', 'repair-rule']);
    assert.match(implRepair.prompt, /Set ok=true in packages\/result\.json\./);

    // 4. Reviewer step: `review-rule` activates (and `repair-rule` does not), and receives `implement` submission pointer `/status`
    const reviewDispatch = dispatches.filter(d => d.stepId === 'review').at(-1)!;
    assert.deepEqual(reviewDispatch.resourceIds, ['base-rule', 'review-rule']);
    assert.match(reviewDispatch.prompt, /"\/status":"completed"/);

    // 5. `role_pre` checkpoint persisted `activatedResourceIds` and CAS-backed `handoffExtracts` (including omitted optional provenance)
    const implPre = rolePreSnapshots.find(a => a.nodeId === 'implement' && a.repair === 'none')!;
    assert.deepEqual(implPre.activatedResourceIds, ['base-rule']);
    assert.equal(implPre.handoffExtracts?.length, 4);
    assert.equal(implPre.handoffExtracts![0]!.status, 'extracted');
    assert.ok(implPre.handoffExtracts![0]!.artifact?.uri?.startsWith('cas://sha256/'));
    assert.equal(implPre.handoffExtracts![3]!.status, 'omitted');
    assert.equal(implPre.handoffExtracts![3]!.omittedReason, 'source_missing');
    assert.equal(implPre.handoffExtracts![3]!.artifact, null);

    // Inspect bundle succeeds cleanly with new progress fields
    const inspected = assertOk(await inspectRun({ runRoot: f.runRoot, runId: 'pi-handoff-1' }), 'inspectRun');
    assert.equal(inspected.status.status, 'completed');

    // 6. Secret-bearing handoff extract is refused before CAS persistence or downstream dispatch!
    let implementRanOnSecret = false;
    const secretAdapter = createPiTestPort(ctx => {
      if (ctx.stepId === 'plan') {
        return {
          files: {
            'packages/plan.md': `## File Changes\nLeak token ${TOKEN} and ghp_1234567890abcdefghijklmnopqrstuv\n## C#\nOk\n`,
            'packages/plan.json': JSON.stringify({ constraints: { ok: true } }),
          },
          responseJson: {
            version: 1,
            status: 'completed',
            checks: [{ checkId: 'tests', status: 'passed', evidenceId: null, reason: null }],
            reason: null,
          },
        };
      }
      if (ctx.stepId === 'implement') implementRanOnSecret = true;
      return {
        responseJson: {
          version: 1,
          status: 'completed',
          checks: [{ checkId: 'tests', status: 'passed', evidenceId: null, reason: null }],
          reason: null,
        },
      };
    });
    const secretRes = assertOk(
      await runCycleWithPorts(
        { configuration: loaded, repository: f.repository, runRoot: f.runRoot, runId: 'pi-secret-handoff' },
        { openAdapter: secretAdapter },
      ),
      'secret handoff run',
    );
    assert.equal(implementRanOnSecret, false);
    assert.equal(secretRes.kind, 'incident');
    if (secretRes.kind === 'incident') {
      assert.equal(secretRes.incident.code, 'CONFIG_CREDENTIAL_INVALID');
    }
    const scrubber = new SecretScrubber();
    scrubber.register(TOKEN);
    assert.equal(scrubber.containsSecret(JSON.stringify(secretRes)), false);
  } finally {
    await f.cleanup();
  }
});

test('Prompt-hash guard fails closed with RECOVERY_REQUIRED before appending any runtime handoff block', async () => {
  const f = await setupMultiRoleHandoffFixture('delegated');
  try {
    const loaded = assertOk(await f.load(), 'load delegated fixture');
    // Start step 1 (`plan`) and submit valid plan files
    const planYield = assertStepYield(
      assertOk(await stepNext({ configuration: loaded, repository: f.repository, runRoot: f.runRoot, runId: 'prompt-guard-1' })),
    );
    await writeFile(join(planYield.candidateDir, 'packages', 'plan.md'), '## File Changes\nValid\n## C#\nValid\n', { mode: 0o600 });
    await writeFile(join(planYield.candidateDir, 'packages', 'plan.json'), JSON.stringify({ constraints: { ok: true } }), { mode: 0o600 });
    const auditYield = assertStepYield(
      assertOk(await stepSubmit({ runRoot: f.runRoot, runId: 'prompt-guard-1', leaseToken: planYield.leaseToken })),
    );

    // Tamper the registry handler prompt in a second loaded configuration that mismatches the compiled private command sha256
    const runDir = join(f.runRoot, 'prompt-guard-1');
    const runJson = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8')) as { plan: { name: string } };
    const planPath = join(runDir, 'artifacts', runJson.plan.name);
    const planObj = JSON.parse(await readFile(planPath, 'utf8')) as { orderedDAG: { id: string; handler: { parameters: { prompt: string } } }[] };
    // Verify compiled plan stores `[private command sha256:<hex>]`
    const implNode = planObj.orderedDAG.find(n => n.id === 'implement')!;
    assert.match(implNode.handler.parameters.prompt, /^\[private command sha256:[0-9a-f]{64}\]$/);

    // Complete audit cleanly -> implement yields with handoff appended AFTER verifying base prompt digest
    const implYield = assertStepYield(
      assertOk(await stepSubmit({ runRoot: f.runRoot, runId: 'prompt-guard-1', leaseToken: auditYield.leaseToken })),
    );
    assert.equal(implYield.stepId, 'implement');
    assert.ok(implYield.prompt.startsWith('Implement the planned changes in packages/result.json.'));
    assert.match(implYield.prompt, /Upstream Step Handoffs:/);

    // Direct Cycle.role prompt-hash tampering check: refuses RECOVERY_REQUIRED BEFORE reading/appending handoffs!
    const fPi = await setupMultiRoleHandoffFixture('pi');
    try {
      const loadedPi = assertOk(await fPi.load(), 'load pi for prompt-hash check');
      const ctx = await createCycle(
        { configuration: loadedPi, repository: fPi.repository, runRoot: fPi.runRoot, runId: 'prompt-tamper-pi' },
        {},
      );
      try {
        const tamperedPlan = {
          ...ctx.plan,
          orderedDAG: ctx.plan.orderedDAG.map(n =>
            n.id === 'implement'
              ? {
                  ...n,
                  handler: {
                    ...n.handler,
                    parameters: { ...n.handler.parameters, prompt: '[private command sha256:' + 'f'.repeat(64) + ']' },
                  },
                }
              : n,
          ),
        };
        const cycle = new Cycle({ ...ctx, plan: tamperedPlan });
        await cycle.bootstrap();
        // Notice `plan` has NOT even run (`nodeCandidates['plan']` is absent -> would be EVIDENCE_UNAVAILABLE if handoffs ran first!).
        // Because the prompt-hash guard runs FIRST, `cycle.role('implement')` MUST refuse `RECOVERY_REQUIRED` instead of `EVIDENCE_UNAVAILABLE`!
        await assert.rejects(
          () => cycle.role('implement'),
          err => err instanceof ControllerFailure && err.diagnostic.code === 'RECOVERY_REQUIRED',
        );
        await cycle.deadline.dispose();
        await cycle.events.close();
      } finally {
        stateValue(ctx.store.release(ctx.authority));
        stateValue(ctx.store.close());
        await ctx.owner.release();
      }
    } finally {
      await fPi.cleanup();
    }
  } finally {
    await f.cleanup();
  }
});

test('loopwright step parity: 0o400 contextFiles, role_pre persistence, --reissue-lease CAS reconstruction without step-lease.json, and <= 64 cap', async () => {
  const f = await setupMultiRoleHandoffFixture('delegated');
  try {
    const loaded = assertOk(await f.load(), 'load delegated');
    const runId = 'step-handoff-1';

    // 1. `plan`
    const s1 = assertStepYield(
      assertOk(await stepNext({ configuration: loaded, repository: f.repository, runRoot: f.runRoot, runId })),
    );
    assert.equal(s1.stepId, 'plan');
    assert.equal(s1.contextFiles.length, 1); // only `base-rule`
    for (const cf of s1.contextFiles) {
      const st = await lstat(cf);
      assert.equal(st.mode & 0o777, 0o400);
    }
    await writeFile(
      join(s1.candidateDir, 'packages', 'plan.md'),
      '## File Changes\nSet ok=true.\n## C#\nKeep C# intact.\n',
      { mode: 0o600 },
    );
    await writeFile(
      join(s1.candidateDir, 'packages', 'plan.json'),
      JSON.stringify({ constraints: { target: 'packages/result.json' } }),
      { mode: 0o600 },
    );

    // 2. `audit` (sibling branch mutating plan.md!)
    const s2 = assertStepYield(assertOk(await stepSubmit({ runRoot: f.runRoot, runId, leaseToken: s1.leaseToken })));
    assert.equal(s2.stepId, 'audit');
    await chmodForWrite(join(s2.candidateDir, 'packages', 'plan.md'));
    await writeFile(join(s2.candidateDir, 'packages', 'plan.md'), '## File Changes\nSIBLING OVERWRITE\n## C#\nBAD\n', { mode: 0o600 });

    // 3. `implement` yields with 1 active resource + 3 extracted handoffs (4th optional handoff omitted) = 4 `0o400` contextFiles
    const s3 = assertStepYield(assertOk(await stepSubmit({ runRoot: f.runRoot, runId, leaseToken: s2.leaseToken })));
    assert.equal(s3.stepId, 'implement');
    assert.equal(s3.contextFiles.length, 4);
    for (const cf of s3.contextFiles) {
      const st = await lstat(cf);
      assert.equal(st.mode & 0o777, 0o400);
      assert.equal(cf.startsWith(s3.candidateDir), false, 'contextFiles must live outside writable candidateDir');
    }
    const cfBodies = await Promise.all(s3.contextFiles.map(cf => readFile(cf, 'utf8')));
    assert.ok(cfBodies.some(b => b.includes('Unconditional repository invariant rule.')));
    assert.ok(cfBodies.some(b => b.includes('Set ok=true.') && !b.includes('SIBLING OVERWRITE')));
    assert.ok(cfBodies.some(b => b.includes('Keep C# intact.')));
    assert.ok(cfBodies.some(b => b.includes('"/constraints":{"target":"packages/result.json"}')));

    // Verify `role_pre` checkpoint persisted `activatedResourceIds` + `handoffExtracts` BEFORE submission!
    const runDir = join(f.runRoot, runId);
    const runDesc = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8'));
    const compiled = assertOk(await compilePlan(loaded));
    const reopenedStore = stateValue(reopenLocalRun(runDesc.identity));
    try {
      const roProgress = new ProgressStore(
        reopenedStore,
        null,
        {
          read: async (ref, max = 8_388_608) => new Uint8Array(await readFile(join(runDir, 'artifacts', ref.name))).slice(0, max),
        },
        compiled,
        runDesc.identity.lock,
        runDesc.plan,
        runDesc.source,
      );
      const head = await roProgress.read();
      assert.notEqual(head, null);
      assert.equal(head!.progress.stage.kind, 'role_pre');
      const activeAttempt = head!.progress.attempts.at(-1)!;
      assert.deepEqual(activeAttempt.activatedResourceIds, ['base-rule']);
      assert.equal(activeAttempt.handoffExtracts?.length, 4);
      assert.equal(activeAttempt.handoffExtracts![0]!.fromStep, 'plan');
      assert.equal(activeAttempt.handoffExtracts![0]!.fromAttemptId, s1.attemptId);
      assert.equal(journal(reopenedStore).view.counts.checkpoints > 0, true);
    } finally {
      stateValue(reopenedStore.close());
    }

    // 4. Simulate crash / lost `step-lease.json` AND lost `context` directory after `role_pre`, then `--reissue-lease`!
    await unlink(join(runDir, 'step-lease.json'));
    const contextDir = join(f.runRoot, 'workspaces', runId, s3.attemptId, 'context');
    await rm(contextDir, { recursive: true, force: true });

    // Without reissueLease, stepNext refuses OWNER_BUSY
    const busyRes = await stepNext({ runRoot: f.runRoot, runId });
    assert.equal(busyRes.ok, false);
    if (!busyRes.ok) assert.equal(busyRes.error.code, 'OWNER_BUSY');

    // With reissueLease: true, reconstructs all 4 `0o400` contextFiles from CAS!
    const reissued = assertStepYield(assertOk(await stepNext({ runRoot: f.runRoot, runId, reissueLease: true }), 'reissueLease'));
    assert.equal(reissued.attemptId, s3.attemptId);
    assert.equal(reissued.contextFiles.length, 4);
    for (const cf of reissued.contextFiles) {
      const st = await lstat(cf);
      assert.equal(st.mode & 0o777, 0o400);
    }
    const reissuedBodies = await Promise.all(reissued.contextFiles.map(cf => readFile(cf, 'utf8')));
    assert.deepEqual(reissuedBodies, cfBodies);

    // Complete `implement` with ok=false first to trigger delegated `implementation` repair with conditional `repair-rule`!
    await chmodForWrite(join(reissued.candidateDir, 'packages', 'result.json'));
    await writeFile(join(reissued.candidateDir, 'packages', 'result.json'), JSON.stringify({ ok: false }), { mode: 0o600 });

    const s4Review = assertStepYield(assertOk(await stepSubmit({ runRoot: f.runRoot, runId, leaseToken: reissued.leaseToken })));
    assert.equal(s4Review.stepId, 'review');
    assert.equal(s4Review.contextFiles.length, 3); // `base-rule`, `review-rule`, + 1 `impl-submission` handoff!

    const s5Repair = assertStepYield(
      assertOk(
        await stepSubmit({
          runRoot: f.runRoot,
          runId,
          leaseToken: s4Review.leaseToken,
          verdict: { verdict: 'pass', summary: 'Pass review so verify check runs', findings: [] },
        }),
      ),
    );
    assert.equal(s5Repair.stepId, 'implement');
    assert.equal(s5Repair.repair, 'implementation');
    // Now `repair-rule` IS mounted alongside `base-rule` + 3 handoffs = 5 contextFiles!
    assert.equal(s5Repair.contextFiles.length, 5);
    const repairBodies = await Promise.all(s5Repair.contextFiles.map(cf => readFile(cf, 'utf8')));
    assert.ok(repairBodies.some(b => b.includes('Repair-only JSON check rule.')));

    await chmodForWrite(join(s5Repair.candidateDir, 'packages', 'result.json'));
    await writeFile(join(s5Repair.candidateDir, 'packages', 'result.json'), JSON.stringify({ ok: true }), { mode: 0o600 });
    const s6Review2 = assertStepYield(assertOk(await stepSubmit({ runRoot: f.runRoot, runId, leaseToken: s5Repair.leaseToken })));
    assert.equal(s6Review2.stepId, 'review');
    const finalRes = assertOk(
      await stepSubmit({
        runRoot: f.runRoot,
        runId,
        leaseToken: s6Review2.leaseToken,
        verdict: { verdict: 'pass', summary: 'All green', findings: [] },
      }),
    );
    assert.equal(finalRes.kind, 'result');
    if (finalRes.kind === 'result') {
      assert.equal(finalRes.result.spec.status, 'completed');
    }
  } finally {
    await f.cleanup();
  }

  // 5. Enforce `<= 64` total `contextFiles` cap across resources + handoffs (`1 + 61 = 62` unconditional + `3` handoffs = `65 > 64`)
  assert.equal(MAX_STEP_CONTEXT_FILES, 64);
  const fOver = await setupMultiRoleHandoffFixture('delegated', 61);
  try {
    const loadedOver = assertOk(await fOver.load(), 'load over-64 fixture');
    const p1 = assertStepYield(
      assertOk(await stepNext({ configuration: loadedOver, repository: fOver.repository, runRoot: fOver.runRoot, runId: 'cap-65' })),
    );
    assert.equal(p1.contextFiles.length, 62); // 62 <= 64 succeeds on `plan` (0 handoffs)
    await writeFile(join(p1.candidateDir, 'packages', 'plan.md'), '## File Changes\nA\n## C#\nB\n', { mode: 0o600 });
    await writeFile(join(p1.candidateDir, 'packages', 'plan.json'), JSON.stringify({ constraints: { x: 1 } }), { mode: 0o600 });
    const p2 = assertStepYield(assertOk(await stepSubmit({ runRoot: fOver.runRoot, runId: 'cap-65', leaseToken: p1.leaseToken })));
    assert.equal(p2.stepId, 'audit');
    // Submitting `audit` attempts to yield `implement` with 62 resources + 3 handoffs = 65 > 64 -> fails closed!
    const overSettled = assertOk(await stepSubmit({ runRoot: fOver.runRoot, runId: 'cap-65', leaseToken: p2.leaseToken }));
    assert.equal(overSettled.kind, 'incident');
    if (overSettled.kind === 'incident') {
      assert.equal(overSettled.incident.code, 'OUTPUT_LIMIT');
    }
  } finally {
    await fOver.cleanup();
  }
});

test('End-to-end rework phase conditional rule activation and verdict source handoff', async () => {
  const f = await setupMultiRoleHandoffFixture('delegated');
  try {
    const reworkRuleBytes = Buffer.from('Rework-only guidance rule.\n', 'utf8');
    await writeFile(join(f.operator, 'rework-rule.md'), reworkRuleBytes, { mode: 0o600 });
    const reworkRes = { id: 'rework-rule', kind: 'instruction' as const, path: 'rework-rule.md', digest: hash(reworkRuleBytes) };
    setFixture(f.registry, ['spec', 'resources'], [...f.registry.spec.resources, reworkRes]);
    setFixture(f.config, ['spec', 'task', 'spec', 'trustedContext', 'resources'], [
      ...f.config.spec.task.spec.trustedContext.resources,
      { ...reworkRes, when: { phases: ['rework'] } },
    ]);

    const installed = await installedHandlerDigests();
    setFixture(f.registry, ['spec', 'handlers'], [
      ...f.registry.spec.handlers,
      {
        id: 'finalize.step',
        version: 1,
        digest: installed['pi.agent.v1'],
        kind: 'agent',
        implementation: 'pi.agent.v1',
        parameters: { purpose: 'task', prompt: 'Finalize after review verdict.' },
        capabilities: ['pi'],
      },
    ]);
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'plan', kind: 'agent', uses: 'plan.step', roleId: 'builder', dependsOn: [] },
      { id: 'implement', kind: 'agent', uses: 'implement.step', roleId: 'builder', dependsOn: ['plan'] },
      {
        id: 'review',
        kind: 'agent',
        uses: 'review.step',
        roleId: 'reviewer',
        dependsOn: ['implement'],
        onRework: { rejectTo: 'implement', maxReworks: 1 },
      },
      {
        id: 'finalize',
        kind: 'agent',
        uses: 'finalize.step',
        roleId: 'builder',
        dependsOn: ['review'],
        handoffs: [
          {
            id: 'review-verdict-summary',
            fromStep: 'review',
            source: { kind: 'verdict' },
            select: { kind: 'json_pointer', pointers: ['/verdict', '/summary'] },
            maxBytes: 1_024,
          },
        ],
      },
      { id: 'verify', kind: 'check', uses: 'tests', roleId: null, dependsOn: ['finalize'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'plan', handlerRef: 'plan.step' },
      { stepId: 'implement', handlerRef: 'implement.step' },
      { stepId: 'review', handlerRef: 'review.step' },
      { stepId: 'finalize', handlerRef: 'finalize.step' },
      { stepId: 'verify', handlerRef: 'tests' },
    ]);
    await f.save();

    const loaded = assertOk(await f.load(), 'load rework + verdict fixture');
    const runId = 'rework-verdict-1';

    // Epoch 0: plan -> implement (rework-rule NOT mounted) -> review emits `rework`
    const p0 = assertStepYield(assertOk(await stepNext({ configuration: loaded, repository: f.repository, runRoot: f.runRoot, runId })));
    const i0 = assertStepYield(assertOk(await stepSubmit({ runRoot: f.runRoot, runId, leaseToken: p0.leaseToken })));
    assert.equal(i0.stepId, 'implement');
    assert.equal(i0.reworkEpoch, 0);
    assert.equal(i0.contextFiles.length, 1); // only `base-rule`
    const r0 = assertStepYield(assertOk(await stepSubmit({ runRoot: f.runRoot, runId, leaseToken: i0.leaseToken })));
    assert.equal(r0.stepId, 'review');

    // Review requests rework -> Epoch 1 `implement` mounts `rework-rule` alongside `base-rule`!
    const i1 = assertStepYield(
      assertOk(
        await stepSubmit({
          runRoot: f.runRoot,
          runId,
          leaseToken: r0.leaseToken,
          verdict: { verdict: 'rework', summary: 'Set ok=true on rework', findings: [] },
        }),
      ),
    );
    assert.equal(i1.stepId, 'implement');
    assert.equal(i1.reworkEpoch, 1);
    assert.equal(i1.contextFiles.length, 2); // `base-rule` + `rework-rule`
    const i1Bodies = await Promise.all(i1.contextFiles.map(cf => readFile(cf, 'utf8')));
    assert.ok(i1Bodies.some(b => b.includes('Rework-only guidance rule.')));

    await chmodForWrite(join(i1.candidateDir, 'packages', 'result.json'));
    await writeFile(join(i1.candidateDir, 'packages', 'result.json'), JSON.stringify({ ok: true }), { mode: 0o600 });

    const r1 = assertStepYield(assertOk(await stepSubmit({ runRoot: f.runRoot, runId, leaseToken: i1.leaseToken })));
    assert.equal(r1.stepId, 'review');

    // Review passes in Epoch 1 -> `finalize` receives `review`'s Epoch 1 verdict (NOT Epoch 0's rework verdict!)
    const fin = assertStepYield(
      assertOk(
        await stepSubmit({
          runRoot: f.runRoot,
          runId,
          leaseToken: r1.leaseToken,
          verdict: { verdict: 'pass', summary: 'Approved in epoch 1', findings: [] },
        }),
      ),
    );
    assert.equal(fin.stepId, 'finalize');
    assert.match(fin.prompt, /"\/summary":"Approved in epoch 1"/);
    assert.match(fin.prompt, /"\/verdict":"pass"/);
    assert.equal(fin.prompt.includes('"/verdict":"rework"'), false);
    const finBodies = await Promise.all(fin.contextFiles.map(cf => readFile(cf, 'utf8')));
    const verdictHandoffBody = finBodies.find(b => b.includes('"/verdict"'))!;
    assert.equal(verdictHandoffBody, canonical({ '/summary': 'Approved in epoch 1', '/verdict': 'pass' }) + '\n');

    const settled = assertOk(await stepSubmit({ runRoot: f.runRoot, runId, leaseToken: fin.leaseToken }));
    assert.equal(settled.kind, 'result');
    if (settled.kind === 'result') {
      assert.equal(settled.result.spec.status, 'completed');
    }
  } finally {
    await f.cleanup();
  }
});

test('Pi retained-attempt resume clears pre-existing 0o400 context dir without EEXIST and nodeCandidates only persists artifact-handoff steps', async () => {
  const f = await setupMultiRoleHandoffFixture('pi');
  try {
    const loaded = assertOk(await f.load(), 'load pi retained-resume fixture');
    const runId = 'pi-retained-resume-1';
    let resumedImplementSeen = false;

    const openAdapter = createPiTestPort(async ctx => {
      const okSub = {
        version: 1,
        status: 'completed',
        checks: [{ checkId: 'tests', status: 'passed', evidenceId: null, reason: null }],
        reason: null,
      };
      if (ctx.stepId === 'plan') {
        return {
          files: {
            'packages/plan.md': '## File Changes\nSet ok=true.\n## C#\nKeep C#.\n',
            'packages/plan.json': JSON.stringify({ constraints: { maxEdits: 1 } }),
          },
          responseJson: okSub,
        };
      }
      if (ctx.stepId === 'audit') {
        return { responseJson: okSub };
      }
      if (ctx.stepId === 'implement') {
        resumedImplementSeen = true;
        const contextDir = join(ctx.host.directory, 'context');
        const handoffFile = join(contextDir, 'handoffs', '00-plan-changes.md');
        const st = await lstat(handoffFile);
        assert.equal(st.mode & 0o777, 0o400);
        return {
          files: { 'packages/result.json': JSON.stringify({ ok: true }) },
          responseJson: okSub,
        };
      }
      return {
        responseJson: { verdict: 'pass', summary: 'Resumed cleanly.', findings: [] },
      };
    });

    const ctx = await createCycle(
      { configuration: loaded, repository: f.repository, runRoot: f.runRoot, runId },
      {
        openAdapter,
        afterCheckpoint: async (phase, head) => {
          if (phase === 'role.3.pre') {
            // Fix #5: `audit` has no downstream `artifact` handoff, so ONLY `plan` is persisted in `nodeCandidates`!
            assert.deepEqual(Object.keys(head.progress.nodeCandidates ?? {}), ['plan']);
            const active = head.progress.attempts.at(-1)!;
            assert.equal(active.nodeId, 'implement');
            // Pre-materialize `0o400` `O_EXCL` context files before crashing to reproduce pre-resume state on disk!
            const contextDir = join(ctx.directory, 'runtime', active.id, 'context');
            await mkdir(contextDir, { recursive: true, mode: 0o700 });
            const activeRes = roleResourcesFor(ctx.loaded, ctx.plan, 'builder').filter(r =>
              (active.activatedResourceIds ?? []).includes(r.id),
            );
            const preFiles = await materializeContextFilesDir(
              contextDir,
              activeRes,
              active.handoffExtracts ?? [],
              ctx.artifacts.directory,
              'execution',
            );
            assert.equal(preFiles.length, 4);
            for (const pf of preFiles) {
              const st = await lstat(pf);
              assert.equal(st.mode & 0o777, 0o400);
            }
            throw new Error('HARD_PROCESS_KILL_AFTER_CONTEXT_DIR');
          }
        },
      },
    );
    const crashing = new Cycle(ctx);
    await assert.rejects(crashing.execute(), /HARD_PROCESS_KILL_AFTER_CONTEXT_DIR/);
    await crashing.deadline.dispose();
    await crashing.events.suspend();
    stateValue(ctx.store.release(ctx.authority));
    stateValue(ctx.store.close());
    await ctx.owner.release();

    // Resume via public `resumeCycleWithPorts`: must NOT fail with EEXIST on pre-existing `0o400` files!
    const resumed = assertOk(
      await resumeCycleWithPorts(
        { configuration: loaded, repository: f.repository, runRoot: f.runRoot, runId },
        { openAdapter },
      ),
      'resumeCycleWithPorts after role_pre + contextDirectory materialization',
    );
    assert.equal(resumedImplementSeen, true);
    assert.equal(resumed.kind, 'result');
    if (resumed.kind === 'result') {
      assert.equal(resumed.result.spec.status, 'completed');
    }

    // Legacy plan with NO `artifact` handoffs leaves `nodeCandidates` undefined across the entire run
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'plan', kind: 'agent', uses: 'plan.step', roleId: 'builder', dependsOn: [] },
      { id: 'verify', kind: 'check', uses: 'tests', roleId: null, dependsOn: ['plan'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'plan', handlerRef: 'plan.step' },
      { stepId: 'verify', handlerRef: 'tests' },
    ]);
    await f.save();
    const legacyLoaded = assertOk(await f.load(), 'load legacy no-handoff plan');
    let sawNodeCandidates = false;
    const legacyRes = assertOk(
      await runCycleWithPorts(
        { configuration: legacyLoaded, repository: f.repository, runRoot: f.runRoot, runId: 'pi-legacy-no-cand' },
        {
          openAdapter: createPiTestPort(() => ({
            files: { 'packages/result.json': JSON.stringify({ ok: true }) },
            responseJson: {
              version: 1,
              status: 'completed',
              checks: [{ checkId: 'tests', status: 'passed', evidenceId: null, reason: null }],
              reason: null,
            },
          })),
          afterCheckpoint: async (_phase, head) => {
            if (head.progress.nodeCandidates !== undefined) sawNodeCandidates = true;
          },
        },
      ),
    );
    assert.equal(legacyRes.kind, 'result');
    assert.equal(sawNodeCandidates, false);
  } finally {
    await f.cleanup();
  }
});

test('Handoff prompt overflow fails closed with OUTPUT_LIMIT, provenance preserves upstream reworkEpoch, and computeFailedCheckSignals propagates ControllerFailure', async () => {
  // 1. Named limits sanity check
  assert.equal(CONTROLLER_LIMITS.maxStepContextFiles, 64);
  assert.equal(CONTROLLER_LIMITS.maxCompiledDagSteps, 16);
  assert.equal(CONTROLLER_LIMITS.handoffJsonCollectionLimit, 4_096);
  assert.equal(CONTROLLER_LIMITS.verifierSignalJsonBytes, 65_536);

  // 2. Provenance `reworkEpoch` preserves upstream snapshot's real epoch (`0`) instead of consumer's epoch (`2`)
  const upstreamDoc = Buffer.from('## File Changes\nUpstream epoch 0 plan.\n', 'utf8');
  const resolvedEpoch = evaluateStepHandoffSelectors(
    [{ id: 'from-epoch-0', fromStep: 'plan', source: { kind: 'artifact', path: 'packages/plan.md' }, select: { kind: 'markdown_heading', heading: '## File Changes' } }],
    () => ({ found: true, bytes: upstreamDoc, fromAttemptId: 'attempt.plan.1', reworkEpoch: 0 }),
    { stepIndex: 2, reworkEpoch: 2 },
  );
  assert.equal(resolvedEpoch[0]!.provenance.reworkEpoch, 0);

  // 3. `appendHandoffPromptBlock` fails closed with `OUTPUT_LIMIT` at `/handoffs` rather than truncating or dropping extracts
  assert.throws(
    () => appendHandoffPromptBlock('Base prompt.', resolvedEpoch, 64, 'execution'),
    err =>
      err instanceof ControllerFailure &&
      err.diagnostic.code === 'OUTPUT_LIMIT' &&
      err.diagnostic.path === '/handoffs' &&
      err.diagnostic.phase === 'execution',
  );

  // 4. End-to-end role `limits.promptBytes` overflow fails closed with `OUTPUT_LIMIT` at `/handoffs`
  const f = await setupMultiRoleHandoffFixture('delegated');
  try {
    setFixture(f.registry, ['spec', 'roleProfiles', 0, 'limits'], { promptBytes: 120 });
    await f.save();
    const loaded = assertOk(await f.load(), 'load tight promptBytes fixture');
    const runId = 'prompt-overflow-1';
    const s1 = assertStepYield(assertOk(await stepNext({ configuration: loaded, repository: f.repository, runRoot: f.runRoot, runId })));
    await writeFile(
      join(s1.candidateDir, 'packages', 'plan.md'),
      '## File Changes\n' + 'Change line details.\n'.repeat(10) + '## C#\nKeep C#.\n',
      { mode: 0o600 },
    );
    await writeFile(join(s1.candidateDir, 'packages', 'plan.json'), JSON.stringify({ constraints: { ok: true } }), { mode: 0o600 });
    const s2 = assertStepYield(assertOk(await stepSubmit({ runRoot: f.runRoot, runId, leaseToken: s1.leaseToken })));
    assert.equal(s2.stepId, 'audit');
    const overflowRes = assertOk(await stepSubmit({ runRoot: f.runRoot, runId, leaseToken: s2.leaseToken }));
    assert.equal(overflowRes.kind, 'incident');
    if (overflowRes.kind === 'incident') {
      assert.equal(overflowRes.incident.code, 'OUTPUT_LIMIT');
      assert.equal(overflowRes.incident.stage, 'execution');
    }
  } finally {
    await f.cleanup();
  }

  // 5. `computeFailedCheckSignals` does NOT swallow `ControllerFailure` from `artifacts.read` integrity checks
  const fPi = await setupMultiRoleHandoffFixture('pi');
  try {
    const loadedPi = assertOk(await fPi.load(), 'load pi for computeFailedCheckSignals');
    const ctx = await createCycle(
      { configuration: loadedPi, repository: fPi.repository, runRoot: fPi.runRoot, runId: 'signals-no-swallow' },
      {},
    );
    try {
      const cycle = new Cycle(ctx);
      await cycle.bootstrap();
      const dummyReceiptBytes = Buffer.from(JSON.stringify({ response: { status: 'failed', reason: 'property_mismatch' } }), 'utf8');
      const receiptRef = await ctx.artifacts.put('verifier-output', dummyReceiptBytes, 4_096);
      const nonJsonRef = await ctx.artifacts.put('verifier-output', Buffer.from('plain text non-json', 'utf8'), 4_096);
      // Inject historical receipt state (reworkEpoch = 1, generation = 1, receipt at generation = 0)
      cycle.head = {
        ...cycle.head!,
        progress: {
          ...cycle.head!.progress,
          reworkEpoch: 1,
          candidate: { ...cycle.head!.progress.candidate, generation: 1 },
          verifierReceipts: [
            {
              slot: ctx.plan.verifierSlots[0]!.id,
              generation: 0,
              operationId: 'op-hist-1',
              producerNonce: '0'.repeat(32),
              output: receiptRef,
              receipt: receiptRef,
            },
            {
              slot: ctx.plan.verifierSlots[1]!.id,
              generation: 0,
              operationId: 'op-hist-2',
              producerNonce: '1'.repeat(32),
              output: nonJsonRef,
              receipt: nonJsonRef,
            },
          ],
        },
      };
      // Valid JSON receipt extracts failedChecks + failureCodes, while verified non-JSON bytes are safely ignored
      const signalsOk = await cycle.computeFailedCheckSignals();
      assert.deepEqual(signalsOk.failedChecks, [ctx.plan.verifierSlots[0]!.checkId]);
      assert.deepEqual(signalsOk.failureCodes, ['property_mismatch']);

      // Corrupt `receiptRef` bytes on disk so `artifacts.read` fails SHA-256 verification -> MUST propagate, never swallowed!
      await writeFile(join(ctx.artifacts.directory, receiptRef.name), 'corrupted-bytes', { mode: 0o600 });
      await assert.rejects(
        () => cycle.computeFailedCheckSignals(),
        err => err instanceof ControllerFailure && err.diagnostic.code === 'ARTIFACT_INVALID',
      );
      await cycle.deadline.dispose();
      await cycle.events.close();
    } finally {
      stateValue(ctx.store.release(ctx.authority));
      stateValue(ctx.store.close());
      await ctx.owner.release();
    }
  } finally {
    await fPi.cleanup();
  }
});

async function chmodForWrite(path: string): Promise<void> {
  const { chmod } = await import('node:fs/promises');
  await chmod(path, 0o600);
}
