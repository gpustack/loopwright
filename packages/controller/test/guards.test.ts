import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { admitTask, bindSubject, digestArtifact, identifyManifest, type ArtifactManifest, type ArtifactRef } from '@loopwright/core';
import { contract } from '../../core/test/fixtures.js';
import { configurationFixture } from './config-fixtures.js';
import { retainedFixture, setFixture } from './progress-fixtures.js';
import { retainInventoryInputs } from './verification-fixtures.js';
import { evaluateControllerAcceptance } from '../src/acceptance.js';
import { runCycleWithPorts } from '../src/controller.js';
import { installedHandlerDigests } from '../src/handlers.js';
import { checkedRefusalRecord, checkedRefusalSubject, sizeJob, VerifierSizingFailure } from '../src/refusal-record.js';
import { canonical, hash } from '../src/schema.js';
import { canonicalizeCandidateManifest, overlayManifestBounds } from '../src/source.js';
import { stepNext, stepSubmit } from '../src/step.js';
import { stateValue } from '../src/storage.js';
import { normalizeSubmission } from '../src/submission.js';
import { authenticatedCheck, preflightVerification, prepareVerification, Verifier, type ByteInventory } from '../src/verification.js';
import { checkedHeader, descriptor, encodeInventory, encodePacket, evaluatePacket, overlayProtocolBounds, type VerifierHeader } from '../src/verifier-protocol.js';

async function initGitRepo(directory: string, files: Readonly<Record<string, string>>): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const git = (args: string[]) =>
    execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: directory,
      env: {
        PATH: '/usr/bin:/bin',
        LANG: 'C',
        LC_ALL: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        HOME: '/nonexistent',
        GIT_TERMINAL_PROMPT: '0',
      },
      timeout: 10_000,
      encoding: 'utf8',
    });
  git(['init', '-q']);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(directory, rel);
    await mkdir(join(abs, '..'), { recursive: true, mode: 0o700 });
    await writeFile(abs, content, { mode: 0o600 });
  }
  git(['add', '.']);
  git(['-c', 'user.name=Test', '-c', 'user.email=test@localhost.invalid', 'commit', '-qm', 'initial']);
  return git(['rev-parse', 'HEAD']).trim();
}

test('installedHandlerDigests registers json-keys-guard.v1 and line-section-guard.v1 with distinct SHA-256 digests', async () => {
  const digests = await installedHandlerDigests();
  for (const impl of [
    'pi.agent.v1',
    'pi.compact.v1',
    'scope.v1',
    'json-artifact.v1',
    'json-keys-guard.v1',
    'line-section-guard.v1',
    'no-change.v1',
    'gate.v1',
  ] as const) {
    assert.equal(digests[impl].algorithm, 'sha256');
    assert.match(digests[impl].hex, /^[0-9a-f]{64}$/);
  }
  assert.notEqual(digests['json-keys-guard.v1'].hex, digests['line-section-guard.v1'].hex);
  assert.notEqual(digests['json-keys-guard.v1'].hex, digests['json-artifact.v1'].hex);
});

