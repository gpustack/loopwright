import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rm, symlink, truncate, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import {
  bindSubject,
  digestArtifact,
  digestArtifactFromMetadata,
  type ArtifactManifest,
  type ArtifactRef,
} from '@loopwright/core';
import { reopenLocalRun } from '@loopwright/state';
import type { PiAdapterV2, PiHostV2, PiOpenInputV2 } from '@loopwright/agent-pi';
import {
  inspectRun,
  installedHandlerDigests,
  parseCasUri,
  reconcileCycle,
  resolveCanonicalCasBlobPath,
  resumeCycleWithPorts,
  runCycleWithPorts,
  signGateVerdict,
  signPayload,
  stepNext,
  stepSubmit,
  streamVerifiedCasBlob,
  verifySignedPayload,
  type ControllerPolicyProfile,
  type PersistedHostPolicy,
  type StepTickResult,
  type StepYield,
} from '../src/index.js';
import { PublicBundle } from '../src/bundle.js';
import { createCycle, Cycle } from '../src/controller.js';
import { decodeDelegatedWorkspace, type DelegatedCapturePayloadV1 } from '../src/capture.js';
import { prepareGate } from '../src/gate.js';
import { phaseCheckpointId, ProgressStore } from '../src/progress.js';
import { readRetained } from '../src/retained.js';
import { canonical, hash } from '../src/schema.js';
import { stateValue } from '../src/storage.js';
import { configurationFixture } from './config-fixtures.js';
import { setFixture } from './progress-fixtures.js';

const GIT_ENV = {
  PATH: '/usr/bin:/bin',
  LANG: 'C',
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  HOME: '/nonexistent',
  GIT_TERMINAL_PROMPT: '0',
};

function assertOk<T>(res: { readonly ok: boolean; readonly value?: T; readonly error?: unknown }, msg = ''): T {
  assert.equal(res.ok, true, `${msg}: ${JSON.stringify(res.error)}`);
  return res.value as T;
}

function assertStepYield(tick: StepTickResult, msg = ''): StepYield {
  assert.equal(tick.kind, 'step', `${msg}: expected step yield, got ${JSON.stringify(tick)}`);
  if (tick.kind !== 'step') throw new Error('expected step');
  return tick;
}

async function createFastGitRepo(
  directory: string,
  files: Readonly<Record<string, { readonly content: Buffer | string; readonly mode?: '100644' | '100755' }>>,
): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [rel, spec] of Object.entries(files)) {
    const abs = join(directory, rel);
    await mkdir(dirname(abs), { recursive: true, mode: 0o700 });
    const mode = spec.mode === '100755' ? 0o700 : 0o600;
    await writeFile(abs, spec.content, { mode });
    if (spec.mode === '100755') await chmod(abs, 0o700);
  }
  const git = (args: string[]) =>
    execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: directory,
      env: GIT_ENV,
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'utf8',
    });
  git(['init', '-q']);
  git(['add', '.']);
  git(['-c', 'user.name=Controller V2 Test', '-c', 'user.email=test@localhost.invalid', 'commit', '-qm', 'baseline']);
  return git(['rev-parse', 'HEAD']).trim();
}

test('PublicBundle scales entry limit to 32 MiB and total bundle to 64 MiB for 16,384-entry v2 candidate.files.json', () => {
  const bundle = new PublicBundle('run-scale', hash('lock'));
  const files = Array.from({ length: 16_384 }, (_, idx) => {
    const sha256 = hash(`entry-${idx}`).hex;
    return {
      name: `packages/mod-${String(idx).padStart(5, '0')}/artifact-${String(idx).padStart(5, '0')}.bin`,
      mode: '100644' as const,
      sha256,
      byteLength: 1024 + idx,
      uri: `cas://sha256/${sha256}`,
      blobPath: `/private/runs/run-scale/artifacts/blobs/sha256/${sha256}`,
    };
  });
  bundle.json('candidate.files.json', {
    version: 2,
    manifest: { apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' }, spec: { entries: [] } },
    files,
  });
  // > 16 MiB up to 32 MiB entry is accepted; 32 MiB + 1 byte is refused; > 64 MiB aggregate is refused
  bundle.add('twenty-mib.bin', new Uint8Array(20 * 1024 * 1024));
  assert.throws(() => bundle.add('too-large.bin', new Uint8Array(33_554_433)));
  bundle.add('thirty-mib.bin', new Uint8Array(30 * 1024 * 1024));
  assert.throws(() => bundle.add('overflow-total.bin', new Uint8Array(20 * 1024 * 1024)));
});

test('CAS-backed >1 MiB JSON target triggers pure preflightSizing refusal without reading file, and >1 MiB submission.path refuses SUBMISSION_INVALID', async () => {
  const { retainedFixture } = await import('./progress-fixtures.js');
  const { preflightVerification } = await import('../src/verification.js');
  const { retainSubmission } = await import('../src/submission.js');
  const f = await retainedFixture();
  try {
    const fakeOversizeSha = hash('oversize-2mib-virtual').hex;
    const oversizeRefRes = digestArtifactFromMetadata('result.json', {
      digest: { algorithm: 'sha256', hex: fakeOversizeSha },
      byteLength: 2 * 1024 * 1024,
    });
    assert.ok(oversizeRefRes.ok);
    if (!oversizeRefRes.ok) return;
    const manifest: ArtifactManifest = {
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'ArtifactManifest',
      metadata: { id: 'candidate' },
      spec: { entries: [oversizeRefRes.value] },
    };
    const manifestRef = await f.artifacts.json('manifest', manifest, 32_768);
    // Notice blobPath does not even exist on disk — neither scope.v1/no-change.v1 nor oversize json-artifact.v1 may read it!
    const casEntry = {
      name: 'result.json',
      byteLength: 2 * 1024 * 1024,
      digest: { algorithm: 'sha256' as const, hex: fakeOversizeSha },
      blobPath: join(f.artifacts.directory, 'blobs', 'sha256', fakeOversizeSha),
    };
    const inv = { manifest, ref: manifestRef, files: [casEntry] };
    // scope.v1 and no-change.v1 perform ZERO file reads
    for (const slot of f.plan.verifierSlots.filter(s => s.handler.implementation === 'scope.v1' || s.handler.implementation === 'no-change.v1')) {
      const prep = preflightVerification(f.plan, f.lock, slot.id, inv, inv, 0, 'a'.repeat(32));
      assert.equal(prep.kind, 'ready');
    }
    // json-artifact.v1 > JSON_FILE_BYTES refuses cleanly via sizeJob without reading blobPath!
    const jsonSlot = f.plan.verifierSlots.find(s => s.handler.implementation === 'json-artifact.v1')!;
    const sized = preflightVerification(f.plan, f.lock, jsonSlot.id, inv, inv, 0, 'b'.repeat(32));
    assert.equal(sized.kind, 'refused');

    // retainSubmission refuses > 1 MiB CAS submission.path immediately with SUBMISSION_INVALID without reading blobPath!
    await assert.rejects(
      retainSubmission(
        {
          checkpointId: 'cp-1',
          outcome: manifestRef,
          originalManifest: manifestRef,
          manifest: manifestRef,
          digest: hash('m'),
          workspace: manifestRef,
          session: null,
          submission: null,
          artifacts: [casEntry],
        },
        { mode: 'artifact_or_assistant', path: 'result.json' },
        f.plan.task,
        f.artifacts,
      ),
      /SUBMISSION_INVALID/,
    );
  } finally {
    await f.close();
  }
});

test('step delegated-capture.v2 streams >64 MiB file and >128 MiB overlay with zero CAS writes on unchanged baseline, settles completed RunResult, and exports candidate.files.json v2', async () => {
  const f = await configurationFixture();
  try {
    const repository = join(f.root, 'repository');
    const runRoot = join(f.root, 'runs');
    const unchangedBaseline = Buffer.alloc(4 * 1024 * 1024, 0x41);
    unchangedBaseline.write('unchanged-baseline-header', 0, 'utf8');
    const unchangedSha256 = createHash('sha256').update(unchangedBaseline).digest('hex');

    const repoFiles: Record<string, { content: Buffer | string; mode?: '100644' | '100755' }> = {
      'assets/unchanged-large.bin': { content: unchangedBaseline },
      'src/same-size.txt': { content: 'baseline-16bytes' },
      'src/delete-me.txt': { content: 'delete-this-file\n' },
      'scripts/build.sh': { content: '#!/bin/sh\necho 1\n', mode: '100644' },
      'packages/proposal.json': { content: JSON.stringify({ ok: false, version: 0 }) },
    };
    for (let i = 0; i < 130; i++) {
      repoFiles[`src/pad-${String(i).padStart(3, '0')}.txt`] = { content: `p${i}\n` };
    }
    const rev = await createFastGitRepo(repository, repoFiles);
    const installed = await installedHandlerDigests();

    setFixture(f.registry, ['spec', 'runtimeProfiles'], []);
    setFixture(f.registry, ['spec', 'credentialBindings'], []);
    setFixture(f.registry, ['spec', 'environmentBindings'], []);
    setFixture(f.registry, ['spec', 'roleProfiles'], [
      { id: 'author', adapter: 'delegated', runtimeRef: null, providerCredentialRef: null, selection: { provider: 'antigravity', model: 'gemini-4-carbon', thinking: 'high' }, tools: ['read', 'write', 'edit', 'delete'], mcp: null },
      { id: 'reviewer', adapter: 'delegated', runtimeRef: null, providerCredentialRef: null, selection: { provider: 'antigravity', model: 'gemini-4-argon', thinking: 'low' }, tools: ['read'], mcp: null },
    ]);
    setFixture(f.registry, ['spec', 'handlers'], [
      { id: 'author.h', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Author.', purpose: 'task' }, capabilities: ['pi'] },
      { id: 'review.h', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Review.', purpose: 'review' }, capabilities: ['pi'] },
      { id: 'proposal.check', kind: 'check', implementation: 'json-artifact.v1', version: 1, digest: installed['json-artifact.v1'], parameters: { checkId: 'proposal', path: 'packages/proposal.json', required: ['ok'], equals: { ok: true } }, capabilities: ['inert_bytes', 'read_only'] },
      ...f.registry.spec.handlers.filter(h => h.id === 'scope' || h.id === 'no-change'),
    ]);
    setFixture(f.config, ['spec', 'credentials'], []);
    setFixture(f.config, ['spec', 'controls', 'maxAttempts'], 4);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], rev);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], rev);
    setFixture(f.config, ['spec', 'task', 'spec', 'scope'], {
      writable: ['packages/**', 'src/**', 'scripts/**', 'assets/**'],
      protected: ['docs/**'],
    });
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'overlay'], {
      maxFiles: 512,
      maxBytes: 268_435_456, // 256 MiB
    });
    setFixture(f.config, ['spec', 'task', 'spec', 'acceptance'], {
      required: ['proposal'],
      checks: [{ id: 'proposal', allowedEvidenceLevels: ['local_execution'] }],
    });
    setFixture(f.config, ['spec', 'task', 'spec', 'roles'], [
      { id: 'author', adapter: 'delegated', provider: 'antigravity', model: 'gemini-4-carbon', thinking: 'high', tools: ['read', 'write', 'edit', 'delete'] },
      { id: 'reviewer', adapter: 'delegated', provider: 'antigravity', model: 'gemini-4-argon', thinking: 'low', tools: ['read'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'roles'], [
      { roleId: 'author', profileRef: 'author' },
      { roleId: 'reviewer', profileRef: 'reviewer' },
    ]);
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'author', kind: 'agent', uses: 'author.h', roleId: 'author', dependsOn: [] },
      { id: 'review', kind: 'agent', uses: 'review.h', roleId: 'reviewer', dependsOn: ['author'] },
      { id: 'proposal', kind: 'check', uses: 'proposal.check', roleId: null, dependsOn: ['review'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'author', handlerRef: 'author.h' },
      { stepId: 'review', handlerRef: 'review.h' },
      { stepId: 'proposal', handlerRef: 'proposal.check' },
    ]);
    f.input.untrustedRoots = [f.taskDirectory, repository];
    await f.save();
    const loaded = assertOk(await f.load(), 'load v2 CAS step fixture');

    const runId = 'run-v2-136mib-step';
    const s1 = assertStepYield(
      assertOk(await stepNext({ configuration: loaded, repository, runRoot, runId }), 'stepNext author'),
    );

    // Create 2 x 68 MiB = 136 MiB (> 64 MiB per file, > 128 MiB aggregate!)
    const size68Mib = 68 * 1024 * 1024;
    const largeA = Buffer.alloc(size68Mib, 0x61);
    largeA.write('large-blob-A-68mib', 0, 'utf8');
    const shaA = createHash('sha256').update(largeA).digest('hex');

    const largeB = Buffer.alloc(size68Mib, 0x62);
    largeB.write('large-blob-B-68mib', 0, 'utf8');
    const shaB = createHash('sha256').update(largeB).digest('hex');

    await writeFile(join(s1.candidateDir, 'packages', 'large-a.bin'), largeA, { mode: 0o600 });
    await writeFile(join(s1.candidateDir, 'packages', 'large-b.bin'), largeB, { mode: 0o600 });
    await writeFile(join(s1.candidateDir, 'src', 'same-size.txt'), 'modified-16bytes', { mode: 0o600 });
    await unlink(join(s1.candidateDir, 'src', 'delete-me.txt'));
    await writeFile(join(s1.candidateDir, 'scripts', 'build.sh'), '#!/bin/sh\necho 2\n', { mode: 0o700 });
    await chmod(join(s1.candidateDir, 'scripts', 'build.sh'), 0o700);
    await writeFile(join(s1.candidateDir, 'packages', 'proposal.json'), JSON.stringify({ ok: true, version: 2 }), { mode: 0o600 });

    const s2 = assertStepYield(
      assertOk(await stepSubmit({ runRoot, runId, leaseToken: s1.leaseToken }), 'stepSubmit 136 MiB overlay'),
    );
    assert.equal(s2.stepId, 'review');

    const artifactsDir = join(runRoot, runId, 'artifacts');
    const casDir = join(artifactsDir, 'blobs', 'sha256');
    // Unchanged 4 MiB baseline file must produce ZERO CAS writes!
    await assert.rejects(lstat(join(casDir, unchangedSha256)), { code: 'ENOENT' });

    // Changed 68 MiB blobs exist in CAS with 0o400 & nlink === 1
    for (const expectedHex of [shaA, shaB]) {
      const st = await lstat(join(casDir, expectedHex));
      assert.equal(st.size, size68Mib);
      assert.equal(st.nlink, 1);
      assert.equal(st.mode & 0o777, 0o400);
    }

    // Reviewer workspace materialized from CAS preserves executable mode 100755 -> 0o500 (read-only role) and deletions
    const revScriptStat = await lstat(join(s2.candidateDir, 'scripts', 'build.sh'));
    assert.equal(revScriptStat.mode & 0o777, 0o500);
    await assert.rejects(lstat(join(s2.candidateDir, 'src', 'delete-me.txt')), { code: 'ENOENT' });
    assert.equal((await lstat(join(s2.candidateDir, 'packages', 'large-a.bin'))).size, size68Mib);

    // Workspace JSON is delegated-capture.v2 (< 8 KiB, zero base64 inflation)
    const retained = await readRetained({ runRoot, runId });
    const store = stateValue(reopenLocalRun(retained.descriptor.identity));
    try {
      const progress = new ProgressStore(store, null, retained.artifacts, retained.plan, retained.lock, retained.descriptor.plan, retained.descriptor.source);
      const head = await progress.read();
      assert.ok(head !== null);
      if (!head) return;
      assert.ok(head.progress.candidate.workspace.byteLength < 8192);
      const wsRaw = JSON.parse(Buffer.from(await retained.artifacts.read(head.progress.candidate.workspace, 65_536)).toString('utf8')) as {
        format: string;
        version: number;
        overlay: Record<string, unknown>[];
      };
      assert.equal(wsRaw.format, 'delegated-capture.v2');
      assert.equal(wsRaw.version, 2);
      assert.equal(wsRaw.overlay.some(entry => 'bodyBase64' in entry), false);
    } finally {
      stateValue(store.close());
    }

    // Plant an unreferenced .tmp-* file in CAS and verify recovery/cleanup removes it while keeping committed blobs
    const orphanTmp = join(casDir, '.tmp-orphan-crash-artifact');
    await writeFile(orphanTmp, 'partial', { mode: 0o600 });

    const finalTick = assertOk(
      await stepSubmit({
        runRoot,
        runId,
        leaseToken: s2.leaseToken,
        verdict: { verdict: 'pass', summary: 'Verified 136 MiB CAS overlay.', findings: [] },
      }),
      'stepSubmit reviewer verdict',
    );
    assert.equal(finalTick.kind, 'result');
    if (finalTick.kind !== 'result') return;
    assert.equal(finalTick.result.spec.status, 'completed');

    await assert.rejects(lstat(orphanTmp), { code: 'ENOENT' });
    assert.equal((await lstat(join(casDir, shaA))).size, size68Mib);

    // inspectRun emits candidate.files.json v2 with verified CAS pointers and zero base64 body
    const exportDir = join(f.root, 'inspect-v2');
    const inspected = assertOk(await inspectRun({ runRoot, runId, output: exportDir }), 'inspectRun v2');
    assert.equal(inspected.status.status, 'completed');
    const candFilesDoc = JSON.parse(await readFile(join(exportDir, 'candidate.files.json'), 'utf8')) as {
      version: number;
      manifest: ArtifactManifest;
      files: { name: string; mode: string; sha256: string; byteLength: number; uri: string; blobPath: string; body?: unknown }[];
    };
    assert.equal(candFilesDoc.version, 2);
    assert.deepEqual(candFilesDoc.manifest.spec.deleted, ['src/delete-me.txt']);
    assert.deepEqual(
      candFilesDoc.files.map(item => item.name),
      ['packages/large-a.bin', 'packages/large-b.bin', 'packages/proposal.json', 'scripts/build.sh', 'src/same-size.txt'],
    );
    for (const file of candFilesDoc.files) {
      assert.equal('body' in file, false);
      assert.equal(parseCasUri(file.uri), file.sha256);
      assert.equal(await resolveCanonicalCasBlobPath(artifactsDir, file.sha256, file.blobPath), file.blobPath);
      await streamVerifiedCasBlob(artifactsDir, { name: file.name, sha256: file.sha256, byteLength: file.byteLength, uri: file.uri, path: file.blobPath });
    }
    assert.equal(candFilesDoc.files.find(item => item.name === 'scripts/build.sh')?.mode, '100755');

    // Corrupting/deleting a referenced CAS blob causes inspectRun to mark candidate.files.json absent!
    await chmod(join(casDir, shaB), 0o600);
    await writeFile(join(casDir, shaB), 'truncated-corrupt-bytes');
    await chmod(join(casDir, shaB), 0o400);
    const corruptExportDir = join(f.root, 'inspect-corrupt');
    const corruptInspected = assertOk(await inspectRun({ runRoot, runId, output: corruptExportDir }), 'inspectRun after CAS corruption');
    const candEntry = corruptInspected.manifest?.entries.find(e => e.name === 'candidate.files.json');
    assert.equal(candEntry?.presence, 'absent');
    await assert.rejects(lstat(join(corruptExportDir, 'candidate.files.json')), { code: 'ENOENT' });
  } finally {
    await f.cleanup();
  }
});

