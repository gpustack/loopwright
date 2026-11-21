import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { compilePlan, loadTrustedConfiguration } from '@loopwright/controller';
import {
  buildDefaultAuthorPrompt,
  compileDeclarativeTaskpack,
  createTaskpackDecisionPort,
  DEFAULT_HOST_BUDGETS,
  DEFAULT_LOCAL_COMMAND_GATE_ENV,
  loadDeclarativeTaskpack,
  mergeMcpServerDeclarations,
  parseMcpServersOverride,
  resolveActionOutputFormats,
  SecretScrubber,
  serializePrettyYaml,
  stageCompiledInstructionResources,
  TaskpackError,
  validateTaskpackV2Manifest,
  writeActionOutputSinks,
} from '../src/index.js';

const BASE_SHA = 'a'.repeat(40);

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const base = await realpath(tmpdir());
  const dir = await mkdtemp(join(base, 'lw-tp-compiler-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('taskpack.ts & output-format.ts: local vs github profiles, auto-scaled role limits, and helpers', () => {
  it('loads and compiles minimal local V2 manifests (omitting triggers, publication, memory) with neutral scope protection', async () => {
    await withTempDir(async dir => {
      const repoRoot = join(dir, 'repo');
      const runRoot = join(dir, 'runs');
      await mkdir(join(repoRoot, '.ops', 'checks'), { recursive: true });
      await mkdir(join(repoRoot, '.claude'), { recursive: true });
      await mkdir(join(repoRoot, '.github', 'workflows'), { recursive: true });
      await mkdir(join(repoRoot, 'src'), { recursive: true });
      await mkdir(runRoot, { recursive: true, mode: 0o700 });

      await writeFile(join(repoRoot, '.ops', 'checks', 'verify.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      await writeFile(join(repoRoot, '.ops', 'secret-sibling.txt'), 'protected sibling\n', 'utf8');
      await writeFile(
        join(repoRoot, '.ops', 'taskpack.yaml'),
        serializePrettyYaml({
          apiVersion: 'loopwright.dev/v1alpha1',
          kind: 'Taskpack',
          metadata: { name: 'minimal-local' },
          spec: {
            goal: {
              candidate: 'Update src and local automation configs.',
              noChange: 'Confirm no changes needed.',
            },
            proposal: {
              path: '.ops/proposal.json',
              schemaVersion: 1,
              requiredFields: ['schema_version'],
            },
            scope: {
              writable: ['src/**', '.claude/**', '.github/workflows/**', '.ops/proposal.json'],
              protected: [],
            },
            verification: {
              localChecks: [
                { id: 'prop-check', implementation: 'json-artifact.v1' },
                { id: 'verify', implementation: 'command.v1', parameters: { script: '.ops/checks/verify.sh', timeoutSeconds: 15 } },
              ],
              externalGates: [],
            },
          },
        }),
        'utf8',
      );

      const manifest = await loadDeclarativeTaskpack({
        manifestPath: '.ops/taskpack.yaml',
        repositoryRoot: repoRoot,
      });
      assert.equal(manifest.spec.publication.mode, 'disabled');
      assert.equal(manifest.spec.memory.apply, 'disabled');
      assert.equal(manifest.spec.memory.directory, '.ops/memory/default');
      assert.equal(manifest.spec.triggers.schedule, false);

      for (const executionMode of ['pi', 'delegated'] as const) {
        const compiled = await compileDeclarativeTaskpack(manifest, {
          mode: 'candidate',
          executionMode,
          repository: 'local/repo',
          repositoryRoot: repoRoot,
          taskpackPath: '.ops/taskpack.yaml',
          baseRevision: BASE_SHA,
          sourceRevision: BASE_SHA,
          budgets: DEFAULT_HOST_BUDGETS,
          ...(executionMode === 'pi'
            ? {
              credentialEnvMap: {
                provider: 'OPENAI_API_KEY',
                localCommandGate: DEFAULT_LOCAL_COMMAND_GATE_ENV,
              },
            }
            : {
              credentialEnvMap: { localCommandGate: DEFAULT_LOCAL_COMMAND_GATE_ENV },
            }),
        });

        assert.equal(compiled.policyProfile, 'local');
        assert.equal(compiled.config.spec.publication.mode, 'disabled');
        const writable = compiled.config.spec.task.spec.scope.writable;
        const prot = compiled.config.spec.task.spec.scope.protected;
        assert.equal(writable.includes('.claude/**'), true);
        assert.equal(writable.includes('.github/workflows/**'), true);
        assert.equal(writable.includes('.ops/proposal.json'), true);
        assert.equal(prot.includes('.git/**'), true);
        assert.equal(prot.includes('.claude/**'), false);
        assert.equal(prot.includes('.github/**'), false);
        assert.equal(prot.includes('CLAUDE.md/**'), false);
        assert.equal(prot.includes('AGENTS.md/**'), false);
        assert.equal(prot.some(entry => entry.startsWith('.ops/secret-sibling.txt')), true);

        const trustedDir = join(runRoot, `trusted-${executionMode}`);
        const regDir = join(trustedDir, 'registry');
        const cfgDir = join(trustedDir, 'config');
        await mkdir(regDir, { recursive: true, mode: 0o700 });
        await mkdir(cfgDir, { recursive: true, mode: 0o700 });
        await chmod(trustedDir, 0o700);
        const regPath = join(regDir, 'registry.yaml');
        const cfgPath = join(cfgDir, 'config.yaml');
        await writeFile(regPath, compiled.registryBytes, { mode: 0o600 });
        await writeFile(cfgPath, serializePrettyYaml(compiled.config), { mode: 0o600 });
        await stageCompiledInstructionResources(regDir, compiled.instructionResources);

        const prevOai = process.env['OPENAI_API_KEY'];
        const prevGate = process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV];
        process.env['OPENAI_API_KEY'] = 'sk-test-token-12345';
        process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV] = 'gate-secret-12345';
        try {
          const loaded = await loadTrustedConfiguration({
            configPath: cfgPath,
            registryPath: regPath,
            registrySha256: compiled.registrySha256,
            untrustedRoots: [repoRoot],
          });
          assert.equal(loaded.ok, true, loaded.ok ? '' : JSON.stringify(loaded.error));
          if (loaded.ok) {
            const plan = await compilePlan(loaded.value);
            assert.equal(plan.ok, true, plan.ok ? '' : JSON.stringify(plan.error));
          }
        } finally {
          if (prevOai === undefined) delete process.env['OPENAI_API_KEY']; else process.env['OPENAI_API_KEY'] = prevOai;
          if (prevGate === undefined) delete process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV]; else process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV] = prevGate;
        }
      }
    });
  });

  it('auto-scales role fileBytes, artifactBytes, and candidateEntries with overlay limits while honoring explicit pins and circuitBreakerLimits', async () => {
    await withTempDir(async dir => {
      const repoRoot = join(dir, 'repo');
      await mkdir(join(repoRoot, 'src'), { recursive: true });
      await writeFile(join(repoRoot, 'src', 'state.json'), '{"ok":true}\n', 'utf8');

      const manifest = validateTaskpackV2Manifest({
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'Taskpack',
        metadata: { name: 'autoscale-limits' },
        spec: {
          goal: { candidate: 'Scale overlay.', noChange: 'No change.' },
          scope: { writable: ['src/**'], protected: [] },
          limits: {
            maxTurns: 42,
            maxRepairTurns: 9,
            overlay: {
              maxFiles: 8_192,
              maxBytes: 268_435_456, // 256 MiB
            },
          },
          verification: {
            localChecks: [
              { id: 'guard', implementation: 'json-keys-guard.v1', parameters: { path: 'src/state.json', allowedPointers: ['/ok'] } },
            ],
            externalGates: [],
          },
        },
      });

      const scaled = await compileDeclarativeTaskpack(manifest, {
        mode: 'candidate',
        executionMode: 'delegated',
        repository: 'local/repo',
        repositoryRoot: repoRoot,
        baseRevision: BASE_SHA,
        sourceRevision: BASE_SHA,
        budgets: DEFAULT_HOST_BUDGETS,
      });

      const roleProfile = scaled.registry.spec.roleProfiles[0]!;
      assert.ok(roleProfile.limits !== undefined);
      assert.equal(roleProfile.limits.fileBytes, 268_435_456);
      assert.equal(roleProfile.limits.artifactBytes, 268_435_456 + 67_371_008);
      assert.equal(roleProfile.limits.candidateEntries, 8_192);
      assert.deepEqual(scaled.circuitBreakerLimits, { maxTurns: 42, maxRepairTurns: 9 });

      // Explicit smaller pins on fileBytes and candidateEntries are preserved while artifactBytes scales with overlay.maxBytes
      const pinned = await compileDeclarativeTaskpack(manifest, {
        mode: 'candidate',
        executionMode: 'delegated',
        repository: 'local/repo',
        repositoryRoot: repoRoot,
        baseRevision: BASE_SHA,
        sourceRevision: BASE_SHA,
        budgets: DEFAULT_HOST_BUDGETS,
        limits: {
          fileBytes: 16_777_216,
          candidateEntries: 1_024,
        },
      });
      const pinnedProfile = pinned.registry.spec.roleProfiles[0]!;
      assert.ok(pinnedProfile.limits !== undefined);
      assert.equal(pinnedProfile.limits.fileBytes, 16_777_216);
      assert.equal(pinnedProfile.limits.candidateEntries, 1_024);
      assert.ok(pinnedProfile.limits.artifactBytes! >= 268_435_456 + pinnedProfile.limits.sessionBytes!);

      // R2-15: 1 GiB overlay with 16 MiB per-file limit scales artifactBytes >= 1 GiB + sessionBytes
      const oneGibManifest = validateTaskpackV2Manifest({
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'Taskpack',
        metadata: { name: 'autoscale-1gib' },
        spec: {
          goal: { candidate: 'Scale 1 GiB overlay.', noChange: 'No change.' },
          scope: { writable: ['src/**'], protected: [] },
          limits: {
            fileBytes: 16_777_216,
            overlay: {
              maxFiles: 64,
              maxBytes: 1_073_741_824,
            },
          },
          verification: {
            localChecks: [
              { id: 'guard', implementation: 'json-keys-guard.v1', parameters: { path: 'src/state.json', allowedPointers: ['/ok'] } },
            ],
            externalGates: [],
          },
        },
      });
      const oneGibCompiled = await compileDeclarativeTaskpack(oneGibManifest, {
        mode: 'candidate',
        executionMode: 'delegated',
        repository: 'local/repo',
        repositoryRoot: repoRoot,
        baseRevision: BASE_SHA,
        sourceRevision: BASE_SHA,
        budgets: DEFAULT_HOST_BUDGETS,
      });
      const oneGibProfile = oneGibCompiled.registry.spec.roleProfiles[0]!;
      assert.ok(oneGibProfile.limits !== undefined);
      assert.equal(oneGibProfile.limits.fileBytes, 16_777_216);
      assert.ok(
        oneGibProfile.limits.artifactBytes! >= 1_073_741_824 + oneGibProfile.limits.sessionBytes!,
        `expected artifactBytes (${oneGibProfile.limits.artifactBytes}) >= 1 GiB + sessionBytes`,
      );
    });
  });

  it('enforces github policyProfile workflow protection and supports decision, MCP, prompt, and output-format helpers', async () => {
    await withTempDir(async dir => {
      const repoRoot = join(dir, 'repo');
      await mkdir(join(repoRoot, '.loopwright'), { recursive: true });
      await mkdir(join(repoRoot, '.github', 'workflows'), { recursive: true });
      await writeFile(join(repoRoot, '.github', 'CODEOWNERS'), '* @team\n', 'utf8');
      await writeFile(
        join(repoRoot, '.loopwright', 'taskpack.yaml'),
        serializePrettyYaml({
          apiVersion: 'loopwright.dev/v1alpha1',
          kind: 'Taskpack',
          metadata: { name: 'gh-profile' },
          spec: {
            goal: { candidate: 'Update workflow.', noChange: 'No change.' },
            execution: { mode: 'strict', capabilities: { allowWorkflowWrites: true } },
            scope: { writable: ['.github/workflows/**'], protected: [] },
            decisions: { enabled: true },
            verification: {
              localChecks: [
                { id: 'json-check', implementation: 'json-artifact.v1', parameters: { path: '.github/workflows/meta.json' } },
              ],
              externalGates: [],
            },
          },
        }),
        'utf8',
      );

      // Under github profile without operator allowWorkflowWrites: true, fails closed with TASKPACK_SCOPE_VIOLATION
      await assert.rejects(
        () => loadDeclarativeTaskpack({
          manifestPath: '.loopwright/taskpack.yaml',
          repositoryRoot: repoRoot,
          hostPolicy: { policyProfile: 'github', allowWorkflowWrites: false },
        }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_SCOPE_VIOLATION',
      );

      // Dual-key unlock succeeds under github profile while keeping .github/CODEOWNERS protected
      const ghManifest = await loadDeclarativeTaskpack({
        manifestPath: '.loopwright/taskpack.yaml',
        repositoryRoot: repoRoot,
        hostPolicy: { policyProfile: 'github', allowWorkflowWrites: true },
      });
      const ghCompiled = await compileDeclarativeTaskpack(ghManifest, {
        mode: 'candidate',
        executionMode: 'delegated',
        hostPolicy: { policyProfile: 'github', allowWorkflowWrites: true },
        repository: 'octocat/repo',
        repositoryRoot: repoRoot,
        baseRevision: BASE_SHA,
        sourceRevision: BASE_SHA,
        budgets: DEFAULT_HOST_BUDGETS,
      });
      assert.equal(ghCompiled.policyProfile, 'github');
      assert.equal(ghCompiled.allowWorkflowWrites, true);
      assert.equal(ghCompiled.config.spec.task.spec.scope.protected.includes('.github/CODEOWNERS/**'), true);

      // Decision port, MCP override merge, author prompt, and output sinks
      const scrubber = new SecretScrubber();
      scrubber.register('ghs_secretTokenValue123456789012345');
      const decisionPort = createTaskpackDecisionPort(ghManifest, { scrubber, runtimeEnv: {} });
      assert.ok(decisionPort !== undefined);
      const overrideMcp = parseMcpServersOverride('[{"id":"docs","transport":"stdio","command":"npx","args":["docs-mcp"]}]');
      const mergedMcp = mergeMcpServerDeclarations(undefined, overrideMcp);
      assert.equal(mergedMcp.length, 1);

      const prompt = buildDefaultAuthorPrompt({
        mode: 'candidate',
        repositoryFullName: 'octocat/repo',
        acceptanceCheckIds: ['json-check'],
        reviseGuidance: 'Keep token ghs_secretTokenValue123456789012345 out of output',
        runtimeEnv: {},
        scrubber,
      });
      assert.equal(prompt.includes('ghs_secretTokenValue123456789012345'), false);
      assert.equal(prompt.includes('[scrubbed]'), true);

      const formats = resolveActionOutputFormats('json,text', ghManifest);
      assert.deepEqual(formats, ['json', 'text']);
      const summaryPath = join(dir, 'summary.md');
      const ghOutPath = join(dir, 'github-output.txt');
      const logs: string[] = [];
      const written = await writeActionOutputSinks({
        formats: ['json', 'text', 'github-step-summary'],
        report: {
          runId: 'run-1',
          status: 'completed',
          elapsedMs: 1200,
          checks: [],
          usage: null,
          externalUrl: null,
        },
        stepSummaryPath: summaryPath,
        githubOutputPath: ghOutPath,
        actionResultJson: '{"kind":"compiled"}',
        scrubber,
        logSink: chunk => logs.push(chunk),
      });
      assert.equal(written.stepSummaryWritten, true);
      assert.equal(written.githubOutputWritten, true);
      assert.equal(logs.length, 1);
      assert.match(await readFile(ghOutPath, 'utf8'), /result<<LOOPWRIGHT_EOF/);
    });
  });
});
