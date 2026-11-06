import assert from 'node:assert/strict';
import { admitTask, digestArtifact, type Result } from '@loopwright/core';
import { contract } from '../../core/test/fixtures.js';
import type { PiOpenInput } from '../src/types.js';
import { MAX_LIMITS } from '../src/policy.js';
import { PREAMBLE_IDENTITY } from '../src/resources.js';
function good<T>(value: Result<T>): T { assert.equal(value.ok, true); if (!value.ok) throw new Error('fixture invalid'); return value.value; }
export function sessionInput(): PiOpenInput {
  const task = contract(); task.spec.roles[0]!.model = 'claude-sonnet-5.5'; task.spec.roles[0]!.thinking = 'xhigh'; task.spec.roles[0]!.tools = ['read'];
  task.spec.budgets.wallTimeMs = 60000; task.spec.budgets.totalTokens = 1000000; task.spec.budgets.perCallOutputTokens = 1024;
  const lock = good(admitTask(task, { admissionId: 'admission-1', runId: 'run-1' })), bytes = Buffer.from('export const value = 1;\n');
  const metadata = { version: 1, lock, roleId: 'builder', stepId: 'build', sessionId: 'session-1', policy: {
    version: 1, policyId: 'policy-1', resourceVersion: 'context-1', adapterId: 'pi', adapterVersion: '0.0.0',
    runtime: { sdkIntegrity: 'sha512-xNDZ5kqowO6Z03FS2gwAkPEGk1ssxVcYKQ6qZId84mFEvwACvvyc2l0vAMOS+c5zvxLRMLBE9r4y44IGYkMJaQ==', graphDigest: { algorithm: 'sha256', hex: 'a'.repeat(64) }, imageDigest: 'sha256:' + 'b'.repeat(64), configDigest: { algorithm: 'sha256', hex: 'c'.repeat(64) }, profile: 'linux/arm64' },
    selection: { provider: 'github-copilot', model: 'claude-sonnet-5.5', thinking: 'xhigh', api: 'anthropic-messages' }, resources: [PREAMBLE_IDENTITY], tools: ['read'],
    mcp: { serverId: 'workspace', scriptDigest: { algorithm: 'sha256', hex: 'd'.repeat(64) }, names: [], effects: [], idleTimeoutSeconds: 2, absoluteTimeoutSeconds: 10 },
    context: { mode: 'estimated_guard', estimator: 'lw-pi-final-json-bytes-v1', proofId: null, version: 1, evidence: 'estimated', workingWindowCeiling: 98304, maxRequestBytes: 65536, serviceMargin: 32768, toolReserve: 16384, maxOutputTokens: 1024 },
    accounting: 'soft_only', retry: 'sender_only', extensions: [], privateArtifacts: true, limits: MAX_LIMITS },
    candidate: { manifest: { apiVersion: 'loopwright.dev/v1alpha1', kind: 'ArtifactManifest', metadata: { id: 'candidate' }, spec: { entries: [good(digestArtifact('packages/example.ts', bytes))] } }, baseRevision: 'base-1', sourceRevision: 'source-1' }, resources: [], restore: null };
  const owned = JSON.parse(JSON.stringify(metadata)); owned.candidate.artifacts = [{ name: 'packages/example.ts', bytes }]; return owned as PiOpenInput;
}
