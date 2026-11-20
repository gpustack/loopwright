import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isWritablePath } from '@loopwright/core';
import {
  GitHubAppError,
  MAX_TASKPACK_ROLES,
  MAX_TASKPACK_STEPS,
  PROTECTED_AUTOMATION_PATHS,
  type TaskpackExecutionDeclaration,
  type UpstreamAcquisitionStatus,
} from '../src/types.js';
import {
  assertManifestScopeInvariants,
  effectiveProtectedPaths,
  parseTaskpackDocument,
  resolveExecutionCapabilities,
  validateExecutionAuthority,
  validateTaskpackManifest,
  validateTaskpackV2Manifest,
  type Json,
} from '../src/schema.js';

function makeBaseV2Manifest(specOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'Taskpack',
    metadata: { name: 'demo-v2-sync' },
    spec: {
      goal: {
        candidate: 'Sync dependencies and docs cleanly.',
        noChange: 'Verify repository invariants when no upstream changed.',
      },
      scope: {
        writable: ['package.json', 'packages/*/package.json', 'docs/**'],
        protected: ['.loopwright/checks/**'],
      },
      upstreams: [
        {
          id: 'pkg-a',
          kind: 'http-json',
          source: 'https://registry.npmjs.org/@scope/pkg-a',
          watchedPaths: ['package.json'],
          versionPath: 'dist-tags.latest',
          monotonicSemver: true,
        },
        {
          id: 'pkg-b',
          kind: 'http-json',
          source: 'https://registry.npmjs.org/@scope/pkg-b',
          watchedPaths: ['package.json'],
          versionPath: '$.dist-tags["latest"]',
          monotonicSemver: true,
        },
      ],
      verification: {
        localChecks: [
          {
            id: 'verify-build',
            implementation: 'command.v1',
            parameters: {
              script: '.loopwright/checks/verify.sh',
              args: ['--strict'],
              timeoutSeconds: 120,
              toolchainPaths: ['/usr/local/bin', '.loopwright/checks/bin'],
              preserveRepoDirName: true,
              mountReadOnlyGit: false,
              env: { TARGET_MODE: 'ci' },
            },
          },
          {
            id: 'guard-pkg',
            implementation: 'json-keys-guard.v1',
            parameters: {
              path: 'package.json',
              allowedPointers: ['/dependencies', '/devDependencies'],
            },
          },
          {
            id: 'guard-readme',
            implementation: 'line-section-guard.v1',
            parameters: {
              path: 'docs/README.md',
              startMarker: '<!-- AUTO-SYNC:START -->',
              endMarker: '<!-- AUTO-SYNC:END -->',
            },
          },
        ],
        externalGates: [],
      },
      publication: {
        mode: 'pull_request',
        targetBranch: 'main',
        headBranchPrefix: 'auto-sync/',
        titleTemplate: 'chore(sync): update packages',
      },
      memory: {
        directory: '.loopwright/memory/demo',
        apply: 'local-only',
        onNoModelBudget: 'deterministic-observations-only',
      },
      triggers: {
        schedule: true,
        workflowDispatch: true,
        releasePublished: false,
        commentCommands: ['retry', 'status'],
      },
      ...specOverrides,
    },
  };
}

describe('Taskpack 2.0 schema: execution trust modes and dual-key authority', () => {
  it('resolves strict and privileged default capabilities with workflow writes and agent network false in both', () => {
    const strictCaps = resolveExecutionCapabilities('strict');
    assert.deepEqual(strictCaps, {
      allowHostEnv: false,
      allowHostPath: false,
      mountReadOnlyGit: false,
      allowCheckNetwork: false,
      allowWorkflowWrites: false,
      allowAgentNetwork: false,
    });

    const privilegedCaps = resolveExecutionCapabilities('privileged');
    assert.deepEqual(privilegedCaps, {
      allowHostEnv: true,
      allowHostPath: true,
      mountReadOnlyGit: true,
      allowCheckNetwork: true,
      allowWorkflowWrites: false,
      allowAgentNetwork: false,
    });
  });

  it('defaults omitted spec.execution to strict mode and sets default digests lockfile when pinDigests is true', () => {
    const manifestDefault = validateTaskpackV2Manifest(makeBaseV2Manifest() as Json);
    assert.equal(manifestDefault.spec.execution?.mode, 'strict');
    assert.equal(manifestDefault.spec.execution?.capabilities.allowHostEnv, false);
    assert.equal(manifestDefault.spec.execution?.digests.pinDigests, false);
    assert.equal(manifestDefault.spec.execution?.digests.lockfile, undefined);

    const manifestPinned = validateTaskpackV2Manifest(
      makeBaseV2Manifest({
        execution: {
          mode: 'privileged',
          digests: { pinDigests: true },
        },
        scope: {
          writable: ['package.json', 'packages/*/package.json', 'docs/**'],
          protected: ['.auto-sync/checks/**'],
        },
        verification: {
          localChecks: [
            {
              id: 'verify-build',
              implementation: 'command.v1',
              parameters: { script: '.auto-sync/checks/verify.sh' },
            },
          ],
          externalGates: [],
        },
        memory: {
          directory: '.auto-sync/memory/demo',
          apply: 'local-only',
          onNoModelBudget: 'deterministic-observations-only',
        },
      }) as Json,
      { controlRoot: '.auto-sync', hostPolicy: { allowPrivileged: true } },
    );
    assert.equal(manifestPinned.spec.execution?.mode, 'privileged');
    assert.equal(manifestPinned.spec.execution?.capabilities.allowHostEnv, true);
    assert.equal(manifestPinned.spec.execution?.capabilities.allowHostPath, true);
    assert.equal(manifestPinned.spec.execution?.capabilities.mountReadOnlyGit, true);
    assert.equal(manifestPinned.spec.execution?.capabilities.allowCheckNetwork, true);
    assert.equal(manifestPinned.spec.execution?.capabilities.allowWorkflowWrites, false);
    assert.equal(manifestPinned.spec.execution?.capabilities.allowAgentNetwork, false);
    assert.equal(manifestPinned.spec.execution?.digests.pinDigests, true);
    assert.equal(manifestPinned.spec.execution?.digests.lockfile, '.auto-sync/digests.lock.json');
  });

  it('enforces dual-key host authorization via validateExecutionAuthority', () => {
    const strictDefault: TaskpackExecutionDeclaration = {
      mode: 'strict',
      capabilities: resolveExecutionCapabilities('strict'),
      digests: { pinDigests: false },
    };
    assert.doesNotThrow(() => validateExecutionAuthority(strictDefault));
    assert.doesNotThrow(() => validateExecutionAuthority(undefined));

    const privilegedDefault: TaskpackExecutionDeclaration = {
      mode: 'privileged',
      capabilities: resolveExecutionCapabilities('privileged'),
      digests: { pinDigests: false },
    };
    assert.throws(
      () => validateExecutionAuthority(privilegedDefault, {}),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_HOST_BINDING_INVALID',
    );
    assert.doesNotThrow(() => validateExecutionAuthority(privilegedDefault, { allowPrivileged: true }));

    const workflowWritesStrict: TaskpackExecutionDeclaration = {
      mode: 'strict',
      capabilities: resolveExecutionCapabilities('strict', { allowWorkflowWrites: true }),
      digests: { pinDigests: false },
    };
    assert.throws(
      () => validateExecutionAuthority(workflowWritesStrict, { allowPrivileged: true }),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_SCOPE_VIOLATION',
    );
    assert.doesNotThrow(() => validateExecutionAuthority(workflowWritesStrict, { allowWorkflowWrites: true }));

    const privilegedWithWorkflows: TaskpackExecutionDeclaration = {
      mode: 'privileged',
      capabilities: resolveExecutionCapabilities('privileged', { allowWorkflowWrites: true }),
      digests: { pinDigests: false },
    };
    assert.throws(
      () => validateExecutionAuthority(privilegedWithWorkflows, { allowPrivileged: true }),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_SCOPE_VIOLATION',
    );
    assert.throws(
      () => validateExecutionAuthority(privilegedWithWorkflows, { allowWorkflowWrites: true }),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_HOST_BINDING_INVALID',
    );
    assert.doesNotThrow(() => validateExecutionAuthority(privilegedWithWorkflows, { allowPrivileged: true, allowWorkflowWrites: true }));

    const strictEscalation: TaskpackExecutionDeclaration = {
      mode: 'strict',
      capabilities: resolveExecutionCapabilities('strict', { allowHostEnv: true }),
      digests: { pinDigests: false },
    };
    assert.throws(
      () => validateExecutionAuthority(strictEscalation, {}),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_HOST_BINDING_INVALID',
    );
  });
});

