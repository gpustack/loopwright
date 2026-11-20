import { mkdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openPiAdapterV2, type PiAdapterV2, type PiCandidateArtifactInput, type PiHostV2, type PiOpenInputV2, type PiOutcomeV2 } from '@loopwright/agent-pi';
import { admitTask, bindSubject, identifyManifest, type ArtifactRef, type Digest, type StructuredFinding, type TaskLock } from '@loopwright/core';
import { createLocalRun, type Authority, type LocalRunIdentity, type LocalRunStore } from '@loopwright/state';
import { approvedState, selectRoleResources } from './config.js';
import { compilePlan } from './compile.js';
import { ControllerFailure, refuse, result, safeDiagnostic, type ControllerDiagnostic } from './errors.js';
import { privateDirectory, ArtifactStore, checkedRef, stateValue, streamVerifiedCasBlob } from './storage.js';
import { ControllerOwner, bootIdentity } from './ownership.js';
import { effectiveRunHostPolicy, hostProtectionFromPolicy, resolveStoreLeaseMs, validatePortPolicyFields } from './retained.js';
export { resolveStoreLeaseMs };
import { freezeSource, materializeBaseline, overlayManifestBounds, verifySource, type FrozenSource, type HostPathProtectionOptions } from './source.js';
import { ProgressStore, stableId, journal, type ProgressHead } from './progress.js';
import { captureRole, adoptRoleCapture, nativeSessionId, type CapturedRole } from './capture.js';
import {
  boundFindingsForObservations,
  hydrateStepVerdicts,
  isVerdictStep,
  normalizeSubmission,
  parseStepVerdict,
  readSubmissionCandidateBytes,
  retainStepOutput,
  summarizeStepVerdictPreview,
  type CapturedStepOutput,
  type Submission,
  type RetainedSubmission,
} from './submission.js';
import { prepareVerification, preflightVerification, Verifier, authenticatedCheck, type PreflightRefusal, type VerifiedCheck, type ByteInventory, type PreparedVerification } from './verification.js';
import { prepareGate, Gate, authenticatedGate, validateGateUrlOverrides, type PreparedGate } from './gate.js';
import { preparePublication, Publication, headRevision, type PreparedPublication } from './publication.js';
import { evaluateControllerAcceptance, type AcceptanceObservation } from './acceptance.js';
import { nextNode, descendants, compactionTarget, resetSubgraphNodes, reworkSubgraph } from './scheduler.js';
import { failureSignature, rememberFailure, repairDisposition, formatPolicy, formatPrompt, reworkPrompt, verdictFormatPrompt } from './repair.js';
import { WorkDeadline } from './deadlines.js';
import { countDelegatedBudgets, observeParentExhaustion, schedulingSnapshot, isBudgetRefusal, isNoEffectBudgetRefusal, storeFactsCertain, refuseFromRoleOutcome } from './budget-observations.js';
import { ControllerEvents, type ControllerEvent } from './events.js';
import { Finalizer, incident, type ControllerIncident } from './finalize.js';
import { canonical, freeze, hash, id, isRecord, record, same, text } from './schema.js';
import { parsePrivateJson } from './parser.js';
import type {
  AdvisoryCapabilityTier,
  AdvisoryDecisionPort,
  AdvisoryDecisionSource,
  CandidateDiffSummary,
  CandidateFileEntry,
  CompiledPlan,
  ControllerAttempt,
  ControllerPolicyProfile,
  ControllerProgress,
  CycleAlignmentRoute,
  CycleExecution,
  LoadedConfiguration,
  PersistedHostPolicy,
  PlannedRole,
  RoleModelOverride,
  StepMcpServerMetadata,
  StepReworkContext,
  StepVerdict,
  StoredStepVerdict,
} from './types.js';

const VALID_ADVISORY_SOURCES: ReadonlySet<string> = new Set<AdvisoryDecisionSource>([
  'jev',
  'deterministic_fallback',
  'deterministic_heuristic',
  'user_override',
]);
const VALID_ALIGNMENT_ROUTES: ReadonlySet<string> = new Set<CycleAlignmentRoute>(['continue', 'revise', 'needs_review', 'blocked']);
const VALID_CAPABILITY_TIERS: ReadonlySet<string> = new Set<AdvisoryCapabilityTier>(['fast', 'balanced', 'strongest']);
const VALID_SOFT_COMPACTION_DECISIONS: ReadonlySet<string> = new Set(['compact', 'defer']);

export function isHaltedByVerdict(progress: ControllerProgress | null | undefined): 'blocked' | 'failed' | null {
  const verdicts = progress?.stepVerdicts;
  if (!verdicts || verdicts.length === 0) return null;
  const epoch = progress?.reworkEpoch ?? 0;
  for (let i = verdicts.length - 1; i >= 0; i -= 1) {
    const entry = verdicts[i]!;
    if (entry.reworkEpoch !== epoch) continue;
    if (entry.verdict === 'fail') return 'failed';
    if (entry.verdict === 'human' || entry.verdict === 'rework') return 'blocked';
  }
  return null;
}

