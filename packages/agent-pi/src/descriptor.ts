import { readFile } from 'node:fs/promises';
import type { Digest } from '@loopwright/core';
import { digest, freeze } from './boundary.js';
import { result } from './errors.js';
import { MAX_LIMITS, SDK_INTEGRITY } from './policy.js';
import { PREAMBLE_IDENTITY } from './resources.js';
import { profileIdentity } from './runtime-profile.js';
import type { PiLimits, PiResult, ResourceIdentity } from './types.js';

export interface PiAdapterFiles {
  readonly version: 1;
  readonly sdkIntegrity: string;
  readonly preamble: ResourceIdentity;
  readonly localMcpScriptDigest: Digest;
  readonly restrictionDigest: Digest;
  readonly limits: PiLimits;
}

/** Installed byte identities only. This operation grants no runtime readiness or execution authority. */
export function describePiAdapterFiles(): Promise<PiResult<PiAdapterFiles>> {
  return result(async () => freeze({
    version: 1 as const,
    sdkIntegrity: SDK_INTEGRITY,
    preamble: { ...PREAMBLE_IDENTITY, digest: { ...PREAMBLE_IDENTITY.digest } },
    localMcpScriptDigest: digest(await readFile(new URL('./workspace-mcp.js', import.meta.url))),
    restrictionDigest: await profileIdentity(),
    limits: { ...MAX_LIMITS },
  }));
}