describe('Taskpack 2.0 schema: post-parse spec.vars AST validation & interpolation', () => {
  it('interpolates declared spec.vars in permitted fields across YAML and JSON manifests', () => {
    const yamlText = `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: vars-demo
spec:
  vars:
    NODE_TARGET: "26"
    RELEASE_CHANNEL: stable
    SECTION_TAG: AUTO-DEPS
    EXTRA_ENV: CUSTOM_FLAG
  goal:
    candidate: "Upgrade to Node \${NODE_TARGET} (\${RELEASE_CHANNEL})"
    noChange: "Verify Node \${NODE_TARGET} invariants"
  scope:
    writable:
      - docs/**
      - package.json
    protected:
      - .loopwright/checks/**
  preflight:
    script: .loopwright/checks/preflight.mjs
    timeoutSeconds: 60
    env:
      - \${EXTRA_ENV}
  upstreams:
    - id: core
      kind: http-json
      source: https://example.com/releases.json
      watchedPaths:
        - package.json
  verification:
    localChecks:
      - id: verify
        implementation: command.v1
        parameters:
          script: .loopwright/checks/verify.sh
          args:
            - "--node=\${NODE_TARGET}"
            - "--channel=\${RELEASE_CHANNEL}"
          env:
            TARGET_NODE: "\${NODE_TARGET}"
      - id: readme-guard
        implementation: line-section-guard.v1
        parameters:
          path: docs/README.md
          startMarker: "<!-- \${SECTION_TAG}:START -->"
          endMarker: "<!-- \${SECTION_TAG}:END -->"
    externalGates: []
  roles:
    - id: implementer
      provider: openai
      model: gpt-5
      prompt: "Target Node \${NODE_TARGET} on \${RELEASE_CHANNEL}"
  publication:
    mode: pull_request
    targetBranch: main
    headBranchPrefix: sync/
    titleTemplate: "chore: sync node-\${NODE_TARGET} (\${RELEASE_CHANNEL})"
    bodyTemplate: "Updated for \${RELEASE_CHANNEL} channel."
  memory:
    directory: .loopwright/memory/vars
    apply: local-only
    onNoModelBudget: skip
  triggers:
    schedule: false
    workflowDispatch: true
    releasePublished: false
    commentCommands: []
`;
    const parsed = parseTaskpackDocument(Buffer.from(yamlText, 'utf8'), 'yaml');
    const manifest = validateTaskpackV2Manifest(parsed);
    assert.equal(manifest.spec.goal.candidate, 'Upgrade to Node 26 (stable)');
    assert.equal(manifest.spec.goal.noChange, 'Verify Node 26 invariants');
    assert.equal(manifest.spec.publication.titleTemplate, 'chore: sync node-26 (stable)');
    assert.equal(manifest.spec.publication.bodyTemplate, 'Updated for stable channel.');
    assert.deepEqual(manifest.spec.preflight?.env, ['CUSTOM_FLAG']);
    assert.equal(manifest.spec.roles?.[0]?.prompt, 'Target Node 26 on stable');
    assert.deepEqual(manifest.spec.verification.localChecks[0]?.parameters?.['args'], ['--node=26', '--channel=stable']);
    const checkEnv = manifest.spec.verification.localChecks[0]?.parameters?.['env'];
    assert.equal(Object.getPrototypeOf(checkEnv), null);
    assert.deepEqual({ ...(checkEnv as Record<string, string>) }, { TARGET_NODE: '26' });
    assert.equal(manifest.spec.verification.localChecks[1]?.parameters?.['startMarker'], '<!-- AUTO-DEPS:START -->');
  });

  it('refuses undeclared vars, nested var references, and vars in disallowed fields with TASKPACK_UNTRUSTED_INTERPOLATION', () => {
    const undeclared = makeBaseV2Manifest({
      vars: { SAFE_VAR: 'ok' },
      publication: {
        mode: 'pull_request',
        targetBranch: 'main',
        headBranchPrefix: 'sync/',
        titleTemplate: 'chore: ${UNDECLARED_VAR}',
      },
    });
    assert.throws(
      () => parseTaskpackDocument(Buffer.from(JSON.stringify(undeclared), 'utf8'), 'json'),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_UNTRUSTED_INTERPOLATION',
    );
    assert.throws(
      () => validateTaskpackV2Manifest(undeclared as Json),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_UNTRUSTED_INTERPOLATION',
    );

    const nestedVar = makeBaseV2Manifest({
      vars: { FIRST: 'a', SECOND: '${FIRST}' },
    });
    assert.throws(
      () => validateTaskpackV2Manifest(nestedVar as Json),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_UNTRUSTED_INTERPOLATION',
    );

    const disallowedTargets: Array<Record<string, unknown>> = [
      { vars: { DIR: 'docs' }, scope: { writable: ['${DIR}/**'], protected: [] } },
      { vars: { MODE: 'privileged' }, execution: { mode: '${MODE}' } },
      { vars: { SCRIPT: '.loopwright/checks/pre.sh' }, preflight: { script: '${SCRIPT}' } },
      {
        vars: { SCRIPT: '.loopwright/checks/verify.sh' },
        verification: {
          localChecks: [{ id: 'cmd', implementation: 'command.v1', parameters: { script: '${SCRIPT}' } }],
          externalGates: [],
        },
      },
      {
        vars: { BIN: '/usr/local/bin' },
        verification: {
          localChecks: [{
            id: 'cmd',
            implementation: 'command.v1',
            parameters: { script: '.loopwright/checks/verify.sh', toolchainPaths: ['${BIN}'] },
          }],
          externalGates: [],
        },
      },
      {
        vars: { CRED: 'SIGNING_REF' },
        verification: {
          localChecks: [],
          externalGates: [{ id: 'ext', gateId: 'g1', endpointId: 'ep1', required: true, signingCredentialRef: '${CRED}' }],
        },
      },
      {
        vars: { CMD: 'node' },
        mcp: { servers: [{ id: 'docs', transport: 'stdio', command: '${CMD}' }] },
      },
    ];
    for (const override of disallowedTargets) {
      const doc = makeBaseV2Manifest(override);
      assert.throws(
        () => parseTaskpackDocument(Buffer.from(JSON.stringify(doc), 'utf8'), 'json'),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_UNTRUSTED_INTERPOLATION',
      );
      assert.throws(
        () => validateTaskpackV2Manifest(doc as Json),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_UNTRUSTED_INTERPOLATION',
      );
    }
  });

  it('rejects secret-like keys and values in spec.vars and handles null-prototype objects', () => {
    const secretKeyDoc = makeBaseV2Manifest({ vars: { MY_API_KEY: 'abc' } });
    assert.throws(
      () => validateTaskpackV2Manifest(secretKeyDoc as Json),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );

    const secretValDoc = makeBaseV2Manifest({ vars: { LABEL: 'ghp_1234567890abcdef1234567890' } });
    assert.throws(
      () => validateTaskpackV2Manifest(secretValDoc as Json),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );

    const nullProtoVars = Object.assign(Object.create(null) as Record<string, string>, { TAG: 'v2' });
    const nullProtoDoc = Object.assign(Object.create(null) as Record<string, unknown>, makeBaseV2Manifest({ vars: nullProtoVars }));
    const validated = validateTaskpackV2Manifest(nullProtoDoc as Json);
    assert.equal(validated.spec.vars?.['TAG'], 'v2');
  });

  it('still rejects ${...} in non-Taskpack documents passed to parseTaskpackDocument', () => {
    assert.throws(
      () => parseTaskpackDocument(Buffer.from('{"apiVersion":"loopwright.dev/v1alpha1","note":"${SECRET}"}', 'utf8'), 'json'),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_UNTRUSTED_INTERPOLATION',
    );
  });
});

