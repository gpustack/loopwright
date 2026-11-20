import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { compilePlan, loadTrustedConfiguration, stepNext, stepSubmit } from '@loopwright/controller';
import { DECISION_FORBIDDEN_AUTHORITY_INTENTS, DecisionError, assertDecisionAuthorityBoundary } from '@loopwright/decisions';
import { loadMemoryStore } from '@loopwright/memory';
import {
  ALWAYS_PROTECTED_WORKSPACE_SUBPATHS,
  CANONICAL_TASKPACK_STEP_GATE_URL,
  DEFAULT_HOST_BUDGETS,
  DEFAULT_LOCAL_COMMAND_GATE_ENV,
  GitHubAppError,
  InstallationTokenBroker,
  MULTI_TENANT_HOST_POLICY,
  SecretScrubber,
  assertMultiTenantManifestAuthority,
  compileDeclarativeTaskpack,
  compileLinuxBwrapCommand,
  compileMacosSeatbeltProfile,
  compileScopePatterns,
  computeTaskpackDigests,
  createTaskpackDecisionPort,
  executeSandboxedCommand,
  executeTurnkeyActionCycle,
  finalizeAndPublishTurnkeyMemory,
  loadDeclarativeTaskpack,
  openStagedTaskpackStepGate,
  resolveEffectiveTaskpackSandboxPolicy,
  runActionCli,
  runGitHubActionEntrypoint,
  serializeActionResultSummary,
  serializePrettyYaml,
  stageCompiledInstructionResources,
  stageTaskpackForStep,
  startGitHubAppControlPlane,
  startLocalCommandGateServer,
  validateTaskpackV2Manifest,
  writeDigestLockfile,
  type Json,
  type WrittenCompiledTaskpack,
} from '../src/index.js';
import { createFastTurnkeyAdapter } from './fast-turnkey-adapter.js';
import { readJsonBody, sseStop, sseToolCall, startHttpServer } from './turnkey-action-fixtures.js';

const BASE_SHA_FALLBACK = 'a'.repeat(40);
const FAST_ADAPTER = createFastTurnkeyAdapter();

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const base = await realpath(tmpdir());
  const dir = await mkdtemp(join(base, 'lw-t8-v2-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function initGitRepo(repoRoot: string): string {
  spawnSync('git', ['init', '-b', 'main'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.name', 'Loopwright Test'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['config', 'user.email', 'test@loopwright.invalid'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['add', '.'], { cwd: repoRoot, stdio: 'ignore' });
  spawnSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoRoot, stdio: 'ignore' });
  return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim();
}

async function writeCompiledArtifacts(
  runRoot: string,
  label: string,
  compiled: Awaited<ReturnType<typeof compileDeclarativeTaskpack>>,
): Promise<WrittenCompiledTaskpack> {
  const trustedDirectory = join(runRoot, `trusted-${label}`);
  const registryDir = join(trustedDirectory, 'registry');
  const configDir = join(trustedDirectory, 'config');
  await mkdir(registryDir, { recursive: true, mode: 0o700 });
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await chmod(trustedDirectory, 0o700);
  await chmod(registryDir, 0o700);
  await chmod(configDir, 0o700);
  const registryPath = join(registryDir, 'registry.yaml');
  const configPath = join(configDir, 'config.yaml');
  const configBytes = Buffer.from(serializePrettyYaml(compiled.config), 'utf8');
  await writeFile(registryPath, compiled.registryBytes, { mode: 0o600 });
  await writeFile(configPath, configBytes, { mode: 0o600 });
  await chmod(registryPath, 0o600);
  await chmod(configPath, 0o600);
  if (compiled.instructionResources !== undefined && compiled.instructionResources.length > 0) {
    await stageCompiledInstructionResources(registryDir, compiled.instructionResources);
  }
  return {
    ...compiled,
    configBytes,
    trustedDirectory,
    registryPath,
    configPath,
  };
}

function makeRuntimeManifest(name: string, specOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'Taskpack',
    metadata: { name },
    spec: {
      goal: { candidate: 'Update docs.', noChange: 'Verify docs.' },
      scope: { writable: ['docs/**'], protected: [] },
      upstreams: [],
      verification: { localChecks: [], externalGates: [] },
      publication: { mode: 'disabled', targetBranch: 'main', headBranchPrefix: 'lw/', titleTemplate: 'chore: docs' },
      memory: { directory: '.loopwright/memory', apply: 'disabled', onNoModelBudget: 'deterministic-observations-only' },
      triggers: { schedule: true, workflowDispatch: true, releasePublished: false, commentCommands: [] },
      ...specOverrides,
    },
  };
}

describe('Taskpack 2.0 compiler, guards, per-role isolation, and digests', () => {
  it('compiles interleaved spec.steps (agent, check, compact), per-role isolation, optional proposal, submission, guards, overlay, matrix, and pinDigests', async () => {
    await withTempDir(async dir => {
      const repoRoot = join(dir, 'repo');
      const runRoot = join(dir, 'runs');
      await mkdir(join(repoRoot, '.loopwright', 'instructions'), { recursive: true });
      await mkdir(join(repoRoot, '.loopwright', 'checks'), { recursive: true });
      await mkdir(join(repoRoot, '.agents', 'skills', 'shared'), { recursive: true });
      await mkdir(join(repoRoot, '.agents', 'skills', 'plan'), { recursive: true });
      await mkdir(join(repoRoot, '.agents', 'notes'), { recursive: true });
      await mkdir(join(repoRoot, '.github', 'workflows'), { recursive: true });
      await mkdir(join(repoRoot, 'docs'), { recursive: true });
      await mkdir(runRoot, { recursive: true, mode: 0o700 });

      await writeFile(join(repoRoot, '.loopwright', 'instructions', 'global.md'), '# Global Instructions\n', 'utf8');
      await writeFile(join(repoRoot, '.loopwright', 'instructions', 'plan.md'), '# Planner Secret Rubric\n', 'utf8');
      await writeFile(join(repoRoot, '.loopwright', 'instructions', 'review.md'), '# Reviewer Checklist\n', 'utf8');
      await writeFile(join(repoRoot, '.agents', 'skills', 'shared', 'SKILL.md'), '# Shared Skill\n', 'utf8');
      await writeFile(join(repoRoot, '.agents', 'skills', 'plan', 'SKILL.md'), '# Plan Skill\n', 'utf8');
      await writeFile(join(repoRoot, '.loopwright', 'checks', 'verify.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      await writeFile(join(repoRoot, '.github', 'CODEOWNERS'), '* @maintainers\n', 'utf8');
      await writeFile(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'name: CI\n', 'utf8');
      await writeFile(join(repoRoot, 'package.json'), '{"name":"demo","version":"1.0.0"}\n', 'utf8');
      await writeFile(join(repoRoot, 'docs', 'README.md'), '<!-- START -->\nbody\n<!-- END -->\n', 'utf8');

      const manifestObj = {
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'Taskpack',
        metadata: { name: 'v2-pipeline' },
        spec: {
          goal: {
            candidate: 'Update package version and bounded docs section without proposal.json.',
            noChange: 'Confirm zero changes are required.',
          },
          execution: {
            mode: 'strict',
            capabilities: { allowWorkflowWrites: true },
            digests: { pinDigests: true },
          },
          instructions: ['.loopwright/instructions/global.md'],
          skills: ['.agents/skills/shared/SKILL.md'],
          scope: {
            writable: [
              'package.json',
              'docs/**',
              '.agents/notes/**',
              '.github/workflows/**',
            ],
            protected: ['.agents/skills/shared/SKILL.md', '.agents/skills/plan/SKILL.md'],
          },
          target: {
            matrix: [{ id: 'darwin-arm64', platform: 'darwin-arm64', variant: 'default' }],
          },
          upstreams: [],
          submission: {
            path: 'docs/submission.json',
            required: true,
          },
          mcp: {
            servers: [
              { id: 'docs-mcp', transport: 'stdio', command: 'npx', args: ['-y', 'docs-mcp'], readOnly: true },
              { id: 'mutating-mcp', transport: 'stdio', command: 'npx', args: ['-y', 'mutating-mcp'] },
            ],
          },
          roles: [
            {
              id: 'planner',
              purpose: 'task',
              provider: 'zai',
              model: 'glm-5.3',
              thinking: 'high',
              instructions: ['.loopwright/instructions/plan.md'],
              skills: ['.agents/skills/plan/SKILL.md'],
              prompt: 'Produce the implementation plan before coding.',
              mcpServers: ['docs-mcp'],
              models: ['zai/glm-5.3', 'openai/gpt-5'],
            },
            {
              id: 'implementer',
              purpose: 'task',
              provider: 'zai',
              model: 'glm-5.3',
              thinking: 'high',
              mcpServers: ['docs-mcp', 'mutating-mcp'],
            },
            {
              id: 'reviewer',
              purpose: 'review',
              provider: 'openai',
              model: 'gpt-5',
              thinking: 'medium',
              instructions: ['.loopwright/instructions/review.md'],
            },
          ],
          steps: [
            { id: 'plan', kind: 'agent', role: 'planner', dependsOn: [] },
            { id: 'implement', kind: 'agent', role: 'implementer', dependsOn: ['plan'] },
            { id: 'compact-impl', kind: 'compact', role: 'implementer', dependsOn: ['implement'] },
            { id: 'pkg-guard', kind: 'check', check: 'json-keys', dependsOn: ['compact-impl'] },
            { id: 'doc-guard', kind: 'check', check: 'line-section', dependsOn: ['pkg-guard'] },
            {
              id: 'review',
              kind: 'agent',
              role: 'reviewer',
              dependsOn: ['doc-guard'],
              onRework: { rejectTo: 'implement', maxReworks: 2 },
            },
          ],
          verification: {
            localChecks: [
              {
                id: 'json-keys',
                implementation: 'json-keys-guard.v1',
                parameters: { path: 'package.json', allowedPointers: ['/version'] },
              },
              {
                id: 'line-section',
                implementation: 'line-section-guard.v1',
                parameters: { path: 'docs/README.md', startMarker: '<!-- START -->', endMarker: '<!-- END -->' },
              },
              {
                id: 'verify-cmd',
                implementation: 'command.v1',
                parameters: { script: '.loopwright/checks/verify.sh', timeoutSeconds: 15 },
              },
            ],
            externalGates: [],
          },
          limits: {
            overlay: { maxFiles: 512, maxBytes: 16_777_216 },
          },
          publication: {
            mode: 'disabled',
            targetBranch: 'main',
            headBranchPrefix: 'loopwright-v2/',
            titleTemplate: 'chore: v2 pipeline',
          },
          memory: {
            directory: '.loopwright/memory/v2-pipeline',
            apply: 'disabled',
            onNoModelBudget: 'deterministic-observations-only',
          },
          triggers: {
            schedule: true,
            workflowDispatch: true,
            releasePublished: false,
            commentCommands: [],
          },
        },
      };

      await writeFile(join(repoRoot, '.loopwright', 'taskpack.yaml'), serializePrettyYaml(manifestObj), 'utf8');

      // Without hostPolicy.allowWorkflowWrites, loadDeclarativeTaskpack fails closed!
      await assert.rejects(
        () => loadDeclarativeTaskpack({ manifestPath: '.loopwright/taskpack.yaml', repositoryRoot: repoRoot }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_SCOPE_VIOLATION',
      );

      const hostPolicy = { allowPrivileged: false, allowWorkflowWrites: true };
      const manifest = await loadDeclarativeTaskpack({
        manifestPath: '.loopwright/taskpack.yaml',
        repositoryRoot: repoRoot,
        hostPolicy,
      } as Parameters<typeof loadDeclarativeTaskpack>[0]);
      assert.equal(manifest.spec.proposal, undefined);

      // pinDigests: true without lockfile fails closed!
      await assert.rejects(
        () => compileDeclarativeTaskpack(manifest, {
          mode: 'candidate',
          hostPolicy,
          repository: 'octocat/target',
          repositoryRoot: repoRoot,
          baseRevision: BASE_SHA_FALLBACK,
          sourceRevision: BASE_SHA_FALLBACK,
          budgets: DEFAULT_HOST_BUDGETS,
          credentialEnvMap: { provider: 'ZAI_API_KEY' },
        }),
        (err: unknown) => err instanceof GitHubAppError,
      );

      // Write digest lockfile, then verify compilation succeeds and records runtime digests!
      const lockfile = await computeTaskpackDigests(repoRoot, manifest, '.loopwright');
      await writeDigestLockfile(repoRoot, '.loopwright/digests.lock.json', lockfile);
      const headSha = initGitRepo(repoRoot);

      const compiled = await compileDeclarativeTaskpack(manifest, {
        mode: 'candidate',
        hostPolicy,
        repository: 'octocat/target',
        repositoryRoot: repoRoot,
        baseRevision: headSha,
        sourceRevision: headSha,
        budgets: DEFAULT_HOST_BUDGETS,
        externalMcpTools: ['mcp__docs-mcp__search', 'mcp__mutating-mcp__apply_patch'],
        credentialEnvMap: {
          provider: 'ZAI_API_KEY',
          localCommandGate: DEFAULT_LOCAL_COMMAND_GATE_ENV,
        },
      });

      // Exact file scope stays exact ('package.json', NOT 'package.json/**') and .github/CODEOWNERS stays protected!
      const writableScope = compiled.config.spec.task.spec.scope.writable;
      const protectedScope = compiled.config.spec.task.spec.scope.protected;
      assert.equal(writableScope.includes('package.json'), true);
      assert.equal(writableScope.includes('package.json/**'), false);
      assert.equal(writableScope.includes('.agents/notes/**'), true);
      assert.equal(writableScope.includes('.github/workflows/**'), true);
      assert.equal(protectedScope.includes('.claude/**'), true);
      assert.equal(protectedScope.includes('.agents/**'), false);
      assert.equal(protectedScope.includes('.github/CODEOWNERS/**'), true);

      // Overlay limits & target.matrix & submission.path forwarded cleanly
      assert.deepEqual({ ...compiled.config.spec.task.spec.budgets.overlay }, { maxFiles: 512, maxBytes: 16_777_216 });
      assert.deepEqual((compiled.config.spec.task.spec.target.matrix ?? []).map(cell => ({ ...cell })), [
        { id: 'darwin-arm64', platform: 'darwin-arm64', variant: 'default' },
      ]);
      assert.equal(compiled.config.spec.controls.submission.path, 'docs/submission.json');

      // Per-role MCP tool filtering and roleMcpServers allowlist
      const rolesById = new Map(compiled.config.spec.task.spec.roles.map(r => [r.id, r] as const));
      assert.equal(rolesById.get('planner')?.tools.includes('mcp__docs-mcp__search'), true);
      assert.equal(rolesById.get('planner')?.tools.includes('mcp__mutating-mcp__apply_patch'), false);
      assert.equal(rolesById.get('implementer')?.tools.includes('mcp__mutating-mcp__apply_patch'), true);
      assert.equal(rolesById.get('reviewer')?.tools.includes('mcp__docs-mcp__search'), false);
      assert.deepEqual(compiled.roleMcpServers, {
        planner: ['docs-mcp'],
        implementer: ['docs-mcp', 'mutating-mcp'],
        reviewer: [],
      });

      // Per-role resourceIds isolation (implementer does NOT receive planner's plan.md or reviewer's review.md)
      const resourceById = new Map(compiled.config.spec.task.spec.trustedContext.resources.map(r => [r.id, r] as const));
      const plannerResPaths = (rolesById.get('planner')?.resourceIds ?? []).map(id => resourceById.get(id)?.path);
      const implResPaths = (rolesById.get('implementer')?.resourceIds ?? []).map(id => resourceById.get(id)?.path);
      const revResPaths = (rolesById.get('reviewer')?.resourceIds ?? []).map(id => resourceById.get(id)?.path);
      assert.equal(plannerResPaths.includes('.loopwright/instructions/plan.md'), true);
      assert.equal(plannerResPaths.includes('.agents/skills/plan/SKILL.md'), true);
      assert.equal(implResPaths.includes('.loopwright/instructions/global.md'), true);
      assert.equal(implResPaths.includes('.agents/skills/shared/SKILL.md'), true);
      assert.equal(implResPaths.includes('.loopwright/instructions/plan.md'), false);
      assert.equal(implResPaths.includes('.loopwright/instructions/review.md'), false);
      assert.equal(revResPaths.includes('.loopwright/instructions/review.md'), true);
      assert.equal(revResPaths.includes('.loopwright/instructions/plan.md'), false);

      // Digests computed & recorded
      assert.ok(compiled.digests !== undefined);
      assert.equal(typeof compiled.digests?.['directory:.loopwright/checks'], 'string');

      // Verify compiled config + registry pass controller loadTrustedConfiguration and compilePlan!
      const written = await writeCompiledArtifacts(runRoot, 'v2-pipeline', compiled);
      const prevZai = process.env['ZAI_API_KEY'];
      const prevOai = process.env['OPENAI_API_KEY'];
      const prevGate = process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV];
      process.env['ZAI_API_KEY'] = 'zai-secret-12345';
      process.env['OPENAI_API_KEY'] = 'oai-secret-12345';
      process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV] = 'gate-secret-12345';
      try {
        const loaded = await loadTrustedConfiguration({
          configPath: written.configPath,
          registryPath: written.registryPath,
          registrySha256: written.registrySha256,
          untrustedRoots: [repoRoot],
        });
        assert.equal(loaded.ok, true, loaded.ok ? '' : JSON.stringify(loaded.error));
        if (loaded.ok) {
          const plan = await compilePlan(loaded.value);
          assert.equal(plan.ok, true, plan.ok ? '' : JSON.stringify(plan.error));
          if (plan.ok) {
            const compactNode = plan.value.orderedDAG.find(n => n.id === 'compact-impl');
            assert.equal(compactNode?.handler.implementation, 'pi.compact.v1');
            const reviewNode = plan.value.orderedDAG.find(n => n.id === 'review');
            assert.deepEqual({ ...reviewNode?.onRework }, { rejectTo: 'implement', maxReworks: 2 });
          }
        }
      } finally {
        if (prevZai === undefined) delete process.env['ZAI_API_KEY']; else process.env['ZAI_API_KEY'] = prevZai;
        if (prevOai === undefined) delete process.env['OPENAI_API_KEY']; else process.env['OPENAI_API_KEY'] = prevOai;
        if (prevGate === undefined) delete process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV]; else process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV] = prevGate;
      }

      // Tampering with verify.sh under pinDigests: true fails closed!
      await writeFile(join(repoRoot, '.loopwright', 'checks', 'verify.sh'), '#!/bin/sh\necho tampered\nexit 0\n', { mode: 0o755 });
      await assert.rejects(
        () => compileDeclarativeTaskpack(manifest, {
          mode: 'candidate',
          hostPolicy,
          repository: 'octocat/target',
          repositoryRoot: repoRoot,
          baseRevision: headSha,
          sourceRevision: headSha,
          budgets: DEFAULT_HOST_BUDGETS,
          credentialEnvMap: { provider: 'ZAI_API_KEY' },
        }),
        (err: unknown) => err instanceof GitHubAppError,
      );
    });
  });

  it('compiles per-role models fallback list and per-gate endpoint credentials cleanly', async () => {
    await withTempDir(async dir => {
      const repoRoot = join(dir, 'repo');
      await mkdir(join(repoRoot, '.loopwright'), { recursive: true });
      await mkdir(join(repoRoot, 'docs'), { recursive: true });
      const manifest = validateTaskpackV2Manifest({
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'Taskpack',
        metadata: { name: 'per-gate-creds' },
        spec: {
          goal: { candidate: 'Update docs.', noChange: 'Confirm no change.' },
          scope: { writable: ['docs/**'], protected: [] },
          upstreams: [],
          roles: [
            {
              id: 'coder',
              provider: 'zai',
              model: 'glm-5.3',
              models: ['zai/glm-5.3', 'openai/gpt-5'],
            },
          ],
          verification: {
            localChecks: [],
            externalGates: [
              {
                id: 'sec-gate',
                gateId: 'security-audit',
                endpointId: 'sec-endpoint',
                required: true,
                url: 'https://sec.example.test/gate',
                signingCredentialRef: 'SEC_GATE_SIGNING_SECRET',
                authCredentialRef: 'SEC_GATE_AUTH_TOKEN',
              },
              {
                id: 'perf-gate',
                gateId: 'perf-bench',
                endpointId: 'perf-endpoint',
                required: false,
                url: 'https://perf.example.test/gate',
                signingCredentialRef: 'PERF_GATE_SIGNING_SECRET',
              },
            ],
          },
          publication: {
            mode: 'disabled',
            targetBranch: 'main',
            headBranchPrefix: 'lw/',
            titleTemplate: 'docs: update',
          },
          memory: { directory: '.loopwright/memory/per-gate', apply: 'disabled', onNoModelBudget: 'deterministic-observations-only' },
          triggers: { schedule: true, workflowDispatch: true, releasePublished: false, commentCommands: [] },
        },
      });

      const fallbackCompiled = await compileDeclarativeTaskpack(manifest, {
        mode: 'candidate',
        repository: 'octocat/target',
        repositoryRoot: repoRoot,
        baseRevision: BASE_SHA_FALLBACK,
        sourceRevision: BASE_SHA_FALLBACK,
        candidateIndex: 1,
        budgets: DEFAULT_HOST_BUDGETS,
      });
      assert.equal(fallbackCompiled.config.spec.task.spec.roles[0]?.provider, 'openai');
      assert.equal(fallbackCompiled.config.spec.task.spec.roles[0]?.model, 'gpt-5');
      assert.equal(fallbackCompiled.registry.spec.gateEndpoints.length, 2);
    });
  });

  it('compileScopePatterns preserves exact files and globs without appending /** in writable mode', () => {
    assert.deepEqual(
      compileScopePatterns(['package.json', 'docs/**', 'packages/*/package.json'], 'writable'),
      ['package.json', 'docs/**', 'packages/*/package.json'],
    );
    assert.deepEqual(
      compileScopePatterns(['.claude', 'docs/secret/*.md', 'docs/keep/**'], 'protected'),
      ['.claude/**', 'docs/secret/*.md', 'docs/keep/**'],
    );
  });
});

