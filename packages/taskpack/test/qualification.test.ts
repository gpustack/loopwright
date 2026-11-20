import assert from 'node:assert/strict';
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { ClockBasis, ClockSample } from '../src/types.js';
import {
  clockValid,
  qualifyDeploymentHostProfile,
  validateMcpAuthConfiguration,
} from '../src/qualification.js';

function basisFrom(created: ClockSample): ClockBasis {
  return {
    clockEpoch: 'test',
    created: { ...created },
    taskDeadlineMonotonicMs: (BigInt(created.monotonicMs) + 1_000_000n).toString(),
  };
}

describe('qualification.ts: host clock, filesystem, storage probe, and MCP OAuth refusal', () => {
  const basis = basisFrom({ wallMs: 1_000_000, monotonicMs: '1000' });
  const baseInput = {
    platform: 'darwin',
    arch: 'arm64',
    nodeVersion: 'v26.1.0',
    filesystemType: 'apfs',
    storageProfile: 'durable' as const,
    clockBasis: basis,
    previousClockSample: { wallMs: 1_000_000, monotonicMs: '1000' },
    currentClockSample: { wallMs: 1_001_000, monotonicMs: '1050' },
    hasVerifiedCheckpointLedger: true,
    autoResumeOnHostLossRequested: false,
  };

  it('qualifies allowed host profiles, runs residue-free storage probe, and rejects unqualified hosts/clocks', async () => {
    assert.equal(clockValid(basis, baseInput.previousClockSample, baseInput.currentClockSample), true);

    const probeDir = await mkdtemp(join(await realpath(tmpdir()), 'lw-tp-qual-'));
    try {
      const ok = await qualifyDeploymentHostProfile({ ...baseInput, probeDirectory: probeDir });
      assert.deepEqual(ok, { ok: true });
      assert.deepEqual(await readdir(probeDir), []);
    } finally {
      await rm(probeDir, { recursive: true, force: true });
    }

    const badFs = await qualifyDeploymentHostProfile({ ...baseInput, filesystemType: 'nfs' });
    assert.equal(badFs.ok ? '' : badFs.code, 'HOST_PROFILE_UNQUALIFIED');

    const badClock = await qualifyDeploymentHostProfile({
      ...baseInput,
      currentClockSample: { wallMs: 1_005_000, monotonicMs: '1050' },
    });
    assert.equal(badClock.ok ? '' : badClock.code, 'HOST_CLOCK_UNTRUSTED');

    const badStorage = await qualifyDeploymentHostProfile({
      ...baseInput,
      storageProfile: 'actions-basic',
      autoResumeOnHostLossRequested: true,
    });
    assert.equal(badStorage.ok ? '' : badStorage.code, 'STORAGE_PROFILE_INSUFFICIENT');
  });

  it('refuses interactive MCP OAuth declarations and 401/403 WWW-Authenticate challenges', () => {
    const oauth = validateMcpAuthConfiguration({ servers: [{ serverId: 'docs', auth: { type: 'oauth2' } }] });
    assert.equal(oauth.ok ? '' : oauth.code, 'MCP_OAUTH_UNSUPPORTED');

    const challenge = validateMcpAuthConfiguration({
      servers: [],
      transportChallenge: { status: 401, wwwAuthenticate: 'Bearer realm="mcp"' },
    });
    assert.equal(challenge.ok ? '' : challenge.code, 'MCP_AUTHENTICATION_REQUIRED');

    const clean = validateMcpAuthConfiguration({
      servers: [{ serverId: 'docs', auth: { type: 'bearer' } }],
      transportChallenge: { status: 200, wwwAuthenticate: null },
    });
    assert.deepEqual(clean, { ok: true });
  });
});
