import { constructAdapter, runtimePorts, type FactoryPorts } from './adapter.js';
import { effectivePolicyV2, isHttpMcp } from './policy-v2.js';
import { object, freeze } from './boundary.js';
import { HttpMcpProcess, HttpMcpFailure, type HttpMcpPorts } from './http-mcp.js';
import { PiFailure } from './errors.js';
import type { PiHost, PiOpenInput, PiOutcome, PiResult } from './types.js';
import type { PiAdapterV2, PiErrorV2, PiHostV2, PiOpenInputV2, PiOutcomeV2, PiResultV2 } from './types-v2.js';

/** Internal test ports remain outside package exports. */
export interface FactoryPortsV2 extends FactoryPorts { readonly http?: HttpMcpPorts }
export async function constructAdapterV2(unownedHost: PiHostV2, unownedInput: unknown, ports: FactoryPortsV2): Promise<PiResultV2<PiAdapterV2>> {
  try {
    const top = object(unownedInput, ['version', 'lock', 'roleId', 'stepId', 'sessionId', 'policy', 'candidate', 'resources', 'restore']);
    if (top.version !== 2) throw new PiFailure({ code: 'INPUT_INVALID', path: '/version', phase: 'preflight', retryable: false, effect: 'none', requestId: null, operationId: null, stateErrorCode: null });
    const data = object(unownedHost, ['store', 'authority', 'directory', 'artifactsDirectory', 'dockerExecutable', 'dockerSocket', 'runtime', 'resolveCredential', 'resolveMcpCredential'], '/host');
    if (typeof data.resolveMcpCredential !== 'function' || typeof data.resolveCredential !== 'function') throw new TypeError('Host callback');
    const policy = await effectivePolicyV2(top.policy);
    let lastFailure: PiErrorV2 | null = null;
    const host: PiHost = { store: data.store as PiHost['store'], authority: data.authority as PiHost['authority'], directory: data.directory as string,
      artifactsDirectory: data.artifactsDirectory as string, dockerExecutable: data.dockerExecutable as string, dockerSocket: data.dockerSocket as string,
      runtime: data.runtime as PiHost['runtime'], resolveCredential: async binding => {
        if (lastFailure) throw new PiFailure({ ...lastFailure, code: 'MCP_FAILED' });
        return (data.resolveCredential as PiHost['resolveCredential']).call(unownedHost, binding);
      } };
    const input = { ...top, version: 1, policy: policy.native } as unknown as PiOpenInput;
    const originalMcp = policy.source.mcp;
    const selected: FactoryPorts = isHttpMcp(originalMcp) ? { ...ports, mcp: (owner, value) => ({ process: () => new HttpMcpProcess(owner, value, originalMcp,
      (data.resolveMcpCredential as PiHostV2['resolveMcpCredential']).bind(unownedHost), error => { lastFailure ??= error; }, ports.http) }) } : ports;
    const opened = await constructAdapter(host, input, selected);
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