describe('Dual-key operator unlock, authorized preflight, mode: auto, and multi-tenant refusal', () => {
  it('refuses untrusted mode: privileged and allowWorkflowWrites: true BEFORE preflight.script runs, and blocks unauthorized issue_comment BEFORE preflight.script', async () => {
    await withTempDir(async dir => {
      const repoRoot = join(dir, 'repo');
      const runRoot = join(dir, 'runs');
      const markerPath = join(dir, 'preflight-ran.txt');
      await mkdir(join(repoRoot, '.loopwright', 'scripts'), { recursive: true });
      await mkdir(join(repoRoot, 'docs'), { recursive: true });
      await mkdir(runRoot, { recursive: true, mode: 0o700 });

      const preflightScript = '.loopwright/scripts/preflight.sh';
      await writeFile(
        join(repoRoot, preflightScript),
        `#!/bin/sh\necho "executed" > "${markerPath}"\nprintf '{"disposition":"no_change"}' > "$LOOPWRIGHT_PREFLIGHT_OUT"\n`,
        { mode: 0o755 },
      );

      // 1) mode: privileged without allow-privileged-execution fails closed BEFORE preflight.script runs
      const privManifest = {
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'Taskpack',
        metadata: { name: 'priv-check' },
        spec: {
          goal: { candidate: 'Update docs.', noChange: 'Confirm no change.' },
          execution: { mode: 'privileged' },
          preflight: { script: preflightScript, timeoutSeconds: 10 },
          scope: { writable: ['docs/**'], protected: [] },
          upstreams: [],
          verification: {
            localChecks: [{ id: 'nc', implementation: 'no-change.v1' }],
            externalGates: [],
          },
          publication: { mode: 'disabled', targetBranch: 'main', headBranchPrefix: 'lw/', titleTemplate: 'docs: sync' },
          memory: { directory: '.loopwright/memory/priv', apply: 'disabled', onNoModelBudget: 'deterministic-observations-only' },
          triggers: { schedule: true, workflowDispatch: true, releasePublished: false, commentCommands: ['retry'] },
        },
      };
      await writeFile(join(repoRoot, '.loopwright', 'taskpack.yaml'), serializePrettyYaml(privManifest), 'utf8');
      const sha = initGitRepo(repoRoot);

      const refusedPriv = await runGitHubActionEntrypoint({
        repositoryRoot: repoRoot,
        repositoryFullName: 'octocat/target',
        baseRevision: sha,
        mode: 'auto',
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'priv-refused-1',
      });
      assert.equal(refusedPriv.kind, 'refused');
      if (refusedPriv.kind === 'refused') {
        assert.equal(refusedPriv.code, 'TASKPACK_HOST_BINDING_INVALID');
      }
      assert.equal(existsSync(markerPath), false, 'preflight.script must NEVER execute before dual-key authorization');

      // 2) Unauthorized issue_comment on a strict manifest NEVER runs preflight.script!
      const strictManifest = {
        ...privManifest,
        spec: {
          ...privManifest.spec,
          execution: { mode: 'strict' },
        },
      };
      await writeFile(join(repoRoot, '.loopwright', 'taskpack.yaml'), serializePrettyYaml(strictManifest), 'utf8');

      const unauthComment = await runGitHubActionEntrypoint({
        repositoryRoot: repoRoot,
        repositoryFullName: 'octocat/target',
        baseRevision: sha,
        mode: 'auto',
        eventName: 'issue_comment',
        eventPayload: {
          action: 'created',
          issue: { number: 3, pull_request: { number: 3, head: { sha } } },
          comment: {
            id: 55,
            body: '/loopwright retry',
            author_association: 'NONE',
            user: { login: 'stranger', type: 'User' },
          },
        },
        runRoot,
        runId: 'unauth-comment-1',
      });
      assert.equal(unauthComment.kind, 'blocked');
      assert.equal(existsSync(markerPath), false, 'unauthorized issue_comment must NEVER execute preflight.script');
    });
  });

  it('refuses self-granted privileged capabilities in multi-tenant service.ts', async () => {
    assert.deepEqual(MULTI_TENANT_HOST_POLICY, { allowPrivileged: false, allowWorkflowWrites: false });
    const privilegedManifest = validateTaskpackV2Manifest(
      {
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'Taskpack',
        metadata: { name: 'tenant-priv' },
        spec: {
          goal: { candidate: 'Sync', noChange: 'None' },
          execution: { mode: 'privileged' },
          scope: { writable: ['docs/**'], protected: [] },
          upstreams: [],
          verification: { localChecks: [{ id: 'nc', implementation: 'no-change.v1' }], externalGates: [] },
          publication: { mode: 'disabled', targetBranch: 'main', headBranchPrefix: 'lw/', titleTemplate: 'sync' },
          memory: { directory: '.loopwright/memory/tp', apply: 'disabled', onNoModelBudget: 'deterministic-observations-only' },
          triggers: { schedule: true, workflowDispatch: true, releasePublished: false, commentCommands: [] },
        },
      },
      { enforceHostAuthority: false },
    );

    assert.throws(
      () => assertMultiTenantManifestAuthority(privilegedManifest),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_HOST_BINDING_INVALID',
    );

    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const broker = new InstallationTokenBroker({
      appId: 99,
      privateKeyPem: pem,
      transport: { createInstallationToken: async () => ({ token: 'ghs_test_token_1234567890', expiresAtMs: Date.now() + 60_000 }) },
    });

    await assert.rejects(
      () => startGitHubAppControlPlane({
        port: 0,
        webhookSecret: 'webhook-sec',
        tokenBroker: broker,
        manifest: privilegedManifest,
      }),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_HOST_BINDING_INVALID',
    );

    // Also verify lease route refuses tenant-supplied manifest requesting allowWorkflowWrites!
    const handle = await startGitHubAppControlPlane({
      port: 0,
      webhookSecret: 'webhook-sec',
      tokenBroker: broker,
      taskpackId: 'tenant-priv',
      baseRevision: BASE_SHA_FALLBACK,
    });
    try {
      const wfManifestJson = {
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'Taskpack',
        metadata: { name: 'tenant-priv' },
        spec: {
          goal: { candidate: 'Sync', noChange: 'None' },
          execution: { mode: 'strict', capabilities: { allowWorkflowWrites: true } },
          scope: { writable: ['.github/workflows/**'], protected: [] },
          upstreams: [],
          verification: { localChecks: [{ id: 'nc', implementation: 'no-change.v1' }], externalGates: [] },
          publication: { mode: 'disabled', targetBranch: 'main', headBranchPrefix: 'lw/', titleTemplate: 'sync' },
          memory: { directory: '.loopwright/memory/tp', apply: 'disabled', onNoModelBudget: 'deterministic-observations-only' },
          triggers: { schedule: true, workflowDispatch: true, releasePublished: false, commentCommands: [] },
        },
      };
      const res = await fetch(`${handle.url}/tenants/1/2/tenant-priv/lease`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workerId: 'w1', repositoryFullName: 'octocat/target', manifest: wfManifestJson }),
      });
      assert.equal(res.status, 400);
      const body = await res.json() as { error?: { code?: string } };
      assert.equal(body.error?.code, 'TASKPACK_SCOPE_VIOLATION');

      // Mismatched metadata.name vs tenant taskpackId must fail closed with 400 TASKPACK_HOST_BINDING_INVALID
      const mismatchedManifestJson = {
        ...wfManifestJson,
        metadata: { name: 'different-pack' },
        spec: {
          ...wfManifestJson.spec,
          execution: { mode: 'strict' },
          scope: { writable: ['docs/**'], protected: [] },
        },
      };
      const mismatchRes = await fetch(`${handle.url}/tenants/1/2/tenant-priv/lease`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workerId: 'w1', repositoryFullName: 'octocat/target', manifest: mismatchedManifestJson }),
      });
      assert.equal(mismatchRes.status, 400);
      const mismatchBody = await mismatchRes.json() as { error?: { code?: string } };
      assert.equal(mismatchBody.error?.code, 'TASKPACK_HOST_BINDING_INVALID');
    } finally {
      await handle.close();
    }

    // Pinned manifest on control plane rejects differing lease manifest and accepts matching manifest
    const pinnedRaw = {
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'Taskpack',
      metadata: { name: 'tenant-pinned' },
      spec: {
        goal: { candidate: 'Sync', noChange: 'None' },
        execution: { mode: 'strict' },
        scope: { writable: ['docs/**'], protected: [] },
        upstreams: [],
        verification: { localChecks: [{ id: 'nc', implementation: 'no-change.v1' }], externalGates: [] },
        publication: { mode: 'disabled', targetBranch: 'main', headBranchPrefix: 'lw/', titleTemplate: 'sync' },
        memory: { directory: '.loopwright/memory/tp', apply: 'disabled', onNoModelBudget: 'deterministic-observations-only' },
        triggers: { schedule: true, workflowDispatch: true, releasePublished: false, commentCommands: [] },
      },
    };
    const pinnedManifest = validateTaskpackV2Manifest(pinnedRaw as Json);
    const pinnedHandle = await startGitHubAppControlPlane({
      port: 0,
      webhookSecret: 'webhook-sec',
      tokenBroker: broker,
      taskpackId: 'tenant-pinned',
      baseRevision: BASE_SHA_FALLBACK,
      manifest: pinnedManifest,
    });
    try {
      const tampered = { ...pinnedRaw, spec: { ...pinnedRaw.spec, scope: { writable: ['src/**'], protected: [] } } };
      const tamperedRes = await fetch(`${pinnedHandle.url}/tenants/1/2/tenant-pinned/lease`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workerId: 'w1', repositoryFullName: 'octocat/target', manifest: tampered }),
      });
      assert.equal(tamperedRes.status, 400);
      const tamperedBody = await tamperedRes.json() as { error?: { code?: string } };
      assert.equal(tamperedBody.error?.code, 'TASKPACK_HOST_BINDING_INVALID');

      const matchingRes = await fetch(`${pinnedHandle.url}/tenants/1/2/tenant-pinned/lease`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workerId: 'w1', repositoryFullName: 'octocat/target', manifest: pinnedRaw }),
      });
      assert.equal(matchingRes.status, 200);
    } finally {
      await pinnedHandle.close();
    }
  });

  it('mode: auto runs check-only no-change verification with ZERO model calls on no_change, and dispatches candidate on available updates or force: true', async () => {
    await withTempDir(async dir => {
      const repoRoot = join(dir, 'repo');
      const runRoot = join(dir, 'runs');
      await mkdir(join(repoRoot, '.loopwright', 'scripts'), { recursive: true });
      await mkdir(join(repoRoot, 'docs'), { recursive: true });
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await writeFile(join(repoRoot, 'docs', 'guide.md'), '# Clean Baseline\n', 'utf8');

      await writeFile(
        join(repoRoot, '.loopwright', 'scripts', 'preflight.sh'),
        '#!/bin/sh\nprintf \'{"disposition":"no_change","reason":"already synchronized"}\' > "$LOOPWRIGHT_PREFLIGHT_OUT"\n',
        { mode: 0o755 },
      );

      let llmCalls = 0;
      const mockLlm = await startHttpServer(async (_req, res) => {
        llmCalls += 1;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sseStop('glm-5.3', JSON.stringify({
          version: 1,
          status: 'completed',
          checks: [{ checkId: 'clean-check', status: 'passed', evidenceId: null, reason: null }],
          reason: null,
        })));
      });

      try {
        const manifestObj = {
          apiVersion: 'loopwright.dev/v1alpha1',
          kind: 'Taskpack',
          metadata: { name: 'auto-mode-sync' },
          spec: {
            goal: { candidate: 'Sync docs.', noChange: 'Verify zero modifications.' },
            preflight: { script: '.loopwright/scripts/preflight.sh', timeoutSeconds: 10 },
            scope: { writable: ['docs/**'], protected: [] },
            upstreams: [{ id: 'core-lib', kind: 'github-release', source: 'octocat/core-lib', watchedPaths: ['docs'] }],
            models: [{ provider: 'openai', id: 'gpt-5', thinking: 'medium', api: 'openai-completions', baseUrl: `${mockLlm.url}/v1`, apiKeyEnv: 'OPENAI_API_KEY' }],
            verification: {
              localChecks: [{ id: 'clean-check', implementation: 'no-change.v1' }],
              externalGates: [],
            },
            publication: { mode: 'disabled', targetBranch: 'main', headBranchPrefix: 'lw/', titleTemplate: 'docs: sync' },
            memory: { directory: '.loopwright/memory/auto', apply: 'disabled', onNoModelBudget: 'deterministic-observations-only' },
            triggers: { schedule: true, workflowDispatch: true, releasePublished: false, commentCommands: [] },
          },
        };
        await writeFile(join(repoRoot, '.loopwright', 'taskpack.yaml'), serializePrettyYaml(manifestObj), 'utf8');
        const headSha = initGitRepo(repoRoot);

        const autoNoChange = await runGitHubActionEntrypoint({
          turnkey: true,
          repositoryRoot: repoRoot,
          repositoryId: 11,
          repositoryFullName: 'octocat/target',
          baseRevision: headSha,
          mode: 'auto',
          allowManifestCustomBaseUrl: true,
          eventName: 'schedule',
          runRoot,
          runId: 'auto-nc-1',
          env: { ...process.env, OPENAI_API_KEY: 'oai-test-token' },
          openHostSessionAdapter: FAST_ADAPTER,
        });
        assert.equal(autoNoChange.kind, 'no_change');
        assert.equal(llmCalls, 0, 'check-only no-change under mode: auto must invoke ZERO agent model calls');
        if (autoNoChange.kind === 'no_change') {
          assert.ok(autoNoChange.taskpack !== undefined, 'mode: auto no_change should attach compiled check-only taskpack');
          const agentSteps = autoNoChange.taskpack!.config.spec.task.spec.steps.filter(s => s.kind === 'agent');
          assert.equal(agentSteps.length, 0);
          assert.equal(autoNoChange.delegateOutcome?.ok, true);
        }

        // With force: true under mode: auto, dispatches candidate!
        const autoForced = await runGitHubActionEntrypoint({
          turnkey: true,
          repositoryRoot: repoRoot,
          repositoryId: 11,
          repositoryFullName: 'octocat/target',
          baseRevision: headSha,
          mode: 'auto',
          force: true,
          allowManifestCustomBaseUrl: true,
          eventName: 'workflow_dispatch',
          runRoot,
          runId: 'auto-force-1',
          env: { ...process.env, OPENAI_API_KEY: 'oai-test-token' },
          probeFetch: async () => new Response(
            JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'OK' } }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
          openHostSessionAdapter: FAST_ADAPTER,
        });
        assert.equal(autoForced.kind, 'compiled');
        assert.ok(llmCalls >= 1, 'force: true under mode: auto must dispatch candidate agent turn');
      } finally {
        await mockLlm.close();
      }
    });
  });
});