describe('Taskpack 2.0 schema: preflight, upstreamGroups, held_back, steps DAG, roles, limits, matrix, guards', () => {
  it('supports up to 16 roles and 16 interleaved steps with rejectTo rework and per-role isolation', () => {
    assert.equal(MAX_TASKPACK_ROLES, 16);
    assert.equal(MAX_TASKPACK_STEPS, 16);

    const statusCheck: UpstreamAcquisitionStatus = 'held_back';
    assert.equal(statusCheck, 'held_back');

    const manifest = validateTaskpackV2Manifest(makeBaseV2Manifest({
      instructions: ['.loopwright/instructions/shared.md'],
      skills: ['.agents/skills/shared/SKILL.md'],
      mcp: {
        servers: [
          { id: 'docs-mcp', transport: 'stdio', command: 'npx', args: ['-y', 'docs-mcp'] },
          { id: 'write-mcp', transport: 'stdio', command: 'npx', args: ['-y', 'write-mcp'] },
        ],
      },
      roles: [
        {
          id: 'planner',
          purpose: 'task',
          provider: 'openai',
          model: 'gpt-5',
          instructions: ['.loopwright/instructions/plan.md'],
          skills: ['.agents/skills/plan/SKILL.md'],
          mcpServers: ['docs-mcp'],
          models: ['openai/gpt-5', 'anthropic/claude-sonnet-4'],
        },
        {
          id: 'implementer',
          purpose: 'task',
          provider: 'openai',
          model: 'gpt-5',
          mcpServers: ['docs-mcp', 'write-mcp'],
        },
        {
          id: 'reviewer',
          purpose: 'review',
          provider: 'anthropic',
          model: 'claude-sonnet-4',
          instructions: ['.loopwright/instructions/review.md'],
        },
      ],
      steps: [
        { id: 'plan', kind: 'agent', role: 'planner', dependsOn: [] },
        { id: 'implement', kind: 'agent', role: 'implementer', dependsOn: ['plan'] },
        { id: 'compact-impl', kind: 'compact', role: 'implementer', dependsOn: ['implement'] },
        { id: 'fast-check', kind: 'check', check: 'verify-build', dependsOn: ['compact-impl'] },
        {
          id: 'review',
          kind: 'agent',
          role: 'reviewer',
          dependsOn: ['fast-check'],
          onRework: { rejectTo: 'implement', maxReworks: 3 },
        },
      ],
      upstreamGroups: [
        { id: 'pi-lockstep', members: ['pkg-a', 'pkg-b'], policy: 'lockstep' },
      ],
      submission: { path: 'docs/submission.json', required: true },
      target: {
        matrix: [
          { id: 'linux-arm64', platform: 'linux-arm64', variant: 'default' },
        ],
      },
      limits: {
        overlay: { maxFiles: 512, maxBytes: 16_777_216 },
      },
      decisions: {
        enabled: true,
        provider: 'typesafe-jev',
        triageRules: [
          { id: 'check-lockfile', description: 'Flag unexpected lockfile churn', severity: 'important', kind: 'noul', threshold: 0.85 },
          { id: 'check-tests', description: 'Score test coverage', severity: 'blocking', kind: 'score' },
        ],
      },
      verification: {
        localChecks: [
          {
            id: 'verify-build',
            implementation: 'command.v1',
            parameters: { script: '.loopwright/checks/verify.sh' },
          },
          {
            id: 'guard-pkg',
            implementation: 'json-keys-guard.v1',
            parameters: { path: 'package.json', allowedPointers: ['/dependencies'] },
          },
          {
            id: 'guard-readme',
            implementation: 'line-section-guard.v1',
            parameters: { path: 'docs/README.md', startMarker: 'BEGIN', endMarker: 'END' },
          },
        ],
        externalGates: [
          {
            id: 'remote-ci',
            gateId: 'ci-gate',
            endpointId: 'ci-endpoint',
            required: true,
            url: 'https://ci.example.com/gate',
            signingCredentialRef: 'CI_SIGNING_SECRET',
            authCredentialRef: 'CI_AUTH_TOKEN',
          },
        ],
      },
    }) as Json);

    assert.equal(manifest.spec.proposal, undefined);
    assert.deepEqual(manifest.spec.submission, { path: 'docs/submission.json', required: true });
    assert.deepEqual(manifest.spec.roles?.[2]?.mcpServers, []);
    assert.deepEqual(manifest.spec.limits?.overlay, { maxFiles: 512, maxBytes: 16_777_216 });
    assert.equal(manifest.spec.steps?.length, 5);
    assert.deepEqual(manifest.spec.steps?.[4]?.onRework, { rejectTo: 'implement', maxReworks: 3 });
    assert.equal(manifest.spec.upstreamGroups?.[0]?.policy, 'lockstep');
    assert.equal(manifest.spec.target?.matrix?.[0]?.id, 'linux-arm64');
    assert.equal(manifest.spec.decisions?.triageRules?.length, 2);
    assert.equal(manifest.spec.verification.externalGates[0]?.signingCredentialRef, 'CI_SIGNING_SECRET');
  });

  it('validates steps onRework strict-ancestor, maxReworks 1..8, DAG cycles, and compact constraints', () => {
    const roles = [
      { id: 'r1', provider: 'openai', model: 'gpt-5' },
      { id: 'r2', provider: 'openai', model: 'gpt-5' },
    ];

    // Self-rejectTo rejected
    assert.throws(
      () => validateTaskpackV2Manifest(makeBaseV2Manifest({
        roles,
        steps: [
          { id: 's1', kind: 'agent', role: 'r1', dependsOn: [], onRework: { rejectTo: 's1', maxReworks: 1 } },
        ],
      }) as Json),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );

    // Sibling rejectTo rejected
    assert.throws(
      () => validateTaskpackV2Manifest(makeBaseV2Manifest({
        roles,
        steps: [
          { id: 's1', kind: 'agent', role: 'r1', dependsOn: [] },
          { id: 's2', kind: 'agent', role: 'r2', dependsOn: [], onRework: { rejectTo: 's1', maxReworks: 2 } },
        ],
      }) as Json),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );

    // maxReworks out of 1..8 rejected
    for (const bad of [0, 9, 1.5]) {
      assert.throws(
        () => validateTaskpackV2Manifest(makeBaseV2Manifest({
          roles,
          steps: [
            { id: 's1', kind: 'agent', role: 'r1', dependsOn: [] },
            { id: 's2', kind: 'agent', role: 'r2', dependsOn: ['s1'], onRework: { rejectTo: 's1', maxReworks: bad } },
          ],
        }) as Json),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
      );
    }

    // Cycle rejected
    assert.throws(
      () => validateTaskpackV2Manifest(makeBaseV2Manifest({
        roles,
        steps: [
          { id: 's1', kind: 'agent', role: 'r1', dependsOn: ['s2'] },
          { id: 's2', kind: 'agent', role: 'r2', dependsOn: ['s1'] },
        ],
      }) as Json),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );

    // Compact without same-role agent ancestor rejected
    assert.throws(
      () => validateTaskpackV2Manifest(makeBaseV2Manifest({
        roles,
        steps: [
          { id: 's1', kind: 'agent', role: 'r1', dependsOn: [] },
          { id: 'c1', kind: 'compact', role: 'r2', dependsOn: ['s1'] },
        ],
      }) as Json),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );

    // Compact under delegated executionMode rejected
    assert.throws(
      () => validateTaskpackV2Manifest(
        makeBaseV2Manifest({
          roles,
          steps: [
            { id: 's1', kind: 'agent', role: 'r1', dependsOn: [] },
            { id: 'c1', kind: 'compact', role: 'r1', dependsOn: ['s1'] },
          ],
        }) as Json,
        { executionMode: 'delegated' },
      ),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );
  });

  it('rejects duplicate lockstep upstream membership, unknown mcpServers, and invalid overlay limits', () => {
    assert.throws(
      () => validateTaskpackV2Manifest(makeBaseV2Manifest({
        upstreamGroups: [
          { id: 'g1', members: ['pkg-a'], policy: 'lockstep' },
          { id: 'g2', members: ['pkg-a', 'pkg-b'], policy: 'lockstep' },
        ],
      }) as Json),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );

    assert.throws(
      () => validateTaskpackV2Manifest(makeBaseV2Manifest({
        roles: [{ id: 'r1', provider: 'openai', model: 'gpt-5', mcpServers: ['undeclared-mcp'] }],
      }) as Json),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );

    assert.throws(
      () => validateTaskpackV2Manifest(makeBaseV2Manifest({
        limits: { overlay: { maxFiles: 5000 } },
      }) as Json),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );
  });

  it('enforces 16-role / 16-step limits, preflight scope/env guards, upstream versionPath guards, and check parameter validation', () => {
    // 16 roles and 16 steps succeed; 17 fail
    const sixteenRoles = Array.from({ length: 16 }, (_, i) => ({ id: `role-${i}`, provider: 'openai', model: 'gpt-5' }));
    const sixteenSteps = Array.from({ length: 16 }, (_, i) => ({
      id: `step-${i}`,
      kind: 'agent',
      role: `role-${i}`,
      dependsOn: i === 0 ? [] : [`step-${i - 1}`],
    }));
    const maxed = validateTaskpackV2Manifest(makeBaseV2Manifest({ roles: sixteenRoles, steps: sixteenSteps }) as Json);
    assert.equal(maxed.spec.roles?.length, 16);
    assert.equal(maxed.spec.steps?.length, 16);

    assert.throws(
      () => validateTaskpackV2Manifest(makeBaseV2Manifest({
        roles: [...sixteenRoles, { id: 'role-16', provider: 'openai', model: 'gpt-5' }],
      }) as Json),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );
    assert.throws(
      () => validateTaskpackV2Manifest(makeBaseV2Manifest({
        roles: sixteenRoles,
        steps: [...sixteenSteps, { id: 'step-16', kind: 'agent', role: 'role-0', dependsOn: ['step-15'] }],
      }) as Json),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );

    // Preflight script outside protected path refused
    assert.throws(
      () => validateTaskpackV2Manifest(makeBaseV2Manifest({
        preflight: { script: 'docs/preflight.mjs' },
      }) as Json),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_SCOPE_VIOLATION',
    );

    // Preflight reserved env refused
    assert.throws(
      () => validateTaskpackV2Manifest(makeBaseV2Manifest({
        preflight: { script: '.loopwright/checks/preflight.mjs', env: ['GITHUB_TOKEN'] },
      }) as Json),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );

    // versionPath on non-http-json or with __proto__ refused
    assert.throws(
      () => validateTaskpackV2Manifest(makeBaseV2Manifest({
        upstreams: [{ id: 'u1', kind: 'github-release', source: 'org/repo', watchedPaths: [], versionPath: 'tag_name' }],
      }) as Json),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );
    assert.throws(
      () => validateTaskpackV2Manifest(makeBaseV2Manifest({
        upstreams: [{ id: 'u1', kind: 'http-json', source: 'https://example.com', watchedPaths: [], versionPath: '__proto__.version' }],
      }) as Json),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );

    // command.v1 toolchainPaths traversal / colon injection refused
    assert.throws(
      () => validateTaskpackV2Manifest(makeBaseV2Manifest({
        verification: {
          localChecks: [{
            id: 'cmd',
            implementation: 'command.v1',
            parameters: { script: '.loopwright/checks/verify.sh', toolchainPaths: ['/usr/bin:/evil/bin'] },
          }],
          externalGates: [],
        },
      }) as Json),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );

    // json-keys-guard.v1 invalid pointer refused (missing leading slash, bad RFC 6901 escape, trailing tilde, empty)
    for (const badPointer of ['dependencies', '', '/dependencies~2bad', '/dependencies~', '/a/b~x/c']) {
      assert.throws(
        () => validateTaskpackV2Manifest(makeBaseV2Manifest({
          verification: {
            localChecks: [{
              id: 'guard',
              implementation: 'json-keys-guard.v1',
              parameters: { path: 'package.json', allowedPointers: [badPointer] },
            }],
            externalGates: [],
          },
        }) as Json),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
        `expected json-keys-guard.v1 to reject pointer ${JSON.stringify(badPointer)}`,
      );
    }

    // json-keys-guard.v1 valid RFC 6901 pointers with ~0 and ~1 escapes accepted
    const validGuardManifest = validateTaskpackV2Manifest(makeBaseV2Manifest({
      verification: {
        localChecks: [{
          id: 'guard',
          implementation: 'json-keys-guard.v1',
          parameters: { path: 'package.json', allowedPointers: ['/dependencies/@scope~1pkg', '/meta/a~0b'] },
        }],
        externalGates: [],
      },
    }) as Json);
    assert.equal(validGuardManifest.spec.verification.localChecks[0]?.implementation, 'json-keys-guard.v1');

    // line-section-guard.v1 identical markers or newline markers refused
    for (const badMarkers of [
      { startMarker: '<!-- MARK -->', endMarker: '<!-- MARK -->' },
      { startMarker: '<!-- START\nLINE -->', endMarker: '<!-- END -->' },
      { startMarker: '<!-- START -->', endMarker: '<!-- END\rLINE -->' },
    ]) {
      assert.throws(
        () => validateTaskpackV2Manifest(makeBaseV2Manifest({
          verification: {
            localChecks: [{
              id: 'line-guard',
              implementation: 'line-section-guard.v1',
              parameters: { path: 'docs/guide.md', ...badMarkers },
            }],
            externalGates: [],
          },
        }) as Json),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
        `expected line-section-guard.v1 to reject markers ${JSON.stringify(badMarkers)}`,
      );
    }

    // externalGate non-https url refused
    assert.throws(
      () => validateTaskpackV2Manifest(makeBaseV2Manifest({
        verification: {
          localChecks: [],
          externalGates: [{ id: 'ext', gateId: 'g1', endpointId: 'ep1', required: true, url: 'http://evil.example.com/gate' }],
        },
      }) as Json),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );

    // Ambiguous compact target (two unrelated maximal same-role ancestors) refused
    assert.throws(
      () => validateTaskpackV2Manifest(makeBaseV2Manifest({
        roles: [{ id: 'r1', provider: 'openai', model: 'gpt-5' }],
        steps: [
          { id: 'a1', kind: 'agent', role: 'r1', dependsOn: [] },
          { id: 'a2', kind: 'agent', role: 'r1', dependsOn: [] },
          { id: 'c1', kind: 'compact', role: 'r1', dependsOn: ['a1', 'a2'] },
        ],
      }) as Json),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );
  });
});

