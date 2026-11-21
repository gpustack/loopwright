import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { LIMITS, bindSubject, digestArtifact, digestArtifactFromMetadata, identifyManifest, isWritablePath, type ArtifactManifest, type ArtifactRef, type Digest, type TaskContract } from '@loopwright/core';
import { reopenLocalRun, type Authority, type LocalRunStore } from '@loopwright/state';
import { approvedState } from './config.js';
import { compilePlan } from './compile.js';
import { ControllerFailure, refuse, result, safeDiagnostic, type ControllerDiagnostic } from './errors.js';
import { copyVerifiedFileReadOnly, readBoundedFile, STREAM_CHUNK_BYTES } from './files.js';
import { parsePrivateJson } from './parser.js';
import { canonical, freeze, hash, id, integer, isRecord, list, record, same, text } from './schema.js';
import { ArtifactStore, privateDirectory, resolveCanonicalCasBlobPath, stateValue } from './storage.js';
import { ControllerOwner } from './ownership.js';
import {
  admitRetainedRun,
  CONSERVATIVE_LEGACY_HOST_POLICY,
  effectiveRunHostPolicy,
  hostProtectionFromPolicy,
  parsePersistedHostPolicy,
  validatePortPolicyFields,
  validatePortsAgainstHostPolicy,
} from './retained.js';
import { reconcileInterruptedOperations, restoredCandidate, retainedPrimary } from './recovery.js';
import { ProgressStore, journal, stableId, type ProgressHead } from './progress.js';
import {
  adoptDelegatedCapture,
  captureDelegatedRole,
  nativeSessionId,
  type DelegatedCaptureOverlayEntryV2,
  type DelegatedCapturePayloadV2,
} from './capture.js';
import {
  assertCanonicalMinimalOverlay,
  attachVerifiedCasSeal,
  canonicalizeCandidateManifest,
  compareUtf16,
  isHostProtectedPath,
  matchesScopePattern,
  materializeBaseline,
  overlayManifestBounds,
  restoreSource,
  type FrozenSource,
  type HostPathProtectionOptions,
} from './source.js';
import { isVerdictStep, normalizeSubmission, validateStepVerdictObject, type RetainedSubmission, type Submission } from './submission.js';
import { evaluateControllerAcceptance, type AcceptanceObservation } from './acceptance.js';
import { descendants, nextNode } from './scheduler.js';
import { formatPolicy, reworkPrompt } from './repair.js';
import { countDelegatedBudgets, observeParentExhaustion, storeFactsCertain, refuseFromRoleOutcome } from './budget-observations.js';
import { validateGateUrlOverrides } from './gate.js';
import { appendHandoffPromptBlock, materializeContextFilesDir } from './handoff.js';
import { createCycle, Cycle, normalizeWatchedPaths, roleResourcesFor, type ControllerPorts, type CycleContext } from './controller.js';
import { incident, type ControllerIncident } from './finalize.js';
import {
  CONTROLLER_LIMITS,
  type AttemptHandoffExtract,
  type CasCandidateFile,
  type CompiledPlan,
  type ControllerAttempt,
  type ControllerPolicyProfile,
  type CycleExecution,
  type DelegatedSelection,
  type LoadedConfiguration,
  type PersistedHostPolicy,
  type PlannedRole,
  type StepMcpServerMetadata,
  type StepVerdict,
  type StepYield,
} from './types.js';

export type RunExecution = CycleExecution;
export type StepTickResult = StepYield | RunExecution;

export interface StepNextInput {
  readonly configuration?: LoadedConfiguration;
  readonly repository?: string;
  readonly runRoot: string;
  readonly runId: string;
  readonly mode?: 'candidate' | 'no-change';
  readonly reissueLease?: boolean;
  readonly policyProfile?: ControllerPolicyProfile | undefined;
  readonly allowWorkflowWrites?: boolean | undefined;
  readonly roleMcpServers?: Readonly<Record<string, readonly string[]>>;
  readonly mcpServers?: readonly StepMcpServerMetadata[];
  readonly watchedPaths?: readonly string[] | undefined;
  readonly environment?: (name: string) => string | undefined;
  readonly signal?: AbortSignal;
}

export interface StepSubmitInput {
  readonly runRoot: string;
  readonly runId: string;
  readonly leaseToken: string;
  readonly submissionFile?: string;
  readonly verdict?: StepVerdict;
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
  readonly allowWorkflowWrites?: boolean;
  readonly hostPolicy: PersistedHostPolicy;
  readonly roleMcpServers?: Readonly<Record<string, readonly string[]>>;
  readonly mcpServers?: readonly StepMcpServerMetadata[];
  readonly watchedPaths?: readonly string[];
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

function isWritableCandidateFile(
  name: string,
  scope: CompiledPlan['scope'],
  hostProtection: HostPathProtectionOptions,
): boolean {
  if (isHostProtectedPath(name, hostProtection)) return false;
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

function normalizeRoleMcpServers(
  raw: unknown,
  phase: ControllerDiagnostic['phase'],
): Readonly<Record<string, readonly string[]>> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) refuse('CONFIG_SCHEMA', '/roleMcpServers', phase);
  const keys = Object.keys(raw);
  if (keys.length > 16) refuse('CONFIG_LIMIT', '/roleMcpServers', phase);
  const out: Record<string, readonly string[]> = {};
  for (const key of keys) {
    id(key, '/roleMcpServers');
    const servers = list(raw[key], '/roleMcpServers/' + key, 32).map(s => id(s, '/roleMcpServers/' + key));
    out[key] = freeze([...new Set(servers)]);
  }
  return freeze(out);
}

function normalizeMcpServersMetadata(
  raw: unknown,
  phase: ControllerDiagnostic['phase'],
): readonly StepMcpServerMetadata[] | undefined {
  if (raw === undefined) return undefined;
  const items = list(raw, '/mcpServers', 32).map((item, idx) => {
    const fields = record(item, ['id', 'transport', 'toolNames'], `/mcpServers/${idx}`);
    const srvId = id(fields.id, `/mcpServers/${idx}/id`);
    const transportRaw = text(fields.transport, `/mcpServers/${idx}/transport`, 16);
    if (transportRaw !== 'stdio' && transportRaw !== 'http') refuse('CONFIG_SCHEMA', `/mcpServers/${idx}/transport`, phase);
    const transport: 'stdio' | 'http' = transportRaw;
    const toolNames = list(fields.toolNames, `/mcpServers/${idx}/toolNames`, 128).map(t => text(t, `/mcpServers/${idx}/toolNames`, 128));
    return freeze({ id: srvId, transport, toolNames: freeze(toolNames) });
  });
  return freeze(items);
}