describe('Preflight split staging, directory-mounted command.v1, preserveRepoDirName, LOOPWRIGHT_CHECK_OUT, and wide overlays', () => {
  it('stages >100 KiB lockfile + binary .tgz via mount: workspace + prompt text, mounts whole check directory with ./lib.sh, preserveRepoDirName, toolchainPaths, LOOPWRIGHT_BASE_DIR, LOOPWRIGHT_STAGED_DIR, and propagates LOOPWRIGHT_CHECK_OUT float metrics & findings into RunResult', async () => {
    await withTempDir(async dir => {
      const repoRoot = join(dir, 'my-custom-repo');
      const runRoot = join(dir, 'runs');
      await mkdir(join(repoRoot, '.loopwright', 'scripts'), { recursive: true });
      await mkdir(join(repoRoot, '.loopwright', 'checks'), { recursive: true });
      await mkdir(join(repoRoot, '.loopwright', 'bin'), { recursive: true });
      await mkdir(join(repoRoot, 'docs'), { recursive: true });
      await mkdir(runRoot, { recursive: true, mode: 0o700 });

      await writeFile(join(repoRoot, 'docs', 'target.txt'), 'baseline-v1\n', 'utf8');

      await writeFile(
        join(repoRoot, '.loopwright', 'bin', 'lw-custom-tool'),
        '#!/bin/sh\nprintf "custom-tool-ok"\n',
        { mode: 0o755 },
      );

      await writeFile(
        join(repoRoot, '.loopwright', 'checks', 'lib.sh'),
        '#!/bin/sh\nhelper_greeting() { printf "from-lib-sh"; }\n',
        { mode: 0o644 },
      );

      const checkScriptContent = `#!/bin/sh
set -eu
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
. "$SCRIPT_DIR/lib.sh"
[ "$(helper_greeting)" = "from-lib-sh" ] || { echo "lib.sh failed"; exit 1; }
[ "$(lw-custom-tool)" = "custom-tool-ok" ] || { echo "toolchain failed"; exit 1; }
[ "$(basename "$PWD")" = "my-custom-repo" ] || { echo "bad repo basename: $(basename "$PWD")"; exit 1; }
[ -d ".git" ] || { echo "missing read-only .git"; exit 1; }
[ ! -e ".git/hooks" ] || { echo ".git/hooks leaked into candidateDir"; exit 1; }
[ ! -e ".git/credentials" ] || { echo ".git/credentials leaked into candidateDir"; exit 1; }
! grep -q "extraheader" ".git/config" || { echo "raw .git/config credential leaked"; exit 1; }
grep -q "hooksPath = /dev/null" ".git/config" || { echo "missing sanitized hooksPath"; exit 1; }
grep -q "fsmonitor = false" ".git/config" || { echo "missing sanitized fsmonitor"; exit 1; }
[ "$GIT_CONFIG_NOSYSTEM" = "1" ] || { echo "missing GIT_CONFIG_NOSYSTEM=1"; exit 1; }
[ "$GIT_CONFIG_GLOBAL" = "/dev/null" ] || { echo "missing GIT_CONFIG_GLOBAL=/dev/null"; exit 1; }
[ "$STATIC_CHECK_MODE" = "strict-v2" ] || { echo "missing static env map"; exit 1; }
[ -f "$LOOPWRIGHT_BASE_DIR/docs/target.txt" ] || { echo "missing LOOPWRIGHT_BASE_DIR"; exit 1; }
grep -q "baseline-v1" "$LOOPWRIGHT_BASE_DIR/docs/target.txt" || { echo "bad base snapshot"; exit 1; }
[ -f "$LOOPWRIGHT_STAGED_DIR/staged/large-lock.json" ] || { echo "missing staged lockfile"; exit 1; }
[ -f "$LOOPWRIGHT_STAGED_DIR/staged/cache.tgz" ] || { echo "missing staged binary tgz"; exit 1; }
[ ! -e "$LOOPWRIGHT_STAGED_DIR/staged/private-agent-only.bin" ] || { echo "unexposed workspace resource leaked to check!"; exit 1; }
SECRET_TOK="super_secret_""check_tok_999"
cat > "$LOOPWRIGHT_CHECK_OUT" <<EOF
{
  "detail": "verified with token $SECRET_TOK",
  "metrics": {
    "latency_ms": 1.425,
    "speedup": 2.5,
    "helper_loaded": true,
    "profile": "strict"
  },
  "findings": [
    {
      "title": "Minor style note",
      "severity": "low",
      "path": "docs/target.txt",
      "line": 1,
      "evidence": "checked against $SECRET_TOK"
    }
  ]
}
EOF
exit 0
`;
      await writeFile(join(repoRoot, '.loopwright', 'checks', 'verify-all.sh'), checkScriptContent, { mode: 0o755 });

      const preflightScriptContent = `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const stageDir = process.env.LOOPWRIGHT_STAGING_DIR;
mkdirSync(join(stageDir, 'staged'), { recursive: true });
writeFileSync(join(stageDir, 'staged', 'summary.md'), '# Preflight Summary\\nUpgrade target to v2.\\n', 'utf8');
writeFileSync(join(stageDir, 'staged', 'large-lock.json'), JSON.stringify({ lockfileVersion: 3, pad: 'x'.repeat(120_000) }), 'utf8');
writeFileSync(join(stageDir, 'staged', 'cache.tgz'), Buffer.from([0x1f, 0x8b, 0x08, 0xff, 0xfe, 0xfd, 0x00, 0x80]));
writeFileSync(join(stageDir, 'staged', 'private-agent-only.bin'), Buffer.from([0xff, 0x00, 0xfe, 0x01]));
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({
  disposition: 'candidate',
  reason: 'v2 available',
  upstreams: [{ id: 'pkg-core', status: 'available', version: '2.0.0', currentVersion: '1.0.0' }],
  stagedResources: [
    { id: 'preflight-summary', kind: 'instruction', path: 'staged/summary.md', mount: 'prompt' },
    { id: 'staged-lock', kind: 'document', path: 'staged/large-lock.json', mount: 'workspace', exposeToChecks: true },
    { id: 'staged-tgz', kind: 'document', path: 'staged/cache.tgz', mount: 'workspace', exposeToChecks: true },
    { id: 'agent-only-bin', kind: 'document', path: 'staged/private-agent-only.bin', mount: 'workspace', exposeToChecks: false }
  ]
}), 'utf8');
`;
      await writeFile(join(repoRoot, '.loopwright', 'scripts', 'preflight.mjs'), preflightScriptContent, { mode: 0o755 });

      let capturedPromptText = '';
      let turnStep = 0;
      const mockLlm = await startHttpServer(async (req, res) => {
        const body = await readJsonBody(req);
        const msgs = (body['messages'] as { role?: string; content?: unknown }[] | undefined) ?? [];
        for (const m of msgs) {
          if (m.role === 'user' && typeof m.content === 'string') {
            capturedPromptText += `\n${m.content}`;
          }
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        turnStep += 1;
        if (turnStep === 1) {
          res.end(sseToolCall('gpt-5', 'call_write_1', 'write', { path: 'docs/target.txt', content: 'updated-v2\n' }));
          return;
        }
        res.end(sseStop('gpt-5', JSON.stringify({
          version: 1,
          status: 'completed',
          checks: [],
          reason: 'updated target',
        })));
      });

      try {
        const manifestObj = {
          apiVersion: 'loopwright.dev/v1alpha1',
          kind: 'Taskpack',
          metadata: { name: 'full-e2e-v2' },
          spec: {
            goal: { candidate: 'Update docs/target.txt to v2.', noChange: 'No change.' },
            preflight: { script: '.loopwright/scripts/preflight.mjs', timeoutSeconds: 15 },
            scope: { writable: ['docs/**'], protected: [] },
            upstreams: [{ id: 'pkg-core', kind: 'github-release', source: 'octocat/pkg-core', watchedPaths: ['docs'] }],
            models: [{ provider: 'openai', id: 'gpt-5', thinking: 'medium', api: 'openai-completions', baseUrl: `${mockLlm.url}/v1`, apiKeyEnv: 'OPENAI_API_KEY' }],
            limits: {
              overlay: { maxFiles: 300, maxBytes: 8_388_608 },
            },
            verification: {
              localChecks: [
                {
                  id: 'verify-all',
                  implementation: 'command.v1',
                  parameters: {
                    script: '.loopwright/checks/verify-all.sh',
                    timeoutSeconds: 20,
                    preserveRepoDirName: true,
                    mountReadOnlyGit: true,
                    toolchainPaths: ['.loopwright/bin'],
                    env: { STATIC_CHECK_MODE: 'strict-v2' },
                  },
                },
              ],
              externalGates: [],
            },
            publication: { mode: 'disabled', targetBranch: 'main', headBranchPrefix: 'lw/', titleTemplate: 'chore: v2' },
            memory: { directory: '.loopwright/memory/e2e', apply: 'disabled', onNoModelBudget: 'deterministic-observations-only' },
            triggers: { schedule: true, workflowDispatch: true, releasePublished: false, commentCommands: [] },
          },
        };
        await writeFile(join(repoRoot, '.loopwright', 'taskpack.yaml'), serializePrettyYaml(manifestObj), 'utf8');
        const headSha = initGitRepo(repoRoot);
        // Seed sensitive .git files & config credentials to verify sanitized read-only .git staging.
        await mkdir(join(repoRoot, '.git', 'hooks'), { recursive: true });
        await writeFile(join(repoRoot, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho PWNED\n', { mode: 0o755 });
        await writeFile(join(repoRoot, '.git', 'credentials'), 'https://x-access-token:leaked_cred@github.com\n', 'utf8');
        const origGitConfig = await readFile(join(repoRoot, '.git', 'config'), 'utf8');
        await writeFile(
          join(repoRoot, '.git', 'config'),
          `${origGitConfig}\n[http "https://github.com/"]\n\textraheader = AUTHORIZATION: basic dGVzdDpsZWFrZWQ=\n[core]\n\tfsmonitor = /bin/true\n`,
          'utf8',
        );

        let capturedReportStatus = '';
        const result = await runGitHubActionEntrypoint({
          turnkey: true,
          repositoryRoot: repoRoot,
          repositoryId: 77,
          repositoryFullName: 'octocat/my-custom-repo',
          baseRevision: headSha,
          mode: 'auto',
          allowManifestCustomBaseUrl: true,
          allowPrivilegedExecution: true,
          eventName: 'workflow_dispatch',
          runRoot,
          runId: 'e2e-preflight-cmd-1',
          env: {
            ...process.env,
            OPENAI_API_KEY: 'super_secret_check_tok_999',
          },
          probeFetch: async () => new Response(
            JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'OK' } }] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
          openHostSessionAdapter: FAST_ADAPTER,
          onTurnkeyReport: info => {
            capturedReportStatus = info.report.status;
          },
        });

        assert.equal(result.kind, 'compiled', JSON.stringify(result));
        if (result.kind === 'compiled') {
          assert.equal(result.delegateOutcome?.ok, true, result.delegateOutcome?.detail ?? '');
          assert.match(capturedPromptText, /staged\/large-lock\.json/);
          assert.match(capturedPromptText, /staged\/cache\.tgz/);
          const hasSummaryRes = result.taskpack.config.spec.task.spec.trustedContext.resources.some(
            r => r.id === 'preflight-summary',
          );
          assert.equal(hasSummaryRes, true);
        }
        assert.equal(capturedReportStatus, 'completed');

        // Inspect retained RunResult artifact on disk to verify float metrics + scrubbed findings propagated cleanly!
        const allFiles = await readdir(runRoot, { recursive: true });
        let foundMetrics = false;
        for (const f of allFiles) {
          const full = join(runRoot, String(f));
          const st = await lstat(full).catch(() => null);
          if (!st || !st.isFile()) continue;
          const txt = await readFile(full, 'utf8').catch(() => '');
          if (txt.includes('"kind":"RunResult"') || txt.includes('"kind": "RunResult"')) {
            const parsed = JSON.parse(txt) as {
              spec?: {
                verification?: {
                  spec?: {
                    required?: {
                      checkId: string;
                      status: string;
                      detail?: string | null;
                      metrics?: Record<string, unknown>;
                      findings?: { title: string; evidence: string }[];
                    }[];
                  };
                };
              };
            };
            const verifyCheck = parsed.spec?.verification?.spec?.required?.find(c => c.checkId === 'verify-all');
            if (verifyCheck?.metrics !== undefined) {
              foundMetrics = true;
              assert.equal(verifyCheck.status, 'passed');
              assert.equal(verifyCheck.metrics['latency_ms'], 1.425);
              assert.equal(verifyCheck.metrics['speedup'], 2.5);
              assert.equal(verifyCheck.metrics['helper_loaded'], true);
              assert.equal(verifyCheck.findings?.length, 1);
              assert.equal(verifyCheck.detail?.includes('super_secret_check_tok_999'), false, 'check detail must scrub secrets');
              assert.equal(verifyCheck.findings?.[0]?.evidence.includes('super_secret_check_tok_999'), false, 'findings must scrub secrets');
            }
          }
        }
        assert.equal(foundMetrics, true, 'expected RunResult to carry float metrics and findings from LOOPWRIGHT_CHECK_OUT');
      } finally {
        await mockLlm.close();
      }
    });
  });

  it('detects mid-run tampering of sibling helper files inside command.v1 script directory', async () => {
    await withTempDir(async dir => {
      const repoRoot = join(dir, 'repo');
      const runRoot = join(dir, 'runs');
      await mkdir(join(repoRoot, '.loopwright', 'checks'), { recursive: true });
      await mkdir(join(repoRoot, 'docs'), { recursive: true });
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await writeFile(join(repoRoot, 'docs', 'a.txt'), 'ok\n', 'utf8');
      await writeFile(join(repoRoot, '.loopwright', 'checks', 'lib.sh'), 'VAL=clean\n', 'utf8');
      await writeFile(join(repoRoot, '.loopwright', 'checks', 'check.sh'), '#!/bin/sh\n. "$(dirname "$0")/lib.sh"\nexit 0\n', { mode: 0o755 });

      let step = 0;
      const mockLlm = await startHttpServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        step += 1;
        if (step === 1) {
          res.end(sseToolCall('gpt-5', 'c1', 'write', { path: 'docs/a.txt', content: 'changed\n' }));
          return;
        }
        res.end(sseStop('gpt-5', JSON.stringify({ version: 1, status: 'completed', checks: [], reason: null })));
      });

      try {
        const manifest = validateTaskpackV2Manifest({
          apiVersion: 'loopwright.dev/v1alpha1',
          kind: 'Taskpack',
          metadata: { name: 'tamper-guard' },
          spec: {
            goal: { candidate: 'Update docs.', noChange: 'None.' },
            scope: { writable: ['docs/**'], protected: [] },
            upstreams: [],
            models: [{ provider: 'openai', id: 'gpt-5', thinking: 'medium', api: 'openai-completions', baseUrl: `${mockLlm.url}/v1` }],
            verification: {
              localChecks: [
                { id: 'chk', implementation: 'command.v1', parameters: { script: '.loopwright/checks/check.sh', timeoutSeconds: 10 } },
              ],
              externalGates: [],
            },
            publication: { mode: 'disabled', targetBranch: 'main', headBranchPrefix: 'lw/', titleTemplate: 'docs' },
            memory: { directory: '.loopwright/memory/tg', apply: 'disabled', onNoModelBudget: 'deterministic-observations-only' },
            triggers: { schedule: true, workflowDispatch: true, releasePublished: false, commentCommands: [] },
          },
        }, { allowLoopbackHttp: true });
        const headSha = initGitRepo(repoRoot);
        const gateServer = await startLocalCommandGateServer({
          runRoot,
          repositoryRoot: repoRoot,
          gates: [],
          runtimeEnv: {},
          scrubber: new SecretScrubber(),
        });
        await gateServer.close();

        const preview = await compileDeclarativeTaskpack(manifest, {
          mode: 'candidate',
          allowManifestCustomBaseUrl: true,
          repository: 'octocat/target',
          repositoryRoot: repoRoot,
          baseRevision: headSha,
          sourceRevision: headSha,
          budgets: DEFAULT_HOST_BUDGETS,
          credentialEnvMap: { provider: 'OPENAI_API_KEY', localCommandGate: DEFAULT_LOCAL_COMMAND_GATE_ENV },
        });
        assert.ok(preview.localCommandGates?.[0]?.scriptDirSha256);

        const realGateServer = await startLocalCommandGateServer({
          runRoot,
          repositoryRoot: repoRoot,
          gates: preview.localCommandGates!,
          runtimeEnv: {},
          scrubber: new SecretScrubber(),
        });
        try {
          const compiled = await compileDeclarativeTaskpack(manifest, {
            mode: 'candidate',
            allowManifestCustomBaseUrl: true,
            repository: 'octocat/target',
            repositoryRoot: repoRoot,
            baseRevision: headSha,
            sourceRevision: headSha,
            budgets: DEFAULT_HOST_BUDGETS,
            gateEndpoints: [realGateServer.endpointPlan],
            credentialEnvMap: { provider: 'OPENAI_API_KEY', localCommandGate: DEFAULT_LOCAL_COMMAND_GATE_ENV },
          });
          // Tamper with sibling helper lib.sh AFTER compilation!
          await writeFile(join(repoRoot, '.loopwright', 'checks', 'lib.sh'), 'VAL=tampered\n', 'utf8');

          const written = await writeCompiledArtifacts(runRoot, 'tamper', compiled);
          const execRes = await executeTurnkeyActionCycle({
            taskpack: written,
            repositoryRoot: repoRoot,
            runId: 'tamper-run-1',
            attemptSeq: 0,
            runtimeEnv: {
              OPENAI_API_KEY: 'oai-tok',
              [DEFAULT_LOCAL_COMMAND_GATE_ENV]: realGateServer.signingSecret,
            },
            openHostSessionAdapter: FAST_ADAPTER,
          });
          assert.equal(execRes.outcome.ok, false, 'tampered sibling helper in check directory must fail verification');
        } finally {
          await realGateServer.close();
        }
      } finally {
        await mockLlm.close();
      }
    });
  });
});

