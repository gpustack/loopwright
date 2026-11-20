import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OVERLAY_LIMITS } from '@loopwright/core';
import {
  GITHUB_PROTECTED_AUTOMATION_PATHS,
  LOCAL_PROTECTED_AUTOMATION_PATHS,
  MULTI_TENANT_HOST_POLICY,
  PROTECTED_AUTOMATION_PATHS,
  TASKPACK_MANIFEST_BYTES,
  TaskpackError,
} from '../src/types.js';
import {
  assertManifestScopeInvariants,
  assertMultiTenantManifestAuthority,
  canCarveOutControlRootProposal,
  effectiveProtectedPaths,
  hasAnyDeclaredGitHubTrigger,
  isControlRootProposalWritableAllowed,
  isGitHubTriggerDeclared,
  parseTaskpackDocument,
  parseTaskpackManifest,
  resolveEffectiveProtectedPaths,
  validateExecutionAuthority,
  validateManifestExecutionAuthority,
  validateTaskpackLimitsDeclaration,
  validateTaskpackManifestObject,
  validateTaskpackV2Manifest,
  type Json,
} from '../src/schema.js';
import { serializePrettyYaml } from '../src/yaml.js';

const MINIMAL_LOCAL_YAML = `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: local-sync
spec:
  goal:
    candidate: Update generated docs.
    noChange: Confirm no updates needed.
  scope:
    writable:
      - docs/**
      - .claude/**
      - .github/workflows/**
    protected: []
  verification:
    localChecks: []
    externalGates: []
`;

