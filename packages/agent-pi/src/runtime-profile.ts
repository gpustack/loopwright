import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { canonical, digest } from './boundary.js';
import { refuse } from './errors.js';
import { sameIdentity } from './policy.js';
export async function profileIdentity() {
  const localSeccomp = new URL('../runtime/seccomp.json', import.meta.url);
  const seccompUrl = existsSync(localSeccomp)
    ? localSeccomp
    : new URL('../../../../packages/agent-pi/runtime/seccomp.json', import.meta.url);
  const seccomp = digest(await readFile(seccompUrl));
  const value = { version: 1, profile: 'linux/arm64', user: '1000:1000', network: 'none', readOnly: true, capabilities: 'drop-all', noNewPrivileges: true,
    seccomp, memory: 536870912, memorySwap: 536870912, cpus: 1, pids: 64, init: true,
    tmpBytes: 33554432, scratchBytes: 134217728, mounts: 'candidate-readonly', logs: 'none', environment: { HOME: '/tmp/home', PI_OFFLINE: '1', LANG: 'C.UTF-8', TERM: 'dumb', PATH: '/usr/local/bin:/usr/bin:/bin' } };
  return digest(Buffer.from(canonical(value)));
}

export function verifyRestrictions(value: Record<string, unknown>, candidateDirectory: string, seccomp: string): void {
    const config = value.Config as { User: string; Env: string[] };
    const host = value.HostConfig as { ReadonlyRootfs: boolean; NetworkMode: string; Privileged: boolean; Memory: number; MemorySwap: number; PidsLimit: number; CapDrop: string[]; CapAdd: string[] | null; SecurityOpt: string[]; NanoCpus: number; PidMode: string; IpcMode: string; UTSMode: string; Init: boolean; Devices: unknown[]; LogConfig: { Type: string }; Tmpfs: Record<string, string> };
    const mounts = value.Mounts as { Type: string; Source: string; Destination: string; RW: boolean }[];
    const expectedEnv = ['HOME=/tmp/home', 'PI_OFFLINE=1', 'PATH=/usr/local/bin:/usr/bin:/bin', 'LANG=C.UTF-8', 'TERM=dumb', 'NODE_VERSION=26.13.0'];
    const policies = host.SecurityOpt.filter(item => item.startsWith('seccomp='));
    if (config.User !== '1000:1000' || !sameIdentity([...config.Env].sort(), expectedEnv.sort()) || !host.ReadonlyRootfs || host.NetworkMode !== 'none' || host.Privileged || host.Memory !== 536870912 || host.MemorySwap !== 536870912 || host.PidsLimit !== 64 || host.NanoCpus !== 1000000000 || !sameIdentity(host.CapDrop, ['ALL']) || host.CapAdd?.length || !host.SecurityOpt.includes('no-new-privileges=true') || policies.length !== 1 || canonical(JSON.parse(policies[0]!.slice(8))) !== seccomp
      || host.PidMode !== '' || host.IpcMode !== 'private' || host.UTSMode !== '' || !host.Init || host.Devices.length || host.LogConfig.Type !== 'none'
      || !sameIdentity(host.Tmpfs, { '/tmp': 'rw,nosuid,nodev,noexec,size=33554432', '/scratch': 'rw,nosuid,nodev,noexec,size=134217728' })
      || mounts.length !== 1 || mounts.some(item => item.Type !== 'bind' || item.Source !== candidateDirectory || item.RW || item.Destination !== '/workspace/candidate')) refuse('CONTAINMENT_MISMATCH');
}
export function restrictedArguments(name: string, labels: Readonly<Record<string, string>>, candidate: string, image: string, role: 'sdk' | 'tool' | 'mcp', nonce: string, seccomp = new URL('../runtime/seccomp.json', import.meta.url)): string[] {
  return ['create', '--pull=never', '--interactive', '--init', '--name', name,
    ...Object.entries(labels).flatMap(([key, value]) => ['--label', key + '=' + value]), '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges=true',
    '--security-opt', 'seccomp=' + fileURLToPath(seccomp), '--user', '1000:1000', '--memory', '512m', '--memory-swap', '512m', '--cpus', '1', '--pids-limit', '64', '--log-driver', 'none',
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=33554432', '--tmpfs', '/scratch:rw,nosuid,nodev,noexec,size=134217728', '--mount', 'type=bind,src=' + candidate + ',dst=/workspace/candidate,readonly',
    '--env', 'HOME=/tmp/home', '--env', 'PI_OFFLINE=1', '--env', 'PATH=/usr/local/bin:/usr/bin:/bin', '--env', 'LANG=C.UTF-8', '--env', 'TERM=dumb',
    image, '/opt/loopwright/packages/agent-pi/dist/' + (role === 'sdk' ? 'sdk-worker.js' : role === 'tool' ? 'tool-worker.js' : 'workspace-mcp.js'), nonce];
}