describe('Multi-upstream lockstep held_back and turnkey-memory currentVersion & targetMatrix', () => {
  it('proceeds as candidate when one lockstep group is held_back and a sibling is available, keeping currentVersion and targetMatrix in reviewed memory', async () => {
    await withTempDir(async dir => {
      const repoRoot = join(dir, 'repo');
      const runRoot = join(dir, 'runs');
      await mkdir(join(repoRoot, '.loopwright'), { recursive: true });
      await mkdir(join(repoRoot, 'docs'), { recursive: true });
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await writeFile(
        join(repoRoot, 'package.json'),
        JSON.stringify({
          name: 'multi-up-repo',
          dependencies: {
            'pi-a': '1.0.0',
            'pi-b': '1.0.0',
            yaml: '2.8.0',
          },
        }, null, 2),
        'utf8',
      );
      await writeFile(join(repoRoot, 'docs', 'notes.md'), '<!-- S -->\nv1\n<!-- E -->\n', 'utf8');

      let seenPrompt = '';
      let callCount = 0;
      const mockLlm = await startHttpServer(async (req, res) => {
        const body = await readJsonBody(req);
        const msgs = (body['messages'] as { role?: string; content?: unknown }[] | undefined) ?? [];
        for (const m of msgs) {
          if (m.role === 'user' && typeof m.content === 'string') seenPrompt += `\n${m.content}`;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        callCount += 1;
        if (callCount === 1) {
          res.end(sseToolCall('gpt-5', 'w1', 'write', { path: 'docs/notes.md', content: 'TAMPERED OUTSIDE\n<!-- S -->\nv2\n<!-- E -->\n' }));
          return;
        }
        res.end(sseStop('gpt-5', JSON.stringify({ version: 1, status: 'completed', checks: [], reason: 'updated notes' })));
      });

      try {
        const manifestObj = {
          apiVersion: 'loopwright.dev/v1alpha1',
          kind: 'Taskpack',
          metadata: { name: 'lockstep-mem' },
          spec: {
            goal: { candidate: 'Upgrade available upstreams while skipping held_back groups.', noChange: 'None.' },
            scope: { writable: ['docs/**'], protected: [] },
            target: {
              matrix: [{ id: 'linux-x64', platform: 'linux-x64', variant: 'cuda12' }],
            },
            upstreams: [
              { id: 'pi-a', kind: 'http-json', source: 'https://registry.npmjs.org/pi-a/latest', watchedPaths: ['docs'], versionPath: '$.version' },
              { id: 'pi-b', kind: 'http-json', source: 'https://registry.npmjs.org/pi-b/latest', watchedPaths: ['docs'], versionPath: '$.version' },
              { id: 'yaml', kind: 'http-json', source: 'https://registry.npmjs.org/yaml/latest', watchedPaths: ['docs'], versionPath: '$.version' },
            ],
            upstreamGroups: [
              { id: 'pi-lockstep', members: ['pi-a', 'pi-b'], policy: 'lockstep' },
            ],
            models: [{ provider: 'openai', id: 'gpt-5', thinking: 'medium', api: 'openai-completions', baseUrl: `${mockLlm.url}/v1`, apiKeyEnv: 'OPENAI_API_KEY' }],
            limits: { maxImplementationRepairs: 0, maxFormatRepairs: 0 },
            verification: {
              localChecks: [
                {
                  id: 'doc-section',
                  implementation: 'line-section-guard.v1',
                  parameters: { path: 'docs/notes.md', startMarker: '<!-- S -->', endMarker: '<!-- E -->' },
                },
              ],
              externalGates: [],
            },
            publication: { mode: 'disabled', targetBranch: 'main', headBranchPrefix: 'lw/', titleTemplate: 'chore: sync' },
            memory: {
              directory: '.loopwright/memory/lockstep-mem',
              apply: 'local-only',
              onNoModelBudget: 'deterministic-observations-only',
              checkUpstreamVersions: true,
              publishOnFailure: true,
            },
            triggers: { schedule: true, workflowDispatch: true, releasePublished: false, commentCommands: [] },
          },
        };
        await writeFile(join(repoRoot, '.loopwright', 'taskpack.yaml'), serializePrettyYaml(manifestObj), 'utf8');
        const headSha = initGitRepo(repoRoot);

        const actionRes = await runGitHubActionEntrypoint({
          turnkey: true,
          repositoryRoot: repoRoot,
          repositoryId: 88,
          repositoryFullName: 'octocat/multi-up-repo',
          baseRevision: headSha,
          mode: 'auto',
          allowManifestCustomBaseUrl: true,
          eventName: 'schedule',
          runRoot,
          runId: 'lockstep-run-1',
          env: { ...process.env, OPENAI_API_KEY: 'oai-mem-token' },
          probeFetch: async url => {
            const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
            if (u.includes('/pi-a/latest')) return new Response(JSON.stringify({ version: '2.0.0' }), { status: 200 });
            if (u.includes('/pi-b/latest')) return new Response(JSON.stringify({ version: '1.5.0' }), { status: 200 });
            if (u.includes('/yaml/latest')) return new Response(JSON.stringify({ version: '2.9.1' }), { status: 200 });
            return new Response(
              JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'OK' } }] }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          },
          openHostSessionAdapter: FAST_ADAPTER,
        });

        assert.equal(actionRes.kind, 'compiled');
        assert.match(seenPrompt, /held_back/);
        assert.match(seenPrompt, /2\.9\.1/);

        if (actionRes.kind === 'compiled') {
          assert.equal(actionRes.memory?.status, 'local_only', `unexpected memory status: ${actionRes.memory?.status} (${actionRes.memory?.reason})`);
          const store = await loadMemoryStore(
            repoRoot,
            'lockstep-mem',
            'octocat/multi-up-repo',
            '.loopwright/memory',
          );
          assert.ok(store.index.entries.length >= 1);
          const entry = store.index.entries[0]!;
          assert.equal(entry.validFor.upstreamVersions['pi-a'], '1.0.0', 'held_back upstream must keep currentVersion 1.0.0, NEVER skipped 2.0.0');
          assert.equal(entry.validFor.upstreamVersions['pi-b'], '1.0.0', 'held_back upstream must keep currentVersion 1.0.0, NEVER skipped 1.5.0');
          assert.equal(entry.validFor.upstreamVersions['yaml'], '2.9.1', 'available upstream records target version 2.9.1');
          assert.deepEqual(entry.scope.targetMatrix, { id: 'linux-x64', platform: 'linux-x64', variant: 'cuda12' });
        }
        void finalizeAndPublishTurnkeyMemory;
      } finally {
        await mockLlm.close();
      }
    });
  });
});

