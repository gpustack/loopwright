import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  cloneVerifiedStagedFileForChecks,
  computeFileDigest,
  formatWorkspaceResourcesManifest,
  PREFLIGHT_MAX_OUTPUT_JSON_BYTES,
  PREFLIGHT_MAX_PROMPT_RESOURCE_BYTES,
  PREFLIGHT_MAX_PROMPT_RESOURCES_TOTAL_BYTES,
  PREFLIGHT_MAX_WORKSPACE_RESOURCE_BYTES,
  projectVerifiedWorkspaceSource,
  runTaskpackPreflight,
  SecretScrubber,
  TaskpackError,
  validateTaskpackV2Manifest,
  type RunTaskpackPreflightOptions,
  type TaskpackErrorCode,
  type TaskpackV2Manifest,
} from '../src/index.js';

async function withTempDirs(
  fn: (repoRoot: string, outsideDir: string, tempRoot: string) => Promise<void>,
): Promise<void> {
  const base = await realpath(tmpdir());
  const holder = await mkdtemp(join(base, 'lw-tp-preflight-'));
  const repoRoot = join(holder, 'repo');
  const outsideDir = join(holder, 'outside');
  const tempRoot = join(holder, 'temp');
  await mkdir(join(repoRoot, '.loopwright', 'scripts'), { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  await mkdir(tempRoot, { recursive: true });
  try {
    await fn(repoRoot, outsideDir, tempRoot);
  } finally {
    await rm(holder, { recursive: true, force: true });
  }
}

function makePreflightManifest(overrides: Record<string, unknown> = {}): TaskpackV2Manifest {
  return validateTaskpackV2Manifest({
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'Taskpack',
    metadata: { name: 'preflight-test' },
    spec: {
      goal: { candidate: 'Update target.', noChange: 'Confirm no change.' },
      scope: { writable: ['src/**'], protected: [] },
      preflight: {
        script: '.loopwright/scripts/preflight.mjs',
        timeoutSeconds: 30,
        env: ['ALLOWED_FLAG'],
      },
      verification: { localChecks: [], externalGates: [] },
      ...overrides,
    },
  });
}

async function expectPreflightError(
  options: RunTaskpackPreflightOptions,
  expected: TaskpackErrorCode | readonly TaskpackErrorCode[],
): Promise<void> {
  const codes = Array.isArray(expected) ? expected : [expected];
  await assert.rejects(
    () => runTaskpackPreflight(options),
    (err: unknown) => err instanceof TaskpackError && codes.includes(err.code),
  );
}

describe('preflight.ts: CoW reflink + 1 MiB streaming workspace staging and exposeToChecks isolation', () => {
  it('projects >1 MiB multi-chunk binary workspace resources via CoW reflink and 1 MiB fallback with nlink === 1, cas:// URIs, and strict checkStagedDir isolation', async () => {
    await withTempDirs(async (repoRoot, _outsideDir, tempRoot) => {
      const scriptPath = join(repoRoot, '.loopwright', 'scripts', 'preflight.mjs');
      // 1.5 MiB binary payload straddling the 1 MiB (1_048_576) streaming chunk boundary.
      const multiChunkBytes = 1_572_864;
      await writeFile(
        scriptPath,
        `import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const staging = process.env.LOOPWRIGHT_STAGING_DIR;
mkdirSync(join(staging, 'vendor'), { recursive: true });
const buf = Buffer.alloc(${multiChunkBytes}, 0x5a);
buf.set([0x1f, 0x8b, 0x08, 0x00, 0xff], 0);
buf.set([0xde, 0xad, 0xbe, 0xef, 0x00], 1_048_574);
writeFileSync(join(staging, 'vendor', 'archive.bin'), buf);
writeFileSync(join(staging, 'private-notes.bin'), Buffer.from([1, 2, 3, 4]));
writeFileSync(join(staging, 'rubric.md'), '# Small Prompt Rubric\\n', 'utf8');
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({
  disposition: 'candidate',
  stagedResources: [
    { id: 'rubric', kind: 'instruction', path: 'rubric.md', mount: 'prompt' },
    { id: 'archive', kind: 'document', path: 'vendor/archive.bin', mount: 'workspace', exposeToChecks: true },
    { id: 'agent-only', kind: 'document', path: 'private-notes.bin', mount: 'workspace', exposeToChecks: false },
  ],
}));`,
        'utf8',
      );

      const expectedBuf = Buffer.alloc(multiChunkBytes, 0x5a);
      expectedBuf.set([0x1f, 0x8b, 0x08, 0x00, 0xff], 0);
      expectedBuf.set([0xde, 0xad, 0xbe, 0xef, 0x00], 1_048_574);
      const expectedSha = createHash('sha256').update(expectedBuf).digest('hex');

      for (const disableReflink of [false, true]) {
        const scrubber = new SecretScrubber();
        const res = await runTaskpackPreflight({
          manifest: makePreflightManifest(),
          repositoryRoot: repoRoot,
          authorized: true,
          scrubber,
          tempRoot,
          disableReflink,
        });
        try {
          assert.equal(res.scriptSha256, await computeFileDigest(repoRoot, '.loopwright/scripts/preflight.mjs'));
          assert.equal(res.promptResources.length, 1);
          assert.equal(res.workspaceResources.length, 2);
          assert.ok(res.stagedDir !== null && res.checkStagedDir !== null);
          assert.notEqual(res.stagedDir, res.checkStagedDir);

          const archive = res.workspaceResources.find(r => r.id === 'archive')!;
          const agentOnly = res.workspaceResources.find(r => r.id === 'agent-only')!;
          assert.equal(archive.byteLength, multiChunkBytes);
          assert.equal(archive.sha256, expectedSha);
          assert.equal(archive.uri, `cas://sha256/${expectedSha}`);
          assert.ok(archive.checkStagedPath !== null);
          assert.equal(agentOnly.checkStagedPath, null);
          assert.equal(agentOnly.uri, `cas://sha256/${agentOnly.sha256}`);

          const stagedStat = await lstat(archive.stagedPath);
          const checkStat = await lstat(archive.checkStagedPath!);
          const agentOnlyStat = await lstat(agentOnly.stagedPath);
          assert.equal(stagedStat.nlink, 1);
          assert.equal(checkStat.nlink, 1);
          assert.equal(agentOnlyStat.nlink, 1);
          assert.notEqual(stagedStat.ino, checkStat.ino);
          assert.equal(stagedStat.mode & 0o777, 0o444);
          assert.equal(checkStat.mode & 0o777, 0o444);
          assert.equal((await lstat(res.stagedDir)).mode & 0o777, 0o555);
          assert.equal((await lstat(res.checkStagedDir)).mode & 0o777, 0o555);

          assert.equal(Buffer.compare(await readFile(archive.stagedPath), expectedBuf), 0);
          assert.equal(Buffer.compare(await readFile(archive.checkStagedPath!), expectedBuf), 0);
          await assert.rejects(stat(join(res.checkStagedDir, 'private-notes.bin')), { code: 'ENOENT' });

          const manifestSummary = formatWorkspaceResourcesManifest(res.workspaceResources, res.stagedDir, scrubber);
          assert.equal(manifestSummary.includes(`uri=cas://sha256/${expectedSha}`), true);
          assert.equal(manifestSummary.includes(`readOnlyPath=${join(res.stagedDir, 'vendor', 'archive.bin')}`), true);
        } finally {
          await res.cleanup();
        }
        await assert.rejects(stat(res.stagedDir!), { code: 'ENOENT' });
        await assert.rejects(stat(res.checkStagedDir!), { code: 'ENOENT' });
      }
    });
  });

  it('preserves 512 KiB output JSON cap, 64 KiB/256 KiB prompt caps, credential stripping, symlink/hardlink confinement, and cross-chunk secret scrubbing', async () => {
    assert.equal(PREFLIGHT_MAX_OUTPUT_JSON_BYTES, 512 * 1024);
    assert.equal(PREFLIGHT_MAX_PROMPT_RESOURCE_BYTES, 64 * 1024);
    assert.equal(PREFLIGHT_MAX_PROMPT_RESOURCES_TOTAL_BYTES, 256 * 1024);
    assert.equal(PREFLIGHT_MAX_WORKSPACE_RESOURCE_BYTES, 128 * 1024 * 1024);

    await withTempDirs(async (repoRoot, outsideDir, tempRoot) => {
      const scriptPath = join(repoRoot, '.loopwright', 'scripts', 'preflight.mjs');
      await writeFile(scriptPath, 'import { writeFileSync } from "node:fs"; writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, "{\\"disposition\\":\\"no_change\\"}");\n', 'utf8');

      // Unauthorized execution rejected before spawning
      await expectPreflightError(
        { manifest: makePreflightManifest(), repositoryRoot: repoRoot, authorized: false, scrubber: new SecretScrubber(), tempRoot },
        'WEBHOOK_ACTOR_UNAUTHORIZED',
      );

      // 512 KiB + 1 output JSON rejected
      await writeFile(
        scriptPath,
        `import { writeFileSync } from 'node:fs';
const pad = 'a'.repeat(${PREFLIGHT_MAX_OUTPUT_JSON_BYTES});
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, '{"disposition":"no_change","reason":"' + pad + '"}');`,
        'utf8',
      );
      await expectPreflightError(
        { manifest: makePreflightManifest(), repositoryRoot: repoRoot, authorized: true, scrubber: new SecretScrubber(), tempRoot },
        'TASKPACK_MANIFEST_INVALID',
      );

      // 64 KiB + 1 mount: 'prompt' resource rejected
      await writeFile(
        scriptPath,
        `import { writeFileSync } from 'node:fs'; import { join } from 'node:path';
writeFileSync(join(process.env.LOOPWRIGHT_STAGING_DIR, 'big.md'), 'x'.repeat(${PREFLIGHT_MAX_PROMPT_RESOURCE_BYTES + 1}), 'utf8');
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({
  disposition: 'candidate',
  stagedResources: [{ id: 'big', kind: 'instruction', path: 'big.md', mount: 'prompt' }],
}));`,
        'utf8',
      );
      await expectPreflightError(
        { manifest: makePreflightManifest(), repositoryRoot: repoRoot, authorized: true, scrubber: new SecretScrubber(), tempRoot },
        'TASKPACK_MANIFEST_INVALID',
      );

      // Secret spanning 1 MiB chunk boundary in mount: 'workspace' fails closed with TOKEN_SECRET_LEAK_DETECTED
      const brokerSecret = 'lw_super_secret_broker_token_9876543210';
      await writeFile(
        scriptPath,
        `import { writeFileSync } from 'node:fs'; import { join } from 'node:path';
const prefix = Buffer.alloc(1_048_576 - 12, 0x41);
const suffix = Buffer.alloc(65_536, 0x42);
const secretBuf = Buffer.from(process.env.BROKERED_SECRET ?? '', 'utf8');
writeFileSync(join(process.env.LOOPWRIGHT_STAGING_DIR, 'leaked.bin'), Buffer.concat([prefix, secretBuf, suffix]));
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({
  disposition: 'candidate',
  stagedResources: [{ id: 'leaked', kind: 'document', path: 'leaked.bin', mount: 'workspace' }],
}));`,
        'utf8',
      );
      await expectPreflightError(
        {
          manifest: makePreflightManifest(),
          repositoryRoot: repoRoot,
          authorized: true,
          scrubber: new SecretScrubber(),
          tempRoot,
          brokeredEnv: { BROKERED_SECRET: brokerSecret },
          disableReflink: true,
        },
        'TOKEN_SECRET_LEAK_DETECTED',
      );

      // Symlink and hardlink escapes in staging dir rejected without mutating outside file mode
      const outsideSecret = join(outsideDir, 'secret.txt');
      await writeFile(outsideSecret, 'OUTSIDE_DATA', { mode: 0o755 });
      await chmod(outsideSecret, 0o755);
      await writeFile(
        scriptPath,
        `import { linkSync, writeFileSync } from 'node:fs'; import { join } from 'node:path';
linkSync(${JSON.stringify(outsideSecret)}, join(process.env.LOOPWRIGHT_STAGING_DIR, 'hardlink.bin'));
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({
  disposition: 'candidate',
  stagedResources: [{ id: 'hl', kind: 'document', path: 'hardlink.bin', mount: 'workspace' }],
}));`,
        'utf8',
      );
      await expectPreflightError(
        { manifest: makePreflightManifest(), repositoryRoot: repoRoot, authorized: true, scrubber: new SecretScrubber(), tempRoot },
        'TASKPACK_SCOPE_VIOLATION',
      );
      assert.equal((await lstat(outsideSecret)).mode & 0o777, 0o755);

      await rm(scriptPath);
      await symlink(outsideSecret, scriptPath);
      await expectPreflightError(
        { manifest: makePreflightManifest(), repositoryRoot: repoRoot, authorized: true, scrubber: new SecretScrubber(), tempRoot },
        'TASKPACK_SCOPE_VIOLATION',
      );
    });
  });

  it('verifies SHA-256 on CoW reflink check projections and rejects hardlinked repo-backed resources', async () => {
    await withTempDirs(async (repoRoot, outsideDir, tempRoot) => {
      // 1. cloneVerifiedStagedFileForChecks rejects digest mismatch on BOTH CoW reflink and 1 MiB stream paths and removes bad projection
      const verifiedDir = join(tempRoot, 'verified-src');
      const checkRoot = join(tempRoot, 'check-proj');
      await mkdir(verifiedDir, { recursive: true });
      await mkdir(checkRoot, { recursive: true });
      const payload = Buffer.alloc(1_100_000, 0x3c);
      payload.set([0xca, 0xfe, 0xba, 0xbe], 1_048_574);
      const verifiedSrcPath = join(verifiedDir, 'bundle.bin');
      await writeFile(verifiedSrcPath, payload, { mode: 0o444 });
      const realSha = createHash('sha256').update(payload).digest('hex');
      const wrongSha = '0'.repeat(64);

      for (const disableReflink of [false, true]) {
        const rel = `sub-${String(disableReflink)}/bundle.bin`;
        await assert.rejects(
          () => cloneVerifiedStagedFileForChecks({
            verifiedSrcPath,
            checkStagedRootDir: checkRoot,
            relativePath: rel,
            expectedByteLength: payload.byteLength,
            expectedSha256: wrongSha,
            disableReflink,
            diagPath: '/preflight/stagedResources/0',
          }),
          (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_SCOPE_VIOLATION',
        );
        await assert.rejects(stat(join(checkRoot, rel)), { code: 'ENOENT' });

        const okDest = await cloneVerifiedStagedFileForChecks({
          verifiedSrcPath,
          checkStagedRootDir: checkRoot,
          relativePath: rel,
          expectedByteLength: payload.byteLength,
          expectedSha256: realSha,
          disableReflink,
          diagPath: '/preflight/stagedResources/0',
        });
        const okStat = await lstat(okDest);
        assert.equal(okStat.nlink, 1);
        assert.equal(okStat.mode & 0o777, 0o444);
      }

      // 2. Repository-backed (sourceRoot === 'repo') hardlinked files (nlink > 1) fail closed with TASKPACK_SCOPE_VIOLATION
      const outsideTarget = join(outsideDir, 'outside-repo-hl.txt');
      await writeFile(outsideTarget, 'REPO_HARDLINK_SECRET\n', 'utf8');
      await link(outsideTarget, join(repoRoot, 'repo-prompt-hl.md'));
      await link(outsideTarget, join(repoRoot, 'repo-workspace-hl.txt'));

      const scriptPath = join(repoRoot, '.loopwright', 'scripts', 'preflight.mjs');
      await writeFile(
        scriptPath,
        `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({
  disposition: 'candidate',
  stagedResources: [{ id: 'repo-p', kind: 'instruction', path: 'repo-prompt-hl.md', mount: 'prompt' }],
}));`,
        'utf8',
      );
      await expectPreflightError(
        { manifest: makePreflightManifest(), repositoryRoot: repoRoot, authorized: true, scrubber: new SecretScrubber(), tempRoot },
        'TASKPACK_SCOPE_VIOLATION',
      );

      for (const disableReflink of [false, true]) {
        await writeFile(
          scriptPath,
          `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({
  disposition: 'candidate',
  stagedResources: [{ id: 'repo-w', kind: 'document', path: 'repo-workspace-hl.txt', mount: 'workspace' }],
}));`,
          'utf8',
        );
        await expectPreflightError(
          {
            manifest: makePreflightManifest(),
            repositoryRoot: repoRoot,
            authorized: true,
            scrubber: new SecretScrubber(),
            tempRoot,
            disableReflink,
          },
          'TASKPACK_SCOPE_VIOLATION',
        );
      }

      // 3. R2-6 & R2-7: projectVerifiedWorkspaceSource and cloneVerifiedStagedFileForChecks preserve pre-existing destination files on EEXIST without unlinking
      const collisionRoot = join(tempRoot, 'collision-root');
      const srcDir = join(tempRoot, 'collision-src');
      await mkdir(collisionRoot, { recursive: true });
      await mkdir(srcDir, { recursive: true });
      const cleanSrc = join(srcDir, 'clean.txt');
      const cleanPayload = Buffer.from('CLEAN_PINNED_SOURCE_CONTENT\n', 'utf8');
      await writeFile(cleanSrc, cleanPayload, { mode: 0o600 });
      const cleanSha = createHash('sha256').update(cleanPayload).digest('hex');

      for (const disableReflink of [false, true]) {
        const okRel = `ok-${String(disableReflink)}/clean.txt`;
        const projected = await projectVerifiedWorkspaceSource({
          srcFullPath: cleanSrc,
          stagedRootDir: collisionRoot,
          relativePath: okRel,
          maxFileBytes: 1_048_576,
          maxRemainingTotalBytes: 1_048_576,
          requireSingleLink: true,
          disableReflink,
          scrubber: new SecretScrubber(),
          strippedScrubber: new SecretScrubber(),
          diagPath: '/preflight/stagedResources/0',
        });
        assert.equal(projected.sha256, cleanSha);
        assert.equal(projected.byteLength, cleanPayload.byteLength);
        const projStat = await lstat(projected.destPath);
        assert.equal(projStat.nlink, 1);
        assert.equal(projStat.mode & 0o777, 0o444);

        const wsSentinelDir = join(collisionRoot, `ws-collide-${String(disableReflink)}`);
        const wsSentinelRel = `ws-collide-${String(disableReflink)}/sentinel.txt`;
        const wsSentinelFull = join(collisionRoot, wsSentinelRel);
        await mkdir(wsSentinelDir, { recursive: true });
        await writeFile(wsSentinelFull, 'DO_NOT_DELETE_WS_SENTINEL\n', { mode: 0o640 });
        await chmod(wsSentinelFull, 0o640);
        await assert.rejects(
          () => projectVerifiedWorkspaceSource({
            srcFullPath: cleanSrc,
            stagedRootDir: collisionRoot,
            relativePath: wsSentinelRel,
            maxFileBytes: 1_048_576,
            maxRemainingTotalBytes: 1_048_576,
            requireSingleLink: true,
            disableReflink,
            scrubber: new SecretScrubber(),
            strippedScrubber: new SecretScrubber(),
            diagPath: '/preflight/stagedResources/0',
          }),
        );
        assert.equal(await readFile(wsSentinelFull, 'utf8'), 'DO_NOT_DELETE_WS_SENTINEL\n');
        assert.equal((await lstat(wsSentinelFull)).mode & 0o777, 0o640, 'existing sentinel mode must not be chmodded to 0o444');
        assert.deepEqual(await readdir(wsSentinelDir), ['sentinel.txt'], 'private .lw-stage-* temp file must be cleaned up');

        const checkSentinelDir = join(collisionRoot, `check-collide-${String(disableReflink)}`);
        const checkSentinelRel = `check-collide-${String(disableReflink)}/sentinel.txt`;
        const checkSentinelFull = join(collisionRoot, checkSentinelRel);
        await mkdir(checkSentinelDir, { recursive: true });
        await writeFile(checkSentinelFull, 'DO_NOT_DELETE_CHECK_SENTINEL\n', { mode: 0o640 });
        await chmod(checkSentinelFull, 0o640);
        await assert.rejects(
          () => cloneVerifiedStagedFileForChecks({
            verifiedSrcPath,
            checkStagedRootDir: collisionRoot,
            relativePath: checkSentinelRel,
            expectedByteLength: payload.byteLength,
            expectedSha256: realSha,
            disableReflink,
            diagPath: '/preflight/stagedResources/0',
          }),
        );
        assert.equal(await readFile(checkSentinelFull, 'utf8'), 'DO_NOT_DELETE_CHECK_SENTINEL\n');
        assert.equal((await lstat(checkSentinelFull)).mode & 0o777, 0o640, 'existing check sentinel mode must not be chmodded to 0o444');
        assert.deepEqual(await readdir(checkSentinelDir), ['sentinel.txt'], 'private .lw-stage-* temp file must be cleaned up');
      }
    });
  });
});
