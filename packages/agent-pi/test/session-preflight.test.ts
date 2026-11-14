import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { admitTask, digestArtifact } from '@loopwright/core';
import { test } from 'node:test';
import { prepareInput } from '../src/preflight.js';
import { sessionInput } from './session-fixtures.js';
import { PiFailure } from '../src/errors.js';

function blobOid(format: 'sha1' | 'sha256', bytes: Uint8Array): string {
  return createHash(format).update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

function overlayBase(objectFormat: 'sha1' | 'sha256' = 'sha1') {
  const source = sessionInput();
  const oidHex = objectFormat === 'sha1' ? 'a'.repeat(40) : 'a'.repeat(64);
  const fileA = Buffer.from('console.log("a");\n');
  const fileB = Buffer.from('#!/bin/sh\necho b\n');
  const entries = [
    { name: 'packages/a.ts', mode: '100644' as const, oid: blobOid(objectFormat, fileA), byteLength: fileA.byteLength },
    { name: 'packages/b.sh', mode: '100755' as const, oid: blobOid(objectFormat, fileB), byteLength: fileB.byteLength },
  ];
  return {
    ...source,
    candidate: {
      manifest: {
        apiVersion: 'loopwright.dev/v1alpha1' as const,
        kind: 'ArtifactManifest' as const,
        metadata: { id: 'candidate' },
        spec: {
          baseTree: { objectFormat, commitOid: oidHex, treeOid: oidHex },
          entries: [],
          deleted: [],
        },
      },
      baseRevision: source.candidate.baseRevision,
      sourceRevision: source.candidate.sourceRevision,
      artifacts: [],
      baseline: {
        directory: '/tmp/loopwright-baseline',
        entries,
      },
    },
  };
}
test('role, step and model identities refuse before any session effect', () => {
  const source = sessionInput();
  for (const patch of [{ roleId: 'other' }, { stepId: 'other' }, { policy: { ...source.policy, selection: { ...source.policy.selection, model: 'other' } } }]) {
    assert.throws(() => prepareInput({ ...source, ...patch }), error => error instanceof PiFailure && error.detail.effect === 'none');
  }
});
test('strict default and hard-token routes refuse before model/container startup', () => {
  const source = sessionInput(), context: Record<string, unknown> = { ...source.policy.context }; delete context.mode;
  assert.throws(() => prepareInput({ ...source, policy: { ...source.policy, context } }), error => error instanceof PiFailure && error.detail.code === 'CONTEXT_UNSAFE');
  const contract = structuredClone(source.lock.spec.contract); (contract.spec.budgets.enforcement as { tokens: string }).tokens = 'hard_admission';
  const locked = admitTask(contract, { admissionId: source.lock.metadata.id, runId: source.lock.spec.runId }); assert.equal(locked.ok, true); if (!locked.ok) return;
  assert.throws(() => prepareInput({ ...source, lock: locked.value }), error => error instanceof PiFailure && error.detail.code === 'CAPABILITY_UNSUPPORTED');
});
test('owned input cannot be mutated and artifact bytes have no caller aliases', () => {
  const source = sessionInput(), result = prepareInput(source);
  source.candidate.artifacts[0]!.bytes[0] = 0;
  assert.notEqual(result.candidate.artifacts[0]!.bytes[0], 0);
  assert.ok(Object.isFrozen(result.policy));
});
test('accessors and proxies are rejected without running caller code', () => {
  let touched = 0; const source = sessionInput();
  const getter = { ...source }; Object.defineProperty(getter, 'policy', { enumerable: true, get: () => { touched++; throw new Error('caller getter'); } });
  const proxy = new Proxy(source, { ownKeys: () => { touched++; throw new Error('caller trap'); } });
  assert.throws(() => prepareInput(getter), PiFailure); assert.throws(() => prepareInput(proxy), PiFailure); assert.equal(touched, 0);
});
test('typed artifact views reject shared memory and ignore caller byte getters', () => {
  const source = sessionInput(); let touched = 0;
  Object.defineProperty(source.candidate.artifacts[0]!.bytes, 'byteLength', { get: () => { touched++; throw new Error('caller byte getter'); } });
  assert.ok(prepareInput(source)); assert.equal(touched, 0);
  const shared = sessionInput(); const candidate = { ...shared.candidate, artifacts: [{ name: shared.candidate.artifacts[0]!.name, bytes: new Uint8Array(new SharedArrayBuffer(4)) }] };
  assert.throws(() => prepareInput({ ...shared, candidate }), PiFailure);
});
test('unauthorized plugins, tools, destination fields and widened limits refuse', () => {
  const source = sessionInput();
  for (const policy of [
    { ...source.policy, extensions: ['@monotykamary/pi-retry'] },
    { ...source.policy, tools: ['mcp__workspace__denied_write'] },
    { ...source.policy, mcp: { ...source.policy.mcp, url: 'https://forbidden.invalid' } },
    { ...source.policy, limits: { ...source.policy.limits, responseBytes: 1048577 } },
  ]) assert.throws(() => prepareInput({ ...source, policy }), PiFailure);
});
test('candidate revision, inventory and content digests bind the owned bytes', () => {
  const source = sessionInput();
  assert.throws(() => prepareInput({ ...source, candidate: { ...source.candidate, baseRevision: 'other' } }), PiFailure);
  source.candidate.artifacts[0]!.bytes[0] = 0; assert.throws(() => prepareInput(source), PiFailure);
});

test('unsupported smaller fixed transport caps fail before startup instead of being ignored', () => {
  const source = sessionInput(); for (const limits of [{ ...source.policy.limits, frameBytes: 32768 }, { ...source.policy.limits, pendingResponseBytes: 131072 }, { ...source.policy.limits, diagnosticBytes: 32 }]) assert.throws(() => prepareInput({ ...source, policy: { ...source.policy, limits } }), error => error instanceof PiFailure && error.detail.code === 'CAPABILITY_UNSUPPORTED');
});

test('classic candidate rejects unexpected baseline while overlay candidate validates and freezes baseline without snapshot cap', () => {
  const classic = sessionInput();
  assert.throws(
    () => prepareInput({ ...classic, candidate: { ...classic.candidate, baseline: { directory: '/tmp/b', entries: [] } } }),
    error => error instanceof PiFailure && error.detail.code === 'INPUT_INVALID' && error.detail.path === '/candidate/baseline',
  );
  const omitted = prepareInput({ ...classic, candidate: { ...classic.candidate, baseline: undefined } });
  assert.equal(omitted.candidate.baseline, undefined);

  // Missing baseline in tree_overlay mode refuses
  const missing = overlayBase();
  delete (missing.candidate as { baseline?: unknown }).baseline;
  assert.throws(() => prepareInput(missing), error => error instanceof PiFailure && error.detail.code === 'INPUT_INVALID');

  // Large baseline (> 4096 entries, beyond snapshot() array cap) passes and freezes entries without caller aliases
  const large = overlayBase('sha256');
  const oid256 = 'b'.repeat(64);
  const largeEntries = Array.from({ length: 5000 }, (_, i) => ({
    name: `packages/f-${String(i).padStart(5, '0')}.ts`,
    mode: (i % 2 === 0 ? '100644' : '100755') as '100644' | '100755',
    oid: oid256,
    byteLength: 10,
  }));
  large.candidate.baseline.entries = largeEntries;
  const prepared = prepareInput(large);
  assert.equal(prepared.candidate.baseline?.entries.length, 5000);
  assert.ok(Object.isFrozen(prepared.candidate.baseline));
  assert.ok(Object.isFrozen(prepared.candidate.baseline?.entries));
  assert.ok(Object.isFrozen(prepared.candidate.baseline?.entries[0]));
  largeEntries[0] = { name: 'mutated.ts', mode: '100644', oid: oid256, byteLength: 1 };
  assert.equal(prepared.candidate.baseline?.entries[0]?.name, 'packages/f-00000.ts');

  // Untouched baseline entry exceeding policy.limits.fileBytes (e.g. 10 MiB binary/fixture) is allowed at preflight
  const oversize = overlayBase('sha256');
  oversize.candidate.baseline.entries = [
    { name: 'packages/large.bin', mode: '100644', oid: 'c'.repeat(64), byteLength: 10 * 1024 * 1024 },
  ];
  const preparedOversize = prepareInput(oversize);
  assert.equal(preparedOversize.candidate.baseline?.entries[0]?.byteLength, 10 * 1024 * 1024);
});

test('overlay baseline preflight rejects malformed directory, ordering, .git/segment, OID format, collisions and cross-checks', () => {
  const expectFail = (fn: () => unknown, code: string) => {
    assert.throws(fn, error => error instanceof PiFailure && error.detail.code === code);
  };

  // Relative or newline directory
  for (const directory of ['relative/dir', '', '/tmp/bad\ndir', '/tmp/bad\0dir']) {
    const base = overlayBase();
    base.candidate.baseline.directory = directory;
    expectFail(() => prepareInput(base), 'INPUT_INVALID');
  }

  // Unsorted entries
  {
    const base = overlayBase();
    base.candidate.baseline.entries = [base.candidate.baseline.entries[1]!, base.candidate.baseline.entries[0]!];
    expectFail(() => prepareInput(base), 'INPUT_INVALID');
  }

  // .git segment and >255 UTF-8 byte segment
  {
    const base = overlayBase();
    base.candidate.baseline.entries = [{ name: 'packages/.GIT/config', mode: '100644', oid: 'a'.repeat(40), byteLength: 5 }];
    expectFail(() => prepareInput(base), 'INPUT_INVALID');
  }
  {
    const base = overlayBase();
    base.candidate.baseline.entries = [{ name: 'packages/' + 'x'.repeat(256), mode: '100644', oid: 'a'.repeat(40), byteLength: 5 }];
    expectFail(() => prepareInput(base), 'INPUT_INVALID');
  }

  // Case-insensitive and directory-vs-file prefix collisions inside baseline
  {
    const base = overlayBase();
    base.candidate.baseline.entries = [
      { name: 'packages/A.ts', mode: '100644', oid: 'a'.repeat(40), byteLength: 5 },
      { name: 'packages/a.ts', mode: '100644', oid: 'a'.repeat(40), byteLength: 5 },
    ];
    expectFail(() => prepareInput(base), 'INPUT_INVALID');
  }
  {
    const base = overlayBase();
    base.candidate.baseline.entries = [
      { name: 'packages/a', mode: '100644', oid: 'a'.repeat(40), byteLength: 5 },
      { name: 'packages/a/b.ts', mode: '100644', oid: 'a'.repeat(40), byteLength: 5 },
    ];
    expectFail(() => prepareInput(base), 'INPUT_INVALID');
  }

  // Wrong OID length for sha1 vs sha256, bad mode, negative byteLength
  {
    const base = overlayBase('sha1');
    base.candidate.baseline.entries[0] = { ...base.candidate.baseline.entries[0]!, oid: 'a'.repeat(64) };
    expectFail(() => prepareInput(base), 'INPUT_INVALID');
  }
  {
    const base = overlayBase('sha256');
    base.candidate.baseline.entries[0] = { ...base.candidate.baseline.entries[0]!, oid: 'a'.repeat(40) };
    expectFail(() => prepareInput(base), 'INPUT_INVALID');
  }
  {
    const base = overlayBase('sha1');
    (base.candidate.baseline.entries[0] as { mode: string }).mode = '120000';
    expectFail(() => prepareInput(base), 'INPUT_INVALID');
  }
  {
    const base = overlayBase('sha1');
    base.candidate.baseline.entries[0] = { ...base.candidate.baseline.entries[0]!, byteLength: -1 };
    expectFail(() => prepareInput(base), 'INPUT_INVALID');
  }

  // Deleted path missing from baseline
  {
    const base = overlayBase();
    (base.candidate.manifest.spec as { deleted: string[] }).deleted = ['packages/nonexistent.ts'];
    expectFail(() => prepareInput(base), 'RESOURCE_MISMATCH');
  }

  // Overlay entry identical to baseline Git blob OID (not minimal)
  {
    const base = overlayBase();
    const sameBytes = Buffer.from('console.log("a");\n');
    const ref = digestArtifact('packages/a.ts', sameBytes);
    assert.equal(ref.ok, true);
    if (ref.ok) {
      (base.candidate.manifest.spec as { entries: unknown[] }).entries = [ref.value];
      (base.candidate as { artifacts: unknown[] }).artifacts = [{ name: 'packages/a.ts', bytes: sameBytes }];
    }
    expectFail(() => prepareInput(base), 'RESOURCE_MISMATCH');
  }

  // Overlay entry colliding case-insensitively or by prefix with non-deleted baseline entry
  {
    const base = overlayBase();
    const bytes = Buffer.from('changed');
    const ref = digestArtifact('packages/A.ts', bytes);
    assert.equal(ref.ok, true);
    if (ref.ok) {
      (base.candidate.manifest.spec as { entries: unknown[] }).entries = [ref.value];
      (base.candidate as { artifacts: unknown[] }).artifacts = [{ name: 'packages/A.ts', bytes }];
    }
    expectFail(() => prepareInput(base), 'RESOURCE_MISMATCH');
  }
  {
    const base = overlayBase();
    const bytes = Buffer.from('nested');
    const ref = digestArtifact('packages/a.ts/nested.ts', bytes);
    assert.equal(ref.ok, true);
    if (ref.ok) {
      (base.candidate.manifest.spec as { entries: unknown[] }).entries = [ref.value];
      (base.candidate as { artifacts: unknown[] }).artifacts = [{ name: 'packages/a.ts/nested.ts', bytes }];
    }
    expectFail(() => prepareInput(base), 'RESOURCE_MISMATCH');
  }

  // Overlay aggregate bytes > 4_194_304 refused with OUTPUT_LIMIT
  {
    const base = overlayBase();
    const big = Buffer.alloc(4_194_305, 0x61);
    const ref = digestArtifact('packages/big.ts', big);
    assert.equal(ref.ok, true);
    if (ref.ok) {
      (base.candidate.manifest.spec as { entries: unknown[] }).entries = [ref.value];
      (base.candidate as { artifacts: unknown[] }).artifacts = [{ name: 'packages/big.ts', bytes: big }];
    }
    expectFail(() => prepareInput(base), 'OUTPUT_LIMIT');
  }

  // Overlay canonical manifest bytes > 32_768 refused with OUTPUT_LIMIT
  {
    const base = overlayBase();
    const bytes = Buffer.from('x');
    const manifestEntries: unknown[] = [];
    const artifacts: unknown[] = [];
    for (let i = 0; i < 128; i++) {
      const name = `packages/${'d'.repeat(230)}-${String(i).padStart(3, '0')}.ts`;
      const ref = digestArtifact(name, bytes);
      assert.equal(ref.ok, true);
      if (ref.ok) {
        manifestEntries.push(ref.value);
        artifacts.push({ name, bytes });
      }
    }
    (base.candidate.manifest.spec as { entries: unknown[] }).entries = manifestEntries;
    (base.candidate as { artifacts: unknown[] }).artifacts = artifacts;
    expectFail(() => prepareInput(base), 'OUTPUT_LIMIT');
  }
});
