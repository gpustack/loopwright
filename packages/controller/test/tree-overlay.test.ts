import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  admitTask,
  bindSubject,
  digestArtifact,
  identifyManifest,
  type ArtifactManifest,
  type ArtifactRef,
  type BaseTreeAnchor,
  type Subject,
  type TaskContract,
  type TaskLock,
} from '@loopwright/core';
import type { PiAdapterV2, PiErrorV2, PiHostV2, PiOpenInputV2, PiOutcomeV2 } from '@loopwright/agent-pi';
import { createLocalRun, reopenLocalRun } from '@loopwright/state';
import { compilePlan } from '../src/compile.js';
import { createCycle, Cycle, runCycleWithPorts, type RunDescriptor } from '../src/controller.js';
import { WorkDeadline } from '../src/deadlines.js';
import { resumeCycleWithPorts } from '../src/recovery.js';
import { approvedState } from '../src/config.js';
import { readStatus, inspectRun } from '../src/inspect.js';
import { ControllerFailure } from '../src/errors.js';
import { ControllerOwner } from '../src/ownership.js';
import { nativeSessionId } from '../src/capture.js';
import { phaseCheckpointId, ProgressStore, stableId } from '../src/progress.js';
import { checkedRefusalRecord, sizeJob, VerifierSizingFailure } from '../src/refusal-record.js';
import { canonical, hash, same } from '../src/schema.js';
import {
  assertCanonicalMinimalOverlay,
  freezeSource,
  materializeBaseline,
  parseSourceTree,
  restoreSource,
  verifySource,
  type FrozenSource,
} from '../src/source.js';
import { ArtifactStore, stateValue } from '../src/storage.js';
import { preflightVerification, prepareVerification, Verifier } from '../src/verification.js';
import {
  encodeInventory,
  encodePacket,
  evaluatePacket,
  JSON_FILE_BYTES,
  OVERLAY_INVENTORY_MAGIC,
  PACKET_BYTES,
  type VerifierHeader,
} from '../src/verifier-protocol.js';
import { configurationFixture } from './config-fixtures.js';
import { retainedFixture, setFixture } from './progress-fixtures.js';

function must<T>(res: { readonly ok: true; readonly value: T } | { readonly ok: false }): T {
  if (!res.ok) throw new Error('expected ok result');
  return res.value;
}

const GIT_ENV = {
  PATH: '/usr/bin:/bin',
  LANG: 'C',
  LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  HOME: '/nonexistent',
  GIT_TERMINAL_PROMPT: '0',
};

interface GitEntryInput {
  readonly path: string;
  readonly mode: '100644' | '100755' | '120000';
  readonly data: Buffer | string;
}

async function createFastGitRepo(
  baseDir: string,
  files: readonly GitEntryInput[],
  gitlinks: readonly { readonly path: string; readonly commitOid: string }[] = [],
) {
  const dir = join(baseDir, 'repo');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const git = (args: string[], input?: Buffer | string) =>
    execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: dir,
      env: GIT_ENV,
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
      timeout: 20_000,
    });

  git(['init', '-q']);
  const indexLines: string[] = [];
  for (const item of files) {
    const raw = typeof item.data === 'string' ? Buffer.from(item.data, 'utf8') : item.data;
    const oid = git(['hash-object', '-w', '--stdin'], raw).toString('utf8').trim();
    indexLines.push(`${item.mode} ${oid}\t${item.path}`);
  }
  for (const gl of gitlinks) {
    indexLines.push(`160000 ${gl.commitOid}\t${gl.path}`);
  }
  if (indexLines.length > 0) {
    git(['update-index', '--index-info'], Buffer.from(indexLines.join('\n') + '\n', 'utf8'));
  }
  const treeOid = git(['write-tree']).toString('utf8').trim();
  const commitOid = git(
    ['-c', 'user.name=T3 Fixture', '-c', 'user.email=t3@localhost.invalid', 'commit-tree', treeOid, '-m', 'seed'],
  ).toString('utf8').trim();
  git(['update-ref', 'HEAD', commitOid]);

  const realDir = await realpath(dir);
  return {
    directory: realDir,
    commitOid,
    treeOid,
    git,
    blob: (content: Buffer | string) =>
      git(['hash-object', '-w', '--stdin'], content).toString('utf8').trim(),
    catObject: (type: 'tree' | 'blob', oid: string) =>
      git(['cat-file', type, oid]),
    task: (
      protectedPaths: readonly string[] = ['.claude/**'],
      writablePaths: readonly string[] = ['src/**', 'pkg/**', 'writable.txt'],
      revision = commitOid,
    ): TaskContract => ({
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'TaskContract',
      spec: {
        goal: 'test-t3',
        taskpack: 'local',
        target: { repository: 'owner/t3-repo', baseRevision: revision, sourceRevision: revision, matrix: null },
        scope: { protected: [...protectedPaths], writable: [...writablePaths] },
        roles: [
          {
            id: 'coder',
            adapter: 'pi',
            provider: 'openai',
            model: 'gpt-4o',
            thinking: 'low',
            tools: ['read', 'write', 'edit', 'delete'],
          },
        ],
        trustedContext: { revision: 'ctx-1', discovery: 'disabled', resources: [] },
        budgets: {
          wallTimeMs: 60000,
          totalTokens: 10000,
          perCallOutputTokens: 2000,
          maxModelCalls: 5,
          maxConcurrency: 1,
          maxFormatRepairs: 1,
          maxImplementationRepairs: 1,
          maxTransportRetries: 1,
          enforcement: {
            wallTime: 'hard_admission',
            tokens: 'hard_admission',
            modelCalls: 'hard_admission',
            concurrency: 'hard_admission',
            formatRepairs: 'hard_admission',
            implementationRepairs: 'hard_admission',
            transportRetries: 'hard_admission',
          },
        },
        steps: [
          { id: 'implement', kind: 'agent', uses: 'coder', roleId: 'coder', dependsOn: [] },
          { id: 'check', kind: 'check', uses: 'tests', roleId: null, dependsOn: ['implement'] },
        ],
        acceptance: { required: ['tests'], checks: [{ id: 'tests', allowedEvidenceLevels: ['local_execution'] }] },
      },
    }),
  };
}

function makeFakeLock(task: TaskContract, runId = 't3-unit-run'): TaskLock {
  const admitted = admitTask(task, { admissionId: 'adm-t3', runId });
  if (!admitted.ok) throw new Error('admitTask failed');
  return admitted.value;
}

function configureJsonCheck(cfg: Awaited<ReturnType<typeof configurationFixture>>, jsonPath = 'config/settings.json') {
  const proto = cfg.registry.spec.handlers.find(h => h.implementation === 'json-artifact.v1')!;
  setFixture(cfg.registry, ['spec', 'handlers'], [
    ...cfg.registry.spec.handlers.filter(h => h.id !== 'json-check'),
    {
      ...proto,
      id: 'json-check',
      parameters: { ...proto.parameters, checkId: 'json-check', path: jsonPath, required: ['ok'], equals: { ok: true } },
    },
  ]);
  setFixture(cfg.config, ['spec', 'task', 'spec', 'steps'], [{ id: 'verify', kind: 'check', uses: 'json-check', roleId: null, dependsOn: [] }]);
  setFixture(cfg.config, ['spec', 'task', 'spec', 'acceptance'], {
    required: ['json-check'],
    checks: [{ id: 'json-check', allowedEvidenceLevels: ['local_execution'] }],
  });
  setFixture(cfg.config, ['spec', 'profiles', 'steps'], [{ stepId: 'verify', handlerRef: 'json-check' }]);
  setFixture(cfg.config, ['spec', 'credentials'], []);
}

test('T3 admission: 128-file classic boundary, auto-switch to version 2 at 240 files and > 32768 canonical manifest', async () => {
  const f = await retainedFixture();
  try {
    // 1. Classic exact 128-file boundary
    const classicEntries: GitEntryInput[] = Array.from({ length: 128 }, (_, i) => ({
      path: `src/f-${String(i).padStart(3, '0')}.txt`,
      mode: '100644',
      data: `content-${i}\n`,
    }));
    const rClassic = await createFastGitRepo(join(f.root, 'c128'), classicEntries);
    const frozenClassic = await freezeSource(rClassic.directory, rClassic.task(), f.owner, f.artifacts);
    assert.equal(frozenClassic.version, 1);
    assert.equal(frozenClassic.artifacts.length, 128);
    assert.equal(frozenClassic.manifest.spec.baseTree, undefined);

    // 2. 240 files (< 4 MiB total) auto-switches to version 2 tree_overlay
    const overlayEntries: GitEntryInput[] = Array.from({ length: 240 }, (_, i) => ({
      path: `src/g-${String(i).padStart(3, '0')}.txt`,
      mode: '100644',
      data: `item-${i}\n`,
    }));
    const r240 = await createFastGitRepo(join(f.root, 'o240'), overlayEntries);
    const frozen240 = await freezeSource(r240.directory, r240.task(), f.owner, f.artifacts);
    assert.equal(frozen240.version, 2);
    assert.equal(frozen240.artifacts.length, 0);
    assert.equal(frozen240.manifest.spec.entries.length, 0);
    assert.deepEqual({ ...frozen240.manifest.spec.baseTree }, {
      objectFormat: 'sha1',
      commitOid: r240.commitOid,
      treeOid: r240.treeOid,
    });
    assert.deepEqual(frozen240.manifest.spec.deleted, []);
    assert.equal(frozen240.baselineEntries?.length, 240);
    assert.ok(frozen240.sourceTree);

    // Verify sourceTree NDJSON parses back accurately & restoreSource recovers v2
    const ndjson = await f.artifacts.read(frozen240.sourceTree, 8 * 1024 * 1024);
    const parsed = parseSourceTree(ndjson, 'sha1');
    assert.equal(parsed.length, 240);
    await verifySource(frozen240, r240.task(), f.owner);
    const restored = await restoreSource(
      r240.directory,
      r240.task(),
      f.owner,
      f.artifacts,
      frozen240.inventory,
      frozen240.workspace,
    );
    assert.equal(restored.version, 2);
    assert.equal(restored.baselineEntries?.length, 240);

    // 3. <= 128 files with long paths making canonical(manifest) > 32768 auto-switches to v2 with 0 classic file artifacts stored and <= 6 git calls
    const longPathEntries: GitEntryInput[] = Array.from({ length: 120 }, (_, i) => ({
      path: `src/${'segment-'.repeat(24)}-${String(i).padStart(3, '0')}.txt`,
      mode: '100644',
      data: Buffer.from(`unique-long-body-${i}`),
    }));
    const rLong = await createFastGitRepo(join(f.root, 'long-manifest'), longPathEntries);
    const beforeLongIntents = (await readFile(f.owner.path, 'utf8')).trim().split('\n').length;
    const frozenLong = await freezeSource(rLong.directory, rLong.task(), f.owner, f.artifacts);
    const longRows = (await readFile(f.owner.path, 'utf8')).trim().split('\n').slice(beforeLongIntents).map(line => JSON.parse(line) as { type: string });
    assert.ok(longRows.filter(row => row.type === 'intent').length <= 6);
    assert.equal(frozenLong.version, 2);
    assert.equal(frozenLong.artifacts.length, 0);
    assert.equal(frozenLong.baselineEntries?.length, 120);
  } finally {
    await f.close();
  }
});

