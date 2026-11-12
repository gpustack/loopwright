import type { PiHost, PiHostV2, AdapterPolicyV2 } from '@loopwright/agent-pi';
import { resolveProviderDestination } from '@loopwright/agent-pi/catalog';
import { refuse } from './errors.js';
import { canonical, id, list, record, text } from './schema.js';
import type { TrustedRegistry } from './types.js';
export interface CredentialVault {
  readonly references: readonly string[];
  readonly assertClean: (value: Uint8Array | string | object) => void;
  /** Gate and publisher signing/auth secrets only; provider and mcp consumers stay behind their bound resolvers. */
  readonly resolveNetworkCredential: (ref: string) => string;
  readonly bind: (scope: { readonly runId: string; readonly roleId: string; readonly stepId: string; readonly providerCredentialRef: string | null;
    readonly selection: AdapterPolicyV2['selection']; readonly mcp: AdapterPolicyV2['mcp'] }) => Pick<PiHostV2, 'resolveCredential' | 'resolveMcpCredential'>;
}
export function credentialDeclarations(raw: unknown, registry: TrustedRegistry): readonly { readonly ref: string; readonly template: string }[] {
  const declarations = list(raw, '/spec/credentials').map((item, i) => {
    const path = '/spec/credentials/' + i, value = record(item, ['ref', 'template'], path), ref = id(value.ref, path + '/ref');
    const binding = registry.spec.credentialBindings.find(binding => binding.id === ref);
    if (!binding || text(value.template, path + '/template') !== binding.template) refuse('CONFIG_REFERENCE', path);
    return { ref, template: value.template as string };
  });
  if (new Set(declarations.map(item => item.ref)).size !== declarations.length) refuse('CONFIG_REFERENCE', '/spec/credentials');
  return declarations;
}
export function createVault(expanded: unknown, registry: TrustedRegistry): CredentialVault {
  const tokens = new Map<string, string>();
  for (const [index, item] of list(expanded, '/spec/credentials').entries()) {
    const fields = record(item, ['ref', 'template'], '/spec/credentials/' + index), ref = id(fields.ref);
    const token = fields.template;
    if (typeof token !== 'string' || token.length > 4096 || !/^[A-Za-z0-9._~+/-]+=*$/.test(token)) refuse('CONFIG_CREDENTIAL_INVALID', '/spec/credentials/' + index);
    tokens.set(ref, token);
  }
  const forms = [...new Set([...tokens.values()].flatMap(token => [token, JSON.stringify(token).slice(1, -1), encodeURIComponent(token), Buffer.from(token).toString('base64')]))];
  return Object.freeze({
    references: Object.freeze([...tokens.keys()].sort()),
    assertClean: (value: Uint8Array | string | object): void => {
      const serialized = value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(typeof value === 'string' ? value : canonical(value));
      if (forms.some(form => serialized.includes(Buffer.from(form)))) refuse('CONFIG_CREDENTIAL_INVALID', '/spec/credentials');
    },
    resolveNetworkCredential: (ref: string): string => {
      const binding = registry.spec.credentialBindings.find(item => item.id === ref);
      if (!binding || binding.consumer !== 'gate' && binding.consumer !== 'publisher') refuse('CONFIG_CREDENTIAL_INVALID', '/spec/credentials');
      const token = tokens.get(ref); if (!token) refuse('CONFIG_CREDENTIAL_INVALID', '/spec/credentials'); return token;
    },
    bind: (scope: Parameters<CredentialVault['bind']>[0]) => {
      const provider: PiHost['resolveCredential'] = async binding => {
        const approved = registry.spec.credentialBindings.find(item => item.id === scope.providerCredentialRef);
        let expectedDestination = '';
        try { expectedDestination = resolveProviderDestination(scope.selection); } catch { refuse('CONFIG_CREDENTIAL_INVALID', '', 'execution'); }
        if (!approved || approved.consumer !== 'provider' || approved.destinationRef !== scope.selection.provider || binding.provider !== scope.selection.provider || binding.model !== scope.selection.model
          || binding.destination !== expectedDestination || binding.runId !== scope.runId || binding.roleId !== scope.roleId || binding.stepId !== scope.stepId || binding.signal.aborted) refuse('CONFIG_CREDENTIAL_INVALID', '', 'execution');
        const token = tokens.get(approved.id); if (!token) refuse('CONFIG_CREDENTIAL_INVALID', '', 'execution'); return { bearerToken: token };
      };
      const mcp: PiHostV2['resolveMcpCredential'] = async binding => {
        const policy = scope.mcp;
        if (!('transport' in policy)) refuse('MCP_AUTHENTICATION_REQUIRED', '', 'execution');
        const approved = registry.spec.credentialBindings.find(item => item.id === policy.credentialRef);
        if (!approved || approved.consumer !== 'mcp' || approved.destinationRef !== policy.destinationRef || binding.credentialRef !== policy.credentialRef
          || binding.serverId !== policy.serverId || binding.transport !== policy.transport || binding.destinationRef !== policy.destinationRef || binding.endpoint !== policy.endpoint || binding.method !== 'POST'
          || binding.runId !== scope.runId || binding.roleId !== scope.roleId || binding.stepId !== scope.stepId || binding.signal.aborted) refuse('MCP_AUTHENTICATION_REQUIRED', '', 'execution');
        const token = tokens.get(approved.id); if (!token) refuse('MCP_AUTHENTICATION_REQUIRED', '', 'execution'); return { bearerToken: token };
      };
      return Object.freeze({ resolveCredential: provider, resolveMcpCredential: mcp });
    },
  });
}