describe('schema.ts: local vs github policy profiles and optional sections', () => {
  it('parses minimal local V2 manifests omitting triggers, publication, and memory with custom controlRoot', () => {
    const manifest = parseTaskpackManifest(MINIMAL_LOCAL_YAML, { controlRoot: '.ops' });
    assert.equal(manifest.metadata.name, 'local-sync');
    assert.equal(manifest.controlRoot, '.ops');
    assert.deepEqual(manifest.spec.triggers, {
      schedule: false,
      workflowDispatch: false,
      releasePublished: false,
      commentCommands: [],
      commentPrefixes: [],
    });
    assert.deepEqual(manifest.spec.publication, { mode: 'disabled' });
    assert.equal(manifest.spec.memory.directory, '.ops/memory/default');
    assert.equal(manifest.spec.memory.apply, 'disabled');
    assert.equal(manifest.spec.memory.onNoModelBudget, 'skip');
    assert.equal(hasAnyDeclaredGitHubTrigger(manifest.spec.triggers), false);
    assert.equal(isGitHubTriggerDeclared(manifest.spec.triggers, 'schedule'), false);
    assert.equal(isGitHubTriggerDeclared(manifest.spec.triggers, 'workflow_dispatch'), false);
    assert.equal(isGitHubTriggerDeclared(manifest.spec.triggers, { eventName: 'issue_comment', commentCommand: 'retry' }), false);

    // Local built-in protection contains only .git (no hardcoded .claude/.codex/CLAUDE.md/AGENTS.md or .github)
    assert.deepEqual(PROTECTED_AUTOMATION_PATHS, ['.git']);
    assert.deepEqual(LOCAL_PROTECTED_AUTOMATION_PATHS, ['.git']);
    assert.deepEqual(GITHUB_PROTECTED_AUTOMATION_PATHS, ['.github', '.git']);

    const effective = resolveEffectiveProtectedPaths(manifest);
    assert.ok(effective.includes('.git'));
    assert.ok(effective.includes('.ops'));
    for (const forbidden of ['.github', '.claude', '.codex', 'CLAUDE.md', 'AGENTS.md']) {
      assert.equal(effective.includes(forbidden), false, `local mode must not hardcode ${forbidden}`);
    }
  });

  it('refuses .github/workflows/** and undeclared triggers under policyProfile: github unless explicitly authorized', () => {
    // Under github profile without allowWorkflowWrites, writable .github/workflows/** is refused
    assert.throws(
      () => parseTaskpackManifest(MINIMAL_LOCAL_YAML, { policyProfile: 'github' }),
      (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_SCOPE_VIOLATION',
    );

    // Under github profile with requireDeclaredTrigger, omitted triggers fail with TASKPACK_TRIGGER_UNSUPPORTED
    const noGithubWriteYaml = `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: gh-no-triggers
spec:
  goal:
    candidate: Update docs.
    noChange: Verify docs.
  scope:
    writable:
      - docs/**
    protected: []
  verification:
    localChecks: []
    externalGates: []
`;
    assert.throws(
      () => parseTaskpackManifest(noGithubWriteYaml, { policyProfile: 'github', requireDeclaredTrigger: true }),
      (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_TRIGGER_UNSUPPORTED',
    );

    // Dual-key workflow unlock under github profile allows .github/workflows/** while keeping non-workflow .github/** protected
    const dualKeyYaml = `apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: gh-workflows
spec:
  execution:
    mode: strict
    capabilities:
      allowWorkflowWrites: true
  goal:
    candidate: Update workflows.
    noChange: Verify workflows.
  scope:
    writable:
      - .github/workflows/**
    protected: []
  verification:
    localChecks: []
    externalGates: []
  triggers:
    schedule: true
    workflowDispatch: false
    releasePublished: false
    commentCommands:
      - retry
`;
    // Missing operator hostPolicy.allowWorkflowWrites -> refused
    assert.throws(
      () => parseTaskpackManifest(dualKeyYaml, { policyProfile: 'github', hostPolicy: { policyProfile: 'github', allowWorkflowWrites: false } }),
      (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_SCOPE_VIOLATION',
    );
    // Both keys present -> accepted and triggers declared properly
    const accepted = parseTaskpackManifest(dualKeyYaml, {
      policyProfile: 'github',
      requireDeclaredTrigger: true,
      hostPolicy: { policyProfile: 'github', allowWorkflowWrites: true },
      githubSiblings: ['.github/CODEOWNERS'],
    });
    assert.equal(isGitHubTriggerDeclared(accepted.spec.triggers, 'schedule'), true);
    assert.equal(isGitHubTriggerDeclared(accepted.spec.triggers, 'workflow_dispatch'), false);
    assert.equal(isGitHubTriggerDeclared(accepted.spec.triggers, { eventName: 'issue_comment', commentCommand: 'retry' }), true);
    assert.equal(isGitHubTriggerDeclared(accepted.spec.triggers, { eventName: 'issue_comment', commentCommand: 'revise' }), false);

    // Non-workflow .github sibling remains blocked even with allowWorkflowWrites: true
    const nonWorkflowSibling = dualKeyYaml.replace('.github/workflows/**', '.github/CODEOWNERS');
    assert.throws(
      () => parseTaskpackManifest(nonWorkflowSibling, {
        policyProfile: 'github',
        hostPolicy: { policyProfile: 'github', allowWorkflowWrites: true },
        githubSiblings: ['.github/CODEOWNERS'],
      }),
      (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_SCOPE_VIOLATION',
    );
  });

  it('requires branch/title fields only when publication.mode is pull_request and makes them optional when disabled', () => {
    const disabledMinimal = validateTaskpackManifestObject({
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'Taskpack',
      metadata: { name: 'pub-disabled' },
      spec: {
        goal: { candidate: 'Work', noChange: 'Verify' },
        scope: { writable: ['docs/**'], protected: [] },
        verification: { localChecks: [], externalGates: [] },
        publication: { mode: 'disabled' },
      },
    } as Json);
    assert.deepEqual(disabledMinimal.spec.publication, { mode: 'disabled' });

    assert.throws(
      () => validateTaskpackManifestObject({
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'Taskpack',
        metadata: { name: 'pub-pr-missing' },
        spec: {
          goal: { candidate: 'Work', noChange: 'Verify' },
          scope: { writable: ['docs/**'], protected: [] },
          verification: { localChecks: [], externalGates: [] },
          publication: { mode: 'pull_request' },
        },
      } as Json),
      (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID' && err.path === '/spec/publication/targetBranch',
    );
  });

  it('preserves exact-file controlRoot proposal.path carve-out and sibling protection in both local and github profiles', () => {
    const rawDoc = {
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'Taskpack',
      metadata: { name: 'auto-sync-demo' },
      spec: {
        goal: { candidate: 'Sync', noChange: 'Verify' },
        scope: {
          writable: ['.auto-sync/proposal.json', 'packages/**'],
          protected: ['.claude/**', 'CLAUDE.md', 'AGENTS.md'],
        },
        instructions: ['.auto-sync/instructions.md'],
        proposal: {
          path: '.auto-sync/proposal.json',
          requiredFields: ['schema_version'],
          schemaVersion: 1,
        },
        verification: {
          localChecks: [
            {
              id: 'verify',
              implementation: 'command.v1',
              parameters: { script: '.auto-sync/checks/verify.sh' },
            },
          ],
          externalGates: [],
        },
      },
    } as Json;

    for (const policyProfile of ['local', 'github'] as const) {
      const manifest = validateTaskpackV2Manifest(rawDoc, { controlRoot: '.auto-sync', policyProfile });
      const protectedSet = assertManifestScopeInvariants(manifest, {
        controlRoot: '.auto-sync',
        policyProfile,
        controlRootSiblings: ['.auto-sync/notes.md'],
      });
      assert.equal(protectedSet.includes('.auto-sync'), false, 'bare controlRoot omitted when proposal carved out');
      assert.ok(protectedSet.includes('.auto-sync/taskpack.yaml'));
      assert.ok(protectedSet.includes('.auto-sync/checks'));
      assert.ok(protectedSet.includes('.auto-sync/scripts'));
      assert.ok(protectedSet.includes('.auto-sync/instructions.md'));
      assert.ok(protectedSet.includes('.auto-sync/digests.lock.json'));
      assert.ok(protectedSet.includes('.auto-sync/notes.md'));
      assert.equal(canCarveOutControlRootProposal('.auto-sync/proposal.json', '.auto-sync', protectedSet), true);
      assert.equal(isControlRootProposalWritableAllowed('.auto-sync/proposal.json', ['.auto-sync/proposal.json', 'packages/**'], '.auto-sync', protectedSet), true);

      // Wildcard inside controlRoot MUST be refused even with proposal.path carve-out
      const wildcardDoc = structuredClone(rawDoc) as Record<string, Record<string, Record<string, unknown>>>;
      wildcardDoc['spec']!['scope']!['writable'] = ['.auto-sync/**'];
      assert.throws(
        () => validateTaskpackV2Manifest(wildcardDoc as unknown as Json, { controlRoot: '.auto-sync', policyProfile }),
        (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_SCOPE_VIOLATION',
      );
    }
  });

  it('allows spec.limits.fileBytes up to OVERLAY_LIMITS.maxMaxBytes (16 GiB) while preserving strict control caps', () => {
    const limits = validateTaskpackLimitsDeclaration({
      fileBytes: OVERLAY_LIMITS.maxMaxBytes,
      overlay: { maxFiles: 128, maxBytes: OVERLAY_LIMITS.maxMaxBytes },
      promptBytes: 1_048_576,
      toolArgsBytes: 4_194_304,
      toolResultBytes: 4_194_304,
      sessionBytes: 67_108_864,
    }, '/spec/limits');
    assert.equal(limits.fileBytes, 17_179_869_184);
    assert.equal(limits.overlay?.maxBytes, 17_179_869_184);

    assert.throws(
      () => validateTaskpackLimitsDeclaration({ fileBytes: OVERLAY_LIMITS.maxMaxBytes + 1 }, '/spec/limits'),
      (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );
    assert.throws(
      () => validateTaskpackLimitsDeclaration({ promptBytes: 1_048_576 + 1 }, '/spec/limits'),
      (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );
    assert.throws(
      () => validateTaskpackLimitsDeclaration({ toolArgsBytes: 4_194_304 + 1 }, '/spec/limits'),
      (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );
    assert.throws(
      () => validateTaskpackLimitsDeclaration({ toolResultBytes: 4_194_304 + 1 }, '/spec/limits'),
      (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );
    assert.throws(
      () => validateTaskpackLimitsDeclaration({ sessionBytes: 67_108_864 + 1 }, '/spec/limits'),
      (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );

    // Oversized taskpack.yaml refused at TASKPACK_MANIFEST_BYTES + 1
    assert.throws(
      () => parseTaskpackDocument(new Uint8Array(TASKPACK_MANIFEST_BYTES + 1), 'yaml'),
      (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_MANIFEST_INVALID',
    );
  });

  it('enforces MULTI_TENANT_HOST_POLICY and refuses conflicting policyProfile declarations', () => {
    const privManifest = parseTaskpackManifest(`apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: priv-demo
spec:
  execution:
    mode: privileged
  goal:
    candidate: Run privileged.
    noChange: Verify.
  scope:
    writable:
      - docs/**
    protected: []
  verification:
    localChecks: []
    externalGates: []
`, { enforceHostAuthority: false });

    assert.equal(MULTI_TENANT_HOST_POLICY.policyProfile, 'github');
    assert.equal(MULTI_TENANT_HOST_POLICY.allowPrivileged, false);
    assert.equal(MULTI_TENANT_HOST_POLICY.allowWorkflowWrites, false);
    assert.throws(
      () => assertMultiTenantManifestAuthority(privManifest),
      (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_HOST_BINDING_INVALID',
    );
    assert.throws(
      () => validateManifestExecutionAuthority(privManifest, MULTI_TENANT_HOST_POLICY),
      (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_HOST_BINDING_INVALID',
    );
    assert.doesNotThrow(() => validateExecutionAuthority(privManifest.spec.execution, { allowPrivileged: true }));

    // Conflicting options.policyProfile vs hostPolicy.policyProfile fails closed
    assert.throws(
      () => parseTaskpackManifest(MINIMAL_LOCAL_YAML, {
        policyProfile: 'local',
        hostPolicy: { policyProfile: 'github' },
      }),
      (err: unknown) => err instanceof TaskpackError && err.code === 'TASKPACK_HOST_BINDING_INVALID',
    );

    // Pretty YAML round-trip stays deterministic
    const serialized = serializePrettyYaml({ apiVersion: 'loopwright.dev/v1alpha1', kind: 'Taskpack' });
    assert.equal(serialized, 'apiVersion: loopwright.dev/v1alpha1\nkind: Taskpack\n');

    // effectiveProtectedPaths respects policyProfile explicitly
    const localPaths = effectiveProtectedPaths([], { controlRoot: '.ops', policyProfile: 'local' });
    assert.equal(localPaths.includes('.github'), false);
    const githubPaths = effectiveProtectedPaths([], { controlRoot: '.ops', policyProfile: 'github' });
    assert.equal(githubPaths.includes('.github'), true);
  });
});
