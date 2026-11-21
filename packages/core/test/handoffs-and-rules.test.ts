import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  admitTask,
  validateDocument,
  LIMITS,
  type ResourceActivationPhase,
  type ResourceActivationRule,
  type StepHandoffSelect,
  type StepHandoffSelector,
  type StepHandoffSource,
} from '../src/index.js';
import { code, contract, value } from './fixtures.js';

function nullProto<T extends Record<string, unknown>>(entries: T): T {
  return Object.assign(Object.create(null) as Record<string, unknown>, entries) as T;
}

function diamondContract() {
  const input = contract();
  input.spec.steps = [
    { id: 'plan', kind: 'agent', uses: 'plan.step', roleId: 'builder', dependsOn: [] },
    { id: 'left', kind: 'agent', uses: 'left.step', roleId: 'builder', dependsOn: ['plan'] },
    { id: 'right', kind: 'agent', uses: 'right.step', roleId: 'builder', dependsOn: ['plan'] },
    { id: 'implement', kind: 'agent', uses: 'impl.step', roleId: 'builder', dependsOn: ['left', 'right'] },
    { id: 'tests-check', kind: 'check', uses: 'tests', roleId: null, dependsOn: ['implement'] },
    { id: 'review', kind: 'agent', uses: 'review.step', roleId: 'builder', dependsOn: ['tests-check'] },
  ];
  return input;
}

function resourceWithWhen(when?: unknown, id = 'inst-1', path = 'docs/rules.md') {
  return {
    id,
    kind: 'instruction',
    path,
    digest: { algorithm: 'sha256', hex: 'a'.repeat(64) },
    ...(when !== undefined ? { when } : {}),
  };
}

test('steps[].handoffs accepts artifact, submission, verdict sources and markdown_heading, json_pointer, full selectors across diamond DAG strict ancestors', () => {
  const baseline = diamondContract();
  const baseLock = value(admitTask(baseline, { admissionId: 'admission-1', runId: 'run-1' }));
  assert.equal(Object.hasOwn(baseLock.spec.contract.spec.steps[3]!, 'handoffs'), false);

  const input = diamondContract();
  const implementHandoffs: readonly StepHandoffSelector[] = [
    {
      id: 'plan-changes',
      fromStep: 'plan',
      source: { kind: 'artifact', path: 'docs/plan.md' } satisfies StepHandoffSource,
      select: { kind: 'markdown_heading', heading: '## File Changes', includeSubheadings: true } satisfies StepHandoffSelect,
      maxBytes: 4_096,
      required: true,
    },
    {
      fromStep: 'left',
      source: { kind: 'submission' },
      select: { kind: 'json_pointer', pointers: ['', '/', '/constraints', '/a~1b', '/m~0n', '/~01', '/~10'] },
      maxBytes: 64,
      required: false,
    },
    {
      id: 'right-verdict',
      fromStep: 'right',
      source: { kind: 'verdict' },
      select: { kind: 'full' },
    },
  ];
  const reviewHandoffs: readonly StepHandoffSelector[] = [
    {
      id: 'plan-changes',
      fromStep: 'plan',
      source: { kind: 'artifact', path: 'docs/c-sharp.md' },
      select: { kind: 'markdown_heading', heading: '## C#', includeSubheadings: false },
      maxBytes: 65_536,
    },
  ];
  Object.assign(input.spec.steps[3]!, { handoffs: implementHandoffs });
  Object.assign(input.spec.steps[5]!, { handoffs: reviewHandoffs });

  const parsed = value(validateDocument(input, 'TaskContract'));
  assert.equal(parsed.spec.steps[3]!.handoffs?.length, 3);
  assert.equal(Object.getPrototypeOf(parsed.spec.steps[3]!.handoffs![0]), null);
  assert.equal(Object.getPrototypeOf(parsed.spec.steps[3]!.handoffs![0]!.source), null);
  assert.equal(Object.getPrototypeOf(parsed.spec.steps[3]!.handoffs![0]!.select), null);
  assert.equal(Object.hasOwn(parsed.spec.steps[3]!.handoffs![1]!, 'id'), false);
  assert.equal(Object.hasOwn(parsed.spec.steps[3]!.handoffs![2]!, 'maxBytes'), false);
  assert.equal(Object.hasOwn(parsed.spec.steps[3]!.handoffs![2]!, 'required'), false);

  const lock = value(admitTask(input, { admissionId: 'admission-1', runId: 'run-1' }));
  assert.notEqual(lock.spec.contractHash.hex, baseLock.spec.contractHash.hex);
  assert.equal(validateDocument(lock, 'TaskLock').ok, true);
});