test('Pi v2 blob_ref checkpoints + CAS PiCandidateArtifactInput drive >64 MiB / >128 MiB overlays through schedulingSnapshot, triageCandidateDiff, submission.path, json-artifact.v1, and RunResult', async () => {
  const f = await configurationFixture();
  try {
    const repository = join(f.root, 'repository');
    const runRoot = join(f.root, 'runs');
    const repoFiles: Record<string, { content: Buffer | string }> = {
      'packages/proposal.json': { content: JSON.stringify({ status: 'pending' }) },
      'src/same-size.txt': { content: '0123456789abcdef' },
      'src/remove.txt': { content: 'bye\n' },
    };
    for (let i = 0; i < 130; i++) {
      repoFiles[`src/base-${String(i).padStart(3, '0')}.txt`] = { content: `b${i}\n` };
    }
    const rev = await createFastGitRepo(repository, repoFiles);
    const installed = await installedHandlerDigests();

    setFixture(f.registry, ['spec', 'roleProfiles'], [
      { ...f.registry.spec.roleProfiles[0]!, id: 'author-prof', tools: ['read', 'write', 'edit', 'delete'], limits: { fileBytes: 268_435_456, artifactBytes: 268_435_456 } },
      { ...f.registry.spec.roleProfiles[0]!, id: 'review-prof', tools: ['read'], limits: { fileBytes: 268_435_456, artifactBytes: 268_435_456 } },
    ]);
    setFixture(f.registry, ['spec', 'handlers'], [
      { id: 'author.h', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Author.', purpose: 'task' }, capabilities: ['pi'] },
      { id: 'review.h', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Review.', purpose: 'review' }, capabilities: ['pi'] },
      { id: 'proposal.check', kind: 'check', implementation: 'json-artifact.v1', version: 1, digest: installed['json-artifact.v1'], parameters: { checkId: 'proposal', path: 'packages/proposal.json', required: ['status'], equals: { status: 'completed' } }, capabilities: ['inert_bytes', 'read_only'] },
      ...f.registry.spec.handlers.filter(h => h.id === 'scope' || h.id === 'no-change'),
    ]);
    setFixture(f.config, ['spec', 'controls', 'submission'], { mode: 'artifact_or_assistant', path: 'packages/proposal.json' });
    setFixture(f.config, ['spec', 'controls', 'maxAttempts'], 4);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], rev);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], rev);
    setFixture(f.config, ['spec', 'task', 'spec', 'scope'], { writable: ['packages/**', 'src/**'], protected: [] });
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'overlay'], { maxFiles: 512, maxBytes: 268_435_456 });
    setFixture(f.config, ['spec', 'task', 'spec', 'acceptance'], {
      required: ['proposal'],
      checks: [{ id: 'proposal', allowedEvidenceLevels: ['local_execution'] }],
    });
    setFixture(f.config, ['spec', 'task', 'spec', 'roles'], [
      { ...f.config.spec.task.spec.roles[0]!, id: 'author', tools: ['read', 'write', 'edit', 'delete'] },
      { ...f.config.spec.task.spec.roles[0]!, id: 'reviewer', tools: ['read'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'roles'], [
      { roleId: 'author', profileRef: 'author-prof' },
      { roleId: 'reviewer', profileRef: 'review-prof' },
    ]);
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'author', kind: 'agent', uses: 'author.h', roleId: 'author', dependsOn: [] },
      { id: 'review', kind: 'agent', uses: 'review.h', roleId: 'reviewer', dependsOn: ['author'] },
      { id: 'proposal', kind: 'check', uses: 'proposal.check', roleId: null, dependsOn: ['review'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'author', handlerRef: 'author.h' },
      { stepId: 'review', handlerRef: 'review.h' },
      { stepId: 'proposal', handlerRef: 'proposal.check' },
    ]);
    f.input.untrustedRoots = [f.taskDirectory, repository];
    await f.save();
    const loaded = assertOk(await f.load(), 'load Pi 136 MiB fixture');

    const size68Mib = 68 * 1024 * 1024;
    const blob1 = Buffer.alloc(size68Mib, 0x51);
    blob1.write('pi-68mib-1', 0, 'utf8');
    const blob2 = Buffer.alloc(size68Mib, 0x52);
    blob2.write('pi-68mib-2', 0, 'utf8');

    let reviewerSawCasPointers = false;
    const triageSummaries: string[][] = [];
    let callSeq = 0;

    const writeCasBlobDirect = async (artifactsDir: string, buf: Uint8Array): Promise<{ sha256: string; path: string }> => {
      const sha256 = createHash('sha256').update(buf).digest('hex');
      const dir = join(artifactsDir, 'blobs', 'sha256');
      await mkdir(join(artifactsDir, 'blobs'), { recursive: true, mode: 0o700 });
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const target = join(dir, sha256);
      const exists = await lstat(target).then(() => true, () => false);
      if (!exists) {
        await writeFile(target, buf, { mode: 0o400 });
        await chmod(target, 0o400);
      }
      return { sha256, path: target };
    };

    const openAdapter = async (host: PiHostV2, input: PiOpenInputV2) => {
      if (input.roleId === 'reviewer') {
        reviewerSawCasPointers =
          input.candidate.artifacts.length === 4 &&
          input.candidate.artifacts.every(item => 'blobPath' in item && !('bytes' in item));
      }
      let lastCmd = '';
      let subJson = '';
      const adapter: PiAdapterV2 = {
        capabilities: () => { throw new Error('unused'); },
        events: () => ({ async *[Symbol.asyncIterator]() { yield* []; } }),
        cancel: async () => ({
          ok: true,
          value: { status: 'cancelled', requestIds: [], operationIds: [], providerTermination: 'none', usage: 'none', localCleanup: 'complete', error: null, cleanupError: null },
        }),
        compact: async () => { throw new Error('unused'); },
        close: async () => ({ ok: true, value: { closed: true } }),
        execute: async cmd => {
          callSeq++;
          lastCmd = cmd.text;
          subJson =
            input.roleId === 'reviewer'
              ? JSON.stringify({ verdict: 'pass', summary: 'Reviewed CAS pointers.', findings: [] })
              : JSON.stringify({
                  version: 1,
                  status: 'completed',
                  checks: [{ checkId: 'proposal', status: 'passed', evidenceId: null, reason: null }],
                  reason: null,
                });
          const reqId = `pi-cas-req-${callSeq}`;
          const opId = `pi-cas-op-${callSeq}`;
          stateValue(host.store.reserveRequest(host.authority, {
            requestId: reqId, roleId: input.roleId, nodeId: input.stepId, attemptId: cmd.commandId,
            purpose: cmd.purpose, repair: cmd.repair, transportRetryOf: null, requestDigest: hash(reqId),
            inputUpperBound: 50, outputUpperBound: 50, totalUpperBound: 100,
            capability: { adapterId: 'pi', adapterVersion: '0.0.0', provider: input.policy.selection.provider, model: input.policy.selection.model, kind: 'soft_only', coversAllBillableTokens: false, enforcesOutputBound: false },
            operationId: opId, targetIdentity: 'fixture:pi-cas',
          }));
          stateValue(host.store.authorizeRequestDispatch(host.authority, reqId));
          const op = stateValue(host.store.getOperation(opId));
          const view = stateValue(host.store.inspect());
          const uBytes = Buffer.from(canonical({ callSeq }));
          const uName = `pi-cas-u-${hash(uBytes).hex}.bin`;
          await writeFile(join(host.artifactsDirectory, uName), uBytes, { mode: 0o600 });
          stateValue(host.store.observeRequest(host.authority, reqId, {
            receiptId: `pi-cas-rcpt-${callSeq}`, termination: 'confirmed', outcome: 'succeeded',
            evidence: {
              evidenceId: `pi-cas-ev-${callSeq}`, producerId: 'pi-cas-mock', method: 'synthetic',
              artifact: { name: uName, byteLength: uBytes.byteLength, digest: hash(uBytes) },
              subject: { storeId: view.storeId, runId: view.runId, lockHash: view.lockHash, operationId: opId, requestId: reqId, intentDigest: op.intentDigest, dispatchGeneration: op.dispatch!.generation, dispatchId: op.dispatch!.dispatchId },
            },
            usage: { requestId: reqId, inputTokens: { provenance: 'reported', value: 10 }, outputTokens: { provenance: 'reported', value: 10 }, costMicrousd: { provenance: 'reported', value: 10 } },
          }));
          return { ok: true, value: { status: 'execution_settled', requestIds: [reqId], operationIds: [opId], providerTermination: 'confirmed', usage: 'complete', localCleanup: 'complete', error: null, cleanupError: null } };
        },
        capture: async ({ checkpointId }) => {
          const proposalBytes = Buffer.from(
            JSON.stringify({
              version: 1,
              status: 'completed',
              checks: [{ checkId: 'proposal', status: 'passed', evidenceId: null, reason: null }],
              reason: null,
            }),
            'utf8',
          );
          const sameSizeBytes = Buffer.from('fedcba9876543210', 'utf8');
          const overlayItems = [
            { name: 'packages/bin-1.bin', buf: blob1 },
            { name: 'packages/bin-2.bin', buf: blob2 },
            { name: 'packages/proposal.json', buf: proposalBytes },
            { name: 'src/same-size.txt', buf: sameSizeBytes },
          ];
          const entries: ArtifactRef[] = [];
          const blobRefs: ArtifactRef[] = [];
          for (const item of overlayItems) {
            const cas = await writeCasBlobDirect(host.artifactsDirectory, item.buf);
            const entryRes = digestArtifactFromMetadata(item.name, {
              digest: { algorithm: 'sha256', hex: cas.sha256 },
              byteLength: item.buf.byteLength,
            });
            const blobRefRes = digestArtifactFromMetadata(item.name, {
              digest: { algorithm: 'sha256', hex: cas.sha256 },
              byteLength: item.buf.byteLength,
              uri: `cas://sha256/${cas.sha256}`,
            });
            if (!entryRes.ok || !blobRefRes.ok) throw new Error('bad metadata ref');
            entries.push(entryRes.value);
            blobRefs.push(blobRefRes.value);
          }
          const manifest: ArtifactManifest = {
            apiVersion: 'loopwright.dev/v1alpha1',
            kind: 'ArtifactManifest',
            metadata: { id: 'candidate' },
            spec: {
              baseTree: input.candidate.manifest.spec.baseTree!,
              entries,
              deleted: ['src/remove.txt'],
            },
          };
          const current = stateValue(host.store.inspect());
          const sourceDigest = hash('loopwright.dev/pi-policy/v2\0' + canonical(input.policy));
          const nativePolicy = { ...input.policy, version: 1, policyId: 'v2.' + BigInt('0x' + sourceDigest.hex).toString(36) };
          const bound = bindSubject(input.lock, manifest, { overlay: { maxFiles: 512, maxBytes: 268_435_456 } });
          if (!bound.ok) throw new Error('bindSubject failed');
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
            candidateDigest: bound.value.candidateDigest,
            clockBasis: current.clock.basis,
            accountingDigest: hash(canonical({ ledger: current.ledger, requests: current.counts.requests, operations: current.counts.operations })),
            sequence: 1,
          };
          const line = (v: unknown) => JSON.stringify(v) + '\n';
          let wsBody = line({ type: 'workspace_snapshot', version: 1, binding, manifest });
          for (let i = 0; i < entries.length; i++) {
            const ref = entries[i]!;
            wsBody += line({ type: 'file', ref });
            wsBody += line({ type: 'blob_ref', ref, blobRef: blobRefs[i]! });
            wsBody += line({ type: 'file_end', byteLength: ref.byteLength, digest: ref.digest.hex });
          }
          wsBody += line({ type: 'end', files: entries.length });
          const wsBytes = Buffer.from(wsBody, 'utf8');
          const wsName = `pi-cas-ws-${hash(wsBytes).hex}.bin`;
          await writeFile(join(host.artifactsDirectory, wsName), wsBytes, { mode: 0o600 });
          const wsRef = { name: wsName, byteLength: wsBytes.byteLength, digest: hash(wsBytes) };

          const ts = '2026-11-20T00:00:00.000Z';
          const sessBody =
            line({ type: 'session_snapshot', version: 1, binding }) +
            line({ type: 'session', version: 3, id: 's1', cwd: '/workspace/candidate', timestamp: ts }) +
            line({ type: 'message', id: 'u1', parentId: null, timestamp: ts, message: { role: 'user', content: lastCmd } }) +
            line({ type: 'message', id: 'a1', parentId: 'u1', timestamp: ts, message: { role: 'assistant', ...input.policy.selection, content: [{ type: 'text', text: subJson }], stopReason: 'stop' } });
          const sessBytes = Buffer.from(sessBody, 'utf8');
          const sessName = `pi-cas-sess-${hash(sessBytes).hex}.bin`;
          await writeFile(join(host.artifactsDirectory, sessName), sessBytes, { mode: 0o600 });
          const sessRef = { name: sessName, byteLength: sessBytes.byteLength, digest: hash(sessBytes) };

          stateValue(host.store.writeCheckpoint(host.authority, {
            checkpointId,
            expectedRevision: stateValue(host.store.inspect()).revision,
            candidateManifest: manifest,
            workspace: wsRef,
            privateSession: sessRef,
            additionalArtifacts: [],
          }));
          return { ok: true, value: { checkpointId, candidate: manifest, workspace: wsRef, session: sessRef } };
        },
      };
      return { ok: true as const, value: adapter };
    };

    const runId = 'run-pi-cas-136mib';
    const executed = assertOk(
      await runCycleWithPorts(
        { configuration: loaded, repository, runRoot, runId },
        {
          openAdapter,
          decisions: {
            triageCandidateDiff: async req => {
              triageSummaries.push([...req.summary.changedFiles]);
              return { escalated: [], verificationCertified: false, source: 'deterministic_heuristic' };
            },
          },
        },
      ),
      'runCycleWithPorts Pi 136 MiB CAS',
    );
    assert.equal(executed.kind, 'result', JSON.stringify(executed));
    if (executed.kind !== 'result') return;
    assert.equal(executed.result.spec.status, 'completed');
    assert.equal(reviewerSawCasPointers, true);
    assert.deepEqual(triageSummaries, [['packages/bin-1.bin', 'packages/bin-2.bin', 'packages/proposal.json', 'src/remove.txt', 'src/same-size.txt']]);

    const exportDir = join(f.root, 'pi-inspect-v2');
    const inspected = assertOk(await inspectRun({ runRoot, runId, output: exportDir }), 'inspectRun Pi v2');
    assert.equal(inspected.manifest?.entries.find(e => e.name === 'candidate.files.json')?.presence, 'present');
    const candFiles = JSON.parse(await readFile(join(exportDir, 'candidate.files.json'), 'utf8')) as {
      version: number;
      files: { name: string; uri: string; blobPath: string }[];
    };
    assert.equal(candFiles.version, 2);
    assert.equal(candFiles.files.length, 4);
  } finally {
    await f.cleanup();
  }
});