describe('Taskpack 2.0 schema: explicit /** and */? scope, .agents opt-in, and .github/workflows dual-key unlock', () => {
  it('allows .agents/** in scope.writable while keeping .claude/** protected', () => {
    assert.equal(PROTECTED_AUTOMATION_PATHS.includes('.agents'), false);
    assert.equal(PROTECTED_AUTOMATION_PATHS.includes('.claude'), true);

    const withAgents = validateTaskpackV2Manifest(makeBaseV2Manifest({
      scope: { writable: ['.agents/**', 'docs/**'], protected: [] },
    }) as Json);
    assert.deepEqual(withAgents.spec.scope.writable, ['.agents/**', 'docs/**']);

    assert.throws(
      () => validateTaskpackV2Manifest(makeBaseV2Manifest({
        scope: { writable: ['.claude/**'], protected: [] },
      }) as Json),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_SCOPE_VIOLATION',
    );
  });

  it('blocks .github/workflows/** by default and unlocks only when dual-key allowWorkflowWrites is true', () => {
    assert.throws(
      () => validateTaskpackV2Manifest(makeBaseV2Manifest({
        execution: { mode: 'privileged' },
        scope: { writable: ['.github/workflows/**'], protected: [] },
      }) as Json, { hostPolicy: { allowPrivileged: true } }),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_SCOPE_VIOLATION',
    );

    // Without hostPolicy.allowWorkflowWrites, manifest self-grant fails closed
    assert.throws(
      () => validateTaskpackV2Manifest(makeBaseV2Manifest({
        execution: { mode: 'strict', capabilities: { allowWorkflowWrites: true } },
        scope: { writable: ['.github/workflows/**', 'docs/**'], protected: [] },
      }) as Json),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_SCOPE_VIOLATION',
    );

    const unlocked = validateTaskpackV2Manifest(makeBaseV2Manifest({
      execution: { mode: 'strict', capabilities: { allowWorkflowWrites: true } },
      scope: { writable: ['.github/workflows/**', 'docs/**'], protected: [] },
    }) as Json, { hostPolicy: { allowWorkflowWrites: true } });
    assert.deepEqual(unlocked.spec.scope.writable, ['.github/workflows/**', 'docs/**']);

    // Even with dual-key allowWorkflowWrites: true, non-workflow .github paths stay protected
    assert.throws(
      () => validateTaskpackV2Manifest(makeBaseV2Manifest({
        execution: { mode: 'strict', capabilities: { allowWorkflowWrites: true } },
        scope: { writable: ['.github/**'], protected: [] },
      }) as Json, { hostPolicy: { allowWorkflowWrites: true } }),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_SCOPE_VIOLATION',
    );
  });

  it('enforces explicit /** semantics for submission/proposal paths and validates */? globs via @loopwright/core', () => {
    // Bare 'docs' does NOT cover 'docs/submission.json' in Taskpack 2.0
    assert.throws(
      () => validateTaskpackV2Manifest(makeBaseV2Manifest({
        scope: { writable: ['docs'], protected: [] },
        submission: { path: 'docs/submission.json', required: true },
      }) as Json),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_SCOPE_VIOLATION',
    );

    // Explicit 'docs/**' covers 'docs/submission.json'
    const ok = validateTaskpackV2Manifest(makeBaseV2Manifest({
      scope: { writable: ['docs/**', 'packages/*/package.json'], protected: [] },
      submission: { path: 'docs/submission.json', required: true },
    }) as Json);
    assert.equal(ok.spec.submission?.path, 'docs/submission.json');

    // Invalid glob pattern rejected
    assert.throws(
      () => validateTaskpackV2Manifest(makeBaseV2Manifest({
        scope: { writable: ['packages/**/nested/file.ts'], protected: [] },
      }) as Json),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );
  });

  it('keeps legacy validateTaskpackManifest compile-compatible while accepting additive Taskpack 2.0 fields', () => {
    const legacyWithV2 = validateTaskpackManifest({
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'Taskpack',
      metadata: { name: 'compat-pack' },
      spec: {
        execution: { mode: 'strict', digests: { pinDigests: false } },
        vars: { CHANNEL: 'beta' },
        goal: { candidate: 'Sync ${CHANNEL}', noChange: 'Check ${CHANNEL}' },
        scope: { writable: ['docs'], protected: [] },
        upstreams: [{ id: 'u1', kind: 'http-json', source: 'https://example.com', watchedPaths: ['docs'], versionPath: 'version', monotonicSemver: true }],
        upstreamGroups: [{ id: 'grp', members: ['u1'], policy: 'independent' }],
        proposal: { path: 'docs/proposal.json', requiredFields: ['summary'], schemaVersion: 1 },
        verification: { localChecks: [], externalGates: [] },
        publication: { mode: 'disabled', targetBranch: 'main', headBranchPrefix: 'sync/', titleTemplate: 'sync ${CHANNEL}' },
        memory: { directory: '.loopwright/memory/compat', apply: 'disabled' },
        triggers: { schedule: false, workflowDispatch: true, releasePublished: false, commentCommands: [] },
        limits: { overlay: { maxFiles: 256 } },
        target: { matrix: [{ id: 'x64', platform: 'linux-x64', variant: 'base' }] },
      },
    } as Json);
    assert.equal(legacyWithV2.spec.proposal.path, 'docs/proposal.json');
    assert.equal(legacyWithV2.spec.publication.titleTemplate, 'sync beta');
    assert.deepEqual(legacyWithV2.spec.limits?.overlay, { maxFiles: 256, maxBytes: 4_194_304 });
  });
});