test('T3 topology: protected 120000/160000 skip vs case/NFC-NFD/prefix collisions refuse in <= 4 git intents', async () => {
  const f = await retainedFixture();
  try {
    const rSub = await createFastGitRepo(join(f.root, 'subsrc'), [
      { path: 'sub.txt', mode: '100644', data: 'sub' },
    ]);

    // Case-insensitive collision
    const rCase = await createFastGitRepo(
      join(f.root, 'case-collision'),
      [
        { path: 'src/Readme.md', mode: '100644', data: 'a' },
        { path: 'src/readme.md', mode: '100644', data: 'b' },
        { path: '.claude/link', mode: '120000', data: 'target' },
      ],
      [{ path: '.codex/sub', commitOid: rSub.commitOid }],
    );
    const beforeCase = (await readFile(f.owner.path, 'utf8')).split('\n').length;
    await assert.rejects(
      freezeSource(rCase.directory, rCase.task(['.claude/**', '.codex/**']), f.owner, f.artifacts),
      (err: unknown) => err instanceof ControllerFailure && err.diagnostic.code === 'CAPABILITY_UNSUPPORTED' && err.diagnostic.phase === 'admission',
    );
    const caseRows = (await readFile(f.owner.path, 'utf8')).trim().split('\n').slice(beforeCase - 1).map(l => JSON.parse(l) as { type: string });
    assert.equal(caseRows.filter(r => r.type === 'intent').length, 4);

    // Unicode NFC vs NFD collision
    const rUnicode = await createFastGitRepo(join(f.root, 'unicode-collision'), [
      { path: 'src/caf\u00e9.ts', mode: '100644', data: 'nfc' },
      { path: 'src/cafe\u0301.ts', mode: '100644', data: 'nfd' },
    ]);
    await assert.rejects(
      freezeSource(rUnicode.directory, rUnicode.task(), f.owner, f.artifacts),
      (err: unknown) => err instanceof ControllerFailure && err.diagnostic.code === 'CAPABILITY_UNSUPPORTED',
    );

    // Directory-vs-file prefix collision (even case-folded: 'src/Foo' vs 'src/foo/bar.ts')
    const rPrefix = await createFastGitRepo(join(f.root, 'prefix-collision'), [
      { path: 'src/Foo', mode: '100644', data: 'file' },
      { path: 'src/foo/bar.ts', mode: '100644', data: 'nested' },
    ]);
    await assert.rejects(
      freezeSource(rPrefix.directory, rPrefix.task(), f.owner, f.artifacts),
      (err: unknown) => err instanceof ControllerFailure && err.diagnostic.code === 'CAPABILITY_UNSUPPORTED',
    );
  } finally {
    await f.close();
  }
});

test('T3 raw cat-file --batch materialization ignores .gitattributes eol/ident/filter and enforces O_NOFOLLOW + 0o444/0o555', async () => {
  const f = await retainedFixture();
  try {
    const rawLfIdent = Buffer.from('line1\nline2 $Id$\nline3\n', 'utf8');
    const scriptBytes = Buffer.from('#!/bin/sh\necho raw\n', 'utf8');
    const files: GitEntryInput[] = [
      { path: '.gitattributes', mode: '100644', data: '* eol=crlf ident filter=trap\n' },
      { path: 'src/raw.txt', mode: '100644', data: rawLfIdent },
      { path: 'src/bin/run.sh', mode: '100755', data: scriptBytes },
      ...Array.from({ length: 140 }, (_, i) => ({
        path: `src/pad/p-${String(i).padStart(3, '0')}.txt`,
        mode: '100644' as const,
        data: `p-${i}`,
      })),
    ];
    const r = await createFastGitRepo(join(f.root, 'rawbatch'), files);
    const frozen = await freezeSource(r.directory, r.task(), f.owner, f.artifacts);
    assert.equal(frozen.version, 2);

    const baselineDir = join(f.root, 'materialized-baseline');
    await materializeBaseline(frozen, baselineDir, f.owner, new AbortController().signal);

    // Verify exact raw bytes (no CRLF conversion, no $Id$ expansion, no filter=trap execution)
    const matRaw = await readFile(join(baselineDir, 'src/raw.txt'));
    assert.deepEqual(matRaw, rawLfIdent);
    const rawStat = await lstat(join(baselineDir, 'src/raw.txt'));
    assert.equal(rawStat.mode & 0o777, 0o444);

    const matScript = await readFile(join(baselineDir, 'src/bin/run.sh'));
    assert.deepEqual(matScript, scriptBytes);
    const scriptStat = await lstat(join(baselineDir, 'src/bin/run.sh'));
    assert.equal(scriptStat.mode & 0o777, 0o555);

    // Ensure no .git directory leaked into materialized baseline
    await assert.rejects(lstat(join(baselineDir, '.git')), (err: NodeJS.ErrnoException) => err.code === 'ENOENT');

    // Re-materializing over stale directory cleanly replaces it
    await chmod(join(baselineDir, 'src/raw.txt'), 0o600);
    await materializeBaseline(frozen, baselineDir, f.owner, new AbortController().signal);
    assert.equal((await lstat(join(baselineDir, 'src/raw.txt'))).mode & 0o777, 0o444);
  } finally {
    await f.close();
  }
});

test('T3 restoreSource and verifySource detect v2 sourceTree/treeOid drift with TARGET_MISMATCH', async () => {
  const f = await retainedFixture();
  try {
    const entries: GitEntryInput[] = Array.from({ length: 150 }, (_, i) => ({
      path: `src/f-${String(i).padStart(3, '0')}.txt`,
      mode: '100644',
      data: `data-${i}`,
    }));
    const r = await createFastGitRepo(join(f.root, 'drift'), entries);
    const frozen = await freezeSource(r.directory, r.task(), f.owner, f.artifacts);
    assert.equal(frozen.version, 2);

    const tamperedSource: FrozenSource = {
      ...frozen,
      manifest: {
        ...frozen.manifest,
        spec: {
          ...frozen.manifest.spec,
          baseTree: {
            objectFormat: 'sha1',
            commitOid: r.commitOid,
            treeOid: '0'.repeat(40),
          },
          entries: frozen.manifest.spec.entries,
          deleted: frozen.manifest.spec.deleted ?? [],
        },
      },
    };
    await assert.rejects(
      verifySource(tamperedSource, r.task(), f.owner),
      (err: unknown) => err instanceof ControllerFailure && err.diagnostic.code === 'TARGET_MISMATCH',
    );

    // Tamper stored workspace JSON so source-tree ref is missing -> ARTIFACT_INVALID
    const badWorkspace = await f.artifacts.json('bad-ws', { version: 2, manifest: frozen.manifest }, 32768);
    await assert.rejects(
      restoreSource(r.directory, r.task(), f.owner, f.artifacts, frozen.inventory, badWorkspace),
      (err: unknown) => err instanceof ControllerFailure && err.diagnostic.code === 'ARTIFACT_INVALID',
    );

    // Mutate the git ref after admission so sourceTree/treeOid drifts -> TARGET_MISMATCH
    r.git(['update-ref', 'refs/heads/source', r.commitOid]);
    const refTask = r.task(['.claude/**'], ['src/**'], 'refs/heads/source');
    const frozenRef = await freezeSource(r.directory, refTask, f.owner, f.artifacts);
    const driftFiles = Array.from({ length: 150 }, (_, i) => ({
      path: `src/f-${String(i).padStart(3, '0')}.txt`,
      mode: '100644' as const,
      data: i === 0 ? 'drifted' : `data-${i}`,
    }));
    const rDrift = await createFastGitRepo(join(f.root, 'drift-ref'), driftFiles);
    r.git(['fetch', rDrift.directory, rDrift.commitOid]);
    r.git(['update-ref', 'refs/heads/source', rDrift.commitOid]);
    await assert.rejects(
      restoreSource(r.directory, refTask, f.owner, f.artifacts, frozenRef.inventory, frozenRef.workspace),
      (err: unknown) => err instanceof ControllerFailure && err.diagnostic.code === 'TARGET_MISMATCH',
    );
  } finally {
    await f.close();
  }
});

test('T3 minimal-overlay invariants reject non-minimal overlays and adoptRoleCapture enforces them', async () => {
  const f = await retainedFixture();
  try {
    const entries: GitEntryInput[] = Array.from({ length: 140 }, (_, i) => ({
      path: `src/item-${String(i).padStart(3, '0')}.txt`,
      mode: '100644',
      data: `body-${i}`,
    }));
    const r = await createFastGitRepo(join(f.root, 'minimal'), entries);
    const frozen = await freezeSource(r.directory, r.task(), f.owner, f.artifacts);
    const baseTree = frozen.manifest.spec.baseTree!;

    // 1. Delete nonexistent path -> RECOVERY_REQUIRED
    const ghostDelManifest = identifyManifest({
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'ArtifactManifest',
      metadata: { id: 'candidate' },
      spec: { baseTree, entries: [], deleted: ['src/does-not-exist.txt'] },
    });
    assert.equal(ghostDelManifest.ok, true);
    if (!ghostDelManifest.ok) throw new Error('expected ok');
    assert.throws(
      () => assertCanonicalMinimalOverlay(ghostDelManifest.value.manifest, [], frozen, 'recovery'),
      (err: unknown) => err instanceof ControllerFailure && err.diagnostic.code === 'RECOVERY_REQUIRED' && err.diagnostic.phase === 'recovery',
    );

    // 2. Re-emit unchanged baseline bytes in entries (identical git blob OID) -> RECOVERY_REQUIRED
    const unchangedBytes = Buffer.from('body-0', 'utf8');
    const unchangedRef = digestArtifact('src/item-000.txt', unchangedBytes);
    assert.equal(unchangedRef.ok, true);
    if (!unchangedRef.ok) throw new Error('expected ok');
    const noopEditManifest = identifyManifest({
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'ArtifactManifest',
      metadata: { id: 'candidate' },
      spec: { baseTree, entries: [unchangedRef.value], deleted: [] },
    });
    assert.equal(noopEditManifest.ok, true);
    if (!noopEditManifest.ok) throw new Error('expected ok');
    assert.throws(
      () => assertCanonicalMinimalOverlay(noopEditManifest.value.manifest, [{ name: 'src/item-000.txt', bytes: unchangedBytes }], frozen, 'execution'),
      (err: unknown) => err instanceof ControllerFailure && err.diagnostic.code === 'RECOVERY_REQUIRED',
    );

    // 3. Mismatched baseTree -> RECOVERY_REQUIRED
    const wrongBaseManifest = identifyManifest({
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'ArtifactManifest',
      metadata: { id: 'candidate' },
      spec: { baseTree: { ...baseTree, treeOid: 'f'.repeat(40) }, entries: [], deleted: [] },
    });
    assert.equal(wrongBaseManifest.ok, true);
    if (!wrongBaseManifest.ok) throw new Error('expected ok');
    assert.throws(
      () => assertCanonicalMinimalOverlay(wrongBaseManifest.value.manifest, [], frozen, 'recovery'),
      (err: unknown) => err instanceof ControllerFailure && err.diagnostic.code === 'RECOVERY_REQUIRED',
    );

    // 4. Case-insensitive / prefix collision against surviving baseline path -> RECOVERY_REQUIRED
    const caseCollisionBytes = Buffer.from('new-body', 'utf8');
    const caseCollisionRef = digestArtifact('src/ITEM-000.txt', caseCollisionBytes);
    assert.equal(caseCollisionRef.ok, true);
    if (!caseCollisionRef.ok) throw new Error('expected ok');
    const collisionManifest = identifyManifest({
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'ArtifactManifest',
      metadata: { id: 'candidate' },
      spec: { baseTree, entries: [caseCollisionRef.value], deleted: [] },
    });
    assert.equal(collisionManifest.ok, true);
    if (!collisionManifest.ok) throw new Error('expected ok');
    assert.throws(
      () => assertCanonicalMinimalOverlay(collisionManifest.value.manifest, [{ name: 'src/ITEM-000.txt', bytes: caseCollisionBytes }], frozen, 'recovery'),
      (err: unknown) => err instanceof ControllerFailure && err.diagnostic.code === 'RECOVERY_REQUIRED',
    );
  } finally {
    await f.close();
  }
});