async function readStepMeta(
  directory: string,
  expectedHostPolicy: PersistedHostPolicy = CONSERVATIVE_LEGACY_HOST_POLICY,
): Promise<StepMetaRecord> {
  const path = join(directory, 'step-meta.json');
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const hostPolicy = expectedHostPolicy;
      return freeze({
        version: 1,
        mode: 'candidate',
        hostPolicy,
        ...(hostPolicy.allowWorkflowWrites ? { allowWorkflowWrites: true } : {}),
      });
    }
    refuse('RECOVERY_REQUIRED', '', 'recovery');
  }
  let bytes: Buffer;
  let parsed: unknown;
  try {
    bytes = await readBoundedFile(path, 65_536, true);
    parsed = parsePrivateJson(bytes, 65_536);
  } catch {
    refuse('RECOVERY_REQUIRED', '', 'recovery');
  }
  if (!isRecord(parsed)) refuse('RECOVERY_REQUIRED', '', 'recovery');
  const hasHostPolicy = Object.hasOwn(parsed, 'hostPolicy') && parsed.hostPolicy !== undefined;
  const hasPolicyProfile = Object.hasOwn(parsed, 'policyProfile') && parsed.policyProfile !== undefined;
  const allowedKeys = [
    'version',
    'mode',
    ...(hasHostPolicy ? ['hostPolicy' as const] : []),
    ...(hasPolicyProfile ? ['policyProfile' as const] : []),
    ...(Object.hasOwn(parsed, 'allowWorkflowWrites') ? ['allowWorkflowWrites' as const] : []),
    ...(Object.hasOwn(parsed, 'roleMcpServers') ? ['roleMcpServers' as const] : []),
    ...(Object.hasOwn(parsed, 'mcpServers') ? ['mcpServers' as const] : []),
    ...(Object.hasOwn(parsed, 'watchedPaths') ? ['watchedPaths' as const] : []),
  ];
  const raw = record(parsed, allowedKeys);
  if (raw.version !== 1 || (raw.mode !== 'candidate' && raw.mode !== 'no-change')) refuse('RECOVERY_REQUIRED', '', 'recovery');
  if (raw.allowWorkflowWrites !== undefined && typeof raw.allowWorkflowWrites !== 'boolean') refuse('RECOVERY_REQUIRED', '', 'recovery');
  if (hasPolicyProfile && raw.policyProfile !== 'local' && raw.policyProfile !== 'github') {
    refuse('RECOVERY_REQUIRED', '/policyProfile', 'recovery');
  }
  let hostPolicy: PersistedHostPolicy;
  if (hasHostPolicy) {
    hostPolicy = parsePersistedHostPolicy(raw.hostPolicy, '/hostPolicy', 'recovery');
    if (hasPolicyProfile && raw.policyProfile !== hostPolicy.policyProfile) {
      refuse('RECOVERY_REQUIRED', '/policyProfile', 'recovery');
    }
    if (raw.allowWorkflowWrites !== undefined && raw.allowWorkflowWrites !== hostPolicy.allowWorkflowWrites) {
      refuse('RECOVERY_REQUIRED', '/allowWorkflowWrites', 'recovery');
    }
  } else if (hasPolicyProfile) {
    hostPolicy = freeze({
      policyProfile: raw.policyProfile as ControllerPolicyProfile,
      allowWorkflowWrites: raw.allowWorkflowWrites === true,
    });
  } else {
    if (raw.allowWorkflowWrites === true) {
      refuse('RECOVERY_REQUIRED', '/allowWorkflowWrites', 'recovery');
    }
    // Legacy step-meta.json omitting hostPolicy/policyProfile defaults conservatively to 'github' with allowWorkflowWrites: false.
    hostPolicy = CONSERVATIVE_LEGACY_HOST_POLICY;
  }
  if (!same(expectedHostPolicy, hostPolicy)) {
    refuse('RECOVERY_REQUIRED', '/hostPolicy', 'recovery');
  }
  const roleMcpServers = normalizeRoleMcpServers(raw.roleMcpServers, 'recovery');
  const mcpServers = normalizeMcpServersMetadata(raw.mcpServers, 'recovery');
  const watchedPaths = normalizeWatchedPaths(raw.watchedPaths, 'recovery');
  return freeze({
    version: 1,
    mode: raw.mode,
    hostPolicy,
    ...(hostPolicy.allowWorkflowWrites ? { allowWorkflowWrites: true } : {}),
    ...(roleMcpServers !== undefined ? { roleMcpServers } : {}),
    ...(mcpServers !== undefined ? { mcpServers } : {}),
    ...(watchedPaths !== undefined ? { watchedPaths } : {}),
  });
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
    ordinal: integer(raw.ordinal, 1, 256),
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