test('steps[].handoffs rejects check steps, compaction steps, non-ancestors, self-reference, and unknown fromStep', () => {
  const validSelector = {
    fromStep: 'plan',
    source: { kind: 'submission' },
    select: { kind: 'full' },
  };

  // check step refusal
  const onCheck = diamondContract();
  Object.assign(onCheck.spec.steps[4]!, { handoffs: [validSelector] });
  assert.equal(code(validateDocument(onCheck, 'TaskContract')), 'FIELD_UNKNOWN');

  // explicit compaction handler refusal while preserving non-compaction handler IDs containing 'compact'
  const onCompact = diamondContract();
  onCompact.spec.steps = [
    { id: 'plan', kind: 'agent', uses: 'plan.step', roleId: 'builder', dependsOn: [] },
    Object.assign(
      { id: 'mid-compact', kind: 'agent', uses: 'pi.compact.v1', roleId: 'builder', dependsOn: ['plan'] },
      { handoffs: [validSelector] },
    ),
  ];
  assert.equal(code(validateDocument(onCompact, 'TaskContract')), 'FIELD_UNKNOWN');

  for (const nonCompactUses of ['compact-readme', 'docs.compact', 'api.compact.v2']) {
    const allowed = diamondContract();
    allowed.spec.steps = [
      { id: 'plan', kind: 'agent', uses: 'plan.step', roleId: 'builder', dependsOn: [] },
      Object.assign(
        { id: 'build-step', kind: 'agent', uses: nonCompactUses, roleId: 'builder', dependsOn: ['plan'] },
        { handoffs: [validSelector] },
      ),
    ];
    assert.equal(validateDocument(allowed, 'TaskContract').ok, true, nonCompactUses);
  }

  // unknown fromStep -> REFERENCE_UNKNOWN
  const unknownStep = diamondContract();
  Object.assign(unknownStep.spec.steps[1]!, { handoffs: [{ ...validSelector, fromStep: 'ghost' }] });
  assert.equal(code(validateDocument(unknownStep, 'TaskContract')), 'REFERENCE_UNKNOWN');

  // self-reference -> GRAPH_CYCLE
  const selfRef = diamondContract();
  Object.assign(selfRef.spec.steps[1]!, { handoffs: [{ ...validSelector, fromStep: 'left' }] });
  assert.equal(code(validateDocument(selfRef, 'TaskContract')), 'GRAPH_CYCLE');

  // non-ancestor sibling -> GRAPH_CYCLE
  const siblingRef = diamondContract();
  Object.assign(siblingRef.spec.steps[2]!, { handoffs: [{ ...validSelector, fromStep: 'left' }] });
  assert.equal(code(validateDocument(siblingRef, 'TaskContract')), 'GRAPH_CYCLE');

  // descendant -> GRAPH_CYCLE
  const descendantRef = diamondContract();
  Object.assign(descendantRef.spec.steps[0]!, { handoffs: [{ ...validSelector, fromStep: 'implement' }] });
  assert.equal(code(validateDocument(descendantRef, 'TaskContract')), 'GRAPH_CYCLE');
});

