import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  canonicalJson,
  collectHardwareProvenance,
  HardwareRunnerError,
  signRelayPayload,
  startRelayServer,
  TRUSTED_ROCM_SMI_PATHS,
  type BenchmarkRequest,
  type BenchmarkVerdict,
  type ProbeCommandRunner,
} from '../src/index.js';

const PINNED_CUDA_ARCH_RE = /^sm_(?:80|86|89|90a?|100a?|120a?)$/;
const PINNED_ROCM_ARCH_RE = /^gfx(?:908|90a|942|1030|1100|1101|1102|1200|1201)$/;

export const DEFAULT_EXPECTED_CUDA_ARCH = 'sm_89' as const;
export const DEFAULT_EXPECTED_ROCM_ARCH = 'gfx1101' as const;

const WORKSPACE_PACKAGE_NAMES: readonly string[] = Object.freeze([
  'core',
  'state',
  'agent-pi',
  'controller',
  'taskpack-runner',
  'memory',
  'decisions',
  'taskpack',
  'github-app',
  'hardware-runner',
  'cli',
]);

export function validateRuntimeSshTarget(rawTarget: string): string {
  const trimmed = rawTarget.trim();
  if (
    trimmed.length === 0
    || trimmed.length > 256
    || trimmed.startsWith('-')
    || /[\s\0\r\n;|&$`'"\\]/.test(trimmed)
  ) {
    throw new Error('Invalid SSH host specification in environment variable');
  }
  return trimmed;
}

export function quotePosixShArg(arg: string): string {
  if (arg.includes('\0')) {
    throw new Error('POSIX shell argument must not contain NUL byte');
  }
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function buildSshRemoteShCommand(script: string): string {
  if (script.includes('\0')) {
    throw new Error('Remote shell script must not contain NUL byte');
  }
  return `/bin/sh -c ${quotePosixShArg(script)}`;
}

export function resolvePinnedAcceleratorArch(
  vendor: 'nvidia' | 'amd',
  probedArch: string,
  explicitExpectedArch?: string,
): string {
  const allowPattern = vendor === 'nvidia' ? PINNED_CUDA_ARCH_RE : PINNED_ROCM_ARCH_RE;
  const defaultExpected = vendor === 'nvidia' ? DEFAULT_EXPECTED_CUDA_ARCH : DEFAULT_EXPECTED_ROCM_ARCH;
  const trimmedExpected = explicitExpectedArch?.trim();
  const effectiveExpected = trimmedExpected !== undefined && trimmedExpected.length > 0
    ? trimmedExpected
    : defaultExpected;
  if (!allowPattern.test(effectiveExpected)) {
    throw new Error(`Configured expected ${vendor} architecture "${effectiveExpected}" is outside the qualified target set`);
  }
  if (!allowPattern.test(probedArch)) {
    throw new Error(`Probed physical ${vendor} architecture "${probedArch}" is outside the pinned target whitelist`);
  }
  if (probedArch !== effectiveExpected) {
    throw new Error(`Probed physical ${vendor} architecture "${probedArch}" did not match pinned "${effectiveExpected}"`);
  }
  return effectiveExpected;
}

export function isSupportedRemoteNode26Version(rawVersion: string): boolean {
  const cleaned = rawVersion.trim().replace(/^v/, '');
  const major = Number.parseInt(cleaned.split('.')[0] ?? '', 10);
  return Number.isSafeInteger(major) && major === 26;
}

export function createRemoteTrustedExecutableVerifier(
  runRemoteScript: (
    remoteScript: string,
    timeoutMs?: number,
  ) => Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>,
): (binaryPath: string, trustedAllowlist: readonly string[]) => Promise<string> {
  return async (binaryPath: string, trustedAllowlist: readonly string[]): Promise<string> => {
    if (!trustedAllowlist.includes(binaryPath)) {
      throw new HardwareRunnerError('RUNNER_SANDBOX_FAILED', `untrusted remote probe executable "${binaryPath}"`);
    }
    const quoted = quotePosixShArg(binaryPath);
    const checkRes = await runRemoteScript(`test -f ${quoted} && test -x ${quoted}`, 10_000);
    if (checkRes.exitCode !== 0) {
      throw new HardwareRunnerError(
        'RUNNER_SANDBOX_FAILED',
        `remote probe executable "${binaryPath}" is not installed or not executable`,
      );
    }
    return binaryPath;
  };
}

function sha256Hex(input: Uint8Array | string): string {
  return createHash('sha256').update(input).digest('hex');
}

function sanitizedSshEnv(): Record<string, string> {
  return {
    PATH: '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/nonexistent',
    ...(process.env.SSH_AUTH_SOCK !== undefined ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
    LANG: 'C',
    LC_ALL: 'C',
  };
}

function runSshRemoteScript(
  sshTarget: string,
  remoteScript: string,
  timeoutMs = 45_000,
  stdinBytes?: Buffer,
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const validatedTarget = validateRuntimeSshTarget(sshTarget);
  // Always pass a SINGLE POSIX-quoted remote command string to OpenSSH so login shells never split -c scripts!
  const singleRemoteCommand = buildSshRemoteShCommand(remoteScript);
  return new Promise((resolveCmd, rejectCmd) => {
    const child = execFile(
      '/usr/bin/ssh',
      [
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=10',
        '-o',
        'ForwardAgent=no',
        '-o',
        'ClearAllForwardings=yes',
        '--',
        validatedTarget,
        singleRemoteCommand,
      ],
      {
        shell: false,
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        env: sanitizedSshEnv(),
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const errno = error as NodeJS.ErrnoException & { code?: number | string };
          if (typeof errno.code === 'number') {
            resolveCmd({ exitCode: errno.code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
            return;
          }
          rejectCmd(error);
          return;
        }
        resolveCmd({ exitCode: 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
    if (stdinBytes !== undefined && child.stdin !== null) {
      child.stdin.end(stdinBytes);
    } else if (child.stdin !== null) {
      child.stdin.end();
    }
  });
}

function createRemoteSshProbeRunner(sshTarget: string): ProbeCommandRunner {
  return async (executablePath, args, options) => {
    const quotedExec = [executablePath, ...args].map(quotePosixShArg).join(' ');
    return runSshRemoteScript(sshTarget, `exec ${quotedExec}`, options.timeoutMs);
  };
}

function collectRuntimeNodeModulesPaths(repoRoot: string): readonly string[] {
  const lockRaw = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8')) as {
    packages?: Readonly<Record<string, { dev?: boolean; link?: boolean; optional?: boolean }>>;
  };
  const out: string[] = [];
  for (const [pkgKey, meta] of Object.entries(lockRaw.packages ?? {})) {
    if (!pkgKey.startsWith('node_modules/')) continue;
    if (meta.dev === true || meta.link === true || meta.optional === true) continue;
    if (pkgKey.startsWith('node_modules/@types/')) continue;
    const absPath = join(repoRoot, pkgKey);
    if (!existsSync(absPath)) continue;
    const st = lstatSync(absPath);
    if (st.isSymbolicLink() || !st.isDirectory()) continue;
    out.push(pkgKey);
  }
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return out;
}

export async function packWorkspaceBundleTar(): Promise<Buffer> {
  const repoRoot = resolve(process.cwd());
  const entriesToPack: string[] = ['package.json', 'package-lock.json'];
  for (const pkg of WORKSPACE_PACKAGE_NAMES) {
    entriesToPack.push(`packages/${pkg}/package.json`, `packages/${pkg}/dist`);
    for (const extraDir of ['runtime', 'vendor']) {
      if (existsSync(join(repoRoot, 'packages', pkg, extraDir))) {
        entriesToPack.push(`packages/${pkg}/${extraDir}`);
      }
    }
  }
  const runtimeNodeModules = collectRuntimeNodeModulesPaths(repoRoot);
  const includedRoots: string[] = [];
  for (const relMod of runtimeNodeModules) {
    if (includedRoots.some(parent => relMod.startsWith(`${parent}/`))) {
      continue;
    }
    entriesToPack.push(relMod);
    includedRoots.push(relMod);
  }

  return await new Promise<Buffer>((resolveTar, rejectTar) => {
    const child = spawn(
      '/usr/bin/tar',
      ['--exclude=*.node', '-czf', '-', ...entriesToPack],
      {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const chunks: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('error', rejectTar);
    child.on('close', code => {
      if (code !== 0) {
        rejectTar(new Error(`tar bundle failed (${String(code)}): ${stderr}`));
        return;
      }
      resolveTar(Buffer.concat(chunks));
    });
  });
}

function buildWorkspaceLinksShellSnippet(appDirExpr: string): string {
  const linkCmds = WORKSPACE_PACKAGE_NAMES.map(
    pkg => `ln -sfn ../../packages/${pkg} ${appDirExpr}/node_modules/@loopwright/${pkg}`,
  );
  return [
    `mkdir -p ${appDirExpr}/node_modules/@loopwright`,
    `cp ${appDirExpr}/package-lock.json ${appDirExpr}/node_modules/package-lock.json`,
    ...linkCmds,
  ].join(' && ');
}

export function buildRemoteNode26ResolverScript(remoteTmpDir: string, explicitRemoteNode?: string): string {
  const quotedTmp = quotePosixShArg(remoteTmpDir);
  const explicitCheck = explicitRemoteNode !== undefined && explicitRemoteNode.trim().length > 0
    ? `check_node26 ${quotePosixShArg(explicitRemoteNode.trim())} && exit 0`
    : ':';
  return [
    'set -eu',
    'check_node26() {',
    '  cand="$1"',
    '  [ -n "$cand" ] && [ -x "$cand" ] || return 1',
    '  maj=$("$cand" -p "Number(process.versions.node.split(\'.\')[0])" 2>/dev/null || echo 0)',
    '  if [ "$maj" -eq 26 ] 2>/dev/null; then',
    '    printf "%s\\n" "$cand"',
    '    return 0',
    '  fi',
    '  return 1',
    '}',
    explicitCheck,
    'if command -v node >/dev/null 2>&1; then check_node26 "$(command -v node)" && exit 0; fi',
    'for cand in "$HOME"/.nvm/versions/node/v26.*/bin/node "$HOME"/.local/share/fnm/node-versions/v26.*/installation/bin/node "$HOME"/.volta/tools/image/node/26.*/bin/node "$HOME"/.asdf/installs/nodejs/26.*/bin/node /usr/local/bin/node /opt/node26/bin/node /opt/nodejs/bin/node; do',
    '  check_node26 "$cand" && exit 0',
    'done',
    // Spec fallback: extract Node 26 runtime binary from node:26-bookworm-slim via Docker when host lacks Node 26.x
    `mkdir -p ${quotedTmp}/node26/bin`,
    'cid=$(/usr/bin/docker create node:26-bookworm-slim 2>/dev/null || (/usr/bin/docker pull node:26-bookworm-slim >/dev/null && /usr/bin/docker create node:26-bookworm-slim))',
    `trap '/usr/bin/docker rm -f "$cid" >/dev/null 2>&1 || true' EXIT`,
    `/usr/bin/docker cp "$cid:/usr/local/bin/node" ${quotedTmp}/node26/bin/node`,
    `/usr/bin/docker rm -f "$cid" >/dev/null 2>&1 || true`,
    'trap - EXIT',
    `chmod 0500 ${quotedTmp}/node26/bin/node`,
    `check_node26 ${quotedTmp}/node26/bin/node && exit 0`,
    'echo "Unable to locate or provision a Node.js 26.x runtime on remote host" >&2',
    'exit 1',
  ].join('\n');
}

async function openReverseSshRelayTunnel(
  sshTarget: string,
  localRelayPort: number,
  remotePort: number,
): Promise<{ close(): Promise<void> }> {
  const validatedTarget = validateRuntimeSshTarget(sshTarget);
  const child: ChildProcess = spawn(
    '/usr/bin/ssh',
    [
      '-N',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ForwardAgent=no',
      '-R',
      `127.0.0.1:${remotePort}:127.0.0.1:${localRelayPort}`,
      '--',
      validatedTarget,
    ],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: sanitizedSshEnv(),
    },
  );
  let stderr = '';
  child.stderr?.on('data', (c: Buffer) => {
    stderr += c.toString('utf8');
  });

  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`SSH reverse tunnel exited early (${child.exitCode}): ${stderr}`);
    }
    const probe = await runSshRemoteScript(
      sshTarget,
      `nc -z 127.0.0.1 ${remotePort} 2>/dev/null || (exec 3<>/dev/tcp/127.0.0.1/${remotePort}) 2>/dev/null`,
      5_000,
    ).catch(() => ({ exitCode: 1, stdout: '', stderr: '' }));
    if (probe.exitCode === 0) {
      break;
    }
    await new Promise(r => setTimeout(r, 150));
  }

  return {
    async close(): Promise<void> {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise<void>(r => {
          const t = setTimeout(() => {
            child.kill('SIGKILL');
            r();
          }, 1_000);
          t.unref();
          child.once('close', () => {
            clearTimeout(t);
            r();
          });
        });
      }
    },
  };
}

async function resolveRemoteDockerImage(
  sshTarget: string,
  envOverride: string | undefined,
  repoPatterns: readonly string[],
  fallbackImage: string,
): Promise<string> {
  if (envOverride !== undefined && envOverride.trim().length > 0) {
    return envOverride.trim();
  }
  const imagesRes = await runSshRemoteScript(
    sshTarget,
    `/usr/bin/docker images --format '{{.Repository}}:{{.Tag}}'`,
    15_000,
  );
  assert.equal(imagesRes.exitCode, 0, `remote docker daemon unavailable: ${imagesRes.stderr}`);
  const lines = imagesRes.stdout
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.includes('<none>'));
  for (const pat of repoPatterns) {
    const found = lines.find(l => l.toLowerCase().includes(pat.toLowerCase()));
    if (found !== undefined) return found;
  }
  const pullRes = await runSshRemoteScript(
    sshTarget,
    `/usr/bin/docker pull ${quotePosixShArg(fallbackImage)}`,
    300_000,
  );
  assert.equal(pullRes.exitCode, 0, `failed to pull Docker image ${fallbackImage}: ${pullRes.stderr}`);
  return fallbackImage;
}

async function executeRemoteDockerBenchmarkSmoke(options: {
  readonly sshTarget: string;
  readonly vendor: 'nvidia' | 'amd';
  readonly dockerImage: string;
  readonly workloadId: string;
  readonly stageAFiles: readonly { readonly name: string; readonly content: string; readonly mode?: '100644' | '100755' }[];
  readonly heldOutInputValues: readonly number[];
  readonly stageBWorkloadScript: string;
  readonly expectedSum: number;
  readonly fallbackCapAccel: string;
  readonly explicitExpectedArch?: string;
}): Promise<{ readonly verdict: BenchmarkVerdict; readonly pinnedArch: string }> {
  // Generate distinct cryptographically random per-run secrets; controllerSigningSecret and
  // controllerAuthToken NEVER leave this local coordinator process!
  const controllerSigningSecret = randomBytes(32).toString('hex');
  const controllerAuthToken = randomBytes(32).toString('hex');
  const workerToken = randomBytes(32).toString('hex');

  const localRoot = await mkdtemp(join(tmpdir(), `lw-live-${options.vendor}-`));
  const casDir = join(localRoot, 'cas');
  await mkdir(casDir, { recursive: true, mode: 0o700 });

  const relay = await startRelayServer({
    host: '127.0.0.1',
    port: 0,
    casDir,
    controllerSigningSecret,
    controllerAuthToken,
    workerTokens: [workerToken],
    leaseTtlMs: 30_000,
  });

  let remoteTmpDir = '';
  let tunnel: { close(): Promise<void> } | null = null;

  try {
    // 1. Collect live physical provenance from remote host (checking remote executable availability!)
    //    and pin target architecture against default sm_89 / gfx1101 or explicit override.
    const remoteProbeRunner = createRemoteSshProbeRunner(options.sshTarget);
    const remoteExecVerifier = createRemoteTrustedExecutableVerifier((remoteScript, timeoutMs) =>
      runSshRemoteScript(options.sshTarget, remoteScript, timeoutMs),
    );
    const preProbe = await collectHardwareProvenance({
      probeMode: 'physical',
      targetCellId: `live-${options.vendor}-cell`,
      capabilities: {
        accelerator: options.fallbackCapAccel,
        isolationModes: ['whole_device', 'sliced'],
        deviceCount: 1,
        driverVersion: '0.0.0',
      },
      workloadDigest: { algorithm: 'sha256', hex: '0'.repeat(64) },
      sandboxBackend: 'docker',
      verifyExecutable: remoteExecVerifier,
      commandRunner: remoteProbeRunner,
      timeoutMs: 25_000,
    });
    assert.equal(preProbe.probeKind, 'physical');
    assert.equal(preProbe.vendor, options.vendor);
    const pinnedArch = resolvePinnedAcceleratorArch(options.vendor, preProbe.accelerator, options.explicitExpectedArch);

    // 2. Stage candidate Stage A build script + kernel source onto local Relay CAS using local-only controller credentials
    const operationId = `verify.0.check.${options.vendor}-live-docker`;
    const entries = [];
    for (const f of options.stageAFiles) {
      const buf = Buffer.from(f.content, 'utf8');
      const sha = sha256Hex(buf);
      const putRes = await fetch(`${relay.url}/v1/benchmark/jobs/${operationId}/blobs/${sha}`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${controllerAuthToken}`,
          'x-loopwright-blob-sha256': sha,
          'x-loopwright-blob-length': String(buf.byteLength),
          'x-loopwright-signature': signRelayPayload(
            controllerSigningSecret,
            `PUT\n${operationId}\n${sha}\n${buf.byteLength}`,
          ),
        },
        body: new Uint8Array(buf),
      });
      assert.equal(putRes.status === 200 || putRes.status === 201, true);
      entries.push({
        name: f.name,
        digest: { algorithm: 'sha256' as const, hex: sha },
        byteLength: buf.byteLength,
        ...(f.mode !== undefined ? { mode: f.mode } : {}),
      });
    }

    const lockHex = sha256Hex(`lock-${operationId}`);
    const candHex = entries[0]!.digest.hex;
    const req: BenchmarkRequest = {
      version: 1,
      kind: 'benchmark_request',
      storeId: `live-${options.vendor}-store`,
      runId: `live-${options.vendor}-run`,
      lockHash: { algorithm: 'sha256', hex: lockHex },
      operationId,
      dispatchId: `disp-${options.vendor}`,
      dispatchGeneration: 1,
      requestDigest: sha256Hex(`req-${operationId}`),
      gateId: `${options.vendor}-docker-gate`,
      checkId: `${options.vendor}-docker-smoke`,
      candidateDigest: candHex,
      subject: {
        lockHash: { algorithm: 'sha256', hex: lockHex },
        contractHash: { algorithm: 'sha256', hex: lockHex },
        repository: 'org/live-smoke',
        baseRevision: '1'.repeat(40),
        sourceRevision: '1'.repeat(40),
        candidateDigest: { algorithm: 'sha256', hex: candHex },
        targetMatrixDigest: { algorithm: 'sha256', hex: lockHex },
      },
      targetCellId: `live-${options.vendor}-cell`,
      targetHardware: {
        accelerator: pinnedArch,
        isolationMode: preProbe.isolationMode,
        deviceCount: 1,
      },
      heldOutWorkloadId: options.workloadId,
      metricThresholds: [
        { kind: 'bounds', metric: 'gpu_sum', min: options.expectedSum, max: options.expectedSum },
        { kind: 'bounds', metric: 'device_count', min: 1, max: 1 },
      ],
      maxPreemptions: 1,
      candidateArtifacts: { entries, deleted: [] },
    };
    const reqBody = Buffer.from(canonicalJson(req), 'utf8');
    const postRes = await fetch(`${relay.url}/v1/benchmark/jobs`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${controllerAuthToken}`,
        'content-type': 'application/json',
        'x-loopwright-signature': signRelayPayload(controllerSigningSecret, reqBody),
      },
      body: new Uint8Array(reqBody),
    });
    assert.equal(postRes.status, 200);

    // 3. Provision private 0700 workspace + full runtime dependency closure on remote GPU host
    const mkRes = await runSshRemoteScript(options.sshTarget, 'umask 077 && /usr/bin/mktemp -d /tmp/lw-remote-smoke.XXXXXXXX');
    assert.equal(mkRes.exitCode, 0, `mktemp failed on remote host: ${mkRes.stderr}`);
    remoteTmpDir = mkRes.stdout.trim();
    assert.equal(remoteTmpDir.startsWith('/tmp/lw-remote-smoke.'), true);

    const bundleTar = await packWorkspaceBundleTar();
    const quotedTmp = quotePosixShArg(remoteTmpDir);
    const quotedWlDir = quotePosixShArg(`${remoteTmpDir}/workloads/${options.workloadId}`);
    const unpackSetupRes = await runSshRemoteScript(
      options.sshTarget,
      [
        'set -eu',
        `umask 077`,
        `mkdir -p ${quotedTmp}/app ${quotedTmp}/work ${quotedWlDir}`,
        `chmod 700 ${quotedTmp} ${quotedTmp}/work ${quotedTmp}/workloads ${quotedWlDir}`,
        `tar -xzf - -C ${quotedTmp}/app`,
        buildWorkspaceLinksShellSnippet(`${quotedTmp}/app`),
      ].join(' && '),
      90_000,
      bundleTar,
    );
    assert.equal(unpackSetupRes.exitCode, 0, `failed to stage runner bundle on remote host: ${unpackSetupRes.stderr}`);

    // 4. Resolve Node >= 26 runtime (with automatic Docker node:26 fallback) and run import self-check BEFORE benchmark!
    const nodeResolveRes = await runSshRemoteScript(
      options.sshTarget,
      buildRemoteNode26ResolverScript(remoteTmpDir, process.env.LOOPWRIGHT_REMOTE_NODE),
      180_000,
    );
    assert.equal(
      nodeResolveRes.exitCode,
      0,
      `failed to resolve Node >= 26 on remote host: ${nodeResolveRes.stderr}`,
    );
    const remoteNodeBin = nodeResolveRes.stdout.trim().split(/\r?\n/).pop()?.trim() ?? '';
    assert.equal(remoteNodeBin.startsWith('/'), true, `unexpected remote Node path "${remoteNodeBin}"`);

    const selfCheckRes = await runSshRemoteScript(
      options.sshTarget,
      `cd ${quotedTmp}/app && ${quotePosixShArg(remoteNodeBin)} --input-type=module -e ${quotePosixShArg(
        'if (Number(process.versions.node.split(".")[0]) !== 26) process.exit(2); const m = await import("./packages/hardware-runner/dist/index.js"); if (typeof m.runHardwareWorker !== "function") process.exit(1); process.stdout.write("IMPORT_OK:" + process.version + "\\n");',
      )}`,
      30_000,
    );
    assert.equal(
      selfCheckRes.exitCode,
      0,
      `remote @loopwright/hardware-runner import self-check failed: stdout=${selfCheckRes.stdout} stderr=${selfCheckRes.stderr}`,
    );
    const reportedVer = /^IMPORT_OK:(v[^\r\n]+)$/m.exec(selfCheckRes.stdout)?.[1] ?? '';
    assert.equal(isSupportedRemoteNode26Version(reportedVer), true, `expected Node 26.x, got "${reportedVer}"`);

    const remoteRelayPort = randomInt(29_000, 49_000);
    tunnel = await openReverseSshRelayTunnel(options.sshTarget, relay.port, remoteRelayPort);

    // Pass ONLY the per-run workerToken via stdin into the private 0700 remote directory (never on CLI argv!)
    const workerConfigObj = {
      workerId: `remote-${options.vendor}-docker-worker`,
      relayUrl: `http://127.0.0.1:${remoteRelayPort}`,
      workerToken,
      workDir: `${remoteTmpDir}/work`,
      heldOutWorkloadsDir: `${remoteTmpDir}/workloads`,
      sandboxBackend: 'docker',
      dockerImage: options.dockerImage,
      capabilities: {
        accelerator: pinnedArch,
        isolationModes: [preProbe.isolationMode],
        deviceCount: 1,
        driverVersion: preProbe.driverVersion,
        workloadIds: [options.workloadId],
      },
      pollWaitMs: 2_000,
      heartbeatIntervalMs: 1_000,
      requestTimeoutMs: 20_000,
      stageATimeoutMs: 120_000,
      stageBTimeoutMs: 120_000,
      toolchainPaths: [],
      probeMode: 'physical',
    };

    const remoteRunnerBootstrap = [
      `import { chmodSync, writeFileSync } from 'node:fs';`,
      `import { runHardwareWorker } from './packages/hardware-runner/dist/index.js';`,
      `writeFileSync(${JSON.stringify(`${remoteTmpDir}/workloads/${options.workloadId}/inputs.txt`)}, ${JSON.stringify(options.heldOutInputValues.join('\n') + '\n')}, { mode: 0o600 });`,
      `writeFileSync(${JSON.stringify(`${remoteTmpDir}/workloads/${options.workloadId}/evaluate.sh`)}, ${JSON.stringify(options.stageBWorkloadScript)}, { mode: 0o755 });`,
      `chmodSync(${JSON.stringify(`${remoteTmpDir}/workloads/${options.workloadId}/evaluate.sh`)}, 0o755);`,
      `const result = await runHardwareWorker({ config: ${JSON.stringify(workerConfigObj)}, once: true });`,
      `process.stdout.write('REMOTE_WORKER_RESULT:' + JSON.stringify(result) + '\\n');`,
    ].join('\n');

    // 5. Execute outbound worker + two-stage Docker sandbox on the remote host
    const remoteExecRes = await runSshRemoteScript(
      options.sshTarget,
      `cd ${quotedTmp}/app && exec ${quotePosixShArg(remoteNodeBin)} --input-type=module -`,
      240_000,
      Buffer.from(remoteRunnerBootstrap, 'utf8'),
    );
    assert.equal(
      remoteExecRes.exitCode,
      0,
      `remote outbound Docker worker failed (${remoteExecRes.exitCode}): stdout=${remoteExecRes.stdout} stderr=${remoteExecRes.stderr}`,
    );

    // 6. Poll local Relay verdict using local-only controller credentials
    const pollRes = await fetch(`${relay.url}/v1/benchmark/jobs`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${controllerAuthToken}`,
        'content-type': 'application/json',
        'x-loopwright-signature': signRelayPayload(controllerSigningSecret, reqBody),
      },
      body: new Uint8Array(reqBody),
    });
    assert.equal(pollRes.status, 200);
    const verdict = (await pollRes.json()) as BenchmarkVerdict;
    assert.equal(verdict.status, 'approved', `remote Docker benchmark denied: ${verdict.reason} - ${verdict.detail ?? ''}`);
    assert.equal(verdict.hardwareProvenance?.probeKind, 'physical');
    assert.equal(verdict.hardwareProvenance?.vendor, options.vendor);
    assert.equal(verdict.hardwareProvenance?.accelerator, pinnedArch);
    assert.equal(verdict.hardwareProvenance?.deviceCount, 1);
    assert.equal(verdict.metrics?.gpu_sum, options.expectedSum);
    assert.equal(verdict.metrics?.device_count, 1);
    assert.equal((verdict.outputArtifacts?.length ?? 0) >= 1, true);
    return { verdict, pinnedArch };
  } finally {
    if (tunnel !== null) {
      await tunnel.close().catch(() => {});
    }
    if (remoteTmpDir.startsWith('/tmp/lw-remote-smoke.')) {
      await runSshRemoteScript(options.sshTarget, `/bin/rm -rf -- ${quotePosixShArg(remoteTmpDir)}`, 15_000).catch(() => {});
    }
    await relay.close();
    await rm(localRoot, { recursive: true, force: true });
  }
}

test('validateRuntimeSshTarget, POSIX single-command SSH quoting, pinned arch validation, and standalone bundle import closure', async () => {
  assert.equal(validateRuntimeSshTarget('gpu-worker.example.internal'), 'gpu-worker.example.internal');
  for (const invalid of ['', '   ', '-oProxyCommand=evil', 'host;id', 'host name', 'user@host$foo', 'host\nid']) {
    assert.throws(() => validateRuntimeSshTarget(invalid), /Invalid SSH host/);
  }

  // Single-command SSH quoting preserves directory changes and embedded quotes as one shell command
  const cmd = buildSshRemoteShCommand(`cd '/tmp/lw dir' && node -e "console.log('ok')"`);
  assert.equal(cmd.startsWith("/bin/sh -c '"), true);
  assert.throws(() => quotePosixShArg('bad\0arg'), /NUL/);

  // Architecture pinning defaults strictly to sm_89 (CUDA) and gfx1101 (ROCm), while honoring explicit allowlisted overrides
  assert.equal(resolvePinnedAcceleratorArch('nvidia', 'sm_89'), 'sm_89');
  assert.throws(() => resolvePinnedAcceleratorArch('nvidia', 'sm_80'), /did not match pinned "sm_89"/);
  assert.equal(resolvePinnedAcceleratorArch('nvidia', 'sm_80', 'sm_80'), 'sm_80');
  assert.equal(resolvePinnedAcceleratorArch('nvidia', 'sm_90a', 'sm_90a'), 'sm_90a');
  assert.throws(() => resolvePinnedAcceleratorArch('nvidia', 'sm_89', 'sm_90a'), /did not match pinned "sm_90a"/);
  assert.throws(() => resolvePinnedAcceleratorArch('nvidia', 'sm_35', 'sm_35'), /outside the qualified target set/);

  assert.equal(resolvePinnedAcceleratorArch('amd', 'gfx1101'), 'gfx1101');
  assert.throws(() => resolvePinnedAcceleratorArch('amd', 'gfx942'), /did not match pinned "gfx1101"/);
  assert.equal(resolvePinnedAcceleratorArch('amd', 'gfx942', 'gfx942'), 'gfx942');
  assert.throws(() => resolvePinnedAcceleratorArch('amd', 'gfx803', 'gfx803'), /outside the qualified target set/);

  // Unified Node 26 predicate rejects Node 25 and Node 27, accepting only 26.x
  assert.equal(isSupportedRemoteNode26Version('v26.13.1'), true);
  assert.equal(isSupportedRemoteNode26Version('26.0.0'), true);
  assert.equal(isSupportedRemoteNode26Version('v27.0.0'), false);
  assert.equal(isSupportedRemoteNode26Version('v24.11.0'), false);

  const resolverSh = buildRemoteNode26ResolverScript('/tmp/lw-remote-smoke.test123', '/opt/node26/bin/node');
  assert.equal(resolverSh.includes('/opt/node26/bin/node'), true);
  assert.equal(resolverSh.includes('[ "$maj" -eq 26 ]'), true);
  assert.equal(resolverSh.includes('node:26-bookworm-slim'), true);

  // Execute buildRemoteNode26ResolverScript in /bin/sh with a fake Node 27 on PATH and a fake Node 26 fallback:
  // verifies Node 27 is rejected so installed Node 26 is selected!
  const fakeNodeDir = await mkdtemp(join(tmpdir(), 'lw-node26-resolver-'));
  try {
    const pathBinDir = join(fakeNodeDir, 'path-bin');
    const nvmNode26Dir = join(fakeNodeDir, 'home', '.nvm', 'versions', 'node', 'v26.13.1', 'bin');
    await mkdir(pathBinDir, { recursive: true, mode: 0o700 });
    await mkdir(nvmNode26Dir, { recursive: true, mode: 0o700 });

    // Fake Node 27 on PATH (prints 27 for major check)
    const fakeNode27 = join(pathBinDir, 'node');
    await writeFile(fakeNode27, '#!/bin/sh\necho 27\n', { mode: 0o755 });
    await chmod(fakeNode27, 0o755);

    // Fake Node 26 in $HOME/.nvm/versions/node/v26.*/bin/node (prints 26 for major check)
    const fakeNode26 = join(nvmNode26Dir, 'node');
    await writeFile(fakeNode26, '#!/bin/sh\necho 26\n', { mode: 0o755 });
    await chmod(fakeNode26, 0o755);

    const resolvedBySh = await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolveSh => {
      execFile(
        '/bin/sh',
        ['-c', buildRemoteNode26ResolverScript(join(fakeNodeDir, 'remote-tmp'))],
        {
          env: {
            PATH: `${pathBinDir}:/usr/bin:/bin`,
            HOME: join(fakeNodeDir, 'home'),
          },
          timeout: 5_000,
        },
        (err, stdout, stderr) => {
          const code = err ? ((err as { code?: number }).code ?? 1) : 0;
          resolveSh({ code: typeof code === 'number' ? code : 1, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
    assert.equal(resolvedBySh.code, 0, resolvedBySh.stderr);
    assert.equal(resolvedBySh.stdout.trim(), fakeNode26);
  } finally {
    await rm(fakeNodeDir, { recursive: true, force: true });
  }

  // Remote probe executable verifier checks executable availability across TRUSTED_ROCM_SMI_PATHS,
  // skipping absent /opt/rocm/bin/rocm-smi and selecting installed /usr/bin/rocm-smi!
  const probedRemotePaths: string[] = [];
  const invokedRemoteBins: string[] = [];
  const mockRemoteVerifier = createRemoteTrustedExecutableVerifier(async script => {
    probedRemotePaths.push(script);
    if (script.includes("'/usr/bin/rocm-smi'")) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    return { exitCode: 1, stdout: '', stderr: '' };
  });
  const fallbackRocmProv = await collectHardwareProvenance({
    probeMode: 'physical',
    targetCellId: 'live-amd-cell',
    capabilities: {
      accelerator: 'gfx1101',
      isolationModes: ['whole_device'],
      deviceCount: 1,
      driverVersion: '0.0.0',
    },
    workloadDigest: { algorithm: 'sha256', hex: '0'.repeat(64) },
    sandboxBackend: 'docker',
    verifyExecutable: mockRemoteVerifier,
    commandRunner: async binPath => {
      invokedRemoteBins.push(binPath);
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          card0: { 'Card series': 'AMD Radeon RX 7800 XT', 'GFX Version': 'gfx1101' },
          system: { 'Driver version': '6.8.5' },
        }),
        stderr: '',
      };
    },
  });
  assert.equal(fallbackRocmProv.accelerator, 'gfx1101');
  assert.equal(probedRemotePaths.some(s => s.includes(TRUSTED_ROCM_SMI_PATHS[0]!)), true);
  assert.equal(invokedRemoteBins[0], '/usr/bin/rocm-smi');

  // Verify packWorkspaceBundleTar() contains the COMPLETE runtime dependency closure (including yaml, taskpack, core)
  // by extracting into an isolated temp directory outside the repository and importing @loopwright/hardware-runner!
  const isolatedDir = await mkdtemp(join(tmpdir(), 'lw-bundle-closure-verify-'));
  try {
    const bundleTar = await packWorkspaceBundleTar();
    await new Promise<void>((resolveUnpack, rejectUnpack) => {
      const tarProc = spawn('/usr/bin/tar', ['-xzf', '-', '-C', isolatedDir], {
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      let errText = '';
      tarProc.stderr.on('data', (c: Buffer) => {
        errText += c.toString('utf8');
      });
      tarProc.on('error', rejectUnpack);
      tarProc.on('close', code => {
        if (code !== 0) rejectUnpack(new Error(`tar unpack failed (${String(code)}): ${errText}`));
        else resolveUnpack();
      });
      tarProc.stdin.end(bundleTar);
    });
    await mkdir(join(isolatedDir, 'node_modules', '@loopwright'), { recursive: true, mode: 0o755 });
    await cp(join(isolatedDir, 'package-lock.json'), join(isolatedDir, 'node_modules', 'package-lock.json'));
    for (const pkg of WORKSPACE_PACKAGE_NAMES) {
      await symlink(join('..', '..', 'packages', pkg), join(isolatedDir, 'node_modules', '@loopwright', pkg));
    }

    // Also verify Stage B copying a 0o400 sealed file into private scratch with 0o700 executes cleanly!
    const sealedFile = join(isolatedDir, 'sealed-0400.sh');
    const scratchExec = join(isolatedDir, 'scratch-0700.sh');
    await writeFile(sealedFile, '#!/bin/sh\necho "SCRATCH_EXEC_OK"\n', { mode: 0o400 });
    await chmod(sealedFile, 0o400);
    await cp(sealedFile, scratchExec);
    await chmod(scratchExec, 0o700);

    const checkRes = await new Promise<{ code: number | null; stdout: string; stderr: string }>(resolveCheck => {
      const child = execFile(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          'const m = await import("./packages/hardware-runner/dist/index.js"); if (typeof m.runHardwareWorker !== "function" || typeof m.parseWorkerConfigObject !== "function") process.exit(2); process.stdout.write("CLOSURE_IMPORT_OK\\n");',
        ],
        { cwd: isolatedDir, timeout: 15_000 },
        (err, stdout, stderr) => {
          const rawCode = err ? (err as unknown as { code?: number | string }).code : 0;
          const exitCode = typeof rawCode === 'number' ? rawCode : err ? 1 : 0;
          resolveCheck({ code: exitCode, stdout: String(stdout), stderr: String(stderr) });
        },
      );
      void child;
    });
    assert.equal(checkRes.code, 0, `standalone bundle import failed: ${checkRes.stderr}`);
    assert.equal(checkRes.stdout.trim(), 'CLOSURE_IMPORT_OK');
  } finally {
    const restoreWritableTree = async (target: string): Promise<void> => {
      const st = await lstat(target).catch(() => null);
      if (st === null || st.isSymbolicLink()) return;
      if (st.isDirectory()) {
        await chmod(target, 0o700).catch(() => {});
        const entries = await readdir(target).catch(() => []);
        for (const entry of entries) {
          await restoreWritableTree(join(target, entry));
        }
      } else {
        await chmod(target, 0o600).catch(() => {});
      }
    };
    await restoreWritableTree(isolatedDir);
    await rm(isolatedDir, { recursive: true, force: true });
  }
});

test('CUDA live SSH physical probe and remote two-stage Docker GPU execution smoke (skips cleanly when LOOPWRIGHT_CUDA_SSH_HOST is unset)', async t => {
  const rawHost = process.env.LOOPWRIGHT_CUDA_SSH_HOST;
  if (rawHost === undefined || rawHost.trim().length === 0) {
    t.skip('LOOPWRIGHT_CUDA_SSH_HOST is unset; skipping optional live CUDA SSH smoke test');
    return;
  }

  const sshTarget = validateRuntimeSshTarget(rawHost);
  const dockerImage = await resolveRemoteDockerImage(
    sshTarget,
    process.env.LOOPWRIGHT_CUDA_DOCKER_IMAGE,
    ['nvidia/cuda'],
    'nvidia/cuda:12.6.3-devel-ubuntu24.04',
  );

  const values = Array.from({ length: 16 }, () => randomInt(3, 50));
  const expectedSum = values.reduce((acc, v) => acc + v, 0);

  // Stage A emits both a PTX kernel file AND host driver runner into stage-a-out (sealed 0o400 by supervisor).
  // Stage B NEVER executes the 0o400 binary directly: it copies the runner into private Stage B $TMPDIR (0o700)
  // and loads the sealed 0o400 PTX file directly from $LOOPWRIGHT_STAGE_A_OUT via cuModuleLoadData!
  const cudaPtxKernel = [
    '.version 7.0',
    '.target sm_50',
    '.address_size 64',
    '.visible .entry sum_k(.param .u64 in_p, .param .u32 n_p, .param .u64 out_p) {',
    '  .reg .pred %p1; .reg .b32 %i, %n, %acc, %v; .reg .b64 %in, %out, %addr;',
    '  ld.param.u64 %in, [in_p]; ld.param.u32 %n, [n_p]; ld.param.u64 %out, [out_p];',
    '  mov.u32 %i, 0; mov.u32 %acc, 0;',
    'LOOP:',
    '  setp.ge.u32 %p1, %i, %n; @%p1 bra DONE;',
    '  mul.wide.u32 %addr, %i, 4; add.u64 %addr, %in, %addr;',
    '  ld.global.u32 %v, [%addr]; add.u32 %acc, %acc, %v; add.u32 %i, %i, 1; bra LOOP;',
    'DONE:',
    '  st.global.u32 [%out], %acc; ret;',
    '}',
    '',
  ].join('\n');

  const cudaDriverSource = [
    '#include <dlfcn.h>',
    '#include <stdio.h>',
    '#include <stdlib.h>',
    'typedef int CUresult; typedef int CUdevice; typedef void* CUcontext; typedef void* CUmodule; typedef void* CUfunction; typedef unsigned long long CUdeviceptr;',
    '#define CHECK(x) do { if ((x) != 0) return 2; } while (0)',
    'int main(int argc, char** argv) {',
    '  if (argc < 3) return 1;',
    '  FILE* pf = fopen(argv[1], "rb"); if (!pf) return 1;',
    '  char ptx[8192]; size_t plen = fread(ptx, 1, sizeof(ptx) - 1, pf); fclose(pf); ptx[plen] = 0;',
    '  FILE* f = fopen(argv[2], "r"); if (!f) return 1;',
    '  int host[256]; int n = 0; while (n < 256 && fscanf(f, "%d", &host[n]) == 1) n++; fclose(f);',
    '  void* lib = dlopen("libcuda.so.1", RTLD_LAZY); if (!lib) return 3;',
    '  CUresult (*cuInit)(unsigned) = dlsym(lib, "cuInit");',
    '  CUresult (*cuDeviceGetCount)(int*) = dlsym(lib, "cuDeviceGetCount");',
    '  CUresult (*cuDeviceGet)(CUdevice*, int) = dlsym(lib, "cuDeviceGet");',
    '  CUresult (*cuDeviceGetAttribute)(int*, int, CUdevice) = dlsym(lib, "cuDeviceGetAttribute");',
    '  CUresult (*cuCtxCreate)(CUcontext*, unsigned, CUdevice) = dlsym(lib, "cuCtxCreate_v2");',
    '  CUresult (*cuModuleLoadData)(CUmodule*, const void*) = dlsym(lib, "cuModuleLoadData");',
    '  CUresult (*cuModuleGetFunction)(CUfunction*, CUmodule, const char*) = dlsym(lib, "cuModuleGetFunction");',
    '  CUresult (*cuMemAlloc)(CUdeviceptr*, size_t) = dlsym(lib, "cuMemAlloc_v2");',
    '  CUresult (*cuMemcpyHtoD)(CUdeviceptr, const void*, size_t) = dlsym(lib, "cuMemcpyHtoD_v2");',
    '  CUresult (*cuMemcpyDtoH)(void*, CUdeviceptr, size_t) = dlsym(lib, "cuMemcpyDtoH_v2");',
    '  CUresult (*cuLaunchKernel)(CUfunction, unsigned, unsigned, unsigned, unsigned, unsigned, unsigned, unsigned, void*, void**, void**) = dlsym(lib, "cuLaunchKernel");',
    '  CUresult (*cuCtxSynchronize)(void) = dlsym(lib, "cuCtxSynchronize");',
    '  CHECK(cuInit(0)); int devCount = 0; CHECK(cuDeviceGetCount(&devCount)); if (devCount < 1) return 4;',
    '  CUdevice dev = 0; CHECK(cuDeviceGet(&dev, 0));',
    '  int ccMaj = 0, ccMin = 0; CHECK(cuDeviceGetAttribute(&ccMaj, 75, dev)); CHECK(cuDeviceGetAttribute(&ccMin, 76, dev));',
    '  CUcontext ctx = 0; CHECK(cuCtxCreate(&ctx, 0, dev));',
    '  CUmodule mod = 0; CHECK(cuModuleLoadData(&mod, ptx));',
    '  CUfunction fn = 0; CHECK(cuModuleGetFunction(&fn, mod, "sum_k"));',
    '  CUdeviceptr dIn = 0, dOut = 0; CHECK(cuMemAlloc(&dIn, sizeof(int) * n)); CHECK(cuMemAlloc(&dOut, sizeof(int)));',
    '  CHECK(cuMemcpyHtoD(dIn, host, sizeof(int) * n));',
    '  void* params[3] = { &dIn, &n, &dOut };',
    '  CHECK(cuLaunchKernel(fn, 1, 1, 1, 1, 1, 1, 0, 0, params, 0)); CHECK(cuCtxSynchronize());',
    '  int result = 0; CHECK(cuMemcpyDtoH(&result, dOut, sizeof(int)));',
    '  printf("LOOPWRIGHT_STAGE_B_RESULT:{\\"status\\":\\"approved\\",\\"detail\\":\\"arch=sm_%d%d\\",\\"metrics\\":{\\"gpu_sum\\":%d,\\"device_count\\":%d,\\"cc_major\\":%d,\\"cc_minor\\":%d}}\\n", ccMaj, ccMin, result, devCount, ccMaj, ccMin);',
    '  return 0;',
    '}',
  ].join('\n');

  const stageABuild = [
    '#!/bin/sh',
    'set -eu',
    'cp "$LOOPWRIGHT_CANDIDATE_DIR/src/reduce_kernel.ptx" "$LOOPWRIGHT_STAGE_A_OUT/reduce_kernel.ptx"',
    'cc -O2 "$LOOPWRIGHT_CANDIDATE_DIR/src/cuda_reduce.c" -o "$LOOPWRIGHT_STAGE_A_OUT/cuda_reduce" -ldl',
  ].join('\n');

  const stageBEval = [
    '#!/bin/sh',
    'set -eu',
    'cp "$LOOPWRIGHT_STAGE_A_OUT/cuda_reduce" "$TMPDIR/cuda_reduce"',
    'chmod 0700 "$TMPDIR/cuda_reduce"',
    '"$TMPDIR/cuda_reduce" "$LOOPWRIGHT_STAGE_A_OUT/reduce_kernel.ptx" "$LOOPWRIGHT_HELD_OUT_WORKLOAD_DIR/inputs.txt"',
  ].join('\n');

  const { verdict, pinnedArch } = await executeRemoteDockerBenchmarkSmoke({
    sshTarget,
    vendor: 'nvidia',
    dockerImage,
    workloadId: 'cuda-live-smoke',
    stageAFiles: [
      { name: 'scripts/build.sh', content: stageABuild, mode: '100755' },
      { name: 'src/cuda_reduce.c', content: cudaDriverSource, mode: '100644' },
      { name: 'src/reduce_kernel.ptx', content: cudaPtxKernel, mode: '100644' },
    ],
    heldOutInputValues: values,
    stageBWorkloadScript: stageBEval,
    expectedSum,
    fallbackCapAccel: 'sm_89',
    ...(process.env.LOOPWRIGHT_CUDA_EXPECTED_ARCH !== undefined
      ? { explicitExpectedArch: process.env.LOOPWRIGHT_CUDA_EXPECTED_ARCH }
      : {}),
  });

  // Verify the physical GPU device executed inside Stage B Docker matches the pinned provenance architecture!
  const measuredBaseArch = `sm_${String(verdict.metrics?.cc_major ?? '')}${String(verdict.metrics?.cc_minor ?? '')}`;
  const strippedPinned = pinnedArch.replace(/a$/, '');
  assert.equal(measuredBaseArch, strippedPinned);
  assert.match(verdict.hardwareProvenance?.accelerator ?? '', PINNED_CUDA_ARCH_RE);
});

test('ROCm live SSH physical probe and remote two-stage Docker GPU execution smoke (skips cleanly when LOOPWRIGHT_ROCM_SSH_HOST is unset)', async t => {
  const rawHost = process.env.LOOPWRIGHT_ROCM_SSH_HOST;
  if (rawHost === undefined || rawHost.trim().length === 0) {
    t.skip('LOOPWRIGHT_ROCM_SSH_HOST is unset; skipping optional live ROCm SSH smoke test');
    return;
  }

  const sshTarget = validateRuntimeSshTarget(rawHost);
  const dockerImage = await resolveRemoteDockerImage(
    sshTarget,
    process.env.LOOPWRIGHT_ROCM_DOCKER_IMAGE,
    ['rocm/dev', 'rocm/pytorch', 'rocm/'],
    'rocm/dev-ubuntu-24.04:6.2.4',
  );

  const values = Array.from({ length: 16 }, () => randomInt(3, 50));
  const expectedSum = values.reduce((acc, v) => acc + v, 0);

  // Stage A compiles a real HIP GPU reduction program; Stage B copies the sealed 0o400 binary into
  // private Stage B $TMPDIR with 0o700 and verifies the in-container GPU gcnArchName matches pinnedArch!
  const hipKernelSource = [
    '#include <hip/hip_runtime.h>',
    '#include <stdio.h>',
    '#include <string.h>',
    '__global__ void sum_kernel(const int* in, int n, int* out) {',
    '  int acc = 0;',
    '  for (int i = 0; i < n; ++i) acc += in[i];',
    '  *out = acc;',
    '}',
    '#define HIP_CHECK(x) do { if ((x) != hipSuccess) return 2; } while (0)',
    'int main(int argc, char** argv) {',
    '  if (argc < 2) return 1;',
    '  FILE* f = fopen(argv[1], "r"); if (!f) return 1;',
    '  int host[256]; int n = 0; while (n < 256 && fscanf(f, "%d", &host[n]) == 1) n++; fclose(f);',
    '  int devCount = 0; HIP_CHECK(hipGetDeviceCount(&devCount)); if (devCount < 1) return 3;',
    '  hipDeviceProp_t prop; HIP_CHECK(hipGetDeviceProperties(&prop, 0));',
    '  char arch[64]; strncpy(arch, prop.gcnArchName, sizeof(arch) - 1); arch[sizeof(arch) - 1] = 0;',
    '  char* colon = strchr(arch, \':\'); if (colon) *colon = 0;',
    '  int *dIn = nullptr, *dOut = nullptr;',
    '  HIP_CHECK(hipMalloc(&dIn, sizeof(int) * n)); HIP_CHECK(hipMalloc(&dOut, sizeof(int)));',
    '  HIP_CHECK(hipMemcpy(dIn, host, sizeof(int) * n, hipMemcpyHostToDevice));',
    '  hipLaunchKernelGGL(sum_kernel, dim3(1), dim3(1), 0, 0, dIn, n, dOut);',
    '  HIP_CHECK(hipDeviceSynchronize());',
    '  int result = 0; HIP_CHECK(hipMemcpy(&result, dOut, sizeof(int), hipMemcpyDeviceToHost));',
    '  printf("LOOPWRIGHT_STAGE_B_RESULT:{\\"status\\":\\"approved\\",\\"detail\\":\\"arch=%s\\",\\"metrics\\":{\\"gpu_sum\\":%d,\\"device_count\\":%d}}\\n", arch, result, devCount);',
    '  return 0;',
    '}',
  ].join('\n');

  const stageABuild = [
    '#!/bin/sh',
    'set -eu',
    'hipcc -O2 "$LOOPWRIGHT_CANDIDATE_DIR/src/hip_reduce.cpp" -o "$LOOPWRIGHT_STAGE_A_OUT/hip_reduce"',
  ].join('\n');

  const stageBEval = [
    '#!/bin/sh',
    'set -eu',
    'cp "$LOOPWRIGHT_STAGE_A_OUT/hip_reduce" "$TMPDIR/hip_reduce"',
    'chmod 0700 "$TMPDIR/hip_reduce"',
    '"$TMPDIR/hip_reduce" "$LOOPWRIGHT_HELD_OUT_WORKLOAD_DIR/inputs.txt"',
  ].join('\n');

  const { verdict, pinnedArch } = await executeRemoteDockerBenchmarkSmoke({
    sshTarget,
    vendor: 'amd',
    dockerImage,
    workloadId: 'rocm-live-smoke',
    stageAFiles: [
      { name: 'scripts/build.sh', content: stageABuild, mode: '100755' },
      { name: 'src/hip_reduce.cpp', content: hipKernelSource, mode: '100644' },
    ],
    heldOutInputValues: values,
    stageBWorkloadScript: stageBEval,
    expectedSum,
    fallbackCapAccel: 'gfx1101',
    ...(process.env.LOOPWRIGHT_ROCM_EXPECTED_ARCH !== undefined
      ? { explicitExpectedArch: process.env.LOOPWRIGHT_ROCM_EXPECTED_ARCH }
      : {}),
  });

  assert.equal(verdict.detail, `arch=${pinnedArch}`);
  assert.match(verdict.hardwareProvenance?.accelerator ?? '', PINNED_ROCM_ARCH_RE);
});