test('passive legacy delegated-capture.v1 checkpoint decodes, adopts, preserves modes, and exports cleanly', async () => {
  const f = await configurationFixture();
  try {
    const repository = join(f.root, 'repository');
    const runRoot = join(f.root, 'runs');
    const rev = await createFastGitRepo(repository, {
      'packages/result.json': { content: JSON.stringify({ ok: false }) },
      'scripts/tool.sh': { content: '#!/bin/sh\necho 0\n', mode: '100644' },
    });
    const installed = await installedHandlerDigests();
    setFixture(f.registry, ['spec', 'runtimeProfiles'], []);
    setFixture(f.registry, ['spec', 'credentialBindings'], []);
    setFixture(f.registry, ['spec', 'environmentBindings'], []);
    setFixture(f.registry, ['spec', 'roleProfiles'], [
      { id: 'author', adapter: 'delegated', runtimeRef: null, providerCredentialRef: null, selection: { provider: 'antigravity', model: 'gemini-4-carbon', thinking: 'high' }, tools: ['read', 'write'], mcp: null },
      { id: 'reviewer', adapter: 'delegated', runtimeRef: null, providerCredentialRef: null, selection: { provider: 'antigravity', model: 'gemini-4-argon', thinking: 'low' }, tools: ['read'], mcp: null },
    ]);
    setFixture(f.registry, ['spec', 'handlers'], [
      { id: 'author.h', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Author.', purpose: 'task' }, capabilities: ['pi'] },
      { id: 'review.h', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Review.', purpose: 'review' }, capabilities: ['pi'] },
      ...f.registry.spec.handlers.filter(h => h.id === 'tests' || h.id === 'scope' || h.id === 'no-change'),
    ]);
    setFixture(f.registry, ['spec', 'handlers', 2, 'parameters', 'path'], 'packages/result.json');
    setFixture(f.config, ['spec', 'credentials'], []);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], rev);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], rev);
    setFixture(f.config, ['spec', 'task', 'spec', 'scope'], { writable: ['packages/**', 'scripts/**'], protected: [] });
    setFixture(f.config, ['spec', 'task', 'spec', 'roles'], [
      { id: 'author', adapter: 'delegated', provider: 'antigravity', model: 'gemini-4-carbon', thinking: 'high', tools: ['read', 'write'] },
      { id: 'reviewer', adapter: 'delegated', provider: 'antigravity', model: 'gemini-4-argon', thinking: 'low', tools: ['read'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'roles'], [
      { roleId: 'author', profileRef: 'author' },
      { roleId: 'reviewer', profileRef: 'reviewer' },
    ]);
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'author', kind: 'agent', uses: 'author.h', roleId: 'author', dependsOn: [] },
      { id: 'review', kind: 'agent', uses: 'review.h', roleId: 'reviewer', dependsOn: ['author'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'author', handlerRef: 'author.h' },
      { stepId: 'review', handlerRef: 'review.h' },
    ]);
    f.input.untrustedRoots = [f.taskDirectory, repository];
    await f.save();
    const loaded = assertOk(await f.load(), 'load v1 compat fixture');

    const runId = 'run-legacy-v1-adopt';
    const s1 = assertStepYield(assertOk(await stepNext({ configuration: loaded, repository, runRoot, runId }), 'stepNext v1'));
    assert.equal(s1.stepId, 'author');

    // Simulate an interrupted legacy delegated-capture.v1 native checkpoint written right before crash!
    const retained = await readRetained({ runRoot, runId });
    const resultBody = Buffer.from(JSON.stringify({ ok: true }), 'utf8');
    const scriptBody = Buffer.from('#!/bin/sh\necho 1\n', 'utf8');
    const resRef = digestArtifact('packages/result.json', resultBody);
    const scrRef = digestArtifact('scripts/tool.sh', scriptBody);
    assert.ok(resRef.ok && scrRef.ok);
    if (!resRef.ok || !scrRef.ok) return;
    const v1Manifest: ArtifactManifest = {
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'ArtifactManifest',
      metadata: { id: 'candidate' },
      spec: { entries: [resRef.value, scrRef.value] },
    };
    const subJson = JSON.stringify({
      version: 1,
      status: 'completed',
      checks: [{ checkId: 'tests', status: 'passed', evidenceId: null, reason: null }],
      reason: null,
    });
    const v1Payload: DelegatedCapturePayloadV1 = {
      format: 'delegated-capture.v1',
      version: 1,
      baseRevision: rev,
      sourceRevision: rev,
      overlay: [
        { name: 'packages/result.json', mode: '100644', bodyBase64: resultBody.toString('base64') },
        { name: 'scripts/tool.sh', mode: '100755', bodyBase64: scriptBody.toString('base64') },
      ],
      deleted: [],
      assistantText: subJson,
      status: 'completed',
      reason: null,
    };
    const wsPlain = Buffer.from(canonical(v1Payload), 'utf8');
    const wsName = 'workspace-' + hash('loopwright.dev/controller/artifact/workspace/v1\0' + hash(wsPlain).hex).hex + '.bin';
    const wsRefRes = digestArtifact(wsName, wsPlain);
    assert.ok(wsRefRes.ok);
    if (!wsRefRes.ok) return;
    await writeFile(join(retained.directory, 'artifacts', wsName), wsPlain, { mode: 0o600 });
    // Remove CAS directory so this strictly exercises pre-CAS v1 capture decoding & fallback!
    await rm(join(retained.directory, 'artifacts', 'blobs'), { recursive: true, force: true });

    const decodedDirect = await decodeDelegatedWorkspace(wsPlain, v1Manifest, retained.lock, 'recovery');
    assert.equal(decodedDirect.payload.version, 1);
    assert.equal(decodedDirect.artifacts.length, 2);

    const store = stateValue(reopenLocalRun(retained.descriptor.identity));
    try {
      const view = stateValue(store.inspect());
      const claim = stateValue(store.claim({ ownerId: 'test.v1.writer', expectedGeneration: view.owner.generation, expectedRevision: view.revision, mode: 'active' }));
      stateValue(store.writeCheckpoint(claim.authority, {
        checkpointId: phaseCheckpointId(runId, 'role.1.native'),
        expectedRevision: stateValue(store.inspect()).revision,
        candidateManifest: v1Manifest,
        workspace: wsRefRes.value,
        privateSession: null,
        additionalArtifacts: [],
      }));
      stateValue(store.release(claim.authority));
    } finally {
      stateValue(store.close());
    }

    // Reopening via stepNext adopts the interrupted delegated-capture.v1 checkpoint and preserves 100755 mode for reviewer!
    const s2 = assertStepYield(assertOk(await stepNext({ runRoot, runId }), 'adopt v1 checkpoint on stepNext'));
    assert.equal(s2.stepId, 'review');
    assert.equal((await lstat(join(s2.candidateDir, 'scripts', 'tool.sh'))).mode & 0o777, 0o500);

    const exportV1Dir = join(f.root, 'inspect-v1-fallback');
    const inspectedV1 = assertOk(await inspectRun({ runRoot, runId, output: exportV1Dir }), 'inspectRun on legacy v1 capture');
    assert.equal(inspectedV1.manifest?.entries.find(e => e.name === 'candidate.files.json')?.presence, 'present');
    const v1CandDoc = JSON.parse(await readFile(join(exportV1Dir, 'candidate.files.json'), 'utf8')) as { version: number; files: { name: string }[] };
    assert.equal(v1CandDoc.version, 1);
    assert.equal(v1CandDoc.files.length, 2);
  } finally {
    await f.cleanup();
  }
});