test('steps[].handoffs enforces 1..16 selector bounds, duplicate id refusal, maxBytes 64..65536, and 65536 aggregate cap', () => {
  // 0 selectors rejected
  const empty = diamondContract();
  Object.assign(empty.spec.steps[1]!, { handoffs: [] });
  assert.equal(code(validateDocument(empty, 'TaskContract')), 'VALUE_RANGE');

  // 16 selectors with maxBytes 4096 (aggregate = 65536) passes
  const max16 = diamondContract();
  Object.assign(max16.spec.steps[1]!, {
    handoffs: Array.from({ length: 16 }, (_, i) => ({
      id: `sel-${i}`,
      fromStep: 'plan',
      source: { kind: 'submission' },
      select: { kind: 'full' },
      maxBytes: 4_096,
    })),
  });
  assert.equal(validateDocument(max16, 'TaskContract').ok, true);

  // 17 selectors rejected
  const over16 = diamondContract();
  Object.assign(over16.spec.steps[1]!, {
    handoffs: Array.from({ length: 17 }, (_, i) => ({
      id: `sel-${i}`,
      fromStep: 'plan',
      source: { kind: 'submission' },
      select: { kind: 'full' },
      maxBytes: 64,
    })),
  });
  assert.equal(code(validateDocument(over16, 'TaskContract')), 'VALUE_RANGE');

  // duplicate selector id within same step rejected
  const dupId = diamondContract();
  Object.assign(dupId.spec.steps[1]!, {
    handoffs: [
      { id: 'dup', fromStep: 'plan', source: { kind: 'submission' }, select: { kind: 'full' }, maxBytes: 128 },
      { fromStep: 'plan', source: { kind: 'verdict' }, select: { kind: 'full' }, maxBytes: 128 },
      { id: 'dup', fromStep: 'plan', source: { kind: 'submission' }, select: { kind: 'full' }, maxBytes: 128 },
    ],
  });
  assert.equal(code(validateDocument(dupId, 'TaskContract')), 'DUPLICATE_ID');

  // per-selector maxBytes bounds
  for (const badMaxBytes of [0, 63, 65_537, 128.5, -64]) {
    const bad = diamondContract();
    Object.assign(bad.spec.steps[1]!, {
      handoffs: [{ fromStep: 'plan', source: { kind: 'submission' }, select: { kind: 'full' }, maxBytes: badMaxBytes }],
    });
    assert.equal(code(validateDocument(bad, 'TaskContract')), 'VALUE_RANGE', String(badMaxBytes));
  }

  // aggregate cap with default 8192: 8 passes (65536), 9 fails (73728)
  const agg8 = diamondContract();
  Object.assign(agg8.spec.steps[1]!, {
    handoffs: Array.from({ length: 8 }, () => ({
      fromStep: 'plan',
      source: { kind: 'submission' },
      select: { kind: 'full' },
    })),
  });
  assert.equal(validateDocument(agg8, 'TaskContract').ok, true);

  const agg9 = diamondContract();
  Object.assign(agg9.spec.steps[1]!, {
    handoffs: Array.from({ length: 9 }, () => ({
      fromStep: 'plan',
      source: { kind: 'submission' },
      select: { kind: 'full' },
    })),
  });
  assert.equal(code(validateDocument(agg9, 'TaskContract')), 'VALUE_RANGE');

  // aggregate cap with explicit values: 65536 passes, 65537 fails
  const aggExact = diamondContract();
  Object.assign(aggExact.spec.steps[1]!, {
    handoffs: [
      { fromStep: 'plan', source: { kind: 'submission' }, select: { kind: 'full' }, maxBytes: 65_472 },
      { fromStep: 'plan', source: { kind: 'verdict' }, select: { kind: 'full' }, maxBytes: 64 },
    ],
  });
  assert.equal(validateDocument(aggExact, 'TaskContract').ok, true);

  const aggOver = diamondContract();
  Object.assign(aggOver.spec.steps[1]!, {
    handoffs: [
      { fromStep: 'plan', source: { kind: 'submission' }, select: { kind: 'full' }, maxBytes: 65_473 },
      { fromStep: 'plan', source: { kind: 'verdict' }, select: { kind: 'full' }, maxBytes: 64 },
    ],
  });
  assert.equal(code(validateDocument(aggOver, 'TaskContract')), 'VALUE_RANGE');
});