test('json-keys-guard.v1 enforces RFC 6901 pointer boundaries, escaped tokens, nested children, duplicate-key rejection, and findings propagation', async () => {
  const basePkg = JSON.stringify({
    name: '@loopwright/demo',
    version: '1.0.0',
    dependencies: {
      '@earendil-works/pi-ai': '0.1.0',
      lodash: '4.17.21',
    },
    devDependencies: {
      typescript: '5.6.0',
    },
    config: {
      'a~b': 'old',
    },
  });

  const installed = await installedHandlerDigests();
  const f = await retainedFixture(1, 10, 8, 60_000, fixture => {
    setFixture(fixture.registry, ['spec', 'roleProfiles', 0, 'tools'], ['read', 'write', 'edit', 'delete']);
    setFixture(fixture.config, ['spec', 'task', 'spec', 'roles', 0, 'tools'], ['read', 'write', 'edit', 'delete']);
    setFixture(fixture.registry, ['spec', 'handlers'], [
      ...fixture.registry.spec.handlers.filter(h => h.id !== 'tests'),
      {
        id: 'pkg-guard',
        kind: 'check',
        implementation: 'json-keys-guard.v1',
        version: 1,
        digest: installed['json-keys-guard.v1'],
        parameters: {
          checkId: 'pkg-guard',
          path: 'packages/pkg.json',
          allowedPointers: ['/dependencies/@earendil-works~1pi-ai', '/devDependencies', '/config/a~0b'],
        },
        capabilities: ['inert_bytes', 'read_only'],
      },
    ]);
    setFixture(fixture.config, ['spec', 'task', 'spec', 'acceptance'], {
      required: ['pkg-guard'],
      checks: [{ id: 'pkg-guard', allowedEvidenceLevels: ['local_execution'] }],
    });
  });

  try {
    const makeInv = async (files: { name: string; bytes: Buffer }[]): Promise<ByteInventory> => {
      const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const entries = sorted.map(file => {
        const r = digestArtifact(file.name, file.bytes);
        assert.equal(r.ok, true);
        if (!r.ok) throw new Error('bad artifact');
        return r.value;
      });
      const manifest: ArtifactManifest = { apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' }, spec: { entries } };
      const ref = await f.artifacts.json('manifest', manifest, 32_768);
      await retainInventoryInputs(f.artifacts, manifest, ref, sorted);
      return { manifest, ref, files: sorted };
    };

    const source = await makeInv([{ name: 'packages/pkg.json', bytes: Buffer.from(basePkg, 'utf8') }]);

    const runGuard = async (candText: string | null, generation: number) => {
      const candFiles = candText === null ? [] : [{ name: 'packages/pkg.json', bytes: Buffer.from(candText, 'utf8') }];
      const candidate = await makeInv(candFiles);
      const bound = bindSubject(f.lock, candidate.manifest);
      assert.equal(bound.ok, true);
      if (!bound.ok) throw new Error('bind failed');
      const verifier = new Verifier(f.store, f.authority, f.artifacts, f.plan, f.lock, () => bound.value);
      const checks = [];
      for (const [idx, slot] of f.plan.verifierSlots.entries()) {
        const prep = prepareVerification(f.plan, f.lock, slot.id, source, candidate, generation, `${generation.toString(16).padStart(16, '0')}${idx.toString(16).padStart(16, '0')}`);
        checks.push(await verifier.run(prep, new AbortController().signal));
      }
      const sub = normalizeSubmission(
        Buffer.from(JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null })),
        f.plan.task,
      );
      const accepted = evaluateControllerAcceptance(f.plan, f.lock, candidate.manifest, candidate.files, generation, checks, sub, f.store);
      return { checks, accepted };
    };

    // 1. Unchanged file passes
    const unchanged = await runGuard(basePkg, 0);
    assert.equal(unchanged.accepted.result.spec.status, 'completed');

    // 2. Escaped ~1 / ~0 pointer edits + nested devDependencies addition/deletion pass
    const validEdit = JSON.stringify({
      name: '@loopwright/demo',
      version: '1.0.0',
      dependencies: {
        '@earendil-works/pi-ai': '0.2.0',
        lodash: '4.17.21',
      },
      devDependencies: {
        vitest: '2.1.0',
      },
      config: {
        'a~b': 'new',
      },
    });
    const passed = await runGuard(validEdit, 1);
    assert.equal(passed.accepted.result.spec.status, 'completed');
    const passRow = passed.accepted.verification.spec.required[0]!;
    assert.equal(passRow.status, 'passed');

    // 3. Out-of-pointer modification + sibling prefix attack (/devDependenciesExtra) + deletion fail with structured findings
    const disallowedEdit = JSON.stringify({
      name: '@loopwright/demo',
      dependencies: {
        '@earendil-works/pi-ai': '0.2.0',
        lodash: '4.17.99',
      },
      devDependencies: {
        typescript: '5.6.0',
      },
      devDependenciesExtra: {
        sneaky: '1.0.0',
      },
      config: {
        'a~b': 'old',
      },
    });
    const failedOut = await runGuard(disallowedEdit, 2);
    assert.equal(failedOut.accepted.result.spec.status, 'failed');
    const failRow = failedOut.accepted.verification.spec.required[0]!;
    assert.equal(failRow.status, 'failed');
    assert.ok(failRow.findings && failRow.findings.length >= 3);
    const evidenceText = failRow.findings.map(item => item.evidence).join('\n');
    assert.match(evidenceText, /\/version/);
    assert.match(evidenceText, /\/dependencies\/lodash/);
    assert.match(evidenceText, /\/devDependenciesExtra/);

    // 4. Duplicate JSON key in candidate fails deterministically
    const dupJson = '{"name":"@loopwright/demo","name":"dup","version":"1.0.0"}';
    const failedDup = await runGuard(dupJson, 3);
    assert.equal(failedDup.accepted.result.spec.status, 'failed');
    const dupCheck = failedDup.checks.find(c => c.checkId === 'pkg-guard')!;
    assert.equal(dupCheck.status, 'failed');
    assert.equal(dupCheck.reason, 'invalid_json');
    assert.ok((authenticatedCheck(dupCheck).evidence.spec.findings?.length ?? 0) >= 1);

    // 5. Deleted candidate file fails with missing_file
    const failedMissing = await runGuard(null, 4);
    assert.equal(failedMissing.accepted.result.spec.status, 'failed');
    assert.equal(failedMissing.checks.find(c => c.checkId === 'pkg-guard')?.reason, 'missing_file');

    // 6. Lone UTF-16 surrogate in candidate JSON fails cleanly as invalid_json (never crashes with RECOVERY_REQUIRED)
    const loneSurrogateJson = '{"name":"@loopwright/demo","version":"1.0.0","\\ud800":1}';
    const failedSurrogate = await runGuard(loneSurrogateJson, 5);
    assert.equal(failedSurrogate.accepted.result.spec.status, 'failed');
    const surrCheck = failedSurrogate.checks.find(c => c.checkId === 'pkg-guard')!;
    assert.equal(surrCheck.status, 'failed');
    assert.equal(surrCheck.reason, 'invalid_json');
    assert.match(authenticatedCheck(surrCheck).evidence.spec.detail ?? '', /surrogate/i);

    // 7. Deleting unallowed parent object /dependencies (when only /dependencies/@earendil-works~1pi-ai is allowed) fails closed
    const deletedParent = JSON.stringify({
      name: '@loopwright/demo',
      version: '1.0.0',
      devDependencies: { typescript: '5.6.0' },
      config: { 'a~b': 'old' },
    });
    const failedParentDel = await runGuard(deletedParent, 6);
    assert.equal(failedParentDel.accepted.result.spec.status, 'failed');
    const delRow = failedParentDel.accepted.verification.spec.required[0]!;
    assert.equal(delRow.status, 'failed');
    assert.match(delRow.findings?.[0]?.evidence ?? '', /"\/dependencies" was removed/);

    // 8. Root-level type change produces RFC 6901 root pointer "" (not "/")
    const rootReplaced = JSON.stringify('scalar-root');
    const failedRoot = await runGuard(rootReplaced, 7);
    assert.equal(failedRoot.accepted.result.spec.status, 'failed');
    const rootRow = failedRoot.accepted.verification.spec.required[0]!;
    assert.match(rootRow.findings?.[0]?.evidence ?? '', /JSON pointer "" was modified/);
  } finally {
    await f.close();
  }
});