async function cleanupRunWorkspaces(
  runRoot: string,
  runId: string,
  directory: string,
  artifacts?: ArtifactStore,
): Promise<void> {
  await unlink(join(directory, 'step-lease.json')).catch(() => {});
  await rm(join(resolve(runRoot), 'workspaces', runId), { recursive: true, force: true }).catch(() => {});
  if (artifacts) {
    await artifacts.cleanCasTempFiles().catch(() => {});
  }
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
      const bounds = overlayManifestBounds(context.plan.budgets.overlay);
      const maxWsBytes = Math.max(bounds.v2WorkspaceJsonMaxBytes, bounds.workspaceMaxBytes);
      const wsBytes = await context.artifacts.read(head.progress.candidate.workspace, maxWsBytes);
      const parsed = parsePrivateJson(Buffer.from(wsBytes), maxWsBytes, bounds.collectionLimit);
      if (isRecord(parsed) && (parsed.format === 'delegated-capture.v1' || parsed.format === 'delegated-capture.v2') && Array.isArray(parsed.overlay)) {
        for (const item of parsed.overlay) {
          if (isRecord(item) && typeof item.name === 'string' && (item.mode === '100644' || item.mode === '100755')) {
            modes.set(item.name, item.mode);
          }
        }
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
  hostProtection: HostPathProtectionOptions,
  activeResources?: ReturnType<typeof roleResourcesFor>,
  handoffExtracts: readonly AttemptHandoffExtract[] = [],
  phase: ControllerDiagnostic['phase'] = 'execution',
): Promise<{ readonly candidateDir: string; readonly contextFiles: readonly string[] }> {
  const { context } = cycle;
  const { plan, loaded, source, owner, artifacts } = context;
  const state = approvedState(loaded);
  const excluded = [context.descriptor.repository, ...state.input.untrustedRoots];
  const workspacesRoot = join(resolve(runRoot), 'workspaces');
  const runWorkspaceDir = join(workspacesRoot, context.lock.spec.runId);
  const attemptWorkspaceDir = join(runWorkspaceDir, attemptId);
  const stagingWorkspaceDir = join(runWorkspaceDir, `.stage-${attemptId}-${randomBytes(6).toString('hex')}`);
  const stagingCandidateDir = join(stagingWorkspaceDir, 'candidate');
  const stagingContextDir = join(stagingWorkspaceDir, 'context');
  const candidateDir = join(attemptWorkspaceDir, 'candidate');
  const contextDir = join(attemptWorkspaceDir, 'context');

  await privateDirectory(workspacesRoot, excluded);
  await privateDirectory(runWorkspaceDir, excluded);
  await privateDirectory(stagingWorkspaceDir, excluded);
  await privateDirectory(stagingCandidateDir, excluded);
  await privateDirectory(stagingContextDir, excluded);

  try {
    const effectiveTools = repair === 'format' ? [] : role.policy.tools;
    const readOnlyRole = repair === 'format' || !effectiveTools.some(tool => tool === 'write' || tool === 'edit' || tool === 'delete' || tool === 'bash');
    const modes = await resolveCurrentFileModes(context, cycle.head);

    if (source.version === 2) {
      await materializeBaseline(source, stagingCandidateDir, owner, cycle.deadline);
      await chmod(stagingCandidateDir, 0o700);
      const deletedSet = new Set(cycle.candidate.manifest.spec.deleted ?? []);
      for (const delPath of deletedSet) {
        await rm(join(stagingCandidateDir, delPath), { force: true });
      }
      for (const item of cycle.candidate.files) {
        const targetPath = join(stagingCandidateDir, item.name);
        await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
        await rm(targetPath, { recursive: true, force: true });
        if ('bytes' in item) {
          const file = await open(targetPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
          try {
            await file.writeFile(item.bytes);
            await file.sync();
          } finally {
            await file.close();
          }
        } else {
          const canonicalBlobPath = await resolveCanonicalCasBlobPath(artifacts.directory, item.digest.hex, item.blobPath, 'execution');
          await copyVerifiedFileReadOnly(canonicalBlobPath, targetPath, {
            expectedBytes: item.byteLength,
            expectedSha256: item.digest.hex,
            mode: 0o600,
            ownedSource: true,
            requireReadOnlySource: true,
            verifyCanonicalSource: true,
            path: item.name,
            phase: 'execution',
          });
        }
      }
      const allPaths = new Set<string>();
      for (const entry of source.baselineEntries ?? []) {
        if (!deletedSet.has(entry.name)) allPaths.add(entry.name);
      }
      for (const file of cycle.candidate.files) allPaths.add(file.name);
      for (const relPath of allPaths) {
        const gitMode = modes.get(relPath) ?? '100644';
        const writable = !readOnlyRole && isWritableCandidateFile(relPath, plan.scope, hostProtection);
        const perm = gitMode === '100755' ? (writable ? 0o700 : 0o500) : (writable ? 0o600 : 0o400);
        await chmod(join(stagingCandidateDir, relPath), perm);
      }
    } else {
      for (const item of cycle.candidate.files) {
        const targetPath = join(stagingCandidateDir, item.name);
        await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
        const gitMode = modes.get(item.name) ?? '100644';
        const writable = !readOnlyRole && isWritableCandidateFile(item.name, plan.scope, hostProtection);
        const perm = gitMode === '100755' ? (writable ? 0o700 : 0o500) : (writable ? 0o600 : 0o400);
        if ('bytes' in item) {
          const file = await open(targetPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, perm);
          try {
            await file.writeFile(item.bytes);
            await file.chmod(perm);
            await file.sync();
          } finally {
            await file.close();
          }
        } else {
          const canonicalBlobPath = await resolveCanonicalCasBlobPath(artifacts.directory, item.digest.hex, item.blobPath, 'execution');
          await copyVerifiedFileReadOnly(canonicalBlobPath, targetPath, {
            expectedBytes: item.byteLength,
            expectedSha256: item.digest.hex,
            mode: perm,
            ownedSource: true,
            requireReadOnlySource: true,
            verifyCanonicalSource: true,
            path: item.name,
            phase: 'execution',
          });
        }
      }
    }

    const effectiveResources = activeResources ?? roleResourcesFor(loaded, plan, role.roleId);
    const stagedContextFiles = await materializeContextFilesDir(
      stagingContextDir,
      effectiveResources,
      handoffExtracts,
      artifacts.directory,
      phase,
    );

    await rm(attemptWorkspaceDir, { recursive: true, force: true });
    await rename(stagingWorkspaceDir, attemptWorkspaceDir);
    const contextFiles = stagedContextFiles.map(filePath => join(contextDir, relative(stagingContextDir, filePath)));
    return { candidateDir, contextFiles };
  } catch (error) {
    await rm(stagingWorkspaceDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function buildStepYield(
  cycle: Cycle,
  runRoot: string,
  attempt: ControllerAttempt,
  role: PlannedRole,
  prompt: string,
  contextFiles: readonly string[],
  leaseToken: string,
  meta: StepMetaRecord,
): Promise<StepYield> {
  const { plan, lock, ports } = cycle.context;
  const effectiveTools = attempt.repair === 'format' ? [] : role.policy.tools;
  const roleMcpMap = meta.roleMcpServers ?? ports.roleMcpServers;
  const declaredServers = meta.mcpServers ?? ports.mcpServers ?? [];
  const allowedMcpServers =
    attempt.repair === 'format'
      ? []
      : roleMcpMap !== undefined
        ? [...(roleMcpMap[role.roleId] ?? [])]
        : role.policy.mcp.names.length > 0
          ? [role.policy.mcp.serverId]
          : [];
  const mcpServers = attempt.repair === 'format' ? [] : declaredServers.filter(srv => allowedMcpServers.includes(srv.id));
  const allowWorkflowWrites = meta.hostPolicy.allowWorkflowWrites;
  const reworkEpoch = attempt.reworkEpoch ?? cycle.reworkEpoch;
  const rework = attempt.repair === 'none' ? await cycle.activeReworkForNode(attempt.nodeId) : null;
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
    allowedMcpServers,
    mcpServers,
    scope: plan.scope,
    allowWorkflowWrites,
    candidateDir,
    contextFiles: [...contextFiles],
    prompt,
    reworkEpoch,
    rework,
    submissionMode: plan.controls.submission.mode,
    submissionPath: plan.controls.submission.path,
    leaseToken,
  });
}

async function yieldDelegatedRole(
  cycle: Cycle,
  runRoot: string,
  nodeId: string,
  meta: StepMetaRecord,
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
  const attemptEpoch = cycle.reworkEpoch;
  const commandId = stableId(lock.spec.runId, nodeId, purpose, repair, ordinal);
  const sessionId = nativeSessionId(lock.spec.runId, role.roleId, nativeStepId, role.policy, attemptEpoch);
  const configured = text(loaded.registry.spec.handlers.find(handler => handler.id === node.handler.id)?.parameters.prompt);
  // Verify base handler prompt digest FIRST before evaluating or appending any runtime handoff block.
  if (node.handler.parameters.prompt !== '[private command sha256:' + hash(configured).hex + ']') refuse('RECOVERY_REQUIRED', '', 'execution');
  const preparedCtx = await cycle.prepareAttemptContext(
    nodeId,
    role,
    repair,
    purpose,
    attemptEpoch,
    meta.watchedPaths ?? cycle.context.ports.watchedPaths,
  );
  await cycle.adviseCapabilityRouting(nodeId, role, purpose, preparedCtx.activeResources);
  const maxPromptBytes = Math.min(LIMITS.inputBytes, role.policy.limits.promptBytes);
  const reworkCtx = repair === 'none' && customPrompt === undefined ? await cycle.activeReworkForNode(nodeId) : null;
  const defaultPrompt = reworkCtx ? reworkPrompt(configured, reworkCtx, Math.min(CONTROLLER_LIMITS.reworkPromptMaxBytes, role.policy.limits.promptBytes)) : configured;
  const basePrompt = customPrompt ?? defaultPrompt;
  const promptText =
    repair !== 'format' && preparedCtx.resolvedHandoffs.length > 0
      ? appendHandoffPromptBlock(basePrompt, preparedCtx.resolvedHandoffs, maxPromptBytes, 'execution')
      : basePrompt;
  const command = await artifacts.put('command', Buffer.from(promptText), maxPromptBytes);
  const originalSubmission = cycle.draft.failures.at(-1)?.evidence ?? cycle.draft.submission;
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
    ...(attemptEpoch > 0 ? { reworkEpoch: attemptEpoch } : {}),
    activatedResourceIds: preparedCtx.activatedResourceIds,
    ...(preparedCtx.handoffExtracts !== undefined ? { handoffExtracts: preparedCtx.handoffExtracts } : {}),
  };
  if (repair === 'format') {
    await artifacts.json('format-intent', {
      version: 1,
      attemptId: commandId,
      original: originalSubmission,
      schema: isVerdictStep(node) ? 'step-verdict.v1' : 'submission.v1',
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
  const hostProtection = hostProtectionFromPolicy(meta.hostPolicy);
  const { contextFiles } = await materializeAttemptWorkspace(
    cycle,
    runRoot,
    commandId,
    role,
    repair,
    hostProtection,
    preparedCtx.activeResources,
    preparedCtx.handoffExtracts ?? [],
    'execution',
  );
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
  return await buildStepYield(cycle, runRoot, attempt, role, promptText, contextFiles, leaseToken, meta);
}

async function advanceStepCycle(
  cycle: Cycle,
  runRoot: string,
  meta: StepMetaRecord,
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
          const captured = await adoptDelegatedCapture(
            cycle.context.store,
            cycle.context.artifacts,
            cycle.context.lock,
            effectiveRole,
            active,
            cycle.context.source,
            hostProtectionFromPolicy(meta.hostPolicy),
          );
          if (disallowMutations) {
            const priorModes = await resolveCurrentFileModes(cycle.context, cycle.head);
            for (const entry of captured.artifacts) {
              if (!('bytes' in entry) && entry.mode !== undefined && entry.mode !== (priorModes.get(entry.name) ?? '100644')) {
                refuse('ARTIFACT_INVALID', '', 'recovery');
              }
            }
          }
          const failure = await cycle.completeCapture(active, captured, { ignoreArtifactPath: disallowMutations });
          if (failure === 'SUBMISSION_AMBIGUOUS') refuse(failure, '', 'verification');
          if (failure === 'SUBMISSION_INVALID') {
            const prompt = await cycle.formatRepairPrompt(active.nodeId);
            return { kind: 'yield', step: await yieldDelegatedRole(cycle, runRoot, active.nodeId, meta, 'format', prompt) };
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
      await refuseFromRoleOutcome(cycle.context.artifacts, lastAttempt.finished.outcome, cycle.draft.candidate.manifest, () => cycle.markCandidateUnknown());
    }
    if (
      lastAttempt?.finished?.nativeCheckpointId &&
      lastAttempt.purpose !== 'compaction' &&
      !cycle.haltedVerdictStatus() &&
      cycle.draft.nodes.find(node => node.id === lastAttempt.nodeId)?.state === 'failed'
    ) {
      const delegatedRole = isDelegatedNode(lastAttempt.nodeId);
      if (delegatedRole) {
        const prompt = await cycle.formatRepairPrompt(lastAttempt.nodeId);
        return { kind: 'yield', step: await yieldDelegatedRole(cycle, runRoot, lastAttempt.nodeId, meta, 'format', prompt) };
      }
      await cycle.repairFormat(lastAttempt.nodeId);
    }
  }

  if (options?.postStructureFailure) {
    const { nodeId, code } = options.postStructureFailure;
    if (code === 'SUBMISSION_AMBIGUOUS') refuse(code, '', 'verification');
    if (code === 'SUBMISSION_INVALID') {
      const prompt = await cycle.formatRepairPrompt(nodeId);
      const delegatedRole = isDelegatedNode(nodeId);
      if (delegatedRole) {
        return { kind: 'yield', step: await yieldDelegatedRole(cycle, runRoot, nodeId, meta, 'format', prompt) };
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
          return { kind: 'yield', step: await yieldDelegatedRole(cycle, runRoot, node.id, meta, 'none') };
        }
        await cycle.role(node.id);
      } else {
        const slot = plan.verifierSlots.find(item => item.handler.id === node.handler.id);
        if (!slot) refuse('CAPABILITY_UNSUPPORTED', '', 'verification');
        const epochBefore = cycle.reworkEpoch;
        const checked = await cycle.runVerifier(slot.id);
        const state = checked.status === 'passed' ? 'completed' : checked.status;
        const actualState = cycle.draft.nodes.find(item => item.id === node.id)!.state;
        const validCheckRework =
          node.onRework !== undefined &&
          checked.status === 'failed' &&
          ((cycle.reworkEpoch === epochBefore + 1 && actualState === 'pending') ||
            (cycle.haltedVerdictStatus() === 'blocked' && actualState === 'blocked'));
        if (actualState !== state && !validCheckRework) refuse('RECOVERY_REQUIRED', '', 'execution');
      }
    }
    await cycle.verifyEligible();
    await cycle.ensureSubmissionForAcceptance();
    const verdictHalt = cycle.haltedVerdictStatus();
    const acceptance = evaluateControllerAcceptance(
      plan,
      cycle.context.lock,
      cycle.candidate.manifest,
      cycle.candidate.files,
      cycle.generation,
      cycle.currentChecks(),
      cycle.submission!.value,
      cycle.context.store,
      verdictHalt,
      cycle.draft.nodes.every(node => node.state === 'completed'),
      cycle.currentRefusals(),
    );
    if (verdictHalt === null && acceptance.result.spec.status === 'failed') {
      const repairSpec = await cycle.prepareImplementationRepair();
      if (repairSpec) {
        if (repairSpec.role.adapter === 'delegated') {
          return { kind: 'yield', step: await yieldDelegatedRole(cycle, runRoot, repairSpec.targetNodeId, meta, 'implementation', repairSpec.prompt) };
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
  meta: StepMetaRecord,
  restored?: {
    readonly head: ProgressHead | null;
    readonly candidate: import('./verification.js').ByteInventory;
    readonly submission: RetainedSubmission | null;
    readonly adopt: boolean;
    readonly advisoryObservations?: readonly Record<string, unknown>[];
  },
  options?: { readonly postStructureFailure?: { readonly nodeId: string; readonly code: ControllerDiagnostic['code'] | null } },
): Promise<StepTickResult> {
  const cycle = new Cycle(context, restored?.head ?? null, restored?.candidate, restored?.adopt);
  cycle.submission = restored?.submission ?? null;
  if (restored?.advisoryObservations && restored.advisoryObservations.length > 0) {
    cycle.advisoryObservations.push(...restored.advisoryObservations);
  }
  let yielded: StepYield | null = null;
  let primary: AcceptanceObservation | ControllerIncident | null = null;
  try {
    const outcome = await advanceStepCycle(cycle, runRoot, meta, options);
    if (outcome.kind === 'yield') {
      yielded = outcome.step;
    } else {
      primary = outcome.primary;
    }
  } catch (error) {
    const diagnostic = safeDiagnostic(error, 'execution');
    const facts = context.store.inspect();
    const certain = facts.ok && storeFactsCertain(facts.value);
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

  await cleanupRunWorkspaces(runRoot, context.lock.spec.runId, context.directory, context.artifacts);
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
  readonly meta: StepMetaRecord;
  readonly head: ProgressHead | null;
  readonly candidate: import('./verification.js').ByteInventory;
  readonly submission: RetainedSubmission | null;
  readonly decision: ReturnType<ProgressStore['decision']>;
  readonly expired: boolean;
}> {
  validatePortPolicyFields(input.ports, input.phase);
  const { directory, descriptor, lock, effectiveConfig, state, plan } = await admitRetainedRun({
    runRoot: input.runRoot,
    runId: input.runId,
    ...(input.configuration ? { configuration: input.configuration } : {}),
    ...(input.repository !== undefined ? { repository: input.repository } : {}),
    ...(input.environment ? { environment: input.environment } : {}),
    phase: input.phase,
  });
  const meta = await readStepMeta(directory, effectiveRunHostPolicy(descriptor));
  const effectivePorts = validatePortsAgainstHostPolicy(input.ports, meta.hostPolicy, input.phase);
  const effectiveDescriptor = descriptor.hostPolicy !== undefined ? descriptor : { ...descriptor, hostPolicy: meta.hostPolicy };
  validateGateUrlOverrides(effectivePorts.gateUrlOverrides, input.phase, effectiveConfig.registry.spec.gateEndpoints);

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
    await artifacts.cleanCasTempFiles();
    const jsonPaths = [...new Set(plan.verifierSlots.filter(slot => ['json-artifact.v1', 'json-keys-guard.v1', 'line-section-guard.v1'].includes(slot.handler.implementation)).map(slot => text(slot.handler.parameters.path)))];
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
      descriptor: effectiveDescriptor,
      signal: input.signal ?? new AbortController().signal,
      onEvent: undefined,
      ports: effectivePorts,
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
    return { context, meta, head, candidate, submission, decision, expired };
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
  await cleanupRunWorkspaces(runRoot, context.lock.spec.runId, context.directory, context.artifacts);
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
  task: TaskContract,
  previousDigest: Digest,
  previousModes: ReadonlyMap<string, '100644' | '100755'>,
  disallowMutations: boolean,
  overlayConfig: CompiledPlan['budgets']['overlay'],
  artifacts: ArtifactStore,
  hostProtection: HostPathProtectionOptions,
): Promise<{
  readonly manifest: ArtifactManifest;
  readonly files: readonly CasCandidateFile[];
  readonly overlay: readonly DelegatedCaptureOverlayEntryV2[];
  readonly deleted: readonly string[];
}> {
  const bounds = overlayManifestBounds(overlayConfig);
  const v2BaseTree = source.version === 2 ? source.manifest.spec.baseTree! : undefined;
  const v2BaselineByPath =
    source.version === 2
      ? new Map((source.baselineEntries ?? []).map(entry => [entry.name, entry]))
      : undefined;
  const v1BaselineByPath =
    source.version === 1
      ? new Map(
          source.artifacts.map(artifact => [
            artifact.name,
            { byteLength: artifact.bytes.byteLength, mode: artifact.mode ?? ('100644' as const) },
          ]),
        )
      : undefined;
  let rootStat;
  try {
    rootStat = await lstat(candidateDir);
  } catch {
    refuse('ARTIFACT_INVALID', '', 'execution');
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) refuse('ARTIFACT_INVALID', '', 'execution');

  interface ScannedRegularEntry {
    readonly absPath: string;
    readonly name: string;
    readonly mode: '100644' | '100755';
    readonly byteLength: number;
    readonly sha256: string;
    readonly gitOid?: string | undefined;
  }

  const scannedFiles: ScannedRegularEntry[] = [];
  const seenPaths = new Set<string>();
  const streamChunk = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
  const probeByte = Buffer.allocUnsafe(1);
  let entriesSeen = 0;
  let knownOverlayFiles = 0;
  let knownOverlayBytes = 0;
  let knownClassicFiles = 0;
  let knownClassicBytes = 0;

  const visit = async (absDir: string, relPrefix: string, depth: number): Promise<void> => {
    if (depth > 32) refuse('ARTIFACT_INVALID', '', 'execution');
    const dirEntries = await readdir(absDir, { withFileTypes: true });
    entriesSeen += dirEntries.length;
    if (entriesSeen > 131_072) refuse('OUTPUT_LIMIT', '', 'execution');
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

      const fh = await open(absPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let byteLength: number;
      let mode: '100644' | '100755';
      let sha256: string;
      let gitOid: string | undefined;
      let sizeChangedOrAdded = false;
      try {
        const fst = await fh.stat();
        if (fst.dev !== st.dev || fst.ino !== st.ino || fst.nlink !== 1 || !fst.isFile() || fst.size !== st.size) {
          refuse('ARTIFACT_INVALID', '', 'execution');
        }
        if (source.version === 2) {
          const baseEntry = v2BaselineByPath!.get(relPath);
          sizeChangedOrAdded = baseEntry === undefined || baseEntry.byteLength !== fst.size;
          if (sizeChangedOrAdded) {
            if (isHostProtectedPath(relPath, hostProtection)) {
              refuse('ARTIFACT_INVALID', '', 'execution');
            }
            if (
              fst.size > bounds.perFileMaxBytes ||
              knownOverlayFiles + 1 > bounds.maxFiles ||
              knownOverlayBytes + fst.size > bounds.maxBytes
            ) {
              refuse('OUTPUT_LIMIT', '', 'execution');
            }
            knownOverlayFiles += 1;
            knownOverlayBytes += fst.size;
          }
        } else {
          const baseEntry = v1BaselineByPath!.get(relPath);
          const observedMode: '100644' | '100755' = (fst.mode & 0o111) !== 0 ? '100755' : '100644';
          if (
            (baseEntry === undefined || baseEntry.byteLength !== fst.size || baseEntry.mode !== observedMode)
            && isHostProtectedPath(relPath, hostProtection)
          ) {
            refuse('ARTIFACT_INVALID', '', 'execution');
          }
          if (
            fst.size > bounds.perFileMaxBytes ||
            knownClassicFiles + 1 > bounds.maxFiles ||
            knownClassicBytes + fst.size > bounds.maxBytes
          ) {
            refuse('OUTPUT_LIMIT', '', 'execution');
          }
          knownClassicFiles += 1;
          knownClassicBytes += fst.size;
        }
        const shaHasher = createHash('sha256');
        const gitHasher =
          v2BaseTree !== undefined
            ? createHash(v2BaseTree.objectFormat === 'sha256' ? 'sha256' : 'sha1').update(`blob ${fst.size}\0`, 'utf8')
            : null;
        let offset = 0;
        while (offset < fst.size) {
          const toRead = Math.min(streamChunk.length, fst.size - offset);
          const { bytesRead } = await fh.read(streamChunk, 0, toRead, offset);
          if (bytesRead <= 0) break;
          const slice = streamChunk.subarray(0, bytesRead);
          shaHasher.update(slice);
          gitHasher?.update(slice);
          offset += bytesRead;
        }
        const { bytesRead: extraBytes } = await fh.read(probeByte, 0, 1, offset);
        const after = await fh.stat();
        if (
          extraBytes !== 0 ||
          offset !== fst.size ||
          after.dev !== fst.dev ||
          after.ino !== fst.ino ||
          after.nlink !== 1 ||
          !after.isFile() ||
          after.size !== fst.size ||
          after.mtimeMs !== fst.mtimeMs ||
          after.ctimeMs !== fst.ctimeMs
        ) {
          refuse('ARTIFACT_INVALID', '', 'execution');
        }
        byteLength = fst.size;
        mode = (fst.mode & 0o111) !== 0 ? '100755' : '100644';
        sha256 = shaHasher.digest('hex');
        gitOid = gitHasher?.digest('hex');
      } finally {
        await fh.close();
      }
      if (source.version === 2 && !sizeChangedOrAdded) {
        const baseEntry = v2BaselineByPath!.get(relPath);
        if (baseEntry !== undefined && gitOid !== baseEntry.oid) {
          if (isHostProtectedPath(relPath, hostProtection)) {
            refuse('ARTIFACT_INVALID', '', 'execution');
          }
          if (
            byteLength > bounds.perFileMaxBytes ||
            knownOverlayFiles + 1 > bounds.maxFiles ||
            knownOverlayBytes + byteLength > bounds.maxBytes
          ) {
            refuse('OUTPUT_LIMIT', '', 'execution');
          }
          knownOverlayFiles += 1;
          knownOverlayBytes += byteLength;
        }
      }
      seenPaths.add(relPath);
      scannedFiles.push({ absPath, name: relPath, mode, byteLength, sha256, gitOid });
    }
  };

  await visit(candidateDir, '', 1);
  scannedFiles.sort((a, b) => compareUtf16(a.name, b.name));

  if (source.version === 2) {
    const baseTree = v2BaseTree!;
    const baselineByPath = v2BaselineByPath!;
    const deleted: string[] = [];
    for (const baseEntry of source.baselineEntries ?? []) {
      if (!seenPaths.has(baseEntry.name)) {
        if (isHostProtectedPath(baseEntry.name, hostProtection)) refuse('ARTIFACT_INVALID', '', 'execution');
        deleted.push(baseEntry.name);
      }
    }
    deleted.sort(compareUtf16);
    const overlay: DelegatedCaptureOverlayEntryV2[] = [];
    const files: CasCandidateFile[] = [];
    const manifestEntries: ArtifactRef[] = [];
    let totalOverlayBytes = 0;
    for (const file of scannedFiles) {
      const baseEntry = baselineByPath.get(file.name);
      const expectedMode = previousModes.get(file.name) ?? baseEntry?.mode ?? '100644';
      if (baseEntry && file.gitOid === baseEntry.oid) {
        if (file.mode !== expectedMode) {
          refuse('ARTIFACT_INVALID', '', 'execution');
        }
        continue;
      }
      if (disallowMutations && file.mode !== expectedMode) {
        refuse('ARTIFACT_INVALID', '', 'execution');
      }
      const effectiveMode = disallowMutations ? expectedMode : file.mode;
      if (isHostProtectedPath(file.name, hostProtection)) refuse('ARTIFACT_INVALID', '', 'execution');
      if (
        file.byteLength > bounds.perFileMaxBytes ||
        overlay.length >= bounds.maxFiles ||
        (totalOverlayBytes += file.byteLength) > bounds.maxBytes
      ) {
        refuse('OUTPUT_LIMIT', '', 'execution');
      }
      const pointer = await artifacts.putCasBlobFromFile(file.name, file.absPath, bounds.perFileMaxBytes, {
        gitObjectFormat: baseTree.objectFormat,
      });
      if (
        pointer.sha256 !== file.sha256
        || pointer.byteLength !== file.byteLength
        || (pointer.verifiedSeal !== undefined && file.gitOid !== undefined && pointer.verifiedSeal.gitOid !== file.gitOid)
      ) {
        refuse('ARTIFACT_INVALID', '', 'execution');
      }
      const ref = digestArtifactFromMetadata(file.name, {
        digest: { algorithm: 'sha256', hex: pointer.sha256 },
        byteLength: pointer.byteLength,
      });
      if (!ref.ok) refuse('ARTIFACT_INVALID', '', 'execution');
      overlay.push({
        name: file.name,
        mode: effectiveMode,
        sha256: pointer.sha256,
        byteLength: pointer.byteLength,
        blobRef: pointer.blobRef,
      });
      const casFile: CasCandidateFile = {
        name: file.name,
        byteLength: pointer.byteLength,
        digest: ref.value.digest,
        blobPath: pointer.path,
        mode: effectiveMode,
      };
      if (pointer.verifiedSeal !== undefined) {
        attachVerifiedCasSeal(casFile, pointer.verifiedSeal);
      }
      files.push(casFile);
      manifestEntries.push(ref.value);
    }
    const identified = identifyManifest(
      canonicalizeCandidateManifest({
        apiVersion: 'loopwright.dev/v1alpha1',
        kind: 'ArtifactManifest',
        metadata: { id: 'candidate' },
        spec: { baseTree, entries: manifestEntries, deleted },
      }),
      bounds.options,
    );
    if (!identified.ok) refuse('ARTIFACT_INVALID', '', 'execution');
    if (disallowMutations && !same(identified.value.digest, previousDigest)) {
      refuse('ARTIFACT_INVALID', '', 'execution');
    }
    return { manifest: identified.value.manifest, files, overlay, deleted };
  }

  // source.version === 1 (classic mode)
  if (scannedFiles.length > bounds.maxFiles) refuse('OUTPUT_LIMIT', '', 'execution');
  let totalBytes = 0;
  const baselineByPath = new Map(
    source.artifacts.map(item => [
      item.name,
      { byteLength: item.bytes.byteLength, sha256: hash(item.bytes).hex, mode: item.mode ?? ('100644' as const) },
    ]),
  );
  const scannedNames = new Set(scannedFiles.map(item => item.name));
  const deleted: string[] = [];
  for (const baseName of baselineByPath.keys()) {
    if (!scannedNames.has(baseName)) {
      if (isHostProtectedPath(baseName, hostProtection)) refuse('ARTIFACT_INVALID', '', 'execution');
      deleted.push(baseName);
    }
  }
  deleted.sort(compareUtf16);
  const overlay: DelegatedCaptureOverlayEntryV2[] = [];
  const files: CasCandidateFile[] = [];
  const manifestEntries: ArtifactRef[] = [];
  for (const file of scannedFiles) {
    const baseInfo = baselineByPath.get(file.name);
    const expectedMode = previousModes.get(file.name) ?? baseInfo?.mode ?? '100644';
    if (disallowMutations && file.mode !== expectedMode) {
      refuse('ARTIFACT_INVALID', '', 'execution');
    }
    const effectiveMode = disallowMutations ? expectedMode : file.mode;
    const modeChangedFromBaseline = baseInfo !== undefined && baseInfo.mode !== effectiveMode;
    const modifiedOrAdded =
      baseInfo === undefined
      || baseInfo.byteLength !== file.byteLength
      || baseInfo.sha256 !== file.sha256
      || modeChangedFromBaseline;
    if (modifiedOrAdded && isHostProtectedPath(file.name, hostProtection)) {
      refuse('ARTIFACT_INVALID', '', 'execution');
    }
    if (modeChangedFromBaseline) {
      if (baseInfo.byteLength === file.byteLength && baseInfo.sha256 === file.sha256) {
        refuse('ARTIFACT_INVALID', '', 'execution');
      }
      const writable = isWritablePath(task, file.name);
      if (!writable.ok || !writable.value) {
        refuse('ARTIFACT_INVALID', '', 'execution');
      }
    }
    if (file.byteLength > bounds.perFileMaxBytes || (totalBytes += file.byteLength) > bounds.maxBytes) {
      refuse('OUTPUT_LIMIT', '', 'execution');
    }
    const pointer = !modifiedOrAdded
      ? (await artifacts.tryReuseCasBlob(file.name, file.sha256, file.byteLength))
        ?? await artifacts.putCasBlobFromFile(file.name, file.absPath, bounds.perFileMaxBytes)
      : await artifacts.putCasBlobFromFile(file.name, file.absPath, bounds.perFileMaxBytes);
    if (pointer.sha256 !== file.sha256 || pointer.byteLength !== file.byteLength) {
      refuse('ARTIFACT_INVALID', '', 'execution');
    }
    const ref = digestArtifactFromMetadata(file.name, {
      digest: { algorithm: 'sha256', hex: pointer.sha256 },
      byteLength: pointer.byteLength,
    });
    if (!ref.ok) refuse('ARTIFACT_INVALID', '', 'execution');
    overlay.push({
      name: file.name,
      mode: effectiveMode,
      sha256: pointer.sha256,
      byteLength: pointer.byteLength,
      blobRef: pointer.blobRef,
    });
    files.push({
      name: file.name,
      byteLength: pointer.byteLength,
      digest: ref.value.digest,
      blobPath: pointer.path,
      mode: effectiveMode,
    });
    manifestEntries.push(ref.value);
  }
  const identified = identifyManifest(
    canonicalizeCandidateManifest({
      apiVersion: 'loopwright.dev/v1alpha1',
      kind: 'ArtifactManifest',
      metadata: { id: 'candidate' },
      spec: { entries: manifestEntries },
    }),
    bounds.options,
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
      fields.some(
        key =>
          !['configuration', 'repository', 'runRoot', 'runId', 'mode', 'reissueLease', 'policyProfile', 'allowWorkflowWrites', 'roleMcpServers', 'mcpServers', 'watchedPaths', 'environment', 'signal'].includes(key),
      ) ||
      (input.mode !== undefined && input.mode !== 'candidate' && input.mode !== 'no-change') ||
      (input.reissueLease !== undefined && typeof input.reissueLease !== 'boolean') ||
      (input.policyProfile !== undefined && input.policyProfile !== 'local' && input.policyProfile !== 'github') ||
      (input.allowWorkflowWrites !== undefined && typeof input.allowWorkflowWrites !== 'boolean') ||
      (input.environment !== undefined && typeof input.environment !== 'function') ||
      (input.signal !== undefined && !(input.signal instanceof AbortSignal))
    ) {
      refuse('CONFIG_SCHEMA', '', 'admission');
    }
    validatePortPolicyFields(ports, 'admission');
    if (input.policyProfile !== undefined && ports.policyProfile !== undefined && input.policyProfile !== ports.policyProfile) {
      refuse('CONFIG_SCHEMA', '/policyProfile', 'admission');
    }
    if (input.allowWorkflowWrites !== undefined && ports.allowWorkflowWrites !== undefined && input.allowWorkflowWrites !== ports.allowWorkflowWrites) {
      refuse('CONFIG_SCHEMA', '/allowWorkflowWrites', 'admission');
    }
    const normalizedRoleMcp = normalizeRoleMcpServers(input.roleMcpServers ?? ports.roleMcpServers, 'admission');
    const normalizedMcpServers = normalizeMcpServersMetadata(input.mcpServers ?? ports.mcpServers, 'admission');
    const normalizedWatched = normalizeWatchedPaths(input.watchedPaths ?? ports.watchedPaths, 'admission');
    validateGateUrlOverrides(ports.gateUrlOverrides, 'admission');
    if (input.signal?.aborted) refuse('CANCELLED', '', 'admission');

    const requestedPolicyProfile = input.policyProfile ?? ports.policyProfile;
    const requestedAllowWorkflowWrites = input.allowWorkflowWrites ?? ports.allowWorkflowWrites;

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
      const initialHostPolicy: PersistedHostPolicy = freeze({
        policyProfile: requestedPolicyProfile ?? 'local',
        allowWorkflowWrites: requestedAllowWorkflowWrites === true,
      });
      const context = await createCycle(
        {
          configuration: input.configuration,
          repository: input.repository,
          runRoot: input.runRoot,
          runId: input.runId,
          ...(input.signal ? { signal: input.signal } : {}),
        },
        {
          ...ports,
          policyProfile: initialHostPolicy.policyProfile,
          allowWorkflowWrites: initialHostPolicy.allowWorkflowWrites,
        },
      );
      const initialMeta: StepMetaRecord = {
        version: 1,
        mode: input.mode ?? 'candidate',
        hostPolicy: initialHostPolicy,
        ...(initialHostPolicy.allowWorkflowWrites ? { allowWorkflowWrites: true } : {}),
        ...(normalizedRoleMcp !== undefined ? { roleMcpServers: normalizedRoleMcp } : {}),
        ...(normalizedMcpServers !== undefined ? { mcpServers: normalizedMcpServers } : {}),
        ...(normalizedWatched !== undefined ? { watchedPaths: normalizedWatched } : {}),
      };
      await writeAtomicPrivateJson(join(context.directory, 'step-meta.json'), initialMeta, context.artifacts.vault);
      const view = stateValue(context.store.inspect());
      const expiredAtStart =
        (view.clock.remainingTaskMs.safeValue ?? 0) <= 0 ||
        BigInt(view.clock.sampledNow.monotonicMs) >= BigInt(view.clock.basis.taskDeadlineMonotonicMs) - BigInt(context.plan.controls.drainReserveMs);
      if (expiredAtStart) {
        const bounds = overlayManifestBounds(context.plan.budgets.overlay);
        const initialManifestRef = await context.artifacts.json('manifest', context.source.manifest, bounds.manifestMaxBytes);
        return await settleForcedStepRun(
          context,
          null,
          { manifest: context.source.manifest, ref: initialManifestRef, files: context.source.artifacts, baselineProofs: context.source.baselineProofs },
          null,
          input.runRoot,
          'expired',
        );
      }
      return await runStepTickWithCycle(context, input.runRoot, initialMeta);
    }

    const mergedReopenPorts: ControllerPorts = {
      ...ports,
      ...(requestedPolicyProfile !== undefined ? { policyProfile: requestedPolicyProfile } : {}),
      ...(requestedAllowWorkflowWrites !== undefined ? { allowWorkflowWrites: requestedAllowWorkflowWrites } : {}),
    };
    const reopened = await reopenStepContext({
      runRoot: input.runRoot,
      runId: input.runId,
      ...(input.configuration ? { configuration: input.configuration } : {}),
      ...(input.repository !== undefined ? { repository: input.repository } : {}),
      ...(input.environment ? { environment: input.environment } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ports: mergedReopenPorts,
      phase: 'execution',
    });
    const { context, meta: existingMeta, head, candidate, submission, decision, expired } = reopened;

    if (input.mode !== undefined && input.mode !== existingMeta.mode) {
      stateValue(context.store.release(context.authority));
      stateValue(context.store.close());
      await context.owner.release();
      refuse('RECOVERY_REQUIRED', '/mode', 'execution');
    }
    const effectiveMeta: StepMetaRecord = {
      ...existingMeta,
      ...(normalizedRoleMcp !== undefined ? { roleMcpServers: normalizedRoleMcp } : {}),
      ...(normalizedMcpServers !== undefined ? { mcpServers: normalizedMcpServers } : {}),
      ...(normalizedWatched !== undefined ? { watchedPaths: normalizedWatched } : {}),
    };

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
      const promptText = priorLease?.prompt ?? new TextDecoder('utf-8', { fatal: true }).decode(await context.artifacts.read(active.command, LIMITS.inputBytes));
      const effectiveRole = active.repair === 'format' ? { ...activeRole, policy: formatPolicy(activeRole.policy) } : activeRole;
      const cycle = new Cycle(context, head, candidate, false);
      const activeResources = cycle.resolveRetainedActiveResources(effectiveRole.roleId, active);
      const hostProtection = hostProtectionFromPolicy(effectiveMeta.hostPolicy);
      const workspacesRoot = join(resolve(input.runRoot), 'workspaces');
      const runWorkspaceDir = join(workspacesRoot, context.lock.spec.runId);
      const attemptWorkspaceDir = join(runWorkspaceDir, active.id);
      const candidateDir = join(attemptWorkspaceDir, 'candidate');
      const contextDir = join(attemptWorkspaceDir, 'context');
      const candidateExists = await lstat(candidateDir).then(st => st.isDirectory() && !st.isSymbolicLink(), () => false);
      let contextFiles: readonly string[];
      if (!candidateExists) {
        const rematerialized = await materializeAttemptWorkspace(
          cycle,
          input.runRoot,
          active.id,
          effectiveRole,
          active.repair,
          hostProtection,
          activeResources,
          active.handoffExtracts ?? [],
          'recovery',
        );
        contextFiles = rematerialized.contextFiles;
      } else {
        const excluded = [context.descriptor.repository, ...approvedState(context.loaded).input.untrustedRoots];
        await privateDirectory(workspacesRoot, excluded);
        await privateDirectory(runWorkspaceDir, excluded);
        await privateDirectory(attemptWorkspaceDir, excluded);
        await rm(contextDir, { recursive: true, force: true });
        await privateDirectory(contextDir, excluded);
        contextFiles = await materializeContextFilesDir(
          contextDir,
          activeResources,
          active.handoffExtracts ?? [],
          context.artifacts.directory,
          'recovery',
        );
      }
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
      const stepYield = await buildStepYield(cycle, input.runRoot, active, effectiveRole, promptText, contextFiles, newToken, effectiveMeta);
      await cycle.deadline.dispose();
      await cycle.events.suspend();
      stateValue(context.store.release(context.authority));
      stateValue(context.store.close());
      await context.owner.release();
      return stepYield;
    }

    return await runStepTickWithCycle(context, input.runRoot, effectiveMeta, {
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
      fields.some(key => !['runRoot', 'runId', 'leaseToken', 'submissionFile', 'verdict', 'status', 'reason', 'environment', 'signal'].includes(key)) ||
      (input.status !== undefined && !['completed', 'no_change', 'failed', 'blocked'].includes(input.status)) ||
      (input.reason !== undefined && typeof input.reason !== 'string') ||
      (input.submissionFile !== undefined && typeof input.submissionFile !== 'string') ||
      (input.verdict !== undefined && input.submissionFile !== undefined) ||
      (input.environment !== undefined && typeof input.environment !== 'function') ||
      (input.signal !== undefined && !(input.signal instanceof AbortSignal))
    ) {
      refuse('CONFIG_SCHEMA', '', 'execution');
    }
    let explicitVerdictBytes: Uint8Array | null = null;
    if (input.verdict !== undefined) {
      if (!isRecord(input.verdict)) refuse('CONFIG_SCHEMA', '/verdict', 'execution');
      const parsedVerdict = validateStepVerdictObject(input.verdict, 'SUBMISSION_INVALID', 'execution');
      explicitVerdictBytes = new Uint8Array(Buffer.from(canonical(parsedVerdict), 'utf8'));
    }
    validateGateUrlOverrides(ports.gateUrlOverrides, 'execution');
    validatePortPolicyFields(ports, 'execution');
    if (input.signal?.aborted) refuse('CANCELLED', '', 'execution');

    const reopened = await reopenStepContext({
      runRoot: input.runRoot,
      runId: input.runId,
      ...(input.environment ? { environment: input.environment } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ports,
      phase: 'execution',
    });
    const { context, meta, head, candidate, submission, decision, expired } = reopened;

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

    const hostProtection = hostProtectionFromPolicy(meta.hostPolicy);
    const role: PlannedRole = active.repair === 'format' ? { ...originalRole, policy: formatPolicy(originalRole.policy) } : originalRole;
    const disallowMutations =
      active.repair === 'format' ||
      !role.policy.tools.some(tool => tool === 'write' || tool === 'edit' || tool === 'delete' || tool === 'bash');
    const candidateDir = join(resolve(input.runRoot), 'workspaces', context.lock.spec.runId, active.id, 'candidate');

    let previousModes: ReadonlyMap<string, '100644' | '100755'>;
    let scanned: Awaited<ReturnType<typeof scanCandidateDirectory>>;
    let explicitSubmissionBytes: Uint8Array | null = explicitVerdictBytes;
    try {
      previousModes = await resolveCurrentFileModes(context, head);
      scanned = await scanCandidateDirectory(
        candidateDir,
        context.source,
        context.plan.task,
        head.progress.candidate.digest,
        previousModes,
        disallowMutations,
        context.plan.budgets.overlay,
        context.artifacts,
        hostProtection,
      );
      if (input.submissionFile !== undefined) {
        explicitSubmissionBytes = await readExplicitSubmissionFile(input.submissionFile);
      }
    } catch (error) {
      stateValue(context.store.release(context.authority));
      stateValue(context.store.close());
      await context.owner.release();
      throw error;
    }

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
      if (isVerdictStep(activeNode)) {
        const syntheticVerdict: StepVerdict = {
          verdict: effectiveStatus === 'failed' ? 'fail' : effectiveStatus === 'blocked' ? 'human' : 'pass',
          summary: effectiveReason ?? 'Passed via step submit.',
          findings: [],
        };
        assistantText = canonical(syntheticVerdict);
        submissionBytes = new Uint8Array(Buffer.from(assistantText, 'utf8'));
      } else {
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
    }

    const payload: DelegatedCapturePayloadV2 = {
      format: 'delegated-capture.v2',
      version: 2,
      baseRevision: context.plan.task.spec.target.baseRevision,
      sourceRevision: context.plan.task.spec.target.sourceRevision,
      overlay: scanned.overlay,
      deleted: scanned.deleted,
      assistantText,
      status: effectiveStatus,
      reason: effectiveReason,
    };

    try {
      const bounds = overlayManifestBounds(context.plan.budgets.overlay);
      const canonicalManifest = identifyManifest(canonicalizeCandidateManifest(scanned.manifest), bounds.options);
      if (!canonicalManifest.ok || Buffer.byteLength(canonical(canonicalManifest.value.manifest), 'utf8') > bounds.manifestMaxBytes) {
        refuse('OUTPUT_LIMIT', '', 'execution');
      }
      await assertCanonicalMinimalOverlay(canonicalManifest.value.manifest, scanned.files, context.source, 'execution');
      const subject = bindSubject(context.lock, canonicalManifest.value.manifest, bounds.options);
      if (!subject.ok) refuse('ARTIFACT_INVALID', '', 'execution');
      const changed = !same(subject.value.candidateDigest, head.progress.candidate.digest);
      if (!changed && scanned.overlay.some(entry => (previousModes.get(entry.name) ?? '100644') !== entry.mode)) {
        refuse('ARTIFACT_INVALID', '', 'execution');
      }
      const nextGeneration = head.progress.candidate.generation + (changed ? 1 : 0);
      if (nextGeneration >= context.plan.capacity.V) refuse('ATTEMPT_LIMIT', '', 'execution');
      const payloadBytes = Buffer.from(canonical(payload), 'utf8');
      if (payloadBytes.byteLength > bounds.v2WorkspaceJsonMaxBytes) refuse('OUTPUT_LIMIT', '', 'execution');
      context.artifacts.vault.assertClean(payloadBytes);
      if (submissionBytes !== null) {
        if (submissionBytes.byteLength > 1_048_576) refuse('OUTPUT_LIMIT', '', 'execution');
        context.artifacts.vault.assertClean(submissionBytes);
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
      const captured = await captureDelegatedRole(
        context.store,
        context.authority,
        context.artifacts,
        context.lock,
        role,
        active,
        context.source,
        {
          candidateManifest: scanned.manifest,
          candidateFiles: scanned.files,
          payload,
          submissionBytes,
        },
        hostProtection,
      );
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
    await context.artifacts.cleanCasTempFiles().catch(() => {});

    await cycle.deadline.dispose();
    await cycle.events.suspend();

    return await runStepTickWithCycle(
      context,
      input.runRoot,
      meta,
      {
        head: cycle.head,
        candidate: cycle.candidate,
        submission: cycle.submission,
        adopt: false,
        advisoryObservations: cycle.advisoryObservations,
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