test('durable hostPolicy enforces github vs local profiles across resumeCycle, reconcileCycle (gate & publication), stepNext/stepSubmit, and legacy descriptors', async () => {
  const f = await configurationFixture();
  const gateSecret = 'GATE_HOSTPOLICY_CANARY_112233445566';
  const pubSecret = 'PUB_HOSTPOLICY_CANARY_77889900aabb';
  let gateServer: { url: string; close: () => Promise<void> } | null = null;
  let pubServer: { url: string; lastReq: () => Record<string, unknown> | null; close: () => Promise<void> } | null = null;
  try {
    gateServer = await new Promise(resolveServer => {
      const srv = createServer((_req: IncomingMessage, res: ServerResponse) => {
        res.destroy();
      });
      srv.listen(0, '127.0.0.1', () => {
        const port = (srv.address() as { port: number }).port;
        resolveServer({
          url: `http://127.0.0.1:${port}/gate`,
          close: () => new Promise((done, fail) => { srv.closeAllConnections(); srv.close(e => (e ? fail(e) : done())); }),
        });
      });
    });
    pubServer = await new Promise(resolveServer => {
      let lastReq: Record<string, unknown> | null = null;
      const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const raw = Buffer.concat(chunks);
          const sig = req.headers['x-loopwright-signature'];
          if (typeof sig === 'string' && verifySignedPayload(pubSecret, raw, sig)) {
            lastReq = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
          }
          res.destroy();
        })();
      });
      srv.listen(0, '127.0.0.1', () => {
        const port = (srv.address() as { port: number }).port;
        resolveServer({
          url: `http://127.0.0.1:${port}/publish`,
          lastReq: () => lastReq,
          close: () => new Promise((done, fail) => { srv.closeAllConnections(); srv.close(e => (e ? fail(e) : done())); }),
        });
      });
    });

    const gateEndpointUrl = gateServer!.url;
    const pubEndpointUrl = pubServer!.url;
    const getLastPubReq = () => pubServer!.lastReq();

    const repository = join(f.root, 'repository');
    const runRoot = join(f.root, 'runs');
    const rev = await createFastGitRepo(repository, {
      'packages/result.json': { content: JSON.stringify({ ok: true }) },
      '.github/workflows/ci.yml': { content: 'name: CI\n' },
      '.claude/config.json': { content: '{"local":true}\n' },
    });
    const installed = await installedHandlerDigests();
    const origRuntimeProfiles = structuredClone(f.registry.spec.runtimeProfiles);
    const origBuilderProfile = structuredClone(f.registry.spec.roleProfiles[0]!);

    f.environment.GATE_SECRET = gateSecret;
    f.environment.PUB_SECRET = pubSecret;
    setFixture(f.registry, ['spec', 'runtimeProfiles'], []);
    setFixture(f.registry, ['spec', 'credentialBindings'], []);
    setFixture(f.registry, ['spec', 'environmentBindings'], []);
    setFixture(f.registry, ['spec', 'gateEndpoints'], []);
    setFixture(f.registry, ['spec', 'publicationEndpoints'], []);
    setFixture(f.registry, ['spec', 'roleProfiles'], [
      { id: 'author', adapter: 'delegated', runtimeRef: null, providerCredentialRef: null, selection: { provider: 'antigravity', model: 'gemini-4-carbon', thinking: 'high' }, tools: ['read', 'write', 'delete'], mcp: null },
    ]);
    setFixture(f.registry, ['spec', 'handlers'], [
      { id: 'author.h', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Author.', purpose: 'task' }, capabilities: ['pi'] },
      ...f.registry.spec.handlers.filter(h => h.id === 'tests' || h.id === 'scope' || h.id === 'no-change'),
    ]);
    setFixture(f.registry, ['spec', 'handlers', 1, 'parameters', 'path'], 'packages/result.json');
    setFixture(f.config, ['spec', 'credentials'], []);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], rev);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], rev);
    setFixture(f.config, ['spec', 'task', 'spec', 'scope'], {
      writable: ['packages/**', '.github/workflows/**', '.claude/**'],
      protected: ['docs/**'],
    });
    setFixture(f.config, ['spec', 'task', 'spec', 'roles'], [
      { id: 'author', adapter: 'delegated', provider: 'antigravity', model: 'gemini-4-carbon', thinking: 'high', tools: ['read', 'write', 'delete'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'roles'], [{ roleId: 'author', profileRef: 'author' }]);
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'author', kind: 'agent', uses: 'author.h', roleId: 'author', dependsOn: [] },
      { id: 'verify', kind: 'check', uses: 'tests', roleId: null, dependsOn: ['author'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'author', handlerRef: 'author.h' },
      { stepId: 'verify', handlerRef: 'tests' },
    ]);
    f.input.untrustedRoots = [f.taskDirectory, repository];
    await f.save();
    const loaded = assertOk(await f.load(), 'load hostPolicy fixture');

    // 1. Default 'local' profile allows .github/workflows/** and .claude/** when covered by scope.writable!
    const runLocal = 'run-policy-local';
    const yLocal = assertStepYield(
      assertOk(await stepNext({ configuration: loaded, repository, runRoot, runId: runLocal, environment: name => f.environment[name] }), 'stepNext local'),
    );
    const localRunJson = JSON.parse(await readFile(join(runRoot, runLocal, 'run.json'), 'utf8')) as { hostPolicy: PersistedHostPolicy };
    assert.deepEqual(localRunJson.hostPolicy, { policyProfile: 'local', allowWorkflowWrites: false });
    assert.equal((await lstat(join(yLocal.candidateDir, '.github', 'workflows', 'ci.yml'))).mode & 0o777, 0o600);
    assert.equal((await lstat(join(yLocal.candidateDir, '.claude', 'config.json'))).mode & 0o777, 0o600);
    await writeFile(join(yLocal.candidateDir, '.github', 'workflows', 'ci.yml'), 'name: Local Edited\n', { mode: 0o600 });
    await writeFile(join(yLocal.candidateDir, '.claude', 'config.json'), '{"local":"updated"}\n', { mode: 0o600 });
    const settledLocal = assertOk(
      await stepSubmit({ runRoot, runId: runLocal, leaseToken: yLocal.leaseToken, status: 'completed', environment: name => f.environment[name] }),
      'stepSubmit local workflow + claude edit',
    );
    assert.equal(settledLocal.kind, 'result');
    if (settledLocal.kind === 'result') assert.equal(settledLocal.result.spec.status, 'completed');

    // 2. 'github' profile persists in run.json + step-meta.json, blocks .github/workflows/** write & delete when ports omitted on stepSubmit, and refuses caller mismatch!
    const runGhStep = 'run-policy-gh-step';
    const policyGh: ControllerPolicyProfile = 'github';
    const yGh = assertStepYield(
      assertOk(
        await stepNext({
          configuration: loaded,
          repository,
          runRoot,
          runId: runGhStep,
          policyProfile: policyGh,
          environment: name => f.environment[name],
        }),
        'stepNext github',
      ),
    );
    const ghRunJson = JSON.parse(await readFile(join(runRoot, runGhStep, 'run.json'), 'utf8')) as { hostPolicy: PersistedHostPolicy };
    assert.deepEqual(ghRunJson.hostPolicy, { policyProfile: 'github', allowWorkflowWrites: false });
    assert.equal((await lstat(join(yGh.candidateDir, '.github', 'workflows', 'ci.yml'))).mode & 0o777, 0o400);

    // Caller passing mismatched policyProfile: 'local' on stepNext or stepSubmit fails closed with RECOVERY_REQUIRED!
    const mismatchNext = await stepNext({ runRoot, runId: runGhStep, reissueLease: true, policyProfile: 'local', environment: name => f.environment[name] });
    assert.equal(mismatchNext.ok, false);
    if (!mismatchNext.ok) assert.equal(mismatchNext.error.code, 'RECOVERY_REQUIRED');

    const mismatchSubmit = await stepSubmit(
      { runRoot, runId: runGhStep, leaseToken: yGh.leaseToken, environment: name => f.environment[name] },
      { policyProfile: 'local' },
    );
    assert.equal(mismatchSubmit.ok, false);
    if (!mismatchSubmit.ok) assert.equal(mismatchSubmit.error.code, 'RECOVERY_REQUIRED');

    // Deleting .github/workflows/ci.yml on 'github' run without ports on stepSubmit fails closed with ARTIFACT_INVALID!
    await unlink(join(yGh.candidateDir, '.github', 'workflows', 'ci.yml'));
    const blockedDelete = await stepSubmit({ runRoot, runId: runGhStep, leaseToken: yGh.leaseToken, environment: name => f.environment[name] });
    assert.equal(blockedDelete.ok, false);
    if (!blockedDelete.ok) assert.equal(blockedDelete.error.code, 'ARTIFACT_INVALID');

    // 3. Legacy run.json (missing hostPolicy) and legacy step-meta.json (missing hostPolicy/policyProfile) default conservatively to 'github'!
    const runLegacy = 'run-policy-legacy';
    const yLeg = assertStepYield(
      assertOk(await stepNext({ configuration: loaded, repository, runRoot, runId: runLegacy, environment: name => f.environment[name] })),
    );
    // Strip hostPolicy from run.json and step-meta.json to simulate a pre-T5 retained run
    const legRunPath = join(runRoot, runLegacy, 'run.json');
    const rawLegRun = JSON.parse(await readFile(legRunPath, 'utf8')) as Record<string, unknown>;
    delete rawLegRun.hostPolicy;
    await writeFile(legRunPath, canonical(rawLegRun), { mode: 0o600 });

    const legMetaPath = join(runRoot, runLegacy, 'step-meta.json');
    await writeFile(legMetaPath, canonical({ version: 1, mode: 'candidate' }), { mode: 0o600 });

    // Caller trying to reopen legacy run as 'local' is refused with RECOVERY_REQUIRED!
    const legMismatch = await stepNext({ runRoot, runId: runLegacy, reissueLease: true, policyProfile: 'local', environment: name => f.environment[name] });
    assert.equal(legMismatch.ok, false);
    if (!legMismatch.ok) assert.equal(legMismatch.error.code, 'RECOVERY_REQUIRED');

    // Submitting workflow edit on legacy run WITHOUT ports enforces conservative 'github' protection -> ARTIFACT_INVALID!
    await writeFile(join(yLeg.candidateDir, '.github', 'workflows', 'ci.yml'), 'name: Legacy Tamper\n', { mode: 0o600 });
    const legBlocked = await stepSubmit({ runRoot, runId: runLegacy, leaseToken: yLeg.leaseToken, environment: name => f.environment[name] });
    assert.equal(legBlocked.ok, false);
    if (!legBlocked.ok) assert.equal(legBlocked.error.code, 'ARTIFACT_INVALID');

    // 4. Pi run interrupted mid-cycle ('github' profile + legacy run.json) resumed via resumeCycle & reconcileCycle (both gate & publication)!
    setFixture(f.registry, ['spec', 'runtimeProfiles'], origRuntimeProfiles);
    setFixture(f.registry, ['spec', 'credentialBindings'], [
      { id: 'gate-signer', consumer: 'gate', destinationRef: 'gate-svc', environmentNames: ['GATE_SECRET'], template: '${GATE_SECRET}' },
      { id: 'pub-signer', consumer: 'publisher', destinationRef: 'pub-svc', environmentNames: ['PUB_SECRET'], template: '${PUB_SECRET}' },
      { id: 'prov', consumer: 'provider', destinationRef: 'github-copilot', environmentNames: ['GATE_SECRET'], template: '${GATE_SECRET}' },
    ]);
    setFixture(f.registry, ['spec', 'environmentBindings'], [
      { name: 'GATE_SECRET', classification: 'credential', paths: ['/spec/credentials/0/template', '/spec/credentials/2/template'] },
      { name: 'PUB_SECRET', classification: 'credential', paths: ['/spec/credentials/1/template'] },
    ]);
    setFixture(f.registry, ['spec', 'gateEndpoints'], [
      { id: 'ci-gate', url: gateEndpointUrl, signingCredentialRef: 'gate-signer', authCredentialRef: null, timeoutMs: 1000, maxPollMs: 1000, pollInitialMs: 100, pollMaxMs: 200, jitter: 0 },
    ]);
    setFixture(f.registry, ['spec', 'publicationEndpoints'], [
      { id: 'pr-pub', url: pubEndpointUrl, signingCredentialRef: 'pub-signer', authCredentialRef: null, timeoutMs: 1000 },
    ]);
    setFixture(f.registry, ['spec', 'roleProfiles'], [
      {
        ...origBuilderProfile,
        id: 'pi-author',
        providerCredentialRef: 'prov',
        tools: ['read', 'write'],
      },
    ]);
    setFixture(f.registry, ['spec', 'handlers'], [
      { id: 'author.h', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Author.', purpose: 'task' }, capabilities: ['pi'] },
      { id: 'gate.h', kind: 'check', implementation: 'gate.v1', version: 1, digest: installed['gate.v1'], parameters: { checkId: 'gate', endpointRef: 'ci-gate', gateId: 'g1' }, capabilities: ['external_service', 'read_only'] },
      ...f.registry.spec.handlers.filter(h => h.id === 'scope' || h.id === 'no-change'),
    ]);
    setFixture(f.config, ['spec', 'credentials'], [
      { ref: 'gate-signer', template: '${GATE_SECRET}' },
      { ref: 'pub-signer', template: '${PUB_SECRET}' },
      { ref: 'prov', template: '${GATE_SECRET}' },
    ]);
    setFixture(f.config, ['spec', 'publication'], {
      mode: 'pull_request',
      endpointRef: 'pr-pub',
      targetBranch: 'main',
      headBranchPrefix: 'loopwright/',
      titleTemplate: 'Test PR',
    });
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'maxImplementationRepairs'], 1);
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'maxModelCalls'], 4);
    setFixture(f.config, ['spec', 'controls', 'maxAttempts'], 4);
    setFixture(f.config, ['spec', 'task', 'spec', 'acceptance'], {
      required: ['gate'],
      checks: [{ id: 'gate', allowedEvidenceLevels: ['external_service'] }],
    });
    setFixture(f.config, ['spec', 'task', 'spec', 'roles'], [
      {
        id: 'author',
        adapter: 'pi',
        provider: origBuilderProfile.selection.provider,
        model: origBuilderProfile.selection.model,
        thinking: origBuilderProfile.selection.thinking,
        tools: ['read', 'write'],
      },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'roles'], [{ roleId: 'author', profileRef: 'pi-author' }]);
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'author', kind: 'agent', uses: 'author.h', roleId: 'author', dependsOn: [] },
      { id: 'gate', kind: 'check', uses: 'gate.h', roleId: null, dependsOn: ['author'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'author', handlerRef: 'author.h' },
      { stepId: 'gate', handlerRef: 'gate.h' },
    ]);
    await f.save();
    const piLoaded = assertOk(await f.load(), 'load Pi github hostPolicy fixture');

    let seq = 0;
    const makeWfMutatingPiPort = (mutateWorkflowAlways: boolean) => async (host: PiHostV2, input: PiOpenInputV2) => {
      let lastCmd = '';
      let mutateWf = mutateWorkflowAlways;
      const adapter: PiAdapterV2 = {
        capabilities: () => { throw new Error('unused'); },
        events: () => ({ async *[Symbol.asyncIterator]() { yield* []; } }),
        cancel: async () => ({
          ok: true,
          value: { status: 'cancelled', requestIds: [], operationIds: [], providerTermination: 'none', usage: 'none', localCleanup: 'complete', error: null, cleanupError: null },
        }),
        compact: async () => { throw new Error('unused'); },
        close: async () => ({ ok: true, value: { closed: true } }),
        execute: async cmd => {
          seq++;
          lastCmd = cmd.text;
          if (cmd.repair === 'implementation') mutateWf = true;
          const reqId = `hp-req-${seq}`;
          const opId = `hp-op-${seq}`;
          stateValue(host.store.reserveRequest(host.authority, {
            requestId: reqId, roleId: input.roleId, nodeId: input.stepId, attemptId: cmd.commandId,
            purpose: cmd.purpose, repair: cmd.repair, transportRetryOf: null, requestDigest: hash(reqId),
            inputUpperBound: 50, outputUpperBound: 50, totalUpperBound: 100,
            capability: { adapterId: 'pi', adapterVersion: '0.0.0', provider: input.policy.selection.provider, model: input.policy.selection.model, kind: 'soft_only', coversAllBillableTokens: false, enforcesOutputBound: false },
            operationId: opId, targetIdentity: 'fixture:hp',
          }));
          stateValue(host.store.authorizeRequestDispatch(host.authority, reqId));
          const op = stateValue(host.store.getOperation(opId));
          const view = stateValue(host.store.inspect());
          const uBytes = Buffer.from(canonical({ seq }));
          const uName = `hp-u-${hash(uBytes).hex}.bin`;
          await writeFile(join(host.artifactsDirectory, uName), uBytes, { mode: 0o600 });
          stateValue(host.store.observeRequest(host.authority, reqId, {
            receiptId: `hp-rcpt-${seq}`, termination: 'confirmed', outcome: 'succeeded',
            evidence: {
              evidenceId: `hp-ev-${seq}`, producerId: 'hp-mock', method: 'synthetic',
              artifact: { name: uName, byteLength: uBytes.byteLength, digest: hash(uBytes) },
              subject: { storeId: view.storeId, runId: view.runId, lockHash: view.lockHash, operationId: opId, requestId: reqId, intentDigest: op.intentDigest, dispatchGeneration: op.dispatch!.generation, dispatchId: op.dispatch!.dispatchId },
            },
            usage: { requestId: reqId, inputTokens: { provenance: 'reported', value: 10 }, outputTokens: { provenance: 'reported', value: 10 }, costMicrousd: { provenance: 'reported', value: 10 } },
          }));
          return { ok: true, value: { status: 'execution_settled', requestIds: [reqId], operationIds: [opId], providerTermination: 'confirmed', usage: 'complete', localCleanup: 'complete', error: null, cleanupError: null } };
        },
        capture: async ({ checkpointId }) => {
          const filesMap = new Map<string, Buffer>([
            ['packages/result.json', Buffer.from(JSON.stringify({ ok: true, seq }), 'utf8')],
          ]);
          if (mutateWf) {
            filesMap.set('.github/workflows/ci.yml', Buffer.from('name: Mutated\n', 'utf8'));
          } else if (!input.candidate.manifest.spec.baseTree) {
            filesMap.set('.github/workflows/ci.yml', Buffer.from('name: CI\n', 'utf8'));
          }
          if (!input.candidate.manifest.spec.baseTree) {
            filesMap.set('.claude/config.json', Buffer.from('{"local":true}\n', 'utf8'));
          }
          const sorted = [...filesMap.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
          const entries = sorted.map(([name, buf]) => {
            const r = digestArtifact(name, buf);
            if (!r.ok) throw new Error('digest');
            return { name, buf, ref: r.value };
          });
          const manifest: ArtifactManifest = {
            apiVersion: 'loopwright.dev/v1alpha1',
            kind: 'ArtifactManifest',
            metadata: { id: 'candidate' },
            spec: input.candidate.manifest.spec.baseTree
              ? {
                  baseTree: input.candidate.manifest.spec.baseTree,
                  entries: entries.map(e => e.ref),
                  deleted: [],
                }
              : { entries: entries.map(e => e.ref) },
          };
          const current = stateValue(host.store.inspect());
          const sourceDigest = hash('loopwright.dev/pi-policy/v2\0' + canonical(input.policy));
          const nativePolicy = { ...input.policy, version: 1, policyId: 'v2.' + BigInt('0x' + sourceDigest.hex).toString(36) };
          const bound = bindSubject(input.lock, manifest);
          if (!bound.ok) throw new Error('bind');
          const binding = {
            version: 1, checkpointId, storeId: current.storeId, runId: current.runId, lockHash: current.lockHash,
            sessionId: input.sessionId, roleId: input.roleId, stepId: input.stepId, runtime: input.policy.runtime,
            policyDigest: hash(canonical(nativePolicy)), resourcesDigest: hash(canonical(input.policy.resources)),
            candidateDigest: bound.value.candidateDigest, clockBasis: current.clock.basis,
            accountingDigest: hash(canonical({ ledger: current.ledger, requests: current.counts.requests, operations: current.counts.operations })), sequence: 1,
          };
          const line = (v: unknown) => JSON.stringify(v) + '\n';
          let wsBody = line({ type: 'workspace_snapshot', version: 1, binding, manifest });
          for (const e of entries) {
            wsBody += line({ type: 'file', ref: e.ref });
            wsBody += line({ type: 'chunk', index: 0, data: e.buf.toString('base64') });
            wsBody += line({ type: 'file_end', byteLength: e.buf.byteLength, digest: e.ref.digest.hex });
          }
          wsBody += line({ type: 'end', files: entries.length });
          const wsBytes = Buffer.from(wsBody, 'utf8');
          const wsName = `hp-ws-${hash(wsBytes).hex}.bin`;
          await writeFile(join(host.artifactsDirectory, wsName), wsBytes, { mode: 0o600 });
          const wsRef = { name: wsName, byteLength: wsBytes.byteLength, digest: hash(wsBytes) };
          const ts = '2026-11-20T00:00:00.000Z';
          const subJson = JSON.stringify({ version: 1, status: 'completed', checks: [{ checkId: 'gate', status: 'passed', evidenceId: null, reason: null }], reason: null });
          const sessBody =
            line({ type: 'session_snapshot', version: 1, binding }) +
            line({ type: 'session', version: 3, id: 's1', cwd: '/workspace/candidate', timestamp: ts }) +
            line({ type: 'message', id: 'u1', parentId: null, timestamp: ts, message: { role: 'user', content: lastCmd } }) +
            line({ type: 'message', id: 'a1', parentId: 'u1', timestamp: ts, message: { role: 'assistant', ...input.policy.selection, content: [{ type: 'text', text: subJson }], stopReason: 'stop' } });
          const sessBytes = Buffer.from(sessBody, 'utf8');
          const sessName = `hp-sess-${hash(sessBytes).hex}.bin`;
          await writeFile(join(host.artifactsDirectory, sessName), sessBytes, { mode: 0o600 });
          const sessRef = { name: sessName, byteLength: sessBytes.byteLength, digest: hash(sessBytes) };
          stateValue(host.store.writeCheckpoint(host.authority, {
            checkpointId, expectedRevision: stateValue(host.store.inspect()).revision,
            candidateManifest: manifest, workspace: wsRef, privateSession: sessRef, additionalArtifacts: [],
          }));
          return { ok: true, value: { checkpointId, candidate: manifest, workspace: wsRef, session: sessRef } };
        },
      };
      return { ok: true as const, value: adapter };
    };

    // 4a. resumeCycle on interrupted 'github' run WITHOUT policyProfile port still blocks .github/workflows/** & refuses mismatch!
    const runResumeGh = 'run-pi-resume-gh';
    const ctxResume = await createCycle(
      { configuration: piLoaded, repository, runRoot, runId: runResumeGh },
      { policyProfile: 'github', allowWorkflowWrites: false },
    );
    const cycResume = new Cycle(ctxResume);
    await cycResume.bootstrap();
    await cycResume.deadline.dispose();
    await cycResume.events.suspend();
    stateValue(ctxResume.store.release(ctxResume.authority));
    stateValue(ctxResume.store.close());
    await ctxResume.owner.release();

    const resumeMismatch = await resumeCycleWithPorts(
      { configuration: piLoaded, repository, runRoot, runId: runResumeGh },
      { policyProfile: 'local', openAdapter: makeWfMutatingPiPort(false) },
    );
    assert.equal(resumeMismatch.ok, false);
    if (!resumeMismatch.ok) assert.equal(resumeMismatch.error.code, 'RECOVERY_REQUIRED');

    const resumedBlocked = assertOk(
      await resumeCycleWithPorts(
        { configuration: piLoaded, repository, runRoot, runId: runResumeGh },
        { openAdapter: makeWfMutatingPiPort(true) }, // policyProfile omitted -> reloads persisted 'github'!
      ),
      'resumeCycleWithPorts enforces persisted github hostPolicy',
    );
    assert.equal(resumedBlocked.kind, 'incident');
    if (resumedBlocked.kind === 'incident') assert.equal(resumedBlocked.incident.code, 'ARTIFACT_INVALID');

    // 4b. Legacy run.json missing hostPolicy on resumeCycle defaults conservatively to 'github' & refuses policyProfile: 'local'!
    const runResumeLeg = 'run-pi-resume-legacy';
    const ctxLeg = await createCycle({ configuration: piLoaded, repository, runRoot, runId: runResumeLeg }, {});
    const cycLeg = new Cycle(ctxLeg);
    await cycLeg.bootstrap();
    await cycLeg.deadline.dispose();
    await cycLeg.events.suspend();
    stateValue(ctxLeg.store.release(ctxLeg.authority));
    stateValue(ctxLeg.store.close());
    await ctxLeg.owner.release();

    const legPiRunJsonPath = join(runRoot, runResumeLeg, 'run.json');
    const rawPiRunJson = JSON.parse(await readFile(legPiRunJsonPath, 'utf8')) as Record<string, unknown>;
    delete rawPiRunJson.hostPolicy;
    await writeFile(legPiRunJsonPath, canonical(rawPiRunJson), { mode: 0o600 });

    const legResumeMismatch = await resumeCycleWithPorts(
      { configuration: piLoaded, repository, runRoot, runId: runResumeLeg },
      { policyProfile: 'local', openAdapter: makeWfMutatingPiPort(false) },
    );
    assert.equal(legResumeMismatch.ok, false);
    if (!legResumeMismatch.ok) assert.equal(legResumeMismatch.error.code, 'RECOVERY_REQUIRED');

    const legResumedBlocked = assertOk(
      await resumeCycleWithPorts(
        { configuration: piLoaded, repository, runRoot, runId: runResumeLeg },
        { openAdapter: makeWfMutatingPiPort(true) },
      ),
      'legacy run.json defaults conservatively to github',
    );
    assert.equal(legResumedBlocked.kind, 'incident');
    if (legResumedBlocked.kind === 'incident') assert.equal(legResumedBlocked.incident.code, 'ARTIFACT_INVALID');

    // 4c. reconcileCycle (gate_verdict AND publication_receipt) enforces persisted hostPolicy & refuses policyProfile/allowWorkflowWrites mismatch!
    const runRec = 'run-pi-reconcile-gh';
    const ctxRec = await createCycle(
      { configuration: piLoaded, repository, runRoot, runId: runRec },
      { policyProfile: 'github', allowWorkflowWrites: false, openAdapter: makeWfMutatingPiPort(false) },
    );
    const cycRec = new Cycle(ctxRec);
    await cycRec.bootstrap();
    await cycRec.role('author');
    const gateSlot = ctxRec.plan.verifierSlots.find(s => s.handler.implementation === 'gate.v1')!;
    const nonce = randomBytes(16).toString('hex');
    const gateJob = prepareGate(ctxRec.plan, ctxRec.lock, gateSlot.id, cycRec.candidate, cycRec.generation, nonce, piLoaded.registry.spec.gateEndpoints);
    const bound = bindSubject(ctxRec.lock, cycRec.candidate.manifest);
    assert.ok(bound.ok);
    if (!bound.ok) return;
    const ordinal = ctxRec.plan.verifierSlots.findIndex(s => s.id === gateSlot.id);
    await cycRec.publish(
      {
        ...cycRec.draft,
        stage: { ...cycRec.draft.stage, kind: 'verifier_pre' },
        verifierReceipts: [{ slot: gateSlot.id, generation: cycRec.generation, operationId: gateJob.operationId, producerNonce: nonce, output: null, receipt: null }],
      },
      `verify.${cycRec.generation}.${ordinal}.pre`,
    );
    stateValue(ctxRec.store.putIntent(ctxRec.authority, {
      operationId: gateJob.operationId,
      nodeId: ctxRec.plan.orderedDAG[0]!.id,
      attemptId: 'job.' + hash(gateJob.operationId + '\0' + nonce).hex.slice(0, 40),
      effect: 'read_only',
      requestDigest: gateJob.requestDigest,
      targetIdentity: `gate:${gateSlot.id}:${cycRec.generation}:${bound.value.candidateDigest.hex}`,
    }));
    const gateDispatched = stateValue(ctxRec.store.authorizeOperationDispatch(ctxRec.authority, gateJob.operationId));
    assert.equal(gateDispatched.kind, 'new_dispatch');
    if (gateDispatched.kind !== 'new_dispatch') return;
    const gateOp = stateValue(ctxRec.store.getOperation(gateJob.operationId));
    const storeId = stateValue(ctxRec.store.inspect()).storeId;
    const gateReq = {
      version: 1, kind: 'gate_request', gateId: 'g1', checkId: gateSlot.checkId,
      candidateDigest: bound.value.candidateDigest.hex, subject: bound.value,
      storeId, runId: runRec, lockHash: ctxRec.lock.spec.lockHash, operationId: gateJob.operationId,
      dispatchId: gateDispatched.permit.dispatchId, dispatchGeneration: gateDispatched.permit.generation, requestDigest: gateJob.requestDigest.hex,
    };
    const gatePrefix = join(ctxRec.artifacts.directory, 'gate-producer-' + hash(gateJob.operationId + '\0' + nonce).hex);
    await writeFile(gatePrefix + '.binding.json', canonical({
      version: 1, planDigest: ctxRec.plan.planDigest, operationId: gateJob.operationId, producerNonce: nonce,
      requestDigest: gateJob.requestDigest, requestBytesDigest: hash(Buffer.from(canonical(gateReq))).hex, intentDigest: gateOp.intentDigest,
      subject: bound.value, generation: cycRec.generation, endpoint: 'ci-gate',
      dispatchReceipt: { generation: gateDispatched.permit.generation, dispatchId: gateDispatched.permit.dispatchId, revision: gateDispatched.permit.authorizedRevision, clockEpoch: gateDispatched.permit.clockEpoch },
    }), { mode: 0o600 });
    await cycRec.deadline.dispose();
    await cycRec.events.suspend();
    stateValue(ctxRec.store.release(ctxRec.authority));
    stateValue(ctxRec.store.close());
    await ctxRec.owner.release();

    const approvedGateBody = {
      version: 1, kind: 'gate_verdict', storeId, runId: runRec, lockHash: ctxRec.lock.spec.lockHash,
      operationId: gateJob.operationId, dispatchId: gateDispatched.permit.dispatchId, dispatchGeneration: gateDispatched.permit.generation,
      gateId: 'g1', checkId: gateSlot.checkId, candidateDigest: bound.value.candidateDigest.hex,
      status: 'approved' as const, reason: null, expiresAtMs: String(Date.now() + 600_000),
    };
    const gateReceiptFile = join(f.root, 'gate-approved.json');
    await writeFile(gateReceiptFile, JSON.stringify({ ...approvedGateBody, signature: signGateVerdict(gateSecret, approvedGateBody) }), { mode: 0o600 });

    // reconcileGate refuses policyProfile mismatch with RECOVERY_REQUIRED!
    const recGateMismatch = await reconcileCycle(
      { configuration: piLoaded, runRoot, runId: runRec, receipt: gateReceiptFile },
      { policyProfile: 'local' },
    );
    assert.equal(recGateMismatch.ok, false);
    if (!recGateMismatch.ok) assert.equal(recGateMismatch.error.code, 'RECOVERY_REQUIRED');

    // reconcileGate without ports succeeds in reconciling gate -> then hits interrupted publication -> returns unresolved ('remaining_unresolved_work')!
    const recGateOk = assertOk(
      await reconcileCycle({ configuration: piLoaded, runRoot, runId: runRec, receipt: gateReceiptFile }),
      'reconcileGate without ports',
    );
    assert.equal(recGateOk.kind, 'unresolved');

    // Now publication is in reconcile_required; verify reconcilePublication ALSO refuses policyProfile / allowWorkflowWrites mismatch!
    const pubCaptured = getLastPubReq();
    assert.ok(pubCaptured !== null);
    if (!pubCaptured) return;
    const pubReceiptBody = {
      version: 1,
      kind: 'publication_receipt',
      storeId: pubCaptured.storeId,
      runId: pubCaptured.runId,
      lockHash: pubCaptured.lockHash,
      operationId: pubCaptured.operationId,
      dispatchId: pubCaptured.dispatchId,
      dispatchGeneration: pubCaptured.dispatchGeneration,
      idempotencyKey: pubCaptured.idempotencyKey,
      outcome: 'succeeded' as const,
      externalUrl: 'https://github.com/example/repo/pull/42',
      reason: null,
    };
    const pubReceiptFile = join(f.root, 'pub-succeeded.json');
    await writeFile(pubReceiptFile, JSON.stringify({ ...pubReceiptBody, signature: signPayload(pubSecret, canonical(pubReceiptBody)) }), { mode: 0o600 });

    const recPubMismatch = await reconcileCycle(
      { configuration: piLoaded, runRoot, runId: runRec, receipt: pubReceiptFile },
      { policyProfile: 'local' },
    );
    assert.equal(recPubMismatch.ok, false);
    if (!recPubMismatch.ok) assert.equal(recPubMismatch.error.code, 'RECOVERY_REQUIRED');

    const recPubWfMismatch = await reconcileCycle(
      { configuration: piLoaded, runRoot, runId: runRec, receipt: pubReceiptFile },
      { allowWorkflowWrites: true },
    );
    assert.equal(recPubWfMismatch.ok, false);
    if (!recPubWfMismatch.ok) assert.equal(recPubWfMismatch.error.code, 'RECOVERY_REQUIRED');

    const recPubOk = assertOk(
      await reconcileCycle({ configuration: piLoaded, runRoot, runId: runRec, receipt: pubReceiptFile }),
      'reconcilePublication without ports',
    );
    assert.equal(recPubOk.kind, 'settled');
    if (recPubOk.kind === 'settled') assert.equal(recPubOk.status, 'completed');
  } finally {
    if (gateServer) await gateServer.close();
    if (pubServer) await pubServer.close();
    await f.cleanup();
  }
});

