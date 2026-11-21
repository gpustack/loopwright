import { fileURLToPath } from 'node:url';
import { LIMITS } from '@loopwright/core';
import { describePiAdapterFiles, type AdapterPolicy } from '@loopwright/agent-pi';
import { resolveBuiltInPiCatalogModel, resolveCatalogModel } from '@loopwright/agent-pi/catalog';
import { approvedState, selectRoleResources } from './config.js';
import { validatePiSelectionOrRefuse } from './registry.js';
import { readBoundedFile } from './files.js';
import { installedHandlerDigests } from './handlers.js';
import { freeze, canonical, hash, same } from './schema.js';
import { refuse, result } from './errors.js';
import { compactionTarget, descendants, reworkSubgraph } from './scheduler.js';
import { CONTROLLER_LIMITS, type CheckpointCapacity, type CompiledPlan, type LoadedConfiguration, type PlannedNode, type PlannedRole, type RuntimeProfile, type StepHandoffSelect, type StepHandoffSelector, type StepHandoffSource, type VerifierSlot } from './types.js';
function cloneHandoffSelector(item: StepHandoffSelector): StepHandoffSelector {
  const source: StepHandoffSource = item.source.kind === 'artifact'
    ? { kind: 'artifact', path: item.source.path }
    : { kind: item.source.kind };
  const select: StepHandoffSelect = item.select.kind === 'markdown_heading'
    ? {
        kind: 'markdown_heading',
        heading: item.select.heading,
        ...(item.select.includeSubheadings !== undefined ? { includeSubheadings: item.select.includeSubheadings } : {}),
      }
    : item.select.kind === 'json_pointer'
      ? { kind: 'json_pointer', pointers: [...item.select.pointers] }
      : { kind: 'full' };
  return {
    ...(item.id !== undefined ? { id: item.id } : {}),
    fromStep: item.fromStep,
    source,
    select,
    ...(item.maxBytes !== undefined ? { maxBytes: item.maxBytes } : {}),
    ...(item.required !== undefined ? { required: item.required } : {}),
  };
}
export function checkpointCapacity(A: number, N: number, I: number, C: number, publication: boolean, R = 0, K = 0): CheckpointCapacity {
  if (![A, N, I, C, R, K].every(Number.isSafeInteger) || A < 1 || A > 64 || N < 0 || I < 0 || R < 0 || K < 0 || C < 2 || C > 34 || typeof publication !== 'boolean') refuse('CONFIG_LIMIT', '/spec/controls', 'compile');
  const V = 1 + Math.min(A + K, N + I + R), J = C * V, D = 4 + 3 * A + 2 * J + (publication ? 3 : 0);
  if (D > 256) refuse('CONFIG_LIMIT', '/spec/controls', 'compile');
  return { A, N, I, C, V, J, D, publication, additionalRefs: 4, requiredRefs: 6, checkpointBytes: 40960 };
}
export function compilePlan(loaded: LoadedConfiguration) {
  return result(async (): Promise<CompiledPlan> => {
    const state = approvedState(loaded), config = loaded.configuration, task = config.spec.task, registry = loaded.registry.spec;
    if (
      task.spec.steps.length > CONTROLLER_LIMITS.maxCompiledDagSteps ||
      task.spec.roles.length > CONTROLLER_LIMITS.maxCompiledRoles ||
      task.spec.acceptance.checks.some(check => check.allowedEvidenceLevels.includes('hardware_execution'))
    ) {
      refuse('CAPABILITY_UNSUPPORTED', '/spec/task', 'compile');
    }
    if (registry.resourceVersion !== task.spec.trustedContext.revision) refuse('CONFIG_REFERENCE', '/spec/task/spec/trustedContext', 'compile');
    if (config.spec.profiles.roles.length !== task.spec.roles.length || config.spec.profiles.steps.length !== task.spec.steps.length) refuse('CONFIG_REFERENCE', '/spec/profiles', 'compile');
    const installed = await installedHandlerDigests();
    for (const handler of registry.handlers) if (!same(handler.digest, installed[handler.implementation])) refuse('CONFIG_REFERENCE', '/registry/spec/handlers', 'compile');
    const pending = [...task.spec.steps], orderedDAG: PlannedNode[] = [], done = new Set<string>();
    while (pending.length) {
      const ready = pending.filter(step => step.dependsOn.every(id => done.has(id))).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)[0];
      if (!ready) refuse('CONFIG_REFERENCE', '/spec/task/spec/steps', 'compile');
      const selected = config.spec.profiles.steps.find(item => item.stepId === ready.id), handler = registry.handlers.find(item => item.id === selected?.handlerRef);
      if (!handler || handler.id !== ready.uses || handler.kind !== ready.kind) refuse('CONFIG_REFERENCE', '/spec/profiles/steps', 'compile');
      orderedDAG.push({
        id: ready.id,
        kind: ready.kind,
        dependsOn: [...ready.dependsOn].sort(),
        roleId: ready.roleId,
        handler: handler.implementation === 'pi.agent.v1' ? { ...handler, parameters: { ...handler.parameters, prompt: '[private command sha256:' + hash(String(handler.parameters.prompt)).hex + ']' } } : handler,
        ...(ready.onRework !== undefined ? { onRework: { rejectTo: ready.onRework.rejectTo, maxReworks: ready.onRework.maxReworks } } : {}),
        ...(ready.handoffs !== undefined ? { handoffs: ready.handoffs.map(cloneHandoffSelector) } : {}),
      });
      done.add(ready.id);
      pending.splice(pending.indexOf(ready), 1);
    }
    for (const node of orderedDAG) {
      if (node.onRework !== undefined) {
        if (!Number.isSafeInteger(node.onRework.maxReworks) || node.onRework.maxReworks < 1 || node.onRework.maxReworks > 8) {
          refuse('CONFIG_SCHEMA', '/spec/task/spec/steps', 'compile');
        }
        if (node.handler.implementation === 'pi.compact.v1') {
          refuse('CAPABILITY_UNSUPPORTED', '/spec/profiles/steps', 'compile');
        }
        if (node.onRework.rejectTo === node.id || !descendants({ orderedDAG }, node.onRework.rejectTo).includes(node.id)) {
          refuse('CONFIG_REFERENCE', '/spec/task/spec/steps', 'compile');
        }
        const rejectTarget = orderedDAG.find(item => item.id === node.onRework!.rejectTo);
        if (rejectTarget?.handler.implementation === 'pi.compact.v1') {
          refuse('CAPABILITY_UNSUPPORTED', '/spec/profiles/steps', 'compile');
        }
      }
      if (node.handoffs !== undefined) {
        if (node.handler.implementation === 'pi.compact.v1') {
          refuse('CAPABILITY_UNSUPPORTED', '/spec/profiles/steps', 'compile');
        }
        if (node.kind !== 'agent' || node.handoffs.length < 1 || node.handoffs.length > LIMITS.handoffsPerStep) {
          refuse('CONFIG_SCHEMA', '/spec/task/spec/steps', 'compile');
        }
        for (const handoff of node.handoffs) {
          const fromNode = orderedDAG.find(item => item.id === handoff.fromStep);
          if (!fromNode || fromNode.id === node.id || !descendants({ orderedDAG }, fromNode.id).includes(node.id)) {
            refuse('CONFIG_REFERENCE', '/spec/task/spec/steps', 'compile');
          }
          if (fromNode.handler.implementation === 'pi.compact.v1') {
            refuse('CAPABILITY_UNSUPPORTED', '/spec/profiles/steps', 'compile');
          }
          if (fromNode.kind !== 'agent' && handoff.source.kind === 'artifact') {
            refuse('CONFIG_SCHEMA', '/spec/task/spec/steps', 'compile');
          }
        }
      }
      if (node.handler.implementation === 'pi.compact.v1') {
        const compactRole = task.spec.roles.find(item => item.id === node.roleId);
        const compactSelected = config.spec.profiles.roles.find(item => item.roleId === node.roleId);
        const compactProfile = registry.roleProfiles.find(item => item.id === compactSelected?.profileRef);
        if (compactRole?.adapter === 'delegated' || compactProfile?.adapter === 'delegated') refuse('CAPABILITY_UNSUPPORTED', '/spec/profiles/steps', 'compile');
        compactionTarget({ orderedDAG }, node.id);
      }
    }
    const verifierSlots: VerifierSlot[] = [], networkCredentials: { readonly ref: string; readonly consumer: 'gate' | 'publisher' }[] = [];
    const networkCredential = (ref: string, consumer: 'gate' | 'publisher', path: string): void => {
      const binding = registry.credentialBindings.find(item => item.id === ref);
      if (!binding || binding.consumer !== consumer) refuse('CONFIG_REFERENCE', path, 'compile');
      if (!networkCredentials.some(item => item.ref === ref)) networkCredentials.push({ ref: binding.id, consumer });
    };
    for (const check of task.spec.acceptance.checks) {
      const matches = registry.handlers.filter(handler => handler.kind === 'check' && handler.parameters.checkId === check.id);
      if (matches.length !== 1) refuse('CONFIG_REFERENCE', '/spec/task/spec/acceptance', 'compile');
      const handler = matches[0]!;
      if (handler.implementation === 'gate.v1') {
        if (!check.allowedEvidenceLevels.includes('external_service')) refuse('CONFIG_SCHEMA', '/spec/task/spec/acceptance', 'compile');
        const endpoint = registry.gateEndpoints.find(item => item.id === handler.parameters.endpointRef);
        if (!endpoint) refuse('CONFIG_REFERENCE', '/registry/spec/gateEndpoints', 'compile');
        networkCredential(endpoint.signingCredentialRef, 'gate', '/registry/spec/gateEndpoints');
        if (endpoint.authCredentialRef !== null) networkCredential(endpoint.authCredentialRef, 'gate', '/registry/spec/gateEndpoints');
      }
      verifierSlots.push({ id: 'check.' + check.id, checkId: check.id, implicit: null, handler });
    }
    for (const [implementation, implicit] of [['scope.v1', 'scope'], ['no-change.v1', 'no_change']] as const) {
      const matches = registry.handlers.filter(handler => handler.implementation === implementation && handler.parameters.checkId === null);
      if (matches.length !== 1) refuse('CONFIG_REFERENCE', '/registry/spec/handlers', 'compile');
      const checkId = implicit === 'scope' ? 'controller.scope' : 'controller.no-change';
      if (task.spec.acceptance.checks.some(check => check.id === checkId)) refuse('CONFIG_REFERENCE', '/spec/task/spec/acceptance', 'compile');
      verifierSlots.push({ id: checkId, checkId, implicit, handler: matches[0]! });
    }
    for (const node of orderedDAG.filter(node => node.kind === 'check')) if (!verifierSlots.some(slot => slot.handler.id === node.handler.id)) refuse('CONFIG_REFERENCE', '/spec/profiles/steps', 'compile');
    const noChangeId = [...task.spec.acceptance.required].sort().find(checkId => task.spec.acceptance.checks.find(check => check.id === checkId)!.allowedEvidenceLevels.includes('local_execution')
      && verifierSlots.some(slot => slot.checkId === checkId && slot.implicit === null && slot.handler.implementation === 'no-change.v1')) ?? null;
    const publication = config.spec.publication;
    if (publication.mode === 'pull_request') {
      const endpoint = registry.publicationEndpoints.find(item => item.id === publication.endpointRef);
      if (!endpoint) refuse('CONFIG_REFERENCE', '/spec/publication', 'compile');
      networkCredential(endpoint.signingCredentialRef, 'publisher', '/spec/publication');
      if (endpoint.authCredentialRef !== null) networkCredential(endpoint.authCredentialRef, 'publisher', '/spec/publication');
    }
    const isMutatingRoleId = (roleId: string | null): boolean => {
      const declared = task.spec.roles.find(item => item.id === roleId);
      return Boolean(declared?.tools.some(tool => tool === 'write' || tool === 'edit' || tool === 'delete' || tool === 'bash'));
    };
    let reworkGenerations = 0;
    let checkReworkGenerations = 0;
    for (const node of orderedDAG) {
      if (node.onRework !== undefined) {
        const subIds = reworkSubgraph({ orderedDAG }, node.onRework.rejectTo);
        const mutatingSubSteps = orderedDAG.filter(
          item => subIds.includes(item.id) && item.kind === 'agent' && item.handler.implementation !== 'pi.compact.v1' && isMutatingRoleId(item.roleId),
        ).length;
        reworkGenerations += node.onRework.maxReworks * (1 + mutatingSubSteps);
        if (node.kind === 'check') checkReworkGenerations += node.onRework.maxReworks;
      }
    }
    const capacity = checkpointCapacity(
      config.spec.controls.maxAttempts,
      orderedDAG.filter(node => node.kind === 'agent' && node.handler.implementation !== 'pi.compact.v1').length,
      task.spec.budgets.maxImplementationRepairs,
      verifierSlots.length,
      publication.mode === 'pull_request',
      reworkGenerations,
      checkReworkGenerations,
    );
    const description = await describePiAdapterFiles(); if (!description.ok) refuse('CAPABILITY_UNSUPPORTED', '', 'compile', { piCode: description.error.code });
    const files = description.value, publicationOps = publication.mode === 'pull_request' ? 1 : 0;
    const storeMaxRequests = Math.min(files.limits.requests, 1024);
    const storeMaxOperations = Math.min(files.limits.operations, 2048);
    if (task.spec.budgets.maxModelCalls > storeMaxRequests || task.spec.budgets.maxModelCalls + capacity.J + publicationOps + 3 * capacity.A > storeMaxOperations) refuse('CONFIG_LIMIT', '/spec/task/spec/budgets', 'compile');
    const graphDigest = hash(await readBoundedFile(fileURLToPath(new URL('../../../package-lock.json', import.meta.resolve('@loopwright/agent-pi'))), 8388608, false));
    const roles: PlannedRole[] = [], neededCredentials = new Set<string>();
    for (const role of task.spec.roles) {
      const selected = config.spec.profiles.roles.find(item => item.roleId === role.id), profile = registry.roleProfiles.find(item => item.id === selected?.profileRef);
      if (!selected || !profile) refuse('CONFIG_REFERENCE', '/spec/profiles/roles', 'compile');
      const adapter = profile.adapter ?? 'pi';
      if (role.adapter !== adapter || role.tools.some(tool => !profile.tools.includes(tool))) refuse('CONFIG_REFERENCE', '/spec/profiles/roles', 'compile');
      const hasOverride = selected.selection !== undefined || Boolean(state.input.roleModelOverrides?.some(item => item.roleId === role.id));
      const hasThinkingOverride = selected.selection?.thinking !== undefined || Boolean(state.input.roleModelOverrides?.some(item => item.roleId === role.id && item.thinking !== undefined));
      if ((!hasOverride && (profile.selection.provider !== role.provider || profile.selection.model !== role.model)) || (!hasThinkingOverride && profile.selection.thinking !== role.thinking)) {
        refuse('CONFIG_REFERENCE', '/spec/profiles/roles', 'compile');
      }
      const active = orderedDAG.some(node => node.roleId === role.id);
      if (active && (task.spec.budgets.enforcement.tokens !== 'soft_accounting' || profile.context.mode !== 'estimated_guard' || task.spec.budgets.perCallOutputTokens > profile.context.maxOutputTokens)) {
        refuse('CAPABILITY_UNSUPPORTED', '/registry/spec/roleProfiles', 'compile');
      }
      const mcpEnabled = role.tools.includes('mcp__workspace__read_file');
      let mcp: PlannedRole['policy']['mcp'];
      if (adapter === 'delegated' && profile.mcp === null) {
        if (role.tools.some(tool => tool === 'codemode' || tool === 'mcp__workspace__read_file')) {
          refuse('CAPABILITY_UNSUPPORTED', '/spec/profiles/roles', 'compile');
        }
        mcp = { serverId: 'workspace', scriptDigest: files.localMcpScriptDigest, names: [], effects: [], idleTimeoutSeconds: 2, absoluteTimeoutSeconds: 10 };
      } else {
        if (!profile.mcp) refuse('CONFIG_REFERENCE', '/registry/spec/roleProfiles', 'compile');
        const configuredMcp = { ...profile.mcp, names: mcpEnabled ? ['mcp__workspace__read_file'] as const : [], effects: mcpEnabled ? ['read_only'] as const : [] };
        if ('transport' in configuredMcp && active && mcpEnabled) {
          const credential = registry.credentialBindings.find(item => item.id === configuredMcp.credentialRef);
          if (!credential || credential.consumer !== 'mcp' || credential.destinationRef !== configuredMcp.destinationRef) refuse('CONFIG_REFERENCE', '/spec/credentials', 'compile');
          neededCredentials.add(credential.id);
        } else if (!('transport' in configuredMcp) && !same(configuredMcp.scriptDigest, files.localMcpScriptDigest)) {
          refuse('CONFIG_REFERENCE', '/registry/spec/roleProfiles', 'compile');
        }
        mcp = configuredMcp;
      }
      if (profile.limits) {
        for (const [limitKey, limitVal] of Object.entries(profile.limits)) {
          const maxVal = files.limits[limitKey as keyof typeof files.limits];
          if (typeof limitVal === 'number' && typeof maxVal === 'number' && limitVal > maxVal) {
            refuse('CONFIG_LIMIT', '/registry/spec/roleProfiles', 'compile');
          }
        }
      }
      const maxAvailableOps = storeMaxOperations - capacity.J - publicationOps;
      const roleLimits = {
        ...files.limits,
        sessionBytes: 2097152,
        ...(profile.limits ?? {}),
        requests: Math.min(profile.limits?.requests ?? storeMaxRequests, storeMaxRequests),
        operations: Math.min(profile.limits?.operations ?? maxAvailableOps, maxAvailableOps),
      };
      if (active && task.spec.budgets.maxModelCalls > roleLimits.requests) refuse('CONFIG_LIMIT', '/spec/task/spec/budgets', 'compile');
      const roleResources = selectRoleResources(task.spec.trustedContext.resources, role.resourceIds, 'compile').map(
        item => ({ id: item.id, kind: item.kind, path: item.path, digest: item.digest }),
      );
      if (adapter === 'delegated') {
        if (profile.providerCredentialRef !== null) refuse('CONFIG_SCHEMA', '/registry/spec/roleProfiles', 'compile');
        let runtime: RuntimeProfile;
        if (profile.runtimeRef === null) {
          runtime = {
            id: 'delegated.none',
            dockerExecutable: '/nonexistent/delegated',
            dockerSocket: '/nonexistent/delegated.sock',
            identity: {
              sdkIntegrity: files.sdkIntegrity,
              graphDigest,
              configDigest: files.restrictionDigest,
              imageDigest: 'sha256:' + '0'.repeat(64),
              profile: 'linux/arm64',
            },
          };
        } else {
          const found = registry.runtimeProfiles.find(item => item.id === profile.runtimeRef);
          if (!found || found.identity.sdkIntegrity !== files.sdkIntegrity || !same(found.identity.graphDigest, graphDigest) || !same(found.identity.configDigest, files.restrictionDigest)) {
            refuse('CONFIG_REFERENCE', '/registry/spec/runtimeProfiles', 'compile');
          }
          runtime = found;
        }
        roles.push({
          roleId: role.id,
          adapter: 'delegated',
          profileRef: profile.id,
          providerCredentialRef: null,
          runtime,
          policy: {
            version: 2,
            policyId: 'controller.' + loaded.registryDigest.hex.slice(0, 32),
            resourceVersion: registry.resourceVersion,
            adapterId: 'pi',
            adapterVersion: '0.0.0',
            runtime: runtime.identity,
            selection: { provider: role.provider, model: role.model, thinking: role.thinking, api: 'openai-responses' },
            resources: [files.preamble, ...roleResources],
            tools: role.tools,
            mcp,
            context: profile.context,
            accounting: 'soft_only',
            retry: 'sender_only',
            extensions: [],
            privateArtifacts: true,
            limits: roleLimits,
          },
        });
        continue;
      }
      const baseSel = profile.selection as AdapterPolicy['selection'];
      let effectiveSelection: AdapterPolicy['selection'] = baseSel;
      if (hasOverride) {
        let api: AdapterPolicy['selection']['api'];
        let customProvider: AdapterPolicy['selection']['customProvider'];
        if (role.provider === baseSel.provider && baseSel.customProvider !== undefined) {
          api = baseSel.api;
          customProvider = baseSel.customProvider;
        } else if (role.provider === 'github-copilot') {
          api = 'anthropic-messages';
          customProvider = undefined;
        } else {
          const catalogEntry = resolveBuiltInPiCatalogModel(role.provider, role.model);
          api = catalogEntry ? catalogEntry.api : baseSel.api;
          customProvider = undefined;
        }
        const candidateSelection: AdapterPolicy['selection'] = {
          provider: role.provider,
          model: role.model,
          thinking: role.thinking,
          api,
          ...(customProvider !== undefined ? { customProvider } : {}),
        };
        validatePiSelectionOrRefuse(candidateSelection, '/spec/profiles/roles', 'compile');
        effectiveSelection = candidateSelection;
        if (active) {
          const { record } = resolveCatalogModel(effectiveSelection);
          if (
            !Number.isSafeInteger(record.contextWindow) ||
            record.contextWindow <= 0 ||
            record.maxTokens < profile.context.maxOutputTokens ||
            Math.min(record.contextWindow, profile.context.workingWindowCeiling) <
              profile.context.serviceMargin + profile.context.toolReserve + profile.context.maxOutputTokens
          ) {
            refuse('CAPABILITY_UNSUPPORTED', '/spec/profiles/roles', 'compile');
          }
        }
      }
      const runtime = registry.runtimeProfiles.find(item => item.id === profile.runtimeRef);
      if (!runtime || runtime.identity.sdkIntegrity !== files.sdkIntegrity || !same(runtime.identity.graphDigest, graphDigest) || !same(runtime.identity.configDigest, files.restrictionDigest)) refuse('CONFIG_REFERENCE', '/registry/spec/runtimeProfiles', 'compile');
      if (active) {
        const provider = registry.credentialBindings.find(item => item.id === profile.providerCredentialRef);
        if (!provider || provider.consumer !== 'provider' || provider.destinationRef !== effectiveSelection.provider) refuse('CONFIG_REFERENCE', '/spec/credentials', 'compile');
        neededCredentials.add(provider.id);
      }
      roles.push({ roleId: role.id, adapter: 'pi', profileRef: profile.id, providerCredentialRef: profile.providerCredentialRef, runtime,
        policy: { version: 2, policyId: 'controller.' + loaded.registryDigest.hex.slice(0, 32), resourceVersion: registry.resourceVersion, adapterId: 'pi', adapterVersion: '0.0.0', runtime: runtime.identity,
          selection: effectiveSelection, resources: [files.preamble, ...roleResources], tools: role.tools, mcp,
          context: profile.context, accounting: 'soft_only', retry: 'sender_only', extensions: [], privateArtifacts: true,
          limits: roleLimits } });
    }
    for (const item of networkCredentials) neededCredentials.add(item.ref);
    if (!same([...neededCredentials].sort(), state.vault.references)) refuse('CONFIG_REFERENCE', '/spec/credentials', 'compile');
    const plan = { version: 1 as const, runId: null, lock: null, admission: 'not_performed' as const, effectfulReadiness: 'not_checked' as const,
      sourceDocumentDigest: loaded.sourceDigest, taskByteDigest: hash('loopwright.dev/controller/task/v1\0' + canonical(task)), registryDigest: loaded.registryDigest,
      task, orderedDAG, scope: task.spec.scope, budgets: task.spec.budgets, controls: config.spec.controls, roles, publication,
      resources: state.resources.map(({ id, kind, ref }) => ({ id, kind, ref })),
      credentialReferences: [...neededCredentials].sort().map(ref => { const item = registry.credentialBindings.find(item => item.id === ref)!; return { ref, consumer: item.consumer, destinationRef: item.destinationRef }; }),
      verifierSlots, capacity, noChangeEligibility: { available: noChangeId !== null, checkId: noChangeId, reason: noChangeId === null ? 'original_required_no_change_check_missing' as const : null },
      verificationLimits: { headerBytes: 16384 as const, packetBytes: 1048576 as const, jsonFileBytes: 1032184 as const, jsonHeaderEligibility: 'complete_manifests_and_max_framing_must_fit' as const },
      capabilities: [{ component: 'controller.serial', disposition: 'supported' as const, readiness: 'not_checked' as const }],
      evidenceNeeds: task.spec.acceptance.checks.map(check => ({ checkId: check.id, levels: check.allowedEvidenceLevels })) };
    state.vault.assertClean(plan);
    if (Buffer.byteLength(canonical(plan)) > 4194304) refuse('CONFIG_LIMIT', '', 'compile');
    return freeze({ ...plan, planDigest: hash('loopwright.dev/controller/plan/v1\0' + canonical(plan)) });
  }, 'compile');
}