test('steps[].handoffs enforces RFC 6901 JSON Pointer bounds, escape syntax, decoded prototype-key refusal, artifact path safety, and closed keys', () => {
  // 0 and 33 pointers rejected, 32 passes
  const zeroPtr = diamondContract();
  Object.assign(zeroPtr.spec.steps[1]!, {
    handoffs: [{ fromStep: 'plan', source: { kind: 'submission' }, select: { kind: 'json_pointer', pointers: [] } }],
  });
  assert.equal(code(validateDocument(zeroPtr, 'TaskContract')), 'VALUE_RANGE');

  const ok32 = diamondContract();
  Object.assign(ok32.spec.steps[1]!, {
    handoffs: [{
      fromStep: 'plan',
      source: { kind: 'submission' },
      select: { kind: 'json_pointer', pointers: Array.from({ length: 32 }, (_, i) => `/field-${i}`) },
    }],
  });
  assert.equal(validateDocument(ok32, 'TaskContract').ok, true);

  const bad33 = diamondContract();
  Object.assign(bad33.spec.steps[1]!, {
    handoffs: [{
      fromStep: 'plan',
      source: { kind: 'submission' },
      select: { kind: 'json_pointer', pointers: Array.from({ length: 33 }, (_, i) => `/field-${i}`) },
    }],
  });
  assert.equal(code(validateDocument(bad33, 'TaskContract')), 'VALUE_RANGE');

  // duplicate pointers rejected
  const dupPtr = diamondContract();
  Object.assign(dupPtr.spec.steps[1]!, {
    handoffs: [{ fromStep: 'plan', source: { kind: 'submission' }, select: { kind: 'json_pointer', pointers: ['/a', '/a'] } }],
  });
  assert.equal(code(validateDocument(dupPtr, 'TaskContract')), 'DUPLICATE_ID');

  // invalid RFC 6901 syntax and decoded prototype-key refusals
  for (const badPointer of [
    'no-leading-slash',
    '/bad~2escape',
    '/trailing~',
    '/double~~0',
    '/__proto__',
    '/constructor',
    '/prototype',
    '/a/__proto__/b',
    '/a/constructor',
    '/a/prototype/c',
    '/has\0null',
    '/has\nnewline',
    '/has\rcr',
    '/has\ttab',
    '/has\u001besc',
    '/has\u202ebidi',
    '/' + 'a/'.repeat(LIMITS.segments) + 'overflow',
    '/' + 'x'.repeat(LIMITS.handoffPointer),
  ]) {
    const bad = diamondContract();
    Object.assign(bad.spec.steps[1]!, {
      handoffs: [{ fromStep: 'plan', source: { kind: 'submission' }, select: { kind: 'json_pointer', pointers: [badPointer] } }],
    });
    assert.equal(code(validateDocument(bad, 'TaskContract')), 'VALUE_RANGE', badPointer);
  }

  // JSON unicode-escaped prototype key in JSON text input is also rejected
  const jsonInput = diamondContract();
  Object.assign(jsonInput.spec.steps[1]!, {
    handoffs: [{ fromStep: 'plan', source: { kind: 'submission' }, select: { kind: 'json_pointer', pointers: ['/__PLACEHOLDER__'] } }],
  });
  const encodedJson = JSON.stringify(jsonInput).replace('/__PLACEHOLDER__', '/\\u005f_proto__');
  assert.equal(code(validateDocument(encodedJson, 'TaskContract')), 'VALUE_RANGE');

  // invalid markdown_heading strings
  for (const badHeading of ['', '   ', '#', '##', '###   ', '## ###', 'Line 1\nLine 2', 'Line 1\rLine 2', 'Null\0Char', 'x'.repeat(LIMITS.handoffHeading + 1)]) {
    const bad = diamondContract();
    Object.assign(bad.spec.steps[1]!, {
      handoffs: [{ fromStep: 'plan', source: { kind: 'artifact', path: 'docs/plan.md' }, select: { kind: 'markdown_heading', heading: badHeading } }],
    });
    assert.equal(code(validateDocument(bad, 'TaskContract')), 'VALUE_RANGE', JSON.stringify(badHeading));
  }

  // invalid artifact paths
  for (const badPath of ['../escape.md', '/abs/plan.md', 'docs//plan.md', 'docs\\plan.md', 'docs/plan\0.md', 'CON']) {
    const bad = diamondContract();
    Object.assign(bad.spec.steps[1]!, {
      handoffs: [{ fromStep: 'plan', source: { kind: 'artifact', path: badPath }, select: { kind: 'full' } }],
    });
    assert.equal(code(validateDocument(bad, 'TaskContract')), 'PATH_INVALID', badPath);
  }

  // unknown properties & malformed discriminated unions
  const unknownOnSelector = diamondContract();
  Object.assign(unknownOnSelector.spec.steps[1]!, {
    handoffs: [{ fromStep: 'plan', source: { kind: 'submission' }, select: { kind: 'full' }, extra: true }],
  });
  assert.equal(code(validateDocument(unknownOnSelector, 'TaskContract')), 'FIELD_UNKNOWN');

  const unknownOnSource = diamondContract();
  Object.assign(unknownOnSource.spec.steps[1]!, {
    handoffs: [{ fromStep: 'plan', source: { kind: 'submission', path: 'extra.md' }, select: { kind: 'full' } }],
  });
  assert.equal(code(validateDocument(unknownOnSource, 'TaskContract')), 'FIELD_UNKNOWN');

  const unknownOnSelect = diamondContract();
  Object.assign(unknownOnSelect.spec.steps[1]!, {
    handoffs: [{ fromStep: 'plan', source: { kind: 'submission' }, select: { kind: 'full', heading: 'nope' } }],
  });
  assert.equal(code(validateDocument(unknownOnSelect, 'TaskContract')), 'FIELD_UNKNOWN');

  const badSourceKind = diamondContract();
  Object.assign(badSourceKind.spec.steps[1]!, {
    handoffs: [{ fromStep: 'plan', source: { kind: 'memory' }, select: { kind: 'full' } }],
  });
  assert.equal(code(validateDocument(badSourceKind, 'TaskContract')), 'VALUE_ENUM');

  const missingSourceKind = diamondContract();
  Object.assign(missingSourceKind.spec.steps[1]!, {
    handoffs: [{ fromStep: 'plan', source: {}, select: { kind: 'full' } }],
  });
  assert.equal(code(validateDocument(missingSourceKind, 'TaskContract')), 'FIELD_REQUIRED');

  const badSelectKind = diamondContract();
  Object.assign(badSelectKind.spec.steps[1]!, {
    handoffs: [{ fromStep: 'plan', source: { kind: 'submission' }, select: { kind: 'regex' } }],
  });
  assert.equal(code(validateDocument(badSelectKind, 'TaskContract')), 'VALUE_ENUM');

  const missingSelectKind = diamondContract();
  Object.assign(missingSelectKind.spec.steps[1]!, {
    handoffs: [{ fromStep: 'plan', source: { kind: 'submission' }, select: {} }],
  });
  assert.equal(code(validateDocument(missingSelectKind, 'TaskContract')), 'FIELD_REQUIRED');

  // non-string kind / non-boolean flags / non-number maxBytes -> VALUE_TYPE
  const nonStringSourceKind = diamondContract();
  Object.assign(nonStringSourceKind.spec.steps[1]!, {
    handoffs: [{ fromStep: 'plan', source: { kind: 42 }, select: { kind: 'full' } }],
  });
  assert.equal(code(validateDocument(nonStringSourceKind, 'TaskContract')), 'VALUE_TYPE');

  const nonStringSelectKind = diamondContract();
  Object.assign(nonStringSelectKind.spec.steps[1]!, {
    handoffs: [{ fromStep: 'plan', source: { kind: 'submission' }, select: { kind: null } }],
  });
  assert.equal(code(validateDocument(nonStringSelectKind, 'TaskContract')), 'VALUE_TYPE');

  const nonBoolRequired = diamondContract();
  Object.assign(nonBoolRequired.spec.steps[1]!, {
    handoffs: [{ fromStep: 'plan', source: { kind: 'submission' }, select: { kind: 'full' }, required: 'yes' }],
  });
  assert.equal(code(validateDocument(nonBoolRequired, 'TaskContract')), 'VALUE_TYPE');

  const nonBoolSubheadings = diamondContract();
  Object.assign(nonBoolSubheadings.spec.steps[1]!, {
    handoffs: [{ fromStep: 'plan', source: { kind: 'artifact', path: 'docs/plan.md' }, select: { kind: 'markdown_heading', heading: 'Scope', includeSubheadings: 1 } }],
  });
  assert.equal(code(validateDocument(nonBoolSubheadings, 'TaskContract')), 'VALUE_TYPE');

  // escaped ~0 prefix does not false-positive as __proto__, while nested __proto__ after escaped segment is rejected
  const validTildeProto = diamondContract();
  Object.assign(validTildeProto.spec.steps[1]!, {
    handoffs: [{ fromStep: 'plan', source: { kind: 'submission' }, select: { kind: 'json_pointer', pointers: ['/~0__proto__'] } }],
  });
  assert.equal(validateDocument(validTildeProto, 'TaskContract').ok, true);

  const nestedAfterEscaped = diamondContract();
  Object.assign(nestedAfterEscaped.spec.steps[1]!, {
    handoffs: [{ fromStep: 'plan', source: { kind: 'submission' }, select: { kind: 'json_pointer', pointers: ['/a~1b/__proto__'] } }],
  });
  assert.equal(code(validateDocument(nestedAfterEscaped, 'TaskContract')), 'VALUE_RANGE');
});