export interface RunCycleInput { readonly configuration: LoadedConfiguration; readonly repository: string; readonly runRoot: string; readonly runId: string; readonly signal?: AbortSignal; readonly onEvent?: (event: ControllerEvent) => Promise<void> }
export interface RunDescriptor {
  readonly version: 1; readonly identity: LocalRunIdentity; readonly plan: ArtifactRef; readonly source: ArtifactRef; readonly sourceWorkspace: ArtifactRef;
  readonly configuration: { readonly configPath: string; readonly registryPath: string; readonly registrySha256: string; readonly roleModelOverrides?: readonly RoleModelOverride[] }; readonly repository: string;
  readonly hostPolicy?: PersistedHostPolicy;
}
/** Trusted local observations and optional non-authoritative advisory hooks. */
export interface ControllerPorts {
  readonly openAdapter?: (host: PiHostV2, input: PiOpenInputV2) => ReturnType<typeof openPiAdapterV2>;
  readonly afterCheckpoint?: (phase: string, head: ProgressHead) => Promise<void>;
  readonly gateUrlOverrides?: Readonly<Record<string, string>>;
  readonly decisions?: AdvisoryDecisionPort;
  readonly policyProfile?: ControllerPolicyProfile | undefined;
  readonly allowWorkflowWrites?: boolean | undefined;
  readonly roleMcpServers?: Readonly<Record<string, readonly string[]>>;
  readonly mcpServers?: readonly StepMcpServerMetadata[];
}
function cycleHostProtection(context: CycleContext): HostPathProtectionOptions {
  const persisted = effectiveRunHostPolicy(context.descriptor);
  return hostProtectionFromPolicy({
    policyProfile: context.ports.policyProfile ?? persisted.policyProfile,
    allowWorkflowWrites: context.ports.allowWorkflowWrites ?? persisted.allowWorkflowWrites,
  });
}
export function roleResourcesFor(loaded: LoadedConfiguration, plan: CompiledPlan, roleId: string) {
  const all = approvedState(loaded).resources;
  const declared = plan.task.spec.roles.find(item => item.id === roleId);
  return selectRoleResources(all, declared?.resourceIds, 'execution');
}
export interface CycleContext {
  readonly loaded: LoadedConfiguration; readonly plan: CompiledPlan; readonly lock: TaskLock; readonly directory: string; readonly source: FrozenSource;
  readonly store: LocalRunStore; readonly authority: Authority; readonly owner: ControllerOwner; readonly artifacts: ArtifactStore; readonly progress: ProgressStore; readonly descriptor: RunDescriptor;
  readonly signal: AbortSignal; readonly onEvent: RunCycleInput['onEvent']; readonly ports: ControllerPorts;
}
type Draft = Omit<ControllerProgress, 'sequence' | 'previous' | 'stage'> & { readonly stage: Omit<ControllerProgress['stage'], 'consumed' | 'watermarks'> };
async function exclusiveJson(path: string, value: unknown): Promise<void> {
  const bytes = Buffer.from(canonical(value)); if (bytes.length > 1048576) refuse('OUTPUT_LIMIT', '', 'admission');
  const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  const parent = await open(resolve(path, '..'), constants.O_RDONLY | constants.O_NOFOLLOW); try { await parent.sync(); } finally { await parent.close(); }
}
export async function createCycle(input: RunCycleInput, ports: ControllerPorts): Promise<CycleContext> {
  const state = approvedState(input.configuration), compiled = await compilePlan(input.configuration); if (!compiled.ok) throw new ControllerFailure(compiled.error); const plan = compiled.value;
  validatePortPolicyFields(ports, 'admission');
  validateGateUrlOverrides(ports.gateUrlOverrides, 'admission', input.configuration.registry.spec.gateEndpoints);
  const hostPolicy: PersistedHostPolicy = freeze({
    policyProfile: ports.policyProfile ?? 'local',
    allowWorkflowWrites: ports.allowWorkflowWrites === true,
  });
  const effectivePorts: ControllerPorts = {
    ...ports,
    policyProfile: hostPolicy.policyProfile,
    allowWorkflowWrites: hostPolicy.allowWorkflowWrites,
  };
  const runId = id(input.runId), root = resolve(text(input.runRoot)), repository = resolve(text(input.repository)), directory = join(root, runId);
  const excluded = [repository, process.cwd(), ...state.input.untrustedRoots];
  await privateDirectory(root, excluded);
  try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') refuse('OWNER_BUSY', '', 'admission'); throw error; }
  let owner: ControllerOwner | null = null, store: LocalRunStore | null = null;
  try {
    owner = await ControllerOwner.acquire(directory, runId, plan.planDigest); const artifactDirectory = join(directory, 'artifacts'); await privateDirectory(artifactDirectory);
    const artifacts = new ArtifactStore(artifactDirectory, owner, state.vault);
    const jsonPaths = plan.verifierSlots.filter(slot => ['json-artifact.v1', 'json-keys-guard.v1', 'line-section-guard.v1'].includes(slot.handler.implementation)).map(slot => text(slot.handler.parameters.path));
    const source = await freezeSource(repository, plan.task, owner, artifacts, jsonPaths);
    const overlayBounds = overlayManifestBounds(plan.budgets.overlay);
    const admitted = admitTask(plan.task, { admissionId: 'admission.' + hash('loopwright.dev/controller/admission/v1\0' + runId + '\0' + plan.planDigest.hex).hex.slice(0, 40), runId });
    if (!admitted.ok) refuse('CONFIG_SCHEMA', '/spec/task', 'admission'); const lock = admitted.value, manifest = await artifacts.json('manifest', source.manifest, overlayBounds.manifestMaxBytes);
    const initial: ByteInventory = { manifest: source.manifest, ref: manifest, files: source.artifacts, baselineProofs: source.baselineProofs };
    // Core identity is pure; complete byte preflight still precedes S02 create/claim and every initial dispatch.
    for (const slot of plan.verifierSlots) if (slot.handler.implementation !== 'gate.v1') prepareVerification(plan, lock, slot.id, initial, initial, 0, randomBytes(16).toString('hex'));
    const planRef = await artifacts.json('plan', plan, 4194304), lockRef = await artifacts.json('task-lock', lock, 4194304);
    const adapters = [...new Set(plan.task.spec.roles.map(role => role.adapter))].sort().map(id => ({ id, version: '0.0.0' }));
    const identity: LocalRunIdentity = { directory: join(directory, 'state'), storeId: 'store.' + hash('loopwright.dev/controller/store/v1\0' + runId).hex.slice(0, 40), lock,
      policy: { version: 1, leaseMs: resolveStoreLeaseMs(input.configuration, plan), cost: 'observe_only' }, binding: { coreApiVersion: 'loopwright.dev/v1alpha1', hostVersion: 's04-controller-v1', adapters,
        resourceVersion: plan.task.spec.trustedContext.revision, clockEpoch: 'boot.' + hash(await bootIdentity()).hex.slice(0, 40) } };
    const descriptor: RunDescriptor = { version: 1, identity, plan: planRef, source: source.inventory, sourceWorkspace: source.workspace,
      configuration: { configPath: state.input.configPath, registryPath: state.input.registryPath, registrySha256: state.input.registrySha256, ...(state.input.roleModelOverrides !== undefined ? { roleModelOverrides: state.input.roleModelOverrides } : {}) }, repository, hostPolicy };
    state.vault.assertClean(descriptor); await exclusiveJson(join(directory, 'run.json'), descriptor);
    store = stateValue(createLocalRun(identity)); const current = stateValue(store.inspect()), authority = stateValue(store.claim({ ownerId: 'controller.' + owner.nonce, expectedGeneration: current.owner.generation, expectedRevision: current.revision, mode: 'active' })).authority;
    const progress = new ProgressStore(store, authority, artifacts, plan, lock, planRef, source.inventory);
    // lockRef is private provenance; source/plan remain the four-ref checkpoint roots.
    await artifacts.json('admission', { version: 1, lock: lockRef, source: source.inventory, plan: planRef }, 65536);
    return { loaded: input.configuration, plan, lock, directory, source, store, authority, owner, artifacts, progress, descriptor, signal: input.signal ?? new AbortController().signal, onEvent: input.onEvent, ports: effectivePorts };
  } catch (error) { if (store) stateValue(store.close()); if (owner) await owner.release(); throw error; }
}
export class Cycle {
  head: ProgressHead | null; candidate: ByteInventory; submission: RetainedSubmission | null = null; readonly checks = new Map<string, VerifiedCheck>(); readonly refusals = new Map<string, PreflightRefusal>();
  readonly deadline: WorkDeadline; readonly events: ControllerEvents; readonly verifier: Verifier; readonly gate: Gate; readonly publisher: Publication;
  readonly advisoryObservations: Record<string, unknown>[] = [];
  #activeAdapter: PiAdapterV2 | null = null; #candidateKnown = true; #cleanup: ControllerIncident['cleanup'] = 'complete';
  #publicationObservation: { readonly status: 'not_run' | 'confirmed' | 'failed' | 'unresolved'; readonly reason: string | null; readonly receipt: ArtifactRef | null } = { status: 'not_run', reason: 'disabled', receipt: null };
  constructor(readonly context: CycleContext, head: ProgressHead | null = null, candidate?: ByteInventory, readonly resumeAdoption?: boolean) {
    this.head = head; this.candidate = candidate ?? { manifest: context.source.manifest, ref: { name: '', digest: hash(''), byteLength: 0 }, files: context.source.artifacts, baselineProofs: context.source.baselineProofs };
    this.deadline = new WorkDeadline(context.store, context.authority, context.plan.controls.drainReserveMs, context.signal);
    this.events = new ControllerEvents(context.store, context.artifacts, context.onEvent, () => this.deadline.stop('OUTPUT_LIMIT'), head?.progress.eventSequence ?? 0);
    if (head) this.events.setDelegatedBudget(countDelegatedBudgets(context.plan, head.progress.attempts));
    const overlayOpts = overlayManifestBounds(context.plan.budgets.overlay).options;
    this.verifier = new Verifier(context.store, context.authority, context.artifacts, context.plan, context.lock, () => { const bound = bindSubject(context.lock, this.candidate.manifest, overlayOpts); if (!bound.ok) refuse('ARTIFACT_INVALID', '', 'verification'); return bound.value; });
    this.gate = new Gate(context.store, context.authority, context.artifacts, context.plan, context.lock, ref => approvedState(context.loaded).vault.resolveNetworkCredential(ref),
      () => { const bound = bindSubject(context.lock, this.candidate.manifest, overlayOpts); if (!bound.ok) refuse('ARTIFACT_INVALID', '', 'verification'); return bound.value; },
      detail => this.events.push('gate_waiting', null, null, null, [], detail), context.ports.gateUrlOverrides);
    this.publisher = new Publication(context.store, context.authority, context.artifacts, context.plan, context.lock, ref => approvedState(context.loaded).vault.resolveNetworkCredential(ref),
      () => { const bound = bindSubject(context.lock, this.candidate.manifest, overlayOpts); if (!bound.ok) refuse('ARTIFACT_INVALID', '', 'verification'); return bound.value; }, context.descriptor.repository);
    if (head && head.progress.publication.status !== 'idle') {
      const prior = head.progress.publication;
      this.#publicationObservation = prior.status === 'confirmed' ? { status: 'confirmed', reason: null, receipt: prior.receipt }
        : prior.status === 'failed' ? { status: 'failed', reason: 'not_executed', receipt: prior.receipt } : { status: 'unresolved', reason: 'unresolved', receipt: null };
    }
  }
  get generation(): number { return this.head?.progress.candidate.generation ?? 0; }
  get reworkEpoch(): number { return this.head?.progress.reworkEpoch ?? 0; }
  get candidateKnown(): boolean { return this.#candidateKnown; }
  markCandidateUnknown(): void { this.#candidateKnown = false; }
  #overlayBounds() { return overlayManifestBounds(this.context.plan.budgets.overlay); }
  #contextUtilization(): number {
    const view = stateValue(this.context.store.inspect());
    const charged = Number(view.ledger.chargedTokens.safeValue ?? 0);
    const total = this.context.lock.spec.contract.spec.budgets.totalTokens;
    return total > 0 ? Math.min(1, Math.max(0, charged / total)) : 0;
  }
  #failedVerificationLoops(): number {
    return (this.head?.progress.attempts.filter(a => a.repair === 'implementation').length ?? 0) + this.reworkEpoch;
  }
  haltedVerdictStatus(): 'blocked' | 'failed' | null {
    return isHaltedByVerdict(this.head?.progress);
  }
  async activeReworkForNode(nodeId: string): Promise<StepReworkContext | null> {
    const epoch = this.reworkEpoch;
    if (epoch === 0) return null;
    const verdicts = this.head?.progress.stepVerdicts ?? [];
    const triggering = [...verdicts].reverse().find(item => item.reworkEpoch === epoch - 1 && item.verdict === 'rework');
    if (!triggering) return null;
    const fromNode = this.context.plan.orderedDAG.find(item => item.id === triggering.stepId);
    if (!fromNode?.onRework) return null;
    const targetNode = this.context.plan.orderedDAG.find(item => item.id === nodeId);
    if (!targetNode || targetNode.kind !== 'agent' || targetNode.handler.implementation === 'pi.compact.v1' || targetNode.handler.parameters.purpose === 'review') {
      return null;
    }
    if (!reworkSubgraph(this.context.plan, fromNode.onRework.rejectTo).includes(nodeId)) return null;
    let hydrated: StepVerdict;
    try {
      hydrated = parseStepVerdict(await this.context.artifacts.read(triggering.raw, 1_048_576));
    } catch {
      refuse('RECOVERY_REQUIRED', '', 'recovery');
    }
    return freeze({
      epoch,
      count: this.head?.progress.reworkCounts?.[fromNode.id] ?? 1,
      maxReworks: fromNode.onRework.maxReworks,
      fromStepId: fromNode.id,
      summary: hydrated.summary,
      findings: hydrated.findings,
    });
  }
  async adviseCapabilityRouting(
    nodeId: string,
    role: PlannedRole,
    purpose: 'task' | 'reviewer',
    roleResources: readonly { readonly id: string; readonly kind: string }[],
  ): Promise<void> {
    const hook = this.context.ports.decisions?.routeCapabilityTier;
    if (!hook) return;
    const candidateSkills = roleResources.filter(item => item.kind === 'skill').map(item => item.id);
    try {
      const routed = await hook({
        runId: this.context.lock.spec.runId,
        stepId: nodeId,
        roleId: role.roleId,
        taskKind: purpose,
        estimatedFilesCount: this.candidate.files.length,
        hasFailingTests: this.currentChecks().some(c => c.status === 'failed'),
        requiresArchitectureChange: false,
        candidateSkills,
        pinnedModel: { provider: role.policy.selection.provider, model: role.policy.selection.model, thinking: role.policy.selection.thinking },
      });
      if (routed === null || routed === undefined) return;
      if (
        !isRecord(routed) ||
        typeof routed.tier !== 'string' ||
        !VALID_CAPABILITY_TIERS.has(routed.tier) ||
        typeof routed.source !== 'string' ||
        !VALID_ADVISORY_SOURCES.has(routed.source)
      ) {
        throw new Error('invalid_capability_routing_output');
      }
      this.advisoryObservations.push({
        intent: 'route_capability_tier',
        stepId: nodeId,
        tier: routed.tier,
        pinnedModelPreserved: true,
        source: routed.source,
      });
    } catch {
      this.advisoryObservations.push({
        intent: 'route_capability_tier',
        stepId: nodeId,
        pinnedModelPreserved: true,
        source: 'deterministic_fallback',
      });
    }
  }
  async evaluateAlignment(trigger: 'implementation_repair' | 'rework', targetStepId: string, candidateDigest: Digest): Promise<boolean> {
    const hook = this.context.ports.decisions?.evaluateCycleAlignment;
    if (!hook) return true;
    try {
      const output = await hook({
        runId: this.context.lock.spec.runId,
        trigger,
        targetStepId,
        contractHash: this.context.lock.spec.contractHash,
        baseRevision: this.context.lock.spec.contract.spec.target.baseRevision,
        candidateDigest,
        reworkEpoch: this.reworkEpoch,
        remainingAttempts: Math.max(0, this.context.plan.capacity.A - (this.head?.progress.attempts.length ?? 0)),
        contextUtilization: this.#contextUtilization(),
        failedVerificationLoops: this.#failedVerificationLoops(),
      });
      if (output === null || output === undefined) return true;
      if (
        !isRecord(output) ||
        typeof output.route !== 'string' ||
        !VALID_ALIGNMENT_ROUTES.has(output.route) ||
        typeof output.precheckPassed !== 'boolean' ||
        typeof output.source !== 'string' ||
        !VALID_ADVISORY_SOURCES.has(output.source)
      ) {
        throw new Error('invalid_alignment_output');
      }
      this.advisoryObservations.push({
        intent: 'evaluate_cycle_alignment',
        trigger,
        targetStepId,
        route: output.route,
        precheckPassed: output.precheckPassed,
        source: output.source,
      });
      return output.route !== 'blocked' && output.route !== 'needs_review';
    } catch {
      this.advisoryObservations.push({
        intent: 'evaluate_cycle_alignment',
        trigger,
        targetStepId,
        route: 'continue',
        precheckPassed: true,
        source: 'deterministic_fallback',
      });
      return true;
    }
  }
  async triageCandidateDiffAdvisory(
    stepId: string,
    attemptId: string,
    candidateDigest: Digest,
    files: readonly CandidateFileEntry[],
    deleted: readonly string[],
  ): Promise<void> {
    const hook = this.context.ports.decisions?.triageCandidateDiff;
    if (!hook) return;
    let modifiedFiles = files;
    const effectiveDeleted = [...deleted];
    if (this.context.source.version === 1) {
      const baseByPath = new Map(this.context.source.artifacts.map(item => [item.name, item.bytes]));
      const present = new Set(files.map(item => item.name));
      modifiedFiles = files.filter(file => {
        const baseBytes = baseByPath.get(file.name);
        if (baseBytes === undefined) return true;
        if ('bytes' in file) return !Buffer.from(baseBytes).equals(Buffer.from(file.bytes));
        return baseBytes.byteLength !== file.byteLength || hash(baseBytes).hex !== file.digest.hex;
      });
      for (const base of this.context.source.artifacts) {
        if (!present.has(base.name)) effectiveDeleted.push(base.name);
      }
    }
    const changedFiles = [...new Set([...modifiedFiles.map(f => f.name), ...effectiveDeleted])].sort();
    const touchedPackages = [
      ...new Set(
        changedFiles
          .map(path => (/^packages\/([^/]+)\//.exec(path)?.[1] ?? null))
          .filter((pkg): pkg is string => pkg !== null),
      ),
    ].sort();
    let addedLines = 0;
    for (const file of modifiedFiles) {
      if ('bytes' in file) {
        if (file.bytes.byteLength === 0) continue;
        if (file.bytes.byteLength > 262_144) {
          addedLines += 1;
          continue;
        }
        let count = 0;
        for (let i = 0; i < file.bytes.byteLength; i++) if (file.bytes[i] === 10) count++;
        addedLines += Math.max(1, count);
      } else {
        if (file.byteLength === 0) continue;
        if (file.byteLength > 262_144) {
          addedLines += 1;
          continue;
        }
        let count = 0;
        try {
          await streamVerifiedCasBlob(
            this.context.artifacts.directory,
            {
              name: file.name,
              sha256: file.digest.hex,
              byteLength: file.byteLength,
              uri: 'cas://sha256/' + file.digest.hex,
              path: file.blobPath,
            },
            chunk => {
              for (let i = 0; i < chunk.byteLength; i++) if (chunk[i] === 10) count++;
            },
            'execution',
          );
          addedLines += Math.max(1, count);
        } catch (error) {
          if (error instanceof ControllerFailure) throw error;
          addedLines += 1;
        }
      }
    }
    const summary: CandidateDiffSummary = freeze({
      changedFiles,
      addedLines,
      deletedLines: effectiveDeleted.length,
      touchedPackages,
      redactedHunkSummaries: changedFiles.slice(0, 16).map(f => 'modified ' + f),
    });
    try {
      const output = await hook({
        runId: this.context.lock.spec.runId,
        stepId,
        attemptId,
        candidateDigest,
        summary,
      });
      if (output === null || output === undefined) return;
      if (
        !isRecord(output) ||
        !Array.isArray(output.escalated) ||
        typeof output.source !== 'string' ||
        !VALID_ADVISORY_SOURCES.has(output.source)
      ) {
        throw new Error('invalid_triage_output');
      }
      // Non-delegable authority invariant: triage escalations are strictly advisory; verificationCertified is forced false.
      this.advisoryObservations.push({
        intent: 'triage_candidate_diff',
        stepId,
        attemptId,
        escalatedCount: output.escalated.length,
        verificationCertified: false,
        source: output.source,
      });
    } catch {
      this.advisoryObservations.push({
        intent: 'triage_candidate_diff',
        stepId,
        attemptId,
        escalatedCount: 0,
        verificationCertified: false,
        source: 'deterministic_fallback',
      });
    }
  }
  get draft(): Draft {
    if (!this.head) refuse('RECOVERY_REQUIRED', '', 'execution'); return { ...this.head.progress, eventSequence: this.events.sequence };
  }
  async publish(draft: Draft, phase: string): Promise<void> {
    this.head = await this.context.progress.publish({ ...draft, eventSequence: this.events.sequence }, phase);
    this.events.setDelegatedBudget(countDelegatedBudgets(this.context.plan, this.head.progress.attempts));
    await this.context.ports.afterCheckpoint?.(phase, this.head);
  }
  async bootstrap(): Promise<void> {
    const { plan, lock, source, artifacts } = this.context, bounds = this.#overlayBounds();
    const manifest = await artifacts.json('manifest', source.manifest, bounds.manifestMaxBytes); this.candidate = { manifest: source.manifest, ref: manifest, files: source.artifacts, baselineProofs: source.baselineProofs };
    const bound = bindSubject(lock, source.manifest, bounds.options); if (!bound.ok) refuse('ARTIFACT_INVALID', '', 'admission');
    await this.events.push('admission', null);
    await this.publish({ version: 2, runId: lock.spec.runId, lockHash: lock.spec.lockHash, stage: { kind: 'bootstrap', phase: 'bootstrap', capacity: plan.capacity },
      nodes: plan.orderedDAG.map(node => ({ id: node.id, state: 'pending' })), attempts: [], nativeCheckpoints: [], submission: null, publication: { status: 'idle', operationId: null, receipt: null },
      candidate: { manifest, digest: bound.value.candidateDigest, generation: 0, workspace: source.workspace, privateSession: null }, failures: [], verifierReceipts: [], verifierRefusals: [], eventSequence: this.events.sequence, terminalIntent: null }, 'bootstrap');
  }
  async guard(): Promise<void> { this.deadline.assert(); await this.context.owner.assertCurrent(); await verifySource(this.context.source, this.context.plan.task, this.context.owner); this.deadline.assert(); }
  async #finalizeVerifierPost(slotId: string, checked: VerifiedCheck, ordinal: number, phase: string): Promise<void> {
    const { plan, artifacts } = this.context;
    const slot = plan.verifierSlots[ordinal]!;
    const gateSlot = slot.handler.implementation === 'gate.v1';
    let draft: Draft = {
      ...this.draft,
      stage: { ...this.draft.stage, kind: 'verifier_post' as const },
      verifierReceipts: this.draft.verifierReceipts.map(item =>
        item.slot === slotId && item.generation === this.generation ? { ...item, output: checked.output, receipt: checked.receipt } : item,
      ),
    };
    if (checked.status === 'failed') {
      const trusted = gateSlot ? authenticatedGate(checked) : authenticatedCheck(checked);
      const stable = hash(
        canonical({
          slot: slot.id,
          handler: slot.handler.digest,
          reason: checked.reason,
          method: trusted.evidence.spec.method,
          parameters: slot.handler.parameters,
        }),
      );
      const signature = failureSignature({
        category: 'implementation',
        codes: [checked.reason!],
        handler: slot.handler.implementation,
        handlerVersion: 1,
        target: typeof slot.handler.parameters.path === 'string' ? slot.handler.parameters.path : slot.id,
        candidate: trusted.subject.candidateDigest,
        evidence: [stable],
      });
      draft = { ...draft, failures: rememberFailure(draft.failures, signature, this.generation, checked.output) };
    }
    const reworkCheckNode =
      checked.status === 'failed'
        ? plan.orderedDAG.find(node => {
            if (node.kind !== 'check' || !node.onRework || node.handler.id !== slot.handler.id) return false;
            if (!same(node.handler.parameters, slot.handler.parameters)) return false;
            const state = draft.nodes.find(item => item.id === node.id)?.state;
            if (state !== 'pending' && state !== 'running') return false;
            return node.dependsOn.every(parent => draft.nodes.find(item => item.id === parent)?.state === 'completed');
          })
        : undefined;
    if (reworkCheckNode?.onRework) {
      let detail: string | undefined;
      if (gateSlot) {
        const trusted = authenticatedGate(checked);
        try {
          const parsed = parsePrivateJson(Buffer.from(trusted.outputBytes), 65536);
          const verdict = isRecord(parsed) && isRecord(parsed.verdict) ? parsed.verdict : null;
          if (verdict && typeof verdict.reason === 'string' && verdict.reason.length > 0) {
            detail = Array.from(verdict.reason).slice(0, 256).join('');
          }
        } catch {
          // Malformed gate payload falls back to checked.reason.
        }
      }
      const reasonText = checked.reason ?? 'check_failed';
      const summary = detail
        ? `Check ${reworkCheckNode.id} (${checked.checkId}) failed: ${reasonText} — ${detail}`
        : `Check ${reworkCheckNode.id} (${checked.checkId}) failed: ${reasonText}`;
      const findingPath = typeof slot.handler.parameters.path === 'string' ? slot.handler.parameters.path : undefined;
      const finding: StructuredFinding = freeze({
        title: Array.from(`Check ${checked.checkId} failed (${reasonText})`).slice(0, 256).join(''),
        severity: 'high',
        ...(findingPath !== undefined ? { path: findingPath } : {}),
        evidence: detail ? `${reasonText}: ${detail}` : reasonText,
      });
      const verdictPayload: StepVerdict = freeze({
        verdict: 'rework',
        summary,
        findings: freeze([finding]),
      });
      const raw = await artifacts.put('step-verdict', Buffer.from(canonical(verdictPayload), 'utf8'), 1_048_576);
      const currentEpoch = draft.reworkEpoch ?? 0;
      const usedReworks = draft.reworkCounts?.[reworkCheckNode.id] ?? 0;
      const canRework = usedReworks < reworkCheckNode.onRework.maxReworks && this.generation + 1 < plan.capacity.V;
      const alignmentOk = canRework ? await this.evaluateAlignment('rework', reworkCheckNode.onRework.rejectTo, draft.candidate.digest) : false;
      const reworked = canRework && alignmentOk;
      const nextGen = this.generation + (reworked ? 1 : 0);
      const storedVerdict: StoredStepVerdict = freeze({
        attemptId: null,
        stepId: reworkCheckNode.id,
        roleId: null,
        reworkEpoch: currentEpoch,
        generation: nextGen,
        raw,
        verdict: 'rework',
        summaryPreview: summarizeStepVerdictPreview(verdictPayload.summary),
        findingCount: verdictPayload.findings.length,
      });
      const nextStepVerdicts = freeze([...(draft.stepVerdicts ?? []), storedVerdict]);
      if (reworked) {
        const markedDone = draft.nodes.map(item => (item.id === reworkCheckNode.id ? { ...item, state: 'completed' as const } : item));
        draft = {
          ...draft,
          candidate: { ...draft.candidate, generation: nextGen },
          nodes: [...resetSubgraphNodes(plan, markedDone, reworkCheckNode.onRework.rejectTo)],
          reworkEpoch: currentEpoch + 1,
          reworkCounts: freeze({ ...(draft.reworkCounts ?? {}), [reworkCheckNode.id]: usedReworks + 1 }),
          stepVerdicts: nextStepVerdicts,
        };
      } else {
        draft = {
          ...draft,
          nodes: draft.nodes.map(item =>
            item.id === reworkCheckNode.id ? { ...item, state: 'blocked' as const } : item.state === 'pending' ? { ...item, state: 'not_run' as const } : item,
          ),
          stepVerdicts: nextStepVerdicts,
        };
      }
    } else {
      draft = { ...draft, nodes: this.nodeDispositions(draft.nodes, this.generation) };
    }
    await this.publish(draft, phase + '.post');
  }
  async runVerifier(slotId: string): Promise<VerifiedCheck | PreflightRefusal> {
    const { plan, lock, artifacts } = this.context, bounds = this.#overlayBounds();
    const existing = this.head!.progress.verifierReceipts.find(item => item.slot === slotId && item.generation === this.generation);
    const negative = this.head!.progress.verifierRefusals.find(item => item.slot === slotId && item.generation === this.generation);
    if (negative) {
      const known = this.refusals.get(slotId + ':' + this.generation); if (known) return known;
      const source = { manifest: this.context.source.manifest, ref: await artifacts.json('manifest', this.context.source.manifest, bounds.manifestMaxBytes), files: this.context.source.artifacts, baselineProofs: this.context.source.baselineProofs };
      const prepared = preflightVerification(plan, lock, slotId, source, this.candidate, this.generation, negative.producerNonce); if (prepared.kind !== 'refused') refuse('RECOVERY_REQUIRED', '', 'recovery');
      await this.verifier.validateStoredRefusal(prepared.prepared, negative);
      const ordinal = plan.verifierSlots.findIndex(slot => slot.id === slotId), phase = 'verify.' + this.generation + '.' + ordinal;
      if (!this.head!.progress.stage.consumed.includes(phase + '.post')) {
        if (this.draft.stage.phase !== phase + '.pre') refuse('RECOVERY_REQUIRED', '', 'recovery');
        await this.publish({ ...this.draft, stage: { ...this.draft.stage, kind: 'verifier_post' }, nodes: this.nodeDispositions(this.draft.nodes, this.generation, { slotId, status: 'blocked' }) }, phase + '.post');
      }
      const restored = await this.verifier.restoreRefusal(prepared.prepared, negative); this.refusals.set(slotId + ':' + this.generation, restored); return restored;
    }
    if (existing) {
      const key = slotId + ':' + this.generation, known = this.checks.get(key); if (known) return known;
      const gateSlot = plan.verifierSlots.find(item => item.id === slotId)!.handler.implementation === 'gate.v1';
      const job = gateSlot
        ? prepareGate(plan, lock, slotId, this.candidate, this.generation, existing.producerNonce, this.context.loaded.registry.spec.gateEndpoints)
        : prepareVerification(plan, lock, slotId, { manifest: this.context.source.manifest, ref: await artifacts.json('manifest', this.context.source.manifest, bounds.manifestMaxBytes), files: this.context.source.artifacts, baselineProofs: this.context.source.baselineProofs }, this.candidate, this.generation, existing.producerNonce);
      const operation = this.context.store.getOperation(job.operationId);
      const restored = !operation.ok && operation.error.code === 'RECORD_NOT_FOUND' && existing.receipt === null
        ? await (gateSlot ? this.gate.run(job as PreparedGate, this.deadline.abort.signal) : this.verifier.run(job as PreparedVerification, this.deadline.abort.signal))
        : await (gateSlot ? this.gate.restore(job as PreparedGate) : this.verifier.restore(job as PreparedVerification));
      if (existing.receipt !== null && (!same(existing.receipt, restored.receipt) || !same(existing.output, restored.output))) refuse('RECOVERY_REQUIRED', '', 'recovery');
      this.checks.set(key, restored);
      const ordinal = plan.verifierSlots.findIndex(slot => slot.id === slotId), phase = 'verify.' + this.generation + '.' + ordinal;
      if (!this.head!.progress.stage.consumed.includes(phase + '.post')) {
        if (this.draft.stage.phase !== phase + '.pre') refuse('RECOVERY_REQUIRED', '', 'recovery');
        await this.#finalizeVerifierPost(slotId, restored, ordinal, phase);
      }
      return restored;
    }
    if (this.draft.failures.length >= 16) refuse('OUTPUT_LIMIT', '', 'verification');
    await this.guard(); const ordinal = plan.verifierSlots.findIndex(slot => slot.id === slotId); if (ordinal < 0) refuse('EVIDENCE_UNAVAILABLE', '', 'verification');
    const nonce = randomBytes(16).toString('hex'), source = { manifest: this.context.source.manifest, ref: await artifacts.json('manifest', this.context.source.manifest, bounds.manifestMaxBytes), files: this.context.source.artifacts, baselineProofs: this.context.source.baselineProofs };
    const gateSlot = plan.verifierSlots[ordinal]!.handler.implementation === 'gate.v1';
    const sized = gateSlot ? null : preflightVerification(plan, lock, slotId, source, this.candidate, this.generation, nonce), phase = 'verify.' + this.generation + '.' + ordinal;
    if (sized && sized.kind === 'refused') {
      const row = await this.verifier.storeRefusal(sized.prepared); await this.events.push('verification', 'OUTPUT_LIMIT');
      await this.publish({ ...this.draft, stage: { ...this.draft.stage, kind: 'verifier_pre' }, verifierRefusals: [...this.draft.verifierRefusals, row] }, phase + '.pre');
      await this.publish({ ...this.draft, stage: { ...this.draft.stage, kind: 'verifier_post' }, nodes: this.nodeDispositions(this.draft.nodes, this.generation, { slotId, status: 'blocked' }) }, phase + '.post');
      const checked = await this.verifier.restoreRefusal(sized.prepared, row); this.refusals.set(slotId + ':' + this.generation, checked); return checked;
    }
    const job: PreparedVerification | PreparedGate = gateSlot
      ? prepareGate(plan, lock, slotId, this.candidate, this.generation, nonce, this.context.loaded.registry.spec.gateEndpoints)
      : sized!.job;
    await this.events.push('verification', null);
    const epochTag = this.reworkEpoch > 0 ? { reworkEpoch: this.reworkEpoch } : {};
    await this.publish({ ...this.draft, stage: { ...this.draft.stage, kind: 'verifier_pre' }, verifierReceipts: [...this.draft.verifierReceipts, { slot: slotId, generation: this.generation, operationId: job.operationId, producerNonce: nonce, output: null, receipt: null, ...epochTag }] }, phase + '.pre');
    this.deadline.assert(); const checked = await (gateSlot ? this.gate.run(job as PreparedGate, this.deadline.abort.signal) : this.verifier.run(job as PreparedVerification, this.deadline.abort.signal)); this.checks.set(slotId + ':' + this.generation, checked);
    await this.#finalizeVerifierPost(slotId, checked, ordinal, phase);
    return checked;
  }
  nodeDispositions(input: ControllerProgress['nodes'], generation: number, pendingRefusal?: { readonly slotId: string; readonly status: 'blocked' }): ControllerProgress['nodes'] {
    const nodes = input.map(item => ({ ...item })), { plan } = this.context;
    for (const node of plan.orderedDAG) {
      const state = nodes.find(item => item.id === node.id)!;
      if (node.kind !== 'check' || state.state === 'not_run' || !node.dependsOn.every(parent => nodes.find(item => item.id === parent)?.state === 'completed')) continue;
      const slot = plan.verifierSlots.find(slot => slot.handler.id === node.handler.id), checked = slot ? this.checks.get(slot.id + ':' + generation) ?? this.refusals.get(slot.id + ':' + generation) ?? (pendingRefusal?.slotId === slot.id ? pendingRefusal : undefined) : undefined;
      if (!checked) continue; state.state = checked.status === 'passed' ? 'completed' : checked.status;
      if (checked.status !== 'passed') for (const id of descendants(plan, node.id)) { const child = nodes.find(item => item.id === id)!; if (child.state === 'pending') child.state = 'not_run'; }
    }
    return nodes;
  }
  async captureStepOutput(
    captured: CapturedRole,
    repair: ControllerAttempt['repair'],
    originalInvalidRaw: ArtifactRef | null,
    ignoreArtifactPath: boolean,
    previousFiles: readonly CandidateFileEntry[],
    expectedKind: 'submission' | 'verdict',
  ): Promise<CapturedStepOutput> {
    const { artifacts, plan } = this.context;
    if (repair === 'format') {
      if (!captured.submission || !originalInvalidRaw) refuse('RECOVERY_REQUIRED', '', 'execution');
      const rawBytes = await artifacts.read(captured.submission, 1048576);
      if (expectedKind === 'verdict') {
        const value = parseStepVerdict(rawBytes);
        const raw = await artifacts.put('step-verdict', rawBytes, 1048576);
        await artifacts.json('format-lineage', { version: 1, original: originalInvalidRaw, repaired: raw, candidate: captured.digest, attemptId: this.draft.attempts.at(-1)!.id }, 65536);
        return { kind: 'verdict', retained: freeze({ version: 1, origin: 'assistant', raw, value }) };
      }
      const value = normalizeSubmission(rawBytes, plan.task);
      const raw = await artifacts.put('submission', rawBytes, 1048576);
      await artifacts.json('format-lineage', { version: 1, original: originalInvalidRaw, repaired: raw, candidate: captured.digest, attemptId: this.draft.attempts.at(-1)!.id }, 65536);
      return { kind: 'submission', retained: freeze({ version: 1, origin: 'assistant', raw, value }) };
    }
    return retainStepOutput(captured, plan.controls.submission, plan.task, artifacts, { ignoreArtifactPath, previousFiles, expectedKind });
  }
  async completeCapture(attempt: ControllerAttempt, captured: CapturedRole, options?: { readonly ignoreArtifactPath?: boolean }): Promise<ControllerDiagnostic['code'] | null> {
    const { plan, store, artifacts } = this.context, { nodeId, repair, purpose, ordinal, id: commandId } = attempt;
    const dagNode = plan.orderedDAG.find(item => item.id === nodeId)!;
    const role = plan.roles.find(item => item.roleId === dagNode.roleId)!;
    const expectedKind: 'submission' | 'verdict' = isVerdictStep(dagNode) ? 'verdict' : 'submission';
    const disallowMutations = repair === 'format' || !role.policy.tools.some(tool => tool === 'write' || tool === 'edit' || tool === 'delete' || tool === 'bash');
    const ignoreArtifactPath = options?.ignoreArtifactPath === true || disallowMutations;
    const previousFiles = this.candidate.files;
    const oldDigest = this.draft.candidate.digest;
    const originalInvalidRaw = this.draft.failures.at(-1)?.evidence ?? this.draft.submission;
    const manifest = await this.context.progress.manifest(captured.manifest), changed = !same(captured.digest, oldDigest);
    if (changed && this.generation + 1 >= plan.capacity.V) refuse('ATTEMPT_LIMIT', '', 'execution');
    this.candidate = { manifest, ref: captured.manifest, files: captured.artifacts, baselineProofs: this.context.source.baselineProofs };
    this.#candidateKnown = true;
    if (changed) {
      await this.triageCandidateDiffAdvisory(nodeId, commandId, captured.digest, captured.artifacts, manifest.spec.deleted ?? []);
    }
    let stepOutput: CapturedStepOutput | null = null, failure: ControllerDiagnostic['code'] | null = null, failedRaw: ArtifactRef | null = null;
    try {
      if (purpose !== 'compaction') {
        stepOutput = await this.captureStepOutput(captured, repair, originalInvalidRaw, ignoreArtifactPath, previousFiles, expectedKind);
      }
    } catch (error) {
      if (error instanceof ControllerFailure && ['SUBMISSION_INVALID', 'SUBMISSION_AMBIGUOUS'].includes(error.diagnostic.code)) failure = error.diagnostic.code;
      else throw error;
    }
    if (failure) {
      const selectedFile = ignoreArtifactPath || plan.controls.submission.path === null
        ? undefined
        : captured.artifacts.find(file => file.name === plan.controls.submission.path);
      let selectedBytes: Uint8Array | undefined;
      if (selectedFile !== undefined) {
        try {
          selectedBytes = await readSubmissionCandidateBytes(selectedFile, artifacts, 'verification');
        } catch {
          selectedBytes = undefined;
        }
      }
      failedRaw = repair === 'format' || selectedBytes === undefined ? captured.submission : await artifacts.put('submission', selectedBytes, 1048576);
    }

    const currentEpoch = this.draft.reworkEpoch ?? 0;
    let nextReworkEpoch = currentEpoch;
    let nextReworkCounts = this.draft.reworkCounts;
    let nextNodeSubmissions = this.draft.nodeSubmissions;
    let nextStepVerdicts = this.draft.stepVerdicts;
    let reworked = false;
    let verdictHalted = false;
    let nextSubmissionRef = this.draft.submission;
    let nextNodes = this.draft.nodes.map(item => ({ ...item }));

    if (failure) {
      if (this.submission === null) nextSubmissionRef = failedRaw;
      nextNodes = nextNodes.map(item => (item.id === nodeId ? { ...item, state: 'failed' as const } : item));
    } else if (stepOutput?.kind === 'verdict') {
      const verdictVal = stepOutput.retained.value;
      if (verdictVal.verdict === 'rework') {
        const usedReworks = this.draft.reworkCounts?.[nodeId] ?? 0;
        const canRework = dagNode.onRework !== undefined && usedReworks < dagNode.onRework.maxReworks && this.generation + 1 < plan.capacity.V;
        const alignmentOk = canRework ? await this.evaluateAlignment('rework', dagNode.onRework!.rejectTo, captured.digest) : false;
        if (canRework && alignmentOk) {
          reworked = true;
          nextReworkEpoch = currentEpoch + 1;
          nextReworkCounts = freeze({ ...(this.draft.reworkCounts ?? {}), [nodeId]: usedReworks + 1 });
        } else {
          verdictHalted = true;
        }
      } else if (verdictVal.verdict === 'human' || verdictVal.verdict === 'fail') {
        verdictHalted = true;
      }
      nextSubmissionRef = this.submission?.raw ?? null;
      const nextGenForVerdict = this.generation + (changed || reworked ? 1 : 0);
      const storedVerdict: StoredStepVerdict = freeze({
        attemptId: commandId,
        stepId: nodeId,
        roleId: role.roleId,
        reworkEpoch: currentEpoch,
        generation: nextGenForVerdict,
        raw: stepOutput.retained.raw,
        verdict: verdictVal.verdict,
        summaryPreview: summarizeStepVerdictPreview(verdictVal.summary),
        findingCount: verdictVal.findings.length,
      });
      nextStepVerdicts = freeze([...(this.draft.stepVerdicts ?? []), storedVerdict]);
      if (verdictVal.verdict === 'pass') {
        nextNodes = nextNodes.map(item => (item.id === nodeId ? { ...item, state: 'completed' as const } : item));
      } else if (reworked) {
        const markedDone = nextNodes.map(item => (item.id === nodeId ? { ...item, state: 'completed' as const } : item));
        const resetNodes = resetSubgraphNodes(plan, markedDone, dagNode.onRework!.rejectTo);
        nextNodes = resetNodes.map(item => {
          if (item.state !== 'completed') return item;
          const itemDagNode = plan.orderedDAG.find(node => node.id === item.id);
          return itemDagNode?.kind === 'check' ? { ...item, state: 'pending' as const } : item;
        });
      } else if (verdictVal.verdict === 'fail') {
        nextNodes = nextNodes.map(item =>
          item.id === nodeId ? { ...item, state: 'failed' as const } : item.state === 'pending' ? { ...item, state: 'not_run' as const } : item,
        );
      } else {
        nextNodes = nextNodes.map(item =>
          item.id === nodeId ? { ...item, state: 'blocked' as const } : item.state === 'pending' ? { ...item, state: 'not_run' as const } : item,
        );
      }
    } else {
      if (stepOutput?.kind === 'submission') {
        const retained = stepOutput.retained;
        const priorNodeSub = this.draft.nodeSubmissions?.[nodeId];
        nextNodeSubmissions = freeze({ ...(this.draft.nodeSubmissions ?? {}), [nodeId]: retained.raw });
        const keepPriorRicherAuthorClaims =
          this.submission !== null &&
          !(priorNodeSub !== undefined && same(priorNodeSub, this.submission.raw)) &&
          this.submission.value.status === 'completed' &&
          this.submission.value.checks.length > 0 &&
          retained.value.status === 'completed' &&
          retained.value.checks.length === 0;
        if (!keepPriorRicherAuthorClaims) {
          this.submission = retained;
        }
        nextSubmissionRef = this.submission!.raw;
      }
      nextNodes = nextNodes.map(item => (item.id === nodeId ? { ...item, state: 'completed' as const } : item));
    }

    const generation = this.generation + (changed || reworked ? 1 : 0);
    if (generation >= plan.capacity.V) refuse('ATTEMPT_LIMIT', '', 'execution');
    const after = stateValue(store.inspect()).counts;
    let draft: Draft = {
      ...this.draft,
      stage: { ...this.draft.stage, kind: 'role_post' },
      attempts: this.draft.attempts.map(item =>
        item.id === commandId ? { ...item, finished: { after: { requests: after.requests, operations: after.operations }, outcome: captured.outcome, nativeCheckpointId: captured.checkpointId } } : item,
      ),
      nativeCheckpoints: [...this.draft.nativeCheckpoints, { attemptId: commandId, checkpointId: captured.checkpointId, outcome: captured.outcome }],
      submission: nextSubmissionRef,
      candidate: { manifest: captured.manifest, digest: captured.digest, generation, workspace: captured.workspace, privateSession: captured.session },
      nodes: nextNodes,
      ...(nextReworkEpoch > 0 ? { reworkEpoch: nextReworkEpoch } : {}),
      ...(nextReworkCounts !== undefined && Object.keys(nextReworkCounts).length > 0 ? { reworkCounts: nextReworkCounts } : {}),
      ...(nextNodeSubmissions !== undefined && Object.keys(nextNodeSubmissions).length > 0 ? { nodeSubmissions: nextNodeSubmissions } : {}),
      ...(nextStepVerdicts !== undefined && nextStepVerdicts.length > 0 ? { stepVerdicts: nextStepVerdicts } : {}),
    };
    if (failure) {
      const signature = failureSignature({ category: 'format', codes: [failure], handler: expectedKind === 'verdict' ? 'step-verdict.v1' : 'submission.v1', handlerVersion: 1, target: nodeId, candidate: captured.digest, evidence: [failedRaw?.digest ?? hash('missing_submission')] });
      draft = { ...draft, failures: rememberFailure(draft.failures, signature, generation, failedRaw) };
    }
    if (repair === 'implementation' && !changed) {
      const requiredOutputs = this.currentChecks().filter(check => check.status === 'failed' && plan.task.spec.acceptance.required.includes(check.checkId)).map(check => check.output);
      draft = { ...draft, failures: draft.failures.map(item => item.evidence && requiredOutputs.some(output => same(item.evidence, output)) ? { ...item, count: Math.min(2, item.count + 1) } : item) };
    }
    if (changed && !reworked && !verdictHalted) {
      const downstreamSet = repair === 'implementation' ? new Set(descendants(plan, nodeId)) : null;
      draft = {
        ...draft,
        nodes: draft.nodes.map(item => {
          const itemDagNode = plan.orderedDAG.find(node => node.id === item.id)!;
          if (itemDagNode.kind === 'check' && (repair === 'implementation' || item.state !== 'not_run')) return { ...item, state: 'pending' };
          if (downstreamSet && downstreamSet.has(item.id) && itemDagNode.kind === 'agent' && itemDagNode.handler.parameters.purpose === 'review') return { ...item, state: 'pending' };
          return item;
        }),
      };
    }
    draft = { ...draft, nodes: this.nodeDispositions(draft.nodes, generation) };
    await this.publish(draft, 'role.' + ordinal + '.post');
    return failure;
  }
  async role(nodeId: string, repair: ControllerAttempt['repair'] = 'none', prompt?: string, retained?: ControllerAttempt): Promise<void> {
    await this.guard(); const { plan, lock, store, artifacts, authority, loaded, directory } = this.context, bounds = this.#overlayBounds();
    const delegatedCounts = countDelegatedBudgets(plan, this.draft.attempts);
    observeParentExhaustion(this.deadline.assert(), lock, delegatedCounts.modelCalls);
    const node = plan.orderedDAG.find(node => node.id === nodeId); if (!node || node.kind !== 'agent') refuse('CAPABILITY_UNSUPPORTED', '', 'execution');
    if (!retained && this.draft.attempts.length >= plan.capacity.A) refuse('ATTEMPT_LIMIT', '', 'execution');
    const originalRole = plan.roles.find(role => role.roleId === node.roleId)!;
    if (originalRole.adapter === 'delegated') refuse('CAPABILITY_UNSUPPORTED', '/spec/profiles/roles', 'execution');
    const role: PlannedRole = repair === 'format' ? { ...originalRole, policy: formatPolicy(originalRole.policy) } : originalRole;
    const purpose = node.handler.implementation === 'pi.compact.v1' ? 'compaction' : node.handler.parameters.purpose === 'review' ? 'reviewer' : 'task';
    const roleResources = roleResourcesFor(loaded, plan, role.roleId);
    if (!retained && purpose === 'compaction' && this.context.ports.decisions?.adviseSoftCompaction) {
      const contextUtilization = this.#contextUtilization();
      const failedVerificationLoops = this.#failedVerificationLoops();
      const hardTrigger = contextUtilization >= 0.8 || failedVerificationLoops >= 2;
      try {
        const advisory = await this.context.ports.decisions.adviseSoftCompaction({
          runId: lock.spec.runId,
          stepId: nodeId,
          roleId: role.roleId,
          contextUtilization,
          failedVerificationLoops,
        });
        if (advisory !== null && advisory !== undefined) {
          if (
            !isRecord(advisory) ||
            (advisory.advisoryDecision !== null &&
              (typeof advisory.advisoryDecision !== 'string' || !VALID_SOFT_COMPACTION_DECISIONS.has(advisory.advisoryDecision))) ||
            typeof advisory.source !== 'string' ||
            !VALID_ADVISORY_SOURCES.has(advisory.source)
          ) {
            throw new Error('invalid_soft_compaction_output');
          }
        }
        const vetoAttempted = hardTrigger && advisory?.advisoryDecision === 'defer';
        this.advisoryObservations.push({
          intent: 'advise_soft_compaction',
          stepId: nodeId,
          advisoryDecision: hardTrigger ? 'compact' : (advisory?.advisoryDecision ?? 'compact'),
          hardTriggerActive: hardTrigger,
          hardTriggerVetoRefused: vetoAttempted,
          source: advisory?.source ?? 'deterministic_heuristic',
        });
      } catch {
        this.advisoryObservations.push({
          intent: 'advise_soft_compaction',
          stepId: nodeId,
          advisoryDecision: 'compact',
          hardTriggerActive: hardTrigger,
          hardTriggerVetoRefused: false,
          source: 'deterministic_fallback',
        });
      }
    }
    if (!retained && purpose !== 'compaction') {
      await this.adviseCapabilityRouting(nodeId, role, purpose, roleResources);
    }
    const attemptEpoch = retained ? (retained.reworkEpoch ?? 0) : this.reworkEpoch;
    const nativeStepId = purpose === 'compaction' ? compactionTarget(plan, nodeId) : nodeId, ordinal = retained?.ordinal ?? this.draft.attempts.length + 1;
    const commandId = stableId(lock.spec.runId, nodeId, purpose, repair, ordinal), sessionId = nativeSessionId(lock.spec.runId, role.roleId, nativeStepId, role.policy, attemptEpoch);
    const configured = purpose === 'compaction' ? '' : text(loaded.registry.spec.handlers.find(handler => handler.id === node.handler.id)?.parameters.prompt);
    if (purpose !== 'compaction' && node.handler.parameters.prompt !== '[private command sha256:' + hash(configured).hex + ']') refuse('RECOVERY_REQUIRED', '', 'execution');
    const reworkCtx = repair === 'none' && prompt === undefined ? await this.activeReworkForNode(nodeId) : null;
    const defaultPrompt = reworkCtx ? reworkPrompt(configured, reworkCtx, Math.min(65_536, role.policy.limits.promptBytes)) : configured;
    const commandText = retained ? new TextDecoder('utf-8', { fatal: true }).decode(await artifacts.read(retained.command, 1048576)) : prompt ?? defaultPrompt;
    const command = await artifacts.put('command', Buffer.from(commandText), Math.min(1048576, role.policy.limits.promptBytes));
    const originalSubmission = this.draft.failures.at(-1)?.evidence ?? this.draft.submission, before = journal(store).view.counts, oldDigest = this.draft.candidate.digest;
    const originalState = await schedulingSnapshot(store, authority, lock, artifacts, this.candidate, this.draft.candidate);
    observeParentExhaustion(this.deadline.assert(), lock, delegatedCounts.modelCalls);
    const attempt: ControllerAttempt = retained ?? {
      ordinal, id: commandId, nodeId, nativeStepId, sessionId, purpose, repair, command,
      before: { requests: before.requests, operations: before.operations }, finished: null,
      ...(attemptEpoch > 0 ? { reworkEpoch: attemptEpoch } : {}),
    };
    if (retained) {
      if (!same(retained, { ...attempt, command, id: commandId, sessionId, nativeStepId, nodeId, purpose, repair, ...(attemptEpoch > 0 ? { reworkEpoch: attemptEpoch } : {}) }) || !same(this.draft.attempts.at(-1), retained) || retained.finished !== null) refuse('RECOVERY_REQUIRED', '', 'recovery');
    } else {
      if (repair === 'format') await artifacts.json('format-intent', { version: 1, attemptId: commandId, original: originalSubmission, schema: isVerdictStep(node) ? 'step-verdict.v1' : 'submission.v1', candidate: oldDigest, output: 'new_assistant_representation' }, 65536);
      await this.events.push(repair === 'none' ? 'role' : 'repair', null, nodeId, commandId);
      await this.publish({ ...this.draft, stage: { ...this.draft.stage, kind: 'role_pre' }, attempts: [...this.draft.attempts, attempt], nodes: this.draft.nodes.map(item => item.id === nodeId ? { ...item, state: 'running' } : item) }, 'role.' + ordinal + '.pre');
    }
    let restore: PiOpenInputV2['restore'] = null, nativeManifest = this.candidate.manifest;
    if (purpose === 'compaction' || repair === 'implementation') {
      const prior = this.draft.attempts.slice(0, -1).filter(item => item.nativeStepId === nativeStepId && item.sessionId === sessionId && item.finished?.nativeCheckpointId).at(-1);
      if (prior) {
        const wrapper = parsePrivateJson(await artifacts.read(prior.finished!.outcome, 4194304), 4194304, 16384) as Record<string, unknown>;
        const checkpoint = stateValue(store.getCheckpoint(prior.finished!.nativeCheckpointId!));
        if (same(checkpoint.subject.candidateDigest, this.draft.candidate.digest)) {
          const identified = identifyManifest(parsePrivateJson(await artifacts.read(checkedRef(wrapper.originalManifest), bounds.manifestMaxBytes), bounds.manifestMaxBytes, bounds.collectionLimit), bounds.options); if (!identified.ok) refuse('RECOVERY_REQUIRED', '', 'recovery'); nativeManifest = identified.value.manifest;
          restore = { checkpointId: checkpoint.checkpointId, workspace: { ref: checkpoint.workspace, bytes: await artifacts.read(checkpoint.workspace, Math.max(8_388_608, bounds.v2WorkspaceJsonMaxBytes, bounds.workspaceMaxBytes)) }, session: { ref: checkpoint.privateSession!, bytes: await artifacts.read(checkpoint.privateSession!, 67108864) } };
        }
      }
      if (purpose === 'compaction' && restore === null) refuse('CAPABILITY_UNSUPPORTED', '', 'execution');
    }
    const hostDirectory = join(directory, 'runtime', commandId); await privateDirectory(hostDirectory);
    let baseline: PiOpenInputV2['candidate']['baseline'];
    if (this.context.source.version === 2) {
      const baselineDirectory = join(hostDirectory, 'baseline');
      await materializeBaseline(this.context.source, baselineDirectory, this.context.owner, this.deadline);
      baseline = { directory: baselineDirectory, entries: this.context.source.baselineEntries ?? [] };
    }
    const host: PiHostV2 = { store, authority, directory: hostDirectory, artifactsDirectory: artifacts.directory, dockerExecutable: role.runtime.dockerExecutable, dockerSocket: role.runtime.dockerSocket, runtime: role.runtime.identity,
      createCandidateStreamChecker: () => approvedState(loaded).vault.createStreamChecker(),
      ...approvedState(loaded).vault.bind({ runId: lock.spec.runId, roleId: role.roleId, stepId: nativeStepId, providerCredentialRef: role.providerCredentialRef, selection: role.policy.selection, mcp: role.policy.mcp }) };
    const piCandidateArtifacts: readonly PiCandidateArtifactInput[] = this.candidate.files.map(file =>
      'bytes' in file
        ? { name: file.name, bytes: file.bytes }
        : { name: file.name, byteLength: file.byteLength, digest: file.digest, blobPath: file.blobPath },
    );
    const input: PiOpenInputV2 = { version: 2, lock, roleId: role.roleId, stepId: nativeStepId, sessionId, policy: role.policy, candidate: { manifest: nativeManifest, baseRevision: plan.task.spec.target.baseRevision, sourceRevision: plan.task.spec.target.sourceRevision, artifacts: piCandidateArtifacts, ...(baseline ? { baseline } : {}) }, resources: roleResources, restore };
    const release = await this.context.owner.holdLocalActivity(); let noEffectMcpAuth = false;
let cleanupKnown = false, reader: Promise<void> | null = null, nativeOutcome: ArtifactRef | null = null; let structureFailure: ControllerDiagnostic['code'] | null;
    let noEffectBudget = false;
    let midSessionBudget: { readonly piCode: string; readonly stateCode: string | null } | null = null;
    const closeLocal = async (): Promise<void> => {
      this.deadline.onStop(null);
      if (this.#activeAdapter) { const active = this.#activeAdapter; this.#activeAdapter = null; const closed = await active.close(); cleanupKnown = closed.ok; if (!closed.ok) this.#cleanup = 'failed'; }
      if (reader) { const draining = reader; reader = null; try { await draining; } catch { cleanupKnown = false; this.#cleanup = 'failed'; this.deadline.stop('OUTPUT_LIMIT'); } }
    };
    try {
      this.deadline.assert(); const opened = await (this.context.ports.openAdapter ?? openPiAdapterV2)(host, input);
      if (!opened.ok) { cleanupKnown = opened.error.code !== 'CLEANUP_FAILED'; noEffectBudget = isNoEffectBudgetRefusal(opened.error); if (opened.error.effect !== 'none' || !cleanupKnown) this.#candidateKnown = false; refuse(opened.error.code === 'MCP_AUTHENTICATION_REQUIRED' ? 'MCP_AUTHENTICATION_REQUIRED' : 'CAPABILITY_UNSUPPORTED', '', 'execution', { piCode: opened.error.code, stateCode: opened.error.stateErrorCode, effect: opened.error.effect }); }
      const adapter = opened.value; this.#activeAdapter = adapter;
      this.deadline.onStop(async reason => { const stopped = await adapter.cancel({ reason: reason === 'DEADLINE' ? 'deadline' : reason === 'CANCELLED' ? 'operator' : 'consumer_disconnected' }); if (!stopped.ok || stopped.value.localCleanup !== 'complete') refuse('CLEANUP_FAILED', '', 'finalization'); });
      reader = (async () => { for await (const event of adapter.events()) { await this.events.push('role', null, nodeId, commandId); if (event.kind === 'request_uncertain') this.deadline.stop('AUTHORITY_REFUSED'); } })().catch(() => { this.deadline.stop('OUTPUT_LIMIT'); });
      // Opening/management is bounded, then the original work cutoff is checked again before the only command call.
      this.deadline.assert(); this.#candidateKnown = false;
      const executed = purpose === 'compaction' ? await adapter.compact({ commandId }) : await adapter.execute({ commandId, text: commandText, purpose, repair });
      if (!executed.ok) { noEffectBudget = isNoEffectBudgetRefusal(executed.error);
        if (executed.error.code === 'MCP_AUTHENTICATION_REQUIRED' && executed.error.effect === 'none') noEffectMcpAuth = true;
        if (!noEffectBudget && isBudgetRefusal(executed.error) && executed.error.effect === 'confirmed') {
          midSessionBudget = { piCode: executed.error.code, stateCode: executed.error.stateErrorCode };
        }
        refuse('RECOVERY_REQUIRED', '', 'execution', { piCode: executed.error.code, stateCode: executed.error.stateErrorCode, effect: executed.error.effect }); }
      const outcome: PiOutcomeV2 = executed.value; nativeOutcome = await artifacts.json('native-outcome', { version: 1, attemptId: commandId, outcome }, 524288);
      noEffectBudget = outcome.error !== null && isNoEffectBudgetRefusal(outcome.error) && outcome.requestIds.length === 0 && outcome.operationIds.length === 0
        && outcome.providerTermination === 'none' && outcome.usage === 'none' && outcome.localCleanup === 'complete' && outcome.cleanupError === null;
      noEffectMcpAuth = outcome.error?.code === 'MCP_AUTHENTICATION_REQUIRED' && outcome.error?.effect === 'none' && outcome.requestIds.length === 0 && outcome.operationIds.length === 0
        && outcome.providerTermination === 'none' && outcome.usage === 'none' && outcome.localCleanup === 'complete' && outcome.cleanupError === null;
      if (outcome.status === 'blocked' && outcome.error?.code === 'MCP_AUTHENTICATION_REQUIRED' && outcome.providerTermination === 'confirmed' && outcome.usage === 'complete' && outcome.localCleanup === 'complete' && outcome.cleanupError === null) {
        this.deadline.assert(); const captured = await captureRole(adapter, store, artifacts, lock, role, attempt, outcome, this.context.source, cycleHostProtection(this.context)); structureFailure = await this.completeCapture(attempt, captured); refuse('MCP_AUTHENTICATION_REQUIRED', '', 'execution', { piCode: 'MCP_AUTHENTICATION_REQUIRED', effect: outcome.error.effect }); }
      if (!noEffectBudget && outcome.status === 'failed' && outcome.error !== null && isBudgetRefusal(outcome.error) && outcome.error.effect === 'confirmed' && outcome.providerTermination === 'confirmed' && outcome.usage === 'complete' && outcome.localCleanup === 'complete' && outcome.cleanupError === null) {
        midSessionBudget = { piCode: outcome.error.code, stateCode: outcome.error.stateErrorCode };
      }
      if (outcome.status !== 'execution_settled' || outcome.providerTermination !== 'confirmed' || outcome.usage !== 'complete') refuse('RECOVERY_REQUIRED', '', 'execution', { piCode: outcome.error?.code ?? null, effect: outcome.error?.effect ?? 'possible' });
      this.deadline.assert(); const captured = await captureRole(adapter, store, artifacts, lock, role, attempt, outcome, this.context.source, cycleHostProtection(this.context));
      if ((repair === 'format' || purpose === 'compaction') && !same(captured.digest, oldDigest)) refuse('CAPABILITY_UNSUPPORTED', '', 'execution', { effect: 'confirmed' });
      structureFailure = await this.completeCapture(attempt, captured);
      if (stateValue(store.inspect()).ledger.admittedCalls + delegatedCounts.modelCalls > lock.spec.contract.spec.budgets.maxModelCalls) {
        cleanupKnown = true;
        this.#candidateKnown = true;
        refuse('BUDGET_EXHAUSTED', '', 'execution', { stateCode: 'BUDGET_EXHAUSTED', effect: 'none' });
      }
    } catch (error) {
      let failure = error;
      if (noEffectBudget || noEffectMcpAuth) {
        this.#candidateKnown = false;
        await closeLocal();
        if (cleanupKnown && this.deadline.reason === null) {
          const afterState = await schedulingSnapshot(store, authority, lock, artifacts, this.candidate, this.draft.candidate);
          if (same(originalState, afterState)) { this.#candidateKnown = true; failure = new ControllerFailure({ ...safeDiagnostic(failure, 'execution'), code: noEffectMcpAuth ? 'MCP_AUTHENTICATION_REQUIRED' : 'BUDGET_EXHAUSTED', stateCode: noEffectMcpAuth ? null : 'BUDGET_EXHAUSTED', piCode: noEffectMcpAuth ? 'MCP_AUTHENTICATION_REQUIRED' : null, effect: 'none' }); }
          else this.#candidateKnown = false;
        } else this.#candidateKnown = false;
      } else if (midSessionBudget) {
        this.#candidateKnown = false;
        await closeLocal();
        const facts = store.inspect();
        if (cleanupKnown && this.deadline.reason === null && facts.ok && storeFactsCertain(facts.value)) {
          failure = new ControllerFailure({
            ...safeDiagnostic(failure, 'execution'),
            code: 'BUDGET_EXHAUSTED',
            stateCode: midSessionBudget.stateCode,
            piCode: midSessionBudget.piCode,
            effect: 'confirmed',
          });
        }
      }
      if (this.head?.progress.attempts.at(-1)?.id === commandId && this.head.progress.attempts.at(-1)!.finished === null) {
        const diagnostic = safeDiagnostic(failure, 'execution'), after = stateValue(store.inspect()).counts;
        const outcome = await artifacts.json('role-refusal', { version: 1, attemptId: commandId, command, diagnostic, nativeOutcome, currentCandidate: this.#candidateKnown ? this.draft.candidate.manifest : null, unavailable: this.#candidateKnown ? [] : ['current_candidate', 'submission'], localCleanup: cleanupKnown ? 'complete' : 'pending' }, 65536);
        await this.publish({ ...this.draft, stage: { ...this.draft.stage, kind: 'role_post' }, attempts: this.draft.attempts.map(item => item.id === commandId ? { ...item, finished: { after: { requests: after.requests, operations: after.operations }, outcome, nativeCheckpointId: null } } : item), nodes: this.draft.nodes.map(item => item.id === nodeId ? { ...item, state: 'failed' } : descendants(plan, nodeId).includes(item.id) && item.state === 'pending' ? { ...item, state: 'not_run' } : item) }, 'role.' + ordinal + '.post');
      }
      throw failure;
    } finally {
      await closeLocal();
      if (cleanupKnown) release(); else if (this.#cleanup === 'complete') this.#cleanup = 'pending';
    }
    if (structureFailure === 'SUBMISSION_AMBIGUOUS') refuse(structureFailure, '', 'verification');
    if (structureFailure === 'SUBMISSION_INVALID') await this.repairFormat(nodeId);
  }
  async resumeAttempt(adopt: boolean): Promise<void> {
    const attempt = this.draft.attempts.at(-1); if (!attempt || attempt.finished !== null) return;
    if (!adopt) { await this.role(attempt.nodeId, attempt.repair, undefined, attempt); return; }
    const original = this.context.plan.roles.find(role => role.roleId === this.context.plan.orderedDAG.find(node => node.id === attempt.nodeId)!.roleId)!;
    const role = attempt.repair === 'format' ? { ...original, policy: formatPolicy(original.policy) } : original;
    const captured = await adoptRoleCapture(this.context.store, this.context.artifacts, this.context.lock, role, attempt, undefined, this.context.source, cycleHostProtection(this.context));
    const failure = await this.completeCapture(attempt, captured);
    if (failure === 'SUBMISSION_AMBIGUOUS') refuse(failure, '', 'verification');
    if (failure === 'SUBMISSION_INVALID') await this.repairFormat(attempt.nodeId);
  }
  repairBound(kind: 'format' | 'implementation', actionable: boolean, repeats?: number): void {
    const view = this.deadline.assert(), { plan } = this.context, delegated = countDelegatedBudgets(plan, this.draft.attempts);
    const latest = this.draft.failures.at(-1), refusal = repairDisposition(kind, { attempts: this.draft.attempts.length, maxAttempts: plan.capacity.A,
      formatRepairs: view.ledger.formatRepairs + delegated.formatRepairs, implementationRepairs: view.ledger.implementationRepairs + delegated.implementationRepairs, maxFormatRepairs: plan.budgets.maxFormatRepairs, maxImplementationRepairs: plan.budgets.maxImplementationRepairs,
      repeats: repeats ?? latest?.count ?? 0, actionable, uncertain: !storeFactsCertain(view) });
    if (refusal) refuse(refusal, '', 'execution');
  }
  async formatRepairPrompt(nodeId: string): Promise<string> {
    const raw = this.draft.failures.at(-1)?.evidence ?? this.draft.submission;
    this.repairBound('format', raw !== null);
    if (!raw) refuse('EVIDENCE_UNAVAILABLE', '', 'verification');
    const node = this.context.plan.orderedDAG.find(item => item.id === nodeId);
    const role = this.context.plan.roles.find(item => item.roleId === node?.roleId);
    const maxPromptBytes = role ? Math.min(16384, role.policy.limits.promptBytes) : 16384;
    const bytes = await this.context.artifacts.read(raw, 1048576);
    if (isVerdictStep(node)) {
      return verdictFormatPrompt(bytes, maxPromptBytes);
    }
    const allowedCheckIds = this.context.plan.task.spec.acceptance.checks.map(item => item.id);
    return formatPrompt(bytes, allowedCheckIds, maxPromptBytes);
  }
  async repairFormat(nodeId: string): Promise<void> {
    const prompt = await this.formatRepairPrompt(nodeId);
    await this.role(nodeId, 'format', prompt);
  }
  currentChecks(): readonly VerifiedCheck[] { return [...this.checks.values()].filter(check => check.generation === this.generation); }
  currentRefusals(): readonly PreflightRefusal[] { return [...this.refusals.values()].filter(item => item.generation === this.generation); }
  async verifyEligible(): Promise<void> {
    for (const slot of this.context.plan.verifierSlots) {
      const nodes = this.context.plan.orderedDAG.filter(node => node.kind === 'check' && node.handler.id === slot.handler.id);
      if (nodes.some(node => this.draft.nodes.find(item => item.id === node.id)?.state !== 'completed')) continue;
      await this.runVerifier(slot.id);
    }
  }
  async graph(): Promise<void> {
    const { plan } = this.context;
    for (;;) {
      const node = nextNode(plan, this.draft.nodes); if (!node) break;
      if (node.kind === 'agent') await this.role(node.id);
      else {
        const slot = plan.verifierSlots.find(slot => slot.handler.id === node.handler.id); if (!slot) refuse('CAPABILITY_UNSUPPORTED', '', 'verification');
        const epochBefore = this.reworkEpoch;
        const checked = await this.runVerifier(slot.id), state = checked.status === 'passed' ? 'completed' : checked.status;
        const actualState = this.draft.nodes.find(item => item.id === node.id)!.state;
        const validCheckRework =
          node.onRework !== undefined &&
          checked.status === 'failed' &&
          ((this.reworkEpoch === epochBefore + 1 && actualState === 'pending') ||
            (this.haltedVerdictStatus() === 'blocked' && actualState === 'blocked'));
        // Node disposition is part of the same predefined post-job boundary, never an extra checkpoint.
        if (actualState !== state && !validCheckRework) refuse('RECOVERY_REQUIRED', '', 'execution');
      }
    }
    await this.verifyEligible();
  }
  async prepareImplementationRepair(): Promise<{ readonly targetNodeId: string; readonly role: PlannedRole; readonly prompt: string } | null> {
    const { plan } = this.context; if (plan.budgets.maxImplementationRepairs === 0) return null;
    const checks = this.currentChecks(), required = plan.verifierSlots.filter(slot => slot.implicit === null && plan.task.spec.acceptance.required.includes(slot.checkId));
    const failed = checks.filter(check => check.status === 'failed' && required.some(slot => slot.id === check.slotId));
    if (!failed.length || this.submission?.value.status === 'no_change' && !plan.noChangeEligibility.available) return null;
    const allAvailable = required.every(slot => checks.some(check => check.slotId === slot.id && check.status !== 'blocked'));
    if (!allAvailable || checks.some(check => plan.verifierSlots.find(slot => slot.id === check.slotId)!.implicit === 'scope' && check.status !== 'passed')) return null;
    const isMutating = (role: PlannedRole) => role.policy.tools.some(tool => tool === 'write' || tool === 'edit' || tool === 'delete' || tool === 'bash');
    const mutatingTasks = this.draft.attempts.filter(
      attempt => attempt.purpose === 'task' && attempt.repair !== 'format' && attempt.finished?.nativeCheckpointId && isMutating(plan.roles.find(role => role.roleId === plan.orderedDAG.find(node => node.id === attempt.nodeId)!.roleId)!),
    );
    const prior = mutatingTasks.filter(attempt => (attempt.reworkEpoch ?? 0) === this.reworkEpoch).at(-1) ?? mutatingTasks.at(-1);
    const target = prior?.nodeId, node = plan.orderedDAG.find(node => node.id === target), role = plan.roles.find(role => role.roleId === node?.roleId);
    if (!node || !role || !isMutating(role)) return null;
    this.repairBound('implementation', true, Math.max(0, ...this.draft.failures.filter(item => failed.some(check => same(check.output, item.evidence))).map(item => item.count)));
    const candidateDigest = this.draft.candidate.digest;
    if (!(await this.evaluateAlignment('implementation_repair', target!, candidateDigest))) return null;
    const findings: {
      checkId: string;
      handler: typeof plan.verifierSlots[number]['handler']['implementation'];
      code: string | null;
      detail?: string;
      parameters: typeof plan.verifierSlots[number]['handler']['parameters'];
      candidate: typeof candidateDigest;
    }[] = failed.map(check => {
      const slot = plan.verifierSlots.find(slot => slot.id === check.slotId)!;
      let detail: string | undefined;
      if (slot.handler.implementation === 'gate.v1') {
        const trusted = authenticatedGate(check);
        try {
          const parsed = parsePrivateJson(Buffer.from(trusted.outputBytes), 65536);
          const verdict = isRecord(parsed) && isRecord(parsed.verdict) ? parsed.verdict : null;
          if (verdict && typeof verdict.reason === 'string' && verdict.reason.length > 0) {
            detail = Array.from(verdict.reason).slice(0, 256).join('');
          }
        } catch {
          // Malformed gate payload must not crash failure repair; fall back to default detail.
        }
      }
      return {
        checkId: check.checkId,
        handler: slot.handler.implementation,
        code: check.reason,
        ...(detail !== undefined ? { detail } : {}),
        parameters: slot.handler.parameters,
        candidate: candidateDigest,
      };
    });
    const maxPromptBytes = Math.min(16384, role.policy.limits.promptBytes);
    const prefix = 'Repair only the admitted writable candidate to satisfy these authenticated current-candidate findings. Return the complete structured submission; evidence claims will be independently checked. Findings:\n';
    let prompt = prefix + canonical(findings);
    if (Buffer.byteLength(prompt, 'utf8') > maxPromptBytes) {
      for (let index = findings.length - 1; index >= 0 && Buffer.byteLength(prompt, 'utf8') > maxPromptBytes; index--) {
        if (findings[index]!.detail !== undefined) {
          delete findings[index]!.detail;
          prompt = prefix + canonical(findings);
        }
      }
      while (findings.length > 1 && Buffer.byteLength(prompt, 'utf8') > maxPromptBytes) {
        findings.pop();
        prompt = prefix + canonical(findings);
      }
    }
    return { targetNodeId: target!, role, prompt };
  }
  async implementationRepair(): Promise<boolean> {
    const spec = await this.prepareImplementationRepair();
    if (!spec) return false;
    await this.role(spec.targetNodeId, 'implementation', spec.prompt);
    return true;
  }
  async ensureSubmissionForAcceptance(): Promise<void> {
    if (this.submission) return;
    if ((this.draft.stepVerdicts?.length ?? 0) > 0) {
      const forced = this.haltedVerdictStatus();
      const status: Submission['status'] = forced === 'failed' ? 'failed' : forced === 'blocked' ? 'blocked' : 'completed';
      const value: Submission = { version: 1, status, checks: [], reason: status === 'completed' ? null : 'step_verdict_' + status };
      const raw = await this.context.artifacts.json('submission', value, 1048576);
      this.submission = { version: 1, origin: 'controller', raw, value };
      return;
    }
    if (this.context.plan.orderedDAG.some(node => node.kind === 'agent')) refuse('EVIDENCE_UNAVAILABLE', '', 'verification');
    const value: Submission = { version: 1, status: 'completed', checks: [], reason: null };
    const raw = await this.context.artifacts.json('submission', value, 1048576);
    this.submission = { version: 1, origin: 'controller', raw, value };
  }
  async execute(): Promise<AcceptanceObservation> {
    if (!this.head) await this.bootstrap();
    else {
      if (this.head.progress.attempts.at(-1)?.finished === null) await this.resumeAttempt(this.resumeAdoption === true);
      const retained = [...this.head.progress.verifierReceipts, ...this.head.progress.verifierRefusals].filter(row => row.generation === this.generation);
      for (const row of retained) await this.runVerifier(row.slot);
      const attempt = this.draft.attempts.at(-1);
      if (attempt?.finished?.nativeCheckpointId === null) {
        await refuseFromRoleOutcome(this.context.artifacts, attempt.finished.outcome, this.draft.candidate.manifest, () => { this.#candidateKnown = false; });
      }
      if (attempt?.finished?.nativeCheckpointId && attempt.purpose !== 'compaction' && !this.haltedVerdictStatus() && this.draft.nodes.find(node => node.id === attempt.nodeId)?.state === 'failed') {
        await this.repairFormat(attempt.nodeId);
      }
    }
    await this.graph();
    for (;;) {
      await this.ensureSubmissionForAcceptance();
      const verdictHalt = this.haltedVerdictStatus();
      const acceptance = evaluateControllerAcceptance(
        this.context.plan,
        this.context.lock,
        this.candidate.manifest,
        this.candidate.files,
        this.generation,
        this.currentChecks(),
        this.submission!.value,
        this.context.store,
        verdictHalt,
        this.draft.nodes.every(node => node.state === 'completed'),
        this.currentRefusals(),
      );
      if (verdictHalt === null && acceptance.result.spec.status === 'failed' && await this.implementationRepair()) {
        await this.graph();
        continue;
      }
      return acceptance.result.spec.status === 'completed' ? await this.publishBoundary(acceptance) : acceptance;
    }
  }
  async publishBoundary(acceptance: AcceptanceObservation): Promise<AcceptanceObservation> {
    const { plan, lock, store, loaded } = this.context, publication = plan.publication, overlayOpts = this.#overlayBounds().options;
    if (publication.mode !== 'pull_request' || ['confirmed', 'failed', 'unresolved'].includes(this.draft.publication.status)) return acceptance;
    const view = stateValue(store.inspect()), endpoint = loaded.registry.spec.publicationEndpoints.find(item => item.id === publication.endpointRef);
    if (!endpoint) refuse('CONFIG_REFERENCE', '/spec/publication', 'execution');
    const subject = (() => { const bound = bindSubject(lock, this.candidate.manifest, overlayOpts); if (!bound.ok) refuse('ARTIFACT_INVALID', '', 'execution'); return bound.value; })();
    const scope = acceptance.verifierMatrix.find(row => row.implicit === 'scope');
    const head = headRevision(this.context.descriptor.repository);
    if (![plan.task.spec.target.baseRevision, plan.task.spec.target.sourceRevision].includes(head)) refuse('TARGET_MISMATCH', '', 'execution');
    if (this.draft.publication.status !== 'pending') {
      const eligible = this.draft.nodes.every(node => node.state === 'completed') && scope?.status === 'passed'
        && storeFactsCertain(view)
        && this.submission !== null && this.submission.value.status === 'completed'
        && same(this.draft.candidate.digest, subject.candidateDigest);
      if (!eligible) { this.#publicationObservation = { status: 'not_run', reason: 'ineligible', receipt: null }; return acceptance; }
    }
    const prepared: PreparedPublication = preparePublication(plan, lock, view.storeId, endpoint, subject);
    const operation = store.getOperation(prepared.operationId);
    await this.events.push('publication', null);
    if (!this.head?.progress.stage.consumed.includes('publication.pre')) await this.publish({ ...this.draft, stage: { ...this.draft.stage, kind: 'publication_pre' }, publication: { status: 'pending', operationId: prepared.operationId, receipt: null } }, 'publication.pre');
    this.deadline.assert();
    const result = !operation.ok && operation.error.code === 'RECORD_NOT_FOUND'
      ? await this.publisher.run(prepared, endpoint, this.deadline.abort.signal)
      : await this.publisher.restore(prepared, endpoint);
    if (result.kind === 'settled') {
      this.#publicationObservation = result.outcome === 'succeeded'
        ? { status: 'confirmed', reason: null, receipt: result.receiptRef }
        : { status: 'failed', reason: 'not_executed', receipt: result.receiptRef };
      await this.publish({ ...this.draft, stage: { ...this.draft.stage, kind: 'publication_post' }, publication: { status: result.outcome === 'succeeded' ? 'confirmed' : 'failed', operationId: prepared.operationId, receipt: result.receiptRef } }, 'publication.post');
    } else {
      this.#publicationObservation = { status: 'unresolved', reason: result.reason, receipt: null };
      await this.publish({ ...this.draft, stage: { ...this.draft.stage, kind: 'publication_post' }, publication: { status: 'unresolved', operationId: prepared.operationId, receipt: null } }, 'publication.post');
    }
    return evaluateControllerAcceptance(plan, lock, this.candidate.manifest, this.candidate.files, this.generation, this.currentChecks(), this.submission!.value, store, null, this.draft.nodes.every(node => node.state === 'completed'), this.currentRefusals());
  }
  async terminal(primary: AcceptanceObservation | ControllerIncident, drainWindowMs = 0): Promise<CycleExecution> {
    const { store, artifacts, lock } = this.context, secondary: ControllerDiagnostic['code'][] = [];
    const accepted = 'result' in primary, status = accepted ? primary.result.spec.status : primary.code;
    let observations: ArtifactRef | null = null, primaryRef: ArtifactRef | null = null, admitted = false;
    const current = stateValue(store.inspect()), finalizer = new Finalizer(artifacts, Math.max(current.clock.remainingTaskMs.safeValue ?? 0, drainWindowMs));
    const checkpoint = async (kind: 'terminal_intent' | 'terminal_result' | 'terminal_observations', phase: string): Promise<void> => {
      // Worst-case logical progress, receipt index and checkpoint framing; no extra allowance is granted.
      finalizer.reserve(65536 + 65536 + 40960);
      const stopped = accepted && ['exhausted', 'expired', 'cancelled'].includes(primary.result.spec.status);
      await this.publish({ ...this.draft, stage: { ...this.draft.stage, kind }, nodes: this.draft.nodes.map(node => stopped && node.state === 'pending' ? { ...node, state: 'not_run' } : node), terminalIntent: { primary: status, result: primaryRef, observations } }, phase); finalizer.check();
    };
    try {
      primaryRef = await finalizer.put(accepted ? 'result' : 'incident', accepted ? primary.result : primary);
      await checkpoint('terminal_intent', 'terminal.intent'); admitted = true;
      await this.events.push('terminal', accepted ? null : primary.code);
      await checkpoint('terminal_result', 'terminal.result');
      // Event bytes were already synced during work. Sealing is no-overwrite metadata, not a final body rewrite.
      const eventsRef = await this.events.close(); finalizer.check();
      const storedVerdicts = this.head?.progress.stepVerdicts ?? [];
      const hydratedVerdicts = await hydrateStepVerdicts(artifacts, storedVerdicts);
      const boundedFindings = boundFindingsForObservations(hydratedVerdicts.flatMap(item => item.verdict.findings));
      observations = await finalizer.put('observations', {
        version: 1,
        primary: primaryRef,
        requestedStatus: accepted ? primary.requestedStatus : null,
        diagnostic: accepted ? primary.diagnostic : primary.code,
        requestedStatusSource: this.submission === null ? 'unavailable' : this.submission.origin === 'controller' ? 'controller_check_only' : 'captured_submission',
        selectedNoChangeCheck: accepted ? primary.selectedNoChangeCheck : this.context.plan.noChangeEligibility.checkId,
        contradictions: accepted ? primary.contradictions : [],
        verifierMatrix: accepted ? primary.verifierMatrix : null,
        verification: accepted ? primary.verification : null,
        preflightRefusals: accepted ? primary.preflightRefusals : null,
        events: eventsRef,
        cleanup: this.#cleanup,
        memory: { status: 'not_requested', reason: null },
        publication: this.#publicationObservation,
        ...(storedVerdicts.length > 0 ? { stepVerdicts: storedVerdicts } : {}),
        ...(boundedFindings.findings.length > 0 ? { findings: boundedFindings.findings } : {}),
        ...(boundedFindings.findingsTruncated ? { findingsTruncated: true, totalFindingsCount: boundedFindings.totalFindingsCount } : {}),
        ...(this.advisoryObservations.length > 0 ? { advisoryDecisions: this.advisoryObservations } : {}),
      });
      await checkpoint('terminal_observations', 'terminal.observations');
    } catch (error) { secondary.push(safeDiagnostic(error, 'finalization').code); }
    finally { try { await this.events.close(); } catch { secondary.push('CLEANUP_FAILED'); this.#cleanup = 'pending'; } }
    const finalVerdicts = await hydrateStepVerdicts(artifacts, this.head?.progress.stepVerdicts).catch(() => []);
    const finalFindings: StructuredFinding[] = finalVerdicts.flatMap(item => item.verdict.findings);
    if (!admitted) return freeze({ kind: 'incident', version: 1, incident: incident({ version: 1, code: 'RECOVERY_REQUIRED', phase: 'finalization', path: '', stateCode: null, piCode: null, effect: 'possible', retryable: false }, lock.spec.runId, lock.spec.lockHash, [this.context.descriptor.plan, this.context.source.inventory, ...(primaryRef ? [primaryRef] : [])], ['terminal_admission'], this.#cleanup) });
    if (accepted) {
      return freeze({
        kind: 'result',
        version: 1,
        runId: lock.spec.runId,
        result: primary.result,
        observations,
        secondary,
        ...(finalFindings.length > 0 ? { findings: freeze(finalFindings) } : {}),
        ...(finalVerdicts.length > 0 ? { stepVerdicts: freeze([...finalVerdicts]) } : {}),
      });
    }
    return freeze({ kind: 'incident', version: 1, incident: primary });
  }
  async finish(): Promise<CycleExecution> {
    let primary: AcceptanceObservation | ControllerIncident;
    try { primary = await this.execute(); }
    catch (error) {
      const diagnostic = safeDiagnostic(error, 'execution');
      if (diagnostic.code === 'CAPABILITY_UNSUPPORTED' && diagnostic.path === '/spec/profiles/roles') {
        try { await this.deadline.dispose(); } catch { /* ignore */ }
        throw error;
      }
      const facts = this.context.store.inspect();
      const certain = facts.ok && facts.value.clockStatus === 'trusted' && !facts.value.counts.dispatchedRequests && !facts.value.counts.unresolvedRequests && !facts.value.counts.unresolvedOperations && !facts.value.ledger.violations.length;
      if (this.#candidateKnown && facts.ok && (['DEADLINE', 'CANCELLED', 'BUDGET_EXHAUSTED', 'ATTEMPT_LIMIT', 'REPEAT_FAILURE'].includes(diagnostic.code) || (certain && ['CAPABILITY_UNSUPPORTED', 'MCP_AUTHENTICATION_REQUIRED', 'EVIDENCE_UNAVAILABLE', 'SUBMISSION_AMBIGUOUS', 'SUBMISSION_INVALID'].includes(diagnostic.code)))) {
        const forced = diagnostic.code === 'DEADLINE' ? 'expired' : diagnostic.code === 'CANCELLED' ? 'cancelled' : ['SUBMISSION_AMBIGUOUS', 'SUBMISSION_INVALID'].includes(diagnostic.code) ? 'failed' : ['CAPABILITY_UNSUPPORTED', 'MCP_AUTHENTICATION_REQUIRED', 'EVIDENCE_UNAVAILABLE'].includes(diagnostic.code) ? 'blocked' : 'exhausted';
        const forcedDiagnostic = ['CAPABILITY_UNSUPPORTED', 'MCP_AUTHENTICATION_REQUIRED', 'EVIDENCE_UNAVAILABLE', 'SUBMISSION_AMBIGUOUS', 'SUBMISSION_INVALID'].includes(diagnostic.code) ? diagnostic.code : null;
        try { primary = evaluateControllerAcceptance(this.context.plan, this.context.lock, this.candidate.manifest, this.candidate.files, this.generation, this.currentChecks(), this.submission?.value ?? null, this.context.store, forced, this.draft.nodes.every(node => node.state === 'completed'), this.currentRefusals(), forcedDiagnostic); }
        catch { primary = incident(diagnostic, this.context.lock.spec.runId, this.context.lock.spec.lockHash, [this.context.descriptor.plan, this.context.source.inventory], ['authoritative_result'], this.#cleanup); }
      } else primary = incident(diagnostic, this.context.lock.spec.runId, this.context.lock.spec.lockHash, [this.context.descriptor.plan, this.context.source.inventory], this.#candidateKnown ? ['authoritative_result'] : ['current_candidate', 'submission', 'authoritative_result'], this.#cleanup);
    }
    try { await this.deadline.dispose(); } catch { this.#cleanup = 'failed'; }
    if (this.#cleanup !== 'complete' && 'result' in primary) primary = incident({ version: 1, code: 'CLEANUP_FAILED', phase: 'finalization', path: '', stateCode: null, piCode: null, effect: 'possible', retryable: false }, this.context.lock.spec.runId, this.context.lock.spec.lockHash, [this.context.descriptor.plan, this.context.source.inventory], ['local_cleanup'], this.#cleanup);
    return this.terminal(primary);
  }
}
export async function executeCycleContext(context: CycleContext, restored?: { readonly head: ProgressHead | null; readonly candidate: ByteInventory; readonly submission: RetainedSubmission | null; readonly adopt: boolean }): Promise<CycleExecution> {
  let execution: CycleExecution | undefined;
  let delegatedUnsupported: ControllerFailure | null = null;
  try {
    const cycle = new Cycle(context, restored?.head, restored?.candidate, restored?.adopt);
    cycle.submission = restored?.submission ?? null;
    execution = await cycle.finish();
  }
  catch (error) {
    if (error instanceof ControllerFailure && error.diagnostic.code === 'CAPABILITY_UNSUPPORTED' && error.diagnostic.path === '/spec/profiles/roles') {
      delegatedUnsupported = error;
    } else {
      execution = { kind: 'incident', version: 1, incident: incident(safeDiagnostic(error, 'execution'), context.lock.spec.runId, context.lock.spec.lockHash, [context.descriptor.plan, context.source.inventory], ['authoritative_result'], 'pending') };
    }
  }
  let cleanup: boolean;
  try { const released = context.store.release(context.authority); const closed = context.store.close(); cleanup = released.ok && closed.ok; if (cleanup) await context.owner.release(); } catch { cleanup = false; }
  if (!cleanup) return { kind: 'incident', version: 1, incident: incident({ version: 1, code: 'CLEANUP_FAILED', phase: 'finalization', path: '', stateCode: null, piCode: null, effect: 'possible', retryable: false }, context.lock.spec.runId, context.lock.spec.lockHash, [context.descriptor.plan, context.source.inventory], ['owner_release', 'authoritative_cleanup'], 'pending') };
  if (delegatedUnsupported) throw delegatedUnsupported;
  return execution!;
}
export function runCycle(input: RunCycleInput) { return runCycleWithPorts(input); }
export function runCycleWithPorts(input: RunCycleInput, ports: ControllerPorts = {}) {
  return result(async () => {
    const fields = Object.keys(input); record(input, fields);
    if (fields.some(key => !['configuration', 'repository', 'runRoot', 'runId', 'signal', 'onEvent'].includes(key))) refuse('CONFIG_SCHEMA', '', 'admission');
    if (input.onEvent !== undefined && typeof input.onEvent !== 'function' || input.signal !== undefined && !(input.signal instanceof AbortSignal)) refuse('CONFIG_SCHEMA', '', 'admission');
    validateGateUrlOverrides(ports.gateUrlOverrides, 'admission');
    validatePortPolicyFields(ports, 'admission');
    if (input.signal?.aborted) refuse('CANCELLED', '', 'admission');
    const compiled = await compilePlan(input.configuration); if (!compiled.ok) throw new ControllerFailure(compiled.error);
    validateGateUrlOverrides(ports.gateUrlOverrides, 'admission', input.configuration.registry.spec.gateEndpoints);
    if (compiled.value.orderedDAG.some(node => node.kind === 'agent' && compiled.value.roles.find(role => role.roleId === node.roleId)?.adapter === 'delegated')) refuse('CAPABILITY_UNSUPPORTED', '/spec/profiles/roles', 'admission');
    const context = await createCycle(input, ports); return executeCycleContext(context);
  }, 'admission');
}