test('json-keys-guard.v1 blocks parent object deletion, missing parent creation, and array resizing when only deeper child pointers are allowed', async () => {
  const installed = await installedHandlerDigests();
  const f = await retainedFixture(1, 10, 8, 60_000, fixture => {
    setFixture(fixture.registry, ['spec', 'roleProfiles', 0, 'tools'], ['read', 'write', 'edit', 'delete']);
    setFixture(fixture.config, ['spec', 'task', 'spec', 'roles', 0, 'tools'], ['read', 'write', 'edit', 'delete']);
    setFixture(fixture.registry, ['spec', 'handlers'], [
      ...fixture.registry.spec.handlers.filter(h => h.id !== 'tests'),
      {
        id: 'strict-guard',
        kind: 'check',
        implementation: 'json-keys-guard.v1',
        version: 1,
        digest: installed['json-keys-guard.v1'],
        parameters: {
          checkId: 'strict-guard',
          path: 'packages/strict.json',
          allowedPointers: ['/dependencies/pkgA', '/arr/0/x'],
        },
        capabilities: ['inert_bytes', 'read_only'],
      },
    ]);
    setFixture(fixture.config, ['spec', 'task', 'spec', 'acceptance'], {
      required: ['strict-guard'],
      checks: [{ id: 'strict-guard', allowedEvidenceLevels: ['local_execution'] }],
    });
  });

  try {
    const makeInv = async (content: string): Promise<ByteInventory> => {
      const bytes = Buffer.from(content, 'utf8');
      const r = digestArtifact('packages/strict.json', bytes);
      assert.equal(r.ok, true);
      if (!r.ok) throw new Error('bad artifact');
      const manifest: ArtifactManifest = { apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' }, spec: { entries: [r.value] } };
      const ref = await f.artifacts.json('manifest', manifest, 32_768);
      await retainInventoryInputs(f.artifacts, manifest, ref, [{ name: 'packages/strict.json', bytes }]);
      return { manifest, ref, files: [{ name: 'packages/strict.json', bytes }] };
    };

    const runCase = async (baseObj: unknown, candObj: unknown, generation: number) => {
      const source = await makeInv(JSON.stringify(baseObj));
      const candidate = await makeInv(JSON.stringify(candObj));
      const bound = bindSubject(f.lock, candidate.manifest);
      assert.equal(bound.ok, true);
      if (!bound.ok) throw new Error('bind failed');
      const verifier = new Verifier(f.store, f.authority, f.artifacts, f.plan, f.lock, () => bound.value);
      const slot = f.plan.verifierSlots.find(s => s.checkId === 'strict-guard')!;
      const prep = prepareVerification(f.plan, f.lock, slot.id, source, candidate, generation, `${(generation + 64).toString(16).padStart(32, '0')}`);
      return await verifier.run(prep, new AbortController().signal);
    };

    // 1. Deleting /dependencies when only /dependencies/pkgA is allowed -> failed
    const delParent = await runCase({ name: 'demo', dependencies: { pkgA: '1.0.0' } }, { name: 'demo' }, 0);
    assert.equal(delParent.status, 'failed');
    assert.equal(delParent.reason, 'disallowed_json_pointer');
    assert.match(authenticatedCheck(delParent).evidence.spec.findings?.[0]?.evidence ?? '', /"\/dependencies" was removed/);

    // 2. Creating missing parent /dependencies when only /dependencies/pkgA is allowed -> failed
    const createParent = await runCase({ name: 'demo' }, { name: 'demo', dependencies: { pkgA: '1.0.0' } }, 1);
    assert.equal(createParent.status, 'failed');
    assert.equal(createParent.reason, 'disallowed_json_pointer');
    assert.match(authenticatedCheck(createParent).evidence.spec.findings?.[0]?.evidence ?? '', /"\/dependencies" was added/);

    // 3. Resizing /arr ([] -> [{x:1}]) when only /arr/0/x is allowed -> failed
    const growArr = await runCase({ arr: [] }, { arr: [{ x: 1 }] }, 2);
    assert.equal(growArr.status, 'failed');
    assert.equal(growArr.reason, 'disallowed_json_pointer');
    assert.match(authenticatedCheck(growArr).evidence.spec.findings?.[0]?.evidence ?? '', /"\/arr\/0" was added/);

    // 4. Shrinking /arr ([{x:1}] -> []) when only /arr/0/x is allowed -> failed
    const shrinkArr = await runCase({ arr: [{ x: 1 }] }, { arr: [] }, 3);
    assert.equal(shrinkArr.status, 'failed');
    assert.equal(shrinkArr.reason, 'disallowed_json_pointer');
    assert.match(authenticatedCheck(shrinkArr).evidence.spec.findings?.[0]?.evidence ?? '', /"\/arr\/0" was removed/);

    // 5. Modifying /arr/0/x in place (without resizing /arr) -> passed
    const editArrInPlace = await runCase({ arr: [{ x: 1 }] }, { arr: [{ x: 2 }] }, 4);
    assert.equal(editArrInPlace.status, 'passed');
  } finally {
    await f.close();
  }
});

test('line-section-guard.v1 allows multi-line edits strictly inside markers (LF & CRLF) and fails closed on outside edits or unbalanced markers', async () => {
  const baseDoc = [
    '# Shared Config',
    'owner = platform',
    '// BEGIN GENERATED_DEPS',
    'dep_a = 1.0.0',
    '// END GENERATED_DEPS',
    'middle_immutable = true',
    '// BEGIN GENERATED_DEPS',
    'dep_b = 2.0.0',
    '// END GENERATED_DEPS',
    'footer = locked',
    '',
  ].join('\n');

  const installed = await installedHandlerDigests();
  const f = await retainedFixture(1, 10, 8, 60_000, fixture => {
    setFixture(fixture.registry, ['spec', 'roleProfiles', 0, 'tools'], ['read', 'write', 'edit', 'delete']);
    setFixture(fixture.config, ['spec', 'task', 'spec', 'roles', 0, 'tools'], ['read', 'write', 'edit', 'delete']);
    setFixture(fixture.registry, ['spec', 'handlers'], [
      ...fixture.registry.spec.handlers.filter(h => h.id !== 'tests'),
      {
        id: 'sec-guard',
        kind: 'check',
        implementation: 'line-section-guard.v1',
        version: 1,
        digest: installed['line-section-guard.v1'],
        parameters: {
          checkId: 'sec-guard',
          path: 'packages/shared.conf',
          startMarker: '// BEGIN GENERATED_DEPS',
          endMarker: '// END GENERATED_DEPS',
        },
        capabilities: ['inert_bytes', 'read_only'],
      },
    ]);
    setFixture(fixture.config, ['spec', 'task', 'spec', 'acceptance'], {
      required: ['sec-guard'],
      checks: [{ id: 'sec-guard', allowedEvidenceLevels: ['local_execution'] }],
    });
  });

  try {
    const makeInv = async (textVal: string): Promise<ByteInventory> => {
      const bytes = Buffer.from(textVal, 'utf8');
      const r = digestArtifact('packages/shared.conf', bytes);
      assert.equal(r.ok, true);
      if (!r.ok) throw new Error('bad artifact');
      const manifest: ArtifactManifest = { apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' }, spec: { entries: [r.value] } };
      const ref = await f.artifacts.json('manifest', manifest, 32_768);
      await retainInventoryInputs(f.artifacts, manifest, ref, [{ name: 'packages/shared.conf', bytes }]);
      return { manifest, ref, files: [{ name: 'packages/shared.conf', bytes }] };
    };

    const source = await makeInv(baseDoc);

    const runSection = async (candText: string, generation: number) => {
      const candidate = await makeInv(candText);
      const bound = bindSubject(f.lock, candidate.manifest);
      assert.equal(bound.ok, true);
      if (!bound.ok) throw new Error('bind failed');
      const verifier = new Verifier(f.store, f.authority, f.artifacts, f.plan, f.lock, () => bound.value);
      const checks = [];
      for (const [idx, slot] of f.plan.verifierSlots.entries()) {
        const prep = prepareVerification(f.plan, f.lock, slot.id, source, candidate, generation, `${(generation + 32).toString(16).padStart(16, '0')}${idx.toString(16).padStart(16, '0')}`);
        checks.push(await verifier.run(prep, new AbortController().signal));
      }
      const sub = normalizeSubmission(Buffer.from(JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null })), f.plan.task);
      const accepted = evaluateControllerAcceptance(f.plan, f.lock, candidate.manifest, candidate.files, generation, checks, sub, f.store);
      return { checks, accepted };
    };

    // 1. Multi-line expansion in section 1 (with CRLF inside markers) and shrink to empty in section 2 passes when outside EOLs stay intact
    const validExpanded = [
      '# Shared Config\n',
      'owner = platform\n',
      '// BEGIN GENERATED_DEPS\r\n',
      'dep_a = 1.1.0\r\n',
      'dep_a_extra_1 = true\r\n',
      'dep_a_extra_2 = true\r\n',
      '// END GENERATED_DEPS\r\n',
      'middle_immutable = true\n',
      '// BEGIN GENERATED_DEPS\n',
      '// END GENERATED_DEPS\n',
      'footer = locked\n',
    ].join('');
    const passRes = await runSection(validExpanded, 0);
    assert.equal(passRes.accepted.result.spec.status, 'completed');

    // 1b. Whole-file LF -> CRLF rewrite on immutable lines outside markers fails closed
    const eolRewritten = [
      '# Shared Config',
      'owner = platform',
      '// BEGIN GENERATED_DEPS',
      'dep_a = 1.1.0',
      '// END GENERATED_DEPS',
      'middle_immutable = true',
      '// BEGIN GENERATED_DEPS',
      'dep_b = 2.0.0',
      '// END GENERATED_DEPS',
      'footer = locked',
      '',
    ].join('\r\n');
    const eolFail = await runSection(eolRewritten, 5);
    assert.equal(eolFail.accepted.result.spec.status, 'failed');
    const eolRow = eolFail.accepted.verification.spec.required[0]!;
    assert.equal(eolRow.status, 'failed');
    assert.equal(eolRow.findings?.[0]?.line, 1);

    // 1c. CRLF baseline staying CRLF outside markers with inside edits passes
    const baseCrlf = baseDoc.replace(/\n/g, '\r\n');
    const sourceCrlf = await makeInv(baseCrlf);
    const candCrlf = await makeInv(baseCrlf.replace('dep_a = 1.0.0', 'dep_a = 1.2.0\r\ndep_extra = true'));
    const boundCrlf = bindSubject(f.lock, candCrlf.manifest);
    assert.equal(boundCrlf.ok, true);
    if (!boundCrlf.ok) throw new Error('bind failed');
    const verifierCrlf = new Verifier(f.store, f.authority, f.artifacts, f.plan, f.lock, () => boundCrlf.value);
    const secSlot = f.plan.verifierSlots.find(s => s.checkId === 'sec-guard')!;
    const prepCrlf = prepareVerification(f.plan, f.lock, secSlot.id, sourceCrlf, candCrlf, 6, 'b'.repeat(32));
    const crlfCheck = await verifierCrlf.run(prepCrlf, new AbortController().signal);
    assert.equal(crlfCheck.status, 'passed');

    // 2. Out-of-region edit after expanded section fails with exact finding line number
    const outsideEdited = [
      '# Shared Config',
      'owner = platform',
      '// BEGIN GENERATED_DEPS',
      'dep_a = 1.1.0',
      'dep_a_extra_1 = true',
      'dep_a_extra_2 = true',
      '// END GENERATED_DEPS',
      'middle_immutable = true',
      '// BEGIN GENERATED_DEPS',
      'dep_b = 2.0.0',
      '// END GENERATED_DEPS',
      'footer = TAMPERED',
      '',
    ].join('\n');
    const outFail = await runSection(outsideEdited, 1);
    assert.equal(outFail.accepted.result.spec.status, 'failed');
    const outRow = outFail.accepted.verification.spec.required[0]!;
    assert.equal(outRow.status, 'failed');
    assert.equal(outRow.findings?.[0]?.path, 'packages/shared.conf');
    assert.equal(outRow.findings?.[0]?.line, 12);

    // 3. Missing markers fails closed
    const missingMarkers = await runSection('# Shared Config\nowner = platform\n', 2);
    assert.equal(missingMarkers.checks.find(c => c.checkId === 'sec-guard')?.reason, 'missing_markers');

    // 4. Nested / unbalanced markers fail closed
    const nestedMarkers = [
      '# Shared Config',
      '// BEGIN GENERATED_DEPS',
      '// BEGIN GENERATED_DEPS',
      '// END GENERATED_DEPS',
    ].join('\n');
    const nestedFail = await runSection(nestedMarkers, 3);
    assert.equal(nestedFail.checks.find(c => c.checkId === 'sec-guard')?.reason, 'unbalanced_markers');

    const unclosedFail = await runSection('# Shared Config\n// BEGIN GENERATED_DEPS\ndep_a = 1\n', 4);
    assert.equal(unclosedFail.checks.find(c => c.checkId === 'sec-guard')?.reason, 'unbalanced_markers');
  } finally {
    await f.close();
  }
});