test('steps[].handoffs and trustedContext.resources[].when accept null-prototype objects', () => {
  const input = diamondContract();
  Object.assign(input.spec.steps[1]!, {
    handoffs: [
      nullProto({
        id: 'null-proto-handoff',
        fromStep: 'plan',
        source: nullProto({ kind: 'artifact', path: 'docs/plan.md' }),
        select: nullProto({ kind: 'markdown_heading', heading: '## Scope', includeSubheadings: false }),
        maxBytes: 1_024,
        required: true,
      }),
    ],
  });
  Object.assign(input.spec.trustedContext, {
    resources: [
      nullProto({
        id: 'cond-1',
        kind: 'instruction',
        path: 'docs/ts-rules.md',
        digest: nullProto({ algorithm: 'sha256', hex: 'b'.repeat(64) }),
        when: nullProto({
          changedPaths: ['packages/core/**'],
          extensions: ['.ts', '.d.ts'],
          phases: ['author', 'repair'],
          failedChecks: ['typecheck'],
          failureCodes: ['TS_2322'],
        }),
      }),
    ],
  });
  const parsed = value(validateDocument(input, 'TaskContract'));
  assert.equal(parsed.spec.steps[1]!.handoffs![0]!.id, 'null-proto-handoff');
  assert.deepEqual(parsed.spec.trustedContext.resources[0]!.when?.extensions, ['.ts', '.d.ts']);
});