test('T3 role registry: compilePlan admits ["read", "delete"] role toolset', async () => {
  const cfg = await configurationFixture();
  try {
    setFixture(cfg.registry, ['spec', 'roleProfiles', 0, 'tools'], ['read', 'delete']);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'roles', 0, 'tools'], ['read', 'delete']);
    await cfg.save();
    const loaded = await cfg.load();
    assert.equal(loaded.ok, true, JSON.stringify(loaded));
    if (!loaded.ok) return;
    const plan = await compilePlan(loaded.value);
    assert.equal(plan.ok, true, JSON.stringify(plan));
    if (!plan.ok) return;
    assert.deepEqual(plan.value.roles[0]?.policy.tools, ['read', 'delete']);
  } finally {
    await cfg.cleanup();
  }
});

test('T3 verifier-protocol: 0x4c574f56 framing, mixed shapes, truncation, no-change.v1 and scope.v1 on deleted paths', async () => {
  const cfg = await configurationFixture();
  try {
    const r = await createFastGitRepo(join(cfg.root, 'vp'), [
      { path: 'src/keep.txt', mode: '100644', data: 'keep' },
      { path: '.claude/secret.txt', mode: '100644', data: 'secret' },
    ]);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], r.commitOid);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], r.commitOid);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'scope', 'protected'], [...new Set([...cfg.config.spec.task.spec.scope.protected, '.claude/**'])]);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'scope', 'writable'], ['src/**']);
    await cfg.save();
    const cfgLoaded = await cfg.load();
    assert.equal(cfgLoaded.ok, true, JSON.stringify(cfgLoaded));
    if (!cfgLoaded.ok) return;
    const task = must(await compilePlan(cfgLoaded.value)).task;
    const lock = makeFakeLock(task);

    const baseTree: BaseTreeAnchor = { objectFormat: 'sha1', commitOid: r.commitOid, treeOid: r.treeOid };
    const sourceManifest = identifyManifest({
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'ArtifactManifest',
      metadata: { id: 'source' },
      spec: { baseTree, entries: [], deleted: [] },
    });
    const classicSource = identifyManifest({
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'ArtifactManifest',
      metadata: { id: 'source' },
      spec: { entries: [] },
    });
    const deletedWritableManifest = identifyManifest({
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'ArtifactManifest',
      metadata: { id: 'candidate' },
      spec: { baseTree, entries: [], deleted: ['src/keep.txt'] },
    });
    const deletedProtectedManifest = identifyManifest({
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'ArtifactManifest',
      metadata: { id: 'candidate' },
      spec: { baseTree, entries: [], deleted: ['.claude/secret.txt'] },
    });
    assert.ok(sourceManifest.ok && classicSource.ok && deletedWritableManifest.ok && deletedProtectedManifest.ok);

    // 1. Verify binary magic 0x4c574f56
    const encodedOverlay = encodeInventory(deletedWritableManifest.value.manifest);
    assert.equal(new DataView(encodedOverlay.buffer).getUint32(0), OVERLAY_INVENTORY_MAGIC);

    // 2. Verify no-change.v1 catches delete-only overlay as candidate_changed
    const srcManifest = sourceManifest.value.manifest;
    const delWritManifest = deletedWritableManifest.value.manifest;
    const delProtManifest = deletedProtectedManifest.value.manifest;
    const srcRef = must(digestArtifact('manifest.json', Buffer.from(canonical(srcManifest))));
    const delWritRef = must(digestArtifact('manifest.json', Buffer.from(canonical(delWritManifest))));
    const delProtRef = must(digestArtifact('manifest.json', Buffer.from(canonical(delProtManifest))));
    const subjectWrit = must(bindSubject(lock, delWritManifest));
    const subjectProt = must(bindSubject(lock, delProtManifest));

    const buildInventoriesPacket = (
      handler: 'no-change.v1' | 'scope.v1',
      sM: ArtifactManifest,
      sR: ArtifactRef,
      cM: ArtifactManifest,
      cR: ArtifactRef,
      subj: Subject,
      params: Record<string, unknown>,
    ) => {
      const header: VerifierHeader = {
        version: 1,
        jobId: 'job.' + 'a'.repeat(40),
        handler,
        handlerVersion: 1,
        handlerDigest: hash(handler),
        checkId: 'check-t3',
        producerNonce: 'b'.repeat(32),
        operationId: 'op.' + 'c'.repeat(40),
        dispatchId: 'unbound',
        generation: 0,
        subject: subj,
        source: { metadataId: sM.metadata.id, ref: sR, entryCount: sM.spec.entries.length },
        candidate: { metadataId: cM.metadata.id, ref: cR, entryCount: cM.spec.entries.length },
        parameters: params as VerifierHeader['parameters'],
        payloadKind: 'inventories',
      };
      const first = encodeInventory(sM), second = encodeInventory(cM);
      const payload = new Uint8Array(first.byteLength + second.byteLength);
      payload.set(first); payload.set(second, first.byteLength);
      return encodePacket(header, payload);
    };

    const noChangeReply = evaluatePacket(
      buildInventoriesPacket('no-change.v1', srcManifest, srcRef, delWritManifest, delWritRef, subjectWrit, {}),
    );
    assert.equal(noChangeReply.status, 'failed');
    assert.equal(noChangeReply.reason, 'candidate_changed');

    // 3. scope.v1 allows writable delete and rejects protected delete as outside_scope
    const scopePass = evaluatePacket(
      buildInventoriesPacket('scope.v1', srcManifest, srcRef, delWritManifest, delWritRef, subjectWrit, { contract: task }),
    );
    assert.equal(scopePass.status, 'passed');

    const scopeFail = evaluatePacket(
      buildInventoriesPacket('scope.v1', srcManifest, srcRef, delProtManifest, delProtRef, subjectProt, { contract: task }),
    );
    assert.equal(scopeFail.status, 'failed');
    assert.equal(scopeFail.reason, 'outside_scope');

    // 4. Reject mixed classic + overlay inventory shapes with ARTIFACT_INVALID
    const classicRef = must(digestArtifact('manifest.json', Buffer.from(canonical(classicSource.value.manifest))));
    assert.throws(
      () => evaluatePacket(
        buildInventoriesPacket('no-change.v1', classicSource.value.manifest, classicRef, delWritManifest, delWritRef, subjectWrit, {}),
      ),
      (err: unknown) => err instanceof ControllerFailure && err.diagnostic.code === 'ARTIFACT_INVALID',
    );

    // 5. Reject truncated overlay inventory with ARTIFACT_INVALID
    const validPacket = buildInventoriesPacket('no-change.v1', srcManifest, srcRef, delWritManifest, delWritRef, subjectWrit, {});
    const truncated = new Uint8Array(validPacket.subarray(0, validPacket.byteLength - 1));
    assert.throws(
      () => evaluatePacket(truncated),
      (err: unknown) => err instanceof ControllerFailure && err.diagnostic.code === 'ARTIFACT_INVALID',
    );
  } finally {
    await cfg.cleanup();
  }
});

