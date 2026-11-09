import type { Digest } from '@loopwright/core';
import type { Purpose } from '@loopwright/state';
import type { AdapterPolicy, PiAdapter, PiCapabilities, PiError, PiHost, PiOpenInput, PiOutcome } from './types.js';

export interface HttpMcpPolicy {
  readonly serverId: 'workspace';
  readonly transport: 'sessionless-http-json-v1';
  readonly destinationRef: string;
  readonly endpoint: string;
  readonly approvedAddresses: readonly string[];
  readonly credentialRef: string;
  readonly names: readonly 'mcp__workspace__read_file'[];
  readonly effects: readonly 'read_only'[];
  readonly idleTimeoutSeconds: number;
  readonly absoluteTimeoutSeconds: number;
}
export interface AdapterPolicyV2 extends Omit<AdapterPolicy, 'version' | 'mcp'> {
  readonly version: 2;
  readonly mcp: AdapterPolicy['mcp'] | HttpMcpPolicy;
}
export interface McpCredentialBinding {
  readonly serverId: 'workspace';
  readonly transport: HttpMcpPolicy['transport'];
  readonly destinationRef: string;
  readonly endpoint: string;
  readonly method: 'POST';
  readonly credentialRef: string;
  readonly runId: string;
  readonly roleId: string;
  readonly stepId: string;
  readonly purpose: Purpose | null;
  readonly parentRequestId: string | null;
  readonly managementOperationId: string | null;
  readonly notAfterMonotonicMs: string;
  readonly signal: AbortSignal;
}
export interface PiHostV2 extends PiHost {
  readonly resolveMcpCredential: (binding: McpCredentialBinding) => Promise<{ readonly bearerToken: string }>;
}
export interface PiOpenInputV2 extends Omit<PiOpenInput, 'version' | 'policy'> {
  readonly version: 2;
  readonly policy: AdapterPolicyV2;
}
export interface PiErrorV2 extends Omit<PiError, 'code'> {
  readonly code: PiError['code'] | 'MCP_AUTHENTICATION_REQUIRED' | 'MCP_TRANSPORT_UNSUPPORTED';
}
export type PiResultV2<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: PiErrorV2 };
export interface PiOutcomeV2 extends Omit<PiOutcome, 'error' | 'cleanupError'> {
  readonly error: PiErrorV2 | null;
  readonly cleanupError: PiErrorV2 | null;
}
export interface PiCapabilitiesV2 extends Omit<PiCapabilities, 'version'> {
  readonly version: 2;
  /** The complete approved v2 policy. policyDigest still names the enforced native policy. */
  readonly sourcePolicyDigest: Digest;
  readonly mcpTransport: 'stdio' | HttpMcpPolicy['transport'];
}
export interface PiAdapterV2 extends Omit<PiAdapter, 'capabilities' | 'execute' | 'compact' | 'cancel'> {
  capabilities(): PiCapabilitiesV2;
  execute(input: Parameters<PiAdapter['execute']>[0]): Promise<PiResultV2<PiOutcomeV2>>;
  compact(input: Parameters<PiAdapter['compact']>[0]): Promise<PiResultV2<PiOutcomeV2>>;
  cancel(input: Parameters<PiAdapter['cancel']>[0]): Promise<PiResultV2<PiOutcomeV2>>;
}
