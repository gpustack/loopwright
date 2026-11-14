import { fileURLToPath } from 'node:url';
import { describePiAdapterFiles } from '@loopwright/agent-pi';
import { approvedState } from './config.js';
import { readBoundedFile } from './files.js';
import { installedHandlerDigests } from './handlers.js';
import { freeze, canonical, hash, same } from './schema.js';
import { refuse, result } from './errors.js';
import { compactionTarget } from './scheduler.js';
import type { CheckpointCapacity, CompiledPlan, LoadedConfiguration, PlannedRole, VerifierSlot } from './types.js';
export function checkpointCapacity(A: number, N: number, I: number, C: number, publication: boolean): CheckpointCapacity {
  if (![A, N, I, C].every(Number.isSafeInteger) || A < 1 || A > 16 || N < 0 || I < 0 || C < 2 || C > 16 || typeof publication !== 'boolean') refuse('CONFIG_LIMIT', '/spec/controls', 'compile');
  const V = 1 + Math.min(A, N + I), J = C * V, D = 4 + 3 * A + 2 * J + (publication ? 3 : 0);
  if (D > 64) refuse('CONFIG_LIMIT', '/spec/controls', 'compile');
  return { A, N, I, C, V, J, D, publication, additionalRefs: 4, requiredRefs: 6, checkpointBytes: 40960 };
}
export function compilePlan(loaded: LoadedConfiguration) {
  return result(async (): Promise<CompiledPlan> => {
    const state = approvedState(loaded), config = loaded.configuration, task = config.spec.task, registry = loaded.registry.spec;
    if (task.spec.steps.length > 16 || task.spec.roles.length > 16 || task.spec.target.matrix !== null) refuse('CAPABILITY_UNSUPPORTED', '/spec/task', 'compile');
    if (registry.resourceVersion !== task.spec.trustedContext.revision) refuse('CONFIG_REFERENCE', '/spec/task/spec/trustedContext', 'compile');
    if (config.spec.profiles.roles.length !== task.spec.roles.length || config.spec.profiles.steps.length !== task.spec.steps.length) refuse('CONFIG_REFERENCE', '/spec/profiles', 'compile');
    const installed = await installedHandlerDigests();
    for (const handler of registry.handlers) if (!same(handler.digest, installed[handler.implementation])) refuse('CONFIG_REFERENCE', '/registry/spec/handlers', 'compile');
    const pending = [...task.spec.steps], orderedDAG: CompiledPlan['orderedDAG'][number][] = [], done = new Set<string>();
    while (pending.length) {
      const ready = pending.filter(step => step.dependsOn.every(id => done.has(id))).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)[0];
      if (!ready) refuse('CONFIG_REFERENCE', '/spec/task/spec/steps', 'compile');
      const selected = config.spec.profiles.steps.find(item => item.stepId === ready.id), handler = registry.handlers.find(item => item.id === selected?.handlerRef);
      if (!handler || handler.id !== ready.uses || handler.kind !== ready.kind) refuse('CONFIG_REFERENCE', '/spec/profiles/steps', 'compile');
      orderedDAG.push({ id: ready.id, kind: ready.kind, dependsOn: [...ready.dependsOn].sort(), roleId: ready.roleId, handler: handler.implementation === 'pi.agent.v1' ? { ...handler, parameters: { ...handler.parameters, prompt: '[private command sha256:' + hash(String(handler.parameters.prompt)).hex + ']' } } : handler }); done.add(ready.id); pending.splice(pending.indexOf(ready), 1);
    }
    for (const node of orderedDAG) if (node.handler.implementation === 'pi.compact.v1') compactionTarget({ orderedDAG }, node.id);
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
    const capacity = checkpointCapacity(config.spec.controls.maxAttempts, orderedDAG.filter(node => node.kind === 'agent' && node.handler.implementation !== 'pi.compact.v1').length, task.spec.budgets.maxImplementationRepairs, verifierSlots.length, publication.mode === 'pull_request');
    const description = await describePiAdapterFiles(); if (!description.ok) refuse('CAPABILITY_UNSUPPORTED', '', 'compile', { piCode: description.error.code });
    const files = description.value, publicationOps = publication.mode === 'pull_request' ? 1 : 0;
    const storeMaxRequests = Math.min(files.limits.requests, 1024);
    const storeMaxOperations = Math.min(files.limits.operations, 2048);
    if (task.spec.budgets.maxModelCalls > storeMaxRequests || task.spec.budgets.maxModelCalls + capacity.J + publicationOps + 3 * capacity.A > storeMaxOperations) refuse('CONFIG_LIMIT', '/spec/task/spec/budgets', 'compile');
    const graphDigest = hash(await readBoundedFile(fileURLToPath(new URL('../../../package-lock.json', import.meta.resolve('@loopwright/agent-pi'))), 8388608, false));
    const roles: PlannedRole[] = [], neededCredentials = new Set<string>();
    for (const role of task.spec.roles) {
      const selected = config.spec.profiles.roles.find(item => item.roleId === role.id), profile = registry.roleProfiles.find(item => item.id === selected?.profileRef);
      if (!profile || role.adapter !== 'pi' || profile.selection.provider !== role.provider || profile.selection.model !== role.model || profile.selection.thinking !== role.thinking || role.tools.some(tool => !profile.tools.includes(tool))) refuse('CONFIG_REFERENCE', '/spec/profiles/roles', 'compile');
      const runtime = registry.runtimeProfiles.find(item => item.id === profile.runtimeRef);
      if (!runtime || runtime.identity.sdkIntegrity !== files.sdkIntegrity || !same(runtime.identity.graphDigest, graphDigest) || !same(runtime.identity.configDigest, files.restrictionDigest)) refuse('CONFIG_REFERENCE', '/registry/spec/runtimeProfiles', 'compile');
      const active = orderedDAG.some(node => node.roleId === role.id);
      if (active && (task.spec.budgets.enforcement.tokens !== 'soft_accounting' || profile.context.mode !== 'estimated_guard' || task.spec.budgets.perCallOutputTokens > profile.context.maxOutputTokens)) refuse('CAPABILITY_UNSUPPORTED', '/registry/spec/roleProfiles', 'compile');
      if (active) {
        const provider = registry.credentialBindings.find(item => item.id === profile.providerCredentialRef);
        if (!provider || provider.consumer !== 'provider' || provider.destinationRef !== profile.selection.provider) refuse('CONFIG_REFERENCE', '/spec/credentials', 'compile');
        neededCredentials.add(provider.id);
      }
      const mcpEnabled = role.tools.includes('mcp__workspace__read_file');
      const mcp = { ...profile.mcp, names: mcpEnabled ? ['mcp__workspace__read_file'] as const : [], effects: mcpEnabled ? ['read_only'] as const : [] };
      if ('transport' in mcp && active && mcpEnabled) {
        const credential = registry.credentialBindings.find(item => item.id === mcp.credentialRef);
        if (!credential || credential.consumer !== 'mcp' || credential.destinationRef !== mcp.destinationRef) refuse('CONFIG_REFERENCE', '/spec/credentials', 'compile');
        neededCredentials.add(credential.id);
      } else if (!('transport' in mcp) && !same(mcp.scriptDigest, files.localMcpScriptDigest)) refuse('CONFIG_REFERENCE', '/registry/spec/roleProfiles', 'compile');
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
      roles.push({ roleId: role.id, profileRef: profile.id, providerCredentialRef: profile.providerCredentialRef, runtime,
        policy: { version: 2, policyId: 'controller.' + loaded.registryDigest.hex.slice(0, 32), resourceVersion: registry.resourceVersion, adapterId: 'pi', adapterVersion: '0.0.0', runtime: runtime.identity,
          selection: profile.selection, resources: [files.preamble, ...task.spec.trustedContext.resources], tools: role.tools, mcp,
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