test('small baseline with budgets.overlay.maxFiles=512 selects v2 overlay for 260 files, enforces legacy allowWorkflowWrites fail-closed, early OUTPUT_LIMIT, and classic CAS reuse', async () => {
  const f = await configurationFixture();
  try {
    const repository = join(f.root, 'repository');
    const runRoot = join(f.root, 'runs');
    const rev = await createFastGitRepo(repository, {
      'packages/result.json': { content: JSON.stringify({ ok: true }) },
      'README.md': { content: 'small baseline\n' },
      '.github/CODEOWNERS': { content: '* @owners\n' },
    });
    const installed = await installedHandlerDigests();
    setFixture(f.registry, ['spec', 'runtimeProfiles'], []);
    setFixture(f.registry, ['spec', 'credentialBindings'], []);
    setFixture(f.registry, ['spec', 'environmentBindings'], []);
    setFixture(f.registry, ['spec', 'roleProfiles'], [
      { id: 'author', adapter: 'delegated', runtimeRef: null, providerCredentialRef: null, selection: { provider: 'antigravity', model: 'gemini-4-carbon', thinking: 'high' }, tools: ['read', 'write', 'delete'], mcp: null },
      { id: 'reviewer', adapter: 'delegated', runtimeRef: null, providerCredentialRef: null, selection: { provider: 'antigravity', model: 'gemini-4-argon', thinking: 'low' }, tools: ['read'], mcp: null },
    ]);
    setFixture(f.registry, ['spec', 'handlers'], [
      { id: 'author.h', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Author.', purpose: 'task' }, capabilities: ['pi'] },
      { id: 'review.h', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Review.', purpose: 'review' }, capabilities: ['pi'] },
      ...f.registry.spec.handlers.filter(h => h.id === 'tests' || h.id === 'scope' || h.id === 'no-change'),
    ]);
    setFixture(f.registry, ['spec', 'handlers', 2, 'parameters', 'path'], 'packages/result.json');
    setFixture(f.config, ['spec', 'credentials'], []);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], rev);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], rev);
    setFixture(f.config, ['spec', 'task', 'spec', 'scope'], {
      writable: ['packages/**', '.github/**'],
      protected: ['docs/**'],
    });
    setFixture(f.config, ['spec', 'task', 'spec', 'roles'], [
      { id: 'author', adapter: 'delegated', provider: 'antigravity', model: 'gemini-4-carbon', thinking: 'high', tools: ['read', 'write', 'delete'] },
      { id: 'reviewer', adapter: 'delegated', provider: 'antigravity', model: 'gemini-4-argon', thinking: 'low', tools: ['read'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'roles'], [
      { roleId: 'author', profileRef: 'author' },
      { roleId: 'reviewer', profileRef: 'reviewer' },
    ]);
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'author', kind: 'agent', uses: 'author.h', roleId: 'author', dependsOn: [] },
      { id: 'review', kind: 'agent', uses: 'review.h', roleId: 'reviewer', dependsOn: ['author'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'author', handlerRef: 'author.h' },
      { stepId: 'review', handlerRef: 'review.h' },
    ]);
    f.input.untrustedRoots = [f.taskDirectory, repository];

    // 1. Classic mode (no wide overlay): verify legacy run.json without hostPolicy + step-meta allowWorkflowWrites:true fails closed,
    //    early sparse file rejection returns OUTPUT_LIMIT without reading body, and unchanged baseline reuses frozen CAS blob!
    await f.save();
    const classicLoaded = assertOk(await f.load(), 'load classic fixture');

    const runClassic = 'run-classic-checks';
    const c1 = assertStepYield(
      assertOk(await stepNext({ configuration: classicLoaded, repository, runRoot, runId: runClassic, policyProfile: 'github', allowWorkflowWrites: true }), 'stepNext classic'),
    );
    // .github/CODEOWNERS must be materialized read-only (0o400) and blocked on submit even when allowWorkflowWrites: true under github profile!
    const codeownersPath = join(c1.candidateDir, '.github', 'CODEOWNERS');
    assert.equal((await lstat(codeownersPath)).mode & 0o777, 0o400);
    await chmod(codeownersPath, 0o600);
    await writeFile(codeownersPath, '* @tampered\n', { mode: 0o600 });
    const blockedCodeowners = await stepSubmit({ runRoot, runId: runClassic, leaseToken: c1.leaseToken });
    assert.equal(blockedCodeowners.ok, false);
    if (!blockedCodeowners.ok) assert.equal(blockedCodeowners.error.code, 'ARTIFACT_INVALID');
    await writeFile(codeownersPath, '* @owners\n', { mode: 0o600 });
    await chmod(codeownersPath, 0o400);

    // Oversized sparse file (> perFileMaxBytes = 1 MiB) is rejected immediately with OUTPUT_LIMIT before reading body
    const sparsePath = join(c1.candidateDir, 'packages', 'huge-sparse.bin');
    await writeFile(sparsePath, '', { mode: 0o600 });
    await truncate(sparsePath, 200 * 1024 * 1024);
    const oversizedRefused = await stepSubmit({ runRoot, runId: runClassic, leaseToken: c1.leaseToken });
    assert.equal(oversizedRefused.ok, false);
    if (!oversizedRefused.ok) assert.equal(oversizedRefused.error.code, 'OUTPUT_LIMIT');
    await unlink(sparsePath);

    // Classic unchanged baseline file reuses its frozen CAS blob without replacing inode/mtime
    const readmeSha = createHash('sha256').update('small baseline\n').digest('hex');
    const readmeCasPath = join(runRoot, runClassic, 'artifacts', 'blobs', 'sha256', readmeSha);
    const casBefore = await lstat(readmeCasPath);
    const c2 = assertStepYield(
      assertOk(await stepSubmit({ runRoot, runId: runClassic, leaseToken: c1.leaseToken }), 'stepSubmit classic unchanged'),
    );
    assert.equal(c2.stepId, 'review');
    const casAfter = await lstat(readmeCasPath);
    assert.equal(casAfter.ino, casBefore.ino);
    assert.equal(casAfter.mtimeMs, casBefore.mtimeMs);

    // Legacy run.json (without hostPolicy) + step-meta.json with { allowWorkflowWrites: true } (without hostPolicy) fails closed with RECOVERY_REQUIRED!
    const runLegacyEscalation = 'run-legacy-meta-escalate';
    assertStepYield(assertOk(await stepNext({ configuration: classicLoaded, repository, runRoot, runId: runLegacyEscalation }), 'stepNext legacy escalation'));
    const runJsonPath = join(runRoot, runLegacyEscalation, 'run.json');
    const rawRunJson = JSON.parse(await readFile(runJsonPath, 'utf8')) as Record<string, unknown>;
    delete rawRunJson.hostPolicy;
    await writeFile(runJsonPath, canonical(rawRunJson), { mode: 0o600 });
    await writeFile(
      join(runRoot, runLegacyEscalation, 'step-meta.json'),
      canonical({ version: 1, mode: 'candidate', allowWorkflowWrites: true }),
      { mode: 0o600 },
    );
    const escalatedReopen = await stepNext({ runRoot, runId: runLegacyEscalation, reissueLease: true });
    assert.equal(escalatedReopen.ok, false);
    if (!escalatedReopen.ok) {
      assert.equal(escalatedReopen.error.code, 'RECOVERY_REQUIRED');
    }

    // 2. Small baseline (3 files <= 128) + budgets.overlay.maxFiles = 512 selects v2 overlay and admits 260 candidate files!
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'overlay'], { maxFiles: 512, maxBytes: 16_777_216 });
    await f.save();
    const wideLoaded = assertOk(await f.load(), 'load wide overlay on small baseline');
    const runWide = 'run-small-base-260-files';
    const w1 = assertStepYield(assertOk(await stepNext({ configuration: wideLoaded, repository, runRoot, runId: runWide }), 'stepNext wide'));
    for (let i = 0; i < 260; i++) {
      await writeFile(join(w1.candidateDir, 'packages', `gen-${String(i).padStart(3, '0')}.txt`), `generated-${i}\n`, { mode: 0o600 });
    }
    const w2 = assertStepYield(assertOk(await stepSubmit({ runRoot, runId: runWide, leaseToken: w1.leaseToken }), 'stepSubmit 260 files on small baseline'));
    assert.equal(w2.stepId, 'review');
    const settledWide = assertOk(
      await stepSubmit({
        runRoot,
        runId: runWide,
        leaseToken: w2.leaseToken,
        verdict: { verdict: 'pass', summary: 'All 260 generated files verified.', findings: [] },
      }),
      'stepSubmit reviewer wide',
    );
    assert.equal(settledWide.kind, 'result');
    if (settledWide.kind === 'result') {
      assert.equal(settledWide.result.spec.status, 'completed');
    }
  } finally {
    await f.cleanup();
  }
});