test('T3 json-artifact.v1: Merkle proof verification, tamper detection, deleted/absent handling, and VerifierSizingFailure bounds', async () => {
  const cfg = await configurationFixture();
  try {
    configureJsonCheck(cfg, 'a/b/config.json');
    const jsonBytes = Buffer.from(canonical({ ok: true, nested: { v: 1 } }), 'utf8');
    const repoFiles: GitEntryInput[] = [
      { path: 'a/b/config.json', mode: '100644', data: jsonBytes },
      ...Array.from({ length: 140 }, (_, i) => ({
        path: `src/f-${String(i).padStart(3, '0')}.txt`,
        mode: '100644' as const,
        data: `x-${i}`,
      })),
    ];
    const r = await createFastGitRepo(join(cfg.root, 'merkle'), repoFiles);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], r.commitOid);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], r.commitOid);
    await cfg.save();
    const loaded = await cfg.load();
    assert.equal(loaded.ok, true, JSON.stringify(loaded));
    if (!loaded.ok) return;

    const planRes = await compilePlan(loaded.value);
    assert.equal(planRes.ok, true);
    if (!planRes.ok) return;
    const plan = planRes.value;
    const lock = makeFakeLock(plan.task, 'merkle-test');

    const ownerDir = join(cfg.root, 'owner');
    await mkdir(ownerDir, { mode: 0o700 });
    const owner = await (await import('../src/ownership.js')).ControllerOwner.acquire(ownerDir, 'merkle-test', plan.planDigest);
    const artDir = join(cfg.root, 'artifacts');
    await mkdir(artDir, { mode: 0o700 });
    const artifacts = new ArtifactStore(artDir, owner, approvedState(loaded.value).vault);
    try {
      const frozen = await freezeSource(r.directory, plan.task, owner, artifacts, ['a/b/config.json']);
      assert.equal(frozen.version, 2);
      const proof = frozen.baselineProofs?.['a/b/config.json'];
      assert.ok(proof);
      assert.equal(proof.trees.length, 3); // root -> a -> b

      const srcRef = await artifacts.json('manifest', frozen.manifest, 32768);
      const sourceInv = { manifest: frozen.manifest, ref: srcRef, files: frozen.artifacts, baselineProofs: frozen.baselineProofs };

      // 1. Valid untouched nested JSON via Merkle proof -> passes via prepareVerification + Worker evaluatePacket
      // Reconstruct packet using exact header/payload via encodePacket on extracted proof to test evaluatePacket directly too
      const slot = plan.verifierSlots.find(s => s.handler.implementation === 'json-artifact.v1')!;
      const prepOk = prepareVerification(plan, lock, slot.id, sourceInv, sourceInv, 0, 'a'.repeat(32));
      assert.ok(prepOk.packetBytes <= PACKET_BYTES);

      // Direct evaluatePacket with valid Merkle proof
      const baseTree = frozen.manifest.spec.baseTree!;
      const subject = must(bindSubject(lock, frozen.manifest));
      const buildProofPacket = (trees: readonly Uint8Array[], blob: Uint8Array, expectedObj: unknown = { baseline: true, mode: proof.mode, oid: proof.oid, byteLength: proof.byteLength }) => {
        const hdr: VerifierHeader = {
          version: 1,
          jobId: 'job.' + 'd'.repeat(40),
          handler: 'json-artifact.v1',
          handlerVersion: 1,
          handlerDigest: slot.handler.digest,
          checkId: slot.checkId,
          producerNonce: 'a'.repeat(32),
          operationId: 'op.' + 'e'.repeat(40),
          dispatchId: 'unbound',
          generation: 0,
          subject,
          source: { metadataId: frozen.manifest.metadata.id, ref: srcRef, entryCount: 0 },
          candidate: { metadataId: frozen.manifest.metadata.id, ref: srcRef, entryCount: 0 },
          parameters: { path: 'a/b/config.json', expected: expectedObj, required: ['ok'], equals: { ok: true }, sourceManifest: frozen.manifest, candidateManifest: frozen.manifest } as unknown as VerifierHeader['parameters'],
          payloadKind: 'json',
        };
        const treesLen = trees.reduce((s, t) => s + 4 + t.byteLength, 0);
        const payload = new Uint8Array(4 + blob.byteLength + 4 + treesLen);
        const view = new DataView(payload.buffer);
        let off = 0;
        view.setUint32(off, blob.byteLength); off += 4;
        payload.set(blob, off); off += blob.byteLength;
        view.setUint32(off, trees.length); off += 4;
        for (const t of trees) { view.setUint32(off, t.byteLength); off += 4; payload.set(t, off); off += t.byteLength; }
        return encodePacket(hdr, payload);
      };

      const passReply = evaluatePacket(buildProofPacket(proof.trees, proof.blob));
      assert.equal(passReply.status, 'passed');
      assert.equal(passReply.reason, null);
      assert.equal(passReply.method, 'verify_json');

      // 2. Tamper one byte in tree[1] -> evaluatePacket rejects ARTIFACT_INVALID
      const badTree = new Uint8Array(proof.trees[1]!);
      badTree[badTree.length - 1] = badTree.at(-1)! ^ 0x01;
      assert.throws(
        () => evaluatePacket(buildProofPacket([proof.trees[0]!, badTree, proof.trees[2]!], proof.blob)),
        (err: unknown) => err instanceof ControllerFailure && err.diagnostic.code === 'ARTIFACT_INVALID',
      );

      // 3. Deleted baseline file -> prepareVerification + evaluatePacket produces missing_file
      const delManifest = identifyManifest({
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'ArtifactManifest',
        metadata: { id: 'candidate' },
        spec: { baseTree, entries: [], deleted: ['a/b/config.json'] },
      });
      assert.equal(delManifest.ok, true);
      if (!delManifest.ok) throw new Error('expected ok');
      const delRef = await artifacts.json('manifest', delManifest.value.manifest, 32768);
      const delPrep = prepareVerification(plan, lock, slot.id, sourceInv, { manifest: delManifest.value.manifest, ref: delRef, files: [] }, 0, 'b'.repeat(32));
      assert.ok(delPrep.packetBytes < PACKET_BYTES);

      // 4. VerifierSizingFailure bounds: treeProofBytes = 262144 vs 262145 and treeCount = 16 vs 17
      const exact262144Source = {
        ...sourceInv,
        baselineProofs: {
          'a/b/config.json': { ...proof, trees: [new Uint8Array(262_144)] },
        },
      };
      const prepExactBytes = prepareVerification(plan, lock, slot.id, exact262144Source, sourceInv, 0, 'c'.repeat(32));
      assert.ok(prepExactBytes.packetBytes <= PACKET_BYTES);

      const oversizeTreesSource = {
        ...sourceInv,
        baselineProofs: {
          'a/b/config.json': { ...proof, trees: [new Uint8Array(262_145)] },
        },
      };
      assert.throws(
        () => prepareVerification(plan, lock, slot.id, oversizeTreesSource, sourceInv, 0, 'c'.repeat(32)),
        (err: unknown) => err instanceof VerifierSizingFailure && err.sizing.reason === 'tree_proof_bytes' && err.sizing.allowed === 262_144 && err.sizing.actual === 262_145,
      );

      const exact16TreesSource = {
        ...sourceInv,
        baselineProofs: {
          'a/b/config.json': { ...proof, trees: Array.from({ length: 16 }, () => new Uint8Array(10)) },
        },
      };
      const prepExactDepth = prepareVerification(plan, lock, slot.id, exact16TreesSource, sourceInv, 0, 'd'.repeat(32));
      assert.ok(prepExactDepth.packetBytes <= PACKET_BYTES);

      const seventeenTreesSource = {
        ...sourceInv,
        baselineProofs: {
          'a/b/config.json': { ...proof, trees: Array.from({ length: 17 }, () => new Uint8Array(10)) },
        },
      };
      assert.throws(
        () => prepareVerification(plan, lock, slot.id, seventeenTreesSource, sourceInv, 0, 'd'.repeat(32)),
        (err: unknown) => err instanceof VerifierSizingFailure && err.sizing.reason === 'tree_proof_depth' && err.sizing.allowed === 16 && err.sizing.actual === 17,
      );

      // 5. Oversize baseline JSON file (JSON_FILE_BYTES + 1) -> json_file_bytes refusal passes sizeJob + checkedRefusalRecord
      const bigBlob = Buffer.alloc(JSON_FILE_BYTES + 1, 0x20);
      const bigOid = createHash('sha1').update(`blob ${bigBlob.byteLength}\0`).update(bigBlob).digest('hex');
      const oversizeJsonSource = {
        ...sourceInv,
        baselineProofs: {
          'a/b/config.json': { ...proof, oid: bigOid, byteLength: bigBlob.byteLength, blob: bigBlob },
        },
      };
      let caughtSizing: VerifierSizingFailure | null = null;
      try {
        prepareVerification(plan, lock, slot.id, oversizeJsonSource, sourceInv, 0, 'e'.repeat(32));
      } catch (err) {
        if (err instanceof VerifierSizingFailure) caughtSizing = err;
        else throw err;
      }
      assert.ok(caughtSizing);
      assert.equal(caughtSizing.sizing.reason, 'json_file_bytes');
      assert.equal(caughtSizing.sizing.actual, JSON_FILE_BYTES + 1);
      assert.equal(caughtSizing.sizing.payloadBytes, 4 + JSON_FILE_BYTES + 1);

      // Ensure refusal record constructed from this VerifierSizingFailure passes checkedRefusalRecord
      const hdrForRefusal: VerifierHeader = {
        version: 1,
        jobId: 'job.' + 'f'.repeat(40),
        handler: 'json-artifact.v1',
        handlerVersion: 1,
        handlerDigest: slot.handler.digest,
        checkId: slot.checkId,
        producerNonce: 'e'.repeat(32),
        operationId: 'op.' + 'a'.repeat(40),
        dispatchId: 'unbound',
        generation: 0,
        subject,
        source: { metadataId: frozen.manifest.metadata.id, ref: srcRef, entryCount: 0 },
        candidate: { metadataId: frozen.manifest.metadata.id, ref: srcRef, entryCount: 0 },
        parameters: {} as VerifierHeader['parameters'],
        payloadKind: 'json',
      };
      assert.throws(
        () => sizeJob(hdrForRefusal, JSON_FILE_BYTES + 100, JSON_FILE_BYTES + 1),
        (err: unknown) => err instanceof VerifierSizingFailure && err.sizing.reason === 'json_file_bytes',
      );
    } finally {
      await owner.release();
    }
  } finally {
    await cfg.cleanup();
  }
});