test('wide 512-file / 16-MiB tree_overlay passes json-artifact.v1, scope.v1, guards, and acceptance without HEADER_BYTES overflow while default runs enforce 128 / 4-MiB', async () => {
  const cfg = await configurationFixture();
  try {
    const repoDir = join(cfg.root, 'repo');
    const baseFiles: Record<string, string> = {
      'packages/result.json': JSON.stringify({ ok: true, rev: 1 }),
      'packages/pkg.json': JSON.stringify({ name: 'demo', dependencies: { '@earendil-works/pi-ai': '1.0.0', keep: '1.0.0' } }),
      'packages/README.md': 'Header\n<!-- START -->\nold\n<!-- END -->\nFooter\n',
    };
    for (let i = 0; i < 140; i++) {
      baseFiles[`baseline/file-${String(i).padStart(3, '0')}.txt`] = `baseline-${i}\n`;
    }
    const rev = await initGitRepo(repoDir, baseFiles);
    const installed = await installedHandlerDigests();

    setFixture(cfg.registry, ['spec', 'roleProfiles', 0, 'tools'], ['read', 'write', 'edit']);
    setFixture(cfg.registry, ['spec', 'handlers'], [
      { id: 'author.h', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Update 512 files.', purpose: 'task' }, capabilities: ['pi'] },
      { id: 'tests', kind: 'check', implementation: 'json-artifact.v1', version: 1, digest: installed['json-artifact.v1'], parameters: { checkId: 'tests', path: 'packages/result.json', required: ['ok'], equals: { ok: true } }, capabilities: ['inert_bytes', 'read_only'] },
      { id: 'pkg-keys', kind: 'check', implementation: 'json-keys-guard.v1', version: 1, digest: installed['json-keys-guard.v1'], parameters: { checkId: 'pkg-keys', path: 'packages/pkg.json', allowedPointers: ['/dependencies/@earendil-works~1pi-ai'] }, capabilities: ['inert_bytes', 'read_only'] },
      { id: 'readme-sec', kind: 'check', implementation: 'line-section-guard.v1', version: 1, digest: installed['line-section-guard.v1'], parameters: { checkId: 'readme-sec', path: 'packages/README.md', startMarker: '<!-- START -->', endMarker: '<!-- END -->' }, capabilities: ['inert_bytes', 'read_only'] },
      ...cfg.registry.spec.handlers.filter(h => h.id === 'scope' || h.id === 'no-change'),
    ]);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], rev);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], rev);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'target', 'matrix'], [{ id: 'sm90', platform: 'linux-x86_64', variant: 'h100' }]);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'scope'], { writable: ['packages/**'], protected: [] });
    setFixture(cfg.config, ['spec', 'task', 'spec', 'budgets', 'overlay'], { maxFiles: 512, maxBytes: 16_777_216 });
    setFixture(cfg.config, ['spec', 'task', 'spec', 'budgets', 'maxImplementationRepairs'], 18);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'budgets', 'maxModelCalls'], 32);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'roles', 0, 'tools'], ['read', 'write', 'edit']);
    setFixture(cfg.config, ['spec', 'controls', 'maxAttempts'], 18);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'acceptance'], {
      required: ['tests', 'pkg-keys', 'readme-sec'],
      checks: [
        { id: 'tests', allowedEvidenceLevels: ['local_execution'] },
        { id: 'pkg-keys', allowedEvidenceLevels: ['local_execution'] },
        { id: 'readme-sec', allowedEvidenceLevels: ['local_execution'] },
      ],
    });
    setFixture(cfg.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'build', kind: 'agent', uses: 'author.h', roleId: 'builder', dependsOn: [] },
    ]);
    setFixture(cfg.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'build', handlerRef: 'author.h' },
    ]);
    cfg.input.untrustedRoots = [cfg.taskDirectory, repoDir];
    await cfg.save();
    const loadedRes = await cfg.load();
    assert.equal(loadedRes.ok, true, JSON.stringify(loadedRes));
    if (!loadedRes.ok) return;

    // Build a 512-file / >6-MiB overlay directly through freezeSource -> Verifier -> evaluateControllerAcceptance
    const { compilePlan } = await import('../src/compile.js');
    const { ControllerOwner } = await import('../src/ownership.js');
    const { ArtifactStore } = await import('../src/storage.js');
    const { approvedState } = await import('../src/config.js');
    const { freezeSource, overlayManifestBounds } = await import('../src/source.js');
    const { createLocalRun } = await import('@loopwright/state');

    const planRes = await compilePlan(loadedRes.value);
    assert.equal(planRes.ok, true);
    if (!planRes.ok) return;
    const plan = planRes.value;
    const widePlan = plan;
    const lockRes = admitTask(plan.task, { admissionId: 'adm-wide', runId: 'run-wide' });
    assert.equal(lockRes.ok, true);
    if (!lockRes.ok) return;
    const lock = lockRes.value;
    assert.notEqual(lock.spec.contract.spec.target.matrix, null);

    const runDir = join(cfg.root, 'run-wide');
    await mkdir(join(runDir, 'artifacts'), { recursive: true, mode: 0o700 });
    const owner = await ControllerOwner.acquire(runDir, 'run-wide', widePlan.planDigest);
    const artifacts = new ArtifactStore(join(runDir, 'artifacts'), owner, approvedState(loadedRes.value).vault);
    const store = stateValue(
      createLocalRun({
        directory: join(runDir, 'state'),
        storeId: 'store.wide',
        lock,
        policy: { version: 1, leaseMs: 60_000, cost: 'observe_only' },
        binding: { coreApiVersion: 'loopwright.dev/v1alpha1', hostVersion: 'test', adapters: [{ id: 'pi', version: '0.0.0' }], resourceVersion: plan.task.spec.trustedContext.revision, clockEpoch: 'boot.1' },
      }),
    );
    const cur = stateValue(store.inspect());
    const authority = stateValue(store.claim({ ownerId: 'controller.' + owner.nonce, expectedGeneration: cur.owner.generation, expectedRevision: cur.revision, mode: 'active' })).authority;

    try {
      const frozen = await freezeSource(repoDir, plan.task, owner, artifacts, ['packages/result.json', 'packages/pkg.json', 'packages/README.md']);
      assert.equal(frozen.version, 2);
      const bounds = overlayManifestBounds(plan.budgets.overlay);
      const srcRef = await artifacts.json('manifest', frozen.manifest, bounds.manifestMaxBytes);
      const sourceInv: ByteInventory = { manifest: frozen.manifest, ref: srcRef, files: [], baselineProofs: frozen.baselineProofs };

      // Build 512 overlay files totaling ~6.2 MiB (> 128 files and > 4 MiB default!)
      const overlayFiles: { name: string; bytes: Uint8Array }[] = [
        { name: 'packages/README.md', bytes: Buffer.from('Header\n<!-- START -->\nupdated 1\nupdated 2\n<!-- END -->\nFooter\n', 'utf8') },
        { name: 'packages/pkg.json', bytes: Buffer.from(JSON.stringify({ name: 'demo', dependencies: { '@earendil-works/pi-ai': '2.0.0', keep: '1.0.0' } }), 'utf8') },
        { name: 'packages/result.json', bytes: Buffer.from(JSON.stringify({ ok: true, rev: 2 }), 'utf8') },
      ];
      const chunkPayload = Buffer.alloc(12_288, 0x61); // 12 KiB * 509 = ~6.1 MiB
      for (let i = 0; i < 509; i++) {
        overlayFiles.push({ name: `packages/gen/item-${String(i).padStart(3, '0')}.txt`, bytes: chunkPayload });
      }
      assert.equal(overlayFiles.length, 512);
      overlayFiles.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const entries: ArtifactRef[] = overlayFiles.map(fItem => {
        const d = digestArtifact(fItem.name, fItem.bytes);
        assert.equal(d.ok, true);
        if (!d.ok) throw new Error('digest failed');
        return d.value;
      });
      const identified = identifyManifest(
        canonicalizeCandidateManifest({
          apiVersion: 'loopwright.dev/v1alpha1',
          kind: 'ArtifactManifest',
          metadata: { id: 'candidate' },
          spec: { baseTree: frozen.manifest.spec.baseTree!, entries, deleted: [] },
        }),
        bounds.options,
      );
      assert.equal(identified.ok, true);
      if (!identified.ok) return;
      const candManifest = identified.value.manifest;
      assert.ok(Buffer.byteLength(canonical(candManifest)) > 32_768);
      const candRef = await artifacts.json('manifest', candManifest, bounds.manifestMaxBytes);
      const candInv: ByteInventory = { manifest: candManifest, ref: candRef, files: overlayFiles };

      const bound = bindSubject(lock, candManifest, bounds.options);
      assert.equal(bound.ok, true);
      if (!bound.ok) return;
      assert.notEqual(bound.value.targetMatrixDigest, null);

      // Verify checkedRefusalSubject accepts non-null targetMatrixDigest matching target.matrix and rejects forged digest
      assert.deepEqual(checkedRefusalSubject(bound.value, lock), bound.value);
      assert.throws(() => checkedRefusalSubject({ ...bound.value, targetMatrixDigest: null }, lock));
      assert.throws(() => checkedRefusalSubject({ ...bound.value, targetMatrixDigest: hash('forged-matrix') }, lock));

      // Run all 5 verifiers at rework generation = 17 (> 16!) and verify restore() parity
      const verifier = new Verifier(store, authority, artifacts, widePlan, lock, () => bound.value);
      const verifiedChecks = [];
      for (const [idx, slot] of widePlan.verifierSlots.entries()) {
        const pre = preflightVerification(widePlan, lock, slot.id, sourceInv, candInv, 17, `${idx.toString(16).padStart(32, '0')}`);
        assert.equal(pre.kind, 'ready', `slot ${slot.id} preflight must be ready`);
        if (pre.kind !== 'ready') return;
        const ran = await verifier.run(pre.job, new AbortController().signal);
        if (slot.implicit === 'no_change') {
          assert.equal(ran.status, 'failed');
        } else {
          assert.equal(ran.status, 'passed', `slot ${slot.id} should pass`);
        }
        const restored = await verifier.restore(pre.job);
        assert.equal(canonical(restored), canonical(ran));
        verifiedChecks.push(ran);
      }

      const sub = normalizeSubmission(Buffer.from(JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null })), plan.task);
      const accepted = evaluateControllerAcceptance(widePlan, lock, candManifest, candInv.files, 17, verifiedChecks, sub, store);
      assert.equal(accepted.result.spec.status, 'completed');
      assert.equal(accepted.verification.spec.satisfied, true);

      // Default contract (without budgets.overlay) still strictly refuses >128 overlay entries and >32768 manifest bytes
      const defaultTask = contract();
      const defaultLockRes = admitTask(defaultTask, { admissionId: 'adm-def', runId: 'run-def' });
      assert.equal(defaultLockRes.ok, true);
      assert.throws(() => descriptor(candManifest, candRef));
      assert.throws(() => encodeInventory(candManifest));

      // checkedHeader accepts generation up to 256 and rejects 257
      const sampleHeader: VerifierHeader = {
        version: 1,
        jobId: 'job.test',
        handler: 'no-change.v1',
        handlerVersion: 1,
        handlerDigest: installed['no-change.v1'],
        checkId: 'controller.no-change',
        producerNonce: 'f'.repeat(32),
        operationId: 'verify.test',
        dispatchId: 'dispatch.test',
        generation: 256,
        subject: bound.value,
        source: descriptor(frozen.manifest, srcRef, plan.budgets.overlay),
        candidate: descriptor(candManifest, candRef, plan.budgets.overlay),
        parameters: {},
        payloadKind: 'inventories',
        overlay: plan.budgets.overlay!,
      };
      assert.equal(checkedHeader(sampleHeader).generation, 256);
      assert.throws(() => checkedHeader({ ...sampleHeader, generation: 257 }));
      const wideInvPayload = new Uint8Array(
        encodeInventory(frozen.manifest, plan.budgets.overlay).byteLength + encodeInventory(candManifest, plan.budgets.overlay).byteLength,
      );
      const encSrc = encodeInventory(frozen.manifest, plan.budgets.overlay);
      const encCand = encodeInventory(candManifest, plan.budgets.overlay);
      wideInvPayload.set(encSrc, 0);
      wideInvPayload.set(encCand, encSrc.byteLength);
      const widePacket = encodePacket(sampleHeader, wideInvPayload);
      const evalReply = evaluatePacket(widePacket);
      assert.equal(evalReply.status, 'failed');
      assert.equal(evalReply.reason, 'candidate_changed');
      assert.equal(evalReply.generation, 256);
    } finally {
      stateValue(store.release(authority));
      stateValue(store.close());
      await owner.release();
    }
  } finally {
    await cfg.cleanup();
  }
});

