import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { bindSubject, digestArtifact, identifyManifest, type ArtifactManifest, type ArtifactRef, type Digest } from '@loopwright/core';
import { reopenLocalRun, type Authority, type LocalRunStore } from '@loopwright/state';
import { approvedState } from './config.js';
import { compilePlan } from './compile.js';
import { ControllerFailure, refuse, result, safeDiagnostic, type ControllerDiagnostic } from './errors.js';
import { readBoundedFile } from './files.js';
import { parsePrivateJson } from './parser.js';
import { canonical, freeze, hash, id, integer, isRecord, list, record, same, text } from './schema.js';
import { ArtifactStore, privateDirectory, stateValue } from './storage.js';
import { ControllerOwner } from './ownership.js';
import { admitRetainedRun } from './retained.js';
import { reconcileInterruptedOperations, restoredCandidate, retainedPrimary } from './recovery.js';
import { ProgressStore, journal, stableId, type ProgressHead } from './progress.js';
import {
  adoptDelegatedCapture,
  captureDelegatedRole,
  decodeDelegatedWorkspace,
  nativeSessionId,
  type DelegatedCapturePayload,
} from './capture.js';
import {
  assertCanonicalMinimalOverlay,
  canonicalizeCandidateManifest,
  compareUtf16,
  gitObjectOid,
  matchesScopePattern,
  materializeBaseline,
  restoreSource,
  type FrozenSource,
} from './source.js';
import { normalizeSubmission, type RetainedSubmission, type Submission } from './submission.js';
import { evaluateControllerAcceptance, type AcceptanceObservation } from './acceptance.js';
import { descendants, nextNode } from './scheduler.js';
import { formatPolicy, formatPrompt } from './repair.js';
import { countDelegatedBudgets, observeParentExhaustion } from './budget-observations.js';
import { validateGateUrlOverrides } from './gate.js';
import { createCycle, Cycle, type ControllerPorts, type CycleContext } from './controller.js';
import { incident, type ControllerIncident, type CycleExecution } from './finalize.js';
import type { CompiledPlan, ControllerAttempt, DelegatedSelection, LoadedConfiguration, PlannedRole, StepYield } from './types.js';

export type RunExecution = CycleExecution;
export type StepTickResult = StepYield | RunExecution;

export interface StepNextInput {
  readonly configuration?: LoadedConfiguration;
  readonly repository?: string;
  readonly runRoot: string;
  readonly runId: string;
  readonly mode?: 'candidate' | 'no-change';
  readonly reissueLease?: boolean;
  readonly environment?: (name: string) => string | undefined;
  readonly signal?: AbortSignal;
}

export interface StepSubmitInput {
  readonly runRoot: string;
  readonly runId: string;
  readonly leaseToken: string;
  readonly submissionFile?: string;
  readonly status?: 'completed' | 'no_change' | 'failed' | 'blocked';
  readonly reason?: string;
  readonly environment?: (name: string) => string | undefined;
  readonly signal?: AbortSignal;
}

export interface StepCancelInput {
  readonly runRoot: string;
  readonly runId: string;
  readonly environment?: (name: string) => string | undefined;
}

interface StepMetaRecord {
  readonly version: 1;
  readonly mode: 'candidate' | 'no-change';
}

interface StepLeaseRecord {
  readonly version: 1;
  readonly runId: string;
  readonly attemptId: string;
  readonly ordinal: number;
  readonly leaseDigest: string;
  readonly prompt: string;
  readonly contextFiles: readonly string[];
}

const ALWAYS_PROTECTED_PATTERNS: readonly string[] = [
  '.github/workflows/**',
  '.claude/**',
  '.agents/**',
  'AGENTS.md',
  'CLAUDE.md',
];

function isWritableCandidateFile(name: string, scope: CompiledPlan['scope']): boolean {
  if (ALWAYS_PROTECTED_PATTERNS.some(pattern => matchesScopePattern(pattern, name))) return false;
  if (scope.protected.some(pattern => matchesScopePattern(pattern, name))) return false;
  return scope.writable.some(pattern => matchesScopePattern(pattern, name));
}

