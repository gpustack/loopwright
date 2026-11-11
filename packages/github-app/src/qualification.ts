import { constants } from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ClockBasis, ClockSample, DeploymentHostProfileInput, DeploymentStorageProfile, HostQualification, McpAuthConfigurationInput, McpAuthValidation } from './types.js';

/** Qualified deployment host allowlist and unqualified filesystem denylist. */
export const QUALIFIED_PLATFORM_ARCH: readonly (readonly [string, string])[] = Object.freeze([
  ['darwin', 'arm64'], ['linux', 'arm64'], ['linux', 'x64'],
]);
export const UNQUALIFIED_FILESYSTEMS: readonly string[] = Object.freeze([
  'nfs', 'smb', 'cifs', 'fuse', 'sshfs', 'webdav', 'tmpfs-ephemeral-unverified',
]);
export const QUALIFIED_NODE_VERSION_PATTERN = /^v?26\./;
const MCP_OAUTH_AUTH_TYPES = new Set(['oauth', 'oauth2', 'browser', 'device_code', 'interactive']);
const DRIFT_LIMIT_MS = 1_000n;

/**
 * Local mirror of the `@loopwright/state` `clockValid` contract (monotonic non-decrease plus adjacent and
 * cumulative drift within 1000ms); that helper is not exported from `@loopwright/state` and this package must
 * not change its public exports.
 */
export function clockValid(basis: ClockBasis, last: ClockSample, now: ClockSample): boolean {
  const mono = (sample: ClockSample): bigint | null => typeof sample.monotonicMs === 'string' && /^[0-9]{1,20}$/.test(sample.monotonicMs) ? BigInt(sample.monotonicMs) : null;
  const monoNow = mono(now), monoLast = mono(last), monoBase = mono(basis.created);
  if (monoNow === null || monoLast === null || monoBase === null) return false;
  if (monoNow < monoLast || now.wallMs < last.wallMs) return false;
  const adjacent = BigInt(now.wallMs - last.wallMs) - (monoNow - monoLast);
  const cumulative = BigInt(now.wallMs - basis.created.wallMs) - (monoNow - monoBase);
  return adjacent >= -DRIFT_LIMIT_MS && adjacent <= DRIFT_LIMIT_MS && cumulative >= -DRIFT_LIMIT_MS && cumulative <= DRIFT_LIMIT_MS;
}

function unqualified(reason: string): HostQualification {
  return { ok: false, code: 'HOST_PROFILE_UNQUALIFIED', reason };
}

/**
 * Bounded `O_CREAT | O_EXCL | O_NOFOLLOW` lockfile probe: create, write, fsync, atomic rename, then remove.
 * Any failure (including an existing probe path) refuses the host; no probe residue remains on return.
 */
async function runStorageProbe(probeDirectory: string): Promise<HostQualification> {
  const unique = `${process.pid}-${randomBytes(6).toString('hex')}`;
  const staging = join(probeDirectory, `.loopwright-probe-${unique}.tmp`);
  const final = join(probeDirectory, `.loopwright-probe-${unique}.lock`);
  let handle = null;
  try {
    handle = await open(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | ('O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0), 0o600);
    await handle.writeFile('probe');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(staging, final);
  } catch (error) {
    return unqualified(`probe directory failed the exclusive lockfile probe: ${error instanceof Error ? error.message.slice(0, 120) : 'unknown error'}`);
  } finally {
    if (handle !== null) await handle.close().catch(() => undefined);
    await rm(staging, { force: true }).catch(() => undefined);
    await rm(final, { force: true }).catch(() => undefined);
  }
  return { ok: true };
}

/**
 * Fail-closed deployment host qualification: platform/arch allowlist, qualified Node runtime, non-network
 * filesystem, clock continuity within the 1000ms drift budget, a bounded exclusive storage probe, and
 * storage-profile rules that never silently reset budgets after host loss.
 */
export async function qualifyDeploymentHostProfile(input: DeploymentHostProfileInput): Promise<HostQualification> {
  const platformMatch = QUALIFIED_PLATFORM_ARCH.some(([platform, arch]) => platform === input.platform && arch === input.arch);
  if (!platformMatch) return unqualified(`(platform, arch) = (${input.platform}, ${input.arch}) is not a qualified deployment target`);
  if (typeof input.nodeVersion !== 'string' || !QUALIFIED_NODE_VERSION_PATTERN.test(input.nodeVersion)) {
    return unqualified(`nodeVersion ${String(input.nodeVersion)} does not match the qualified 26.x runtime`);
  }
  if (UNQUALIFIED_FILESYSTEMS.includes(input.filesystemType)) {
    return unqualified(`filesystemType ${input.filesystemType} is not a qualified local POSIX filesystem`);
  }
  if (!clockValid(input.clockBasis, input.previousClockSample, input.currentClockSample)) {
    return { ok: false, code: 'HOST_CLOCK_UNTRUSTED', reason: 'clock samples moved backward or drifted beyond the 1000ms budget' };
  }
  const storageProfile: DeploymentStorageProfile = input.storageProfile;
  if (storageProfile === 'actions-basic' && input.autoResumeOnHostLossRequested) {
    return {
      ok: false, code: 'STORAGE_PROFILE_INSUFFICIENT',
      reason: 'an actions-basic runner must never silently restart a cycle with a fresh full budget after host loss',
      recommendedRunStatus: 'reconcile_required',
    };
  }
  if (input.autoResumeOnHostLossRequested && !input.hasVerifiedCheckpointLedger) {
    return {
      ok: false, code: 'STORAGE_PROFILE_INSUFFICIENT',
      reason: 'resuming after an interrupted run requires a verified checkpoint ledger',
      recommendedRunStatus: 'reconcile_required',
    };
  }
  if (input.probeDirectory !== undefined) {
    return runStorageProbe(input.probeDirectory);
  }
  return { ok: true };
}

/**
 * Fail-closed interactive MCP authentication refusal: OAuth or browser-bound declarations and runtime
 * `WWW-Authenticate` challenges are refused with no browser launches, no loopback listeners, and no
 * anonymous fallback. This function performs no I/O.
 */
export function validateMcpAuthConfiguration(input: McpAuthConfigurationInput): McpAuthValidation {
  for (const server of input.servers) {
    const type = server.auth?.type;
    if (typeof type === 'string' && MCP_OAUTH_AUTH_TYPES.has(type)) {
      return { ok: false, code: 'MCP_OAUTH_UNSUPPORTED', reason: `MCP server ${server.serverId} declares ${type} authentication, which the control plane never performs` };
    }
  }
  const challenge = input.transportChallenge;
  if (challenge !== undefined && challenge !== null && (challenge.status === 401 || challenge.status === 403)) {
    const header = challenge.wwwAuthenticate ?? '';
    if (/Bearer|OAuth|authorization_uri/i.test(header)) {
      return { ok: false, code: 'MCP_AUTHENTICATION_REQUIRED', reason: `MCP transport answered ${challenge.status} with an interactive authentication challenge` };
    }
  }
  return { ok: true };
}
