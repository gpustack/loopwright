import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { loadTrustedConfiguration, stepNext, stepSubmit } from '@loopwright/controller';
import {
  alignBaselineRevisions,
  assertExtractedConflictsResolved,
  BASELINE_ALIGNMENT_POLICIES,
  BASELINE_CONFLICT_REASON,
  BASELINE_CONFLICT_RESOURCE_ID,
  BASELINE_CONFLICT_RESOURCE_PATH,
  compileDeclarativeTaskpack,
  computeThreeWaySourceRevisionCarryDelta,
  containsResidualGitConflictMarkers,
  DEFAULT_BASELINE_ALIGNMENT_POLICY,
  DEFAULT_BASELINE_MAX_CONFLICT_BYTES,
  DEFAULT_BASELINE_MAX_CONFLICT_FILES,
  DEFAULT_HOST_BUDGETS,
  DEFAULT_LOCAL_COMMAND_GATE_ENV,
  ensureCarryBlobsInGitObjectStore,
  executeTurnkeyCycle,
  listTreeEntriesAtRevision,
  mergeCandidateOverlayWithCarry,
  openStagedTaskpackStepGate,
  parseBaselineAlignmentPolicy,
  parseTaskpackManifest,
  resolveBaselineAlignmentConfig,
  runTurnkeyTaskpack,
  SecretScrubber,
  serializePrettyYaml,
  stageCompiledInstructionResources,
  stageEntriesInIndex,
  stageTaskpackForStep,
  TaskpackError,
  validateBaselineAlignmentDeclaration,
  validateTaskpackV2Manifest,
  verifyCandidateBaselinePrePublication,
  type WrittenCompiledTaskpack,
} from '../src/index.js';

function git(cwd: string, args: readonly string[]): string {
  const res = spawnSync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args],
    {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'Loopwright Test',
        GIT_AUTHOR_EMAIL: 'test@loopwright.invalid',
        GIT_COMMITTER_NAME: 'Loopwright Test',
        GIT_COMMITTER_EMAIL: 'test@loopwright.invalid',
      },
    },
  );
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${String(res.status)}): ${res.stderr}`);
  }
  return res.stdout.trim();
}

async function snapshotGitObjects(repoRoot: string): Promise<readonly string[]> {
  const objectsRoot = join(repoRoot, '.git', 'objects');
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === 'maintenance.lock') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        const st = await lstat(full);
        found.push(`${relative(objectsRoot, full)}:${st.size}`);
      }
    }
  };
  await walk(objectsRoot);
  return found;
}

async function removeTreeForce(targetDir: string): Promise<void> {
  const unlock = async (dir: string): Promise<void> => {
    await chmod(dir, 0o700).catch(() => undefined);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await unlock(join(dir, entry.name));
      }
    }
  };
  await unlock(targetDir);
  await rm(targetDir, { recursive: true, force: true });
}

function makeBaseManifestObject(extraSpec: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'Taskpack',
    metadata: { name: 'align-pack' },
    spec: {
      goal: { candidate: 'Update src files cleanly.', noChange: 'Confirm no change.' },
      scope: { writable: ['src/**'], protected: ['docs/protected/**'] },
      proposal: {
        path: 'src/proposal.json',
        requiredFields: ['schema_version', 'status'],
        schemaVersion: 1,
      },
      verification: {
        localChecks: [
          {
            id: 'artifact-json',
            implementation: 'json-artifact.v1',
          },
        ],
        externalGates: [],
      },
      publication: { mode: 'disabled' },
      ...extraSpec,
    },
  };
}

function sseToolCall(model: string, id: string, name: string, args: Record<string, unknown>): string {
  return [
    `data: ${JSON.stringify({
      id: `chatcmpl-${id}`,
      model,
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
        },
        finish_reason: null,
      }],
    })}`,
    '',
    `data: ${JSON.stringify({
      id: `chatcmpl-${id}`,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 },
    })}`,
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n');
}

function sseStop(model: string, text: string): string {
  return [
    `data: ${JSON.stringify({
      id: 'chatcmpl-final',
      model,
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 },
    })}`,
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n');
}

async function startLoopbackOpenAiServer(
  onChatTurn: (turnIndex: number, body: Record<string, unknown>) => string,
): Promise<{ readonly baseUrl: string; close(): Promise<void> }> {
  let turnIndex = 0;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw.trim().length > 0 ? JSON.parse(raw) as Record<string, unknown> : {};
    if (body['max_tokens'] === 1 && body['stream'] !== true) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'OK' } }] }));
      return;
    }
    const sse = onChatTurn(turnIndex++, body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse);
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('failed to bind loopback OpenAI server');
  }
  return {
    baseUrl: `http://127.0.0.1:${addr.port}/v1`,
    close: async () => await new Promise<void>(resolveClose => server.close(() => resolveClose())),
  };
}

async function writeLoopbackModelsJson(dir: string, fileName: string, baseUrl: string): Promise<string> {
  const modelsJsonPath = join(dir, fileName);
  await writeFile(
    modelsJsonPath,
    JSON.stringify({
      providers: {
        'local-oai': {
          baseUrl,
          api: 'openai-completions',
          apiKey: 'LOCAL_OAI_KEY',
          models: [{ id: 'mock-model', contextWindow: 128_000, maxTokens: 4_096 }],
        },
      },
    }),
    'utf8',
  );
  return modelsJsonPath;
}

function createSpyOnlyAdapter(callCounter: { count: number }) {
  return (async () => {
    callCounter.count += 1;
    throw new Error('adapter should never be invoked when pre-probe baseline alignment blocks');
  }) as unknown as NonNullable<Parameters<typeof executeTurnkeyCycle>[0]['openHostSessionAdapter']>;
}

