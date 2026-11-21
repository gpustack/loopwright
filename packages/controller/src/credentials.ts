import type { PiHost, PiHostV2, AdapterPolicyV2 } from '@loopwright/agent-pi';
import { resolveProviderDestination } from '@loopwright/agent-pi/catalog';
import { refuse } from './errors.js';
import { STREAM_CHUNK_BYTES } from './files.js';
import { canonical, id, list, record, text } from './schema.js';
import type { TrustedRegistry } from './types.js';

export interface CredentialStreamChecker {
  readonly push: (chunk: Uint8Array) => void;
  readonly finish: () => void;
  readonly overlapBytes?: number;
  readonly maxObservedWindowBytes?: number;
}

export interface CredentialVault {
  readonly references: readonly string[];
  readonly assertClean: (value: Uint8Array | string | object) => void;
  readonly createStreamChecker: () => CredentialStreamChecker;
  /** Gate and publisher signing/auth secrets only; provider and mcp consumers stay behind their bound resolvers. */
  readonly resolveNetworkCredential: (ref: string) => string;
  readonly bind: (scope: {
    readonly runId: string;
    readonly roleId: string;
    readonly stepId: string;
    readonly providerCredentialRef: string | null;
    readonly selection: AdapterPolicyV2['selection'];
    readonly mcp: AdapterPolicyV2['mcp'];
  }) => Pick<PiHostV2, 'resolveCredential' | 'resolveMcpCredential'>;
}

function deriveSecretFormBuffers(secrets: Iterable<string>): readonly Buffer[] {
  const formSet = new Set<string>();
  for (const token of secrets) {
    if (typeof token !== 'string' || token.length === 0) continue;
    const jsonEscaped = JSON.stringify(token).slice(1, -1);
    formSet.add(token);
    formSet.add(jsonEscaped);
    formSet.add(jsonEscaped.replaceAll('/', '\\/'));
    try {
      formSet.add(encodeURIComponent(token));
    } catch {
      // Ignore lone-surrogate URIError on untrusted standalone inputs.
    }
    formSet.add(Buffer.from(token, 'utf8').toString('base64'));
  }
  formSet.delete('');
  return Object.freeze([...formSet].map(form => Buffer.from(form, 'utf8')));
}

const UNBOUNDED_GENERIC_CREDENTIAL_PATTERNS: readonly RegExp[] = Object.freeze([
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/,
  /sk-(?:ant-|proj-)[A-Za-z0-9_-]{20,}/,
]);

const BOUNDED_GENERIC_CREDENTIAL_PATTERNS: readonly RegExp[] = Object.freeze([
  /(?<![0-9A-Za-z])AKIA[0-9A-Z]{16}(?![0-9A-Za-z])/g,
]);

function hasGenericCredentialPattern(bytes: Buffer, isFinal: boolean, minMatchEnd = 0): boolean {
  const textWindow = bytes.toString('latin1');
  if (UNBOUNDED_GENERIC_CREDENTIAL_PATTERNS.some(pattern => pattern.test(textWindow))) {
    return true;
  }
  for (const pattern of BOUNDED_GENERIC_CREDENTIAL_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(textWindow)) !== null) {
      const matchEnd = match.index + match[0].length;
      if (matchEnd < minMatchEnd) continue;
      if (isFinal || matchEnd < textWindow.length) {
        return true;
      }
    }
  }
  return false;
}

function createCredentialStreamCheckerFromBuffers(formBuffers: readonly Buffer[]): CredentialStreamChecker {
  const maxDerivedFormByteLength = formBuffers.reduce((max, buf) => Math.max(max, buf.byteLength), 0);
  const overlap = Math.min(262_144, Math.max(16_384, maxDerivedFormByteLength));
  const maxWindowSlice = STREAM_CHUNK_BYTES - overlap;
  let carryTail: Buffer = Buffer.alloc(0);
  let maxWindowBytes = 0;
  return Object.freeze({
    overlapBytes: overlap,
    get maxObservedWindowBytes(): number {
      return maxWindowBytes;
    },
    push: (chunk: Uint8Array): void => {
      if (chunk.byteLength === 0) return;
      const view = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      for (let offset = 0; offset < view.byteLength; offset += maxWindowSlice) {
        const sub = view.subarray(offset, Math.min(view.byteLength, offset + maxWindowSlice));
        const prevCarryLen = carryTail.byteLength;
        const combined = prevCarryLen === 0 ? sub : Buffer.concat([carryTail, sub]);
        if (combined.byteLength > maxWindowBytes) {
          maxWindowBytes = combined.byteLength;
        }
        if (formBuffers.some(form => combined.includes(form)) || hasGenericCredentialPattern(combined, false, prevCarryLen)) {
          if (carryTail.byteLength > 0) carryTail.fill(0);
          carryTail = Buffer.alloc(0);
          refuse('CONFIG_CREDENTIAL_INVALID', '/spec/credentials');
        }
        const keep = Math.min(overlap, combined.byteLength);
        if (carryTail.byteLength > 0) carryTail.fill(0);
        carryTail = Buffer.from(combined.subarray(combined.byteLength - keep));
      }
    },
    finish: (): void => {
      const tail = carryTail;
      carryTail = Buffer.alloc(0);
      try {
        if (tail.byteLength > maxWindowBytes) {
          maxWindowBytes = tail.byteLength;
        }
        if (
          tail.byteLength > 0
          && (formBuffers.some(form => tail.includes(form)) || hasGenericCredentialPattern(tail, true, tail.byteLength))
        ) {
          refuse('CONFIG_CREDENTIAL_INVALID', '/spec/credentials');
        }
      } finally {
        if (tail.byteLength > 0) tail.fill(0);
      }
    },
  });
}

export function createCredentialStreamChecker(secrets: Iterable<string>): CredentialStreamChecker {
  return createCredentialStreamCheckerFromBuffers(deriveSecretFormBuffers(secrets));
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
  const formBuffers = deriveSecretFormBuffers(tokens.values());
  return Object.freeze({
    references: Object.freeze([...tokens.keys()].sort()),
    assertClean: (value: Uint8Array | string | object): void => {
      const serialized = value instanceof Uint8Array
        ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
        : Buffer.from(typeof value === 'string' ? value : canonical(value));
      if (formBuffers.some(form => serialized.includes(form)) || hasGenericCredentialPattern(serialized, true, 0)) {
        refuse('CONFIG_CREDENTIAL_INVALID', '/spec/credentials');
      }
    },
    createStreamChecker: (): CredentialStreamChecker => createCredentialStreamCheckerFromBuffers(formBuffers),
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