test('native Pi host.createCandidateStreamChecker and adoptRoleCapture defense-in-depth reject registered and generic secrets in CAS blob_ref captures', async () => {
  const f = await configurationFixture();
  try {
    const repository = join(f.root, 'repository');
    const runRoot = join(f.root, 'runs');
    const rev = await createFastGitRepo(repository, {
      'packages/result.json': { content: JSON.stringify({ ok: false }) },
    });
    const installed = await installedHandlerDigests();
    const registeredSecret = 'PiRegisteredSecret+Canary99887766==';
    f.environment.PROVIDER_TOKEN = registeredSecret;
    const origBuilder = structuredClone(f.registry.spec.roleProfiles[0]!);
    setFixture(f.registry, ['spec', 'roleProfiles'], [{ ...origBuilder, id: 'pi-author', tools: ['read', 'write'] }]);
    setFixture(f.registry, ['spec', 'handlers'], [
      { id: 'author.h', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Author.', purpose: 'task' }, capabilities: ['pi'] },
      ...f.registry.spec.handlers.filter(h => h.id === 'tests' || h.id === 'scope' || h.id === 'no-change'),
    ]);
    setFixture(f.registry, ['spec', 'handlers', 1, 'parameters', 'path'], 'packages/result.json');
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], rev);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], rev);
    setFixture(f.config, ['spec', 'task', 'spec', 'scope'], { writable: ['packages/**'], protected: [] });
    setFixture(f.config, ['spec', 'task', 'spec', 'roles'], [
      { id: 'author', adapter: 'pi', provider: origBuilder.selection.provider, model: origBuilder.selection.model, thinking: origBuilder.selection.thinking, tools: ['read', 'write'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'roles'], [{ roleId: 'author', profileRef: 'pi-author' }]);
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'author', kind: 'agent', uses: 'author.h', roleId: 'author', dependsOn: [] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [{ stepId: 'author', handlerRef: 'author.h' }]);
    f.input.untrustedRoots = [f.taskDirectory, repository];
    await f.save();
    const loaded = assertOk(await f.load(), 'load Pi secret scrub fixture');

    let seq = 0;
    const runSecretCase = async (runId: string, secretBody: Buffer, bypassHostChecker: boolean) => {
      let hostSawChecker = false;
      const openAdapter = async (host: PiHostV2, input: PiOpenInputV2) => {
        hostSawChecker = typeof host.createCandidateStreamChecker === 'function';
        let lastCmd = '';
        const adapter: PiAdapterV2 = {
          capabilities: () => { throw new Error('unused'); },
          events: () => ({ async *[Symbol.asyncIterator]() { yield* []; } }),
          cancel: async () => ({ ok: true, value: { status: 'cancelled', requestIds: [], operationIds: [], providerTermination: 'none', usage: 'none', localCleanup: 'complete', error: null, cleanupError: null } }),
          compact: async () => { throw new Error('unused'); },
          close: async () => ({ ok: true, value: { closed: true } }),
          execute: async cmd => {
            seq++;
            lastCmd = cmd.text;
            const reqId = `sec-req-${seq}`;
            const opId = `sec-op-${seq}`;
            stateValue(host.store.reserveRequest(host.authority, {
              requestId: reqId, roleId: input.roleId, nodeId: input.stepId, attemptId: cmd.commandId,
              purpose: cmd.purpose, repair: cmd.repair, transportRetryOf: null, requestDigest: hash(reqId),
              inputUpperBound: 50, outputUpperBound: 50, totalUpperBound: 100,
              capability: { adapterId: 'pi', adapterVersion: '0.0.0', provider: input.policy.selection.provider, model: input.policy.selection.model, kind: 'soft_only', coversAllBillableTokens: false, enforcesOutputBound: false },
              operationId: opId, targetIdentity: 'fixture:sec',
            }));
            stateValue(host.store.authorizeRequestDispatch(host.authority, reqId));
            const op = stateValue(host.store.getOperation(opId));
            const view = stateValue(host.store.inspect());
            const uBytes = Buffer.from(canonical({ seq }));
            const uName = `sec-u-${hash(uBytes).hex}.bin`;
            await writeFile(join(host.artifactsDirectory, uName), uBytes, { mode: 0o600 });
            stateValue(host.store.observeRequest(host.authority, reqId, {
              receiptId: `sec-rcpt-${seq}`, termination: 'confirmed', outcome: 'succeeded',
              evidence: {
                evidenceId: `sec-ev-${seq}`, producerId: 'sec-mock', method: 'synthetic',
                artifact: { name: uName, byteLength: uBytes.byteLength, digest: hash(uBytes) },
                subject: { storeId: view.storeId, runId: view.runId, lockHash: view.lockHash, operationId: opId, requestId: reqId, intentDigest: op.intentDigest, dispatchGeneration: op.dispatch!.generation, dispatchId: op.dispatch!.dispatchId },
              },
              usage: { requestId: reqId, inputTokens: { provenance: 'reported', value: 10 }, outputTokens: { provenance: 'reported', value: 10 }, costMicrousd: { provenance: 'reported', value: 10 } },
            }));
            return { ok: true, value: { status: 'execution_settled', requestIds: [reqId], operationIds: [opId], providerTermination: 'confirmed', usage: 'complete', localCleanup: 'complete', error: null, cleanupError: null } };
          },
          capture: async ({ checkpointId }) => {
            if (!bypassHostChecker && host.createCandidateStreamChecker) {
              const checker = host.createCandidateStreamChecker();
              checker.push(secretBody);
              checker.finish();
            }
            const sha = createHash('sha256').update(secretBody).digest('hex');
            const shaDir = join(host.artifactsDirectory, 'blobs', 'sha256');
            await mkdir(shaDir, { recursive: true, mode: 0o700 });
            const blobTarget = join(shaDir, sha);
            await writeFile(blobTarget, secretBody, { mode: 0o400 });
            await chmod(blobTarget, 0o400);
            const entryRes = digestArtifactFromMetadata('packages/result.json', { digest: { algorithm: 'sha256', hex: sha }, byteLength: secretBody.byteLength });
            const blobRefRes = digestArtifactFromMetadata('packages/result.json', { digest: { algorithm: 'sha256', hex: sha }, byteLength: secretBody.byteLength, uri: `cas://sha256/${sha}` });
            if (!entryRes.ok || !blobRefRes.ok) throw new Error('bad metadata');
            const manifest: ArtifactManifest = {
              apiVersion: 'loopwright.dev/v1alpha1',
              kind: 'ArtifactManifest',
              metadata: { id: 'candidate' },
              spec: { entries: [entryRes.value] },
            };
            const current = stateValue(host.store.inspect());
            const sourceDigest = hash('loopwright.dev/pi-policy/v2\0' + canonical(input.policy));
            const nativePolicy = { ...input.policy, version: 1, policyId: 'v2.' + BigInt('0x' + sourceDigest.hex).toString(36) };
            const bound = bindSubject(input.lock, manifest);
            if (!bound.ok) throw new Error('bind');
            const binding = {
              version: 1, checkpointId, storeId: current.storeId, runId: current.runId, lockHash: current.lockHash,
              sessionId: input.sessionId, roleId: input.roleId, stepId: input.stepId, runtime: input.policy.runtime,
              policyDigest: hash(canonical(nativePolicy)), resourcesDigest: hash(canonical(input.policy.resources)),
              candidateDigest: bound.value.candidateDigest, clockBasis: current.clock.basis,
              accountingDigest: hash(canonical({ ledger: current.ledger, requests: current.counts.requests, operations: current.counts.operations })), sequence: 1,
            };
            const line = (v: unknown) => JSON.stringify(v) + '\n';
            const wsBody =
              line({ type: 'workspace_snapshot', version: 1, binding, manifest }) +
              line({ type: 'file', ref: entryRes.value }) +
              line({ type: 'blob_ref', ref: entryRes.value, blobRef: blobRefRes.value }) +
              line({ type: 'file_end', byteLength: entryRes.value.byteLength, digest: sha }) +
              line({ type: 'end', files: 1 });
            const wsBytes = Buffer.from(wsBody, 'utf8');
            const wsName = `sec-ws-${hash(wsBytes).hex}.bin`;
            await writeFile(join(host.artifactsDirectory, wsName), wsBytes, { mode: 0o600 });
            const wsRef = { name: wsName, byteLength: wsBytes.byteLength, digest: hash(wsBytes) };
            const ts = '2026-11-20T00:00:00.000Z';
            const subJson = JSON.stringify({ version: 1, status: 'completed', checks: [{ checkId: 'tests', status: 'passed', evidenceId: null, reason: null }], reason: null });
            const sessBody =
              line({ type: 'session_snapshot', version: 1, binding }) +
              line({ type: 'session', version: 3, id: 's1', cwd: '/workspace/candidate', timestamp: ts }) +
              line({ type: 'message', id: 'u1', parentId: null, timestamp: ts, message: { role: 'user', content: lastCmd } }) +
              line({ type: 'message', id: 'a1', parentId: 'u1', timestamp: ts, message: { role: 'assistant', ...input.policy.selection, content: [{ type: 'text', text: subJson }], stopReason: 'stop' } });
            const sessBytes = Buffer.from(sessBody, 'utf8');
            const sessName = `sec-sess-${hash(sessBytes).hex}.bin`;
            await writeFile(join(host.artifactsDirectory, sessName), sessBytes, { mode: 0o600 });
            const sessRef = { name: sessName, byteLength: sessBytes.byteLength, digest: hash(sessBytes) };
            stateValue(host.store.writeCheckpoint(host.authority, {
              checkpointId, expectedRevision: stateValue(host.store.inspect()).revision,
              candidateManifest: manifest, workspace: wsRef, privateSession: sessRef, additionalArtifacts: [],
            }));
            return { ok: true, value: { checkpointId, candidate: manifest, workspace: wsRef, session: sessRef } };
          },
        };
        return { ok: true as const, value: adapter };
      };
      const outcome = assertOk(await runCycleWithPorts({ configuration: loaded, repository, runRoot, runId }, { openAdapter }), runId);
      assert.equal(hostSawChecker, true);
      assert.equal(outcome.kind, 'incident');
      if (outcome.kind === 'incident') {
        assert.equal(outcome.incident.code, 'CONFIG_CREDENTIAL_INVALID');
      }
    };

    // 1. Registered secret rejected via host.createCandidateStreamChecker before CAS write
    const regBody = Buffer.from(JSON.stringify({ ok: true, leak: registeredSecret }), 'utf8');
    await runSecretCase('run-pi-scrub-registered', regBody, false);
    const regSha = createHash('sha256').update(regBody).digest('hex');
    await assert.rejects(
      lstat(join(runRoot, 'run-pi-scrub-registered', 'artifacts', 'blobs', 'sha256', regSha)),
      (err: NodeJS.ErrnoException) => err.code === 'ENOENT',
    );

    // 2. Generic GitHub token pre-populated directly into CAS still rejected by adoptRoleCapture defense-in-depth!
    const genBody = Buffer.from(JSON.stringify({ ok: true, token: 'ghp_0123456789abcdefghij0123456789' }), 'utf8');
    await runSecretCase('run-pi-scrub-generic-adopt', genBody, true);
  } finally {
    await f.cleanup();
  }
});