test('T3 E2E 600-file tree_overlay cycle: raw baseline materialization, delete+edit role, crash resume, and inspect', async () => {
  const cfg = await configurationFixture();
  try {
    const rawLfIdent = Buffer.from('alpha\n$Id$\n', 'utf8');
    const jsonBytes = Buffer.from(canonical({ ok: true }), 'utf8');
    const files: GitEntryInput[] = [
      { path: '.gitattributes', mode: '100644', data: '* eol=crlf ident filter=trap\n' },
      { path: '.claude/protected-link', mode: '120000', data: '../shared' },
      { path: 'config/settings.json', mode: '100644', data: jsonBytes },
      { path: 'src/exec.sh', mode: '100755', data: '#!/bin/sh\nexit 0\n' },
      { path: 'src/raw.txt', mode: '100644', data: rawLfIdent },
      { path: 'src/delete-me.txt', mode: '100644', data: 'to be deleted' },
      { path: 'src/edit-me.txt', mode: '100644', data: 'before' },
      ...Array.from({ length: 595 }, (_, i) => ({
        path: `src/batch/file-${String(i).padStart(4, '0')}.txt`,
        mode: '100644' as const,
        data: `baseline-content-${i}`,
      })),
    ];
    const r = await createFastGitRepo(join(cfg.root, 'e2e600'), files);
    const runRoot = join(cfg.root, 'runs');
    await mkdir(runRoot, { mode: 0o700 });

    setFixture(cfg.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], r.commitOid);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], r.commitOid);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'scope', 'protected'], [...new Set([...cfg.config.spec.task.spec.scope.protected, '.claude/**'])]);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'scope', 'writable'], ['src/**']);
    setFixture(cfg.registry, ['spec', 'roleProfiles', 0, 'tools'], ['read', 'write', 'edit', 'delete']);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'roles', 0, 'tools'], ['read', 'write', 'edit', 'delete']);
    const proto = cfg.registry.spec.handlers.find(h => h.implementation === 'json-artifact.v1')!;
    setFixture(cfg.registry, ['spec', 'handlers'], [
      ...cfg.registry.spec.handlers.filter(h => h.id !== 'json-check'),
      {
        ...proto,
        id: 'json-check',
        parameters: { ...proto.parameters, checkId: 'json-check', path: 'config/settings.json', required: ['ok'], equals: { ok: true } },
      },
    ]);
    const roleStep = cfg.config.spec.task.spec.steps[0]!;
    setFixture(cfg.config, ['spec', 'task', 'spec', 'steps'], [
      { ...roleStep, id: 'implement', dependsOn: [] },
      { id: 'verify', kind: 'check', uses: 'json-check', roleId: null, dependsOn: ['implement'] },
    ]);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'acceptance'], {
      required: ['json-check'],
      checks: [{ id: 'json-check', allowedEvidenceLevels: ['local_execution'] }],
    });
    setFixture(cfg.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'implement', handlerRef: roleStep.uses },
      { stepId: 'verify', handlerRef: 'json-check' },
    ]);
    await cfg.save();
    const loaded = await cfg.load();
    assert.equal(loaded.ok, true, JSON.stringify(loaded));
    if (!loaded.ok) return;

    let observedBaselineCount = 0;
    let observedRawPreserved = false;
    let observedExecMode = 0;
    let crashedOnce = false;

    const editedBytes = Buffer.from('after-overlay-edit', 'utf8');
    const editedRef = must(digestArtifact('src/edit-me.txt', editedBytes));
    const overlayManifestFromInput = (baseTree: BaseTreeAnchor) =>
      must(identifyManifest({
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'ArtifactManifest',
        metadata: { id: 'candidate' },
        spec: { baseTree, entries: [editedRef], deleted: ['src/delete-me.txt'] },
      })).manifest;

    const cancelledError: PiErrorV2 = {
      code: 'CANCELLED',
      phase: 'session',
      path: '',
      retryable: false,
      effect: 'none',
      requestId: null,
      operationId: null,
      stateErrorCode: null,
    };
    const cancelledOutcome: PiOutcomeV2 = {
      status: 'cancelled',
      requestIds: [],
      operationIds: [],
      providerTermination: 'none',
      usage: 'none',
      localCleanup: 'complete',
      error: cancelledError,
      cleanupError: null,
    };

    const makeAdapterPort = () => async (host: PiHostV2, input: PiOpenInputV2) => {
      assert.ok(input.candidate.baseline);
      observedBaselineCount = input.candidate.baseline.entries.length;
      const matRaw = await readFile(join(input.candidate.baseline.directory, 'src/raw.txt'));
      observedRawPreserved = same(Buffer.from(matRaw), rawLfIdent);
      observedExecMode = (await lstat(join(input.candidate.baseline.directory, 'src/exec.sh'))).mode & 0o777;
      await assert.rejects(
        lstat(join(input.candidate.baseline.directory, '.git')),
        (err: NodeJS.ErrnoException) => err.code === 'ENOENT',
      );

      let cmdText = '';
      let reqId = '';
      const adapter: PiAdapterV2 = {
        capabilities: () => { throw new Error('unused'); },
        execute: async cmd => {
          cmdText = cmd.text;
          reqId = 'req-600';
          const opId = 'op-600';
          stateValue(host.store.reserveRequest(host.authority, {
            requestId: reqId,
            roleId: input.roleId,
            nodeId: input.stepId,
            attemptId: cmd.commandId,
            purpose: cmd.purpose,
            repair: cmd.repair,
            transportRetryOf: null,
            requestDigest: hash(cmd.text),
            inputUpperBound: 220,
            outputUpperBound: 130,
            totalUpperBound: 350,
            capability: {
              adapterId: 'pi',
              adapterVersion: '0.0.0',
              provider: input.policy.selection.provider,
              model: input.policy.selection.model,
              kind: 'soft_only',
              coversAllBillableTokens: false,
              enforcesOutputBound: false,
            },
            operationId: opId,
            targetIdentity: 'fixture:mock-provider',
          }));
          stateValue(host.store.authorizeRequestDispatch(host.authority, reqId));
          const op = stateValue(host.store.getOperation(opId));
          const view = stateValue(host.store.inspect());
          const usageBytes = Buffer.from(canonical({ inputTokens: 100, outputTokens: 20 }));
          const usageRef = must(digestArtifact('usage-600.bin', usageBytes));
          await writeFile(join(host.artifactsDirectory, 'usage-600.bin'), usageBytes, { mode: 0o600 });
          stateValue(host.store.observeRequest(host.authority, reqId, {
            receiptId: 'rcpt-600',
            termination: 'confirmed',
            outcome: 'succeeded',
            evidence: {
              evidenceId: 'ev-600',
              producerId: 'mock-pi',
              method: 'mock-sse',
              artifact: usageRef,
              subject: {
                storeId: view.storeId,
                runId: view.runId,
                lockHash: view.lockHash,
                operationId: opId,
                requestId: reqId,
                intentDigest: op.intentDigest,
                dispatchGeneration: op.dispatch!.generation,
                dispatchId: op.dispatch!.dispatchId,
              },
            },
            usage: {
              requestId: reqId,
              inputTokens: { provenance: 'reported', value: 100 },
              outputTokens: { provenance: 'reported', value: 20 },
              costMicrousd: { provenance: 'estimated', value: 1000 },
            },
          }));
          return {
            ok: true,
            value: {
              status: 'execution_settled',
              requestIds: [reqId],
              operationIds: [],
              providerTermination: 'confirmed',
              usage: 'complete',
              localCleanup: 'complete',
              error: null,
              cleanupError: null,
            },
          };
        },
        compact: async () => ({ ok: false, error: cancelledError }),
        events: () => ({ async *[Symbol.asyncIterator]() { yield* []; } }),
        cancel: async () => ({ ok: true, value: cancelledOutcome }),
        capture: async ({ checkpointId }) => {
          const candidateManifest = overlayManifestFromInput(input.candidate.manifest.spec.baseTree!);
          const subject = must(bindSubject(input.lock, candidateManifest));
          const current = stateValue(host.store.inspect());
          const sourceDigest = hash('loopwright.dev/pi-policy/v2\0' + canonical(input.policy));
          const nativePolicy = { ...input.policy, version: 1, policyId: 'v2.' + BigInt('0x' + sourceDigest.hex).toString(36) };
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
            candidateDigest: subject.candidateDigest,
            clockBasis: current.clock.basis,
            accountingDigest: hash(canonical({
              ledger: current.ledger,
              requests: current.counts.requests,
              operations: current.counts.operations,
            })),
            sequence: 1,
          };
          const line = (v: unknown) => JSON.stringify(v) + '\n';
          const wsBytes = Buffer.from(
            line({ type: 'workspace_snapshot', version: 1, binding, manifest: candidateManifest }) +
              line({ type: 'file', ref: editedRef }) +
              line({ type: 'chunk', index: 0, data: editedBytes.toString('base64') }) +
              line({ type: 'file_end', byteLength: editedBytes.byteLength, digest: hash(editedBytes).hex }) +
              line({ type: 'end', files: 1 }),
          );
          const wsRef = must(digestArtifact('ws-600.bin', wsBytes));
          await writeFile(join(host.artifactsDirectory, 'ws-600.bin'), wsBytes, { mode: 0o600 });
          const ts = '2026-11-13T00:00:00.000Z';
          const subText = JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null });
          const sessBytes = Buffer.from(
            line({ type: 'session_snapshot', version: 1, binding }) +
              line({ type: 'session', version: 3, id: 'mock_600', cwd: '/workspace/candidate', timestamp: ts }) +
              line({ type: 'message', id: 'u1', parentId: null, timestamp: ts, message: { role: 'user', content: cmdText } }) +
              line({
                type: 'message',
                id: 'a1',
                parentId: 'u1',
                timestamp: ts,
                message: {
                  role: 'assistant',
                  ...input.policy.selection,
                  content: [{ type: 'text', text: subText }],
                  stopReason: 'stop',
                },
              }),
          );
          const sessRef = must(digestArtifact('sess-600.bin', sessBytes));
          await writeFile(join(host.artifactsDirectory, 'sess-600.bin'), sessBytes, { mode: 0o600 });
          stateValue(host.store.renew(host.authority));
          const now = stateValue(host.store.inspect());
          stateValue(host.store.writeCheckpoint(host.authority, {
            checkpointId,
            expectedRevision: now.revision,
            candidateManifest,
            workspace: wsRef,
            privateSession: sessRef,
            additionalArtifacts: [],
          }));
          return { ok: true, value: { checkpointId, candidate: candidateManifest, workspace: wsRef, session: sessRef } };
        },
        close: async () => ({ ok: true, value: { closed: true } }),
      };
      return { ok: true as const, value: adapter };
    };

    // Crash once right after role.1.post checkpoint so we test resumeCycleWithPorts too!
    const crashErr = new Error('simulated-crash-after-role-post');
    const context = await createCycle(
      { configuration: loaded.value, repository: r.directory, runRoot, runId: 'e2e-600' },
      {
        openAdapter: makeAdapterPort(),
        afterCheckpoint: async phase => {
          if (!crashedOnce && phase === 'role.1.post') {
            crashedOnce = true;
            throw crashErr;
          }
        },
      },
    );
    const cycle = new Cycle(context);
    let tryErr: unknown = null;
    try {
      await cycle.bootstrap();
      await assert.rejects(() => cycle.graph(), /simulated-crash-after-role-post/);
    } catch (err) {
      tryErr = err;
      throw err;
    } finally {
      const sealedEvents = await cycle.events.close().catch(() => null);
      if (sealedEvents) {
        const eventBytes = await readFile(join(runRoot, 'e2e-600', 'artifacts', sealedEvents.name));
        await writeFile(join(runRoot, 'e2e-600', 'artifacts', 'controller-events.open'), eventBytes, { mode: 0o600 });
      }
      await cycle.deadline.dispose().catch(() => {});
      context.store.release(context.authority);
      context.store.close();
      if (tryErr) {
        await context.owner.release().catch(() => {});
      } else {
        await context.owner.release();
      }
    }
    assert.equal(crashedOnce, true);
    assert.equal(observedBaselineCount, 601); // .gitattributes, json, exec, raw, delete-me, edit-me, 595 batch = 601
    assert.equal(observedRawPreserved, true);
    assert.equal(observedExecMode, 0o555);

    // Resume via resumeCycleWithPorts: adopts captured overlay and completes verifier checks (Merkle json + implicit scope)!
    const resumed = await resumeCycleWithPorts(
      { configuration: loaded.value, repository: r.directory, runRoot, runId: 'e2e-600' },
      { openAdapter: makeAdapterPort() },
    );
    assert.equal(resumed.ok, true, JSON.stringify(resumed));
    if (!resumed.ok) return;
    assert.equal(resumed.value.kind, 'result', JSON.stringify(resumed.value));
    if (resumed.value.kind !== 'result') return;
    assert.equal(resumed.value.result.spec.status, 'completed');

    // Inspect & status cleanly report the overlay manifest without errors
    const status = await readStatus({ runRoot, runId: 'e2e-600' });
    assert.equal(status.ok, true, JSON.stringify(status));
    const exportDir = join(cfg.root, 'exported');
    const inspected = await inspectRun({ runRoot, runId: 'e2e-600', output: exportDir });
    assert.equal(inspected.ok, true, JSON.stringify(inspected));
    const candFiles = JSON.parse(await readFile(join(exportDir, 'candidate.files.json'), 'utf8')) as {
      manifest: ArtifactManifest;
      files: { name: string }[];
    };
    assert.deepEqual(candFiles.files.map(item => item.name), ['src/edit-me.txt']);
    assert.deepEqual(candFiles.manifest.spec.deleted, ['src/delete-me.txt']);
    assert.ok(candFiles.manifest.spec.baseTree !== undefined);

    // Verify stored progress candidate manifest preserves baseTree + deleted + entries
    const runJson = JSON.parse(await readFile(join(runRoot, 'e2e-600', 'run.json'), 'utf8')) as RunDescriptor;
    const store = stateValue(reopenLocalRun(runJson.identity));
    try {
      const latest = stateValue(store.inspect());
      assert.equal(latest.counts.requests, 1);
    } finally {
      stateValue(store.close());
    }
    assert.equal(resumed.value.result.spec.subject.candidateDigest.algorithm, 'sha256');
  } finally {
    await cfg.cleanup();
  }
});

async function writeMockCapture(
  host: PiHostV2,
  input: PiOpenInputV2,
  checkpointId: string,
  candidateManifest: ArtifactManifest,
  files: readonly { readonly ref: ArtifactRef; readonly bytes: Buffer }[],
  cmdText: string,
  sequence: number,
  submissionObj: unknown = { version: 1, status: 'completed', checks: [], reason: null },
) {
  const subject = must(bindSubject(input.lock, candidateManifest));
  const current = stateValue(host.store.inspect());
  const sourceDigest = hash('loopwright.dev/pi-policy/v2\0' + canonical(input.policy));
  const nativePolicy = { ...input.policy, version: 1, policyId: 'v2.' + BigInt('0x' + sourceDigest.hex).toString(36) };
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
    candidateDigest: subject.candidateDigest,
    clockBasis: current.clock.basis,
    accountingDigest: hash(canonical({
      ledger: current.ledger,
      requests: current.counts.requests,
      operations: current.counts.operations,
    })),
    sequence,
  };
  const line = (v: unknown) => JSON.stringify(v) + '\n';
  const wsParts = [line({ type: 'workspace_snapshot', version: 1, binding, manifest: candidateManifest })];
  for (const f of files) {
    wsParts.push(
      line({ type: 'file', ref: f.ref }),
      line({ type: 'chunk', index: 0, data: f.bytes.toString('base64') }),
      line({ type: 'file_end', byteLength: f.bytes.byteLength, digest: hash(f.bytes).hex }),
    );
  }
  wsParts.push(line({ type: 'end', files: files.length }));
  const wsBytes = Buffer.from(wsParts.join(''));
  const wsName = `ws-${sequence}-${checkpointId.slice(-8)}.bin`;
  const wsRef = must(digestArtifact(wsName, wsBytes));
  await writeFile(join(host.artifactsDirectory, wsName), wsBytes, { mode: 0o600 });

  const ts = '2026-11-13T00:00:00.000Z';
  const subText = JSON.stringify(submissionObj);
  const sessBytes = Buffer.from(
    line({ type: 'session_snapshot', version: 1, binding }) +
      line({ type: 'session', version: 3, id: `mock_${sequence}`, cwd: '/workspace/candidate', timestamp: ts }) +
      line({ type: 'message', id: 'u1', parentId: null, timestamp: ts, message: { role: 'user', content: cmdText } }) +
      line({
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: ts,
        message: {
          role: 'assistant',
          ...input.policy.selection,
          content: [{ type: 'text', text: subText }],
          stopReason: 'stop',
        },
      }),
  );
  const sessName = `sess-${sequence}-${checkpointId.slice(-8)}.bin`;
  const sessRef = must(digestArtifact(sessName, sessBytes));
  await writeFile(join(host.artifactsDirectory, sessName), sessBytes, { mode: 0o600 });

  stateValue(host.store.renew(host.authority));
  const now = stateValue(host.store.inspect());
  stateValue(host.store.writeCheckpoint(host.authority, {
    checkpointId,
    expectedRevision: now.revision,
    candidateManifest,
    workspace: wsRef,
    privateSession: sessRef,
    additionalArtifacts: [],
  }));
  return { checkpointId, candidate: candidateManifest, workspace: wsRef, session: sessRef };
}