describe('Sandbox */? glob translation, .agents opt-in, and dual-key .github/workflows', () => {
  const canRunKernelSandbox =
    (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) ||
    (process.platform === 'linux' && (existsSync('/usr/bin/bwrap') || existsSync('/usr/bin/python3')));

  it('drops .agents from ALWAYS_PROTECTED_WORKSPACE_SUBPATHS while keeping .claude protected', () => {
    assert.equal(ALWAYS_PROTECTED_WORKSPACE_SUBPATHS.includes('.agents'), false);
    assert.equal(ALWAYS_PROTECTED_WORKSPACE_SUBPATHS.includes('.claude'), true);
  });

  it('permits writes to matched packages/*/package.json and docs/** while blocking sibling packages/core/src/index.ts, and enforces dual-key .github/workflows', async () => {
    await withTempDir(async workspaceRoot => {
      await mkdir(join(workspaceRoot, '.git'), { recursive: true });
      await mkdir(join(workspaceRoot, '.loopwright'), { recursive: true });
      await mkdir(join(workspaceRoot, '.claude'), { recursive: true });
      await mkdir(join(workspaceRoot, '.agents', 'skills'), { recursive: true });
      await mkdir(join(workspaceRoot, '.github', 'workflows'), { recursive: true });
      await mkdir(join(workspaceRoot, 'packages', 'core', 'src'), { recursive: true });
      await mkdir(join(workspaceRoot, 'packages', 'cli', 'src'), { recursive: true });
      await mkdir(join(workspaceRoot, 'docs'), { recursive: true });

      await writeFile(join(workspaceRoot, '.git', 'config'), '[core]\n', 'utf8');
      await writeFile(join(workspaceRoot, '.claude', 'settings.json'), '{"locked":true}\n', 'utf8');
      await writeFile(join(workspaceRoot, '.agents', 'skills', 's.md'), 'v1\n', 'utf8');
      await writeFile(join(workspaceRoot, '.github', 'CODEOWNERS'), '* @team\n', 'utf8');
      await writeFile(join(workspaceRoot, '.github', 'workflows', 'ci.yml'), 'name: CI\n', 'utf8');
      await writeFile(join(workspaceRoot, 'packages', 'core', 'package.json'), '{"version":"1.0.0"}\n', 'utf8');
      await writeFile(join(workspaceRoot, 'packages', 'core', 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');
      await writeFile(join(workspaceRoot, 'packages', 'cli', 'package.json'), '{"version":"1.0.0"}\n', 'utf8');

      const manifest = validateTaskpackV2Manifest({
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'Taskpack',
        metadata: { name: 'glob-sandbox' },
        spec: {
          goal: { candidate: 'Bump package versions.', noChange: 'None.' },
          execution: { mode: 'strict', capabilities: { allowWorkflowWrites: true } },
          scope: {
            writable: ['packages/*/package.json', 'docs/**', '.agents/**', '.github/workflows/**'],
            protected: [],
          },
          upstreams: [],
          verification: { localChecks: [{ id: 'nc', implementation: 'no-change.v1' }], externalGates: [] },
          publication: { mode: 'disabled', targetBranch: 'main', headBranchPrefix: 'lw/', titleTemplate: 'bump' },
          memory: { directory: '.loopwright/memory/gs', apply: 'disabled', onNoModelBudget: 'deterministic-observations-only' },
          triggers: { schedule: true, workflowDispatch: true, releasePublished: false, commentCommands: [] },
        },
      }, {
        hostPolicy: { allowPrivileged: false, allowWorkflowWrites: true },
        githubSiblings: ['.github/CODEOWNERS'],
      });
      await writeFile(join(workspaceRoot, '.loopwright', 'taskpack.yaml'), serializePrettyYaml(manifest), 'utf8');

      // Without hostPolicy.allowWorkflowWrites, resolveEffectiveTaskpackSandboxPolicy fails closed!
      assert.throws(
        () => resolveEffectiveTaskpackSandboxPolicy(manifest, { workspaceRoot, env: {} }),
        (err: unknown) => err instanceof GitHubAppError,
      );

      const policy = resolveEffectiveTaskpackSandboxPolicy(manifest, {
        workspaceRoot,
        hostPolicy: { allowPrivileged: false, allowWorkflowWrites: true },
        env: {},
      });

      const seatbelt = compileMacosSeatbeltProfile(policy, { platform: 'darwin', arch: 'arm64', probeExecutables: false });
      assert.equal(seatbelt.profileText.includes(`(subpath "${join(workspaceRoot, 'packages', 'core')}")`), false, 'must NEVER grant subpath on packages/core');

      const bwrap = compileLinuxBwrapCommand(policy, { platform: 'linux', arch: 'x64', probeExecutables: false });
      const overBroadBind = bwrap.args.some(
        (arg, idx) => arg === '--bind' && bwrap.args[idx + 1] === join(workspaceRoot, 'packages', 'core'),
      );
      assert.equal(overBroadBind, false, 'bwrap must NEVER --bind whole packages/core directory');

      if (canRunKernelSandbox) {
        // 1. Allowed: packages/core/package.json
        const okPkg = await executeSandboxedCommand({
          policy,
          command: '/bin/sh',
          args: ['-c', 'printf \'{"version":"2.0.0"}\\n\' > "$1"', 'sh', join(workspaceRoot, 'packages', 'core', 'package.json')],
        });
        assert.equal(okPkg.exitCode, 0, okPkg.stderr);
        assert.equal(await readFile(join(workspaceRoot, 'packages', 'core', 'package.json'), 'utf8'), '{"version":"2.0.0"}\n');

        // 2. Blocked: packages/core/src/index.ts!
        const blockedSrc = await executeSandboxedCommand({
          policy,
          command: '/bin/sh',
          args: ['-c', 'printf "export const tampered = true;\\n" > "$1"', 'sh', join(workspaceRoot, 'packages', 'core', 'src', 'index.ts')],
        });
        assert.notEqual(blockedSrc.exitCode, 0, 'packages/*/package.json must NOT allow writing packages/core/src/index.ts');
        assert.equal(await readFile(join(workspaceRoot, 'packages', 'core', 'src', 'index.ts'), 'utf8'), 'export const x = 1;\n');

        // 3. Allowed: .agents/skills/s.md and .github/workflows/ci.yml (dual-key unlocked)
        const okAgents = await executeSandboxedCommand({
          policy,
          command: '/bin/sh',
          args: ['-c', 'printf "v2\\n" > "$1"', 'sh', join(workspaceRoot, '.agents', 'skills', 's.md')],
        });
        assert.equal(okAgents.exitCode, 0, okAgents.stderr);

        const okWorkflow = await executeSandboxedCommand({
          policy,
          command: '/bin/sh',
          args: ['-c', 'printf "name: CI v2\\n" > "$1"', 'sh', join(workspaceRoot, '.github', 'workflows', 'ci.yml')],
        });
        assert.equal(okWorkflow.exitCode, 0, okWorkflow.stderr);

        // 4. Blocked: .claude/settings.json and .github/CODEOWNERS!
        const blockedClaude = await executeSandboxedCommand({
          policy,
          command: '/bin/sh',
          args: ['-c', 'printf "{}" > "$1"', 'sh', join(workspaceRoot, '.claude', 'settings.json')],
        });
        assert.notEqual(blockedClaude.exitCode, 0);

        const blockedCodeowners = await executeSandboxedCommand({
          policy,
          command: '/bin/sh',
          args: ['-c', 'printf "* @attacker\\n" > "$1"', 'sh', join(workspaceRoot, '.github', 'CODEOWNERS')],
        });
        assert.notEqual(blockedCodeowners.exitCode, 0, '.github/CODEOWNERS must remain protected even when allowWorkflowWrites is true');
      }
    });
  });
});

describe('Live spec.decisions wiring and stageTaskpackForStep parity', () => {
  it('wires spec.decisions via createTaskpackDecisionPort: skips empty triageRules cleanly, preserves pinned models, falls back deterministically, and refuses forbidden authority intents', async () => {
    for (const forbidden of DECISION_FORBIDDEN_AUTHORITY_INTENTS) {
      assert.throws(
        () => assertDecisionAuthorityBoundary(forbidden),
        (err: unknown) => err instanceof DecisionError && err.code === 'DECISION_AUTHORITY_VIOLATION',
      );
    }

    const baseDecisionManifest = (triageRules?: { id: string; description: string; severity: 'blocking'; kind: 'noul' }[]) => validateTaskpackV2Manifest({
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'Taskpack',
      metadata: { name: 'decisions-live' },
      spec: {
        goal: { candidate: 'Update docs.', noChange: 'None.' },
        scope: { writable: ['docs/**'], protected: [] },
        upstreams: [],
        decisions: {
          enabled: true,
          provider: 'typesafe-jev',
          disclosurePolicy: 'public-metadata-only',
          minConfidence: 0.8,
          confirmThreshold: 0.6,
          hardDeadlineMs: 3000,
          maxAttempts: 1,
          ...(triageRules !== undefined ? { triageRules } : {}),
        },
        verification: { localChecks: [{ id: 'nc', implementation: 'no-change.v1' }], externalGates: [] },
        publication: { mode: 'disabled', targetBranch: 'main', headBranchPrefix: 'lw/', titleTemplate: 'docs' },
        memory: { directory: '.loopwright/memory/dec', apply: 'disabled', onNoModelBudget: 'deterministic-observations-only' },
        triggers: { schedule: true, workflowDispatch: true, releasePublished: false, commentCommands: [] },
      },
    } as unknown as Json);

    let transportCalls = 0;
    const mockTransport = {
      send: async () => {
        transportCalls += 1;
        return {
          status: 200,
          body: JSON.stringify({
            answers: {
              'capability-tier': {
                choice: 'strongest',
                confidence: 0.95,
                probabilities: { fast: 0.02, balanced: 0.03, strongest: 0.95 },
              },
              'cycle-alignment': {
                choice: 'continue',
                confidence: 0.92,
                probabilities: { continue: 0.92, revise: 0.04, needs_review: 0.02, blocked: 0.02 },
              },
              'soft-compaction': {
                choice: 'compact',
                confidence: 0.91,
                probabilities: { compact: 0.91, defer: 0.09 },
              },
              'rule:no-secrets': { noul: 0.95 },
            },
          }),
        };
      },
    };

    const dummyDigest = { algorithm: 'sha256' as const, hex: 'b'.repeat(64) };

    // 1. Empty/unset triageRules skips triageCandidateDiff cleanly without throwing DECISION_BATCH_SIZE_INVALID!
    const portNoRules = createTaskpackDecisionPort(baseDecisionManifest(), {
      apiKey: 'jev_test_secret_key_123',
      transport: mockTransport,
      hasPinnedRoles: false,
    });
    assert.ok(portNoRules !== undefined);
    const skippedTriage = await portNoRules!.triageCandidateDiff!({
      runId: 'run-1',
      stepId: 'author-candidate',
      attemptId: 'att-1',
      candidateDigest: dummyDigest,
      summary: {
        changedFiles: ['docs/a.md'],
        addedLines: 4,
        deletedLines: 1,
        touchedPackages: [],
        redactedHunkSummaries: [],
      },
    });
    assert.equal(skippedTriage, null);
    assert.equal(transportCalls, 0, 'empty triageRules must skip transport completely');

    // 2. Live capability routing + diff triage with triageRules
    const portWithRules = createTaskpackDecisionPort(
      baseDecisionManifest([{ id: 'no-secrets', description: 'No hardcoded credentials', severity: 'blocking', kind: 'noul' }]),
      {
        apiKey: 'jev_test_secret_key_123',
        transport: mockTransport,
        hasPinnedRoles: false,
      },
    );
    assert.ok(portWithRules !== undefined);
    const capRes = await portWithRules!.routeCapabilityTier!({
      runId: 'run-1',
      stepId: 'author-candidate',
      roleId: 'author',
      taskKind: 'task',
      estimatedFilesCount: 3,
      hasFailingTests: false,
      requiresArchitectureChange: false,
      candidateSkills: [],
      pinnedModel: { provider: 'zai', model: 'glm-5.3', thinking: 'medium' },
    });
    assert.equal(capRes?.tier, 'strongest');
    assert.equal(capRes?.source, 'jev');
    assert.ok(transportCalls >= 1);

    const triageRes = await portWithRules!.triageCandidateDiff!({
      runId: 'run-1',
      stepId: 'author-candidate',
      attemptId: 'att-1',
      candidateDigest: dummyDigest,
      summary: {
        changedFiles: ['docs/a.md'],
        addedLines: 4,
        deletedLines: 1,
        touchedPackages: [],
        redactedHunkSummaries: [],
      },
    });
    assert.equal(triageRes?.verificationCertified, false);
    assert.equal(triageRes?.escalated.length, 1);
    assert.equal(triageRes?.escalated[0]?.ruleId, 'no-secrets');

    // 3. Pinned role models preserve user override (`source: 'user_override'`, zero transport calls)
    const callsBeforePinned = transportCalls;
    const pinnedPort = createTaskpackDecisionPort(baseDecisionManifest(), {
      apiKey: 'jev_test_secret_key_123',
      transport: mockTransport,
      hasPinnedRoles: true,
    });
    const pinnedRes = await pinnedPort!.routeCapabilityTier!({
      runId: 'run-1',
      stepId: 'coder',
      roleId: 'coder',
      taskKind: 'task',
      estimatedFilesCount: 10,
      hasFailingTests: true,
      requiresArchitectureChange: true,
      candidateSkills: [],
      pinnedModel: { provider: 'openai', model: 'gpt-5', thinking: 'high' },
    });
    assert.equal(pinnedRes?.source, 'user_override');
    assert.equal(transportCalls, callsBeforePinned);

    // 4. Transport failure / missing API key falls back deterministically without crashing
    const fallbackPort = createTaskpackDecisionPort(baseDecisionManifest(), {
      runtimeEnv: {},
      transport: {
        send: async () => {
          throw new Error('network unreachable');
        },
      },
    });
    const fallbackCap = await fallbackPort!.routeCapabilityTier!({
      runId: 'run-2',
      stepId: 'author-candidate',
      roleId: 'author',
      taskKind: 'task',
      estimatedFilesCount: 8,
      hasFailingTests: false,
      requiresArchitectureChange: false,
      candidateSkills: [],
      pinnedModel: { provider: 'zai', model: 'glm-5.3', thinking: 'medium' },
    });
    assert.equal(fallbackCap?.tier, 'balanced');
    assert.ok(fallbackCap?.source === 'deterministic_fallback' || fallbackCap?.source === 'deterministic_heuristic');
  });

  it('stageTaskpackForStep + openStagedTaskpackStepGate achieves full Taskpack 2.0 parity (roleMcpServers, mcpServers, allowWorkflowWrites, StepVerdict rework loop)', async () => {
    await withTempDir(async dir => {
      const repoRoot = join(dir, 'repo');
      const runRoot = join(dir, 'runs');
      await mkdir(join(repoRoot, '.loopwright', 'checks'), { recursive: true });
      await mkdir(join(repoRoot, '.github', 'workflows'), { recursive: true });
      await mkdir(join(repoRoot, 'docs'), { recursive: true });
      await mkdir(runRoot, { recursive: true, mode: 0o700 });

      await writeFile(join(repoRoot, '.github', 'CODEOWNERS'), '* @owners\n', 'utf8');
      await writeFile(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'name: CI v1\n', 'utf8');
      await writeFile(join(repoRoot, 'docs', 'spec.md'), '# v1\n', 'utf8');
      await writeFile(join(repoRoot, '.loopwright', 'checks', 'fast.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      const manifestObj = {
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'Taskpack',
        metadata: { name: 'step-v2-parity' },
        spec: {
          goal: { candidate: 'Update workflow and docs with reviewer rework.', noChange: 'None.' },
          execution: {
            mode: 'strict',
            capabilities: { allowWorkflowWrites: true },
          },
          scope: {
            writable: ['docs/**', '.github/workflows/**'],
            protected: [],
          },
          upstreams: [],
          mcp: {
            servers: [
              { id: 'docs-mcp', transport: 'stdio', command: 'npx', args: ['-y', 'docs-mcp'], readOnly: true },
              { id: 'repo-mcp', transport: 'stdio', command: 'npx', args: ['-y', 'repo-mcp'] },
            ],
          },
          roles: [
            {
              id: 'implementer',
              purpose: 'task',
              provider: 'antigravity',
              model: 'gemini-4-carbon',
              mcpServers: ['docs-mcp', 'repo-mcp'],
            },
            {
              id: 'reviewer',
              purpose: 'review',
              provider: 'antigravity',
              model: 'gemini-4-argon',
              mcpServers: ['docs-mcp'],
            },
          ],
          steps: [
            { id: 'implement', kind: 'agent', role: 'implementer', dependsOn: [] },
            { id: 'fast-check', kind: 'check', check: 'fast-cmd', dependsOn: ['implement'] },
            {
              id: 'review',
              kind: 'agent',
              role: 'reviewer',
              dependsOn: ['fast-check'],
              onRework: { rejectTo: 'implement', maxReworks: 2 },
            },
          ],
          verification: {
            localChecks: [
              { id: 'fast-cmd', implementation: 'command.v1', parameters: { script: '.loopwright/checks/fast.sh', timeoutSeconds: 10 } },
            ],
            externalGates: [],
          },
          publication: { mode: 'disabled', targetBranch: 'main', headBranchPrefix: 'lw/', titleTemplate: 'chore: step' },
          memory: { directory: '.loopwright/memory/step-v2', apply: 'disabled', onNoModelBudget: 'deterministic-observations-only' },
          triggers: { schedule: true, workflowDispatch: true, releasePublished: false, commentCommands: [] },
        },
      };
      await writeFile(join(repoRoot, '.loopwright', 'taskpack.yaml'), serializePrettyYaml(manifestObj), 'utf8');
      initGitRepo(repoRoot);

      // Without allowWorkflowWrites host authorization, stageTaskpackForStep fails closed!
      await assert.rejects(
        () => stageTaskpackForStep({
          taskpackPath: '.loopwright/taskpack.yaml',
          repositoryRoot: repoRoot,
          runRoot,
          runId: 'step-denied-wf',
          discoverUpstreams: false,
        }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_SCOPE_VIOLATION',
      );

      const staged = await stageTaskpackForStep({
        taskpackPath: '.loopwright/taskpack.yaml',
        repositoryRoot: repoRoot,
        runRoot,
        runId: 'step-v2-rework',
        allowWorkflowWrites: true,
        discoverUpstreams: false,
      });
      assert.equal(staged.allowWorkflowWrites, true);
      assert.deepEqual(staged.roleMcpServers, {
        implementer: ['docs-mcp', 'repo-mcp'],
        reviewer: ['docs-mcp'],
      });
      assert.equal(staged.mcpServers?.length, 2);

      const handle = await openStagedTaskpackStepGate({ runRoot, runId: 'step-v2-rework' });
      assert.notEqual(handle, null);
      if (handle === null) return;
      try {
        assert.equal(handle.allowWorkflowWrites, true);
        assert.ok(handle.ports !== undefined);

        const prevSecret = process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV];
        process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV] = handle.environment(DEFAULT_LOCAL_COMMAND_GATE_ENV);
        try {
          const loaded = await loadTrustedConfiguration({
            configPath: staged.configPath,
            registryPath: staged.registryPath,
            registrySha256: staged.registrySha256,
            untrustedRoots: [repoRoot],
          });
          assert.equal(loaded.ok, true, loaded.ok ? '' : JSON.stringify(loaded.error));
          if (!loaded.ok) return;

          // 1. stepNext yields 'implement' with ['docs-mcp', 'repo-mcp'] MCP servers
          const s1 = await stepNext(
            { configuration: loaded.value, repository: repoRoot, runRoot, runId: 'step-v2-rework', environment: handle.environment },
            handle.ports,
          );
          assert.equal(s1.ok, true);
          if (!s1.ok || s1.value.kind !== 'step') return;
          assert.equal(s1.value.stepId, 'implement');
          assert.deepEqual(s1.value.allowedMcpServers, ['docs-mcp', 'repo-mcp']);

          // Implementer edits workflow file inside candidateDir (allowed via dual-key allowWorkflowWrites!) and submits
          await writeFile(join(s1.value.candidateDir, '.github', 'workflows', 'ci.yml'), 'name: CI draft 1\n', 'utf8');
          const sub1 = await stepSubmit(
            {
              runRoot,
              runId: 'step-v2-rework',
              leaseToken: s1.value.leaseToken,
              status: 'completed',
              reason: 'draft 1',
              environment: handle.environment,
            },
            handle.ports,
          );
          assert.equal(sub1.ok, true, sub1.ok ? '' : JSON.stringify(sub1.error));
          if (!sub1.ok || sub1.value.kind !== 'step') return;

          // 2. stepSubmit automatically ran fast-check and yielded 'review' with ONLY ['docs-mcp']!
          const s2Yield = sub1.value;
          assert.equal(s2Yield.stepId, 'review');
          assert.equal(s2Yield.purpose, 'reviewer');
          assert.deepEqual(s2Yield.allowedMcpServers, ['docs-mcp']);

          // Reviewer returns StepVerdict rework -> rejects back to 'implement'!
          const subRev1 = await stepSubmit(
            {
              runRoot,
              runId: 'step-v2-rework',
              leaseToken: s2Yield.leaseToken,
              verdict: {
                verdict: 'rework',
                summary: 'Add concurrency group to ci.yml',
                findings: [
                  { title: 'Missing concurrency', severity: 'medium', path: '.github/workflows/ci.yml', line: 1, evidence: 'No concurrency block' },
                ],
              },
              environment: handle.environment,
            },
            handle.ports,
          );
          assert.equal(subRev1.ok, true, subRev1.ok ? '' : JSON.stringify(subRev1.error));
          if (!subRev1.ok || subRev1.value.kind !== 'step') return;

          // 3. Re-yields 'implement' with rework findings!
          const s3Yield = subRev1.value;
          assert.equal(s3Yield.stepId, 'implement');
          assert.equal(s3Yield.rework?.count, 1);
          assert.match(s3Yield.prompt, /Missing concurrency/);

          await writeFile(join(s3Yield.candidateDir, '.github', 'workflows', 'ci.yml'), 'name: CI final\nconcurrency: ci\n', 'utf8');
          const sub2 = await stepSubmit(
            {
              runRoot,
              runId: 'step-v2-rework',
              leaseToken: s3Yield.leaseToken,
              status: 'completed',
              reason: 'addressed review',
              environment: handle.environment,
            },
            handle.ports,
          );
          assert.equal(sub2.ok, true, sub2.ok ? '' : JSON.stringify(sub2.error));
          if (!sub2.ok || sub2.value.kind !== 'step') return;

          // 4. Reviewer approves ('pass') -> run settles 'completed'!
          const s4Yield = sub2.value;
          assert.equal(s4Yield.stepId, 'review');
          const subRev2 = await stepSubmit(
            {
              runRoot,
              runId: 'step-v2-rework',
              leaseToken: s4Yield.leaseToken,
              verdict: {
                verdict: 'pass',
                summary: 'Looks great now',
                findings: [],
              },
              environment: handle.environment,
            },
            handle.ports,
          );
          assert.equal(subRev2.ok, true, subRev2.ok ? '' : JSON.stringify(subRev2.error));
          if (subRev2.ok) {
            assert.equal(subRev2.value.kind, 'result');
            if (subRev2.value.kind === 'result') {
              assert.equal(subRev2.value.result.spec.status, 'completed');
            }
          }
        } finally {
          if (prevSecret === undefined) delete process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV];
          else process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV] = prevSecret;
        }
      } finally {
        await handle.close();
      }
      void CANONICAL_TASKPACK_STEP_GATE_URL;
      void runActionCli;
    });
  });
});

