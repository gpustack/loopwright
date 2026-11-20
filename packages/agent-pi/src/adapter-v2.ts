import { isAbsolute, resolve } from 'node:path';
import { types } from 'node:util';
import { constructAdapterFromCaptured, runtimePorts, type FactoryPorts } from './adapter.js';
import { composeCandidateStreamCheckers, createBuiltInPiStreamChecker } from './cas.js';
import { effectivePolicyV2, isHttpMcp } from './policy-v2.js';
import { object, freeze, snapshot, text, type Json } from './boundary.js';
import { sameIdentity, validateRuntime } from './policy.js';
import { snapshotOpenInputSync, validateStructuralInputWithPolicy } from './preflight.js';
import { HttpMcpProcess, HttpMcpFailure, type HttpMcpPorts } from './http-mcp.js';
import { PiFailure, refuse } from './errors.js';
import type { PiHost, PiOutcome, PiResult } from './types.js';
import type { PiAdapterV2, PiErrorV2, PiHostV2, PiOpenInputV2, PiOutcomeV2, PiResultV2 } from './types-v2.js';

/** Internal test ports remain outside package exports. */
export interface FactoryPortsV2 extends FactoryPorts { readonly http?: HttpMcpPorts }
export async function constructAdapterV2(unownedHost: PiHostV2, unownedInput: unknown, ports: FactoryPortsV2): Promise<PiResultV2<PiAdapterV2>> {
  try {
    // Capture and snapshot ALL caller-owned input and host fields synchronously BEFORE the first await.
    const captured = snapshotOpenInputSync(unownedInput, 2);
    if (!unownedHost || typeof unownedHost !== 'object' || types.isProxy(unownedHost)) {
      refuse('INPUT_INVALID', '/host');
    }
    const hasStreamChecker = Object.hasOwn(unownedHost, 'createCandidateStreamChecker');
    const hostFields = [
      'store', 'authority', 'directory', 'artifactsDirectory', 'dockerExecutable', 'dockerSocket', 'runtime', 'resolveCredential', 'resolveMcpCredential',
      ...(hasStreamChecker ? ['createCandidateStreamChecker'] : []),
    ];
    const data = object(unownedHost, hostFields, '/host');
    if (typeof data.resolveMcpCredential !== 'function' || typeof data.resolveCredential !== 'function') throw new TypeError('Host callback');
    if (hasStreamChecker && data.createCandidateStreamChecker !== undefined && typeof data.createCandidateStreamChecker !== 'function') {
      throw new TypeError('Host callback');
    }
    const runtime = validateRuntime(snapshot(data.runtime), '/host/runtime');
    for (const name of ['directory', 'artifactsDirectory'] as const) {
      if (typeof data[name] !== 'string' || /[,\r\n\0]/.test(data[name])) {
        refuse('INPUT_INVALID', '/host/' + name);
      }
    }
    const rawDirectory = text(data.directory, '/host/directory');
    const rawArtifactsDirectory = text(data.artifactsDirectory, '/host/artifactsDirectory');
    if (!isAbsolute(rawArtifactsDirectory)) refuse('INPUT_INVALID', '/host/artifactsDirectory');
    const artifactsDirectory = resolve(rawArtifactsDirectory);
    let lastFailure: PiErrorV2 | null = null;
    const resolvedSecrets = new Set<string>();
    const rawResolveCredential = (data.resolveCredential as PiHost['resolveCredential']).bind(unownedHost);
    const rawResolveMcpCredential = (data.resolveMcpCredential as PiHostV2['resolveMcpCredential']).bind(unownedHost);
    const wrappedResolveCredential: PiHost['resolveCredential'] = async binding => {
      if (lastFailure) throw new PiFailure({ ...lastFailure, code: 'MCP_FAILED' });
      const resolved = await rawResolveCredential(binding);
      if (resolved && typeof resolved.bearerToken === 'string' && resolved.bearerToken.length > 0) {
        resolvedSecrets.add(resolved.bearerToken);
      }
      return resolved;
    };
    const wrappedResolveMcpCredential: PiHostV2['resolveMcpCredential'] = async binding => {
      const resolved = await rawResolveMcpCredential(binding);
      if (resolved && typeof resolved.bearerToken === 'string' && resolved.bearerToken.length > 0) {
        resolvedSecrets.add(resolved.bearerToken);
      }
      return resolved;
    };
    const rawStreamChecker = typeof data.createCandidateStreamChecker === 'function'
      ? (data.createCandidateStreamChecker as NonNullable<PiHost['createCandidateStreamChecker']>).bind(unownedHost)
      : undefined;
    const host: PiHost = Object.freeze({
      store: data.store as PiHost['store'],
      authority: freeze(snapshot(data.authority)) as unknown as PiHost['authority'],
      directory: rawDirectory,
      artifactsDirectory,
      dockerExecutable: text(data.dockerExecutable, '/host/dockerExecutable'),
      dockerSocket: text(data.dockerSocket, '/host/dockerSocket'),
      runtime: freeze(runtime),
      resolveCredential: wrappedResolveCredential,
      createCandidateStreamChecker: () => composeCandidateStreamCheckers(rawStreamChecker?.(), createBuiltInPiStreamChecker(resolvedSecrets)),
    });

    // Neither unownedHost nor unownedInput is ever read after this point.
    const policy = await effectivePolicyV2(captured.rawPolicy);
    const prepared = validateStructuralInputWithPolicy(captured, policy.native as unknown as Json);
    if (!sameIdentity(host.runtime, prepared.policy.runtime)) refuse('RUNTIME_MISMATCH', '/policy/runtime');
    const originalMcp = policy.source.mcp;
    const selected: FactoryPorts = isHttpMcp(originalMcp) ? { ...ports, mcp: (owner, value) => ({ process: () => new HttpMcpProcess(owner, value, originalMcp,
      wrappedResolveMcpCredential, error => { lastFailure ??= error; }, ports.http) }) } : ports;
    const opened = await constructAdapterFromCaptured(host, prepared, selected);
    if (!opened.ok) return { ok: false, error: lastFailure ?? opened.error };
    const adapter = opened.value;
    if (lastFailure) { const closed = await adapter.close(); return { ok: false, error: closed.ok ? lastFailure : closed.error }; }
    const mapped = (outcome: PiOutcome): PiOutcomeV2 => {
      if (!lastFailure) return outcome;
      const current = host.store.inspect();
      const uncertain = !current.ok || current.value.counts.dispatchedRequests > 0 || current.value.counts.unresolvedRequests > 0 || current.value.counts.unresolvedOperations > 0
        || outcome.providerTermination === 'unknown' || outcome.usage === 'incomplete' || outcome.localCleanup !== 'complete';
      return freeze({ ...outcome, status: uncertain ? 'recovery_required' : outcome.status === 'cancelled' ? 'cancelled' : 'blocked', error: { ...lastFailure } });
    };
    const execute = async (call: () => Promise<PiResult<PiOutcome>>, allowFailed = false): Promise<PiResultV2<PiOutcomeV2>> => {
      if (lastFailure && !allowFailed) return { ok: false, error: lastFailure };
      const result = await call();
      return result.ok ? { ok: true, value: mapped(result.value) } : { ok: false, error: lastFailure ?? result.error };
    };
    return { ok: true, value: Object.freeze({
      capabilities: () => freeze({ ...adapter.capabilities(), version: 2 as const, sourcePolicyDigest: { ...policy.sourceDigest },
        mcpTransport: isHttpMcp(originalMcp) ? originalMcp.transport : 'stdio' as const }),
      execute: (command: Parameters<PiAdapterV2['execute']>[0]) => execute(() => adapter.execute(command)),
      compact: (command: Parameters<PiAdapterV2['compact']>[0]) => execute(() => adapter.compact(command)),
      cancel: (command: Parameters<PiAdapterV2['cancel']>[0]) => execute(() => adapter.cancel(command), true),
      events: () => adapter.events(), capture: (command: Parameters<PiAdapterV2['capture']>[0]) => adapter.capture(command), close: () => adapter.close(),
    }) };
  } catch (error) {
    if (error instanceof HttpMcpFailure) return { ok: false, error: error.detail };
    if (error instanceof PiFailure) return { ok: false, error: error.detail };
    return { ok: false, error: { code: 'INPUT_INVALID', path: '', phase: 'preflight', retryable: false, effect: 'none', requestId: null, operationId: null, stateErrorCode: null } };
  }
}

export function openPiAdapterV2(host: PiHostV2, input: PiOpenInputV2): Promise<PiResultV2<PiAdapterV2>> {
  return constructAdapterV2(host, input, runtimePorts);
}