function recordMockRequest(host: PiHostV2, input: PiOpenInputV2, cmd: { commandId: string; text: string; purpose: Parameters<PiAdapterV2['execute']>[0]['purpose']; repair: 'none' | 'format' | 'implementation' }, idx: number) {
  const reqId = `req-${idx}-${cmd.commandId.slice(-8)}`;
  const opId = `op-${idx}-${cmd.commandId.slice(-8)}`;
  stateValue(host.store.reserveRequest(host.authority, {
    requestId: reqId,
    roleId: input.roleId,
    nodeId: input.stepId,
    attemptId: cmd.commandId,
    purpose: cmd.purpose,
    repair: cmd.repair,
    transportRetryOf: null,
    requestDigest: hash(cmd.text),
    inputUpperBound: 220,
    outputUpperBound: 130,
    totalUpperBound: 350,
    capability: {
      adapterId: 'pi',
      adapterVersion: '0.0.0',
      provider: input.policy.selection.provider,
      model: input.policy.selection.model,
      kind: 'soft_only',
      coversAllBillableTokens: false,
      enforcesOutputBound: false,
    },
    operationId: opId,
    targetIdentity: 'fixture:mock-provider',
  }));
  stateValue(host.store.authorizeRequestDispatch(host.authority, reqId));
  const op = stateValue(host.store.getOperation(opId));
  const view = stateValue(host.store.inspect());
  const usageBytes = Buffer.from(canonical({ inputTokens: 100, outputTokens: 20 }));
  const usageName = `usage-${idx}.bin`;
  const usageRef = must(digestArtifact(usageName, usageBytes));
  return writeFile(join(host.artifactsDirectory, usageName), usageBytes, { mode: 0o600 }).then(() => {
    stateValue(host.store.observeRequest(host.authority, reqId, {
      receiptId: `rcpt-${idx}`,
      termination: 'confirmed',
      outcome: 'succeeded',
      evidence: {
        evidenceId: `ev-${idx}`,
        producerId: 'mock-pi',
        method: 'mock-sse',
        artifact: usageRef,
        subject: {
          storeId: view.storeId,
          runId: view.runId,
          lockHash: view.lockHash,
          operationId: opId,
          requestId: reqId,
          intentDigest: op.intentDigest,
          dispatchGeneration: op.dispatch!.generation,
          dispatchId: op.dispatch!.dispatchId,
        },
      },
      usage: {
        requestId: reqId,
        inputTokens: { provenance: 'reported', value: 100 },
        outputTokens: { provenance: 'reported', value: 20 },
        costMicrousd: { provenance: 'estimated', value: 1000 },
      },
    }));
    return reqId;
  });
}

test('T3 implementationRepair classifies ["read", "delete"] role as mutating and invokes repair', async () => {
  const cfg = await configurationFixture();
  try {
    const r = await createFastGitRepo(join(cfg.root, 'del-repair'), [
      { path: 'config/settings.json', mode: '100644', data: canonical({ ok: false }) },
      { path: 'src/stale.txt', mode: '100644', data: 'stale' },
      ...Array.from({ length: 140 }, (_, i) => ({
        path: `src/pad-${String(i).padStart(3, '0')}.txt`,
        mode: '100644' as const,
        data: `pad-${i}`,
      })),
    ]);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], r.commitOid);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], r.commitOid);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'scope', 'writable'], ['src/**']);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'budgets', 'maxImplementationRepairs'], 1);
    setFixture(cfg.config, ['spec', 'controls', 'maxAttempts'], 3);
    setFixture(cfg.registry, ['spec', 'roleProfiles', 0, 'tools'], ['read', 'delete']);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'roles', 0, 'tools'], ['read', 'delete']);
    const proto = cfg.registry.spec.handlers.find(h => h.implementation === 'json-artifact.v1')!;
    setFixture(cfg.registry, ['spec', 'handlers'], [
      ...cfg.registry.spec.handlers.filter(h => h.id !== 'json-check'),
      {
        ...proto,
        id: 'json-check',
        parameters: { ...proto.parameters, checkId: 'json-check', path: 'config/settings.json', required: ['ok'], equals: { ok: true } },
      },
    ]);
    const roleStep = cfg.config.spec.task.spec.steps[0]!;
    setFixture(cfg.config, ['spec', 'task', 'spec', 'steps'], [
      { ...roleStep, id: 'implement', dependsOn: [] },
      { id: 'verify', kind: 'check', uses: 'json-check', roleId: null, dependsOn: ['implement'] },
    ]);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'acceptance'], {
      required: ['json-check'],
      checks: [{ id: 'json-check', allowedEvidenceLevels: ['local_execution'] }],
    });
    setFixture(cfg.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'implement', handlerRef: roleStep.uses },
      { stepId: 'verify', handlerRef: 'json-check' },
    ]);
    await cfg.save();
    const loaded = await cfg.load();
    assert.equal(loaded.ok, true, JSON.stringify(loaded));
    if (!loaded.ok) return;

    const repairsSeen: ('none' | 'format' | 'implementation')[] = [];
    let callSeq = 0;
    const cancelledError: PiErrorV2 = {
      code: 'CANCELLED',
      phase: 'session',
      path: '',
      retryable: false,
      effect: 'none',
      requestId: null,
      operationId: null,
      stateErrorCode: null,
    };
    const cancelledOutcome: PiOutcomeV2 = {
      status: 'cancelled',
      requestIds: [],
      operationIds: [],
      providerTermination: 'none',
      usage: 'none',
      localCleanup: 'complete',
      error: cancelledError,
      cleanupError: null,
    };

    const runRoot = join(cfg.root, 'runs');
    await mkdir(runRoot, { mode: 0o700 });
    const res = await runCycleWithPorts(
      { configuration: loaded.value, repository: r.directory, runRoot, runId: 'delete-repair' },
      {
        openAdapter: async (host, input) => {
          let lastCmd = '';
          let lastReq = '';
          let repairMode: 'none' | 'format' | 'implementation' = 'none';
          const adapter: PiAdapterV2 = {
            capabilities: () => { throw new Error('unused'); },
            execute: async cmd => {
              callSeq++;
              lastCmd = cmd.text;
              repairMode = cmd.repair;
              repairsSeen.push(cmd.repair);
              lastReq = await recordMockRequest(host, input, cmd, callSeq);
              return {
                ok: true,
                value: {
                  status: 'execution_settled',
                  requestIds: [lastReq],
                  operationIds: [],
                  providerTermination: 'confirmed',
                  usage: 'complete',
                  localCleanup: 'complete',
                  error: null,
                  cleanupError: null,
                },
              };
            },
            compact: async () => ({ ok: false, error: cancelledError }),
            events: () => ({ async *[Symbol.asyncIterator]() { yield* []; } }),
            cancel: async () => ({ ok: true, value: cancelledOutcome }),
            capture: async ({ checkpointId }) => {
              const baseTree = input.candidate.manifest.spec.baseTree!;
              const candidateManifest = must(identifyManifest({
                apiVersion: 'loopwright.dev/v1alpha1',
                kind: 'ArtifactManifest',
                metadata: { id: 'candidate' },
                spec: { baseTree, entries: [], deleted: repairMode === 'implementation' ? ['src/stale.txt'] : [] },
              })).manifest;
              return { ok: true, value: await writeMockCapture(host, input, checkpointId, candidateManifest, [], lastCmd, callSeq) };
            },
            close: async () => ({ ok: true, value: { closed: true } }),
          };
          return { ok: true as const, value: adapter };
        },
      },
    );
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.deepEqual(repairsSeen, ['none', 'implementation']);
  } finally {
    await cfg.cleanup();
  }
});

test('T3 mixed-case README.md + package.json compaction restore and implementation repair in tree_overlay mode', async () => {
  const cfg = await configurationFixture();
  try {
    const installed = await (await import('../src/handlers.js')).installedHandlerDigests();
    const r = await createFastGitRepo(join(cfg.root, 'mixed-case'), [
      { path: 'README.md', mode: '100644', data: '# Initial\n' },
      { path: 'package.json', mode: '100644', data: canonical({ name: 'mixed-pkg', ok: false }) },
      ...Array.from({ length: 140 }, (_, i) => ({
        path: `src/mod-${String(i).padStart(3, '0')}.ts`,
        mode: '100644' as const,
        data: `export const n${i} = ${i};\n`,
      })),
    ]);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], r.commitOid);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], r.commitOid);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'scope', 'writable'], ['README.md', 'package.json', 'src/**']);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'budgets', 'maxImplementationRepairs'], 1);
    setFixture(cfg.config, ['spec', 'controls', 'maxAttempts'], 4);
    setFixture(cfg.registry, ['spec', 'roleProfiles', 0, 'tools'], ['read', 'write', 'edit']);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'roles', 0, 'tools'], ['read', 'write', 'edit']);
    const proto = cfg.registry.spec.handlers.find(h => h.implementation === 'json-artifact.v1')!;
    setFixture(cfg.registry, ['spec', 'handlers'], [
      ...cfg.registry.spec.handlers.filter(h => h.id !== 'json-check'),
      {
        id: 'compact-step',
        kind: 'agent',
        implementation: 'pi.compact.v1',
        version: 1,
        digest: installed['pi.compact.v1'],
        parameters: {},
        capabilities: ['pi', 'compaction'],
      },
      {
        ...proto,
        id: 'json-check',
        parameters: { ...proto.parameters, checkId: 'json-check', path: 'package.json', required: ['ok'], equals: { ok: true } },
      },
    ]);
    const roleStep = cfg.config.spec.task.spec.steps[0]!;
    setFixture(cfg.config, ['spec', 'task', 'spec', 'steps'], [
      { ...roleStep, id: 'implement', dependsOn: [] },
      { id: 'compact', kind: 'agent', uses: 'compact-step', roleId: roleStep.roleId, dependsOn: ['implement'] },
      { id: 'verify', kind: 'check', uses: 'json-check', roleId: null, dependsOn: ['compact'] },
    ]);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'acceptance'], {
      required: ['json-check'],
      checks: [{ id: 'json-check', allowedEvidenceLevels: ['local_execution'] }],
    });
    setFixture(cfg.config, ['spec', 'profiles', 'steps'], [
      { stepId: 'implement', handlerRef: roleStep.uses },
      { stepId: 'compact', handlerRef: 'compact-step' },
      { stepId: 'verify', handlerRef: 'json-check' },
    ]);
    await cfg.save();
    const loaded = await cfg.load();
    assert.equal(loaded.ok, true, JSON.stringify(loaded));
    if (!loaded.ok) return;

    const readmeBytes = Buffer.from('# Updated README\n', 'utf8');
    const readmeRef = must(digestArtifact('README.md', readmeBytes));
    const fixedPkgBytes = Buffer.from(canonical({ name: 'mixed-pkg', ok: true }), 'utf8');
    const fixedPkgRef = must(digestArtifact('package.json', fixedPkgBytes));

    let callSeq = 0;
    let compactedRestoredReadme = false;
    let repairRestoredReadme = false;
    const cancelledError: PiErrorV2 = {
      code: 'CANCELLED',
      phase: 'session',
      path: '',
      retryable: false,
      effect: 'none',
      requestId: null,
      operationId: null,
      stateErrorCode: null,
    };
    const cancelledOutcome: PiOutcomeV2 = {
      status: 'cancelled',
      requestIds: [],
      operationIds: [],
      providerTermination: 'none',
      usage: 'none',
      localCleanup: 'complete',
      error: cancelledError,
      cleanupError: null,
    };

    const runRoot = join(cfg.root, 'runs');
    await mkdir(runRoot, { mode: 0o700 });
    const res = await runCycleWithPorts(
      { configuration: loaded.value, repository: r.directory, runRoot, runId: 'mixed-case-repair' },
      {
        openAdapter: async (host, input) => {
          let lastCmd = '';
          let repairMode: 'none' | 'format' | 'implementation' = 'none';
          let isCompact = false;
          if (input.restore !== null) {
            const restoredNames = input.candidate.manifest.spec.entries.map(e => e.name);
            if (restoredNames.includes('README.md') && !repairRestoredReadme && callSeq === 1) {
              compactedRestoredReadme = true;
            }
            if (restoredNames.includes('README.md') && callSeq >= 2) {
              repairRestoredReadme = true;
            }
          }
          const adapter: PiAdapterV2 = {
            capabilities: () => { throw new Error('unused'); },
            execute: async cmd => {
              callSeq++;
              lastCmd = cmd.text;
              repairMode = cmd.repair;
              isCompact = false;
              const reqId = await recordMockRequest(host, input, cmd, callSeq);
              return {
                ok: true,
                value: {
                  status: 'execution_settled',
                  requestIds: [reqId],
                  operationIds: [],
                  providerTermination: 'confirmed',
                  usage: 'complete',
                  localCleanup: 'complete',
                  error: null,
                  cleanupError: null,
                },
              };
            },
            compact: async cmd => {
              callSeq++;
              lastCmd = '';
              isCompact = true;
              const reqId = await recordMockRequest(host, input, { commandId: cmd.commandId, text: '', purpose: 'compaction', repair: 'none' }, callSeq);
              return {
                ok: true,
                value: {
                  status: 'execution_settled',
                  requestIds: [reqId],
                  operationIds: [],
                  providerTermination: 'confirmed',
                  usage: 'complete',
                  localCleanup: 'complete',
                  error: null,
                  cleanupError: null,
                },
              };
            },
            events: () => ({ async *[Symbol.asyncIterator]() { yield* []; } }),
            cancel: async () => ({ ok: true, value: cancelledOutcome }),
            capture: async ({ checkpointId }) => {
              const baseTree = input.candidate.manifest.spec.baseTree!;
              const entries = isCompact
                ? [readmeRef]
                : repairMode === 'implementation'
                  ? [readmeRef, fixedPkgRef]
                  : [readmeRef];
              const files = isCompact
                ? [{ ref: readmeRef, bytes: readmeBytes }]
                : repairMode === 'implementation'
                  ? [{ ref: readmeRef, bytes: readmeBytes }, { ref: fixedPkgRef, bytes: fixedPkgBytes }]
                  : [{ ref: readmeRef, bytes: readmeBytes }];
              const candidateManifest = must(identifyManifest({
                apiVersion: 'loopwright.dev/v1alpha1',
                kind: 'ArtifactManifest',
                metadata: { id: 'candidate' },
                spec: { baseTree, entries, deleted: [] },
              })).manifest;
              return { ok: true, value: await writeMockCapture(host, input, checkpointId, candidateManifest, files, lastCmd, callSeq) };
            },
            close: async () => ({ ok: true, value: { closed: true } }),
          };
          return { ok: true as const, value: adapter };
        },
      },
    );
    assert.equal(res.ok, true, JSON.stringify(res));
    if (!res.ok) return;
    assert.equal(res.value.kind, 'result', JSON.stringify(res.value));
    if (res.value.kind !== 'result') return;
    assert.equal(res.value.result.spec.status, 'completed');
    assert.equal(compactedRestoredReadme, true);
    assert.equal(repairRestoredReadme, true);
  } finally {
    await cfg.cleanup();
  }
});