test('R2-8: read-only delegated role chmod mutation on overlay file is refused with ARTIFACT_INVALID and authorized mode is preserved', async () => {
  const f = await configurationFixture();
  try {
    const repository = join(f.root, 'repository');
    const runRoot = join(f.root, 'runs');
    const rev = await createFastGitRepo(repository, {
      'packages/result.json': { content: JSON.stringify({ ok: true }) },
      'README.md': { content: 'mode guard test\n' },
    });
    const installed = await installedHandlerDigests();
    setFixture(f.registry, ['spec', 'runtimeProfiles'], []);
    setFixture(f.registry, ['spec', 'credentialBindings'], []);
    setFixture(f.registry, ['spec', 'environmentBindings'], []);
    setFixture(f.registry, ['spec', 'roleProfiles'], [
      { id: 'implementer', adapter: 'delegated', runtimeRef: null, providerCredentialRef: null, selection: { provider: 'antigravity', model: 'gemini-4-carbon', thinking: 'high' }, tools: ['read', 'write', 'delete'], mcp: null },
      { id: 'reviewer', adapter: 'delegated', runtimeRef: null, providerCredentialRef: null, selection: { provider: 'antigravity', model: 'gemini-4-argon', thinking: 'low' }, tools: ['read'], mcp: null },
    ]);
    setFixture(f.registry, ['spec', 'handlers'], [
      { id: 'impl.h', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Implement.', purpose: 'task' }, capabilities: ['pi'] },
      { id: 'review.h', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Review.', purpose: 'review' }, capabilities: ['pi'] },
      ...f.registry.spec.handlers.filter(h => h.id === 'tests' || h.id === 'scope' || h.id === 'no-change'),
    ]);
    setFixture(f.registry, ['spec', 'handlers', 2, 'parameters', 'path'], 'packages/result.json');
    setFixture(f.config, ['spec', 'credentials'], []);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], rev);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], rev);
    setFixture(f.config, ['spec', 'task', 'spec', 'scope'], { writable: ['packages/**'], protected: [] });
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'overlay'], { maxFiles: 256, maxBytes: 16_777_216 });
    setFixture(f.config, ['spec', 'task', 'spec', 'roles'], [
      { id: 'implementer', adapter: 'delegated', provider: 'antigravity', model: 'gemini-4-carbon', thinking: 'high', tools: ['read', 'write', 'delete'] },
      { id: 'reviewer', adapter: 'delegated', provider: 'antigravity', model: 'gemini-4-argon', thinking: 'low', tools: ['read'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'roles'], [
      { roleId: 'implementer', profileRef: 'implementer' },
      { roleId: 'reviewer', profileRef: 'reviewer' },
    ]);
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'implement', kind: 'agent', uses: 'impl.h', roleId: 'implementer', dependsOn: [] },
      { id: 'review', kind: 'agent', uses: 'review.h', roleId: 'reviewer', dependsOn: ['implement'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'implement', handlerRef: 'impl.h' },
      { stepId: 'review', handlerRef: 'review.h' },
    ]);
    f.input.untrustedRoots = [f.taskDirectory, repository];
    await f.save();
    const loaded = assertOk(await f.load(), 'load mode guard fixture');

    const runId = 'run-r2-8-mode-guard';
    const y1 = assertStepYield(assertOk(await stepNext({ configuration: loaded, repository, runRoot, runId }), 'stepNext implement'));
    // Implementer adds packages/bin/run.sh as non-executable 0o644
    await mkdir(join(y1.candidateDir, 'packages', 'bin'), { recursive: true, mode: 0o700 });
    await writeFile(join(y1.candidateDir, 'packages', 'bin', 'run.sh'), '#!/bin/sh\necho hi\n', { mode: 0o644 });
    await chmod(join(y1.candidateDir, 'packages', 'bin', 'run.sh'), 0o644);
    const y2 = assertStepYield(assertOk(await stepSubmit({ runRoot, runId, leaseToken: y1.leaseToken }), 'stepSubmit implement'));
    assert.equal(y2.stepId, 'review');

    // Read-only reviewer flips packages/bin/run.sh to 0o755 without changing bytes -> MUST be refused with ARTIFACT_INVALID
    const reviewScript = join(y2.candidateDir, 'packages', 'bin', 'run.sh');
    await chmod(reviewScript, 0o755);
    const chmodRefused = await stepSubmit({
      runRoot,
      runId,
      leaseToken: y2.leaseToken,
      verdict: { verdict: 'pass', summary: 'Tried chmod +x.', findings: [] },
    });
    assert.equal(chmodRefused.ok, false);
    if (!chmodRefused.ok) {
      assert.equal(chmodRefused.error.code, 'ARTIFACT_INVALID');
    }

    // Restoring 0o400 (non-executable) allows reviewer submission to settle and inspectRun preserves mode 100644
    await chmod(reviewScript, 0o400);
    const settled = assertOk(
      await stepSubmit({
        runRoot,
        runId,
        leaseToken: y2.leaseToken,
        verdict: { verdict: 'pass', summary: 'Clean review.', findings: [] },
      }),
      'stepSubmit review clean',
    );
    assert.equal(settled.kind, 'result');
    if (settled.kind === 'result') {
      assert.equal(settled.result.spec.status, 'completed');
    }
    const inspectDir = join(f.root, 'inspect-r2-8');
    const inspected = assertOk(await inspectRun({ runRoot, runId, output: inspectDir }), 'inspectRun mode guard');
    assert.ok(inspected.manifest !== null);
    const exportedFiles = JSON.parse(await readFile(join(inspectDir, 'candidate.files.json'), 'utf8')) as {
      version: number;
      files: { name: string; mode: string }[];
    };
    assert.equal(exportedFiles.version, 2);
    const runSh = exportedFiles.files.find(file => file.name === 'packages/bin/run.sh');
    assert.equal(runSh?.mode, '100644');
  } finally {
    await f.cleanup();
  }
});

test('R2-10 & R2-13: async assertCanonicalMinimalOverlay reuses VERIFIED_CAS_SEAL and visit() charges same-size edits immediately before touching later files', async () => {
  const { assertCanonicalMinimalOverlay, VERIFIED_CAS_SEAL, freezeSource } = await import('../src/source.js');
  const { retainedFixture } = await import('./progress-fixtures.js');

  // Part A (R2-10): assertCanonicalMinimalOverlay is async, attaches VERIFIED_CAS_SEAL, reuses it on repeat calls, and rejects tampered mode
  const rf = await retainedFixture();
  try {
    const repoDir = join(rf.root, 'seal-repo');
    const baselineFiles: Record<string, { content: string }> = {};
    for (let i = 0; i < 135; i++) {
      baselineFiles[`packages/base-${String(i).padStart(3, '0')}.txt`] = { content: `base-${i}\n` };
    }
    const rev = await createFastGitRepo(repoDir, baselineFiles);
    const task = {
      ...rf.plan.task,
      spec: {
        ...rf.plan.task.spec,
        target: {
          ...rf.plan.task.spec.target,
          baseRevision: rev,
          sourceRevision: rev,
        },
      },
    };
    const frozen = await freezeSource(repoDir, task, rf.owner, rf.artifacts);
    assert.equal(frozen.version, 2);

    const editedBytes = Buffer.from('edited-base-0\n', 'utf8');
    const ptr = await rf.artifacts.putCasBlobFromBytes('packages/base-000.txt', editedBytes);
    const entryRes = digestArtifactFromMetadata('packages/base-000.txt', {
      digest: { algorithm: 'sha256', hex: ptr.sha256 },
      byteLength: ptr.byteLength,
    });
    assert.equal(entryRes.ok, true);
    if (!entryRes.ok) throw new Error('expected ok');
    const manifest: ArtifactManifest = {
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'ArtifactManifest',
      metadata: { id: 'candidate' },
      spec: { baseTree: frozen.manifest.spec.baseTree!, entries: [entryRes.value], deleted: [] },
    };
    const casFile = {
      name: 'packages/base-000.txt',
      byteLength: ptr.byteLength,
      digest: entryRes.value.digest,
      blobPath: ptr.path,
      mode: '100644' as const,
    };
    await assertCanonicalMinimalOverlay(manifest, [casFile], frozen, 'execution');
    const attachedSeal = (casFile as typeof casFile & { [VERIFIED_CAS_SEAL]?: { sha256: string; gitOid: string | null } })[VERIFIED_CAS_SEAL];
    assert.ok(attachedSeal !== undefined);
    assert.equal(attachedSeal.sha256, ptr.sha256);
    assert.ok(attachedSeal.gitOid !== null);
    // Second verification hits the verified seal cleanly
    await assertCanonicalMinimalOverlay(manifest, [casFile], frozen, 'execution');
    // Flipping CAS blob writable invalidates the fast path and refuses RECOVERY_REQUIRED
    await chmod(ptr.path, 0o600);
    await assert.rejects(
      assertCanonicalMinimalOverlay(manifest, [casFile], frozen, 'execution'),
      (err: unknown) => err instanceof Error && 'diagnostic' in err && (err as { diagnostic: { code: string } }).diagnostic.code === 'RECOVERY_REQUIRED',
    );
    await chmod(ptr.path, 0o400);
  } finally {
    await rf.close();
  }

  // Part B (R2-13): overlay.maxFiles=1 with two same-size modified files (a.txt, b.txt) refuses OUTPUT_LIMIT at b.txt BEFORE visiting z.txt
  const f = await configurationFixture();
  try {
    const repository = join(f.root, 'repository-samesize');
    const runRoot = join(f.root, 'runs-samesize');
    const files: Record<string, { content: string }> = {
      'packages/a.txt': { content: 'aaaa\n' },
      'packages/b.txt': { content: 'bbbb\n' },
      'packages/result.json': { content: JSON.stringify({ ok: true }) },
      'packages/z.txt': { content: 'zzzz\n' },
    };
    for (let i = 0; i < 135; i++) {
      files[`src/f-${String(i).padStart(3, '0')}.txt`] = { content: `src-${i}\n` };
    }
    const rev = await createFastGitRepo(repository, files);
    const installed = await installedHandlerDigests();
    setFixture(f.registry, ['spec', 'runtimeProfiles'], []);
    setFixture(f.registry, ['spec', 'credentialBindings'], []);
    setFixture(f.registry, ['spec', 'environmentBindings'], []);
    setFixture(f.registry, ['spec', 'roleProfiles'], [
      { id: 'author', adapter: 'delegated', runtimeRef: null, providerCredentialRef: null, selection: { provider: 'antigravity', model: 'gemini-4-carbon', thinking: 'high' }, tools: ['read', 'write', 'delete'], mcp: null },
    ]);
    setFixture(f.registry, ['spec', 'handlers'], [
      { id: 'author.h', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Author.', purpose: 'task' }, capabilities: ['pi'] },
      ...f.registry.spec.handlers.filter(h => h.id === 'tests' || h.id === 'scope' || h.id === 'no-change'),
    ]);
    setFixture(f.registry, ['spec', 'handlers', 1, 'parameters', 'path'], 'packages/result.json');
    setFixture(f.config, ['spec', 'credentials'], []);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], rev);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], rev);
    setFixture(f.config, ['spec', 'task', 'spec', 'scope'], { writable: ['packages/**'], protected: [] });
    setFixture(f.config, ['spec', 'task', 'spec', 'budgets', 'overlay'], { maxFiles: 1, maxBytes: 1_048_576 });
    setFixture(f.config, ['spec', 'task', 'spec', 'roles'], [
      { id: 'author', adapter: 'delegated', provider: 'antigravity', model: 'gemini-4-carbon', thinking: 'high', tools: ['read', 'write', 'delete'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'roles'], [{ roleId: 'author', profileRef: 'author' }]);
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'author', kind: 'agent', uses: 'author.h', roleId: 'author', dependsOn: [] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [{ stepId: 'author', handlerRef: 'author.h' }]);
    f.input.untrustedRoots = [f.taskDirectory, repository];
    await f.save();
    const loaded = assertOk(await f.load(), 'load same-size charge fixture');

    const runId = 'run-r2-13-samesize';
    const y = assertStepYield(assertOk(await stepNext({ configuration: loaded, repository, runRoot, runId }), 'stepNext same-size'));
    // Modify a.txt and b.txt with the EXACT SAME byte length (5 bytes each)
    await writeFile(join(y.candidateDir, 'packages', 'a.txt'), 'xxxx\n', { mode: 0o600 });
    await writeFile(join(y.candidateDir, 'packages', 'b.txt'), 'yyyy\n', { mode: 0o600 });
    // Replace z.txt with a symlink (which visit() would reject with ARTIFACT_INVALID if it ever reached z.txt!)
    await unlink(join(y.candidateDir, 'packages', 'z.txt'));
    await symlink(join(y.candidateDir, 'packages', 'a.txt'), join(y.candidateDir, 'packages', 'z.txt'));

    const res = await stepSubmit({ runRoot, runId, leaseToken: y.leaseToken });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.error.code, 'OUTPUT_LIMIT', `expected OUTPUT_LIMIT before visiting z.txt, got ${res.error.code}`);
    }
  } finally {
    await f.cleanup();
  }
});