test('trustedContext.resources[].when validates every predicate field, rejects empty {}, invalid values, unknown properties, and enforces discovery: disabled', () => {
  // Unconditional resource keeps `when` omitted and preserves baseline structure
  const base = contract();
  Object.assign(base.spec.trustedContext, { resources: [resourceWithWhen(undefined)] });
  const baseParsed = value(validateDocument(base, 'TaskContract'));
  assert.equal(Object.hasOwn(baseParsed.spec.trustedContext.resources[0]!, 'when'), false);
  const baseLock = value(admitTask(base, { admissionId: 'admission-1', runId: 'run-1' }));

  // All five predicate fields valid individually and combined
  const allPhases: readonly ResourceActivationPhase[] = ['author', 'review', 'repair', 'rework'];
  const fullRule: ResourceActivationRule = {
    changedPaths: ['packages/core/**', 'docs/*.md'],
    extensions: ['.ts', '.d.ts', '.yaml', '.json'],
    phases: allPhases,
    failedChecks: ['tests', 'controller.scope'],
    failureCodes: ['CHECK_FAILED', 'ts:2322', 'exit-1'],
  };
  const validAll = contract();
  Object.assign(validAll.spec.trustedContext, {
    resources: [
      resourceWithWhen(fullRule, 'r-all', 'docs/all.md'),
      resourceWithWhen({ changedPaths: ['**'] }, 'r-paths', 'docs/paths.md'),
      resourceWithWhen({ extensions: ['.mjs'] }, 'r-ext', 'docs/ext.md'),
      resourceWithWhen({ phases: ['repair'] }, 'r-phase', 'docs/phase.md'),
      resourceWithWhen({ failedChecks: ['tests'] }, 'r-checks', 'docs/checks.md'),
      resourceWithWhen({ failureCodes: ['SCOPE_VIOLATION'] }, 'r-codes', 'docs/codes.md'),
    ],
  });
  const parsedAll = value(validateDocument(validAll, 'TaskContract'));
  assert.equal(parsedAll.spec.trustedContext.resources.length, 6);
  assert.equal(Object.getPrototypeOf(parsedAll.spec.trustedContext.resources[0]!.when), null);
  assert.deepEqual(parsedAll.spec.trustedContext.resources[0]!.when?.phases, allPhases);

  // Adding `when` changes contractHash deterministically
  const condOnly = contract();
  Object.assign(condOnly.spec.trustedContext, { resources: [resourceWithWhen({ phases: ['repair'] })] });
  const condLock = value(admitTask(condOnly, { admissionId: 'admission-1', runId: 'run-1' }));
  assert.notEqual(condLock.spec.contractHash.hex, baseLock.spec.contractHash.hex);

  // Empty when: {} and null-prototype empty object rejected
  for (const emptyWhen of [{}, Object.create(null)]) {
    const bad = contract();
    Object.assign(bad.spec.trustedContext, { resources: [resourceWithWhen(emptyWhen)] });
    assert.equal(code(validateDocument(bad, 'TaskContract')), 'VALUE_RANGE');
  }

  // Non-object when rejected
  for (const badType of [null, [], 'repair', 42, true]) {
    const bad = contract();
    Object.assign(bad.spec.trustedContext, { resources: [resourceWithWhen(badType)] });
    assert.equal(code(validateDocument(bad, 'TaskContract')), 'VALUE_TYPE');
  }

  // Empty predicate lists rejected
  for (const emptyField of ['changedPaths', 'extensions', 'phases', 'failedChecks', 'failureCodes'] as const) {
    const bad = contract();
    Object.assign(bad.spec.trustedContext, { resources: [resourceWithWhen({ [emptyField]: [] })] });
    assert.equal(code(validateDocument(bad, 'TaskContract')), 'VALUE_RANGE', emptyField);
  }

  // Invalid phase
  for (const badPhase of ['format', 'compaction', 'AUTHOR', '']) {
    const bad = contract();
    Object.assign(bad.spec.trustedContext, { resources: [resourceWithWhen({ phases: [badPhase] })] });
    assert.equal(code(validateDocument(bad, 'TaskContract')), 'VALUE_ENUM', badPhase);
  }

  // Duplicate phase
  const dupPhase = contract();
  Object.assign(dupPhase.spec.trustedContext, { resources: [resourceWithWhen({ phases: ['repair', 'repair'] })] });
  assert.equal(code(validateDocument(dupPhase, 'TaskContract')), 'DUPLICATE_ID');

  // Invalid extensions (missing leading '.', uppercase, traversal, double dot, trailing dot, over max length)
  for (const badExt of ['ts', '.TS', '.', '..', '../ts', '..ts', '.ts/', '.ts\\', '.a..b', '.a.', '.' + 'a'.repeat(33)]) {
    const bad = contract();
    Object.assign(bad.spec.trustedContext, { resources: [resourceWithWhen({ extensions: [badExt] })] });
    assert.equal(code(validateDocument(bad, 'TaskContract')), 'VALUE_RANGE', badExt);
  }

  // Invalid globs in changedPaths
  for (const badGlob of ['../escape/**', '/abs/**', 'packages/**/nested', 'packages/{a,b}.ts']) {
    const bad = contract();
    Object.assign(bad.spec.trustedContext, { resources: [resourceWithWhen({ changedPaths: [badGlob] })] });
    const err = code(validateDocument(bad, 'TaskContract'));
    assert.ok(err === 'PATH_INVALID' || err === 'PATTERN_UNSUPPORTED', `${badGlob} -> ${err}`);
  }

  // Invalid failedChecks and failureCodes
  const badCheck = contract();
  Object.assign(badCheck.spec.trustedContext, { resources: [resourceWithWhen({ failedChecks: ['Bad Check!'] })] });
  assert.equal(code(validateDocument(badCheck, 'TaskContract')), 'IDENTIFIER_INVALID');

  for (const badCode of ['has space', 'bad\ncode', '-leading', 'bad/code']) {
    const bad = contract();
    Object.assign(bad.spec.trustedContext, { resources: [resourceWithWhen({ failureCodes: [badCode] })] });
    assert.equal(code(validateDocument(bad, 'TaskContract')), 'IDENTIFIER_INVALID', badCode);
  }

  // Unknown property on when rejected
  const unknownWhen = contract();
  Object.assign(unknownWhen.spec.trustedContext, { resources: [resourceWithWhen({ phases: ['author'], extra: true })] });
  assert.equal(code(validateDocument(unknownWhen, 'TaskContract')), 'FIELD_UNKNOWN');

  // Collection ceiling enforcement on predicate lists
  const tooManyPaths = contract();
  Object.assign(tooManyPaths.spec.trustedContext, {
    resources: [resourceWithWhen({ changedPaths: Array.from({ length: LIMITS.ruleChangedPaths + 1 }, (_, i) => `src/f-${i}.ts`) })],
  });
  assert.equal(code(validateDocument(tooManyPaths, 'TaskContract')), 'VALUE_RANGE');

  const tooManyExts = contract();
  Object.assign(tooManyExts.spec.trustedContext, {
    resources: [resourceWithWhen({ extensions: Array.from({ length: LIMITS.ruleExtensions + 1 }, (_, i) => `.ext${i}`) })],
  });
  assert.equal(code(validateDocument(tooManyExts, 'TaskContract')), 'VALUE_RANGE');

  const tooManyChecks = contract();
  Object.assign(tooManyChecks.spec.trustedContext, {
    resources: [resourceWithWhen({ failedChecks: Array.from({ length: LIMITS.ruleFailedChecks + 1 }, (_, i) => `chk-${i}`) })],
  });
  assert.equal(code(validateDocument(tooManyChecks, 'TaskContract')), 'VALUE_RANGE');

  const tooManyCodes = contract();
  Object.assign(tooManyCodes.spec.trustedContext, {
    resources: [resourceWithWhen({ failureCodes: Array.from({ length: LIMITS.ruleFailureCodes + 1 }, (_, i) => `ERR_${i}`) })],
  });
  assert.equal(code(validateDocument(tooManyCodes, 'TaskContract')), 'VALUE_RANGE');

  // trustedContext.discovery remains strictly 'disabled' even with conditional resources
  const discoveryEnabled = contract();
  discoveryEnabled.spec.trustedContext.discovery = 'enabled';
  Object.assign(discoveryEnabled.spec.trustedContext, { resources: [resourceWithWhen({ phases: ['repair'] })] });
  assert.equal(code(validateDocument(discoveryEnabled, 'TaskContract')), 'VALUE_ENUM');
});