test('T3 restoredCandidate rejects a tampered non-minimal overlay on resume with RECOVERY_REQUIRED', async () => {
  const cfg = await configurationFixture();
  try {
    const unchangedBytes = Buffer.from('unchanged-body', 'utf8');
    const files: GitEntryInput[] = [
      { path: 'src/keep.txt', mode: '100644', data: unchangedBytes },
      ...Array.from({ length: 140 }, (_, i) => ({
        path: `src/pad-${String(i).padStart(3, '0')}.txt`,
        mode: '100644' as const,
        data: `p-${i}`,
      })),
    ];
    const r = await createFastGitRepo(join(cfg.root, 'tamper-resume'), files);
    const runRoot = join(cfg.root, 'runs');
    await mkdir(runRoot, { mode: 0o700 });
    setFixture(cfg.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], r.commitOid);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], r.commitOid);
    setFixture(cfg.config, ['spec', 'task', 'spec', 'scope', 'writable'], ['src/**']);
    await cfg.save();
    const loaded = await cfg.load();
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;

    const context = await createCycle({ configuration: loaded.value, repository: r.directory, runRoot, runId: 'nonminimal-resume' }, {});
    const cycle = new Cycle(context);
    try {
      await cycle.bootstrap();
      const role = context.plan.roles[0]!;
      const node = context.plan.orderedDAG.find(item => item.kind === 'agent')!;
      const ordinal = 1;
      const commandId = stableId(context.lock.spec.runId, node.id, 'task', 'none', ordinal);
      const sessionId = nativeSessionId(context.lock.spec.runId, role.roleId, node.id, role.policy);
      const cmdText = 'tamper test command';
      const cmdRef = await context.artifacts.put('command', Buffer.from(cmdText), 16384);
      const attempt = {
        ordinal,
        id: commandId,
        nodeId: node.id,
        nativeStepId: node.id,
        sessionId,
        purpose: 'task' as const,
        repair: 'none' as const,
        command: cmdRef,
        before: cycle.head!.progress.stage.watermarks,
        finished: null,
      };
      await cycle.publish({
        ...cycle.draft,
        stage: { ...cycle.draft.stage, kind: 'role_pre' },
        attempts: [attempt],
        nodes: cycle.draft.nodes.map(item => item.id === node.id ? { ...item, state: 'running' } : item),
      }, 'role.1.pre');

      const noopRef = must(digestArtifact('src/keep.txt', unchangedBytes));
      const nonMinimalManifest = must(identifyManifest({
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'ArtifactManifest',
        metadata: { id: 'candidate' },
        spec: { baseTree: context.source.manifest.spec.baseTree!, entries: [noopRef], deleted: [] },
      })).manifest;
      const hostProxy: PiHostV2 = {
        store: context.store,
        authority: context.authority,
        directory: join(context.directory, 'runtime'),
        artifactsDirectory: context.artifacts.directory,
        dockerExecutable: role.runtime.dockerExecutable,
        dockerSocket: role.runtime.dockerSocket,
        runtime: role.runtime.identity,
        ...approvedState(loaded.value).vault.bind({
          runId: context.lock.spec.runId,
          roleId: role.roleId,
          stepId: node.id,
          providerCredentialRef: role.providerCredentialRef,
          selection: role.policy.selection,
          mcp: role.policy.mcp,
        }),
      };
      const fakeOpenInput: PiOpenInputV2 = {
        version: 2,
        lock: context.lock,
        roleId: role.roleId,
        stepId: node.id,
        sessionId,
        policy: role.policy,
        candidate: {
          manifest: context.source.manifest,
          baseRevision: r.commitOid,
          sourceRevision: r.commitOid,
          artifacts: [],
        },
        resources: [],
        restore: null,
      };
      const reqId = await recordMockRequest(hostProxy, fakeOpenInput, { commandId, text: cmdText, purpose: 'task', repair: 'none' }, 1);
      const nativeId = phaseCheckpointId(context.lock.spec.runId, 'role.1.native');
      const captured = await writeMockCapture(hostProxy, fakeOpenInput, nativeId, nonMinimalManifest, [{ ref: noopRef, bytes: unchangedBytes }], cmdText, 1);
      const manifestRef = await context.artifacts.json('manifest', nonMinimalManifest, 32768);
      const origManifestRef = await context.artifacts.json('native-manifest', nonMinimalManifest, 32768);
      const afterCounts = stateValue(context.store.inspect()).counts;
      const outcomeRef = await context.artifacts.json('role-outcome', {
        version: 1,
        attemptId: commandId,
        command: cmdRef,
        roleId: role.roleId,
        nodeId: node.id,
        stepId: node.id,
        sessionId,
        checkpointId: nativeId,
        originalManifest: origManifestRef,
        manifest: manifestRef,
        workspace: captured.workspace,
        session: captured.session,
        submission: null,
        journal: { requestIds: [reqId], operationIds: [] },
      }, 1048576);
      const candDigest = must(bindSubject(context.lock, nonMinimalManifest)).candidateDigest;
      await cycle.publish({
        ...cycle.draft,
        stage: { ...cycle.draft.stage, kind: 'role_post' },
        attempts: [{ ...attempt, finished: { after: { requests: afterCounts.requests, operations: afterCounts.operations }, outcome: outcomeRef, nativeCheckpointId: nativeId } }],
        nativeCheckpoints: [{ attemptId: commandId, checkpointId: nativeId, outcome: outcomeRef }],
        candidate: { manifest: manifestRef, digest: candDigest, generation: 1, workspace: captured.workspace, privateSession: captured.session },
        nodes: cycle.draft.nodes.map(item => item.id === node.id ? { ...item, state: 'completed' } : item),
      }, 'role.1.post');
    } finally {
      await cycle.events.close().catch(() => {});
      await cycle.deadline.dispose().catch(() => {});
      context.store.release(context.authority);
      context.store.close();
      await context.owner.release();
    }

    const resumed = await resumeCycleWithPorts({ configuration: loaded.value, repository: r.directory, runRoot, runId: 'nonminimal-resume' }, {});
    assert.equal(resumed.ok, false);
    if (resumed.ok) throw new Error('expected RECOVERY_REQUIRED');
    assert.equal(resumed.error.code, 'RECOVERY_REQUIRED');
    assert.equal(resumed.error.phase, 'recovery');
  } finally {
    await cfg.cleanup();
  }
});