test('R3-10 & R4-6: fresh CAS winner omits unhashed seal while EEXIST/tryReuse mint descriptor seals, first overlay verification hashes finalized 0o400 descriptor, and second reuses seal without re-reading', async () => {
  const { assertCanonicalMinimalOverlay, attachVerifiedCasSeal, VERIFIED_CAS_SEAL, freezeSource } = await import('../src/source.js');
  const { retainedFixture } = await import('./progress-fixtures.js');

  const rf = await retainedFixture();
  try {
    const repoDir = join(rf.root, 'r3-10-repo');
    const baselineFiles: Record<string, { content: string }> = {};
    for (let i = 0; i < 135; i++) {
      baselineFiles[`packages/base-${String(i).padStart(3, '0')}.txt`] = { content: `base-${i}\n` };
    }
    const rev = await createFastGitRepo(repoDir, baselineFiles);
    const task = {
      ...rf.plan.task,
      spec: {
        ...rf.plan.task.spec,
        target: { ...rf.plan.task.spec.target, baseRevision: rev, sourceRevision: rev },
      },
    };
    const frozen = await freezeSource(repoDir, task, rf.owner, rf.artifacts);
    assert.equal(frozen.version, 2);

    const srcFile = join(rf.root, 'edited-r3-10.txt');
    const editedBytes = Buffer.from('edited-base-0!\n', 'utf8');
    await writeFile(srcFile, editedBytes, { mode: 0o600 });

    // 1. Fresh-write winner branch MUST NOT mint verifiedSeal from the pre-chmod writable write stream (R4-6)
    const winnerPtr = await rf.artifacts.putCasBlobFromFile('packages/base-000.txt', srcFile, undefined, {
      gitObjectFormat: 'sha1',
    });
    assert.equal(winnerPtr.verifiedSeal, undefined);
    const blobStat = await lstat(winnerPtr.path);

    // 2. EEXIST dedup branch AND tryReuseCasBlob hash the finalized 0o400 nlink===1 descriptor and mint verifiedSeal
    const dedupPtr = await rf.artifacts.putCasBlobFromFile('packages/base-000.txt', srcFile, undefined, {
      gitObjectFormat: 'sha1',
    });
    assert.ok(dedupPtr.verifiedSeal !== undefined);
    assert.equal(dedupPtr.verifiedSeal.sha256, winnerPtr.sha256);
    assert.ok(dedupPtr.verifiedSeal.gitOid !== null);
    assert.equal(dedupPtr.verifiedSeal.dev, blobStat.dev);
    assert.equal(dedupPtr.verifiedSeal.ino, blobStat.ino);
    assert.equal(dedupPtr.verifiedSeal.ctimeMs, blobStat.ctimeMs);

    const reusedPtr = await rf.artifacts.tryReuseCasBlob(
      'packages/base-000.txt',
      winnerPtr.sha256,
      winnerPtr.byteLength,
      { gitObjectFormat: 'sha1' },
    );
    assert.ok(reusedPtr !== null);
    assert.ok(reusedPtr.verifiedSeal !== undefined);
    assert.equal(reusedPtr.verifiedSeal.ino, blobStat.ino);
    assert.equal(reusedPtr.verifiedSeal.gitOid, dedupPtr.verifiedSeal.gitOid);

    const entryRes = digestArtifactFromMetadata('packages/base-000.txt', {
      digest: { algorithm: 'sha256', hex: winnerPtr.sha256 },
      byteLength: winnerPtr.byteLength,
    });
    assert.equal(entryRes.ok, true);
    if (!entryRes.ok) throw new Error('expected ok');
    const manifest: ArtifactManifest = {
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'ArtifactManifest',
      metadata: { id: 'candidate' },
      spec: { baseTree: frozen.manifest.spec.baseTree!, entries: [entryRes.value], deleted: [] },
    };

    // 3. First assertCanonicalMinimalOverlay on fresh unsealed casFile hashes finalized 0o400 descriptor and attaches VERIFIED_CAS_SEAL;
    //    second assertCanonicalMinimalOverlay reuses that descriptor-minted seal without reading bytes again.
    const freshCasFile = {
      name: 'packages/base-000.txt',
      byteLength: winnerPtr.byteLength,
      digest: entryRes.value.digest,
      blobPath: winnerPtr.path,
      mode: '100644' as const,
    };
    assert.equal((freshCasFile as typeof freshCasFile & { [VERIFIED_CAS_SEAL]?: unknown })[VERIFIED_CAS_SEAL], undefined);

    const probeHandle = await open(winnerPtr.path, constants.O_RDONLY);
    const fileHandleProto = Object.getPrototypeOf(probeHandle) as {
      read: (...args: unknown[]) => Promise<unknown>;
    };
    await probeHandle.close();
    const origRead = fileHandleProto.read;
    let readCalls = 0;
    const readSpy = mock.method(fileHandleProto, 'read', function (this: unknown, ...args: unknown[]) {
      readCalls += 1;
      return origRead.apply(this, args);
    });
    try {
      await assertCanonicalMinimalOverlay(manifest, [freshCasFile], frozen, 'execution');
      const readsAfterFirst = readCalls;
      assert.ok(readsAfterFirst > 0, `expected first verification to hash finalized descriptor, got ${readsAfterFirst} reads`);
      const mintedSeal = (freshCasFile as typeof freshCasFile & { [VERIFIED_CAS_SEAL]?: { sha256: string; gitOid: string | null; ino: number } })[VERIFIED_CAS_SEAL];
      assert.ok(mintedSeal !== undefined);
      assert.equal(mintedSeal.sha256, winnerPtr.sha256);
      assert.equal(mintedSeal.gitOid, dedupPtr.verifiedSeal.gitOid);
      assert.equal(mintedSeal.ino, blobStat.ino);

      // Second verification reuses the descriptor-minted seal in O(1) without calling fh.read()
      await assertCanonicalMinimalOverlay(manifest, [freshCasFile], frozen, 'execution');
      assert.equal(readCalls, readsAfterFirst, 'expected second verification to reuse VERIFIED_CAS_SEAL without re-reading');
    } finally {
      readSpy.mock.restore();
    }

    // 4. Dedup-sealed casFile also validates cleanly
    const dedupCasFile = attachVerifiedCasSeal(
      {
        name: 'packages/base-000.txt',
        byteLength: dedupPtr.byteLength,
        digest: entryRes.value.digest,
        blobPath: dedupPtr.path,
        mode: '100644' as const,
      },
      dedupPtr.verifiedSeal,
    );
    await assertCanonicalMinimalOverlay(manifest, [dedupCasFile], frozen, 'execution');

    // 5. Replace <artifactsDir>/blobs/sha256/<hex> with a DIFFERENT same-size 0o400 single-link inode with wrong bytes
    const wrongBytes = Buffer.from('TAMPER-base-0!\n', 'utf8');
    assert.equal(wrongBytes.byteLength, editedBytes.byteLength);
    await unlink(winnerPtr.path);
    await writeFile(winnerPtr.path, wrongBytes, { mode: 0o400 });
    await chmod(winnerPtr.path, 0o400);
    const replacedStat = await lstat(winnerPtr.path);
    assert.equal(replacedStat.nlink, 1);
    assert.equal(replacedStat.size, editedBytes.byteLength);
    assert.equal(replacedStat.mode & 0o222, 0);

    // Both sealed and unsealed (fresh-winner) casFiles MUST detect the altered bytes and refuse RECOVERY_REQUIRED
    await assert.rejects(
      assertCanonicalMinimalOverlay(manifest, [freshCasFile], frozen, 'execution'),
      (err: unknown) =>
        err instanceof Error && 'diagnostic' in err && (err as { diagnostic: { code: string } }).diagnostic.code === 'RECOVERY_REQUIRED',
    );
    await assert.rejects(
      assertCanonicalMinimalOverlay(manifest, [dedupCasFile], frozen, 'execution'),
      (err: unknown) =>
        err instanceof Error && 'diagnostic' in err && (err as { diagnostic: { code: string } }).diagnostic.code === 'RECOVERY_REQUIRED',
    );
    const unsealedCasFile = {
      name: 'packages/base-000.txt',
      byteLength: winnerPtr.byteLength,
      digest: entryRes.value.digest,
      blobPath: winnerPtr.path,
      mode: '100644' as const,
    };
    await assert.rejects(
      assertCanonicalMinimalOverlay(manifest, [unsealedCasFile], frozen, 'execution'),
      (err: unknown) =>
        err instanceof Error && 'diagnostic' in err && (err as { diagnostic: { code: string } }).diagnostic.code === 'RECOVERY_REQUIRED',
    );
  } finally {
    await rf.close();
  }
});

test('R3-12: classic mode (source.version === 1) refuses mode-only chmod +x on host-protected and task-protected files even alongside a valid writable edit', async () => {
  const f = await configurationFixture();
  try {
    const repository = join(f.root, 'repo-classic-mode-guard');
    const runRoot = join(f.root, 'runs-classic-mode-guard');
    const rev = await createFastGitRepo(repository, {
      'packages/ok.md': { content: 'hello\n' },
      'packages/result.json': { content: JSON.stringify({ ok: true }) },
      '.github/CODEOWNERS': { content: '* @owners\n' },
      '.claude/settings.json': { content: '{"safe":true}\n' },
    });
    const installed = await installedHandlerDigests();
    setFixture(f.registry, ['spec', 'runtimeProfiles'], []);
    setFixture(f.registry, ['spec', 'credentialBindings'], []);
    setFixture(f.registry, ['spec', 'environmentBindings'], []);
    setFixture(f.registry, ['spec', 'roleProfiles'], [
      { id: 'author', adapter: 'delegated', runtimeRef: null, providerCredentialRef: null, selection: { provider: 'antigravity', model: 'gemini-4-carbon', thinking: 'high' }, tools: ['read', 'write', 'delete'], mcp: null },
      { id: 'reviewer', adapter: 'delegated', runtimeRef: null, providerCredentialRef: null, selection: { provider: 'antigravity', model: 'gemini-4-carbon', thinking: 'high' }, tools: ['read'], mcp: null },
    ]);
    setFixture(f.registry, ['spec', 'handlers'], [
      { id: 'author.h', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Author.', purpose: 'task' }, capabilities: ['pi'] },
      { id: 'review.h', kind: 'agent', implementation: 'pi.agent.v1', version: 1, digest: installed['pi.agent.v1'], parameters: { prompt: 'Review.', purpose: 'review' }, capabilities: ['pi'] },
      ...f.registry.spec.handlers.filter(h => h.id === 'tests' || h.id === 'scope' || h.id === 'no-change'),
    ]);
    setFixture(f.registry, ['spec', 'handlers', 2, 'parameters', 'path'], 'packages/result.json');
    setFixture(f.config, ['spec', 'credentials'], []);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], rev);
    setFixture(f.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], rev);
    setFixture(f.config, ['spec', 'task', 'spec', 'scope'], {
      writable: ['packages/**'],
      protected: ['.claude/**'],
    });
    setFixture(f.config, ['spec', 'task', 'spec', 'roles'], [
      { id: 'author', adapter: 'delegated', provider: 'antigravity', model: 'gemini-4-carbon', thinking: 'high', tools: ['read', 'write', 'delete'] },
      { id: 'reviewer', adapter: 'delegated', provider: 'antigravity', model: 'gemini-4-carbon', thinking: 'high', tools: ['read'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'roles'], [
      { roleId: 'author', profileRef: 'author' },
      { roleId: 'reviewer', profileRef: 'reviewer' },
    ]);
    setFixture(f.config, ['spec', 'task', 'spec', 'steps'], [
      { id: 'author', kind: 'agent', uses: 'author.h', roleId: 'author', dependsOn: [] },
      { id: 'review', kind: 'agent', uses: 'review.h', roleId: 'reviewer', dependsOn: ['author'] },
    ]);
    setFixture(f.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'author', handlerRef: 'author.h' },
      { stepId: 'review', handlerRef: 'review.h' },
    ]);
    f.input.untrustedRoots = [f.taskDirectory, repository];
    await f.save();
    const loaded = assertOk(await f.load(), 'load classic mode-guard fixture');

    const runId = 'run-r3-12-classic-mode';
    const y = assertStepYield(
      assertOk(
        await stepNext({
          configuration: loaded,
          repository,
          runRoot,
          runId,
          policyProfile: 'github',
          allowWorkflowWrites: false,
        }),
        'stepNext classic mode-guard',
      ),
    );

    // Legitimate edit to writable file (so candidateDigest changes!)
    await writeFile(join(y.candidateDir, 'packages', 'ok.md'), 'hello updated\n', { mode: 0o600 });

    // Case 1: Mode-only chmod 0o755 on host-protected .github/CODEOWNERS must be refused with ARTIFACT_INVALID
    const codeownersPath = join(y.candidateDir, '.github', 'CODEOWNERS');
    await chmod(codeownersPath, 0o755);
    const codeownersRefused = await stepSubmit({ runRoot, runId, leaseToken: y.leaseToken });
    assert.equal(codeownersRefused.ok, false);
    if (!codeownersRefused.ok) {
      assert.equal(codeownersRefused.error.code, 'ARTIFACT_INVALID');
    }
    await chmod(codeownersPath, 0o400);

    // Case 2: Mode-only chmod 0o755 on task-protected .claude/settings.json must also be refused with ARTIFACT_INVALID
    const claudeSettingsPath = join(y.candidateDir, '.claude', 'settings.json');
    await chmod(claudeSettingsPath, 0o755);
    const taskProtectedRefused = await stepSubmit({ runRoot, runId, leaseToken: y.leaseToken });
    assert.equal(taskProtectedRefused.ok, false);
    if (!taskProtectedRefused.ok) {
      assert.equal(taskProtectedRefused.error.code, 'ARTIFACT_INVALID');
    }
    await chmod(claudeSettingsPath, 0o400);

    // Case 3: With protected files restored to 0o400 (100644), the valid writable edit submits cleanly
    const reviewYield = assertStepYield(
      assertOk(await stepSubmit({ runRoot, runId, leaseToken: y.leaseToken }), 'stepSubmit clean edit'),
    );
    assert.equal(reviewYield.stepId, 'review');
  } finally {
    await f.cleanup();
  }
});
