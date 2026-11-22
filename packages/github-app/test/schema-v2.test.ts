import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isWritablePath } from '@loopwright/core';
import {
  GitHubAppError,
  MAX_TASKPACK_ROLES,
  MAX_TASKPACK_STEPS,
  PROTECTED_AUTOMATION_PATHS,
  type GitHubAppErrorCode,
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

function expectAppError(fn: () => unknown, code: GitHubAppErrorCode, path?: string): void {
  assert.throws(
    fn,
    (err: unknown) => err instanceof GitHubAppError && err.code === code && (path === undefined || err.path === path),
  );
}

function cmdCheck(parameters: Record<string, unknown>, id = 'cmd'): Record<string, unknown> {
  return { id, implementation: 'command.v1', parameters: { script: '.loopwright/checks/verify.sh', ...parameters } };
}

function makeBaseV2Manifest(specOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiVersion: 'loopwright.dev/v1alpha1',
    kind: 'Taskpack',
    metadata: { name: 'demo-v2-sync' },
    spec: {
      goal: { candidate: 'Sync dependencies and docs cleanly.', noChange: 'Verify repository invariants.' },
      scope: { writable: ['package.json', 'packages/*/package.json', 'docs/**'], protected: ['.loopwright/checks/**'] },
      upstreams: [
        { id: 'pkg-a', kind: 'http-json', source: 'https://registry.npmjs.org/@scope/pkg-a', watchedPaths: ['package.json'], versionPath: 'dist-tags.latest', monotonicSemver: true },
        { id: 'pkg-b', kind: 'http-json', source: 'https://registry.npmjs.org/@scope/pkg-b', watchedPaths: ['package.json'], versionPath: '$.dist-tags["latest"]', monotonicSemver: true },
      ],
      verification: {
        localChecks: [
          cmdCheck({ args: ['--strict'], timeoutSeconds: 120, toolchainPaths: ['/usr/local/bin', '.loopwright/checks/bin'], preserveRepoDirName: true, mountReadOnlyGit: false, env: { TARGET_MODE: 'ci' } }, 'verify-build'),
          { id: 'guard-pkg', implementation: 'json-keys-guard.v1', parameters: { path: 'package.json', allowedPointers: ['/dependencies', '/devDependencies'] } },
          { id: 'guard-readme', implementation: 'line-section-guard.v1', parameters: { path: 'docs/README.md', startMarker: '<!-- AUTO-SYNC:START -->', endMarker: '<!-- AUTO-SYNC:END -->' } },
        ],
        externalGates: [],
      },
      publication: { mode: 'pull_request', targetBranch: 'main', headBranchPrefix: 'auto-sync/', titleTemplate: 'chore(sync): update packages' },
      memory: { directory: '.loopwright/memory/demo', apply: 'local-only', onNoModelBudget: 'deterministic-observations-only' },
      triggers: { schedule: true, workflowDispatch: true, releasePublished: false, commentCommands: ['retry', 'status'] },
      ...specOverrides,
    },
  };
}