describe('Command check authority, scrubbing, network isolation, base-dir caching, and decision error handling', () => {
  it('refuses per-check command.v1 mountReadOnlyGit: true in strict entrypoint and multi-tenant control plane', async () => {
    await withTempDir(async dir => {
      const repoRoot = join(dir, 'repo');
      const runRoot = join(dir, 'runs');
      await mkdir(join(repoRoot, '.loopwright', 'checks'), { recursive: true });
      await mkdir(join(repoRoot, 'docs'), { recursive: true });
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await writeFile(join(repoRoot, 'docs', 'a.txt'), 'ok\n', 'utf8');
      await writeFile(join(repoRoot, '.loopwright', 'checks', 'verify.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      const manifestObj = makeRuntimeManifest('mount-git-strict', {
        verification: { localChecks: [{ id: 'git-check', implementation: 'command.v1', parameters: { script: '.loopwright/checks/verify.sh', mountReadOnlyGit: true } }], externalGates: [] },
      });
      await writeFile(join(repoRoot, '.loopwright', 'taskpack.yaml'), serializePrettyYaml(manifestObj), 'utf8');
      const headSha = initGitRepo(repoRoot);

      const refused = await runGitHubActionEntrypoint({
        turnkey: true, repositoryRoot: repoRoot, repositoryId: 88, repositoryFullName: 'octocat/mount-git-strict',
        baseRevision: headSha, mode: 'no-change', eventName: 'workflow_dispatch', runRoot, runId: 'refuse-mount-git-1', env: {},
      });
      assert.equal(refused.kind, 'refused');
      if (refused.kind === 'refused') assert.equal(refused.code, 'TASKPACK_HOST_BINDING_INVALID');

      const validatedWithPriv = validateTaskpackV2Manifest(manifestObj as Json, { hostPolicy: { allowPrivileged: true } });
      assert.throws(() => assertMultiTenantManifestAuthority(validatedWithPriv), (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_HOST_BINDING_INVALID');
      await assert.rejects(() => startGitHubAppControlPlane({ webhookSecret: 'whsec_test_mount_git', manifest: validatedWithPriv }), (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_HOST_BINDING_INVALID');
    });
  });

  it('strips forbidden secrets from command.v1 gate.env & gate.envMap, populates openStagedTaskpackStepGate scrubber, and rethrows symlink TASKPACK_SCOPE_VIOLATION', async () => {
    await withTempDir(async dir => {
      const repoRoot = join(dir, 'repo');
      const runRoot = join(dir, 'runs');
      await mkdir(join(repoRoot, '.loopwright', 'checks'), { recursive: true });
      await mkdir(join(repoRoot, 'docs'), { recursive: true });
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await writeFile(join(repoRoot, 'docs', 'a.txt'), 'ok\n', 'utf8');

      const checkScript = `#!/bin/sh
set -eu
[ -z "\${TYPESAFE_API_KEY:-}" ] || { echo "TYPESAFE_API_KEY leaked"; exit 1; }
[ -z "\${NPM_TOKEN:-}" ] || { echo "NPM_TOKEN leaked"; exit 1; }
[ -z "\${AWS_SECRET_ACCESS_KEY:-}" ] || { echo "AWS_SECRET_ACCESS_KEY leaked"; exit 1; }
[ -z "\${SEC_GATE_SIGNING_SECRET:-}" ] || { echo "SEC_GATE_SIGNING_SECRET leaked"; exit 1; }
[ -z "\${CHECK_SECRET:-}" ] || { echo "CHECK_SECRET leaked"; exit 1; }
[ "\${SAFE_FLAG:-}" = "yes" ] || { echo "SAFE_FLAG missing"; exit 1; }
TOK="ts_live_secret_""value_987654321"
cat > "$LOOPWRIGHT_CHECK_OUT" <<EOF
{
  "detail": "saw decision token $TOK",
  "findings": [
    { "title": "Leak check", "severity": "low", "evidence": "evidence $TOK" }
  ]
}
EOF
exit 0
`;
      await writeFile(join(repoRoot, '.loopwright', 'checks', 'verify-env.sh'), checkScript, { mode: 0o755 });

      const manifestObj = {
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'Taskpack',
        metadata: { name: 'env-scrubber-test' },
        spec: {
          goal: { candidate: 'Update docs.', noChange: 'Verify docs.' },
          scope: { writable: ['docs/**'], protected: [] },
          upstreams: [],
          verification: {
            localChecks: [
              {
                id: 'env-check',
                implementation: 'command.v1',
                parameters: {
                  script: '.loopwright/checks/verify-env.sh',
                  env: { SAFE_FLAG: 'yes' },
                },
              },
            ],
            externalGates: [],
          },
          publication: { mode: 'disabled', targetBranch: 'main', headBranchPrefix: 'lw/', titleTemplate: 'chore: docs' },
          memory: { directory: '.loopwright/memory', apply: 'disabled', onNoModelBudget: 'deterministic-observations-only' },
          triggers: { schedule: true, workflowDispatch: true, releasePublished: false, commentCommands: [] },
        },
      };
      await writeFile(join(repoRoot, '.loopwright', 'taskpack.yaml'), serializePrettyYaml(manifestObj), 'utf8');
      initGitRepo(repoRoot);

      // 1A. Adversarial gate with forbidden env + envMap entries must fail closed at runtime (never leaks secrets)
      const stagedAdv = await stageTaskpackForStep({
        taskpackPath: '.loopwright/taskpack.yaml',
        repositoryRoot: repoRoot,
        runRoot,
        runId: 'step-scrub-adv',
        mode: 'candidate',
        discoverUpstreams: false,
        runtimeEnv: {
          TYPESAFE_API_KEY: 'ts_live_secret_value_987654321',
          NPM_TOKEN: 'npm_live_secret_12345',
          AWS_SECRET_ACCESS_KEY: 'aws_live_secret_12345',
          SEC_GATE_SIGNING_SECRET: 'gate_live_secret_12345',
          CHECK_SECRET: 'check_live_secret_12345',
        },
      });
      const baseGateAdv = stagedAdv.localCommandGates[0]!;
      const adversarialGate = {
        ...baseGateAdv,
        env: ['TYPESAFE_API_KEY', 'NPM_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'SEC_GATE_SIGNING_SECRET', 'CHECK_SECRET'],
        envMap: {
          TYPESAFE_API_KEY: 'forced-override',
          SEC_GATE_SIGNING_SECRET: 'forced-override-2',
          SAFE_FLAG: 'yes',
        },
      };
      const advSecretPath = join(stagedAdv.stageDir, 'secrets.json');
      const rawAdvSecrets = JSON.parse(await readFile(advSecretPath, 'utf8')) as { localCommandGates: unknown[] };
      rawAdvSecrets.localCommandGates = [adversarialGate];
      await writeFile(advSecretPath, JSON.stringify(rawAdvSecrets), { mode: 0o600 });

      const advStepGate = await openStagedTaskpackStepGate({
        runRoot,
        runId: 'step-scrub-adv',
        decisionApiKey: 'ts_live_secret_value_987654321',
        runtimeEnv: {
          TYPESAFE_API_KEY: 'ts_live_secret_value_987654321',
          NPM_TOKEN: 'npm_live_secret_12345',
          AWS_SECRET_ACCESS_KEY: 'aws_live_secret_12345',
          SEC_GATE_SIGNING_SECRET: 'gate_live_secret_12345',
          CHECK_SECRET: 'check_live_secret_12345',
        },
      });
      assert.notEqual(advStepGate, null);
      if (advStepGate === null) return;
      try {
        const prevSecret = process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV];
        process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV] = advStepGate.environment(DEFAULT_LOCAL_COMMAND_GATE_ENV);
        try {
          const loadedAdv = await loadTrustedConfiguration({
            configPath: stagedAdv.configPath,
            registryPath: stagedAdv.registryPath,
            registrySha256: stagedAdv.registrySha256,
            untrustedRoots: [repoRoot],
          });
          assert.equal(loadedAdv.ok, true);
          if (!loadedAdv.ok) return;
          const nextAdv = await stepNext(
            { configuration: loadedAdv.value, repository: repoRoot, runRoot, runId: 'step-scrub-adv', environment: advStepGate.environment },
            advStepGate.ports,
          );
          assert.equal(nextAdv.ok, true);
          if (!nextAdv.ok || nextAdv.value.kind !== 'step') return;
          await writeFile(join(nextAdv.value.candidateDir, 'docs', 'a.txt'), 'updated-adv\n', 'utf8');
          const subAdv = await stepSubmit(
            {
              runRoot,
              runId: 'step-scrub-adv',
              leaseToken: nextAdv.value.leaseToken,
              status: 'completed',
              reason: 'done',
              environment: advStepGate.environment,
            },
            advStepGate.ports,
          );
          assert.equal(subAdv.ok, true);
          assert.equal(subAdv.ok && subAdv.value.kind === 'step', true, 'forbidden gate.env/gate.envMap must deny check and trigger repair');
          if (subAdv.ok && subAdv.value.kind === 'step') {
            assert.match(subAdv.value.prompt, /forbidden env variable/i);
          }
        } finally {
          if (prevSecret === undefined) delete process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV];
          else process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV] = prevSecret;
        }
      } finally {
        await advStepGate.close();
      }

      // 1B. Clean gate under openStagedTaskpackStepGate passes AND scrubs decisionApiKey from LOOPWRIGHT_CHECK_OUT detail & findings
      const staged = await stageTaskpackForStep({
        taskpackPath: '.loopwright/taskpack.yaml',
        repositoryRoot: repoRoot,
        runRoot,
        runId: 'step-scrub-1',
        mode: 'candidate',
        discoverUpstreams: false,
        runtimeEnv: {
          TYPESAFE_API_KEY: 'ts_live_secret_value_987654321',
        },
      });

      const stepGate = await openStagedTaskpackStepGate({
        runRoot,
        runId: 'step-scrub-1',
        decisionApiKey: 'ts_live_secret_value_987654321',
        runtimeEnv: {
          TYPESAFE_API_KEY: 'ts_live_secret_value_987654321',
          NPM_TOKEN: 'npm_live_secret_12345',
          AWS_SECRET_ACCESS_KEY: 'aws_live_secret_12345',
          SEC_GATE_SIGNING_SECRET: 'gate_live_secret_12345',
          CHECK_SECRET: 'check_live_secret_12345',
        },
      });
      assert.notEqual(stepGate, null);
      if (stepGate === null) return;

      try {
        const prevSecret = process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV];
        process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV] = stepGate.environment(DEFAULT_LOCAL_COMMAND_GATE_ENV);
        try {
          const loadedCfg = await loadTrustedConfiguration({
            configPath: staged.configPath,
            registryPath: staged.registryPath,
            registrySha256: staged.registrySha256,
            untrustedRoots: [repoRoot],
          });
          assert.equal(loadedCfg.ok, true);
          if (!loadedCfg.ok) return;

          const nextStep = await stepNext(
            { configuration: loadedCfg.value, repository: repoRoot, runRoot, runId: 'step-scrub-1', environment: stepGate.environment },
            stepGate.ports,
          );
          assert.equal(nextStep.ok, true);
          if (!nextStep.ok || nextStep.value.kind !== 'step') return;

          await writeFile(join(nextStep.value.candidateDir, 'docs', 'a.txt'), 'updated\n', 'utf8');
          const sub = await stepSubmit(
            {
              runRoot,
              runId: 'step-scrub-1',
              leaseToken: nextStep.value.leaseToken,
              status: 'completed',
              reason: 'done',
              environment: stepGate.environment,
            },
            stepGate.ports,
          );
          assert.equal(sub.ok, true, sub.ok ? '' : JSON.stringify(sub.error));
          assert.equal(sub.ok && sub.value.kind === 'result', true);
          if (sub.ok && sub.value.kind === 'result') {
            assert.equal(sub.value.result.spec.status, 'completed');
            const checkOutcome = sub.value.result.spec.verification?.spec.required.find(r => r.checkId === 'env-check');
            assert.equal(checkOutcome?.status, 'passed');
            assert.equal(checkOutcome?.detail?.includes('ts_live_secret_value_987654321'), false, 'step gate must scrub decisionApiKey from detail');
            assert.equal(
              checkOutcome?.findings?.[0]?.evidence.includes('ts_live_secret_value_987654321'),
              false,
              'step gate must scrub decisionApiKey from findings',
            );
          }
        } finally {
          if (prevSecret === undefined) delete process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV];
          else process.env[DEFAULT_LOCAL_COMMAND_GATE_ENV] = prevSecret;
        }
      } finally {
        await stepGate.close();
      }

      // 2. Swapping .loopwright/taskpack.yaml with a symlink must rethrow TASKPACK_SCOPE_VIOLATION in openStagedTaskpackStepGate
      const decoyPath = join(dir, 'outside-taskpack.yaml');
      await writeFile(decoyPath, serializePrettyYaml(manifestObj), 'utf8');
      await rm(join(repoRoot, '.loopwright', 'taskpack.yaml'), { force: true });
      await symlink(decoyPath, join(repoRoot, '.loopwright', 'taskpack.yaml'));

      await assert.rejects(
        async () => {
          const leakedHandle = await openStagedTaskpackStepGate({
            runRoot,
            runId: 'step-scrub-1',
            runtimeEnv: {},
          });
          if (leakedHandle !== null) {
            await leakedHandle.close();
          }
        },
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_SCOPE_VIOLATION',
      );
    });
  });

  it('enforces command.v1 allowCheckNetwork at runtime (blocks outbound TCP in strict mode, allows when privileged allowCheckNetwork: true)', async () => {
    const canIsolateNet =
      (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) ||
      (process.platform === 'linux' && existsSync('/usr/bin/bwrap'));
    if (!canIsolateNet) return;

    await withTempDir(async dir => {
      let pingHits = 0;
      const probeServer = await startHttpServer((_req, res) => {
        pingHits += 1;
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('pong');
      });

      try {
        const makeRepoAndRun = async (allowNet: boolean, runId: string) => {
          const repoRoot = join(dir, `repo-${runId}`);
          const runRoot = join(dir, `runs-${runId}`);
          await mkdir(join(repoRoot, '.loopwright', 'checks'), { recursive: true });
          await mkdir(join(repoRoot, 'docs'), { recursive: true });
          await mkdir(runRoot, { recursive: true, mode: 0o700 });
          await writeFile(join(repoRoot, 'docs', 'a.txt'), 'ok\n', 'utf8');

          const probeScript = `#!/bin/sh
set -eu
"${process.execPath}" -e 'fetch(${JSON.stringify(`${probeServer.url}/ping`)}).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(2))'
`;
          await writeFile(join(repoRoot, '.loopwright', 'checks', 'net-check.sh'), probeScript, { mode: 0o755 });
          const manifestObj = makeRuntimeManifest(`net-${runId}`, {
            ...(allowNet ? { execution: { mode: 'privileged', capabilities: { allowCheckNetwork: true } } } : {}),
            verification: {
              localChecks: [{ id: 'net-check', implementation: 'command.v1', parameters: { script: '.loopwright/checks/net-check.sh', timeoutSeconds: 10 } }],
              externalGates: [],
            },
          });
          await writeFile(join(repoRoot, '.loopwright', 'taskpack.yaml'), serializePrettyYaml(manifestObj), 'utf8');
          const headSha = initGitRepo(repoRoot);

          return runGitHubActionEntrypoint({
            turnkey: true,
            repositoryRoot: repoRoot,
            repositoryId: 90,
            repositoryFullName: `octocat/net-${runId}`,
            baseRevision: headSha,
            mode: 'auto',
            allowPrivilegedExecution: allowNet,
            eventName: 'workflow_dispatch',
            runRoot,
            runId,
            env: {},
            openHostSessionAdapter: FAST_ADAPTER,
          });
        };

        // 1. Strict mode (allowCheckNetwork: false): network connection MUST be blocked by OS confinement
        const strictRes = await makeRepoAndRun(false, 'strict');
        assert.equal(strictRes.kind, 'no_change');
        if (strictRes.kind === 'no_change') {
          assert.equal(strictRes.delegateOutcome?.ok, false, 'strict command.v1 check must not reach loopback/outbound network');
        }
        assert.equal(pingHits, 0, 'strict command.v1 check must not hit local TCP server');

        // 2. Privileged mode with allowCheckNetwork: true + allowPrivilegedExecution: true: succeeds
        const privRes = await makeRepoAndRun(true, 'priv');
        assert.equal(privRes.kind, 'no_change');
        if (privRes.kind === 'no_change') {
          assert.equal(privRes.delegateOutcome?.ok, true, privRes.delegateOutcome?.detail ?? '');
        }
        assert.equal(pingHits, 1, 'privileged allowCheckNetwork: true command.v1 check should reach server');
      } finally {
        await probeServer.close();
      }
    });
  });

  it('short-circuits preflight no_change even with non-empty upstreams, compacts serializeActionResultSummary, and preserves stageTaskpackForStep preflight parity', async () => {
    await withTempDir(async dir => {
      const repoRoot = join(dir, 'repo');
      const runRoot = join(dir, 'runs');
      await mkdir(join(repoRoot, '.loopwright', 'scripts'), { recursive: true });
      await mkdir(join(repoRoot, '.loopwright', 'checks'), { recursive: true });
      await mkdir(join(repoRoot, 'docs'), { recursive: true });
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await writeFile(join(repoRoot, 'docs', 'a.txt'), 'ok\n', 'utf8');
      await writeFile(join(repoRoot, '.loopwright', 'checks', 'pass.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

      const preflightNoChange = `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({
  disposition: 'no_change',
  reason: 'maintenance window closed',
  upstreams: [{ id: 'pkg-core', status: 'available', version: '2.0.0', currentVersion: '1.0.0' }],
}), 'utf8');
`;
      await writeFile(join(repoRoot, '.loopwright', 'scripts', 'preflight.mjs'), preflightNoChange, { mode: 0o755 });

      let llmCalls = 0;
      const mockLlm = await startHttpServer((_req, res) => {
        llmCalls += 1;
        res.writeHead(500);
        res.end('should not be called');
      });

      try {
        const manifestObj = makeRuntimeManifest('preflight-nc', {
          preflight: { script: '.loopwright/scripts/preflight.mjs', timeoutSeconds: 15 },
          upstreams: [{ id: 'pkg-core', kind: 'github-release', source: 'octocat/pkg-core', watchedPaths: ['docs'] }],
          models: [{ provider: 'openai', id: 'gpt-5', thinking: 'medium', api: 'openai-completions', baseUrl: `${mockLlm.url}/v1`, apiKeyEnv: 'OPENAI_API_KEY' }],
          verification: {
            localChecks: [{ id: 'pass', implementation: 'command.v1', parameters: { script: '.loopwright/checks/pass.sh' } }],
            externalGates: [],
          },
        });
        await writeFile(join(repoRoot, '.loopwright', 'taskpack.yaml'), serializePrettyYaml(manifestObj), 'utf8');
        const headSha = initGitRepo(repoRoot);

        // 1. action.ts mode: 'auto' MUST short-circuit to no_change with ZERO LLM calls despite non-empty available upstreams
        const ncResult = await runGitHubActionEntrypoint({
          turnkey: true,
          repositoryRoot: repoRoot,
          repositoryId: 91,
          repositoryFullName: 'octocat/preflight-nc',
          baseRevision: headSha,
          mode: 'auto',
          allowManifestCustomBaseUrl: true,
          eventName: 'workflow_dispatch',
          runRoot,
          runId: 'preflight-nc-1',
          env: { OPENAI_API_KEY: 'sk_test_unused_123' },
          openHostSessionAdapter: FAST_ADAPTER,
        });
        assert.equal(ncResult.kind, 'no_change', JSON.stringify(ncResult));
        assert.equal(llmCalls, 0, 'preflight disposition no_change must not invoke LLM');
        if (ncResult.kind === 'no_change') {
          assert.equal(ncResult.reason, 'maintenance window closed');
          assert.ok(ncResult.taskpack !== undefined);
        }

        // 2. serializeActionResultSummary must summarize taskpack compactly for no_change (no raw config/registry ASTs)
        const summary = JSON.parse(serializeActionResultSummary(ncResult, new SecretScrubber())) as {
          kind: string;
          taskpack?: Record<string, unknown>;
        };
        assert.equal(summary.kind, 'no_change');
        assert.ok(summary.taskpack !== undefined);
        assert.equal('config' in (summary.taskpack ?? {}), false, 'summary must omit raw config AST');
        assert.equal('registry' in (summary.taskpack ?? {}), false, 'summary must omit raw registry AST');
        assert.equal(typeof summary.taskpack?.['configPath'], 'string');

        // 3. stageTaskpackForStep with runPreflight: true preserves preflight upstreams without running discoverTaskpackUpstreamsV2
        const stagedStep = await stageTaskpackForStep({
          taskpackPath: '.loopwright/taskpack.yaml',
          repositoryRoot: repoRoot,
          runRoot,
          runId: 'step-preflight-preserve',
          mode: 'candidate',
          runPreflight: true,
          discoverUpstreams: true,
          runtimeEnv: {},
        });
        const stagedRegistryText = await readFile(stagedStep.registryPath, 'utf8');
        assert.match(stagedRegistryText, /2\.0\.0/, 'stageTaskpackForStep must preserve preflight upstreams into compiled registry prompt');

        // 4. stageTaskpackForStep with runPreflight: true fails closed when preflight returns disposition: 'blocked'
        const preflightBlocked = `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(process.env.LOOPWRIGHT_PREFLIGHT_OUT, JSON.stringify({
  disposition: 'blocked',
  reason: 'upstream mirror offline',
}), 'utf8');
`;
        await writeFile(join(repoRoot, '.loopwright', 'scripts', 'preflight.mjs'), preflightBlocked, { mode: 0o755 });
        await assert.rejects(
          () => stageTaskpackForStep({
            taskpackPath: '.loopwright/taskpack.yaml',
            repositoryRoot: repoRoot,
            runRoot,
            runId: 'step-preflight-blocked',
            mode: 'candidate',
            runPreflight: true,
            runtimeEnv: {},
          }),
          (err: unknown) => err instanceof GitHubAppError && err.code === 'ACTION_INPUT_INVALID' && /blocked/.test(err.message),
        );
      } finally {
        await mockLlm.close();
      }
    });
  });

  it('enforces toolchainPaths multi-tenant & strict guards, caches baseDir across command.v1 checks, rethrows fatal DecisionErrors, and refuses OAuth or secret leaks in mode: auto', async () => {
    await withTempDir(async dir => {
      // 1. Multi-tenant service.ts rejects absolute host toolchainPaths
      const absToolchainManifest = validateTaskpackV2Manifest(makeRuntimeManifest('mt-toolchain', {
        verification: { localChecks: [{ id: 'tc', implementation: 'command.v1', parameters: { script: '.loopwright/checks/pass.sh', toolchainPaths: ['/usr/local/bin'] } }], externalGates: [] },
      }) as Json);
      assert.throws(
        () => assertMultiTenantManifestAuthority(absToolchainManifest),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_HOST_BINDING_INVALID',
      );

      // 2. Strict mode refuses tmpdir-rooted absolute toolchainPaths, while privileged mode allows it;
      //    plus two command.v1 checks in one run share the exact same cached LOOPWRIGHT_BASE_DIR!
      const repoRoot = join(dir, 'repo-tc');
      const runRoot = join(dir, 'runs-tc');
      const tmpToolchain = join(dir, 'tmp-bin');
      await mkdir(join(repoRoot, '.loopwright', 'checks'), { recursive: true });
      await mkdir(join(repoRoot, 'docs'), { recursive: true });
      await mkdir(runRoot, { recursive: true, mode: 0o700 });
      await mkdir(tmpToolchain, { recursive: true, mode: 0o755 });
      await writeFile(join(tmpToolchain, 'my-tmp-tool'), '#!/bin/sh\necho ok\n', { mode: 0o755 });
      await writeFile(join(repoRoot, 'docs', 'a.txt'), 'ok\n', 'utf8');

      const recordBaseDirScript = `#!/bin/sh
set -eu
cat > "$LOOPWRIGHT_CHECK_OUT" <<EOF
{ "metrics": { "base_dir": "$LOOPWRIGHT_BASE_DIR" } }
EOF
exit 0
`;
      await writeFile(join(repoRoot, '.loopwright', 'checks', 'check-a.sh'), recordBaseDirScript, { mode: 0o755 });
      await writeFile(join(repoRoot, '.loopwright', 'checks', 'check-b.sh'), recordBaseDirScript, { mode: 0o755 });

      const tcManifestObj = makeRuntimeManifest('tc-runtime', {
        verification: {
          localChecks: [
            { id: 'check-a', implementation: 'command.v1', parameters: { script: '.loopwright/checks/check-a.sh', toolchainPaths: [tmpToolchain] } },
            { id: 'check-b', implementation: 'command.v1', parameters: { script: '.loopwright/checks/check-b.sh', toolchainPaths: [tmpToolchain] } },
          ],
          externalGates: [],
        },
      });
      await writeFile(join(repoRoot, '.loopwright', 'taskpack.yaml'), serializePrettyYaml(tcManifestObj), 'utf8');
      const headSha = initGitRepo(repoRoot);

      // Strict mode denies tmpdir-rooted absolute toolchainPath
      const strictTcRes = await runGitHubActionEntrypoint({
        turnkey: true,
        repositoryRoot: repoRoot,
        repositoryId: 92,
        repositoryFullName: 'octocat/tc-runtime',
        baseRevision: headSha,
        mode: 'auto',
        allowPrivilegedExecution: false,
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'tc-strict',
        env: {},
        openHostSessionAdapter: FAST_ADAPTER,
      });
      assert.equal(strictTcRes.kind, 'no_change');
      if (strictTcRes.kind === 'no_change') {
        assert.equal(strictTcRes.delegateOutcome?.ok, false, 'strict mode must reject tmpdir-rooted absolute toolchainPath');
      }

      // Privileged mode succeeds AND both check-a and check-b observe the EXACT same cached LOOPWRIGHT_BASE_DIR!
      const privTcRes = await runGitHubActionEntrypoint({
        turnkey: true,
        repositoryRoot: repoRoot,
        repositoryId: 92,
        repositoryFullName: 'octocat/tc-runtime',
        baseRevision: headSha,
        mode: 'auto',
        allowPrivilegedExecution: true,
        eventName: 'workflow_dispatch',
        runRoot,
        runId: 'tc-priv',
        env: {},
        openHostSessionAdapter: FAST_ADAPTER,
      });
      assert.equal(privTcRes.kind, 'no_change');
      if (privTcRes.kind === 'no_change') {
        assert.equal(privTcRes.delegateOutcome?.ok, true, privTcRes.delegateOutcome?.detail ?? '');
      }
      const files = await readdir(runRoot, { recursive: true }).catch(() => [] as string[]);
      let baseDirA: string | undefined;
      let baseDirB: string | undefined;
      for (const f of files) {
        const full = join(runRoot, String(f));
        if (!full.includes('tc-priv')) continue;
        const st = await lstat(full).catch(() => null);
        if (!st?.isFile()) continue;
        const txt = await readFile(full, 'utf8').catch(() => '');
        if (!txt.includes('"kind":"RunResult"') && !txt.includes('"kind": "RunResult"')) continue;
        const parsed = JSON.parse(txt) as {
          spec?: { verification?: { spec?: { required?: { checkId: string; metrics?: Record<string, unknown> }[] } } };
        };
        for (const req of parsed.spec?.verification?.spec?.required ?? []) {
          if (req.checkId === 'check-a' && typeof req.metrics?.['base_dir'] === 'string') {
            baseDirA = req.metrics['base_dir'];
          }
          if (req.checkId === 'check-b' && typeof req.metrics?.['base_dir'] === 'string') {
            baseDirB = req.metrics['base_dir'];
          }
        }
      }
      assert.ok(baseDirA !== undefined && baseDirA.length > 0, 'expected check-a to report LOOPWRIGHT_BASE_DIR');
      assert.equal(baseDirA, baseDirB, 'expected check-a and check-b to share the exact same cached read-only baseDir');

      // 3. createTaskpackDecisionPort: rethrows fatal policy/authority DecisionErrors and aligns adviseSoftCompaction < 0.6 fallback
      const validDecisionManifest = validateTaskpackV2Manifest(makeRuntimeManifest('dec-fatal', {
        decisions: {
          enabled: true, provider: 'typesafe-jev', disclosurePolicy: 'public-metadata-only',
          minConfidence: 0.8, confirmThreshold: 0.6, hardDeadlineMs: 1_500, maxAttempts: 1,
          triageRules: [{ id: 'r1', description: 'rule 1', severity: 'blocking', kind: 'noul' }],
        },
      }) as Json);
      const invalidPolicyManifest = {
        ...validDecisionManifest,
        spec: {
          ...validDecisionManifest.spec,
          decisions: {
            ...validDecisionManifest.spec.decisions!,
            minConfidence: 0.5,
            confirmThreshold: 0.9,
          },
        },
      };
      const fatalPolicyPort = createTaskpackDecisionPort(invalidPolicyManifest, {
        apiKey: 'jev_test_key_123',
        transport: {
          send: async () => ({ status: 200, body: '{}' }),
        },
      });
      assert.ok(fatalPolicyPort !== undefined);
      await assert.rejects(
        () => fatalPolicyPort!.routeCapabilityTier!({
          runId: 'r1',
          stepId: 's1',
          roleId: 'author',
          taskKind: 'task',
          estimatedFilesCount: 3,
          hasFailingTests: false,
          requiresArchitectureChange: false,
          candidateSkills: [],
          pinnedModel: { provider: 'openai', model: 'gpt-5', thinking: 'medium' },
        }),
        (err: unknown) => err instanceof DecisionError && err.code === 'DECISION_POLICY_INVALID',
      );

      const transientPort = createTaskpackDecisionPort(validDecisionManifest, {
        apiKey: 'jev_test_key_123',
        transport: {
          send: async () => {
            throw new Error('network reset');
          },
        },
      });
      assert.ok(transientPort !== undefined);
      const lowUtilRes = await transientPort!.adviseSoftCompaction!({
        runId: 'r1',
        stepId: 's1',
        roleId: 'author',
        contextUtilization: 0.4,
        failedVerificationLoops: 0,
      });
      assert.notEqual(lowUtilRes, null);
      assert.equal(lowUtilRes?.advisoryDecision, null, 'contextUtilization < 0.6 fallback must return null advisoryDecision');
      assert.equal(lowUtilRes?.hardTriggerActive, false);

      // 4. isAutoNoChange: refuses PROVIDER_OAUTH_UNSUPPORTED instead of swallowing or converting to blocked,
      //    and rejects leaked secrets inside instructionResources via assertCleanArtifact
      const oauthRepo = join(dir, 'repo-oauth');
      const oauthRuns = join(dir, 'runs-oauth');
      await mkdir(join(oauthRepo, '.loopwright', 'prompts'), { recursive: true });
      await mkdir(join(oauthRepo, '.loopwright', 'checks'), { recursive: true });
      await mkdir(join(oauthRepo, 'docs'), { recursive: true });
      await mkdir(oauthRuns, { recursive: true, mode: 0o700 });
      await writeFile(join(oauthRepo, 'docs', 'a.txt'), 'ok\n', 'utf8');
      await writeFile(join(oauthRepo, '.loopwright', 'prompts', 'inst.md'), 'Normal instructions.\n', 'utf8');
      await writeFile(join(oauthRepo, '.loopwright', 'checks', 'pass.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      await writeFile(
        join(oauthRepo, '.loopwright', 'taskpack.yaml'),
        serializePrettyYaml(makeRuntimeManifest('oauth-nc', {
          instructions: ['.loopwright/prompts/inst.md'],
          models: [{ provider: 'openai-codex', id: 'gpt-5.4' }],
          verification: { localChecks: [{ id: 'pass', implementation: 'command.v1', parameters: { script: '.loopwright/checks/pass.sh' } }], externalGates: [] },
        })),
        'utf8',
      );
      const oauthSha = initGitRepo(oauthRepo);

      const oauthRes = await runGitHubActionEntrypoint({
        turnkey: true,
        repositoryRoot: oauthRepo,
        repositoryId: 93,
        repositoryFullName: 'octocat/oauth-nc',
        baseRevision: oauthSha,
        mode: 'auto',
        eventName: 'workflow_dispatch',
        runRoot: oauthRuns,
        runId: 'oauth-nc-1',
        env: {},
      });
      assert.equal(oauthRes.kind, 'refused');
      if (oauthRes.kind === 'refused') {
        assert.equal(oauthRes.code, 'PROVIDER_OAUTH_UNSUPPORTED');
      }

      // Now switch to standard openai model and embed a registered secret in instructions -> assertCleanArtifact triggers
      await writeFile(
        join(oauthRepo, '.loopwright', 'prompts', 'inst.md'),
        'Leaked key: sk_live_instruction_leak_999888777\n',
        'utf8',
      );
      await writeFile(
        join(oauthRepo, '.loopwright', 'taskpack.yaml'),
        serializePrettyYaml(makeRuntimeManifest('leak-nc', {
          instructions: ['.loopwright/prompts/inst.md'],
          verification: { localChecks: [{ id: 'pass', implementation: 'command.v1', parameters: { script: '.loopwright/checks/pass.sh' } }], externalGates: [] },
        })),
        'utf8',
      );
      const leakSha = initGitRepo(oauthRepo);
      await assert.rejects(
        () => runGitHubActionEntrypoint({
          turnkey: true,
          repositoryRoot: oauthRepo,
          repositoryId: 94,
          repositoryFullName: 'octocat/leak-nc',
          baseRevision: leakSha,
          mode: 'auto',
          eventName: 'workflow_dispatch',
          runRoot: oauthRuns,
          runId: 'leak-nc-1',
          env: { OPENAI_API_KEY: 'sk_live_instruction_leak_999888777' },
        }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TOKEN_SECRET_LEAK_DETECTED',
      );
    });
  });
});