test('runCycleWithPorts and stepNext/stepSubmit resolve baseline Merkle proofs for json-keys-guard.v1 and line-section-guard.v1 on >128-file tree_overlay repos', async () => {
  const cfg = await configurationFixture();
  try {
    const repoDir = join(cfg.root, 'repo-e2e');
    const baseFiles: Record<string, string> = {
      'packages/pkg.json': JSON.stringify({ name: 'sync-target', version: '1.0.0', dependencies: { '@earendil-works/pi-ai': '0.5.0' } }),
      'packages/notes.md': '# Notes\n<!-- AUTO -->\nv0.5.0\n<!-- /AUTO -->\nEnd\n',
    };
    for (let i = 0; i < 135; i++) baseFiles[`lib/mod-${String(i).padStart(3, '0')}.ts`] = `export const x${i} = ${i};\n`;
    const rev = await initGitRepo(repoDir, baseFiles);
    const installed = await installedHandlerDigests();

    setFixture(cfg.registry, ['spec', 'roleProfiles'], [
      {
        id: 'builder',
        adapter: 'delegated',
        selection: { provider: 'claude-code', model: 'claude-sonnet-4-6', thinking: 'high' },
        tools: ['read', 'write', 'edit'],
        runtimeRef: null,
        providerCredentialRef: null,
        mcp: null,
      },
    ]);
    setFixture(cfg.registry, ['spec', 'credentialBindings'], []);
    setFixture(cfg.registry, ['spec', 'environmentBindings'], []);
    setFixture(cfg.registry, ['spec', 'handlers'], [
      { id: 'author.h', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Sync upstream.', purpose: 'task' }, capabilities: ['pi'] },
      { id: 'pkg-keys', kind: 'check', implementation: 'json-keys-guard.v1', version: 1, digest: installed['json-keys-guard.v1'], parameters: { checkId: 'pkg-keys', path: 'packages/pkg.json', allowedPointers: ['/dependencies/@earendil-works~1pi-ai'] }, capabilities: ['inert_bytes', 'read_only'] },
      { id: 'notes-sec', kind: 'check', implementation: 'line-section-guard.v1', version: 1, digest: installed['line-section-guard.v1'], parameters: { checkId: 'notes-sec', path: 'packages/notes.md', startMarker: '<!-- AUTO -->', endMarker: '<!-- /AUTO -->' }, capabilities: ['inert_bytes', 'read_only'] },
      ...cfg.registry.spec.handlers.filter(h => h.id === 'scope' || h.id === 'no-change'),
    ]);
    setFixture(cfg.config, ['spec', 'credentials'], []);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], rev);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], rev);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'scope'], { writable: ['packages/**'], protected: [] });
    setFixture(cfg.config, ['spec', 'task', 'spec', 'roles'], [
      { id: 'builder', adapter: 'delegated', provider: 'claude-code', model: 'claude-sonnet-4-6', thinking: 'high', tools: ['read', 'write', 'edit'] },
    ]);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'budgets', 'maxImplementationRepairs'], 0);
    setFixture(cfg.config, ['spec', 'controls', 'maxAttempts'], 1);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'acceptance'], {
      required: ['pkg-keys', 'notes-sec'],
      checks: [
        { id: 'pkg-keys', allowedEvidenceLevels: ['local_execution'] },
        { id: 'notes-sec', allowedEvidenceLevels: ['local_execution'] },
      ],
    });
    cfg.input.untrustedRoots = [cfg.taskDirectory, repoDir];

    // 1. Check-only runCycleWithPorts on >128-file tree_overlay repo
    setFixture(cfg.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'check-keys', kind: 'check', uses: 'pkg-keys', roleId: null, dependsOn: [] },
      { id: 'check-sec', kind: 'check', uses: 'notes-sec', roleId: null, dependsOn: ['check-keys'] },
    ]);
    setFixture(cfg.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'check-keys', handlerRef: 'pkg-keys' },
      { stepId: 'check-sec', handlerRef: 'notes-sec' },
    ]);
    await cfg.save();
    const loadedCheckOnly = await cfg.load();
    assert.equal(loadedCheckOnly.ok, true);
    if (!loadedCheckOnly.ok) return;

    const res = await runCycleWithPorts({
      configuration: loadedCheckOnly.value,
      repository: repoDir,
      runRoot: join(cfg.root, 'runs'),
      runId: 'run-guards-tree-overlay',
    });
    assert.equal(res.ok, true, JSON.stringify(res));
    if (!res.ok || res.value.kind !== 'result') {
      assert.fail('expected result');
    }
    assert.equal(res.value.result.spec.status, 'completed');
    assert.deepEqual(
      res.value.result.spec.verification.spec.required.map(r => [r.checkId, r.status]),
      [['pkg-keys', 'passed'], ['notes-sec', 'passed']],
    );

    // 2. Delegated role stepNext/stepSubmit editing overlay files in-pointer + in-section -> completed
    setFixture(cfg.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'sync', kind: 'agent', uses: 'author.h', roleId: 'builder', dependsOn: [] },
    ]);
    setFixture(cfg.config, ['spec', 'profiles', 'steps'], [{ stepId: 'sync', handlerRef: 'author.h' }]);
    await cfg.save();
    const loadedDelegated = await cfg.load();
    assert.equal(loadedDelegated.ok, true, JSON.stringify(loadedDelegated));
    if (!loadedDelegated.ok) return;

    const runRoot = join(cfg.root, 'runs');
    const yieldPass = await stepNext({ configuration: loadedDelegated.value, repository: repoDir, runRoot, runId: 'run-step-pass' });
    assert.equal(yieldPass.ok, true, JSON.stringify(yieldPass));
    if (!yieldPass.ok || yieldPass.value.kind !== 'step') {
      assert.fail('expected step yield');
    }
    await chmod(join(yieldPass.value.candidateDir, 'packages/pkg.json'), 0o600);
    await writeFile(
      join(yieldPass.value.candidateDir, 'packages/pkg.json'),
      JSON.stringify({ name: 'sync-target', version: '1.0.0', dependencies: { '@earendil-works/pi-ai': '0.6.0' } }),
      { mode: 0o600 },
    );
    await chmod(join(yieldPass.value.candidateDir, 'packages/notes.md'), 0o600);
    await writeFile(
      join(yieldPass.value.candidateDir, 'packages/notes.md'),
      '# Notes\n<!-- AUTO -->\nv0.6.0\nupdated cleanly\n<!-- /AUTO -->\nEnd\n',
      { mode: 0o600 },
    );
    const subPass = await stepSubmit({ runRoot, runId: 'run-step-pass', leaseToken: yieldPass.value.leaseToken, status: 'completed' });
    assert.equal(subPass.ok, true, JSON.stringify(subPass));
    const finPass = await stepNext({ runRoot, runId: 'run-step-pass' });
    assert.equal(finPass.ok, true, JSON.stringify(finPass));
    if (!finPass.ok || finPass.value.kind !== 'result') {
      assert.fail('expected completed result');
    }
    assert.equal(finPass.value.result.spec.status, 'completed');

    // 3. Delegated role stepNext/stepSubmit editing out-of-pointer JSON + out-of-section line -> failed with findings
    const yieldFail = await stepNext({ configuration: loadedDelegated.value, repository: repoDir, runRoot, runId: 'run-step-fail' });
    assert.equal(yieldFail.ok, true);
    if (!yieldFail.ok || yieldFail.value.kind !== 'step') {
      assert.fail('expected step yield');
    }
    await chmod(join(yieldFail.value.candidateDir, 'packages/pkg.json'), 0o600);
    await writeFile(
      join(yieldFail.value.candidateDir, 'packages/pkg.json'),
      JSON.stringify({ name: 'sync-target', version: '9.9.9', dependencies: { '@earendil-works/pi-ai': '0.6.0' } }),
      { mode: 0o600 },
    );
    await chmod(join(yieldFail.value.candidateDir, 'packages/notes.md'), 0o600);
    await writeFile(
      join(yieldFail.value.candidateDir, 'packages/notes.md'),
      '# Notes\n<!-- AUTO -->\nv0.6.0\n<!-- /AUTO -->\nTAMPERED_END\n',
      { mode: 0o600 },
    );
    const subFail = await stepSubmit({ runRoot, runId: 'run-step-fail', leaseToken: yieldFail.value.leaseToken, status: 'completed' });
    assert.equal(subFail.ok, true);
    const finFail = await stepNext({ runRoot, runId: 'run-step-fail' });
    assert.equal(finFail.ok, true, JSON.stringify(finFail));
    if (!finFail.ok || finFail.value.kind !== 'result') {
      assert.fail('expected failed result');
    }
    assert.equal(finFail.value.result.spec.status, 'failed');
    const reqById = new Map(finFail.value.result.spec.verification.spec.required.map(r => [r.checkId, r]));
    assert.equal(reqById.get('pkg-keys')?.status, 'failed');
    assert.match(reqById.get('pkg-keys')?.findings?.[0]?.evidence ?? '', /\/version/);
    assert.equal(reqById.get('notes-sec')?.status, 'failed');
    assert.equal(reqById.get('notes-sec')?.findings?.[0]?.line, 5);
  } finally {
    await cfg.cleanup();
  }
});