describe('Taskpack 2.0 schema: execution trust modes and dual-key authority', () => {
  it('resolves strict and privileged default capabilities and defaults omitted execution to strict', () => {
    assert.deepEqual(resolveExecutionCapabilities('strict'), {
      allowHostEnv: false, allowHostPath: false, mountReadOnlyGit: false,
      allowCheckNetwork: false, allowWorkflowWrites: false, allowAgentNetwork: false, allowDockerSocket: false,
    });
    assert.deepEqual(resolveExecutionCapabilities('privileged'), {
      allowHostEnv: true, allowHostPath: true, mountReadOnlyGit: true,
      allowCheckNetwork: true, allowWorkflowWrites: false, allowAgentNetwork: false, allowDockerSocket: false,
    });

    const manifestDefault = validateTaskpackV2Manifest(makeBaseV2Manifest() as Json);
    assert.equal(manifestDefault.spec.execution?.mode, 'strict');
    assert.equal(manifestDefault.spec.execution?.digests.pinDigests, false);
    assert.equal(manifestDefault.spec.execution?.digests.lockfile, undefined);

    const manifestPinned = validateTaskpackV2Manifest(
      makeBaseV2Manifest({
        execution: { mode: 'privileged', digests: { pinDigests: true } },
        scope: { writable: ['package.json', 'packages/*/package.json', 'docs/**'], protected: ['.auto-sync/checks/**'] },
        verification: { localChecks: [cmdCheck({ script: '.auto-sync/checks/verify.sh' }, 'verify-build')], externalGates: [] },
        memory: { directory: '.auto-sync/memory/demo', apply: 'local-only', onNoModelBudget: 'deterministic-observations-only' },
      }) as Json,
      { controlRoot: '.auto-sync', hostPolicy: { allowPrivileged: true } },
    );
    assert.equal(manifestPinned.spec.execution?.mode, 'privileged');
    assert.equal(manifestPinned.spec.execution?.digests.lockfile, '.auto-sync/digests.lock.json');
  });

  it('enforces dual-key host authorization across validateExecutionAuthority, manifest validators, and sandbox networkMode', () => {
    const decl = (mode: 'strict' | 'privileged', caps?: Parameters<typeof resolveExecutionCapabilities>[1]): TaskpackExecutionDeclaration => ({
      mode, capabilities: resolveExecutionCapabilities(mode, caps), digests: { pinDigests: false },
    });
    assert.doesNotThrow(() => validateExecutionAuthority(decl('strict')));
    assert.doesNotThrow(() => validateExecutionAuthority(undefined));
    expectAppError(() => validateExecutionAuthority(decl('privileged'), {}), 'TASKPACK_HOST_BINDING_INVALID');
    assert.doesNotThrow(() => validateExecutionAuthority(decl('privileged'), { allowPrivileged: true }));
    expectAppError(() => validateExecutionAuthority(decl('strict', { allowWorkflowWrites: true }), { allowPrivileged: true }), 'TASKPACK_SCOPE_VIOLATION');
    assert.doesNotThrow(() => validateExecutionAuthority(decl('strict', { allowWorkflowWrites: true }), { allowWorkflowWrites: true }));
    expectAppError(() => validateExecutionAuthority(decl('privileged', { allowWorkflowWrites: true }), { allowPrivileged: true }), 'TASKPACK_SCOPE_VIOLATION');
    expectAppError(() => validateExecutionAuthority(decl('privileged', { allowWorkflowWrites: true }), { allowWorkflowWrites: true }), 'TASKPACK_HOST_BINDING_INVALID');
    assert.doesNotThrow(() => validateExecutionAuthority(decl('privileged', { allowWorkflowWrites: true }), { allowPrivileged: true, allowWorkflowWrites: true }));
    expectAppError(() => validateExecutionAuthority(decl('strict', { allowHostEnv: true }), {}), 'TASKPACK_HOST_BINDING_INVALID');

    const selfGrantedPriv = makeBaseV2Manifest({
      execution: { mode: 'privileged', capabilities: { allowWorkflowWrites: true, allowAgentNetwork: true } },
      scope: { writable: ['.github/workflows/**'], protected: [] },
      proposal: { path: '.github/workflows/pwn.yml', requiredFields: ['summary'], schemaVersion: 1 },
      sandbox: { networkMode: 'allow-outbound' },
      verification: { localChecks: [], externalGates: [] },
    }) as Json;

    expectAppError(() => validateTaskpackV2Manifest(selfGrantedPriv), 'TASKPACK_HOST_BINDING_INVALID');
    expectAppError(() => validateTaskpackManifest(selfGrantedPriv), 'TASKPACK_HOST_BINDING_INVALID');
    expectAppError(() => validateTaskpackV2Manifest(selfGrantedPriv, { policyProfile: 'github', hostPolicy: { allowPrivileged: true } } as Parameters<typeof validateTaskpackV2Manifest>[1]), 'TASKPACK_SCOPE_VIOLATION');
    assert.equal(validateTaskpackV2Manifest(selfGrantedPriv, { enforceHostAuthority: false }).spec.execution?.mode, 'privileged');

    const dualKey = validateTaskpackV2Manifest(selfGrantedPriv, { policyProfile: 'github', hostPolicy: { allowPrivileged: true, allowWorkflowWrites: true } } as Parameters<typeof validateTaskpackV2Manifest>[1]);
    assert.doesNotThrow(() => assertManifestScopeInvariants(dualKey, { controlRoot: '.loopwright', policyProfile: 'github', hostPolicy: { allowPrivileged: true, allowWorkflowWrites: true } } as Parameters<typeof assertManifestScopeInvariants>[1]));
    expectAppError(() => assertManifestScopeInvariants(dualKey, { controlRoot: '.loopwright', policyProfile: 'github' } as Parameters<typeof assertManifestScopeInvariants>[1]), 'TASKPACK_HOST_BINDING_INVALID');
    expectAppError(() => assertManifestScopeInvariants(dualKey, { controlRoot: '.loopwright', policyProfile: 'github', hostPolicy: { allowPrivileged: true } } as Parameters<typeof assertManifestScopeInvariants>[1]), 'TASKPACK_SCOPE_VIOLATION');

    // sandbox.networkMode: allow-outbound requires both allowAgentNetwork and hostPolicy.allowPrivileged
    expectAppError(() => validateTaskpackV2Manifest(makeBaseV2Manifest({ execution: { mode: 'strict' }, sandbox: { networkMode: 'allow-outbound' } }) as Json), 'TASKPACK_SCOPE_VIOLATION', '/spec/sandbox/networkMode');
    expectAppError(() => validateTaskpackV2Manifest(makeBaseV2Manifest({ execution: { mode: 'privileged' }, sandbox: { networkMode: 'allow-outbound' } }) as Json, { hostPolicy: { allowPrivileged: true } }), 'TASKPACK_SCOPE_VIOLATION', '/spec/sandbox/networkMode');
    const agentNet = makeBaseV2Manifest({ execution: { mode: 'strict', capabilities: { allowAgentNetwork: true } }, sandbox: { networkMode: 'allow-outbound' } }) as Json;
    expectAppError(() => validateTaskpackV2Manifest(agentNet), 'TASKPACK_HOST_BINDING_INVALID');
    assert.equal(validateTaskpackV2Manifest(agentNet, { hostPolicy: { allowPrivileged: true } }).spec.sandbox?.networkMode, 'allow-outbound');

    // Omitting sandbox.networkMode leaves it undefined
    const omittedNet = validateTaskpackV2Manifest(makeBaseV2Manifest({
      execution: { mode: 'privileged', capabilities: { allowAgentNetwork: true } },
      sandbox: { preferredBackends: ['macos-seatbelt'] },
    }) as Json, { hostPolicy: { allowPrivileged: true } });
    assert.equal(omittedNet.spec.sandbox?.networkMode, undefined);

    // Per-check command.v1 mountReadOnlyGit requires hostPolicy.allowPrivileged
    const mountGit = makeBaseV2Manifest({ verification: { localChecks: [cmdCheck({ mountReadOnlyGit: true }, 'git-check')], externalGates: [] } }) as Json;
    expectAppError(() => validateTaskpackV2Manifest(mountGit), 'TASKPACK_HOST_BINDING_INVALID');
    expectAppError(() => validateTaskpackV2Manifest(mountGit, { hostPolicy: { allowPrivileged: false } }), 'TASKPACK_HOST_BINDING_INVALID');
    assert.equal(validateTaskpackV2Manifest(mountGit, { hostPolicy: { allowPrivileged: true } }).spec.verification.localChecks[0]?.parameters?.['mountReadOnlyGit'], true);
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
    writable: [docs/**, package.json]
    protected: [.loopwright/checks/**]
  preflight:
    script: .loopwright/checks/preflight.mjs
    timeoutSeconds: 60
    env: ["\${EXTRA_ENV}"]
  upstreams:
    - id: core
      kind: http-json
      source: https://example.com/releases.json
      watchedPaths: [package.json]
  verification:
    localChecks:
      - id: verify
        implementation: command.v1
        parameters:
          script: .loopwright/checks/verify.sh
          args: ["--node=\${NODE_TARGET}", "--channel=\${RELEASE_CHANNEL}"]
          env: { TARGET_NODE: "\${NODE_TARGET}" }
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
  triggers: { schedule: false, workflowDispatch: true, releasePublished: false, commentCommands: [] }
`;
    const manifest = validateTaskpackV2Manifest(parseTaskpackDocument(Buffer.from(yamlText, 'utf8'), 'yaml'));
    assert.equal(manifest.spec.goal.candidate, 'Upgrade to Node 26 (stable)');
    assert.equal(manifest.spec.publication.titleTemplate, 'chore: sync node-26 (stable)');
    assert.deepEqual(manifest.spec.preflight?.env, ['CUSTOM_FLAG']);
    assert.equal(manifest.spec.roles?.[0]?.prompt, 'Target Node 26 on stable');
    assert.deepEqual(manifest.spec.verification.localChecks[0]?.parameters?.['args'], ['--node=26', '--channel=stable']);
    const checkEnv = manifest.spec.verification.localChecks[0]?.parameters?.['env'];
    assert.equal(Object.getPrototypeOf(checkEnv), null);
    assert.deepEqual({ ...(checkEnv as Record<string, string>) }, { TARGET_NODE: '26' });
    assert.equal(manifest.spec.verification.localChecks[1]?.parameters?.['startMarker'], '<!-- AUTO-DEPS:START -->');
  });

  it('refuses undeclared, nested, boundary-split, disallowed-field, and non-Taskpack ${...} interpolation', () => {
    const interpolationRejects: Array<Record<string, unknown>> = [
      { vars: { SAFE_VAR: 'ok' }, publication: { mode: 'pull_request', targetBranch: 'main', headBranchPrefix: 'sync/', titleTemplate: 'chore: ${UNDECLARED_VAR}' } },
      { vars: { FIRST: 'a', SECOND: '${FIRST}' } },
      { vars: { '${SECRET}': 'v' } },
      { vars: ['${SECRET}'] },
      { vars: { FOO: 'line1\n${SECRET}' } },
      { vars: { BRACE: '{GITHUB_TOKEN}' }, goal: { candidate: '$${BRACE}', noChange: 'ok' } },
      { vars: { DOLLAR: '$', BRACE: '{GITHUB_TOKEN}' }, publication: { mode: 'pull_request', targetBranch: 'main', headBranchPrefix: 'sync/', titleTemplate: '${DOLLAR}${BRACE}' } },
      { vars: { DIR: 'docs' }, scope: { writable: ['${DIR}/**'], protected: [] } },
      { vars: { MODE: 'privileged' }, execution: { mode: '${MODE}' } },
      { vars: { SCRIPT: '.loopwright/checks/pre.sh' }, preflight: { script: '${SCRIPT}' } },
      { vars: { SCRIPT: '.loopwright/checks/verify.sh' }, verification: { localChecks: [cmdCheck({ script: '${SCRIPT}' })], externalGates: [] } },
      { vars: { BIN: '/usr/local/bin' }, verification: { localChecks: [cmdCheck({ toolchainPaths: ['${BIN}'] })], externalGates: [] } },
      { vars: { CRED: 'SIGNING_REF' }, verification: { localChecks: [], externalGates: [{ id: 'ext', gateId: 'g1', endpointId: 'ep1', required: true, signingCredentialRef: '${CRED}' }] } },
      { vars: { CMD: 'node' }, mcp: { servers: [{ id: 'docs', transport: 'stdio', command: '${CMD}' }] } },
    ];
    for (const override of interpolationRejects) {
      const doc = makeBaseV2Manifest(override);
      expectAppError(() => parseTaskpackDocument(Buffer.from(JSON.stringify(doc), 'utf8'), 'json'), 'TASKPACK_UNTRUSTED_INTERPOLATION');
      expectAppError(() => validateTaskpackV2Manifest(doc as Json), 'TASKPACK_UNTRUSTED_INTERPOLATION');
    }

    // Non-string check parameter interpolation rejected at parse
    const nonStringParam = makeBaseV2Manifest({
      vars: { FLAG: 'true' },
      verification: { localChecks: [cmdCheck({ allowReadOnlyGitHubToken: '${FLAG}' })], externalGates: [] },
    });
    expectAppError(() => parseTaskpackDocument(Buffer.from(JSON.stringify(nonStringParam), 'utf8'), 'json'), 'TASKPACK_UNTRUSTED_INTERPOLATION');

    // Non-Taskpack documents still reject ${...} everywhere (including /spec/vars)
    for (const raw of [
      '{"apiVersion":"loopwright.dev/v1alpha1","note":"${SECRET}"}',
      '{"apiVersion":"loopwright.dev/v1alpha1","kind":"NotTaskpack","spec":{"vars":{"PWN":"${GITHUB_TOKEN}","nested":["${AWS_SECRET_ACCESS_KEY}"]}}}',
    ]) {
      expectAppError(() => parseTaskpackDocument(Buffer.from(raw, 'utf8'), 'json'), 'TASKPACK_UNTRUSTED_INTERPOLATION');
    }

    // Expanded length overflow, secret-like keys/values rejected; null-prototype objects accepted
    const oversized = makeBaseV2Manifest({ vars: { BIG: 'x'.repeat(512) }, roles: [{ id: 'r1', provider: 'openai', model: 'gpt-5', prompt: '${BIG}'.repeat(20) }] });
    expectAppError(() => parseTaskpackDocument(Buffer.from(JSON.stringify(oversized), 'utf8'), 'json'), 'TASKPACK_MANIFEST_INVALID');
    expectAppError(() => validateTaskpackV2Manifest(oversized as Json), 'TASKPACK_MANIFEST_INVALID');
    expectAppError(() => validateTaskpackV2Manifest(makeBaseV2Manifest({ vars: { MY_API_KEY: 'abc' } }) as Json), 'TASKPACK_MANIFEST_INVALID');
    expectAppError(() => validateTaskpackV2Manifest(makeBaseV2Manifest({ vars: { LABEL: 'ghp_1234567890abcdef1234567890' } }) as Json), 'TASKPACK_MANIFEST_INVALID');

    const nullProtoDoc = Object.assign(Object.create(null) as Record<string, unknown>, makeBaseV2Manifest({
      vars: Object.assign(Object.create(null) as Record<string, string>, { TAG: 'v2' }),
    }));
    assert.equal(validateTaskpackV2Manifest(nullProtoDoc as Json).spec.vars?.['TAG'], 'v2');
  });
});

describe('Taskpack 2.0 schema: roles, steps DAG, rework, guards, upstreams, and externalGates', () => {
  it('supports up to 16 roles and 16 interleaved steps with rework, per-role isolation, matrix, limits, and decisions', () => {
    assert.equal(MAX_TASKPACK_ROLES, 16);
    assert.equal(MAX_TASKPACK_STEPS, 16);
    const statusCheck: UpstreamAcquisitionStatus = 'held_back';
    assert.equal(statusCheck, 'held_back');

    const manifest = validateTaskpackV2Manifest(makeBaseV2Manifest({
      instructions: ['.loopwright/instructions/shared.md'],
      skills: ['.agents/skills/shared/SKILL.md'],
      mcp: { servers: [{ id: 'docs-mcp', transport: 'stdio', command: 'npx', args: ['-y', 'docs-mcp'], readOnly: true }, { id: 'write-mcp', transport: 'stdio', command: 'npx' }] },
      roles: [
        { id: 'planner', purpose: 'task', provider: 'openai', model: 'gpt-5', instructions: ['.loopwright/instructions/plan.md'], skills: ['.agents/skills/plan/SKILL.md'], mcpServers: ['docs-mcp'], models: ['openai/gpt-5', 'anthropic/claude-sonnet-4'] },
        { id: 'implementer', purpose: 'task', provider: 'openai', model: 'gpt-5', mcpServers: ['docs-mcp', 'write-mcp'] },
        { id: 'reviewer', purpose: 'review', provider: 'anthropic', model: 'claude-sonnet-4', instructions: ['.loopwright/instructions/review.md'], mcpServers: ['docs-mcp'] },
      ],
      steps: [
        { id: 'plan', kind: 'agent', role: 'planner', dependsOn: [] },
        { id: 'implement', kind: 'agent', role: 'implementer', dependsOn: ['plan'] },
        { id: 'compact-impl', kind: 'compact', role: 'implementer', dependsOn: ['implement'] },
        { id: 'fast-check', kind: 'check', check: 'verify-build', dependsOn: ['compact-impl'] },
        { id: 'review', kind: 'agent', role: 'reviewer', dependsOn: ['fast-check'], onRework: { rejectTo: 'implement', maxReworks: 3 } },
      ],
      upstreamGroups: [{ id: 'pi-lockstep', members: ['pkg-a', 'pkg-b'], policy: 'lockstep' }],
      submission: { path: 'docs/submission.json', required: true },
      target: { matrix: [{ id: 'linux-arm64', platform: 'linux-arm64', variant: 'default' }] },
      limits: { overlay: { maxFiles: 512, maxBytes: 16_777_216 } },
      decisions: { enabled: true, provider: 'typesafe-jev', triageRules: [{ id: 'check-lockfile', description: 'Flag lockfile churn', severity: 'important', kind: 'noul', threshold: 0.85 }] },
      verification: {
        localChecks: [
          cmdCheck({}, 'verify-build'),
          { id: 'guard-pkg', implementation: 'json-keys-guard.v1', parameters: { path: 'package.json', allowedPointers: ['/dependencies/@scope~1pkg', '/meta/a~0b'] } },
          { id: 'guard-readme', implementation: 'line-section-guard.v1', parameters: { path: 'docs/README.md', startMarker: 'BEGIN', endMarker: 'END' } },
        ],
        externalGates: [{ id: 'remote-ci', gateId: 'ci-gate', endpointId: 'ci-endpoint', required: true, url: 'https://ci.example.com/gate', signingCredentialRef: 'CI_SIGNING_SECRET', authCredentialRef: 'CI_AUTH_TOKEN' }],
      },
    }) as Json);

    assert.equal(manifest.spec.proposal, undefined);
    assert.deepEqual(manifest.spec.submission, { path: 'docs/submission.json', required: true });
    assert.deepEqual(manifest.spec.roles?.[2]?.mcpServers, ['docs-mcp']);
    assert.deepEqual(manifest.spec.limits?.overlay, { maxFiles: 512, maxBytes: 16_777_216 });
    assert.deepEqual(manifest.spec.steps?.[4]?.onRework, { rejectTo: 'implement', maxReworks: 3 });

    // 16 roles / 16 steps boundary passes; 17 fails
    const roles16 = Array.from({ length: 16 }, (_, i) => ({ id: `role-${i}`, provider: 'openai', model: 'gpt-5' }));
    const steps16 = Array.from({ length: 16 }, (_, i) => ({ id: `step-${i}`, kind: 'agent', role: `role-${i}`, dependsOn: i === 0 ? [] : [`step-${i - 1}`] }));
    assert.equal(validateTaskpackV2Manifest(makeBaseV2Manifest({ roles: roles16, steps: steps16 }) as Json).spec.steps?.length, 16);
    expectAppError(() => validateTaskpackV2Manifest(makeBaseV2Manifest({ roles: [...roles16, { id: 'role-16', provider: 'openai', model: 'gpt-5' }] }) as Json), 'TASKPACK_MANIFEST_INVALID');
    expectAppError(() => validateTaskpackV2Manifest(makeBaseV2Manifest({ roles: roles16, steps: [...steps16, { id: 'step-16', kind: 'agent', role: 'role-0', dependsOn: ['step-15'] }] }) as Json), 'TASKPACK_MANIFEST_INVALID');
  });

  it('rejects invalid DAG/rework/review-role/compact configurations and unknown references', () => {
    const roles = [
      { id: 'r1', purpose: 'task', provider: 'openai', model: 'gpt-5' },
      { id: 'r2', purpose: 'review', provider: 'anthropic', model: 'claude-sonnet-4' },
    ];
    const invalidSpecs: Array<Record<string, unknown>> = [
      { roles, steps: [{ id: 's1', kind: 'agent', role: 'r1', dependsOn: [], onRework: { rejectTo: 's1', maxReworks: 1 } }] },
      { roles, steps: [{ id: 's1', kind: 'agent', role: 'r1', dependsOn: [] }, { id: 's2', kind: 'agent', role: 'r2', dependsOn: [], onRework: { rejectTo: 's1', maxReworks: 2 } }] },
      ...[0, 9, 1.5].map(maxReworks => ({ roles, steps: [{ id: 's1', kind: 'agent', role: 'r1', dependsOn: [] }, { id: 's2', kind: 'agent', role: 'r2', dependsOn: ['s1'], onRework: { rejectTo: 's1', maxReworks } }] })),
      { roles, steps: [{ id: 's1', kind: 'agent', role: 'r1', dependsOn: ['s2'] }, { id: 's2', kind: 'agent', role: 'r2', dependsOn: ['s1'] }] },
      { roles, steps: [{ id: 's1', kind: 'agent', role: 'r1', dependsOn: [] }, { id: 'c1', kind: 'compact', role: 'r2', dependsOn: ['s1'] }] },
      { roles, steps: [{ id: 'a1', kind: 'agent', role: 'r1', dependsOn: [] }, { id: 'a2', kind: 'agent', role: 'r1', dependsOn: [] }, { id: 'c1', kind: 'compact', role: 'r1', dependsOn: ['a1', 'a2'] }] },
      { roles, steps: [{ id: 's1', kind: 'agent', role: 'r1', dependsOn: [] }, { id: 'c1', kind: 'compact', role: 'r1', dependsOn: ['s1'] }, { id: 'rev', kind: 'agent', role: 'r2', dependsOn: ['c1'], onRework: { rejectTo: 'c1', maxReworks: 2 } }] },
      { roles, steps: [{ id: 's1', kind: 'agent', role: 'r1', dependsOn: [] }, { id: 'chk', kind: 'check', check: 'verify-build', dependsOn: ['s1'] }, { id: 'rev', kind: 'agent', role: 'r2', dependsOn: ['chk'], onRework: { rejectTo: 'chk', maxReworks: 2 } }] },
      ...['write', 'edit', 'delete'].map(t => ({ roles: [{ id: 'rev', purpose: 'review', provider: 'anthropic', model: 'claude-sonnet-4', tools: ['read', t] }] })),
      { mcp: { servers: [{ id: 'write-mcp', transport: 'stdio', command: 'npx' }] }, roles: [{ id: 'rev', purpose: 'review', provider: 'anthropic', model: 'claude-sonnet-4', mcpServers: ['write-mcp'] }] },
      { upstreamGroups: [{ id: 'g1', members: ['pkg-a'], policy: 'lockstep' }, { id: 'g2', members: ['pkg-a', 'pkg-b'], policy: 'lockstep' }] },
      { roles: [{ id: 'r1', provider: 'openai', model: 'gpt-5', mcpServers: ['undeclared-mcp'] }] },
      { limits: { overlay: { maxFiles: 20_000 } } },
    ];
    for (const override of invalidSpecs) {
      expectAppError(() => validateTaskpackV2Manifest(makeBaseV2Manifest(override) as Json), 'TASKPACK_MANIFEST_INVALID');
    }
    // Compact under delegated executionMode refused
    expectAppError(() => validateTaskpackV2Manifest(makeBaseV2Manifest({
      roles, steps: [{ id: 's1', kind: 'agent', role: 'r1', dependsOn: [] }, { id: 'c1', kind: 'compact', role: 'r1', dependsOn: ['s1'] }],
    }) as Json, { executionMode: 'delegated' }), 'TASKPACK_MANIFEST_INVALID');
  });

  it('validates preflight, versionPath (linear-time), check parameters, toolchainPaths, reserved env names, and externalGates', () => {
    expectAppError(() => validateTaskpackV2Manifest(makeBaseV2Manifest({ preflight: { script: 'docs/preflight.mjs' } }) as Json), 'TASKPACK_SCOPE_VIOLATION');
    expectAppError(() => validateTaskpackV2Manifest(makeBaseV2Manifest({ preflight: { script: '.loopwright/checks/preflight.mjs', env: ['GITHUB_TOKEN'] } }) as Json), 'TASKPACK_MANIFEST_INVALID');
    expectAppError(() => validateTaskpackV2Manifest(makeBaseV2Manifest({ upstreams: [{ id: 'u1', kind: 'github-release', source: 'org/repo', watchedPaths: [], versionPath: 'tag_name' }] }) as Json), 'TASKPACK_MANIFEST_INVALID');
    expectAppError(() => validateTaskpackV2Manifest(makeBaseV2Manifest({ upstreams: [{ id: 'u1', kind: 'http-json', source: 'https://example.com', watchedPaths: [], versionPath: '__proto__.version' }] }) as Json), 'TASKPACK_MANIFEST_INVALID');

    // Linear-time versionPath validation (no ReDoS)
    const started = performance.now();
    expectAppError(() => validateTaskpackV2Manifest(makeBaseV2Manifest({ upstreams: [{ id: 'u1', kind: 'http-json', source: 'https://example.com', watchedPaths: [], versionPath: `a${'.a'.repeat(120)}!` }] }) as Json), 'TASKPACK_MANIFEST_INVALID');
    assert.ok(performance.now() - started < 200);

    // toolchainPaths invalid syntax and unprotected/writable relative paths
    for (const badPath of ['/usr/bin:/evil/bin', '.', 'a//b', '/usr//bin', ' /usr/bin', '/']) {
      expectAppError(() => validateTaskpackV2Manifest(makeBaseV2Manifest({ verification: { localChecks: [cmdCheck({ toolchainPaths: [badPath] })], externalGates: [] } }) as Json), 'TASKPACK_MANIFEST_INVALID');
    }
    for (const badRel of ['docs/bin', 'unprotected/bin']) {
      expectAppError(() => validateTaskpackV2Manifest(makeBaseV2Manifest({ scope: { writable: ['docs/**'], protected: [] }, verification: { localChecks: [cmdCheck({ toolchainPaths: [badRel] })], externalGates: [] } }) as Json), 'TASKPACK_SCOPE_VIOLATION');
    }
    const okToolchain = validateTaskpackV2Manifest(makeBaseV2Manifest({
      scope: { writable: ['docs/**'], protected: ['scripts/bin'] },
      verification: { localChecks: [cmdCheck({ toolchainPaths: ['/usr/local/bin', 'scripts/bin'] })], externalGates: [] },
    }) as Json);
    assert.deepEqual(okToolchain.spec.verification.localChecks[0]?.parameters?.['toolchainPaths'], ['/usr/local/bin', 'scripts/bin']);

    // Guard parameters: RFC 6901 pointers and line-section markers
    for (const badPtr of ['dependencies', '', '/dependencies~2bad', '/dependencies~', '/a/b~x/c']) {
      expectAppError(() => validateTaskpackV2Manifest(makeBaseV2Manifest({ verification: { localChecks: [{ id: 'g', implementation: 'json-keys-guard.v1', parameters: { path: 'package.json', allowedPointers: [badPtr] } }], externalGates: [] } }) as Json), 'TASKPACK_MANIFEST_INVALID');
    }
    for (const badMarkers of [{ startMarker: 'M', endMarker: 'M' }, { startMarker: 'A\nB', endMarker: 'C' }, { startMarker: 'A', endMarker: 'C\rD' }]) {
      expectAppError(() => validateTaskpackV2Manifest(makeBaseV2Manifest({ verification: { localChecks: [{ id: 'g', implementation: 'line-section-guard.v1', parameters: { path: 'docs/guide.md', ...badMarkers } }], externalGates: [] } }) as Json), 'TASKPACK_MANIFEST_INVALID');
    }

    // Reserved command env names & gate credential ref conflicts
    for (const badEnv of ['TYPESAFE_API_KEY', 'CLOUDFLARE_API_TOKEN', 'STARTLUX_API_KEY', 'NPM_TOKEN', 'NODE_AUTH_TOKEN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']) {
      expectAppError(() => validateTaskpackV2Manifest(makeBaseV2Manifest({ verification: { localChecks: [cmdCheck({ env: [badEnv] })], externalGates: [] } }) as Json), 'TASKPACK_MANIFEST_INVALID');
      expectAppError(() => validateTaskpackV2Manifest(makeBaseV2Manifest({ verification: { localChecks: [cmdCheck({ env: { [badEnv]: 'v' } })], externalGates: [] } }) as Json), 'TASKPACK_MANIFEST_INVALID');
    }
    for (const refEnv of ['SEC_GATE_SIGNING_SECRET', 'SEC_GATE_AUTH_TOKEN']) {
      expectAppError(() => validateTaskpackV2Manifest(makeBaseV2Manifest({
        verification: {
          localChecks: [cmdCheck({ env: [refEnv] })],
          externalGates: [{ id: 'ext', gateId: 'g1', endpointId: 'ep1', required: true, signingCredentialRef: 'SEC_GATE_SIGNING_SECRET', authCredentialRef: 'SEC_GATE_AUTH_TOKEN' }],
        },
      }) as Json), 'TASKPACK_MANIFEST_INVALID');
    }

    // externalGates URL & credentialRef rules
    for (const badUrl of ['http://evil.example.com/gate', 'https://ci.example.com/gate?secret=123', 'https://ci.example.com', 'http://localhost/gate', 'http://127.0.0.1/gate']) {
      expectAppError(() => validateTaskpackV2Manifest(makeBaseV2Manifest({ verification: { localChecks: [], externalGates: [{ id: 'ext', gateId: 'g1', endpointId: 'ep1', required: true, url: badUrl }] } }) as Json, { allowLoopbackHttp: true }), 'TASKPACK_MANIFEST_INVALID');
    }
    expectAppError(() => validateTaskpackV2Manifest(makeBaseV2Manifest({ verification: { localChecks: [], externalGates: [{ id: 'ext', gateId: 'g1', endpointId: 'ep1', required: true, url: 'http://127.0.0.1:8443/gate' }] } }) as Json), 'TASKPACK_MANIFEST_INVALID');
    assert.equal(validateTaskpackV2Manifest(makeBaseV2Manifest({
      verification: { localChecks: [], externalGates: [{ id: 'ext', gateId: 'g1', endpointId: 'ep1', required: true, url: 'http://127.0.0.1:8443/gate', signingCredentialRef: 'gate-signer', authCredentialRef: 'GATE_AUTH_TOKEN' }] },
    }) as Json, { allowLoopbackHttp: true }).spec.verification.externalGates[0]?.url, 'http://127.0.0.1:8443/gate');
    for (const badRef of ['MixedCaseRef', 'A'.repeat(65)]) {
      expectAppError(() => validateTaskpackV2Manifest(makeBaseV2Manifest({ verification: { localChecks: [], externalGates: [{ id: 'ext', gateId: 'g1', endpointId: 'ep1', required: true, signingCredentialRef: badRef }] } }) as Json), 'TASKPACK_MANIFEST_INVALID');
    }
  });
});

describe('Taskpack 2.0 schema: explicit /** and */? scope, protected invariants, and legacy compat', () => {
  it('allows .agents/** opt-in, blocks declared .claude/** and non-workflow .github/**, and enforces dual-key .github/workflows/**', () => {
    assert.equal(PROTECTED_AUTOMATION_PATHS.includes('.agents'), false);
    assert.equal(PROTECTED_AUTOMATION_PATHS.includes('.claude'), false);
    assert.equal(PROTECTED_AUTOMATION_PATHS.includes('.git'), true);

    assert.deepEqual(validateTaskpackV2Manifest(makeBaseV2Manifest({ scope: { writable: ['.agents/**', 'docs/**'], protected: [] } }) as Json).spec.scope.writable, ['.agents/**', 'docs/**']);
    expectAppError(() => validateTaskpackV2Manifest(makeBaseV2Manifest({ scope: { writable: ['.claude/**'], protected: ['.claude/**'] } }) as Json), 'TASKPACK_SCOPE_VIOLATION');
    expectAppError(() => validateTaskpackV2Manifest(makeBaseV2Manifest({ execution: { mode: 'privileged' }, scope: { writable: ['.github/workflows/**'], protected: [] } }) as Json, { policyProfile: 'github', hostPolicy: { allowPrivileged: true } } as Parameters<typeof validateTaskpackV2Manifest>[1]), 'TASKPACK_SCOPE_VIOLATION');
    expectAppError(() => validateTaskpackV2Manifest(makeBaseV2Manifest({ execution: { mode: 'strict', capabilities: { allowWorkflowWrites: true } }, scope: { writable: ['.github/workflows/**', 'docs/**'], protected: [] } }) as Json, { policyProfile: 'github' } as Parameters<typeof validateTaskpackV2Manifest>[1]), 'TASKPACK_SCOPE_VIOLATION');
    expectAppError(() => validateTaskpackV2Manifest(makeBaseV2Manifest({ execution: { mode: 'strict', capabilities: { allowWorkflowWrites: true } }, scope: { writable: ['.github/**'], protected: [] } }) as Json, { policyProfile: 'github', hostPolicy: { allowWorkflowWrites: true } } as Parameters<typeof validateTaskpackV2Manifest>[1]), 'TASKPACK_SCOPE_VIOLATION');
    expectAppError(() => validateTaskpackV2Manifest(makeBaseV2Manifest({ execution: { mode: 'strict', capabilities: { allowWorkflowWrites: true } }, scope: { writable: ['.github/workflows/**'], protected: ['.github/**'] } }) as Json, { policyProfile: 'github', hostPolicy: { allowWorkflowWrites: true } } as Parameters<typeof validateTaskpackV2Manifest>[1]), 'TASKPACK_SCOPE_VIOLATION');

    const unlocked = validateTaskpackV2Manifest(makeBaseV2Manifest({
      execution: { mode: 'strict', capabilities: { allowWorkflowWrites: true } },
      scope: { writable: ['.github/workflows/**', 'docs/**'], protected: [] },
    }) as Json, { policyProfile: 'github', hostPolicy: { allowWorkflowWrites: true } } as Parameters<typeof validateTaskpackV2Manifest>[1]);
    assert.deepEqual(unlocked.spec.scope.writable, ['.github/workflows/**', 'docs/**']);

    const prot = effectiveProtectedPaths([], { controlRoot: '.loopwright', policyProfile: 'github', allowWorkflowWrites: true, githubSiblings: ['.github/CODEOWNERS', '.github/actions', '.github/workflows'] } as Parameters<typeof effectiveProtectedPaths>[1]);
    assert.equal(prot.includes('.github'), false);
    assert.equal(prot.includes('.github/workflows'), false);
    assert.equal(prot.includes('.github/CODEOWNERS'), true);

    const rev = 'a'.repeat(40);
    const contract = {
      apiVersion: 'loopwright.dev/v1alpha1', kind: 'TaskContract',
      spec: {
        goal: 'Update workflow', taskpack: 'wf-check',
        target: { repository: 'org/repo', baseRevision: rev, sourceRevision: rev, matrix: null },
        scope: { writable: ['.github/workflows/**'], protected: prot.map(p => (p.endsWith('/**') ? p : `${p}/**`)) },
        trustedContext: { revision: rev, discovery: 'disabled', resources: [] },
        roles: [{ id: 'r1', adapter: 'pi', provider: 'openai', model: 'gpt-5', thinking: 'medium', tools: ['read', 'write'] }],
        steps: [{ id: 's1', kind: 'agent', uses: 'pi.turn.v1', roleId: 'r1', dependsOn: [] }, { id: 'c1', kind: 'check', uses: 'scope.v1', roleId: null, dependsOn: ['s1'] }],
        budgets: { wallTimeMs: 60_000, totalTokens: 100_000, perCallOutputTokens: 4_096, maxModelCalls: 10, maxConcurrency: 1, maxFormatRepairs: 2, maxImplementationRepairs: 2, maxTransportRetries: 1, enforcement: { wallTime: 'hard_admission', tokens: 'hard_admission', modelCalls: 'hard_admission', concurrency: 'hard_admission', formatRepairs: 'hard_admission', implementationRepairs: 'hard_admission', transportRetries: 'hard_admission' } },
        acceptance: { required: ['c1'], checks: [{ id: 'c1', allowedEvidenceLevels: ['local_execution'] }] },
      },
    };
    const wfRes = isWritablePath(contract, '.github/workflows/ci.yml');
    assert.equal(wfRes.ok && wfRes.value, true);
    const coRes = isWritablePath(contract, '.github/CODEOWNERS');
    assert.equal(coRes.ok && coRes.value, false);
  });

  it('enforces explicit /** semantics, protected-path downgrade prevention, and digests lockfile protection', () => {
    expectAppError(() => validateTaskpackV2Manifest(makeBaseV2Manifest({ scope: { writable: ['docs'], protected: [] }, submission: { path: 'docs/submission.json', required: true } }) as Json), 'TASKPACK_SCOPE_VIOLATION');
    assert.equal(validateTaskpackV2Manifest(makeBaseV2Manifest({ scope: { writable: ['docs/**', 'packages/*/package.json'], protected: [] }, submission: { path: 'docs/submission.json', required: true } }) as Json).spec.submission?.path, 'docs/submission.json');
    expectAppError(() => validateTaskpackV2Manifest(makeBaseV2Manifest({ scope: { writable: ['packages/**/nested/file.ts'], protected: [] } }) as Json), 'TASKPACK_MANIFEST_INVALID');

    // Mandatory protected paths cannot be downgraded via case, glob, or sibling bypasses
    for (const badWritable of [['SCRIPTS/verify.sh'], ['script?/verify.sh'], ['scripts/**'], ['scripts/lib.sh'], ['.agent?/skills/s/SKILL.md']]) {
      expectAppError(() => validateTaskpackV2Manifest(makeBaseV2Manifest({
        skills: ['.agents/skills/s/SKILL.md'],
        preflight: { script: 'scripts/verify.sh' },
        verification: { localChecks: [cmdCheck({ script: 'scripts/verify.sh' })], externalGates: [] },
        scope: { protected: ['scripts/verify.sh', '.agents/skills/s/SKILL.md'], writable: badWritable },
      }) as Json), 'TASKPACK_SCOPE_VIOLATION');
    }

    // Superset writable over user-only protected glob allowed (blacklist wins), subset rejected
    assert.deepEqual(validateTaskpackV2Manifest(makeBaseV2Manifest({ scope: { writable: ['packages/**'], protected: ['packages/*/secret.json'] } }) as Json).spec.scope.writable, ['packages/**']);
    for (const prot of ['packages/*/secret.json', 'PACKAGES/*/SECRET.JSON']) {
      expectAppError(() => validateTaskpackV2Manifest(makeBaseV2Manifest({ scope: { writable: ['packages/core/secret.json'], protected: [prot] } }) as Json), 'TASKPACK_SCOPE_VIOLATION');
    }

    // Default and custom digests.lock.json stay protected
    expectAppError(() => validateTaskpackV2Manifest(makeBaseV2Manifest({
      execution: { mode: 'strict', digests: { pinDigests: true } },
      proposal: { path: '.loopwright/digests.lock.json', requiredFields: ['version'], schemaVersion: 1 },
      scope: { writable: ['.loopwright/digests.lock.json'], protected: [] },
    }) as Json), 'TASKPACK_SCOPE_VIOLATION');
    expectAppError(() => validateTaskpackV2Manifest(makeBaseV2Manifest({
      execution: { mode: 'strict', digests: { pinDigests: true, lockfile: 'docs/digests.lock.json' } },
      scope: { writable: ['docs/**'], protected: [] },
    }) as Json), 'TASKPACK_SCOPE_VIOLATION');
    const customLock = validateTaskpackV2Manifest(makeBaseV2Manifest({
      execution: { mode: 'strict', digests: { pinDigests: true, lockfile: '.loopwright/custom.lock.json' } },
      scope: { writable: ['docs/**'], protected: [] },
    }) as Json);
    const lockProt = assertManifestScopeInvariants(customLock, { controlRoot: '.loopwright' });
    assert.equal(lockProt.includes('.loopwright/digests.lock.json') && lockProt.includes('.loopwright/custom.lock.json'), true);

    // Legacy validateTaskpackManifest remains compatible with additive v2 fields
    const legacyWithV2 = validateTaskpackManifest({
      apiVersion: 'loopwright.dev/v1alpha1', kind: 'Taskpack', metadata: { name: 'compat-pack' },
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
    assert.equal(legacyWithV2.spec.publication.titleTemplate, 'sync beta');
    assert.deepEqual(legacyWithV2.spec.limits?.overlay, { maxFiles: 256, maxBytes: 4_194_304 });
  });
});