test('T3 real-repo Merkle oversize handling: depth > 16, tree > 262144 bytes, blob > 4 MiB, and __proto__ path', async () => {
  const cfg = await configurationFixture();
  try {
    const padEntries: GitEntryInput[] = Array.from({ length: 140 }, (_, i) => ({
      path: `pad/p-${String(i).padStart(3, '0')}.txt`,
      mode: '100644',
      data: `p-${i}`,
    }));

    // 1. 17-segment nested JSON path (depth 17 > 16) vs 16-segment path (depth 16 <= 16)
    const deep16Path = `${Array.from({ length: 15 }, (_, i) => `d${i}`).join('/')}/config.json`;
    const deep17Path = `${Array.from({ length: 16 }, (_, i) => `e${i}`).join('/')}/config.json`;
    const okJson = canonical({ ok: true });
    // 2. Large directory tree (> 262,144 bytes in single tree object)
    const bigTreeEntries: GitEntryInput[] = [
      { path: 'bigdir/config.json', mode: '100644', data: okJson },
      ...Array.from({ length: 6500 }, (_, i) => ({
        path: `bigdir/entry-${String(i).padStart(4, '0')}-${'x'.repeat(16)}.txt`,
        mode: '100644' as const,
        data: 'x',
      })),
    ];
    // 3. > 4 MiB baseline JSON file (4,194,305 bytes)
    const hugeJsonBytes = Buffer.concat([Buffer.from('{"ok":true}'), Buffer.alloc(4_194_305 - 11, 0x20)]);
    // 4. __proto__ baseline JSON path
    const r = await createFastGitRepo(join(cfg.root, 'merkle-oversize'), [
      ...padEntries,
      { path: deep16Path, mode: '100644', data: okJson },
      { path: deep17Path, mode: '100644', data: okJson },
      ...bigTreeEntries,
      { path: 'huge.json', mode: '100644', data: hugeJsonBytes },
      { path: '__proto__', mode: '100644', data: okJson },
    ]);

    const ownerDir = join(cfg.root, 'owner-oversize');
    await mkdir(ownerDir, { mode: 0o700 });
    const artDir = join(cfg.root, 'art-oversize');
    await mkdir(artDir, { mode: 0o700 });

    for (const [label, jsonPath, expectedReason] of [
      ['depth16', deep16Path, null],
      ['depth17', deep17Path, 'tree_proof_depth'],
      ['bigtree', 'bigdir/config.json', 'tree_proof_bytes'],
      ['hugeblob', 'huge.json', 'json_file_bytes'],
      ['proto', '__proto__', null],
    ] as const) {
      configureJsonCheck(cfg, jsonPath);
      setFixture(cfg.config, ['spec', 'task', 'spec', 'target', 'baseRevision'], r.commitOid);
      setFixture(cfg.config, ['spec', 'task', 'spec', 'target', 'sourceRevision'], r.commitOid);
      await cfg.save();
      const loaded = await cfg.load();
      assert.equal(loaded.ok, true, JSON.stringify(loaded));
      if (!loaded.ok) return;
      const plan = must(await compilePlan(loaded.value));
      const lock = makeFakeLock(plan.task, `run-${label}`);
      const slot = plan.verifierSlots.find(s => s.handler.implementation === 'json-artifact.v1')!;

      const oDir = join(ownerDir, label);
      await mkdir(oDir, { mode: 0o700 });
      const owner = await ControllerOwner.acquire(oDir, `run-${label}`, plan.planDigest);
      const aDir = join(artDir, label);
      await mkdir(aDir, { mode: 0o700 });
      const artifacts = new ArtifactStore(aDir, owner, approvedState(loaded.value).vault);
      try {
        const frozen = await freezeSource(r.directory, plan.task, owner, artifacts, [jsonPath]);
        assert.equal(frozen.version, 2);
        const proof = frozen.baselineProofs?.[jsonPath];
        assert.ok(proof, `expected proof for ${label}`);
        const srcRef = await artifacts.json('manifest', frozen.manifest, 32768);
        const sourceInv = { manifest: frozen.manifest, ref: srcRef, files: frozen.artifacts, baselineProofs: frozen.baselineProofs };

        const pre = preflightVerification(plan, lock, slot.id, sourceInv, sourceInv, 0, 'a'.repeat(32));
        if (expectedReason === null) {
          assert.equal(pre.kind, 'ready', label);
          if (label === 'proto') {
            assert.equal(Object.getPrototypeOf(frozen.baselineProofs), null);
            assert.equal(Object.hasOwn(frozen.baselineProofs!, '__proto__'), true);
          }
        } else {
          assert.equal(pre.kind, 'refused', label);
          if (pre.kind !== 'refused') return;
          // Verify storeRefusal + checkedRefusalRecord round-trip with SQLite state
          const stateDir = join(oDir, 'state');
          const store = stateValue(createLocalRun({
            directory: stateDir,
            storeId: `store-${label}`,
            lock,
            policy: { version: 1, leaseMs: 60_000, cost: 'observe_only' },
            binding: {
              coreApiVersion: 'loopwright.dev/v1alpha1',
              hostVersion: 's04-test',
              adapters: [{ id: 'pi', version: '0.0.0' }],
              resourceVersion: plan.task.spec.trustedContext.revision,
              clockEpoch: 'boot.' + 'a'.repeat(40),
            },
          }));
          try {
            const initial = stateValue(store.inspect());
            const authority = stateValue(store.claim({
              ownerId: 'controller.' + owner.nonce,
              expectedGeneration: initial.owner.generation,
              expectedRevision: initial.revision,
              mode: 'active',
            })).authority;
            const planRef = await artifacts.json('plan', plan, 1048576);
            const progress = new ProgressStore(store, authority, artifacts, plan, lock, planRef, frozen.inventory);
            const bound = must(bindSubject(lock, frozen.manifest));
            await progress.publish({
              version: 2,
              runId: lock.spec.runId,
              lockHash: lock.spec.lockHash,
              stage: { kind: 'bootstrap', phase: 'bootstrap', capacity: plan.capacity },
              nodes: plan.orderedDAG.map(n => ({ id: n.id, state: 'pending' })),
              attempts: [],
              nativeCheckpoints: [],
              submission: null,
              publication: { status: 'idle', operationId: null, receipt: null },
              candidate: { manifest: srcRef, digest: bound.candidateDigest, generation: 0, workspace: frozen.workspace, privateSession: null },
              failures: [],
              verifierReceipts: [],
              verifierRefusals: [],
              eventSequence: 0,
              terminalIntent: null,
            }, 'bootstrap');
            const verifier = new Verifier(store, authority, artifacts, plan, lock, () => bound);
            const row = await verifier.storeRefusal(pre.prepared);
            const parsedRefusal = JSON.parse(Buffer.from(await artifacts.read(row.record, 65536)).toString('utf8')) as Record<string, unknown>;
            const rec = checkedRefusalRecord(parsedRefusal, plan, lock, row);
            assert.equal(rec.limits.reason, expectedReason);
            assert.throws(
              () => checkedRefusalRecord({
                ...parsedRefusal,
                limits: { ...(parsedRefusal['limits'] as Record<string, unknown>), actual: 1_073_741_825 },
              }, plan, lock, row),
              (err: unknown) => err instanceof Error,
            );
            stateValue(store.release(authority));
          } finally {
            stateValue(store.close());
          }
        }
      } finally {
        await owner.release();
      }
    }
  } finally {
    await cfg.cleanup();
  }
});

test('T3 materializeBaseline deadline and abort handling, non-UTF-8 admission refusal, and verifier-protocol leaf isolation', async () => {
  const f = await retainedFixture();
  try {
    const files: GitEntryInput[] = [
      { path: 'src/a.txt', mode: '100644', data: 'alpha' },
      ...Array.from({ length: 140 }, (_, i) => ({
        path: `src/b-${String(i).padStart(3, '0')}.txt`,
        mode: '100644' as const,
        data: `beta-${i}`,
      })),
    ];
    const r = await createFastGitRepo(join(f.root, 'mat-cancel'), files);
    const frozen = await freezeSource(r.directory, r.task(), f.owner, f.artifacts);
    assert.equal(frozen.version, 2);

    // 1. Pre-aborted AbortSignal -> CANCELLED
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(
      materializeBaseline(frozen, join(f.root, 'mat-aborted'), f.owner, aborted.signal),
      (err: unknown) => err instanceof ControllerFailure && err.diagnostic.code === 'CANCELLED',
    );

    // 2. AbortSignal triggered during execution -> CANCELLED
    const midAbort = new AbortController();
    const abortingOwner = await ControllerOwner.acquire(join(f.root, 'retained'), 'run-abort-mid', f.plan.planDigest, {
      afterGitExec: async () => {
        midAbort.abort();
      },
    }).catch(() => null);
    // Use a fresh owner directory for afterGitExec port test
    const midDir = join(f.root, 'owner-mid-abort');
    await mkdir(midDir, { mode: 0o700 });
    const midOwner = abortingOwner ?? await ControllerOwner.acquire(midDir, 'run-abort-mid', f.plan.planDigest, {
      afterGitExec: async () => {
        midAbort.abort();
      },
    });
    try {
      await assert.rejects(
        materializeBaseline(frozen, join(f.root, 'mat-mid-abort'), midOwner, midAbort.signal),
        (err: unknown) => err instanceof ControllerFailure && err.diagnostic.code === 'CANCELLED',
      );
    } finally {
      await midOwner.release();
    }

    // 3. WorkDeadline already expired / exhausted -> DEADLINE (even on remainingMs <= 0 without 10s floor)
    const expiredDeadline = new WorkDeadline(f.store, f.authority, 10_000_000, new AbortController().signal);
    try {
      await assert.rejects(
        materializeBaseline(frozen, join(f.root, 'mat-expired'), f.owner, expiredDeadline),
        (err: unknown) => err instanceof ControllerFailure && err.diagnostic.code === 'DEADLINE',
      );
    } finally {
      await expiredDeadline.dispose();
    }

    // 4. materializeGitBatch timeoutMs <= 0 -> DEADLINE immediately
    await assert.rejects(
      f.owner.materializeGitBatch(frozen.directory, frozen.baselineEntries ?? [], join(f.root, 'mat-zero-ms'), new AbortController().signal, 0),
      (err: unknown) => err instanceof ControllerFailure && err.diagnostic.code === 'DEADLINE',
    );

    // 5. Child process timeout mapped to DEADLINE (remainingMs = 150ms while afterGitExec sleeps 400ms)
    const timeoutDir = join(f.root, 'owner-timeout');
    await mkdir(timeoutDir, { mode: 0o700 });
    const timeoutOwner = await ControllerOwner.acquire(timeoutDir, 'run-timeout', f.plan.planDigest, {
      afterGitExec: async () => {
        await new Promise(resolve => setTimeout(resolve, 400));
      },
    });
    try {
      await assert.rejects(
        timeoutOwner.materializeGitBatch(frozen.directory, frozen.baselineEntries ?? [], join(f.root, 'mat-timeout'), new AbortController().signal, 150),
        (err: unknown) => err instanceof ControllerFailure && err.diagnostic.code === 'DEADLINE',
      );
    } finally {
      await timeoutOwner.release();
    }

    // 6. OID mismatch during materializeGitBatch -> TARGET_MISMATCH
    const tamperedEntries = (frozen.baselineEntries ?? []).map((entry, idx) =>
      idx === 0 ? { ...entry, byteLength: entry.byteLength + 1 } : entry,
    );
    await assert.rejects(
      f.owner.materializeGitBatch(frozen.directory, tamperedEntries, join(f.root, 'mat-oid-mismatch'), new AbortController().signal, 5_000),
      (err: unknown) => err instanceof ControllerFailure && err.diagnostic.code === 'TARGET_MISMATCH',
    );

    // 7. Non-UTF-8 path in ls-tree -> CAPABILITY_UNSUPPORTED
    const nonUtf8RepoDir = join(f.root, 'non-utf8-repo');
    await mkdir(nonUtf8RepoDir, { recursive: true, mode: 0o700 });
    const runGit = (args: string[], input?: Buffer) =>
      execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', ...args], {
        cwd: nonUtf8RepoDir,
        env: GIT_ENV,
        input,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    runGit(['init', '-q']);
    const blobOid = runGit(['hash-object', '-w', '--stdin'], Buffer.from('badpath')).toString('utf8').trim();
    const rawTreeEntry = Buffer.concat([
      Buffer.from('100644 ', 'ascii'),
      Buffer.from([0x66, 0xff, 0x2e, 0x74, 0x78, 0x74, 0x00]),
      Buffer.from(blobOid, 'hex'),
    ]);
    const badTreeOid = runGit(['hash-object', '-t', 'tree', '-w', '--stdin'], rawTreeEntry).toString('utf8').trim();
    const badCommitOid = runGit(
      ['-c', 'user.name=T3', '-c', 'user.email=t3@localhost.invalid', 'commit-tree', badTreeOid, '-m', 'nonutf8'],
    ).toString('utf8').trim();
    runGit(['update-ref', 'HEAD', badCommitOid]);
    const realBadDir = await realpath(nonUtf8RepoDir);
    await assert.rejects(
      freezeSource(realBadDir, r.task(undefined, undefined, badCommitOid), f.owner, f.artifacts),
      (err: unknown) => err instanceof ControllerFailure && err.diagnostic.code === 'CAPABILITY_UNSUPPORTED' && err.diagnostic.phase === 'admission',
    );

    // 8. verifier-protocol.ts has zero transitive imports of node:fs, node:fs/promises, node:child_process, or storage.ts
    const seen = new Set<string>();
    const queue = [new URL('../src/verifier-protocol.js', import.meta.url).pathname.replace('/.test-build/', '/')];
    // Walk relative TS imports starting from packages/controller/src/verifier-protocol.ts
    const srcRoot = realpath ? await realpath(join(process.cwd(), 'packages/controller/src')) : join(process.cwd(), 'packages/controller/src');
    const tsQueue = [join(srcRoot, 'verifier-protocol.ts')];
    const specifiers: string[] = [];
    while (tsQueue.length > 0) {
      const current = tsQueue.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const sourceText = await readFile(current, 'utf8');
      for (const match of sourceText.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const spec = match[1]!;
        specifiers.push(spec);
        if (spec.startsWith('./') || spec.startsWith('../')) {
          tsQueue.push(join(srcRoot, spec.replace(/\.js$/, '.ts')));
        }
      }
    }
    assert.ok(queue.length > 0);
    assert.equal(specifiers.some(s => s === 'node:fs' || s === 'node:fs/promises' || s === 'node:child_process' || s === './storage.js' || s === './source.js'), false, JSON.stringify(specifiers));
  } finally {
    await f.close();
  }
});