test('wide-overlay bounds align across source.ts & verifier-protocol.ts, handle 512 entries+deleted with URIs, and route inventory overflow to VerifierSizingFailure', async () => {
  // 1. Bounds alignment across source.ts and verifier-protocol.ts at 512, 4096, and 16384 maxFiles
  for (const maxFiles of [128, 512, 4096, 16_384] as const) {
    const overlay = { maxFiles, maxBytes: 67_108_864 };
    const srcBounds = overlayManifestBounds(overlay);
    const protoBounds = overlayProtocolBounds(overlay);
    assert.equal(srcBounds.manifestMaxBytes, protoBounds.manifestMaxBytes, `manifestMaxBytes aligned at ${maxFiles}`);
    assert.ok(protoBounds.inventoryMaxBytes >= protoBounds.manifestMaxBytes, `inventoryMaxBytes >= manifestMaxBytes at ${maxFiles}`);
  }
  const maxBounds = overlayProtocolBounds({ maxFiles: 16_384, maxBytes: 67_108_864 });
  assert.ok(
    maxBounds.allocationMaxBytes > 167_772_160 + 2 * maxBounds.manifestMaxBytes,
    `allocationMaxBytes (${maxBounds.allocationMaxBytes}) must exceed MAX_ABSOLUTE_PACKET_BYTES + 2*manifestMaxBytes`,
  );

  // 2. Worst-case 512 entries (with ArtifactRef.uri) + 512 deleted paths (>1 MiB canonical JSON, >900 KiB binary inventory)
  const overlay512 = { maxFiles: 512, maxBytes: 16_777_216 };
  const bounds512 = overlayManifestBounds(overlay512);
  const baseTree = { commitOid: 'a'.repeat(40), treeOid: 'b'.repeat(40), objectFormat: 'sha1' as const };
  const entries: ArtifactRef[] = [];
  const deleted: string[] = [];
  for (let i = 0; i < 512; i++) {
    const name = `packages/deep/segment/alpha/file-${String(i).padStart(4, '0')}.txt`;
    const d = digestArtifact(name, Buffer.from(`v-${i}`));
    assert.equal(d.ok, true);
    if (!d.ok) throw new Error('digest');
    entries.push({
      ...d.value,
      uri: `https://artifacts.example.internal/runs/wide/item-${String(i).padStart(4, '0')}/${'u'.repeat(1600)}`,
      mediaType: 'text/plain',
    });
    deleted.push(`packages/legacy/old/path/removed-${String(i).padStart(4, '0')}/${'d'.repeat(180)}.txt`);
  }
  const wideManifestRes = identifyManifest(
    canonicalizeCandidateManifest({
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'ArtifactManifest',
      metadata: { id: 'candidate' },
      spec: { baseTree, entries, deleted },
    }),
    bounds512.options,
  );
  assert.equal(wideManifestRes.ok, true);
  if (!wideManifestRes.ok) return;
  const wideManifest = wideManifestRes.value.manifest;
  const wideCanonical = canonical(wideManifest);
  assert.ok(Buffer.byteLength(wideCanonical) > 1_000_000, 'manifest exceeds 1 MiB JSON');
  assert.ok(Buffer.byteLength(wideCanonical) <= bounds512.manifestMaxBytes);
  const encodedWide = encodeInventory(wideManifest, overlay512);
  assert.ok(encodedWide.byteLength > 850_000, 'binary inventory exceeds old 837 KiB cap');

  // 3. Inventory byte overflow routes cleanly through VerifierSizingFailure({ reason: 'inventory_bytes' }) and passes checkedRefusalRecord
  const f = await retainedFixture();
  try {
    const installed = await installedHandlerDigests();
    const emptyManifest: ArtifactManifest = { apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' }, spec: { entries: [] } };
    const emptyRef = await f.artifacts.json('manifest', emptyManifest, 32_768);
    const bound = bindSubject(f.lock, emptyManifest);
    assert.equal(bound.ok, true);
    if (!bound.ok) return;
    const slot = f.plan.verifierSlots.find(s => s.handler.implementation === 'no-change.v1')!;
    const sampleHeader: VerifierHeader = {
      version: 1,
      jobId: 'job.inv-overflow',
      handler: 'no-change.v1',
      handlerVersion: 1,
      handlerDigest: installed['no-change.v1'],
      checkId: slot.checkId,
      producerNonce: 'e'.repeat(32),
      operationId: 'verify.inv-overflow',
      dispatchId: 'unbound',
      generation: 0,
      subject: bound.value,
      source: descriptor(emptyManifest, emptyRef),
      candidate: descriptor(emptyManifest, emptyRef),
      parameters: {},
      payloadKind: 'inventories',
    };
    let caught: unknown;
    try {
      sizeJob(sampleHeader, 40_000, null, undefined, { firstBytes: 33_000, secondBytes: 7_000 });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof VerifierSizingFailure);
    assert.equal(caught.sizing.reason, 'inventory_bytes');
    assert.equal(caught.sizing.actual, 33_000);
    assert.equal(caught.sizing.allowed, 32_772);
    const row = {
      slot: slot.id,
      generation: 0,
      prospectiveOperationId: 'verify.inv-overflow',
      producerNonce: 'e'.repeat(32),
      subject: bound.value,
      record: emptyRef,
    };
    const refusalDoc = {
      version: 1 as const,
      kind: 'controller_preflight_refusal' as const,
      planDigest: f.plan.planDigest,
      handlerDigest: slot.handler.digest,
      slotId: slot.id,
      checkId: slot.checkId,
      generation: 0,
      prospectiveOperationId: 'verify.inv-overflow',
      producerNonce: 'e'.repeat(32),
      subject: bound.value,
      source: descriptor(emptyManifest, emptyRef),
      candidate: descriptor(emptyManifest, emptyRef),
      code: 'OUTPUT_LIMIT' as const,
      limits: caught.sizing,
    };
    assert.equal(checkedRefusalRecord(refusalDoc, f.plan, f.lock, row).limits.reason, 'inventory_bytes');
  } finally {
    await f.close();
  }
});