describe('baseline-align: schema, isolated 3-way merge, 3-way carry blobs, conflict extraction, and RunEval wiring', { concurrency: 1 }, () => {
  it('validates spec.baselineAlignment defaults, bounds, null-prototype objects, runtime overrides, and rejects invalid inputs', () => {
    assert.deepEqual(BASELINE_ALIGNMENT_POLICIES, ['off', 'fail-fast', 'extract-context']);
    assert.equal(DEFAULT_BASELINE_ALIGNMENT_POLICY, 'off');
    assert.equal(DEFAULT_BASELINE_MAX_CONFLICT_FILES, 16);
    assert.equal(DEFAULT_BASELINE_MAX_CONFLICT_BYTES, 65_536);

    // Omitted spec.baselineAlignment resolves to defaults
    const omittedManifest = validateTaskpackV2Manifest(makeBaseManifestObject() as never);
    assert.equal(omittedManifest.spec.baselineAlignment, undefined);
    assert.deepEqual(resolveBaselineAlignmentConfig(omittedManifest.spec.baselineAlignment), {
      policy: 'off',
      maxConflictFiles: 16,
      maxConflictBytes: 65_536,
    });

    // Explicit YAML/object declarations across all 3 policies and exact boundary min/max values
    for (const policy of ['off', 'fail-fast', 'extract-context'] as const) {
      const parsed = parseTaskpackManifest(
        serializePrettyYaml(
          makeBaseManifestObject({
            baselineAlignment: {
              policy,
              maxConflictFiles: policy === 'off' ? 1 : 64,
              maxConflictBytes: policy === 'off' ? 1_024 : 262_144,
            },
          }),
        ),
      );
      assert.deepEqual(parsed.spec.baselineAlignment, {
        policy,
        maxConflictFiles: policy === 'off' ? 1 : 64,
        maxConflictBytes: policy === 'off' ? 1_024 : 262_144,
      });
    }

    // Null-prototype object support with Object.hasOwn
    const nullProtoAlignment = Object.assign(Object.create(null) as Record<string, unknown>, {
      policy: 'extract-context',
    });
    assert.deepEqual(validateBaselineAlignmentDeclaration(nullProtoAlignment), {
      policy: 'extract-context',
      maxConflictFiles: 16,
      maxConflictBytes: 65_536,
    });

    const nullProtoOverride = Object.assign(Object.create(null) as Record<string, unknown>, {
      policy: 'fail-fast',
      maxConflictFiles: 8,
      maxConflictBytes: 4_096,
    });
    assert.deepEqual(
      resolveBaselineAlignmentConfig({ policy: 'off', maxConflictFiles: 32, maxConflictBytes: 8_192 }, nullProtoOverride as never),
      { policy: 'fail-fast', maxConflictFiles: 8, maxConflictBytes: 4_096 },
    );
    assert.deepEqual(
      resolveBaselineAlignmentConfig({ policy: 'off', maxConflictFiles: 12, maxConflictBytes: 16_384 }, 'extract-context'),
      { policy: 'extract-context', maxConflictFiles: 12, maxConflictBytes: 16_384 },
    );
    assert.equal(parseBaselineAlignmentPolicy('fail-fast'), 'fail-fast');

    // Reject invalid values, out-of-range integers, unknown keys, and non-objects
    const invalidInputs: readonly unknown[] = [
      null,
      'fail-fast',
      [],
      { policy: 'unknown-mode' },
      { policy: 123 },
      { policy: 'off', maxConflictFiles: 0 },
      { policy: 'off', maxConflictFiles: 65 },
      { policy: 'off', maxConflictFiles: 2.5 },
      { policy: 'off', maxConflictFiles: -0 },
      { policy: 'off', maxConflictBytes: 1_023 },
      { policy: 'off', maxConflictBytes: 262_145 },
      { policy: 'off', maxConflictBytes: '65536' },
      { policy: 'off', extraField: true },
      Object.assign(Object.create(null) as Record<string, unknown>, { policy: 'off', constructor: 'bad' }),
    ];
    for (const bad of invalidInputs) {
      assert.throws(
        () => validateBaselineAlignmentDeclaration(bad),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
        `expected rejection for ${JSON.stringify(bad)}`,
      );
    }
    assert.throws(
      () => parseBaselineAlignmentPolicy('auto-merge'),
      (err: unknown) => err instanceof TaskpackError && err.code === 'ACTION_INPUT_INVALID',
    );
  });

  it('runs isolated 3-way merge probes (primary merge-tree and index fallback) with ZERO new objects in host .git/objects and zero ref/worktree mutations', async () => {
    const holder = await mkdtemp(join(await realpath(tmpdir()), 'lw-align-iso-'));
    const repoRoot = join(holder, 'repo');
    const scratchRoot = join(holder, 'scratch');
    try {
      await mkdir(join(repoRoot, 'src'), { recursive: true });
      await mkdir(scratchRoot, { recursive: true });
      git(repoRoot, ['init', '-b', 'main']);

      await writeFile(join(repoRoot, 'src', 'app.ts'), 'const a = 1;\nconst mid = 0;\nconst b = 1;\n', 'utf8');
      await writeFile(join(repoRoot, 'src', 'conflict.ts'), 'export const v = "orig";\n', 'utf8');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'merge-base']);
      const mergeBaseSha = git(repoRoot, ['rev-parse', 'HEAD']);

      git(repoRoot, ['checkout', '-b', 'pr-branch']);
      await writeFile(join(repoRoot, 'src', 'app.ts'), 'const a = 1;\nconst mid = 0;\nconst b = 2;\n', 'utf8');
      await writeFile(join(repoRoot, 'src', 'conflict.ts'), 'export const v = "from-source";\n', 'utf8');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'source commit']);
      const sourceSha = git(repoRoot, ['rev-parse', 'HEAD']);

      git(repoRoot, ['checkout', 'main']);
      await writeFile(join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst mid = 0;\nconst b = 1;\n', 'utf8');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'base disjoint commit']);
      const cleanBaseSha = git(repoRoot, ['rev-parse', 'HEAD']);

      // Also create a conflicting base commit on another ref to test conflicted probe isolation
      git(repoRoot, ['checkout', '-b', 'conflicting-main', cleanBaseSha]);
      await writeFile(join(repoRoot, 'src', 'conflict.ts'), 'export const v = "from-base";\n', 'utf8');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'base conflict commit']);
      const conflictBaseSha = git(repoRoot, ['rev-parse', 'HEAD']);
      git(repoRoot, ['checkout', 'main']);

      const manifest = validateTaskpackV2Manifest(makeBaseManifestObject() as never);
      const objectsBefore = await snapshotGitObjects(repoRoot);
      const refsBefore = git(repoRoot, ['for-each-ref']);
      const statusBefore = git(repoRoot, ['status', '--porcelain']);

      for (const forceIndexFallback of [false, true]) {
        const cleanAligned = await alignBaselineRevisions({
          repositoryRoot: repoRoot,
          baseRevision: cleanBaseSha,
          sourceRevision: sourceSha,
          manifest,
          baselineAlignment: 'fail-fast',
          scratchRoot,
          forceIndexFallback,
        });
        assert.equal(cleanAligned.disposition, 'clean');
        assert.equal(cleanAligned.mergeBase, mergeBaseSha);
        assert.equal(cleanAligned.conflictPaths.length, 0);
        const appCarry = cleanAligned.carryUpdates.find(u => u.path === 'src/app.ts');
        assert.ok(appCarry !== undefined, 'expected 3-way merged carry update for src/app.ts');
        assert.ok(appCarry.bytes !== undefined);
        assert.equal(
          Buffer.from(appCarry.bytes).toString('utf8'),
          'const a = 2;\nconst mid = 0;\nconst b = 2;\n',
        );

        const conflictAligned = await alignBaselineRevisions({
          repositoryRoot: repoRoot,
          baseRevision: conflictBaseSha,
          sourceRevision: sourceSha,
          manifest,
          baselineAlignment: 'fail-fast',
          scratchRoot,
          forceIndexFallback,
        });
        assert.equal(conflictAligned.disposition, 'blocked');
        assert.equal(conflictAligned.reason, 'baseline_merge_conflict');
        assert.deepEqual(conflictAligned.conflictPaths, ['src/conflict.ts']);
      }

      const objectsAfter = await snapshotGitObjects(repoRoot);
      const refsAfter = git(repoRoot, ['for-each-ref']);
      const statusAfter = git(repoRoot, ['status', '--porcelain']);
      const remainingScratch = await readdir(scratchRoot);

      assert.deepEqual(objectsAfter, objectsBefore, 'host .git/objects must receive ZERO new objects');
      assert.equal(refsAfter, refsBefore, 'host refs must remain completely unchanged');
      assert.equal(statusAfter, statusBefore, 'host working tree must remain completely clean');
      assert.deepEqual(remainingScratch, [], 'temporary GIT_OBJECT_DIRECTORY must be cleaned up in finally');
    } finally {
      await removeTreeForce(holder);
    }
  });

  it('preserves BOTH baseRevision and sourceRevision lines on disjoint same-file edits across command.v1 verification and git index staging', async () => {
    const holder = await mkdtemp(join(await realpath(tmpdir()), 'lw-align-carry-'));
    const repoRoot = join(holder, 'repo');
    const runRoot = join(holder, 'runs');
    try {
      await mkdir(join(repoRoot, '.loopwright', 'checks'), { recursive: true });
      await mkdir(join(repoRoot, 'src'), { recursive: true });
      git(repoRoot, ['init', '-b', 'main']);

      await writeFile(
        join(repoRoot, 'src', 'shared.txt'),
        ['header-orig', 'keep-1', 'keep-2', 'keep-3', 'footer-orig'].join('\n') + '\n',
        'utf8',
      );
      await writeFile(join(repoRoot, 'src', 'obsolete.txt'), 'remove-me\n', 'utf8');
      await writeFile(join(repoRoot, 'src', 'proposal.json'), '{"status":"init"}\n', 'utf8');
      await writeFile(
        join(repoRoot, '.loopwright', 'checks', 'verify-merge.sh'),
        [
          '#!/bin/sh',
          'set -eu',
          'expected_shared=$(printf "header-from-base\\nkeep-1\\nkeep-2\\nkeep-3\\nfooter-from-source")',
          'actual_shared=$(cat src/shared.txt)',
          'test "$actual_shared" = "$expected_shared" || { echo "shared mismatch: $actual_shared"; exit 1; }',
          'test "$(cat src/base-added.txt)" = "added-on-base" || { echo "base-added mismatch"; exit 1; }',
          'test ! -e src/obsolete.txt || { echo "obsolete still exists"; exit 1; }',
          'test "$(cat src/proposal.json)" = \'{"status":"ready"}\' || { echo "proposal mismatch: $(cat src/proposal.json)"; exit 1; }',
        ].join('\n') + '\n',
        { mode: 0o755 },
      );
      await writeFile(
        join(repoRoot, '.loopwright', 'taskpack.yaml'),
        serializePrettyYaml({
          apiVersion: 'loopwright.dev/v1alpha1',
          kind: 'Taskpack',
          metadata: { name: 'disjoint-carry' },
          spec: {
            goal: { candidate: 'Update proposal.json.', noChange: 'No change.' },
            scope: { writable: ['src/**'], protected: [] },
            verification: {
              localChecks: [
                {
                  id: 'verify-merge',
                  implementation: 'command.v1',
                  parameters: { script: '.loopwright/checks/verify-merge.sh', timeoutSeconds: 20 },
                },
              ],
              externalGates: [],
            },
            publication: { mode: 'disabled' },
          },
        }),
        'utf8',
      );
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'initial']);

      // PR branch (sourceRevision): modifies footer of shared.txt and deletes obsolete.txt
      git(repoRoot, ['checkout', '-b', 'pr-head']);
      await writeFile(
        join(repoRoot, 'src', 'shared.txt'),
        ['header-orig', 'keep-1', 'keep-2', 'keep-3', 'footer-from-source'].join('\n') + '\n',
        'utf8',
      );
      await rm(join(repoRoot, 'src', 'obsolete.txt'));
      git(repoRoot, ['add', '-A']);
      git(repoRoot, ['commit', '-m', 'pr edits footer and deletes obsolete']);
      const sourceRevision = git(repoRoot, ['rev-parse', 'HEAD']);

      // Main branch (baseRevision): modifies header of shared.txt and adds base-added.txt
      git(repoRoot, ['checkout', 'main']);
      await writeFile(
        join(repoRoot, 'src', 'shared.txt'),
        ['header-from-base', 'keep-1', 'keep-2', 'keep-3', 'footer-orig'].join('\n') + '\n',
        'utf8',
      );
      await writeFile(join(repoRoot, 'src', 'base-added.txt'), 'added-on-base\n', 'utf8');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'main edits header and adds base-added']);
      const baseRevision = git(repoRoot, ['rev-parse', 'HEAD']);

      const objectsBeforeVerification = await snapshotGitObjects(repoRoot);

      // Run delegated step flow where agent ONLY updates src/proposal.json on sourceRevision;
      // command.v1 gate must materialize the 3-way merged src/shared.txt + src/base-added.txt!
      const runId = 'disjoint-carry-run';
      const staged = await stageTaskpackForStep({
        taskpackPath: '.loopwright/taskpack.yaml',
        repositoryRoot: repoRoot,
        runRoot,
        runId,
        baseRevision,
        sourceRevision,
        runtimeEnv: {},
      });
      const gateHandle = await openStagedTaskpackStepGate({ runRoot, runId, runtimeEnv: {} });
      assert.ok(gateHandle !== null);
      try {
        const prevSecret = process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV];
        process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV] = gateHandle.environment(DEFAULT_LOCAL_COMMAND_GATE_ENV);
        let loadedCfg: Awaited<ReturnType<typeof loadTrustedConfiguration>>;
        try {
          loadedCfg = await loadTrustedConfiguration({
            configPath: staged.configPath,
            registryPath: staged.registryPath,
            registrySha256: staged.registrySha256,
            untrustedRoots: [repoRoot],
          });
        } finally {
          if (prevSecret === undefined) delete process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV];
          else process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV] = prevSecret;
        }
        assert.equal(loadedCfg.ok, true);
        if (!loadedCfg.ok) return;
        assert.equal(loadedCfg.value.configuration.spec.task.spec.target.sourceRevision, sourceRevision);

        const next = await stepNext(
          {
            configuration: loadedCfg.value,
            repository: repoRoot,
            runRoot,
            runId,
            policyProfile: gateHandle.policyProfile,
            environment: gateHandle.environment,
          },
          gateHandle.ports,
        );
        assert.equal(next.ok, true);
        if (!next.ok || next.value.kind !== 'step') return;

        await writeFile(join(next.value.candidateDir, 'src', 'proposal.json'), '{"status":"ready"}\n', 'utf8');
        const submitted = await stepSubmit(
          {
            runRoot,
            runId,
            leaseToken: next.value.leaseToken,
            status: 'completed',
            reason: 'updated proposal',
            environment: gateHandle.environment,
          },
          gateHandle.ports,
        );
        assert.equal(submitted.ok, true, submitted.ok ? '' : JSON.stringify(submitted.error));
        if (!submitted.ok) return;
        assert.equal(
          submitted.value.kind === 'result' ? submitted.value.result.spec.status : `${submitted.value.kind}:${JSON.stringify(submitted.value)}`,
          'completed',
        );
      } finally {
        await gateHandle.close();
      }

      // Host .git/objects MUST still be untouched after verification!
      const objectsAfterVerification = await snapshotGitObjects(repoRoot);
      assert.deepEqual(objectsAfterVerification, objectsBeforeVerification);

      // Verify shared publisher helper ensureCarryBlobsInGitObjectStore writes exact OID for git index staging
      const gitEnv = {
        PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      };
      const baseEntries = await listTreeEntriesAtRevision(repoRoot, baseRevision, gitEnv);
      const sourceEntries = await listTreeEntriesAtRevision(repoRoot, sourceRevision, gitEnv);
      const manifest = validateTaskpackV2Manifest(makeBaseManifestObject() as never);
      const compiled = await compileDeclarativeTaskpack(manifest, {
        mode: 'candidate',
        repository: 'acme/repo',
        repositoryRoot: repoRoot,
        baseRevision,
        sourceRevision,
        budgets: DEFAULT_HOST_BUDGETS,
        credentialEnvMap: { provider: 'LOOPWRIGHT_PROVIDER_TOKEN' },
      });
      const delta = await computeThreeWaySourceRevisionCarryDelta({
        repositoryRoot: repoRoot,
        baseRevision,
        sourceRevision,
        snapshot: {
          contract: compiled.config.spec.task,
          protectedPaths: compiled.config.spec.task.spec.scope.protected,
        },
        baseEntries,
        sourceEntries,
      });
      assert.deepEqual(delta.carryRemovals, ['src/obsolete.txt']);
      const sharedUpdate = delta.carryUpdates.find(u => u.path === 'src/shared.txt');
      assert.ok(sharedUpdate !== undefined && sharedUpdate.bytes !== undefined);
      assert.equal(
        Buffer.from(sharedUpdate.bytes).toString('utf8'),
        ['header-from-base', 'keep-1', 'keep-2', 'keep-3', 'footer-from-source'].join('\n') + '\n',
      );
      await ensureCarryBlobsInGitObjectStore({
        repositoryRoot: repoRoot,
        carryUpdates: delta.carryUpdates,
        objectFormat: 'sha1',
        gitEnv,
      });
      const tempIndex = join(holder, 'pub-index');
      spawnSync('git', ['-C', repoRoot, 'read-tree', `${baseRevision}^{tree}`], {
        env: { ...gitEnv, GIT_INDEX_FILE: tempIndex },
      });
      await stageEntriesInIndex(repoRoot, tempIndex, delta.carryUpdates, gitEnv);
      const stagedTreeOid = spawnSync('git', ['-C', repoRoot, 'write-tree'], {
        env: { ...gitEnv, GIT_INDEX_FILE: tempIndex },
        encoding: 'utf8',
      }).stdout.trim();
      const publishedShared = git(repoRoot, ['cat-file', 'blob', `${stagedTreeOid}:src/shared.txt`]);
      assert.equal(publishedShared, ['header-from-base', 'keep-1', 'keep-2', 'keep-3', 'footer-from-source'].join('\n'));

      // Also verify same_revision fast-paths and verifyCandidateBaselinePrePublication over classic snapshots
      const sameRev = await alignBaselineRevisions({
        repositoryRoot: repoRoot,
        baseRevision,
        sourceRevision: baseRevision,
        manifest,
      });
      assert.equal(sameRev.disposition, 'clean');
      assert.equal(sameRev.status, 'same_revision');

      const sameCarry = await computeThreeWaySourceRevisionCarryDelta({
        repositoryRoot: repoRoot,
        baseRevision,
        sourceRevision: baseRevision,
        snapshot: {
          contract: compiled.config.spec.task,
          protectedPaths: compiled.config.spec.task.spec.scope.protected,
        },
      });
      assert.deepEqual(sameCarry.carryUpdates, []);

      const prePubDelta = await verifyCandidateBaselinePrePublication({
        repositoryRoot: repoRoot,
        snapshot: {
          lock: {},
          contract: compiled.config.spec.task,
          protectedPaths: compiled.config.spec.task.spec.scope.protected,
          baseRevision,
          sourceRevision,
          manifest: {
            apiVersion: 'loopwright.dev/v1alpha1',
            kind: 'ArtifactManifest',
            metadata: { id: 'manifest-1' },
            spec: { entries: [] },
          },
          files: [
            {
              kind: 'inline',
              name: 'src/shared.txt',
              mode: '100644',
              bytes: Buffer.from(['header-orig', 'keep-1', 'keep-2', 'keep-3', 'footer-from-source'].join('\n') + '\n', 'utf8'),
            },
            {
              kind: 'inline',
              name: 'src/proposal.json',
              mode: '100644',
              bytes: Buffer.from('{"status":"ready"}\n', 'utf8'),
            },
          ],
        },
        gitEnv,
      });
      assert.ok(prePubDelta.carryUpdates.some(u => u.path === 'src/shared.txt'));
      assert.deepEqual(prePubDelta.reconciledOverlayFiles.map(f => f.name), ['src/proposal.json']);
    } finally {
      await removeTreeForce(holder);
    }
  });

  it('halts conflicted branches under fail-fast as blocked (baseline_merge_conflict) BEFORE any provider health probe or model call', async () => {
    const holder = await mkdtemp(join(await realpath(tmpdir()), 'lw-align-ff-'));
    const repoRoot = join(holder, 'repo');
    const runRoot = join(holder, 'runs');
    try {
      await mkdir(join(repoRoot, 'src'), { recursive: true });
      git(repoRoot, ['init', '-b', 'main']);

      await writeFile(join(repoRoot, 'src', 'service.ts'), 'export const port = 3000;\n', 'utf8');
      await writeFile(join(repoRoot, 'src', 'proposal.json'), '{"status":"init"}\n', 'utf8');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'init']);

      git(repoRoot, ['checkout', '-b', 'pr-conflict']);
      await writeFile(join(repoRoot, 'src', 'service.ts'), 'export const port = 4000;\n', 'utf8');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'source change']);
      const sourceRevision = git(repoRoot, ['rev-parse', 'HEAD']);

      git(repoRoot, ['checkout', 'main']);
      await writeFile(join(repoRoot, 'src', 'service.ts'), 'export const port = 5000;\n', 'utf8');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'base conflicting change']);
      const baseRevision = git(repoRoot, ['rev-parse', 'HEAD']);

      // Configure 2 model candidates so selectHealthyModelCandidate WOULD probe if reached!
      const manifestWithTwoModels = validateTaskpackV2Manifest(
        makeBaseManifestObject({
          baselineAlignment: { policy: 'off' },
          models: [
            { provider: 'openai', id: 'gpt-4.1-mini', api: 'openai-completions', apiKeyEnv: 'OPENAI_API_KEY' },
            { provider: 'openai', id: 'gpt-4.1', api: 'openai-completions', apiKeyEnv: 'OPENAI_API_KEY' },
          ],
        }) as never,
      );

      let probeSpyCallCount = 0;
      const probeFetch: typeof globalThis.fetch = async () => {
        probeSpyCallCount += 1;
        return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };
      const adapterCounter = { count: 0 };
      const mockAdapter = createSpyOnlyAdapter(adapterCounter);

      const objectsBefore = await snapshotGitObjects(repoRoot);

      // Runtime override 'fail-fast' overrides manifest 'off' and halts BEFORE probeFetch or mockAdapter!
      const blockedResult = await runTurnkeyTaskpack({
        manifest: manifestWithTwoModels,
        repositoryRoot: repoRoot,
        repositoryFullName: 'acme/repo',
        runRoot,
        runId: 'ff-blocked-run',
        baseRevision,
        sourceRevision,
        baselineAlignment: 'fail-fast',
        probeFetch,
        openHostSessionAdapter: mockAdapter,
        runtimeEnv: {
          OPENAI_API_KEY: 'sk-test-token-one-12345678,sk-test-token-two-87654321',
        },
      });

      assert.equal(blockedResult.kind, 'blocked');
      assert.equal(blockedResult.reason, 'baseline_merge_conflict');
      assert.equal(probeSpyCallCount, 0, 'provider health probe spy must NOT be called under fail-fast conflict');
      assert.equal(adapterCounter.count, 0, 'model session adapter must NOT be called under fail-fast conflict');
      assert.deepEqual(await snapshotGitObjects(repoRoot), objectsBefore);

      // compileDeclarativeTaskpack and stageTaskpackForStep must surface typed reason === 'baseline_merge_conflict'
      await assert.rejects(
        () => compileDeclarativeTaskpack(manifestWithTwoModels, {
          mode: 'candidate',
          repository: 'acme/repo',
          repositoryRoot: repoRoot,
          baseRevision,
          sourceRevision,
          baselineAlignment: 'fail-fast',
          budgets: DEFAULT_HOST_BUDGETS,
          credentialEnvMap: { provider: 'OPENAI_API_KEY' },
        }),
        (err: unknown) => (
          err instanceof TaskpackError
          && err.code === 'TASKPACK_SCOPE_VIOLATION'
          && err.reason === BASELINE_CONFLICT_REASON
        ),
      );

      await mkdir(join(repoRoot, '.loopwright'), { recursive: true });
      await writeFile(
        join(repoRoot, '.loopwright', 'taskpack.yaml'),
        serializePrettyYaml(makeBaseManifestObject({ baselineAlignment: { policy: 'fail-fast' } })),
        'utf8',
      );
      await assert.rejects(
        () => stageTaskpackForStep({
          taskpackPath: '.loopwright/taskpack.yaml',
          repositoryRoot: repoRoot,
          runRoot,
          runId: 'ff-stage-blocked',
          baseRevision,
          sourceRevision,
          runtimeEnv: {},
        }),
        (err: unknown) => (
          err instanceof TaskpackError
          && err.code === 'TASKPACK_SCOPE_VIOLATION'
          && err.reason === BASELINE_CONFLICT_REASON
        ),
      );

      // runTurnkeyTaskpack must fail closed when manifest declares unsupported sections (e.g. spec.preflight)
      const manifestWithPreflight = validateTaskpackV2Manifest(
        makeBaseManifestObject({
          preflight: { script: '.loopwright/preflight.sh', timeoutSeconds: 10 },
        }) as never,
      );
      await assert.rejects(
        () => runTurnkeyTaskpack({
          manifest: manifestWithPreflight,
          repositoryRoot: repoRoot,
          repositoryFullName: 'acme/repo',
          runRoot,
          runId: 'unsupported-preflight-run',
          baseRevision,
          sourceRevision: baseRevision,
        }),
        (err: unknown) => (
          err instanceof TaskpackError
          && err.code === 'TASKPACK_MANIFEST_INVALID'
          && err.path === '/spec/preflight'
        ),
      );
    } finally {
      await removeTreeForce(holder);
    }
  });

  it('extracts scrubbed writable conflict context under extract-context, blocks protected/overflowing conflicts, and enforces conflict resolution', async () => {
    const holder = await mkdtemp(join(await realpath(tmpdir()), 'lw-align-ec-'));
    const repoRoot = join(holder, 'repo');
    const runRoot = join(holder, 'runs');
    try {
      await mkdir(join(repoRoot, 'src'), { recursive: true });
      await mkdir(join(repoRoot, 'docs', 'protected'), { recursive: true });
      await mkdir(join(repoRoot, 'outside'), { recursive: true });
      git(repoRoot, ['init', '-b', 'main']);

      const baseBody = 'export const label = "merge-base";\n';
      await writeFile(join(repoRoot, 'src', 'feature.ts'), baseBody, 'utf8');
      await writeFile(join(repoRoot, 'src', 'proposal.json'), '{"status":"init"}\n', 'utf8');
      await writeFile(join(repoRoot, 'docs', 'protected', 'rule.md'), 'rule v1\n', 'utf8');
      await writeFile(join(repoRoot, 'outside', 'unwritable.txt'), 'out v1\n', 'utf8');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'merge base']);

      const customSecret = 'superSecretCustomCredential987654';
      const ghSecret = 'ghp_1234567890abcdefghijklmnopqrstuv';
      const sourceBody = `export const label = "source-${customSecret}";\n`;
      const targetBody = `export const label = "target-${ghSecret}";\n`;

      git(repoRoot, ['checkout', '-b', 'source-branch']);
      await writeFile(join(repoRoot, 'src', 'feature.ts'), sourceBody, 'utf8');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'source conflict edit']);
      const sourceRevision = git(repoRoot, ['rev-parse', 'HEAD']);

      git(repoRoot, ['checkout', 'main']);
      await writeFile(join(repoRoot, 'src', 'feature.ts'), targetBody, 'utf8');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'target conflict edit']);
      const baseRevision = git(repoRoot, ['rev-parse', 'HEAD']);

      const scrubber = new SecretScrubber();
      scrubber.register(customSecret);
      const manifest = validateTaskpackV2Manifest(
        makeBaseManifestObject({
          baselineAlignment: {
            policy: 'extract-context',
            maxConflictFiles: 4,
            maxConflictBytes: 16_384,
          },
        }) as never,
      );

      // 1. Writable conflict within bounds -> scrubbed conflict context with exact SHA-256 digests
      const aligned = await alignBaselineRevisions({
        repositoryRoot: repoRoot,
        baseRevision,
        sourceRevision,
        manifest,
        scrubber,
      });
      assert.equal(aligned.disposition, 'extracted');
      assert.ok(aligned.conflictResource !== null);
      assert.equal(aligned.conflictResource.id, BASELINE_CONFLICT_RESOURCE_ID);
      assert.equal(aligned.conflictResource.path, BASELINE_CONFLICT_RESOURCE_PATH);
      scrubber.assertClean(aligned.conflictResource.bytes);
      const conflictText = aligned.conflictResource.bytes.toString('utf8');
      assert.equal(conflictText.includes(customSecret), false);
      assert.equal(conflictText.includes(ghSecret), false);
      assert.equal(conflictText.includes('[scrubbed]'), true);

      const expectedBaseSha = createHash('sha256').update(baseBody, 'utf8').digest('hex');
      const expectedTargetSha = createHash('sha256').update(targetBody, 'utf8').digest('hex');
      const expectedSourceSha = createHash('sha256').update(sourceBody, 'utf8').digest('hex');
      assert.equal(aligned.conflicts.length, 1);
      assert.equal(aligned.conflicts[0]?.path, 'src/feature.ts');
      assert.equal(aligned.conflicts[0]?.baseSha256, expectedBaseSha);
      assert.equal(aligned.conflicts[0]?.targetSha256, expectedTargetSha);
      assert.equal(aligned.conflicts[0]?.sourceSha256, expectedSourceSha);
      assert.ok((aligned.conflicts[0]?.hunks.length ?? 0) >= 1);

      // Verify compiled TaskContract pins sourceRevision to real SHA and stages 0o400 read-only resource
      const compiled = await compileDeclarativeTaskpack(manifest, {
        mode: 'candidate',
        repository: 'acme/repo',
        repositoryRoot: repoRoot,
        baseRevision,
        sourceRevision,
        budgets: DEFAULT_HOST_BUDGETS,
        credentialEnvMap: { provider: 'LOOPWRIGHT_PROVIDER_TOKEN' },
        baselineConflictResource: aligned.conflictResource,
        scrubber,
      });
      assert.equal(compiled.config.spec.task.spec.target.sourceRevision, sourceRevision);
      assert.equal(compiled.config.spec.task.spec.trustedContext.discovery, 'disabled');
      const contractRes = compiled.config.spec.task.spec.trustedContext.resources.find(
        r => r.id === BASELINE_CONFLICT_RESOURCE_ID,
      );
      assert.ok(contractRes !== undefined);
      assert.equal(contractRes.digest.hex, aligned.conflictResource.sha256);

      const regDir = join(holder, 'staged-reg');
      await mkdir(regDir, { recursive: true, mode: 0o700 });
      await stageCompiledInstructionResources(regDir, compiled.instructionResources);
      const stagedFileStat = await lstat(join(regDir, BASELINE_CONFLICT_RESOURCE_PATH));
      assert.equal(stagedFileStat.mode & 0o777, 0o400, 'staged conflict context must be 0o400 read-only');

      // 2. Conflict-resolution helper rejects untouched conflict OR leftover <<<<<<< / ||||||| / >>>>>>> markers
      //    (including NUL-containing buffers!), while allowing legitimate standalone 7-char ======= setext headings
      assert.equal(containsResidualGitConflictMarkers('<<<<<<< HEAD\nfoo\n'), true);
      assert.equal(containsResidualGitConflictMarkers('<<<<<<< HEAD\nfoo\n=======\nbar\n>>>>>>> branch\n'), true);
      assert.equal(containsResidualGitConflictMarkers('ok\n||||||| merged common ancestors\nbar\n'), true);
      assert.equal(containsResidualGitConflictMarkers('ok\n>>>>>>> branch\n'), true);
      assert.equal(containsResidualGitConflictMarkers('Section Heading\n=======\nBody paragraph.\n'), false);
      assert.equal(containsResidualGitConflictMarkers('export const ok = 1 === 1;\n'), false);

      const scopeSnap = {
        contract: compiled.config.spec.task,
        protectedPaths: compiled.config.spec.task.spec.scope.protected,
      };
      await assert.rejects(
        () => assertExtractedConflictsResolved({
          extractedConflictPaths: ['src/feature.ts'],
          snapshot: scopeSnap,
          candidateFiles: [],
          candidateDeletedPaths: [],
        }),
        (err: unknown) => (
          err instanceof TaskpackError
          && err.reason === BASELINE_CONFLICT_REASON
          && /unresolved|updated or deleted/i.test(err.message)
        ),
      );
      await assert.rejects(
        () => assertExtractedConflictsResolved({
          extractedConflictPaths: ['src/feature.ts'],
          snapshot: scopeSnap,
          candidateFiles: [
            { kind: 'inline', name: 'src/feature.ts', bytes: Buffer.from('<<<<<<< HEAD\nconst x = 1;\n', 'utf8') },
          ],
          candidateDeletedPaths: [],
        }),
        (err: unknown) => (
          err instanceof TaskpackError
          && err.reason === BASELINE_CONFLICT_REASON
          && /conflict marker/i.test(err.message)
        ),
      );
      await assert.rejects(
        () => assertExtractedConflictsResolved({
          extractedConflictPaths: ['src/feature.ts'],
          snapshot: scopeSnap,
          candidateFiles: [
            {
              kind: 'inline',
              name: 'src/feature.ts',
              bytes: Buffer.from('prefix\0\n<<<<<<< HEAD\nconst x = 1;\n=======\nconst x = 2;\n>>>>>>> branch\n', 'utf8'),
            },
          ],
          candidateDeletedPaths: [],
        }),
        (err: unknown) => (
          err instanceof TaskpackError
          && err.reason === BASELINE_CONFLICT_REASON
          && /conflict marker/i.test(err.message)
        ),
      );
      await assertExtractedConflictsResolved({
        extractedConflictPaths: ['src/feature.ts'],
        snapshot: scopeSnap,
        candidateFiles: [
          {
            kind: 'inline',
            name: 'src/feature.ts',
            bytes: Buffer.from('Heading\n=======\nexport const label = "merged-clean";\n', 'utf8'),
          },
        ],
        candidateDeletedPaths: [],
      });
      await assertExtractedConflictsResolved({
        extractedConflictPaths: ['src/feature.ts'],
        snapshot: scopeSnap,
        candidateFiles: [],
        candidateDeletedPaths: ['src/feature.ts'],
      });

      // 3. End-to-end turnkey run under extract-context:
      //    Attempt 1 leaves leftover <<<<<<< marker (denied by verification gate!), repair Attempt 2 resolves cleanly -> completed!
      //    Assert host .git/objects invariance across both turnkey runs!
      const objectsBeforeExtractTurnkey = await snapshotGitObjects(repoRoot);
      const repairSse = await startLoopbackOpenAiServer(turnIdx => {
        if (turnIdx === 0) {
          return sseToolCall('mock-model', 'c1', 'write', {
            path: 'src/proposal.json',
            content: '{"schema_version":1,"status":"ok"}\n',
          });
        }
        if (turnIdx === 1) {
          // Leave residual <<<<<<< marker on first attempt -> must fail verification!
          return sseToolCall('mock-model', 'c2', 'write', {
            path: 'src/feature.ts',
            content: '<<<<<<< HEAD\nexport const label = "broken";\n',
          });
        }
        if (turnIdx === 2) {
          return sseStop('mock-model', '{"version":1,"status":"completed","checks":[],"reason":"attempt 1"}');
        }
        if (turnIdx === 3) {
          // Cleanly resolve on implementation repair turn -> must pass!
          return sseToolCall('mock-model', 'c3', 'write', {
            path: 'src/feature.ts',
            content: 'export const label = "resolved";\n',
          });
        }
        return sseStop('mock-model', '{"version":1,"status":"completed","checks":[],"reason":"resolved"}');
      });
      try {
        const repairModelsJson = await writeLoopbackModelsJson(holder, 'repair-models.json', repairSse.baseUrl);
        const repairResolvedRun = await runTurnkeyTaskpack({
          manifest: validateTaskpackV2Manifest(
            makeBaseManifestObject({
              baselineAlignment: { policy: 'extract-context', maxConflictFiles: 4, maxConflictBytes: 16_384 },
              limits: { maxImplementationRepairs: 2, maxAttempts: 4 },
              models: [{ provider: 'local-oai', id: 'mock-model', apiKeyEnv: 'LOCAL_OAI_KEY' }],
            }) as never,
          ),
          modelsJsonPath: repairModelsJson,
          repositoryRoot: repoRoot,
          repositoryFullName: 'acme/repo',
          runRoot,
          runId: 'ec-repair-resolve',
          baseRevision,
          sourceRevision,
          scrubber,
          runtimeEnv: { LOCAL_OAI_KEY: 'sk-ec-token-1234567890' },
        });
        assert.equal(repairResolvedRun.kind, 'completed', repairResolvedRun.detail);
        assert.equal(repairResolvedRun.summary.ok, true);
      } finally {
        await repairSse.close();
      }

      // Leaving conflict completely untouched when repairs=0 fails closed!
      const untouchedLogs: string[] = [];
      const untouchedSse = await startLoopbackOpenAiServer(turnIdx => {
        if (turnIdx === 0) {
          return sseToolCall('mock-model', 'u1', 'write', {
            path: 'src/proposal.json',
            content: '{"schema_version":1,"status":"ok"}\n',
          });
        }
        return sseStop('mock-model', '{"version":1,"status":"completed","checks":[],"reason":"skipped conflict"}');
      });
      try {
        const untouchedModelsJson = await writeLoopbackModelsJson(holder, 'untouched-models.json', untouchedSse.baseUrl);
        const unresolvedRun = await runTurnkeyTaskpack({
          manifest: validateTaskpackV2Manifest(
            makeBaseManifestObject({
              baselineAlignment: { policy: 'extract-context', maxConflictFiles: 4, maxConflictBytes: 16_384 },
              limits: { maxImplementationRepairs: 0, maxAttempts: 2 },
              models: [{ provider: 'local-oai', id: 'mock-model', apiKeyEnv: 'LOCAL_OAI_KEY' }],
            }) as never,
          ),
          modelsJsonPath: untouchedModelsJson,
          repositoryRoot: repoRoot,
          repositoryFullName: 'acme/repo',
          runRoot,
          runId: 'ec-untouched-fail',
          baseRevision,
          sourceRevision,
          scrubber,
          onLog: line => untouchedLogs.push(line),
          runtimeEnv: { LOCAL_OAI_KEY: 'sk-ec-token-1234567890' },
        });
        assert.notEqual(unresolvedRun.kind, 'completed');
        assert.equal(unresolvedRun.summary?.ok, false);
        assert.equal(untouchedLogs.some(l => /baseline_merge_conflict/i.test(l)), true);
      } finally {
        await untouchedSse.close();
      }
      assert.deepEqual(
        await snapshotGitObjects(repoRoot),
        objectsBeforeExtractTurnkey,
        'host .git/objects must receive ZERO new objects during extract-context turnkey runs',
      );

      // 4. Overflowing maxConflictFiles or maxConflictBytes fails closed as blocked
      git(repoRoot, ['checkout', 'source-branch']);
      await writeFile(join(repoRoot, 'src', 'second.ts'), `export const big = "${'s'.repeat(900)}";\n`, 'utf8');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'second conflict source']);
      const twoConflictSource = git(repoRoot, ['rev-parse', 'HEAD']);

      git(repoRoot, ['checkout', 'main']);
      await writeFile(join(repoRoot, 'src', 'second.ts'), `export const big = "${'b'.repeat(900)}";\n`, 'utf8');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'second conflict base']);
      const twoConflictBase = git(repoRoot, ['rev-parse', 'HEAD']);

      const fileOverflow = await alignBaselineRevisions({
        repositoryRoot: repoRoot,
        baseRevision: twoConflictBase,
        sourceRevision: twoConflictSource,
        manifest,
        baselineAlignment: { policy: 'extract-context', maxConflictFiles: 1, maxConflictBytes: 65_536 },
        scrubber,
      });
      assert.equal(fileOverflow.disposition, 'blocked');
      assert.equal(fileOverflow.reason, 'baseline_merge_conflict');
      assert.equal(fileOverflow.conflictResource, null);

      const byteOverflow = await alignBaselineRevisions({
        repositoryRoot: repoRoot,
        baseRevision: twoConflictBase,
        sourceRevision: twoConflictSource,
        manifest,
        baselineAlignment: { policy: 'extract-context', maxConflictFiles: 16, maxConflictBytes: 1_024 },
        scrubber,
      });
      assert.equal(byteOverflow.disposition, 'blocked');
      assert.equal(byteOverflow.reason, 'baseline_merge_conflict');
      assert.equal(byteOverflow.conflictResource, null);

      // 5. Protected or out-of-scope conflicted path fails closed as blocked WITHOUT exposing conflict hunks
      git(repoRoot, ['checkout', 'source-branch']);
      await writeFile(join(repoRoot, 'docs', 'protected', 'rule.md'), 'PROTECTED_SOURCE_HUNK_SECRET\n', 'utf8');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'protected conflict source']);
      const protConflictSource = git(repoRoot, ['rev-parse', 'HEAD']);

      git(repoRoot, ['checkout', 'main']);
      await writeFile(join(repoRoot, 'docs', 'protected', 'rule.md'), 'PROTECTED_BASE_HUNK_SECRET\n', 'utf8');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'protected conflict base']);
      const protConflictBase = git(repoRoot, ['rev-parse', 'HEAD']);

      const protectedConflict = await alignBaselineRevisions({
        repositoryRoot: repoRoot,
        baseRevision: protConflictBase,
        sourceRevision: protConflictSource,
        manifest,
        baselineAlignment: 'extract-context',
        scrubber,
      });
      assert.equal(protectedConflict.disposition, 'blocked');
      assert.equal(protectedConflict.reason, 'baseline_merge_conflict');
      assert.equal(protectedConflict.conflictResource, null);
      assert.equal(protectedConflict.conflicts.length, 0);
      assert.equal(JSON.stringify(protectedConflict).includes('PROTECTED_SOURCE_HUNK_SECRET'), false);
      assert.equal(JSON.stringify(protectedConflict).includes('PROTECTED_BASE_HUNK_SECRET'), false);

      git(repoRoot, ['checkout', 'source-branch']);
      await writeFile(join(repoRoot, 'outside', 'unwritable.txt'), 'OUTSIDE_SOURCE_HUNK\n', 'utf8');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'outside conflict source']);
      const outConflictSource = git(repoRoot, ['rev-parse', 'HEAD']);

      git(repoRoot, ['checkout', 'main']);
      await writeFile(join(repoRoot, 'outside', 'unwritable.txt'), 'OUTSIDE_BASE_HUNK\n', 'utf8');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'outside conflict base']);
      const outConflictBase = git(repoRoot, ['rev-parse', 'HEAD']);

      const outOfScopeConflict = await alignBaselineRevisions({
        repositoryRoot: repoRoot,
        baseRevision: outConflictBase,
        sourceRevision: outConflictSource,
        manifest,
        baselineAlignment: 'extract-context',
        scrubber,
      });
      assert.equal(outOfScopeConflict.disposition, 'blocked');
      assert.equal(outOfScopeConflict.reason, 'baseline_merge_conflict');
      assert.equal(outOfScopeConflict.conflictResource, null);
      assert.equal(JSON.stringify(outOfScopeConflict).includes('OUTSIDE_SOURCE_HUNK'), false);

      // 6. Modify/delete conflict extraction and structural file/directory conflict refusal
      git(repoRoot, ['checkout', '-b', 'mod-del-base', baseRevision]);
      await rm(join(repoRoot, 'src', 'feature.ts'));
      git(repoRoot, ['add', '-A']);
      git(repoRoot, ['commit', '-m', 'delete feature on target']);
      const delTargetSha = git(repoRoot, ['rev-parse', 'HEAD']);

      const delModAligned = await alignBaselineRevisions({
        repositoryRoot: repoRoot,
        baseRevision: delTargetSha,
        sourceRevision,
        manifest,
        baselineAlignment: 'extract-context',
        scrubber,
      });
      assert.equal(delModAligned.disposition, 'extracted');
      assert.equal(delModAligned.conflicts[0]?.conflictKind, 'delete_modify');
      scrubber.assertClean(delModAligned.conflictResource.bytes);

      git(repoRoot, ['checkout', '-b', 'dir-conflict-base', baseRevision]);
      await rm(join(repoRoot, 'src', 'feature.ts'));
      await mkdir(join(repoRoot, 'src', 'feature.ts'), { recursive: true });
      await writeFile(join(repoRoot, 'src', 'feature.ts', 'nested.ts'), 'export const n = 1;\n', 'utf8');
      git(repoRoot, ['add', '-A']);
      git(repoRoot, ['commit', '-m', 'replace file with directory']);
      const dirTargetSha = git(repoRoot, ['rev-parse', 'HEAD']);

      const structuralConflict = await alignBaselineRevisions({
        repositoryRoot: repoRoot,
        baseRevision: dirTargetSha,
        sourceRevision,
        manifest,
        baselineAlignment: 'extract-context',
        scrubber,
      });
      assert.equal(structuralConflict.disposition, 'blocked');
      assert.equal(structuralConflict.reason, 'baseline_merge_conflict');
    } finally {
      await removeTreeForce(holder);
    }
  });

  it('fails closed on unmerged conflicts under policy: "off" during 3-way carry resolution and verification (never silently overwriting baseRevision)', async () => {
    const holder = await mkdtemp(join(await realpath(tmpdir()), 'lw-align-off-'));
    const repoRoot = join(holder, 'repo');
    const runRoot = join(holder, 'runs');
    try {
      await mkdir(join(repoRoot, '.loopwright', 'checks'), { recursive: true });
      await mkdir(join(repoRoot, 'src'), { recursive: true });
      git(repoRoot, ['init', '-b', 'main']);

      await writeFile(join(repoRoot, 'src', 'important.ts'), 'export const mode = "orig";\n', 'utf8');
      await writeFile(join(repoRoot, 'src', 'proposal.json'), '{"status":"init"}\n', 'utf8');
      await writeFile(
        join(repoRoot, '.loopwright', 'checks', 'noop.sh'),
        '#!/bin/sh\nexit 0\n',
        { mode: 0o755 },
      );
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'base']);

      git(repoRoot, ['checkout', '-b', 'pr-stale']);
      await writeFile(join(repoRoot, 'src', 'important.ts'), 'export const mode = "stale-pr";\n', 'utf8');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'stale pr']);
      const sourceRevision = git(repoRoot, ['rev-parse', 'HEAD']);

      git(repoRoot, ['checkout', 'main']);
      await writeFile(join(repoRoot, 'src', 'important.ts'), 'export const mode = "newer-main";\n', 'utf8');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'newer main']);
      const baseRevision = git(repoRoot, ['rev-parse', 'HEAD']);

      const manifest = validateTaskpackV2Manifest(
        makeBaseManifestObject({
          baselineAlignment: { policy: 'off' },
          verification: {
            localChecks: [
              { id: 'noop', implementation: 'command.v1', parameters: { script: '.loopwright/checks/noop.sh' } },
            ],
            externalGates: [],
          },
          limits: { maxImplementationRepairs: 0, maxAttempts: 2 },
        }) as never,
      );

      const offAligned = await alignBaselineRevisions({
        repositoryRoot: repoRoot,
        baseRevision,
        sourceRevision,
        manifest,
      });
      assert.equal(offAligned.disposition, 'unmerged_off');
      assert.deepEqual(offAligned.conflictPaths, ['src/important.ts']);

      const compiled = await compileDeclarativeTaskpack(manifest, {
        mode: 'candidate',
        repository: 'acme/repo',
        repositoryRoot: repoRoot,
        baseRevision,
        sourceRevision,
        budgets: DEFAULT_HOST_BUDGETS,
        credentialEnvMap: { provider: 'LOOPWRIGHT_PROVIDER_TOKEN' },
      });
      const gitEnv = {
        PATH: process.env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      };
      const baseEntries = await listTreeEntriesAtRevision(repoRoot, baseRevision, gitEnv);
      const sourceEntries = await listTreeEntriesAtRevision(repoRoot, sourceRevision, gitEnv);

      await assert.rejects(
        () => computeThreeWaySourceRevisionCarryDelta({
          repositoryRoot: repoRoot,
          baseRevision,
          sourceRevision,
          snapshot: {
            contract: compiled.config.spec.task,
            protectedPaths: compiled.config.spec.task.spec.scope.protected,
          },
          baseEntries,
          sourceEntries,
        }),
        (err: unknown) => err instanceof TaskpackError && /baseline_merge_conflict/i.test(err.message),
      );

      // Also prove startLocalCommandGateServer + runTurnkeyTaskpack fail closed under policy: 'off'
      // with ZERO host .git/objects mutations!
      const objectsBeforeOffTurnkey = await snapshotGitObjects(repoRoot);
      const offLogs: string[] = [];
      const offSse = await startLoopbackOpenAiServer(turnIdx => {
        if (turnIdx === 0) {
          return sseToolCall('mock-model', 'o1', 'write', {
            path: 'src/proposal.json',
            content: '{"schema_version":1,"status":"ready"}\n',
          });
        }
        return sseStop('mock-model', '{"version":1,"status":"completed","checks":[],"reason":"done"}');
      });
      try {
        const offModelsJson = await writeLoopbackModelsJson(holder, 'off-models.json', offSse.baseUrl);
        const offManifestWithModel = validateTaskpackV2Manifest(
          makeBaseManifestObject({
            baselineAlignment: { policy: 'off' },
            verification: {
              localChecks: [
                { id: 'noop', implementation: 'command.v1', parameters: { script: '.loopwright/checks/noop.sh' } },
              ],
              externalGates: [],
            },
            limits: { maxImplementationRepairs: 0, maxAttempts: 2 },
            models: [{ provider: 'local-oai', id: 'mock-model', apiKeyEnv: 'LOCAL_OAI_KEY' }],
          }) as never,
        );
        const offTurnkey = await runTurnkeyTaskpack({
          manifest: offManifestWithModel,
          modelsJsonPath: offModelsJson,
          repositoryRoot: repoRoot,
          repositoryFullName: 'acme/repo',
          runRoot,
          runId: 'off-unmerged-run',
          baseRevision,
          sourceRevision,
          onLog: line => offLogs.push(line),
          runtimeEnv: { LOCAL_OAI_KEY: 'sk-off-token-1234567890' },
        });
        assert.notEqual(offTurnkey.kind, 'completed');
        assert.equal(offTurnkey.summary?.ok, false);
        assert.equal(offLogs.some(l => /baseline_merge_conflict/i.test(l)), true);
      } finally {
        await offSse.close();
      }
      assert.deepEqual(
        await snapshotGitObjects(repoRoot),
        objectsBeforeOffTurnkey,
        'host .git/objects must receive ZERO new objects during policy: "off" turnkey runs',
      );
    } finally {
      await removeTreeForce(holder);
    }
  });

  it('handles deletions and conflicted carry in index-fallback mode (forceIndexFallback: true) without clobbering baseRevision edits or additions', async () => {
    const holder = await mkdtemp(join(await realpath(tmpdir()), 'lw-align-idx-fb-'));
    const repoRoot = join(holder, 'repo');
    try {
      await mkdir(join(repoRoot, 'src'), { recursive: true });
      await mkdir(join(repoRoot, 'docs', 'protected'), { recursive: true });
      git(repoRoot, ['init', '-b', 'main']);

      await writeFile(join(repoRoot, 'src', 'deleted-both.txt'), 'gone-both\n', 'utf8');
      await writeFile(join(repoRoot, 'src', 'deleted-base-only.txt'), 'gone-base\n', 'utf8');
      await writeFile(join(repoRoot, 'src', 'deleted-source-only.txt'), 'gone-source\n', 'utf8');
      await writeFile(join(repoRoot, 'src', 'base-edited.ts'), 'export const x = "orig";\n', 'utf8');
      await writeFile(join(repoRoot, 'src', 'disjoint.ts'), 'const top = 1;\nconst mid = 0;\nconst bot = 1;\n', 'utf8');
      await writeFile(join(repoRoot, 'docs', 'protected', 'rule.md'), 'rule-orig\n', 'utf8');
      await writeFile(join(repoRoot, 'src', 'proposal.json'), '{"status":"init"}\n', 'utf8');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'merge-base']);

      // Source branch: deletes deleted-both.txt & deleted-source-only.txt, edits bot of disjoint.ts
      git(repoRoot, ['checkout', '-b', 'source-clean-del']);
      await rm(join(repoRoot, 'src', 'deleted-both.txt'));
      await rm(join(repoRoot, 'src', 'deleted-source-only.txt'));
      await writeFile(join(repoRoot, 'src', 'disjoint.ts'), 'const top = 1;\nconst mid = 0;\nconst bot = 2;\n', 'utf8');
      git(repoRoot, ['add', '-A']);
      git(repoRoot, ['commit', '-m', 'source clean deletions and disjoint edit']);
      const cleanSourceSha = git(repoRoot, ['rev-parse', 'HEAD']);

      // Base branch: deletes deleted-both.txt & deleted-base-only.txt, edits base-edited.ts, adds base-added.ts, edits top of disjoint.ts
      git(repoRoot, ['checkout', 'main']);
      await rm(join(repoRoot, 'src', 'deleted-both.txt'));
      await rm(join(repoRoot, 'src', 'deleted-base-only.txt'));
      await writeFile(join(repoRoot, 'src', 'base-edited.ts'), 'export const x = "edited-on-base";\n', 'utf8');
      await writeFile(join(repoRoot, 'src', 'base-added.ts'), 'export const addedOnBase = true;\n', 'utf8');
      await writeFile(join(repoRoot, 'src', 'disjoint.ts'), 'const top = 2;\nconst mid = 0;\nconst bot = 1;\n', 'utf8');
      git(repoRoot, ['add', '-A']);
      git(repoRoot, ['commit', '-m', 'base clean deletions, edit, addition, and disjoint edit']);
      const cleanBaseSha = git(repoRoot, ['rev-parse', 'HEAD']);

      const manifest = validateTaskpackV2Manifest(makeBaseManifestObject() as never);
      const objectsBeforeClean = await snapshotGitObjects(repoRoot);

      // 1. Both-deleted and one-side-deleted paths merge cleanly under forceIndexFallback: true (matching merge-tree --write-tree)
      const primaryClean = await alignBaselineRevisions({
        repositoryRoot: repoRoot,
        baseRevision: cleanBaseSha,
        sourceRevision: cleanSourceSha,
        manifest,
        baselineAlignment: 'fail-fast',
        forceIndexFallback: false,
      });
      const fallbackClean = await alignBaselineRevisions({
        repositoryRoot: repoRoot,
        baseRevision: cleanBaseSha,
        sourceRevision: cleanSourceSha,
        manifest,
        baselineAlignment: 'fail-fast',
        forceIndexFallback: true,
      });
      assert.equal(fallbackClean.disposition, 'clean');
      assert.equal(fallbackClean.mergedTreeOid, primaryClean.mergedTreeOid);
      assert.deepEqual(fallbackClean.carryRemovals, ['src/deleted-source-only.txt']);
      assert.deepEqual(await snapshotGitObjects(repoRoot), objectsBeforeClean);

      // 2. Conflicted fallback with protected conflict (policy: 'off') AND writable conflict (extract-context):
      //    computeThreeWaySourceRevisionCarryDelta(forceIndexFallback: true) must NEVER fall back to sourceEntries
      //    or overwrite base-edited.ts / remove base-added.ts!
      git(repoRoot, ['checkout', '-b', 'source-prot-conflict', cleanSourceSha]);
      await writeFile(join(repoRoot, 'docs', 'protected', 'rule.md'), 'rule-from-source\n', 'utf8');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'source protected edit']);
      const protSourceSha = git(repoRoot, ['rev-parse', 'HEAD']);

      git(repoRoot, ['checkout', '-b', 'base-prot-conflict', cleanBaseSha]);
      await writeFile(join(repoRoot, 'docs', 'protected', 'rule.md'), 'rule-from-base\n', 'utf8');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'base protected edit']);
      const protBaseSha = git(repoRoot, ['rev-parse', 'HEAD']);

      const objectsBeforeConflictFallback = await snapshotGitObjects(repoRoot);
      const compiled = await compileDeclarativeTaskpack(manifest, {
        mode: 'candidate',
        repository: 'acme/repo',
        repositoryRoot: repoRoot,
        baseRevision: protBaseSha,
        sourceRevision: protSourceSha,
        budgets: DEFAULT_HOST_BUDGETS,
        credentialEnvMap: { provider: 'LOOPWRIGHT_PROVIDER_TOKEN' },
      });

      const fallbackDelta = await computeThreeWaySourceRevisionCarryDelta({
        repositoryRoot: repoRoot,
        baseRevision: protBaseSha,
        sourceRevision: protSourceSha,
        snapshot: {
          contract: compiled.config.spec.task,
          protectedPaths: compiled.config.spec.task.spec.scope.protected,
        },
        forceIndexFallback: true,
      });
      assert.ok(fallbackDelta.mergedTreeOid !== null, 'index fallback must materialize a real mergedTreeOid even with conflicts');
      assert.equal(
        fallbackDelta.carryRemovals.includes('src/base-added.ts'),
        false,
        'files added on baseRevision must NEVER be removed by carryRemovals',
      );
      assert.equal(
        fallbackDelta.carryUpdates.some(u => u.path === 'src/base-edited.ts'),
        false,
        'files edited only on baseRevision must NEVER be overwritten with stale sourceRevision blobs',
      );
      const disjointCarry = fallbackDelta.carryUpdates.find(u => u.path === 'src/disjoint.ts');
      assert.ok(disjointCarry !== undefined && disjointCarry.bytes !== undefined);
      assert.equal(
        Buffer.from(disjointCarry.bytes).toString('utf8'),
        'const top = 2;\nconst mid = 0;\nconst bot = 2;\n',
      );
      assert.deepEqual(await snapshotGitObjects(repoRoot), objectsBeforeConflictFallback);
    } finally {
      await removeTreeForce(holder);
    }
  });

  it('reconciles 3-party edits (baseRevision line 1 + sourceRevision line 50 + candidate line 100) and fails closed on candidate-vs-base conflicts', async () => {
    const holder = await mkdtemp(join(await realpath(tmpdir()), 'lw-align-3party-'));
    const repoRoot = join(holder, 'repo');
    const runRoot = join(holder, 'runs');
    try {
      await mkdir(join(repoRoot, '.loopwright', 'checks'), { recursive: true });
      await mkdir(join(repoRoot, 'src'), { recursive: true });
      git(repoRoot, ['init', '-b', 'main']);

      const makeLines = (overrides: Readonly<Record<number, string>> = {}): string => {
        const lines: string[] = [];
        for (let i = 1; i <= 100; i += 1) {
          lines.push(overrides[i] ?? `line-${String(i).padStart(3, '0')}`);
        }
        return `${lines.join('\n')}\n`;
      };

      await writeFile(join(repoRoot, 'src', 'hundred.ts'), makeLines(), 'utf8');
      await writeFile(
        join(repoRoot, 'src', 'base-only-mod.ts'),
        ['top-orig', 'mid-1', 'mid-2', 'mid-3', 'bottom-orig'].join('\n') + '\n',
        'utf8',
      );
      await writeFile(join(repoRoot, 'src', 'proposal.json'), '{"status":"init"}\n', 'utf8');
      await writeFile(
        join(repoRoot, '.loopwright', 'checks', 'verify-3party.sh'),
        [
          '#!/bin/sh',
          'set -eu',
          'head_line=$(sed -n "1p" src/hundred.ts)',
          'mid_line=$(sed -n "50p" src/hundred.ts)',
          'tail_line=$(sed -n "100p" src/hundred.ts)',
          'test "$head_line" = "line-001-from-base" || { echo "lost baseRevision line 1: $head_line"; exit 1; }',
          'test "$mid_line" = "line-050-from-source" || { echo "lost sourceRevision line 50: $mid_line"; exit 1; }',
          'test "$tail_line" = "line-100-from-candidate" || { echo "lost candidate line 100: $tail_line"; exit 1; }',
          'bom_top=$(sed -n "1p" src/base-only-mod.ts)',
          'bom_bot=$(sed -n "5p" src/base-only-mod.ts)',
          'test "$bom_top" = "top-from-base" || { echo "lost baseRevision top on base-only-mod: $bom_top"; exit 1; }',
          'test "$bom_bot" = "bottom-from-candidate" || { echo "lost candidate bottom on base-only-mod: $bom_bot"; exit 1; }',
        ].join('\n') + '\n',
        { mode: 0o755 },
      );
      await writeFile(
        join(repoRoot, '.loopwright', 'taskpack.yaml'),
        serializePrettyYaml({
          apiVersion: 'loopwright.dev/v1alpha1',
          kind: 'Taskpack',
          metadata: { name: 'three-party-pack' },
          spec: {
            goal: { candidate: 'Edit line 100 of hundred.ts and bottom of base-only-mod.ts.', noChange: 'No change.' },
            scope: { writable: ['src/**'], protected: [] },
            verification: {
              localChecks: [
                {
                  id: 'verify-3party',
                  implementation: 'command.v1',
                  parameters: { script: '.loopwright/checks/verify-3party.sh', timeoutSeconds: 20 },
                },
              ],
              externalGates: [],
            },
            publication: { mode: 'disabled' },
          },
        }),
        'utf8',
      );
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'merge-base']);

      // sourceRevision: edits line 50 of hundred.ts (leaves base-only-mod.ts untouched)
      git(repoRoot, ['checkout', '-b', 'pr-3party']);
      await writeFile(join(repoRoot, 'src', 'hundred.ts'), makeLines({ 50: 'line-050-from-source' }), 'utf8');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'source edits line 50']);
      const sourceRevision = git(repoRoot, ['rev-parse', 'HEAD']);

      // baseRevision: edits line 1 of hundred.ts AND top of base-only-mod.ts
      git(repoRoot, ['checkout', 'main']);
      await writeFile(join(repoRoot, 'src', 'hundred.ts'), makeLines({ 1: 'line-001-from-base' }), 'utf8');
      await writeFile(
        join(repoRoot, 'src', 'base-only-mod.ts'),
        ['top-from-base', 'mid-1', 'mid-2', 'mid-3', 'bottom-orig'].join('\n') + '\n',
        'utf8',
      );
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'base edits line 1 and base-only-mod top']);
      const baseRevision = git(repoRoot, ['rev-parse', 'HEAD']);

      const objectsBefore = await snapshotGitObjects(repoRoot);

      // 1. Delegated step run: candidate starts from sourceRevision and edits line 100 of hundred.ts
      //    + bottom of base-only-mod.ts -> command.v1 sees ALL 3 parties' edits!
      const runId = 'three-party-step-run';
      const staged = await stageTaskpackForStep({
        taskpackPath: '.loopwright/taskpack.yaml',
        repositoryRoot: repoRoot,
        runRoot,
        runId,
        baseRevision,
        sourceRevision,
        runtimeEnv: {},
      });
      const gateHandle = await openStagedTaskpackStepGate({ runRoot, runId, runtimeEnv: {} });
      assert.ok(gateHandle !== null);
      try {
        const prevSecret = process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV];
        process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV] = gateHandle.environment(DEFAULT_LOCAL_COMMAND_GATE_ENV);
        let loadedCfg: Awaited<ReturnType<typeof loadTrustedConfiguration>>;
        try {
          loadedCfg = await loadTrustedConfiguration({
            configPath: staged.configPath,
            registryPath: staged.registryPath,
            registrySha256: staged.registrySha256,
            untrustedRoots: [repoRoot],
          });
        } finally {
          if (prevSecret === undefined) delete process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV];
          else process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV] = prevSecret;
        }
        assert.equal(loadedCfg.ok, true);
        if (!loadedCfg.ok) return;

        const next = await stepNext(
          {
            configuration: loadedCfg.value,
            repository: repoRoot,
            runRoot,
            runId,
            policyProfile: gateHandle.policyProfile,
            environment: gateHandle.environment,
          },
          gateHandle.ports,
        );
        assert.equal(next.ok, true);
        if (!next.ok || next.value.kind !== 'step') return;

        // Candidate workspace started from sourceRevision (line 1 = line-001, line 50 = line-050-from-source):
        await writeFile(
          join(next.value.candidateDir, 'src', 'hundred.ts'),
          makeLines({ 50: 'line-050-from-source', 100: 'line-100-from-candidate' }),
          'utf8',
        );
        await writeFile(
          join(next.value.candidateDir, 'src', 'base-only-mod.ts'),
          ['top-orig', 'mid-1', 'mid-2', 'mid-3', 'bottom-from-candidate'].join('\n') + '\n',
          'utf8',
        );
        const submitted = await stepSubmit(
          {
            runRoot,
            runId,
            leaseToken: next.value.leaseToken,
            status: 'completed',
            reason: 'edited line 100 and bottom',
            environment: gateHandle.environment,
          },
          gateHandle.ports,
        );
        assert.equal(submitted.ok, true, submitted.ok ? '' : JSON.stringify(submitted.error));
        if (!submitted.ok) return;
        assert.equal(
          submitted.value.kind === 'result' ? submitted.value.result.spec.status : `${submitted.value.kind}:${JSON.stringify(submitted.value)}`,
          'completed',
        );
      } finally {
        await gateHandle.close();
      }

      // 2. verifyCandidateBaselinePrePublication returns reconciledOverlayFiles with all 3 parties' edits
      //    and mergeCandidateOverlayWithCarry rejects conflicting candidate line-1 edits!
      const manifest = validateTaskpackV2Manifest(makeBaseManifestObject() as never);
      const compiled = await compileDeclarativeTaskpack(manifest, {
        mode: 'candidate',
        repository: 'acme/repo',
        repositoryRoot: repoRoot,
        baseRevision,
        sourceRevision,
        budgets: DEFAULT_HOST_BUDGETS,
        credentialEnvMap: { provider: 'LOOPWRIGHT_PROVIDER_TOKEN' },
      });
      const scopeSnap = {
        contract: compiled.config.spec.task,
        protectedPaths: compiled.config.spec.task.spec.scope.protected,
      };
      const sourceTreeOid = git(repoRoot, ['rev-parse', `${sourceRevision}^{tree}`]);
      const prePub = await verifyCandidateBaselinePrePublication({
        repositoryRoot: repoRoot,
        snapshot: {
          lock: {},
          ...scopeSnap,
          baseRevision,
          sourceRevision,
          manifest: {
            apiVersion: 'loopwright.dev/v1alpha1',
            kind: 'ArtifactManifest',
            metadata: { id: 'manifest-3p' },
            spec: {
              baseTree: {
                commitOid: sourceRevision,
                treeOid: sourceTreeOid,
                objectFormat: 'sha1' as const,
              },
              entries: [],
              deleted: [],
            },
          },
          files: [
            {
              kind: 'inline',
              name: 'src/hundred.ts',
              mode: '100644',
              bytes: Buffer.from(makeLines({ 50: 'line-050-from-source', 100: 'line-100-from-candidate' }), 'utf8'),
            },
          ],
        },
      });
      const recHundred = prePub.reconciledOverlayFiles.find(f => f.name === 'src/hundred.ts');
      assert.ok(recHundred !== undefined && recHundred.kind === 'inline');
      assert.equal(
        recHundred.bytes.toString('utf8'),
        makeLines({ 1: 'line-001-from-base', 50: 'line-050-from-source', 100: 'line-100-from-candidate' }),
      );

      // Conflicting candidate edit on line 1 (or deleting a baseRevision-modified file) must fail closed!
      await assert.rejects(
        () => mergeCandidateOverlayWithCarry({
          repositoryRoot: repoRoot,
          baseRevision,
          sourceRevision,
          snapshot: scopeSnap,
          carryUpdates: prePub.carryUpdates,
          overlayFiles: [],
          candidateDeletedPaths: ['src/base-only-mod.ts'],
        }),
        (err: unknown) => (
          err instanceof TaskpackError
          && err.code === 'TASKPACK_SCOPE_VIOLATION'
          && err.reason === BASELINE_CONFLICT_REASON
        ),
      );
      await assert.rejects(
        () => mergeCandidateOverlayWithCarry({
          repositoryRoot: repoRoot,
          baseRevision,
          sourceRevision,
          snapshot: scopeSnap,
          carryUpdates: prePub.carryUpdates,
          overlayFiles: [
            {
              kind: 'inline',
              name: 'src/hundred.ts',
              mode: '100644',
              bytes: Buffer.from(makeLines({ 1: 'line-001-conflicting-candidate', 50: 'line-050-from-source' }), 'utf8'),
            },
          ],
        }),
        (err: unknown) => (
          err instanceof TaskpackError
          && err.code === 'TASKPACK_SCOPE_VIOLATION'
          && err.reason === BASELINE_CONFLICT_REASON
        ),
      );

      assert.deepEqual(
        await snapshotGitObjects(repoRoot),
        objectsBefore,
        'host .git/objects must receive ZERO new objects across 3-party reconciliation',
      );
    } finally {
      await removeTreeForce(holder);
    }
  });

  it('wires inspected.value.runEval from inspectRun into TurnkeyCycleAttemptSummary and RunReportInput (including GitHub Step Summary)', async () => {
    const holder = await mkdtemp(join(await realpath(tmpdir()), 'lw-align-runeval-'));
    const repoRoot = join(holder, 'repo');
    const runRoot = join(holder, 'runs');
    const stepSummaryPath = join(holder, 'step-summary.md');
    const evalSse = await startLoopbackOpenAiServer(turnIdx => {
      if (turnIdx === 0) {
        return sseToolCall('mock-model', 'e1', 'write', {
          path: 'src/proposal.json',
          content: '{"schema_version":1,"status":"evaluated"}\n',
        });
      }
      return sseStop('mock-model', '{"version":1,"status":"completed","checks":[],"reason":"evaluated"}');
    });
    try {
      await mkdir(join(repoRoot, 'src'), { recursive: true });
      git(repoRoot, ['init', '-b', 'main']);
      await writeFile(join(repoRoot, 'src', 'proposal.json'), '{"status":"init"}\n', 'utf8');
      git(repoRoot, ['add', '.']);
      git(repoRoot, ['commit', '-m', 'init']);
      const headSha = git(repoRoot, ['rev-parse', 'HEAD']);

      const evalModelsJson = await writeLoopbackModelsJson(holder, 'eval-models.json', evalSse.baseUrl);
      const manifest = validateTaskpackV2Manifest(
        makeBaseManifestObject({
          models: [{ provider: 'local-oai', id: 'mock-model', apiKeyEnv: 'LOCAL_OAI_KEY' }],
        }) as never,
      );
      const compiled = await compileDeclarativeTaskpack(manifest, {
        mode: 'candidate',
        repository: 'acme/repo',
        repositoryRoot: repoRoot,
        baseRevision: headSha,
        sourceRevision: headSha,
        budgets: DEFAULT_HOST_BUDGETS,
        modelsJsonPath: evalModelsJson,
        credentialEnvMap: { provider: 'LOCAL_OAI_KEY' },
      });

      const trustedDirectory = join(runRoot, 'lw-trusted-eval');
      const registryDirectory = join(trustedDirectory, 'registry');
      const configDirectory = join(trustedDirectory, 'config');
      await mkdir(registryDirectory, { recursive: true, mode: 0o700 });
      await mkdir(configDirectory, { recursive: true, mode: 0o700 });
      await chmod(runRoot, 0o700);
      await chmod(trustedDirectory, 0o700);
      const registryPath = join(registryDirectory, 'registry.yaml');
      const configPath = join(configDirectory, 'config.yaml');
      const configBytes = Buffer.from(serializePrettyYaml(compiled.config), 'utf8');
      await writeFile(registryPath, compiled.registryBytes, { mode: 0o600 });
      await writeFile(configPath, configBytes, { mode: 0o600 });
      const written: WrittenCompiledTaskpack = {
        ...compiled,
        configBytes,
        trustedDirectory,
        registryPath,
        configPath,
      };

      let capturedReportRunEval: unknown = undefined;
      const cycleResult = await executeTurnkeyCycle({
        runId: 'turnkey-runeval-1',
        attemptSeq: 0,
        repositoryRoot: repoRoot,
        taskpack: written,
        runtimeEnv: { LOCAL_OAI_KEY: 'sk-eval-token-1234567890' },
        outputFormats: ['json', 'github-step-summary'],
        stepSummaryPath,
        onTurnkeyReport: report => {
          capturedReportRunEval = report.runEval;
        },
      });

      assert.equal(cycleResult.ok, true, cycleResult.detail);
      assert.ok(cycleResult.runEval !== null && cycleResult.runEval !== undefined, 'summary.runEval must be populated from inspectRun');
      assert.equal(cycleResult.runEval.runId, 'turnkey-runeval-1');
      assert.equal(cycleResult.report.runEval, cycleResult.runEval, 'RunReportInput.runEval must match inspected runEval');
      assert.equal(capturedReportRunEval, cycleResult.runEval);

      const summaryMarkdown = await readFile(stepSummaryPath, 'utf8');
      assert.match(summaryMarkdown, /Run Health/, 'GitHub Step Summary must include Run Health section from runEval');
    } finally {
      await evalSse.close();
      await removeTreeForce(holder);
    }
  });
});