describe('Taskpack 2.0 security & contract regressions (S1-S4, S7, P1-P3, P5-P7)', () => {
  it('S1: fails closed on privileged mode, allowWorkflowWrites, and sandbox allow-outbound across all entrypoints', () => {
    const selfGrantedPriv = makeBaseV2Manifest({
      execution: {
        mode: 'privileged',
        capabilities: { allowWorkflowWrites: true, allowAgentNetwork: true },
      },
      scope: { writable: ['.github/workflows/**'], protected: [] },
      proposal: { path: '.github/workflows/pwn.yml', requiredFields: ['summary'], schemaVersion: 1 },
      sandbox: { networkMode: 'allow-outbound' },
      verification: { localChecks: [], externalGates: [] },
    });

    // validateTaskpackV2Manifest & validateTaskpackManifest fail closed without hostPolicy
    assert.throws(
      () => validateTaskpackV2Manifest(selfGrantedPriv as Json),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_HOST_BINDING_INVALID',
    );
    assert.throws(
      () => validateTaskpackManifest(selfGrantedPriv as Json),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_HOST_BINDING_INVALID',
    );
    assert.throws(
      () => validateTaskpackV2Manifest(selfGrantedPriv as Json, { hostPolicy: { allowPrivileged: true } }),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_SCOPE_VIOLATION',
    );

    // Offline inspection mode (e.g., digest sync) explicitly opts out of host authority
    const offlineValidated = validateTaskpackV2Manifest(selfGrantedPriv as Json, { enforceHostAuthority: false });
    assert.equal(offlineValidated.spec.execution?.mode, 'privileged');

    // Dual-key unlock succeeds on both validate and assertManifestScopeInvariants
    const dualKeyValidated = validateTaskpackV2Manifest(selfGrantedPriv as Json, {
      hostPolicy: { allowPrivileged: true, allowWorkflowWrites: true },
    });
    assert.doesNotThrow(() => assertManifestScopeInvariants(dualKeyValidated, {
      controlRoot: '.loopwright',
      hostPolicy: { allowPrivileged: true, allowWorkflowWrites: true },
    }));

    // assertManifestScopeInvariants fails closed without hostPolicy
    assert.throws(
      () => assertManifestScopeInvariants(dualKeyValidated, { controlRoot: '.loopwright' }),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_HOST_BINDING_INVALID',
    );
    assert.throws(
      () => assertManifestScopeInvariants(dualKeyValidated, {
        controlRoot: '.loopwright',
        hostPolicy: { allowPrivileged: true },
      }),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_SCOPE_VIOLATION',
    );

    // sandbox.networkMode: 'allow-outbound' refused unless allowAgentNetwork: true (and hostPolicy.allowPrivileged: true)
    const strictOutbound = makeBaseV2Manifest({
      execution: { mode: 'strict' },
      sandbox: { networkMode: 'allow-outbound' },
    });
    assert.throws(
      () => validateTaskpackV2Manifest(strictOutbound as Json),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_SCOPE_VIOLATION' && err.path === '/spec/sandbox/networkMode',
    );
    const privNoAgentNet = makeBaseV2Manifest({
      execution: { mode: 'privileged' },
      sandbox: { networkMode: 'allow-outbound' },
    });
    assert.throws(
      () => validateTaskpackV2Manifest(privNoAgentNet as Json, { hostPolicy: { allowPrivileged: true } }),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_SCOPE_VIOLATION' && err.path === '/spec/sandbox/networkMode',
    );
    const strictWithAgentNetNoHost = makeBaseV2Manifest({
      execution: { mode: 'strict', capabilities: { allowAgentNetwork: true } },
      sandbox: { networkMode: 'allow-outbound' },
    });
    assert.throws(
      () => validateTaskpackV2Manifest(strictWithAgentNetNoHost as Json),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_HOST_BINDING_INVALID',
    );
    const strictWithAgentNetUnlocked = validateTaskpackV2Manifest(strictWithAgentNetNoHost as Json, {
      hostPolicy: { allowPrivileged: true },
    });
    assert.equal(strictWithAgentNetUnlocked.spec.sandbox?.networkMode, 'allow-outbound');
  });

  it('S2: prevents downgrading mandatory protected paths via spec.scope.protected and rejects glob/case subsets of protected patterns', () => {
    const downgradeVariants = [
      ['SCRIPTS/verify.sh'],
      ['script?/verify.sh'],
      ['scripts/**'],
      ['scripts/lib.sh'],
      ['.agent?/skills/s/SKILL.md'],
    ];
    for (const badWritable of downgradeVariants) {
      const doc = makeBaseV2Manifest({
        skills: ['.agents/skills/s/SKILL.md'],
        preflight: { script: 'scripts/verify.sh' },
        verification: {
          localChecks: [{ id: 'cmd', implementation: 'command.v1', parameters: { script: 'scripts/verify.sh' } }],
          externalGates: [],
        },
        scope: {
          protected: ['scripts/verify.sh', '.agents/skills/s/SKILL.md'],
          writable: badWritable,
        },
      });
      assert.throws(
        () => validateTaskpackV2Manifest(doc as Json),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_SCOPE_VIOLATION',
        `expected downgrade bypass to fail for writable=${JSON.stringify(badWritable)}`,
      );
    }

    // Same check on assertManifestScopeInvariants with an in-memory tampered manifest
    const clean = validateTaskpackV2Manifest(makeBaseV2Manifest({
      skills: ['.agents/skills/s/SKILL.md'],
      preflight: { script: 'scripts/verify.sh' },
      verification: {
        localChecks: [{ id: 'cmd', implementation: 'command.v1', parameters: { script: 'scripts/verify.sh' } }],
        externalGates: [],
      },
      scope: {
        protected: ['scripts/verify.sh', '.agents/skills/s/SKILL.md'],
        writable: ['docs/**'],
      },
    }) as Json);
    const tampered = {
      ...clean,
      spec: {
        ...clean.spec,
        scope: {
          writable: ['SCRIPTS/verify.sh'],
          protected: clean.spec.scope.protected,
        },
      },
    };
    assert.throws(
      () => assertManifestScopeInvariants(tampered, { controlRoot: '.loopwright' }),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_SCOPE_VIOLATION',
    );

    // User-only protected glob allows broad superset (blacklist wins) but rejects glob/case-insensitive subset
    const supersetOk = validateTaskpackV2Manifest(makeBaseV2Manifest({
      scope: { writable: ['packages/**'], protected: ['packages/*/secret.json'] },
    }) as Json);
    assert.deepEqual(supersetOk.spec.scope.writable, ['packages/**']);

    for (const prot of ['packages/*/secret.json', 'PACKAGES/*/SECRET.JSON']) {
      assert.throws(
        () => validateTaskpackV2Manifest(makeBaseV2Manifest({
          scope: { writable: ['packages/core/secret.json'], protected: [prot] },
        }) as Json),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_SCOPE_VIOLATION',
      );
    }
  });

  it('S3: protects default digests.lock.json and custom spec.execution.digests.lockfile from writes and carve-outs', () => {
    // Carve-out targeting .loopwright/digests.lock.json refused
    assert.throws(
      () => validateTaskpackV2Manifest(makeBaseV2Manifest({
        execution: { mode: 'strict', digests: { pinDigests: true } },
        proposal: { path: '.loopwright/digests.lock.json', requiredFields: ['version'], schemaVersion: 1 },
        scope: { writable: ['.loopwright/digests.lock.json'], protected: [] },
      }) as Json),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_SCOPE_VIOLATION',
    );

    // Custom lockfile in writable docs/ refused
    assert.throws(
      () => validateTaskpackV2Manifest(makeBaseV2Manifest({
        execution: { mode: 'strict', digests: { pinDigests: true, lockfile: 'docs/digests.lock.json' } },
        scope: { writable: ['docs/**'], protected: [] },
      }) as Json),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_SCOPE_VIOLATION',
    );

    // Custom lockfile in protected location succeeds and is included in effectiveProtectedPaths
    const customLock = validateTaskpackV2Manifest(makeBaseV2Manifest({
      execution: { mode: 'strict', digests: { pinDigests: true, lockfile: '.loopwright/custom.lock.json' } },
      scope: { writable: ['docs/**'], protected: [] },
    }) as Json);
    const prot = assertManifestScopeInvariants(customLock, { controlRoot: '.loopwright' });
    assert.equal(prot.includes('.loopwright/digests.lock.json'), true);
    assert.equal(prot.includes('.loopwright/custom.lock.json'), true);
  });

  it('S4: evaluates pathological http-json versionPath strings in linear time without ReDoS', () => {
    const pathological = `a${'.a'.repeat(120)}!`;
    const started = performance.now();
    assert.throws(
      () => validateTaskpackV2Manifest(makeBaseV2Manifest({
        upstreams: [{ id: 'u1', kind: 'http-json', source: 'https://example.com', watchedPaths: [], versionPath: pathological }],
      }) as Json),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );
    const elapsedMs = performance.now() - started;
    assert.equal(elapsedMs < 200, true, `expected linear-time validation (<200ms), took ${elapsedMs.toFixed(2)}ms`);
  });

  it('S7: hardens command.v1 toolchainPaths against ".", empty segments, whitespace, and writable/unprotected relative paths', () => {
    for (const badPath of ['.', 'a//b', '/usr//bin', ' /usr/bin', '/usr/bin ', '/']) {
      assert.throws(
        () => validateTaskpackV2Manifest(makeBaseV2Manifest({
          verification: {
            localChecks: [{
              id: 'cmd',
              implementation: 'command.v1',
              parameters: { script: '.loopwright/checks/verify.sh', toolchainPaths: [badPath] },
            }],
            externalGates: [],
          },
        }) as Json),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
        `expected invalid toolchainPath "${badPath}" to fail`,
      );
    }

    // Relative path overlapping spec.scope.writable or outside protected paths refused
    for (const badRel of ['docs/bin', 'unprotected/bin']) {
      assert.throws(
        () => validateTaskpackV2Manifest(makeBaseV2Manifest({
          scope: { writable: ['docs/**'], protected: [] },
          verification: {
            localChecks: [{
              id: 'cmd',
              implementation: 'command.v1',
              parameters: { script: '.loopwright/checks/verify.sh', toolchainPaths: [badRel] },
            }],
            externalGates: [],
          },
        }) as Json),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_SCOPE_VIOLATION',
        `expected unsafe relative toolchainPath "${badRel}" to fail`,
      );
    }

    // Protected relative path and safe absolute path succeed
    const ok = validateTaskpackV2Manifest(makeBaseV2Manifest({
      scope: { writable: ['docs/**'], protected: ['scripts/bin'] },
      verification: {
        localChecks: [{
          id: 'cmd',
          implementation: 'command.v1',
          parameters: { script: '.loopwright/checks/verify.sh', toolchainPaths: ['/usr/local/bin', 'scripts/bin'] },
        }],
        externalGates: [],
      },
    }) as Json);
    assert.deepEqual(ok.spec.verification.localChecks[0]?.parameters?.['toolchainPaths'], ['/usr/local/bin', 'scripts/bin']);
  });

  it('P1: rejects ${...} inside /spec/vars when kind !== "Taskpack"', () => {
    const raw = Buffer.from(
      '{"apiVersion":"loopwright.dev/v1alpha1","kind":"NotTaskpack","spec":{"vars":{"PWN":"${GITHUB_TOKEN}","nested":["${AWS_SECRET_ACCESS_KEY}"]}}}',
      'utf8',
    );
    assert.throws(
      () => parseTaskpackDocument(raw, 'json'),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_UNTRUSTED_INTERPOLATION',
    );
  });

  it('P2: rejects boundary-split ${...} synthesis and expanded length overflow on both parse and validate passes', () => {
    const splitA = makeBaseV2Manifest({
      vars: { BRACE: '{GITHUB_TOKEN}' },
      goal: { candidate: '$${BRACE}', noChange: 'ok' },
    });
    const splitB = makeBaseV2Manifest({
      vars: { DOLLAR: '$', BRACE: '{GITHUB_TOKEN}' },
      publication: {
        mode: 'pull_request',
        targetBranch: 'main',
        headBranchPrefix: 'sync/',
        titleTemplate: '${DOLLAR}${BRACE}',
      },
    });
    for (const doc of [splitA, splitB]) {
      assert.throws(
        () => parseTaskpackDocument(Buffer.from(JSON.stringify(doc), 'utf8'), 'json'),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_UNTRUSTED_INTERPOLATION',
      );
      assert.throws(
        () => validateTaskpackV2Manifest(doc as Json),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_UNTRUSTED_INTERPOLATION',
      );
    }

    const oversized = makeBaseV2Manifest({
      vars: { BIG: 'x'.repeat(512) },
      roles: [{ id: 'r1', provider: 'openai', model: 'gpt-5', prompt: '${BIG}'.repeat(20) }],
    });
    assert.throws(
      () => parseTaskpackDocument(Buffer.from(JSON.stringify(oversized), 'utf8'), 'json'),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );
    assert.throws(
      () => validateTaskpackV2Manifest(oversized as Json),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );
  });

  it('P3: emits writable .github/workflows/** under @loopwright/core when dual-key unlocked while keeping explicit user protected winning', () => {
    const prot = effectiveProtectedPaths([], {
      controlRoot: '.loopwright',
      allowWorkflowWrites: true,
      githubSiblings: ['.github/CODEOWNERS', '.github/actions', '.github/workflows'],
    });
    assert.equal(prot.includes('.github'), false);
    assert.equal(prot.includes('.github/CODEOWNERS'), true);
    assert.equal(prot.includes('.github/actions'), true);
    assert.equal(prot.includes('.github/workflows'), false);

    const rev = 'a'.repeat(40);
    const sampleContract = {
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'TaskContract',
      spec: {
        goal: 'Update workflow',
        taskpack: 'wf-check',
        target: { repository: 'org/repo', baseRevision: rev, sourceRevision: rev, matrix: null },
        scope: {
          writable: ['.github/workflows/**'],
          protected: prot.map(p => (p.endsWith('/**') ? p : `${p}/**`)),
        },
        trustedContext: { revision: rev, discovery: 'disabled', resources: [] },
        roles: [{ id: 'r1', adapter: 'pi', provider: 'openai', model: 'gpt-5', thinking: 'medium', tools: ['read', 'write'] }],
        steps: [
          { id: 's1', kind: 'agent', uses: 'pi.turn.v1', roleId: 'r1', dependsOn: [] },
          { id: 'c1', kind: 'check', uses: 'scope.v1', roleId: null, dependsOn: ['s1'] },
        ],
        budgets: {
          wallTimeMs: 60_000,
          totalTokens: 100_000,
          perCallOutputTokens: 4_096,
          maxModelCalls: 10,
          maxConcurrency: 1,
          maxFormatRepairs: 2,
          maxImplementationRepairs: 2,
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
        acceptance: {
          required: ['c1'],
          checks: [{ id: 'c1', allowedEvidenceLevels: ['local_execution'] }],
        },
      },
    };
    const wfRes = isWritablePath(sampleContract, '.github/workflows/ci.yml');
    assert.equal(wfRes.ok, true);
    assert.equal(wfRes.ok && wfRes.value, true);
    const codeownersRes = isWritablePath(sampleContract, '.github/CODEOWNERS');
    assert.equal(codeownersRes.ok, true);
    assert.equal(codeownersRes.ok && codeownersRes.value, false);

    // Explicit user protected: ['.github/**'] always wins over allowWorkflowWrites: true
    assert.throws(
      () => validateTaskpackV2Manifest(makeBaseV2Manifest({
        execution: { mode: 'strict', capabilities: { allowWorkflowWrites: true } },
        scope: { writable: ['.github/workflows/**'], protected: ['.github/**'] },
      }) as Json, { hostPolicy: { allowWorkflowWrites: true } }),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_SCOPE_VIOLATION',
    );
    assert.throws(
      () => validateTaskpackV2Manifest(makeBaseV2Manifest({
        execution: { mode: 'strict', capabilities: { allowWorkflowWrites: true } },
        scope: { writable: ['.github/workflows/**', 'docs/**'], protected: ['.github/**'] },
        submission: { path: '.github/workflows/sub.json', required: true },
      }) as Json, { hostPolicy: { allowWorkflowWrites: true } }),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_SCOPE_VIOLATION',
    );
  });

  it('P5: emits TASKPACK_UNTRUSTED_INTERPOLATION for ${...} in spec.vars keys/arrays/multiline values and non-allowlisted check params', () => {
    const varCases: Array<Record<string, unknown>> = [
      { vars: { '${SECRET}': 'v' } },
      { vars: ['${SECRET}'] },
      { vars: { FOO: 'line1\n${SECRET}' } },
    ];
    for (const override of varCases) {
      const doc = makeBaseV2Manifest(override);
      assert.throws(
        () => parseTaskpackDocument(Buffer.from(JSON.stringify(doc), 'utf8'), 'json'),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_UNTRUSTED_INTERPOLATION',
      );
      assert.throws(
        () => validateTaskpackV2Manifest(doc as Json),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_UNTRUSTED_INTERPOLATION',
      );
    }

    const nonStringParamDoc = makeBaseV2Manifest({
      vars: { FLAG: 'true' },
      verification: {
        localChecks: [{
          id: 'cmd',
          implementation: 'command.v1',
          parameters: { script: '.loopwright/checks/verify.sh', allowReadOnlyGitHubToken: '${FLAG}' },
        }],
        externalGates: [],
      },
    });
    assert.throws(
      () => parseTaskpackDocument(Buffer.from(JSON.stringify(nonStringParamDoc), 'utf8'), 'json'),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_UNTRUSTED_INTERPOLATION',
    );
  });

  it('P6: restricts onRework.rejectTo to task agent steps and forbids mutating tools / non-readOnly MCP on review roles', () => {
    const roles = [
      { id: 'impl', purpose: 'task', provider: 'openai', model: 'gpt-5' },
      { id: 'rev', purpose: 'review', provider: 'anthropic', model: 'claude-sonnet-4' },
    ];

    // rejectTo targeting compact step refused
    assert.throws(
      () => validateTaskpackV2Manifest(makeBaseV2Manifest({
        roles,
        steps: [
          { id: 's-impl', kind: 'agent', role: 'impl', dependsOn: [] },
          { id: 's-compact', kind: 'compact', role: 'impl', dependsOn: ['s-impl'] },
          { id: 's-rev', kind: 'agent', role: 'rev', dependsOn: ['s-compact'], onRework: { rejectTo: 's-compact', maxReworks: 2 } },
        ],
      }) as Json),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );

    // rejectTo targeting check step refused
    assert.throws(
      () => validateTaskpackV2Manifest(makeBaseV2Manifest({
        roles,
        steps: [
          { id: 's-impl', kind: 'agent', role: 'impl', dependsOn: [] },
          { id: 's-check', kind: 'check', check: 'verify-build', dependsOn: ['s-impl'] },
          { id: 's-rev', kind: 'agent', role: 'rev', dependsOn: ['s-check'], onRework: { rejectTo: 's-check', maxReworks: 2 } },
        ],
      }) as Json),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );

    // review role with write/edit/delete tools refused
    for (const badTool of ['write', 'edit', 'delete']) {
      assert.throws(
        () => validateTaskpackV2Manifest(makeBaseV2Manifest({
          roles: [{ id: 'rev', purpose: 'review', provider: 'anthropic', model: 'claude-sonnet-4', tools: ['read', badTool] }],
        }) as Json),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
      );
    }

    // review role with non-readOnly MCP server refused; readOnly: true MCP server accepted
    assert.throws(
      () => validateTaskpackV2Manifest(makeBaseV2Manifest({
        mcp: { servers: [{ id: 'write-mcp', transport: 'stdio', command: 'npx' }] },
        roles: [{ id: 'rev', purpose: 'review', provider: 'anthropic', model: 'claude-sonnet-4', mcpServers: ['write-mcp'] }],
      }) as Json),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );

    const okReviewMcp = validateTaskpackV2Manifest(makeBaseV2Manifest({
      mcp: { servers: [{ id: 'ro-mcp', transport: 'stdio', command: 'npx', readOnly: true }] },
      roles: [{ id: 'rev', purpose: 'review', provider: 'anthropic', model: 'claude-sonnet-4', mcpServers: ['ro-mcp'] }],
    }) as Json);
    assert.deepEqual(okReviewMcp.spec.roles?.[0]?.mcpServers, ['ro-mcp']);
  });

  it('P7: aligns externalGates[] URL and credentialRef validation with @loopwright/controller TrustedRegistry rules', () => {
    const badUrls = [
      'https://ci.example.com/gate?secret=123',
      'https://ci.example.com',
      'http://localhost/gate',
      'http://127.0.0.1/gate',
    ];
    for (const badUrl of badUrls) {
      assert.throws(
        () => validateTaskpackV2Manifest(makeBaseV2Manifest({
          verification: {
            localChecks: [],
            externalGates: [{ id: 'ext', gateId: 'g1', endpointId: 'ep1', required: true, url: badUrl }],
          },
        }) as Json, { allowLoopbackHttp: true }),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
        `expected externalGate url "${badUrl}" to fail`,
      );
    }

    // Explicit-port loopback http succeeds only with allowLoopbackHttp: true
    assert.throws(
      () => validateTaskpackV2Manifest(makeBaseV2Manifest({
        verification: {
          localChecks: [],
          externalGates: [{ id: 'ext', gateId: 'g1', endpointId: 'ep1', required: true, url: 'http://127.0.0.1:8443/gate' }],
        },
      }) as Json),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );
    const loopbackOk = validateTaskpackV2Manifest(makeBaseV2Manifest({
      verification: {
        localChecks: [],
        externalGates: [{
          id: 'ext',
          gateId: 'g1',
          endpointId: 'ep1',
          required: true,
          url: 'http://127.0.0.1:8443/gate',
          signingCredentialRef: 'gate-signer',
          authCredentialRef: 'GATE_AUTH_TOKEN',
        }],
      },
    }) as Json, { allowLoopbackHttp: true });
    assert.equal(loopbackOk.spec.verification.externalGates[0]?.url, 'http://127.0.0.1:8443/gate');

    // Mixed-case or >64-char credential refs rejected
    for (const badRef of ['MixedCaseRef', 'A'.repeat(65)]) {
      assert.throws(
        () => validateTaskpackV2Manifest(makeBaseV2Manifest({
          verification: {
            localChecks: [],
            externalGates: [{ id: 'ext', gateId: 'g1', endpointId: 'ep1', required: true, signingCredentialRef: badRef }],
          },
        }) as Json),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
      );
    }
  });

  it('Review-T8: requires hostPolicy.allowPrivileged for per-check command.v1 mountReadOnlyGit, blocks decision/cloud/gate secret envs, and leaves omitted sandbox.networkMode undefined', () => {
    // 1. Per-check parameters.mountReadOnlyGit: true requires hostPolicy.allowPrivileged === true
    const mountGitManifest = makeBaseV2Manifest({
      verification: {
        localChecks: [
          {
            id: 'git-check',
            implementation: 'command.v1',
            parameters: {
              script: '.loopwright/checks/verify.sh',
              mountReadOnlyGit: true,
            },
          },
        ],
        externalGates: [],
      },
    }) as Json;

    assert.throws(
      () => validateTaskpackV2Manifest(mountGitManifest),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_HOST_BINDING_INVALID',
    );
    assert.throws(
      () => validateTaskpackV2Manifest(mountGitManifest, { hostPolicy: { allowPrivileged: false } }),
      (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_HOST_BINDING_INVALID',
    );
    const privilegedMountGit = validateTaskpackV2Manifest(mountGitManifest, {
      hostPolicy: { allowPrivileged: true },
    });
    assert.equal(privilegedMountGit.spec.verification.localChecks[0]?.parameters?.['mountReadOnlyGit'], true);

    // 2. RESERVED_COMMAND_ENV_NAMES blocks decision provider API keys, cloud/registry tokens, and external gate credential refs
    const forbiddenEnvs = [
      'TYPESAFE_API_KEY',
      'CLOUDFLARE_API_TOKEN',
      'STARTLUX_API_KEY',
      'NPM_TOKEN',
      'NODE_AUTH_TOKEN',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
    ];
    for (const badEnv of forbiddenEnvs) {
      assert.throws(
        () => validateTaskpackV2Manifest(makeBaseV2Manifest({
          verification: {
            localChecks: [
              {
                id: 'env-check',
                implementation: 'command.v1',
                parameters: {
                  script: '.loopwright/checks/verify.sh',
                  env: [badEnv],
                },
              },
            ],
            externalGates: [],
          },
        }) as Json),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
        `expected command.v1 array env "${badEnv}" to be rejected`,
      );
      assert.throws(
        () => validateTaskpackV2Manifest(makeBaseV2Manifest({
          verification: {
            localChecks: [
              {
                id: 'env-map-check',
                implementation: 'command.v1',
                parameters: {
                  script: '.loopwright/checks/verify.sh',
                  env: { [badEnv]: 'static-value' },
                },
              },
            ],
            externalGates: [],
          },
        }) as Json),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
        `expected command.v1 map env "${badEnv}" to be rejected`,
      );
    }

    // External gate signingCredentialRef / authCredentialRef conflicts with command.v1 env
    for (const refEnv of ['SEC_GATE_SIGNING_SECRET', 'SEC_GATE_AUTH_TOKEN']) {
      assert.throws(
        () => validateTaskpackV2Manifest(makeBaseV2Manifest({
          verification: {
            localChecks: [
              {
                id: 'env-gate-conflict',
                implementation: 'command.v1',
                parameters: {
                  script: '.loopwright/checks/verify.sh',
                  env: [refEnv],
                },
              },
            ],
            externalGates: [
              {
                id: 'ext-gate',
                gateId: 'g1',
                endpointId: 'ep1',
                required: true,
                signingCredentialRef: 'SEC_GATE_SIGNING_SECRET',
                authCredentialRef: 'SEC_GATE_AUTH_TOKEN',
              },
            ],
          },
        }) as Json),
        (err: unknown) => err instanceof GitHubAppError && err.code === 'TASKPACK_MANIFEST_INVALID',
        `expected command.v1 env conflicting with external gate credential ref "${refEnv}" to be rejected`,
      );
    }

    // 3. Omitting spec.sandbox.networkMode leaves manifest.spec.sandbox.networkMode undefined
    const omittedNetwork = validateTaskpackV2Manifest(makeBaseV2Manifest({
      execution: { mode: 'privileged', capabilities: { allowAgentNetwork: true } },
      sandbox: { preferredBackends: ['macos-seatbelt'] },
    }) as Json, { hostPolicy: { allowPrivileged: true } });
    assert.equal(omittedNetwork.spec.sandbox?.networkMode, undefined);
  });
});