async function writeAtomicPrivateJson(
  targetPath: string,
  value: unknown,
  vault: { assertClean: (value: Uint8Array | string | object) => void },
): Promise<void> {
  const bytes = Buffer.from(canonical(value));
  if (bytes.byteLength > 2_097_152) refuse('OUTPUT_LIMIT', '', 'execution');
  vault.assertClean(bytes);
  const tempPath = targetPath + '.' + randomBytes(6).toString('hex') + '.tmp';
  const file = await open(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(tempPath, targetPath);
  const parent = await open(dirname(targetPath), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}

async function readStepMeta(directory: string): Promise<StepMetaRecord> {
  const path = join(directory, 'step-meta.json');
  let bytes: Buffer;
  try {
    bytes = await readBoundedFile(path, 4096, true);
  } catch {
    return { version: 1, mode: 'candidate' };
  }
  const raw = record(parsePrivateJson(bytes, 4096), ['version', 'mode']);
  if (raw.version !== 1 || (raw.mode !== 'candidate' && raw.mode !== 'no-change')) refuse('RECOVERY_REQUIRED', '', 'recovery');
  return { version: 1, mode: raw.mode };
}

async function readStepLease(directory: string): Promise<StepLeaseRecord | null> {
  const path = join(directory, 'step-lease.json');
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    refuse('RECOVERY_REQUIRED', '', 'execution');
  }
  const bytes = await readBoundedFile(path, 2_097_152, true);
  const raw = record(parsePrivateJson(bytes, 2_097_152), ['version', 'runId', 'attemptId', 'ordinal', 'leaseDigest', 'prompt', 'contextFiles']);
  if (raw.version !== 1 || !/^[0-9a-f]{64}$/.test(text(raw.leaseDigest))) refuse('RECOVERY_REQUIRED', '', 'execution');
  return {
    version: 1,
    runId: id(raw.runId),
    attemptId: id(raw.attemptId),
    ordinal: integer(raw.ordinal, 1, 64),
    leaseDigest: text(raw.leaseDigest),
    prompt: text(raw.prompt, '', 1_048_576),
    contextFiles: list(raw.contextFiles, '', 64).map(item => text(item, '', 4096)),
  };
}

function verifyLeaseToken(lease: StepLeaseRecord | null, runId: string, attemptId: string, ordinal: number, leaseToken: string): void {
  if (!lease || lease.runId !== runId || lease.attemptId !== attemptId || lease.ordinal !== ordinal || typeof leaseToken !== 'string' || !/^[0-9a-f]{64}$/.test(leaseToken)) {
    refuse('AUTHORITY_REFUSED', '/leaseToken', 'execution');
  }
  const expected = Buffer.from(lease.leaseDigest, 'hex');
  const observed = Buffer.from(hash(leaseToken).hex, 'hex');
  if (expected.byteLength !== observed.byteLength || !timingSafeEqual(expected, observed)) {
    refuse('AUTHORITY_REFUSED', '/leaseToken', 'execution');
  }
}

async function cleanupRunWorkspaces(runRoot: string, runId: string, directory: string): Promise<void> {
  await unlink(join(directory, 'step-lease.json')).catch(() => {});
  await rm(join(resolve(runRoot), 'workspaces', runId), { recursive: true, force: true }).catch(() => {});
}

async function resolveCurrentFileModes(context: CycleContext, head: ProgressHead | null): Promise<Map<string, '100644' | '100755'>> {
  const modes = new Map<string, '100644' | '100755'>();
  if (context.source.version === 2) {
    for (const entry of context.source.baselineEntries ?? []) modes.set(entry.name, entry.mode);
  } else {
    const rawSource = parsePrivateJson(await context.artifacts.read(context.descriptor.source, 262_144), 262_144) as Record<string, unknown>;
    for (const rawEntry of list(rawSource.entries, '', 256)) {
      const entry = record(rawEntry, ['name', 'mode', 'oid', 'ref', 'artifact']);
      const mode = text(entry.mode);
      if (mode === '100644' || mode === '100755') modes.set(text(entry.name), mode);
    }
  }
  if (head && !same(head.progress.candidate.workspace, context.source.workspace)) {
    try {
      const wsBytes = await context.artifacts.read(head.progress.candidate.workspace, 8_388_608);
      const parsed = parsePrivateJson(Buffer.from(wsBytes), 8_388_608);
      if (isRecord(parsed) && parsed.format === 'delegated-capture.v1') {
        const decoded = decodeDelegatedWorkspace(wsBytes, head.manifest, context.lock, 'recovery');
        for (const item of decoded.payload.overlay) modes.set(item.name, item.mode);
      }
    } catch {
      // Non-JSON workspace (e.g., pi capture) keeps baseline modes or defaults to 100644 for new overlay files.
    }
  }
  return modes;
}

async function materializeAttemptWorkspace(
  cycle: Cycle,
  runRoot: string,
  attemptId: string,
  role: PlannedRole,
  repair: ControllerAttempt['repair'],
): Promise<{ readonly candidateDir: string; readonly contextFiles: readonly string[] }> {
  const { context } = cycle;
  const { plan, loaded, source, owner } = context;
  const state = approvedState(loaded);
  const excluded = [context.descriptor.repository, ...state.input.untrustedRoots];
  const workspacesRoot = join(resolve(runRoot), 'workspaces');
  const runWorkspaceDir = join(workspacesRoot, context.lock.spec.runId);
  const attemptWorkspaceDir = join(runWorkspaceDir, attemptId);
  const candidateDir = join(attemptWorkspaceDir, 'candidate');
  const contextDir = join(attemptWorkspaceDir, 'context');

  await privateDirectory(workspacesRoot, excluded);
  await privateDirectory(runWorkspaceDir, excluded);
  await rm(attemptWorkspaceDir, { recursive: true, force: true });
  await privateDirectory(attemptWorkspaceDir, excluded);
  await privateDirectory(candidateDir, excluded);
  await privateDirectory(contextDir, excluded);

  const effectiveTools = repair === 'format' ? [] : role.policy.tools;
  const readOnlyRole = repair === 'format' || !effectiveTools.some(tool => tool === 'write' || tool === 'edit' || tool === 'delete' || tool === 'bash');
  const modes = await resolveCurrentFileModes(context, cycle.head);

  if (source.version === 2) {
    await materializeBaseline(source, candidateDir, owner, cycle.deadline);
    await chmod(candidateDir, 0o700);
    const deletedSet = new Set(cycle.candidate.manifest.spec.deleted ?? []);
    for (const delPath of deletedSet) {
      await rm(join(candidateDir, delPath), { force: true });
    }
    const overlayByPath = new Map(cycle.candidate.files.map(file => [file.name, file.bytes]));
    for (const [name, bytes] of overlayByPath) {
      const targetPath = join(candidateDir, name);
      await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
      await rm(targetPath, { recursive: true, force: true });
      const file = await open(targetPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
    }
    const allPaths = new Set<string>();
    for (const entry of source.baselineEntries ?? []) {
      if (!deletedSet.has(entry.name)) allPaths.add(entry.name);
    }
    for (const file of cycle.candidate.files) allPaths.add(file.name);
    for (const relPath of allPaths) {
      const gitMode = modes.get(relPath) ?? '100644';
      const writable = !readOnlyRole && isWritableCandidateFile(relPath, plan.scope);
      const perm = gitMode === '100755' ? (writable ? 0o700 : 0o500) : (writable ? 0o600 : 0o400);
      await chmod(join(candidateDir, relPath), perm);
    }
  } else {
    for (const item of cycle.candidate.files) {
      const targetPath = join(candidateDir, item.name);
      await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
      const gitMode = modes.get(item.name) ?? '100644';
      const writable = !readOnlyRole && isWritableCandidateFile(item.name, plan.scope);
      const perm = gitMode === '100755' ? (writable ? 0o700 : 0o500) : (writable ? 0o600 : 0o400);
      const file = await open(targetPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, perm);
      try {
        await file.writeFile(item.bytes);
        await file.chmod(perm);
        await file.sync();
      } finally {
        await file.close();
      }
    }
  }

  const contextFiles: string[] = [];
  for (const resource of state.resources) {
    const targetPath = join(contextDir, resource.ref.name);
    await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
    const file = await open(targetPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o400);
    try {
      await file.writeFile(resource.bytes);
      await file.chmod(0o400);
      await file.sync();
    } finally {
      await file.close();
    }
    contextFiles.push(targetPath);
  }

  return { candidateDir, contextFiles };
}

function buildStepYield(
  cycle: Cycle,
  runRoot: string,
  attempt: ControllerAttempt,
  role: PlannedRole,
  prompt: string,
  contextFiles: readonly string[],
  leaseToken: string,
): StepYield {
  const { plan, lock } = cycle.context;
  const effectiveTools = attempt.repair === 'format' ? [] : role.policy.tools;
  const selection: DelegatedSelection = {
    provider: role.policy.selection.provider,
    model: role.policy.selection.model,
    thinking: role.policy.selection.thinking,
  };
  const candidateDir = join(resolve(runRoot), 'workspaces', lock.spec.runId, attempt.id, 'candidate');
  return freeze({
    kind: 'step',
    status: 'awaiting_role',
    runId: lock.spec.runId,
    attemptId: attempt.id,
    stepId: attempt.nodeId,
    roleId: role.roleId,
    purpose: attempt.purpose === 'reviewer' ? 'reviewer' : 'task',
    repair: attempt.repair,
    selection,
    allowedTools: [...effectiveTools],
    scope: plan.scope,
    candidateDir,
    contextFiles: [...contextFiles],
    prompt,
    submissionMode: plan.controls.submission.mode,
    submissionPath: plan.controls.submission.path,
    leaseToken,
  });
}

async function yieldDelegatedRole(
  cycle: Cycle,
  runRoot: string,
  nodeId: string,
  repair: ControllerAttempt['repair'] = 'none',
  customPrompt?: string,
): Promise<StepYield> {
  await cycle.guard();
  const { plan, lock, store, artifacts, loaded, directory } = cycle.context;
  const delegated = countDelegatedBudgets(plan, cycle.draft.attempts);
  observeParentExhaustion(cycle.deadline.assert(), lock, delegated.modelCalls);
  const node = plan.orderedDAG.find(item => item.id === nodeId);
  if (!node || node.kind !== 'agent') refuse('CAPABILITY_UNSUPPORTED', '', 'execution');
  if (cycle.draft.attempts.length >= plan.capacity.A) refuse('ATTEMPT_LIMIT', '', 'execution');
  const originalRole = plan.roles.find(item => item.roleId === node.roleId)!;
  const role: PlannedRole = repair === 'format' ? { ...originalRole, policy: formatPolicy(originalRole.policy) } : originalRole;
  const purpose = node.handler.implementation === 'pi.compact.v1' ? 'compaction' : node.handler.parameters.purpose === 'review' ? 'reviewer' : 'task';
  if (purpose === 'compaction') refuse('CAPABILITY_UNSUPPORTED', '', 'execution');
  const nativeStepId = nodeId;
  const ordinal = cycle.draft.attempts.length + 1;
  const commandId = stableId(lock.spec.runId, nodeId, purpose, repair, ordinal);
  const sessionId = nativeSessionId(lock.spec.runId, role.roleId, nativeStepId, role.policy);
  const configured = text(loaded.registry.spec.handlers.find(handler => handler.id === node.handler.id)?.parameters.prompt);
  if (node.handler.parameters.prompt !== '[private command sha256:' + hash(configured).hex + ']') refuse('RECOVERY_REQUIRED', '', 'execution');
  const promptText = customPrompt ?? configured;
  const command = await artifacts.put('command', Buffer.from(promptText), Math.min(1_048_576, role.policy.limits.promptBytes));
  const originalSubmission = cycle.draft.submission;
  const before = journal(store).view.counts;
  const oldDigest = cycle.draft.candidate.digest;
  observeParentExhaustion(cycle.deadline.assert(), lock, delegated.modelCalls);
  const attempt: ControllerAttempt = {
    ordinal,
    id: commandId,
    nodeId,
    nativeStepId,
    sessionId,
    purpose,
    repair,
    command,
    before: { requests: before.requests, operations: before.operations },
    finished: null,
  };
  if (repair === 'format') {
    await artifacts.json('format-intent', {
      version: 1,
      attemptId: commandId,
      original: originalSubmission,
      schema: 'submission.v1',
      candidate: oldDigest,
      output: 'new_assistant_representation',
    }, 65_536);
  }
  await cycle.events.push(repair === 'none' ? 'role' : 'repair', null, nodeId, commandId);
  await cycle.publish(
    {
      ...cycle.draft,
      stage: { ...cycle.draft.stage, kind: 'role_pre' },
      attempts: [...cycle.draft.attempts, attempt],
      nodes: cycle.draft.nodes.map(item => (item.id === nodeId ? { ...item, state: 'running' } : item)),
    },
    'role.' + ordinal + '.pre',
  );
  const { contextFiles } = await materializeAttemptWorkspace(cycle, runRoot, commandId, role, repair);
  const leaseToken = randomBytes(32).toString('hex');
  await writeAtomicPrivateJson(
    join(directory, 'step-lease.json'),
    {
      version: 1,
      runId: lock.spec.runId,
      attemptId: commandId,
      ordinal,
      leaseDigest: hash(leaseToken).hex,
      prompt: promptText,
      contextFiles,
    } satisfies StepLeaseRecord,
    artifacts.vault,
  );
  return buildStepYield(cycle, runRoot, attempt, role, promptText, contextFiles, leaseToken);
}

async function advanceStepCycle(
  cycle: Cycle,
  runRoot: string,
  options?: { readonly postStructureFailure?: { readonly nodeId: string; readonly code: ControllerDiagnostic['code'] | null } },
): Promise<{ readonly kind: 'yield'; readonly step: StepYield } | { readonly kind: 'done'; readonly primary: AcceptanceObservation }> {
  const { plan } = cycle.context;
  const isDelegatedNode = (nodeId: string): PlannedRole | null => {
    const dagNode = plan.orderedDAG.find(item => item.id === nodeId);
    const role = dagNode?.roleId ? plan.roles.find(item => item.roleId === dagNode.roleId) : undefined;
    return role?.adapter === 'delegated' ? role : null;
  };

  if (!cycle.head) {
    await cycle.bootstrap();
  } else if (!options?.postStructureFailure) {
    const active = cycle.head.progress.attempts.at(-1);
    if (active && active.finished === null) {
      const delegatedRole = isDelegatedNode(active.nodeId);
      if (delegatedRole) {
        if (cycle.resumeAdoption === true) {
          const effectiveRole = active.repair === 'format' ? { ...delegatedRole, policy: formatPolicy(delegatedRole.policy) } : delegatedRole;
          const disallowMutations =
            active.repair === 'format' ||
            !effectiveRole.policy.tools.some(tool => tool === 'write' || tool === 'edit' || tool === 'delete' || tool === 'bash');
          const captured = await adoptDelegatedCapture(cycle.context.store, cycle.context.artifacts, cycle.context.lock, effectiveRole, active, cycle.context.source);
          const failure = await cycle.completeCapture(active, captured, { ignoreArtifactPath: disallowMutations });
          if (failure === 'SUBMISSION_AMBIGUOUS') refuse(failure, '', 'verification');
          if (failure === 'SUBMISSION_INVALID') {
            const raw = cycle.draft.submission;
            cycle.repairBound('format', raw !== null);
            if (!raw) refuse('EVIDENCE_UNAVAILABLE', '', 'verification');
            const allowedCheckIds = plan.task.spec.acceptance.checks.map(item => item.id);
            const prompt = formatPrompt(await cycle.context.artifacts.read(raw, 1_048_576), allowedCheckIds, Math.min(16_384, delegatedRole.policy.limits.promptBytes));
            return { kind: 'yield', step: await yieldDelegatedRole(cycle, runRoot, active.nodeId, 'format', prompt) };
          }
        } else {
          refuse('RECOVERY_REQUIRED', '', 'recovery');
        }
      } else {
        await cycle.resumeAttempt(cycle.resumeAdoption === true);
      }
    }
    const retained = [...cycle.head.progress.verifierReceipts, ...cycle.head.progress.verifierRefusals].filter(
      row => row.generation === cycle.generation,
    );
    for (const row of retained) await cycle.runVerifier(row.slot);
    const lastAttempt = cycle.draft.attempts.at(-1);
    if (lastAttempt?.finished?.nativeCheckpointId === null) {
      const refusal = record(
        parsePrivateJson(await cycle.context.artifacts.read(lastAttempt.finished.outcome, 65_536), 65_536),
        ['version', 'attemptId', 'command', 'diagnostic', 'nativeOutcome', 'currentCandidate', 'unavailable', 'localCleanup'],
      );
      if (refusal.localCleanup !== 'complete') refuse('RECOVERY_REQUIRED', '', 'recovery');
      const diagnostic = refusal.diagnostic as unknown as ControllerDiagnostic;
      if (refusal.currentCandidate === null && diagnostic.code === 'BUDGET_EXHAUSTED' && diagnostic.effect === 'confirmed') {
        cycle.markCandidateUnknown();
        refuse('BUDGET_EXHAUSTED', '', 'execution', { stateCode: diagnostic.stateCode, piCode: diagnostic.piCode, effect: 'confirmed' });
      }
      if (!same(refusal.currentCandidate, cycle.draft.candidate.manifest)) refuse('RECOVERY_REQUIRED', '', 'recovery');
      if (['BUDGET_EXHAUSTED', 'CAPABILITY_UNSUPPORTED', 'MCP_AUTHENTICATION_REQUIRED'].includes(diagnostic.code) && diagnostic.effect === 'none') {
        refuse(diagnostic.code, '', 'execution');
      }
      refuse('RECOVERY_REQUIRED', '', 'recovery');
    }
    if (
      lastAttempt?.finished?.nativeCheckpointId &&
      cycle.submission === null &&
      lastAttempt.purpose !== 'compaction' &&
      cycle.draft.nodes.find(node => node.id === lastAttempt.nodeId)?.state === 'failed'
    ) {
      const delegatedRole = isDelegatedNode(lastAttempt.nodeId);
      if (delegatedRole) {
        const raw = cycle.draft.submission;
        cycle.repairBound('format', raw !== null);
        if (!raw) refuse('EVIDENCE_UNAVAILABLE', '', 'verification');
        const allowedCheckIds = plan.task.spec.acceptance.checks.map(item => item.id);
        const prompt = formatPrompt(await cycle.context.artifacts.read(raw, 1_048_576), allowedCheckIds, Math.min(16_384, delegatedRole.policy.limits.promptBytes));
        return { kind: 'yield', step: await yieldDelegatedRole(cycle, runRoot, lastAttempt.nodeId, 'format', prompt) };
      }
      await cycle.repairFormat(lastAttempt.nodeId);
    }
  }

  if (options?.postStructureFailure) {
    const { nodeId, code } = options.postStructureFailure;
    if (code === 'SUBMISSION_AMBIGUOUS') refuse(code, '', 'verification');
    if (code === 'SUBMISSION_INVALID') {
      const raw = cycle.draft.submission;
      cycle.repairBound('format', raw !== null);
      if (!raw) refuse('EVIDENCE_UNAVAILABLE', '', 'verification');
      const delegatedRole = isDelegatedNode(nodeId);
      const node = plan.orderedDAG.find(item => item.id === nodeId);
      const role = plan.roles.find(item => item.roleId === node?.roleId);
      const maxPromptBytes = role ? Math.min(16_384, role.policy.limits.promptBytes) : 16_384;
      const allowedCheckIds = plan.task.spec.acceptance.checks.map(item => item.id);
      const prompt = formatPrompt(await cycle.context.artifacts.read(raw, 1_048_576), allowedCheckIds, maxPromptBytes);
      if (delegatedRole) {
        return { kind: 'yield', step: await yieldDelegatedRole(cycle, runRoot, nodeId, 'format', prompt) };
      }
      await cycle.role(nodeId, 'format', prompt);
    }
  }

  for (;;) {
    for (;;) {
      const node = nextNode(plan, cycle.draft.nodes);
      if (!node) break;
      if (node.kind === 'agent') {
        const delegatedRole = isDelegatedNode(node.id);
        if (delegatedRole) {
          return { kind: 'yield', step: await yieldDelegatedRole(cycle, runRoot, node.id, 'none') };
        }
        await cycle.role(node.id);
      } else {
        const slot = plan.verifierSlots.find(item => item.handler.id === node.handler.id);
        if (!slot) refuse('CAPABILITY_UNSUPPORTED', '', 'verification');
        const checked = await cycle.runVerifier(slot.id);
        const state = checked.status === 'passed' ? 'completed' : checked.status;
        if (cycle.draft.nodes.find(item => item.id === node.id)!.state !== state) refuse('RECOVERY_REQUIRED', '', 'execution');
      }
    }
    await cycle.verifyEligible();
    if (!cycle.submission) {
      if (plan.orderedDAG.some(node => node.kind === 'agent')) refuse('EVIDENCE_UNAVAILABLE', '', 'verification');
      const value: Submission = { version: 1, status: 'completed', checks: [], reason: null };
      const raw = await cycle.context.artifacts.json('submission', value, 1_048_576);
      cycle.submission = { version: 1, origin: 'controller', raw, value };
    }
    const acceptance = evaluateControllerAcceptance(
      plan,
      cycle.context.lock,
      cycle.candidate.manifest,
      cycle.candidate.files,
      cycle.generation,
      cycle.currentChecks(),
      cycle.submission.value,
      cycle.context.store,
      null,
      cycle.draft.nodes.every(node => node.state === 'completed'),
      cycle.currentRefusals(),
    );
    if (acceptance.result.spec.status === 'failed') {
      const repairSpec = await cycle.prepareImplementationRepair();
      if (repairSpec) {
        if (repairSpec.role.adapter === 'delegated') {
          return { kind: 'yield', step: await yieldDelegatedRole(cycle, runRoot, repairSpec.targetNodeId, 'implementation', repairSpec.prompt) };
        }
        await cycle.role(repairSpec.targetNodeId, 'implementation', repairSpec.prompt);
        continue;
      }
    }
    const finalAcceptance = acceptance.result.spec.status === 'completed' ? await cycle.publishBoundary(acceptance) : acceptance;
    return { kind: 'done', primary: finalAcceptance };
  }
}

async function runStepTickWithCycle(
  context: CycleContext,
  runRoot: string,
  restored?: { readonly head: ProgressHead | null; readonly candidate: import('./verification.js').ByteInventory; readonly submission: RetainedSubmission | null; readonly adopt: boolean },
  options?: { readonly postStructureFailure?: { readonly nodeId: string; readonly code: ControllerDiagnostic['code'] | null } },
): Promise<StepTickResult> {
  const cycle = new Cycle(context, restored?.head ?? null, restored?.candidate, restored?.adopt);
  cycle.submission = restored?.submission ?? null;
  let yielded: StepYield | null = null;
  let primary: AcceptanceObservation | ControllerIncident | null = null;
  try {
    const outcome = await advanceStepCycle(cycle, runRoot, options);
    if (outcome.kind === 'yield') {
      yielded = outcome.step;
    } else {
      primary = outcome.primary;
    }
  } catch (error) {
    const diagnostic = safeDiagnostic(error, 'execution');
    const facts = context.store.inspect();
    const certain =
      facts.ok &&
      facts.value.clockStatus === 'trusted' &&
      !facts.value.counts.dispatchedRequests &&
      !facts.value.counts.unresolvedRequests &&
      !facts.value.counts.unresolvedOperations &&
      !facts.value.ledger.violations.length;
    if (
      cycle.candidateKnown &&
      facts.ok &&
      (['DEADLINE', 'CANCELLED', 'BUDGET_EXHAUSTED', 'ATTEMPT_LIMIT', 'REPEAT_FAILURE'].includes(diagnostic.code) ||
        (certain &&
          ['CAPABILITY_UNSUPPORTED', 'MCP_AUTHENTICATION_REQUIRED', 'EVIDENCE_UNAVAILABLE', 'SUBMISSION_AMBIGUOUS', 'SUBMISSION_INVALID'].includes(
            diagnostic.code,
          )))
    ) {
      const forced =
        diagnostic.code === 'DEADLINE'
          ? 'expired'
          : diagnostic.code === 'CANCELLED'
            ? 'cancelled'
            : ['SUBMISSION_AMBIGUOUS', 'SUBMISSION_INVALID'].includes(diagnostic.code)
              ? 'failed'
              : ['CAPABILITY_UNSUPPORTED', 'MCP_AUTHENTICATION_REQUIRED', 'EVIDENCE_UNAVAILABLE'].includes(diagnostic.code)
                ? 'blocked'
                : 'exhausted';
      const forcedDiagnostic = ['CAPABILITY_UNSUPPORTED', 'MCP_AUTHENTICATION_REQUIRED', 'EVIDENCE_UNAVAILABLE', 'SUBMISSION_AMBIGUOUS', 'SUBMISSION_INVALID'].includes(
        diagnostic.code,
      )
        ? diagnostic.code
        : null;
      try {
        primary = evaluateControllerAcceptance(
          context.plan,
          context.lock,
          cycle.candidate.manifest,
          cycle.candidate.files,
          cycle.generation,
          cycle.currentChecks(),
          cycle.submission?.value ?? null,
          context.store,
          forced,
          cycle.draft.nodes.every(node => node.state === 'completed'),
          cycle.currentRefusals(),
          forcedDiagnostic,
        );
      } catch {
        primary = incident(
          diagnostic,
          context.lock.spec.runId,
          context.lock.spec.lockHash,
          [context.descriptor.plan, context.source.inventory],
          cycle.candidateKnown ? ['authoritative_result'] : ['current_candidate', 'submission', 'authoritative_result'],
          'complete',
        );
      }
    } else {
      primary = incident(
        diagnostic,
        context.lock.spec.runId,
        context.lock.spec.lockHash,
        [context.descriptor.plan, context.source.inventory],
        cycle.candidateKnown ? ['authoritative_result'] : ['current_candidate', 'submission', 'authoritative_result'],
        'complete',
      );
    }
  }

  if (yielded !== null) {
    await cycle.deadline.dispose();
    await cycle.events.suspend();
    stateValue(context.store.release(context.authority));
    stateValue(context.store.close());
    await context.owner.release();
    return yielded;
  }

  await cleanupRunWorkspaces(runRoot, context.lock.spec.runId, context.directory);
  try {
    await cycle.deadline.dispose();
  } catch {
    primary = incident(
      { version: 1, code: 'CLEANUP_FAILED', phase: 'finalization', path: '', stateCode: null, piCode: null, effect: 'possible', retryable: false },
      context.lock.spec.runId,
      context.lock.spec.lockHash,
      [context.descriptor.plan, context.source.inventory],
      ['local_cleanup'],
      'failed',
    );
  }
  const settled = await cycle.terminal(primary!);
  let cleanup: boolean;
  try {
    const released = context.store.release(context.authority);
    const closed = context.store.close();
    cleanup = released.ok && closed.ok;
    if (cleanup) await context.owner.release();
  } catch {
    cleanup = false;
  }
  if (!cleanup) {
    return {
      kind: 'incident',
      version: 1,
      incident: incident(
        { version: 1, code: 'CLEANUP_FAILED', phase: 'finalization', path: '', stateCode: null, piCode: null, effect: 'possible', retryable: false },
        context.lock.spec.runId,
        context.lock.spec.lockHash,
        [context.descriptor.plan, context.source.inventory],
        ['owner_release', 'authoritative_cleanup'],
        'pending',
      ),
    };
  }
  return settled;
}

async function reopenStepContext(input: {
  readonly runRoot: string;
  readonly runId: string;
  readonly configuration?: LoadedConfiguration;
  readonly repository?: string;
  readonly environment?: (name: string) => string | undefined;
  readonly signal?: AbortSignal;
  readonly ports: ControllerPorts;
  readonly phase: ControllerDiagnostic['phase'];
  readonly forceRecoveryMode?: boolean;
}): Promise<{
  readonly context: CycleContext;
  readonly head: ProgressHead | null;
  readonly candidate: import('./verification.js').ByteInventory;
  readonly submission: RetainedSubmission | null;
  readonly decision: ReturnType<ProgressStore['decision']>;
  readonly expired: boolean;
}> {
  const { directory, descriptor, lock, effectiveConfig, state, plan } = await admitRetainedRun({
    runRoot: input.runRoot,
    runId: input.runId,
    ...(input.configuration ? { configuration: input.configuration } : {}),
    ...(input.repository !== undefined ? { repository: input.repository } : {}),
    ...(input.environment ? { environment: input.environment } : {}),
    phase: input.phase,
  });
  validateGateUrlOverrides(input.ports.gateUrlOverrides, input.phase, effectiveConfig.registry.spec.gateEndpoints);

  let owner: ControllerOwner | null = null;
  let store: LocalRunStore | null = null;
  let authority: Authority | null = null;
  let handedOff = false;
  try {
    owner = await ControllerOwner.acquire(directory, input.runId, plan.planDigest);
    store = stateValue(reopenLocalRun(descriptor.identity));
    const original = stateValue(store.inspect());
    if (original.clockStatus !== 'trusted') refuse('RECOVERY_REQUIRED', '', input.phase);
    authority = stateValue(
      store.claim({
        ownerId: 'controller.' + owner.nonce,
        expectedGeneration: original.owner.generation,
        expectedRevision: original.revision,
        mode: 'recovery',
      }),
    ).authority;
    const artifacts = new ArtifactStore(join(directory, 'artifacts'), owner, state.vault);
    const jsonPaths = [...new Set(plan.verifierSlots.filter(slot => slot.handler.implementation === 'json-artifact.v1').map(slot => text(slot.handler.parameters.path)))];
    const source = await restoreSource(descriptor.repository, plan.task, owner, artifacts, descriptor.source, descriptor.sourceWorkspace, jsonPaths);
    const progress = new ProgressStore(store, authority, artifacts, plan, lock, descriptor.plan, descriptor.source);
    let head = await progress.read();
    let context: CycleContext = {
      loaded: effectiveConfig,
      plan,
      lock,
      directory,
      source,
      store,
      authority,
      owner,
      artifacts,
      progress,
      descriptor,
      signal: input.signal ?? new AbortController().signal,
      onEvent: undefined,
      ports: input.ports,
    };
    const candidate = await restoredCandidate(context, head);
    await reconcileInterruptedOperations(context, head, candidate, original.storeId);
    head = await progress.read();
    const decision = progress.decision(head);
    const expired =
      decision !== 'terminal' &&
      decision !== 'reconcile_required' &&
      ((original.clock.remainingTaskMs.safeValue ?? 0) <= 0 ||
        BigInt(original.clock.sampledNow.monotonicMs) >= BigInt(original.clock.basis.taskDeadlineMonotonicMs) - BigInt(plan.controls.drainReserveMs));
    if (decision !== 'terminal' && decision !== 'reconcile_required' && !expired && !input.forceRecoveryMode) {
      stateValue(store.release(authority));
      authority = null;
      const current = stateValue(store.inspect());
      authority = stateValue(
        store.claim({
          ownerId: 'controller.' + owner.nonce,
          expectedGeneration: current.owner.generation,
          expectedRevision: current.revision,
          mode: 'active',
        }),
      ).authority;
      context = {
        ...context,
        authority,
        progress: new ProgressStore(store, authority, artifacts, plan, lock, descriptor.plan, descriptor.source),
      };
    }
    let submission: RetainedSubmission | null = null;
    if (head?.progress.submission) {
      try {
        submission = {
          version: 1,
          origin: plan.orderedDAG.some(node => node.kind === 'agent') ? 'assistant' : 'controller',
          raw: head.progress.submission,
          value: normalizeSubmission(await artifacts.read(head.progress.submission, 1_048_576), plan.task),
        };
      } catch (error) {
        if (!(error instanceof ControllerFailure) || error.diagnostic.code !== 'SUBMISSION_INVALID') throw error;
      }
    }
    handedOff = true;
    return { context, head, candidate, submission, decision, expired };
  } finally {
    if (!handedOff) {
      if (store) {
        if (authority) stateValue(store.release(authority));
        stateValue(store.close());
      }
      if (owner) await owner.release();
    }
  }
}

async function settleForcedStepRun(
  context: CycleContext,
  head: ProgressHead | null,
  candidate: import('./verification.js').ByteInventory,
  submission: RetainedSubmission | null,
  runRoot: string,
  forcedStatus: 'expired' | 'cancelled' | 'reconcile_required',
): Promise<RunExecution> {
  await cleanupRunWorkspaces(runRoot, context.lock.spec.runId, context.directory);
  const cycle = new Cycle(context, head, candidate, false);
  cycle.submission = submission;
  let primary: AcceptanceObservation | ControllerIncident;
  try {
    if (!cycle.head) await cycle.bootstrap();
    const active = cycle.draft.attempts.at(-1);
    if (active && active.finished === null && forcedStatus !== 'reconcile_required') {
      const diagnostic: ControllerDiagnostic = {
        version: 1,
        code: forcedStatus === 'expired' ? 'DEADLINE' : 'CANCELLED',
        phase: 'execution',
        path: '',
        stateCode: null,
        piCode: null,
        effect: 'none',
        retryable: false,
      };
      const after = stateValue(context.store.inspect()).counts;
      const outcome = await context.artifacts.json(
        'role-refusal',
        {
          version: 1,
          attemptId: active.id,
          command: active.command,
          diagnostic,
          nativeOutcome: null,
          currentCandidate: cycle.draft.candidate.manifest,
          unavailable: [],
          localCleanup: 'complete',
        },
        65_536,
      );
      await cycle.publish(
        {
          ...cycle.draft,
          stage: { ...cycle.draft.stage, kind: 'role_post' },
          attempts: cycle.draft.attempts.map(item =>
            item.id === active.id
              ? { ...item, finished: { after: { requests: after.requests, operations: after.operations }, outcome, nativeCheckpointId: null } }
              : item,
          ),
          nodes: cycle.draft.nodes.map(item =>
            item.id === active.nodeId
              ? { ...item, state: 'failed' }
              : descendants(context.plan, active.nodeId).includes(item.id) && item.state === 'pending'
                ? { ...item, state: 'not_run' }
                : item,
          ),
        },
        'role.' + active.ordinal + '.post',
      );
    }
    const retained = [
      ...(cycle.head?.progress.verifierReceipts ?? []).filter(row => {
        if (row.receipt !== null) return true;
        const op = context.store.getOperation(row.operationId);
        return op.ok && op.value.dispatch !== null;
      }),
      ...(cycle.head?.progress.verifierRefusals ?? []),
    ].filter(row => row.generation === cycle.generation);
    for (const row of retained) await cycle.runVerifier(row.slot);
    primary = evaluateControllerAcceptance(
      context.plan,
      context.lock,
      cycle.candidate.manifest,
      cycle.candidate.files,
      cycle.generation,
      cycle.currentChecks(),
      cycle.submission?.value ?? null,
      context.store,
      forcedStatus === 'reconcile_required' ? null : forcedStatus,
      cycle.draft.nodes.every(node => node.state === 'completed'),
      cycle.currentRefusals(),
    );
  } catch (error) {
    primary = incident(
      safeDiagnostic(error, 'finalization'),
      context.lock.spec.runId,
      context.lock.spec.lockHash,
      [context.descriptor.plan, context.source.inventory],
      ['authoritative_result'],
      'complete',
    );
  }
  await cycle.deadline.dispose().catch(() => {});
  const settled = await cycle.terminal(primary, 15_000);
  try {
    stateValue(context.store.release(context.authority));
    stateValue(context.store.close());
    await context.owner.release();
  } catch {
    // Best-effort release on terminal drain/cancel.
  }
  return settled;
}

async function scanCandidateDirectory(
  candidateDir: string,
  source: FrozenSource,
  previousDigest: Digest,
  disallowMutations: boolean,
): Promise<{
  readonly manifest: ArtifactManifest;
  readonly files: readonly { readonly name: string; readonly bytes: Uint8Array }[];
  readonly overlay: readonly { readonly name: string; readonly mode: '100644' | '100755'; readonly bodyBase64: string }[];
  readonly deleted: readonly string[];
}> {
  let rootStat;
  try {
    rootStat = await lstat(candidateDir);
  } catch {
    refuse('ARTIFACT_INVALID', '', 'execution');
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) refuse('ARTIFACT_INVALID', '', 'execution');

  const scannedFiles: { readonly name: string; readonly mode: '100644' | '100755'; readonly bytes: Uint8Array }[] = [];
  let entriesSeen = 0;

  const visit = async (absDir: string, relPrefix: string, depth: number): Promise<void> => {
    if (depth > 32) refuse('ARTIFACT_INVALID', '', 'execution');
    const dirEntries = await readdir(absDir, { withFileTypes: true });
    entriesSeen += dirEntries.length;
    if (entriesSeen > 16_384) refuse('OUTPUT_LIMIT', '', 'execution');
    dirEntries.sort((a, b) => compareUtf16(a.name, b.name));
    for (const d of dirEntries) {
      if (d.name.toLowerCase() === '.git' || Buffer.byteLength(d.name, 'utf8') > 255) refuse('ARTIFACT_INVALID', '', 'execution');
      const absPath = join(absDir, d.name);
      const relPath = relPrefix ? `${relPrefix}/${d.name}` : d.name;
      const st = await lstat(absPath);
      if (st.isSymbolicLink()) refuse('ARTIFACT_INVALID', '', 'execution');
      if (st.isDirectory()) {
        await visit(absPath, relPath, depth + 1);
        continue;
      }
      if (!st.isFile() || st.nlink !== 1) refuse('ARTIFACT_INVALID', '', 'execution');
      if (!digestArtifact(relPath, new Uint8Array()).ok) refuse('ARTIFACT_INVALID', '', 'execution');
      if (st.size > 1_048_576) refuse('OUTPUT_LIMIT', '', 'execution');
      const fh = await open(absPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let buf: Buffer;
      try {
        const fst = await fh.stat();
        if (fst.dev !== st.dev || fst.ino !== st.ino || fst.nlink !== 1 || !fst.isFile() || fst.size > 1_048_576) {
          refuse('ARTIFACT_INVALID', '', 'execution');
        }
        buf = Buffer.alloc(fst.size);
        let offset = 0;
        while (offset < fst.size) {
          const { bytesRead } = await fh.read(buf, offset, fst.size - offset, offset);
          if (bytesRead <= 0) break;
          offset += bytesRead;
        }
        if (offset !== fst.size) refuse('ARTIFACT_INVALID', '', 'execution');
      } finally {
        await fh.close();
      }
      const mode: '100644' | '100755' = (st.mode & 0o111) !== 0 ? '100755' : '100644';
      scannedFiles.push({ name: relPath, mode, bytes: new Uint8Array(buf) });
    }
  };

  await visit(candidateDir, '', 1);
  scannedFiles.sort((a, b) => compareUtf16(a.name, b.name));

  if (source.version === 2) {
    const baseTree = source.manifest.spec.baseTree!;
    const baselineByPath = new Map((source.baselineEntries ?? []).map(entry => [entry.name, entry]));
    const scannedByPath = new Map(scannedFiles.map(file => [file.name, file]));
    const deleted: string[] = [];
    for (const baseEntry of source.baselineEntries ?? []) {
      if (!scannedByPath.has(baseEntry.name)) deleted.push(baseEntry.name);
    }
    deleted.sort(compareUtf16);
    const overlay: { readonly name: string; readonly mode: '100644' | '100755'; readonly bodyBase64: string }[] = [];
    const files: { readonly name: string; readonly bytes: Uint8Array }[] = [];
    const manifestEntries: ArtifactRef[] = [];
    let totalOverlayBytes = 0;
    for (const file of scannedFiles) {
      const baseEntry = baselineByPath.get(file.name);
      if (baseEntry && gitObjectOid(baseTree.objectFormat, 'blob', file.bytes) === baseEntry.oid) {
        continue;
      }
      if (overlay.length >= 128 || (totalOverlayBytes += file.bytes.byteLength) > 4_194_304) {
        refuse('OUTPUT_LIMIT', '', 'execution');
      }
      const ref = digestArtifact(file.name, file.bytes);
      if (!ref.ok) refuse('ARTIFACT_INVALID', '', 'execution');
      overlay.push({ name: file.name, mode: file.mode, bodyBase64: Buffer.from(file.bytes).toString('base64') });
      files.push({ name: file.name, bytes: file.bytes });
      manifestEntries.push(ref.value);
    }
    const identified = identifyManifest(
      canonicalizeCandidateManifest({
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'ArtifactManifest',
        metadata: { id: 'candidate' },
        spec: { baseTree, entries: manifestEntries, deleted },
      }),
    );
    if (!identified.ok) refuse('ARTIFACT_INVALID', '', 'execution');
    if (disallowMutations && !same(identified.value.digest, previousDigest)) {
      refuse('ARTIFACT_INVALID', '', 'execution');
    }
    return { manifest: identified.value.manifest, files, overlay, deleted };
  }

  // source.version === 1 (classic mode)
  if (scannedFiles.length > 128) refuse('OUTPUT_LIMIT', '', 'execution');
  let totalBytes = 0;
  const baselineNames = new Set(source.artifacts.map(item => item.name));
  const scannedNames = new Set(scannedFiles.map(item => item.name));
  const deleted: string[] = [];
  for (const baseName of baselineNames) {
    if (!scannedNames.has(baseName)) deleted.push(baseName);
  }
  deleted.sort(compareUtf16);
  const overlay: { readonly name: string; readonly mode: '100644' | '100755'; readonly bodyBase64: string }[] = [];
  const files: { readonly name: string; readonly bytes: Uint8Array }[] = [];
  const manifestEntries: ArtifactRef[] = [];
  for (const file of scannedFiles) {
    if ((totalBytes += file.bytes.byteLength) > 4_194_304) refuse('OUTPUT_LIMIT', '', 'execution');
    const ref = digestArtifact(file.name, file.bytes);
    if (!ref.ok) refuse('ARTIFACT_INVALID', '', 'execution');
    overlay.push({ name: file.name, mode: file.mode, bodyBase64: Buffer.from(file.bytes).toString('base64') });
    files.push({ name: file.name, bytes: file.bytes });
    manifestEntries.push(ref.value);
  }
  const identified = identifyManifest(
    canonicalizeCandidateManifest({
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'ArtifactManifest',
      metadata: { id: 'candidate' },
      spec: { entries: manifestEntries },
    }),
  );
  if (!identified.ok) refuse('ARTIFACT_INVALID', '', 'execution');
  if (disallowMutations && !same(identified.value.digest, previousDigest)) {
    refuse('ARTIFACT_INVALID', '', 'execution');
  }
  return { manifest: identified.value.manifest, files, overlay, deleted };
}

async function readExplicitSubmissionFile(path: string): Promise<Uint8Array> {
  const rawTarget = resolve(text(path, '/submissionFile', 4096));
  let target: string;
  try {
    const stats = await lstat(rawTarget);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size > 65_536) {
      refuse(stats.size > 65_536 ? 'OUTPUT_LIMIT' : 'ARTIFACT_INVALID', '/submissionFile', 'execution');
    }
    target = join(await realpath(dirname(rawTarget)), basename(rawTarget));
  } catch (error) {
    if (error instanceof ControllerFailure) throw error;
    refuse('ARTIFACT_INVALID', '/submissionFile', 'execution');
  }
  const bytes = await readBoundedFile(target, 65_536, false);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    refuse('SUBMISSION_INVALID', '/submissionFile', 'execution');
  }
  return new Uint8Array(bytes);
}

export function stepNext(input: StepNextInput, ports: ControllerPorts = {}) {
  return result(async (): Promise<StepTickResult> => {
    const fields = Object.keys(input);
    record(input, fields);
    if (
      fields.some(key => !['configuration', 'repository', 'runRoot', 'runId', 'mode', 'reissueLease', 'environment', 'signal'].includes(key)) ||
      (input.mode !== undefined && input.mode !== 'candidate' && input.mode !== 'no-change') ||
      (input.reissueLease !== undefined && typeof input.reissueLease !== 'boolean') ||
      (input.environment !== undefined && typeof input.environment !== 'function') ||
      (input.signal !== undefined && !(input.signal instanceof AbortSignal))
    ) {
      refuse('CONFIG_SCHEMA', '', 'admission');
    }
    validateGateUrlOverrides(ports.gateUrlOverrides, 'admission');
    if (input.signal?.aborted) refuse('CANCELLED', '', 'admission');

    const root = resolve(text(input.runRoot));
    const runId = id(input.runId);
    const directory = join(root, runId);
    const exists = await lstat(directory).then(() => true, () => false);

    if (!exists) {
      if (!input.configuration || input.repository === undefined) refuse('CONFIG_SCHEMA', '', 'admission');
      const compiled = await compilePlan(input.configuration);
      if (!compiled.ok) throw new ControllerFailure(compiled.error);
      validateGateUrlOverrides(ports.gateUrlOverrides, 'admission', input.configuration.registry.spec.gateEndpoints);
      if (input.mode === 'no-change' && !compiled.value.noChangeEligibility.available) {
        refuse('CAPABILITY_UNSUPPORTED', '/mode', 'admission');
      }
      const context = await createCycle(
        {
          configuration: input.configuration,
          repository: input.repository,
          runRoot: input.runRoot,
          runId: input.runId,
          ...(input.signal ? { signal: input.signal } : {}),
        },
        ports,
      );
      await writeAtomicPrivateJson(
        join(context.directory, 'step-meta.json'),
        {
          version: 1,
          mode: input.mode ?? 'candidate',
        } satisfies StepMetaRecord,
        context.artifacts.vault,
      );
      const view = stateValue(context.store.inspect());
      const expiredAtStart =
        (view.clock.remainingTaskMs.safeValue ?? 0) <= 0 ||
        BigInt(view.clock.sampledNow.monotonicMs) >= BigInt(view.clock.basis.taskDeadlineMonotonicMs) - BigInt(context.plan.controls.drainReserveMs);
      if (expiredAtStart) {
        const initialManifestRef = await context.artifacts.json('manifest', context.source.manifest, 32_768);
        return await settleForcedStepRun(
          context,
          null,
          { manifest: context.source.manifest, ref: initialManifestRef, files: context.source.artifacts, baselineProofs: context.source.baselineProofs },
          null,
          input.runRoot,
          'expired',
        );
      }
      return await runStepTickWithCycle(context, input.runRoot);
    }

    const reopened = await reopenStepContext({
      runRoot: input.runRoot,
      runId: input.runId,
      ...(input.configuration ? { configuration: input.configuration } : {}),
      ...(input.repository !== undefined ? { repository: input.repository } : {}),
      ...(input.environment ? { environment: input.environment } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ports,
      phase: 'execution',
    });
    const { context, head, candidate, submission, decision, expired } = reopened;

    if (input.mode !== undefined) {
      const existingMeta = await readStepMeta(context.directory).catch(async error => {
        stateValue(context.store.release(context.authority));
        stateValue(context.store.close());
        await context.owner.release();
        throw error;
      });
      if (input.mode !== existingMeta.mode) {
        stateValue(context.store.release(context.authority));
        stateValue(context.store.close());
        await context.owner.release();
        refuse('RECOVERY_REQUIRED', '/mode', 'execution');
      }
    }

    if (decision === 'terminal') {
      try {
        return await retainedPrimary(context, head!);
      } finally {
        stateValue(context.store.release(context.authority));
        stateValue(context.store.close());
        await context.owner.release();
      }
    }

    if (decision === 'reconcile_required') {
      return await settleForcedStepRun(context, head, candidate, submission, input.runRoot, 'reconcile_required');
    }

    if (expired) {
      return await settleForcedStepRun(context, head, candidate, submission, input.runRoot, 'expired');
    }

    const active = head?.progress.attempts.at(-1);
    const activeNode = active ? context.plan.orderedDAG.find(node => node.id === active.nodeId) : undefined;
    const activeRole = activeNode?.roleId ? context.plan.roles.find(role => role.roleId === activeNode.roleId) : undefined;

    if (head?.progress.stage.kind === 'role_pre' && active && active.finished === null && activeRole?.adapter === 'delegated' && decision !== 'adopt_capture') {
      if (!input.reissueLease) {
        stateValue(context.store.release(context.authority));
        stateValue(context.store.close());
        await context.owner.release();
        refuse('OWNER_BUSY', '', 'execution');
      }
      const priorLease = await readStepLease(context.directory);
      const promptText = priorLease?.prompt ?? new TextDecoder('utf-8', { fatal: true }).decode(await context.artifacts.read(active.command, 1_048_576));
      const contextFiles = priorLease?.contextFiles ?? [];
      const newToken = randomBytes(32).toString('hex');
      await writeAtomicPrivateJson(
        join(context.directory, 'step-lease.json'),
        {
          version: 1,
          runId: context.lock.spec.runId,
          attemptId: active.id,
          ordinal: active.ordinal,
          leaseDigest: hash(newToken).hex,
          prompt: promptText,
          contextFiles,
        } satisfies StepLeaseRecord,
        context.artifacts.vault,
      );
      const effectiveRole = active.repair === 'format' ? { ...activeRole, policy: formatPolicy(activeRole.policy) } : activeRole;
      const cycle = new Cycle(context, head, candidate, false);
      const stepYield = buildStepYield(cycle, input.runRoot, active, effectiveRole, promptText, contextFiles, newToken);
      await cycle.deadline.dispose();
      await cycle.events.suspend();
      stateValue(context.store.release(context.authority));
      stateValue(context.store.close());
      await context.owner.release();
      return stepYield;
    }

    return await runStepTickWithCycle(context, input.runRoot, {
      head,
      candidate,
      submission,
      adopt: decision === 'adopt_capture',
    });
  }, 'execution');
}

export function stepSubmit(input: StepSubmitInput, ports: ControllerPorts = {}) {
  return result(async (): Promise<StepTickResult> => {
    const fields = Object.keys(input);
    record(input, fields);
    if (
      fields.some(key => !['runRoot', 'runId', 'leaseToken', 'submissionFile', 'status', 'reason', 'environment', 'signal'].includes(key)) ||
      (input.status !== undefined && !['completed', 'no_change', 'failed', 'blocked'].includes(input.status)) ||
      (input.reason !== undefined && typeof input.reason !== 'string') ||
      (input.submissionFile !== undefined && typeof input.submissionFile !== 'string') ||
      (input.environment !== undefined && typeof input.environment !== 'function') ||
      (input.signal !== undefined && !(input.signal instanceof AbortSignal))
    ) {
      refuse('CONFIG_SCHEMA', '', 'execution');
    }
    validateGateUrlOverrides(ports.gateUrlOverrides, 'execution');
    if (input.signal?.aborted) refuse('CANCELLED', '', 'execution');

    const reopened = await reopenStepContext({
      runRoot: input.runRoot,
      runId: input.runId,
      ...(input.environment ? { environment: input.environment } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ports,
      phase: 'execution',
    });
    const { context, head, candidate, submission, decision, expired } = reopened;

    if (expired) {
      return await settleForcedStepRun(context, head, candidate, submission, input.runRoot, 'expired');
    }

    const releaseAndRefuse = async (code: ControllerDiagnostic['code'], path = '', phase: ControllerDiagnostic['phase'] = 'execution'): Promise<never> => {
      stateValue(context.store.release(context.authority));
      stateValue(context.store.close());
      await context.owner.release();
      refuse(code, path, phase);
    };

    if (decision === 'terminal' || decision === 'reconcile_required') {
      return await releaseAndRefuse('AUTHORITY_REFUSED', '/leaseToken', 'execution');
    }

    const active = head?.progress.attempts.at(-1);
    const activeNode = active ? context.plan.orderedDAG.find(node => node.id === active.nodeId) : undefined;
    const originalRole = activeNode?.roleId ? context.plan.roles.find(role => role.roleId === activeNode.roleId) : undefined;
    if (!head || head.progress.stage.kind !== 'role_pre' || !active || active.finished !== null || !originalRole || originalRole.adapter !== 'delegated') {
      return await releaseAndRefuse('AUTHORITY_REFUSED', '/leaseToken', 'execution');
    }

    const lease = await readStepLease(context.directory);
    try {
      verifyLeaseToken(lease, context.lock.spec.runId, active.id, active.ordinal, input.leaseToken);
    } catch {
      return await releaseAndRefuse('AUTHORITY_REFUSED', '/leaseToken', 'execution');
    }

    const role: PlannedRole = active.repair === 'format' ? { ...originalRole, policy: formatPolicy(originalRole.policy) } : originalRole;
    const disallowMutations =
      active.repair === 'format' ||
      !role.policy.tools.some(tool => tool === 'write' || tool === 'edit' || tool === 'delete' || tool === 'bash');
    const candidateDir = join(resolve(input.runRoot), 'workspaces', context.lock.spec.runId, active.id, 'candidate');

    let scanned: Awaited<ReturnType<typeof scanCandidateDirectory>>;
    let explicitSubmissionBytes: Uint8Array | null = null;
    try {
      scanned = await scanCandidateDirectory(candidateDir, context.source, head.progress.candidate.digest, disallowMutations);
      if (input.submissionFile !== undefined) {
        explicitSubmissionBytes = await readExplicitSubmissionFile(input.submissionFile);
      }
    } catch (error) {
      stateValue(context.store.release(context.authority));
      stateValue(context.store.close());
      await context.owner.release();
      throw error;
    }

    const meta = await readStepMeta(context.directory);
    const unchangedFromBaseline = same(scanned.manifest, context.source.manifest);
    const effectiveStatus: 'completed' | 'no_change' | 'failed' | 'blocked' =
      input.status ?? (meta.mode === 'no-change' && unchangedFromBaseline ? 'no_change' : 'completed');
    const effectiveReason = input.reason ?? (effectiveStatus === 'failed' || effectiveStatus === 'blocked' ? 'delegated_' + effectiveStatus : null);

    let assistantText: string | null = null;
    let submissionBytes: Uint8Array | null = null;
    const artifactSubmissionFile =
      context.plan.controls.submission.path === null ? undefined : scanned.files.find(file => file.name === context.plan.controls.submission.path);
    const ignoreArtifactPath =
      disallowMutations || explicitSubmissionBytes !== null || input.status !== undefined || input.reason !== undefined;

    if (explicitSubmissionBytes !== null) {
      assistantText = new TextDecoder('utf-8', { fatal: true }).decode(explicitSubmissionBytes);
      submissionBytes = explicitSubmissionBytes;
    } else if (artifactSubmissionFile === undefined || active.repair === 'format' || ignoreArtifactPath) {
      const checkStatus =
        effectiveStatus === 'completed' || effectiveStatus === 'no_change'
          ? ('passed' as const)
          : effectiveStatus === 'blocked'
            ? ('blocked' as const)
            : ('failed' as const);
      const checkReason = checkStatus === 'passed' ? null : (effectiveReason ?? 'check_not_satisfied');
      const synthetic: Submission = {
        version: 1,
        status: effectiveStatus,
        checks: context.plan.task.spec.acceptance.checks.map(check => ({
          checkId: check.id,
          status: checkStatus,
          evidenceId: null,
          reason: checkReason,
        })),
        reason: effectiveReason,
      };
      assistantText = canonical(synthetic);
      submissionBytes = new Uint8Array(Buffer.from(assistantText, 'utf8'));
    }

    const payload: DelegatedCapturePayload = {
      format: 'delegated-capture.v1',
      version: 1,
      baseRevision: context.plan.task.spec.target.baseRevision,
      sourceRevision: context.plan.task.spec.target.sourceRevision,
      overlay: scanned.overlay,
      deleted: scanned.deleted,
      assistantText,
      status: effectiveStatus,
      reason: effectiveReason,
    };

    try {
      const canonicalManifest = identifyManifest(canonicalizeCandidateManifest(scanned.manifest));
      if (!canonicalManifest.ok || Buffer.byteLength(canonical(canonicalManifest.value.manifest), 'utf8') > 32_768) {
        refuse('OUTPUT_LIMIT', '', 'execution');
      }
      assertCanonicalMinimalOverlay(canonicalManifest.value.manifest, scanned.files, context.source, 'execution');
      const subject = bindSubject(context.lock, canonicalManifest.value.manifest);
      if (!subject.ok) refuse('ARTIFACT_INVALID', '', 'execution');
      const changed = !same(subject.value.candidateDigest, head.progress.candidate.digest);
      const nextGeneration = head.progress.candidate.generation + (changed ? 1 : 0);
      if (nextGeneration >= context.plan.capacity.V) refuse('ATTEMPT_LIMIT', '', 'execution');
      const payloadBytes = Buffer.from(canonical(payload), 'utf8');
      if (payloadBytes.byteLength > 8_388_608) refuse('OUTPUT_LIMIT', '', 'execution');
      context.artifacts.vault.assertClean(payloadBytes);
      if (submissionBytes !== null) {
        if (submissionBytes.byteLength > 1_048_576) refuse('OUTPUT_LIMIT', '', 'execution');
        context.artifacts.vault.assertClean(submissionBytes);
      }
      for (const file of scanned.files) {
        context.artifacts.vault.assertClean(file.bytes);
      }
    } catch (error) {
      stateValue(context.store.release(context.authority));
      stateValue(context.store.close());
      await context.owner.release();
      throw error;
    }

    const cycle = new Cycle(context, head, candidate, false);
    cycle.submission = submission;
    let structureFailure: ControllerDiagnostic['code'] | null;
    try {
      const captured = await captureDelegatedRole(context.store, context.authority, context.artifacts, context.lock, role, active, context.source, {
        candidateManifest: scanned.manifest,
        candidateFiles: scanned.files,
        payload,
        submissionBytes,
      });
      structureFailure = await cycle.completeCapture(active, captured, { ignoreArtifactPath });
    } catch (error) {
      await cycle.deadline.dispose().catch(() => {});
      await cycle.events.suspend().catch(() => {});
      stateValue(context.store.release(context.authority));
      stateValue(context.store.close());
      await context.owner.release();
      throw error;
    }

    await unlink(join(context.directory, 'step-lease.json')).catch(() => {});
    await rm(join(resolve(input.runRoot), 'workspaces', context.lock.spec.runId, active.id), { recursive: true, force: true }).catch(() => {});

    await cycle.deadline.dispose();
    await cycle.events.suspend();

    return await runStepTickWithCycle(
      context,
      input.runRoot,
      {
        head: cycle.head,
        candidate: cycle.candidate,
        submission: cycle.submission,
        adopt: false,
      },
      { postStructureFailure: { nodeId: active.nodeId, code: structureFailure } },
    );
  }, 'execution');
}

export function stepCancel(input: StepCancelInput, ports: ControllerPorts = {}) {
  return result(async (): Promise<RunExecution> => {
    const fields = Object.keys(input);
    record(input, fields);
    if (
      fields.some(key => !['runRoot', 'runId', 'environment'].includes(key)) ||
      (input.environment !== undefined && typeof input.environment !== 'function')
    ) {
      refuse('CONFIG_SCHEMA', '', 'execution');
    }
    validateGateUrlOverrides(ports.gateUrlOverrides, 'execution');
    const reopened = await reopenStepContext({
      runRoot: input.runRoot,
      runId: input.runId,
      ...(input.environment ? { environment: input.environment } : {}),
      ports,
      phase: 'execution',
      forceRecoveryMode: true,
    });
    if (reopened.decision === 'terminal') {
      try {
        return await retainedPrimary(reopened.context, reopened.head!);
      } finally {
        stateValue(reopened.context.store.release(reopened.context.authority));
        stateValue(reopened.context.store.close());
        await reopened.context.owner.release();
      }
    }
    if (reopened.decision === 'reconcile_required') {
      return await settleForcedStepRun(reopened.context, reopened.head, reopened.candidate, reopened.submission, input.runRoot, 'reconcile_required');
    }
    return await settleForcedStepRun(reopened.context, reopened.head, reopened.candidate, reopened.submission, input.runRoot, 'cancelled');
  }, 'execution');
}
