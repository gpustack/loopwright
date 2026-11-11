# Specification: Native macOS Seatbelt and Linux Bubblewrap OS Sandbox Execution Backends

- **Status**: Shipped
- **Date**: 2026-11-11
- **Owner**: `@loopwright/github-app`, `@loopwright/taskpack-runner`, `@loopwright/cli`
- **Target Branch**: `spec/s12-os-sandbox-backends`

---

## 1. Motivation & Problem Statement

Loopwright originally isolated model-invoked tools and local workspace MCP processes exclusively through a digest-pinned Linux `arm64` Docker container profile (`packages/agent-pi/src/runtime-profile.ts` and `packages/agent-pi/src/containers.ts`). While container isolation remains supported for local Docker qualification, requiring a Docker daemon in every execution environment has two operational drawbacks:

1. **Container-in-container & dedicated-host friction**: In GitHub Actions runners, Kubernetes GPU Pods, or dedicated macOS/Linux build hosts, requiring a nested Docker daemon (`Docker-in-Docker`) introduces privileged daemon risk or unnecessary VM overhead.
2. **Parity with modern agentic CLI sandboxes (Claude Code & OpenAI Codex CLI)**: On macOS and Linux, lightweight kernel-enforced OS sandboxes — macOS Seatbelt (`/usr/bin/sandbox-exec` with Sandbox Profile Language, SBPL) and Linux Bubblewrap (`bwrap` unprivileged user/mount/PID/IPC/UTS/net namespaces + `--die-with-parent` + `seccomp` BPF syscall filtering) — enforce strict filesystem read/write containment, protected-path read-only masking, and network isolation without any daemon or container image pull.

This specification defines a first-class, fail-closed OS Sandbox Execution Backend architecture in `@loopwright/github-app` (`packages/github-app/src/sandbox.ts`), integrates optional OS sandbox wrapping into `@loopwright/taskpack-runner` (`packages/taskpack-runner/src/python-bridge.ts`), wires capability and failure-matrix verification into `@loopwright/cli` (`packages/cli/src/closure.ts` and `packages/cli/src/failure-matrix.ts`), and documents the sandbox backends across `docs/` and `site/` without modifying the frozen `packages/{core,state,agent-pi,controller}` source trees.

---

## 2. Goals & Non-Goals

### 2.1 Goals

1. **Multi-Backend Sandbox Model (`macos-seatbelt`, `linux-bwrap`, `linux-landlock`, `docker`, `direct-dedicated`)**:
   - Define a unified sandbox policy, capability model, and execution contract in `@loopwright/github-app` (`packages/github-app/src/sandbox.ts` and `packages/github-app/src/types.ts`).
   - Support declarative `sandbox` configuration in `.loopwright/taskpack.yaml` (`packages/github-app/src/schema.ts` and `packages/github-app/src/taskpack.ts`).
2. **macOS Seatbelt Backend (`macos-seatbelt` via `/usr/bin/sandbox-exec`)**:
   - Deterministically compile canonical SBPL profiles (`compileMacosSeatbeltProfile`) that:
     - Resolve all paths with `realpath` (or parent `realpath` for non-existent protected target paths) so macOS `/tmp -> /private/tmp` and `/var -> /private/var` symlinks never bypass rules.
     - Deny reading sensitive host credential/state directories (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.config/gh`, parent `.loopwright` state/vault directories, and caller-specified `deniedReadPaths`).
     - Deny all filesystem writes globally (`(deny file-write*)`), allow writes only to canonicalized `writablePaths` (candidate workspace and scratch directories) plus safe device nodes (`/dev/null`, `/dev/zero`, `/dev/dtracehelper`), and **re-deny** writes to `PROTECTED_AUTOMATION_PATHS` and repository-protected paths (`.git`, `.github`, `.loopwright`, `.claude`, `.agents`, `AGENTS.md`, `CLAUDE.md`, plus manifest `scope.protected`) even when nested inside a writable workspace root.
     - Enforce network isolation (`networkMode: 'none' | 'loopback-only' | 'allow-outbound'`): `'none'` emits `(deny network*)`; `'loopback-only'` denies general network access and permits only local loopback (`localhost:*` / `127.0.0.1` / `::1`).
   - Execute real sandboxed commands on macOS via `/usr/bin/sandbox-exec -p <profile> -- <command> <args...>` (`executeSandboxedCommand`) with secret-scrubbed output, sanitized environment variables, bounded stdout/stderr streams, timeout enforcement, and process cleanup.
3. **Linux Bubblewrap + Seccomp Backend (`linux-bwrap` via `bwrap`)**:
   - Deterministically synthesize `bwrap` command-line arguments and seccomp rules (`compileLinuxBwrapCommand`) that:
     - Isolate namespaces with `--unshare-all` (user, mount, PID, IPC, UTS, cgroup, and network when `networkMode !== 'allow-outbound'`), `--die-with-parent`, and `--new-session`.
     - Bind-mount `/` read-only (`--ro-bind / /`), mount fresh `--proc /proc` and `--dev /dev`, mask sensitive host credential/state paths with `--tmpfs` or `--ro-bind /dev/null`, bind-mount approved `writablePaths` read-write (`--bind <path> <path>`), and **re-mask** protected paths (`.git`, `.github`, `.loopwright`, `.claude`, `.agents`, `AGENTS.md`, `CLAUDE.md`, plus manifest `scope.protected`) read-only (`--ro-bind <path> <path>`) on top of the writable workspace mount.
     - Bind a canonical seccomp syscall filter descriptor (`computeSandboxSeccompProfile`) blocking dangerous kernel surface (`ptrace`, `kexec_load`, `kexec_file_load`, `mount`, `umount2`, `pivot_root`, `bpf`, `perf_event_open`, `userfaultfd`, `keyctl`, `add_key`, `request_key`, `io_uring_setup`, `io_uring_enter`, `io_uring_register`).
4. **Fail-Closed Capability Negotiation (`negotiateSandboxBackend`)**:
   - Each backend reports its verified isolation capabilities (`filesystemReadContainment`, `filesystemWriteContainment`, `protectedPathReadOnlyMask`, `networkIsolation`, `processTreeCleanup`, `syscallFiltering`).
   - If a task requires isolation capabilities that the selected or available host backend cannot satisfy — or if the required OS binary (`/usr/bin/sandbox-exec` on `darwin` or `bwrap` on `linux`) is missing or outside trusted system directories — `negotiateSandboxBackend` and `executeSandboxedCommand` fail closed with `SANDBOX_BACKEND_UNAVAILABLE`, `SANDBOX_CAPABILITY_INSUFFICIENT`, or `SANDBOX_POLICY_INVALID`. Silent fallback to unsandboxed execution is strictly forbidden.
   - `direct-dedicated` is accepted only when `requiredCapabilities` is empty or `allowDedicatedDirectOverride: true` is explicitly provided by the host operator.
5. **`@loopwright/taskpack-runner`, `@loopwright/cli`, and Documentation Integration**:
   - Extend `PythonBridge` in `packages/taskpack-runner/src/python-bridge.ts` with optional OS sandbox wrapping (`sandbox?: PythonSandboxOptions`) so Python subprocesses on macOS can run inside `/usr/bin/sandbox-exec` SBPL containment in addition to `SITE_GUARD_CODE`.
   - Update `packages/cli/src/closure.ts` (`qualified-host-clock-and-storage-profile` evidence paths) and `packages/cli/src/failure-matrix.ts` (Scenario 13 `untrusted_taskpack_and_oauth_boundary_refusal`) to verify OS sandbox compilation, protected-path write denial, and fail-closed capability negotiation.
   - Document the OS sandbox backends and `.loopwright/taskpack.yaml` `sandbox:` schema across `docs/github-app.md`, `docs/operate/github-action.md`, `docs/operate/github-app.md`, `docs/walkthroughs/declarative-taskpack.md`, and `docs/README.md`, keeping `npm run lint:docs` and `npm run site` green (`0` errors).

### 2.2 Non-Goals

- Modifying any file under `packages/core`, `packages/state`, `packages/agent-pi`, or `packages/controller` (their qualification source manifests remain frozen).
- Installing privileged kernel modules, loading root-only AppArmor profiles, or starting Docker containers during unit tests.
- Silently downgrading a sandboxed task to unsandboxed host execution when `sandbox-exec` or `bwrap` is unavailable.

---

## 3. Detailed Design

### 3.1 Error Codes & Types in `@loopwright/github-app` (`packages/github-app/src/types.ts`)

Extend `GITHUB_APP_ERROR_CODES` with:
- `'SANDBOX_POLICY_INVALID'`
- `'SANDBOX_BACKEND_UNAVAILABLE'`
- `'SANDBOX_CAPABILITY_INSUFFICIENT'`
- `'SANDBOX_EXECUTION_FAILED'`

Define the following exported types in `packages/github-app/src/types.ts`:

```ts
export type SandboxBackendId = 'macos-seatbelt' | 'linux-bwrap' | 'linux-landlock' | 'docker' | 'direct-dedicated';
export type SandboxNetworkMode = 'none' | 'loopback-only' | 'allow-outbound';
export type SandboxCapability =
  | 'filesystemReadContainment'
  | 'filesystemWriteContainment'
  | 'protectedPathReadOnlyMask'
  | 'networkIsolation'
  | 'processTreeCleanup'
  | 'syscallFiltering';

export interface TaskpackSandboxDeclaration {
  readonly preferredBackends?: readonly SandboxBackendId[] | undefined;
  readonly networkMode?: SandboxNetworkMode | undefined;
  readonly requiredCapabilities?: readonly SandboxCapability[] | undefined;
  readonly deniedReadPaths?: readonly string[] | undefined;
}

export interface SandboxPolicyInput {
  readonly workspaceRoot: string;
  readonly writablePaths: readonly string[];
  readonly protectedPaths?: readonly string[] | undefined;
  readonly deniedReadPaths?: readonly string[] | undefined;
  readonly scratchDirectory?: string | undefined;
  readonly networkMode?: SandboxNetworkMode | undefined;
  readonly requiredCapabilities?: readonly SandboxCapability[] | undefined;
  readonly preferredBackends?: readonly SandboxBackendId[] | undefined;
  readonly allowDedicatedDirectOverride?: boolean | undefined;
}

export interface SandboxHostEnvironment {
  readonly platform: 'darwin' | 'linux' | string;
  readonly arch: 'arm64' | 'x64' | string;
  readonly homeDirectory?: string | undefined;
  readonly seatbeltExecutable?: string | undefined;
  readonly bwrapExecutable?: string | undefined;
  readonly dockerExecutable?: string | undefined;
  readonly dockerSocket?: string | undefined;
  readonly probeExecutables?: boolean | undefined;
}

export interface NegotiatedSandboxBackend {
  readonly backendId: SandboxBackendId;
  readonly executablePath: string | null;
  readonly capabilities: readonly SandboxCapability[];
  readonly networkMode: SandboxNetworkMode;
  readonly profileDigest: Digest;
}

export interface CompiledMacosSeatbeltProfile {
  readonly backendId: 'macos-seatbelt';
  readonly executablePath: string;
  readonly profileText: string;
  readonly profileDigest: Digest;
  readonly canonicalWorkspaceRoot: string;
  readonly canonicalWritablePaths: readonly string[];
  readonly canonicalProtectedPaths: readonly string[];
  readonly canonicalDeniedReadPaths: readonly string[];
  readonly networkMode: SandboxNetworkMode;
}

export interface CompiledLinuxBwrapCommand {
  readonly backendId: 'linux-bwrap';
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly seccompProfileJson: string;
  readonly seccompDigest: Digest;
  readonly profileDigest: Digest;
  readonly canonicalWorkspaceRoot: string;
  readonly canonicalWritablePaths: readonly string[];
  readonly canonicalProtectedPaths: readonly string[];
  readonly canonicalDeniedReadPaths: readonly string[];
  readonly networkMode: SandboxNetworkMode;
}

export interface SandboxedCommandInput {
  readonly policy: SandboxPolicyInput;
  readonly host?: SandboxHostEnvironment | undefined;
  readonly command: string;
  readonly args?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly stdin?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
  readonly secretsToScrub?: readonly string[] | undefined;
}

export interface SandboxedCommandResult {
  readonly backendId: SandboxBackendId;
  readonly profileDigest: Digest;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
}
```

### 3.2 Sandbox Module (`packages/github-app/src/sandbox.ts`)

1. **Constants & Trusted Binary Allowlists**:
   - `TRUSTED_SEATBELT_PATHS = Object.freeze(['/usr/bin/sandbox-exec'])`
   - `TRUSTED_BWRAP_PATHS = Object.freeze(['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap'])`
   - `DEFAULT_DENIED_HOME_SUBPATHS = Object.freeze(['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.config/gh', '.npmrc', '.pypirc', '.netrc'])`
   - `ALWAYS_PROTECTED_WORKSPACE_SUBPATHS = Object.freeze(['.git', '.github', '.loopwright', '.claude', '.agents', 'AGENTS.md', 'CLAUDE.md'])`
   - `SANDBOX_CAPABILITIES_BY_BACKEND`:
     - `'macos-seatbelt'`: `['filesystemReadContainment', 'filesystemWriteContainment', 'protectedPathReadOnlyMask', 'networkIsolation', 'processTreeCleanup']`
     - `'linux-bwrap'`: `['filesystemReadContainment', 'filesystemWriteContainment', 'protectedPathReadOnlyMask', 'networkIsolation', 'processTreeCleanup', 'syscallFiltering']`
     - `'docker'`: `['filesystemReadContainment', 'filesystemWriteContainment', 'protectedPathReadOnlyMask', 'networkIsolation', 'processTreeCleanup', 'syscallFiltering']`
     - `'direct-dedicated'`: `['processTreeCleanup']`

2. **Canonical Path Resolution & Containment Validation**:
   - `workspaceRoot` must be an existing directory on disk (or an absolute path when compiling offline profiles; when existing on disk, resolve via `realpath`). Reject any path containing `\0`, `\r`, `\n`, or `"` (which could break SBPL quoting) with `GitHubAppError('SANDBOX_POLICY_INVALID', ...)`.
   - Every relative entry in `writablePaths` and `protectedPaths` is normalized with `normalizeRelativePath` and resolved inside `canonicalWorkspaceRoot`. Any `writablePath` that escapes `canonicalWorkspaceRoot` (unless it is the explicit `scratchDirectory`) or targets a protected automation path is rejected with `GitHubAppError('SANDBOX_POLICY_INVALID', ...)`.
   - Protected paths always include `ALWAYS_PROTECTED_WORKSPACE_SUBPATHS` (`['.git', '.github', '.loopwright', '.claude', '.agents', 'AGENTS.md', 'CLAUDE.md']`) merged with `policy.protectedPaths`. When a protected subpath does not exist yet on disk, resolve its existing ancestor with `realpath` and append the normalized relative suffix so Seatbelt/Bubblewrap rules still cover the exact canonical path inside `/private/var/...` or `/private/tmp/...`.

3. **macOS Seatbelt Profile Compiler (`compileMacosSeatbeltProfile`)**:
   - Produces deterministic SBPL (`(version 1)`) in exact precedence order:
     1. `(version 1)`
     2. `(allow default)`
     3. Read-denial rules: `(deny file-read* (subpath "<deniedPath>") ...)` for every entry in `canonicalDeniedReadPaths` (derived from `homeDirectory` + `DEFAULT_DENIED_HOME_SUBPATHS` and `policy.deniedReadPaths`, excluding any ancestor of `canonicalWorkspaceRoot` or `scratchDirectory` so temp workspaces under `$HOME` remain readable). Note: only `(deny file-read-data ...)` or `(deny file-read* ...)` on specific non-ancestor leaf credential directories is emitted so directory traversal (`stat` on parent directories) to the workspace is never broken.
     4. Global write denial: `(deny file-write*)`
     5. Explicit write allowlist: `(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (subpath "<writablePath>") ...)` for each canonical writable path and optional `scratchDirectory`.
     6. Protected-path write re-denial (placed **after** the write allowlist so XNU Seatbelt last-match-wins precedence blocks writes to protected paths inside writable directories): `(deny file-write* (subpath "<protectedPath>") ...)` for every canonical protected path.
     7. Network rules:
        - `networkMode === 'none'`: `(deny network*)`
        - `networkMode === 'loopback-only'`:
          ```scheme
          (deny network*)
          (allow network-outbound (remote ip "localhost:*"))
          (allow network-inbound (local ip "localhost:*"))
          (allow network-bind (local ip "localhost:*"))
          ```
        - `networkMode === 'allow-outbound'`: no `(deny network*)` clause.
   - Computes `profileDigest` (`sha256` over `'loopwright.dev/sandbox-seatbelt/v1\0' + profileText`).

4. **Linux Bubblewrap + Seccomp Compiler (`compileLinuxBwrapCommand`)**:
   - Validates `bwrapExecutable` against `TRUSTED_BWRAP_PATHS` and builds deterministic arguments:
     - `--unshare-all` (plus `--share-net` only when `networkMode === 'allow-outbound'`; for `'none'` and `'loopback-only'`, the unshared network namespace provides an isolated loopback interface with zero external interfaces).
     - `--die-with-parent`, `--new-session`
     - `--ro-bind / /`, `--proc /proc`, `--dev /dev`, `--tmpfs /tmp`
     - For each canonical denied read path: `--tmpfs <deniedPath>`
     - For each canonical writable path (and optional `scratchDirectory`): `--bind <writablePath> <writablePath>`
     - For each canonical protected path: `--ro-bind-try <protectedPath> <protectedPath>` (placed **after** `--bind` so the kernel mount table masks protected paths read-only inside writable mounts).
     - `--chdir <cwd || canonicalWorkspaceRoot>`
     - `--clearenv` plus deterministic `--setenv` bindings for safe environment keys (`PATH`, `HOME`, `LANG`, `TERM`, plus caller-supplied sanitized `env`).
   - Synthesizes `seccompProfileJson` via `computeSandboxSeccompProfile()` (`defaultAction: 'SCMP_ACT_ALLOW'`, blocking `ptrace`, `kexec_load`, `kexec_file_load`, `mount`, `umount2`, `pivot_root`, `bpf`, `perf_event_open`, `userfaultfd`, `keyctl`, `add_key`, `request_key`, `io_uring_setup`, `io_uring_enter`, `io_uring_register` with `SCMP_ACT_ERRNO`), and computes `seccompDigest` and `profileDigest`.

5. **Fail-Closed Backend Negotiation (`negotiateSandboxBackend`)**:
   - Default `requiredCapabilities` when omitted: `['filesystemReadContainment', 'filesystemWriteContainment', 'protectedPathReadOnlyMask', 'networkIsolation', 'processTreeCleanup']`.
   - Default `preferredBackends` when omitted:
     - On `darwin`: `['macos-seatbelt', 'docker']`
     - On `linux`: `['linux-bwrap', 'docker']`
   - Evaluates candidate backends in `preferredBackends` order:
     - Checks platform compatibility (`macos-seatbelt` requires `platform === 'darwin'`; `linux-bwrap` requires `platform === 'linux'`).
     - Checks executable path against trusted paths and (when `probeExecutables !== false`) verifies the binary exists and is a regular executable file on disk.
     - Checks that every capability in `requiredCapabilities` is supported by the candidate backend (or for `direct-dedicated`, requires `allowDedicatedDirectOverride === true`).
   - If a candidate satisfies all checks, returns `NegotiatedSandboxBackend`.
   - Otherwise throws `GitHubAppError`:
     - `'SANDBOX_CAPABILITY_INSUFFICIENT'` if a candidate backend is reachable on the platform (or `direct-dedicated` was requested without override) but lacks one or more `requiredCapabilities`.
     - `'SANDBOX_BACKEND_UNAVAILABLE'` if no candidate backend is compatible and present on the host.

6. **Real Sandboxed Execution (`executeSandboxedCommand`)**:
   - Negotiates the backend via `negotiateSandboxBackend(input.policy, input.host)`.
   - On `macos-seatbelt`, compiles the SBPL profile via `compileMacosSeatbeltProfile` and spawns `/usr/bin/sandbox-exec -p <profileText> -- <command> <args...>`.
   - Enforces `timeoutMs` (default `30_000`, max `300_000`) and `maxOutputBytes` (default `1_048_576`), killing the child on timeout or overflow, scrubbing any `secretsToScrub` via `SecretScrubber`, and returning `SandboxedCommandResult`.

### 3.3 Declarative `.loopwright/taskpack.yaml` Schema (`packages/github-app/src/schema.ts` & `taskpack.ts`)

- Allow optional `spec.sandbox` in `TaskpackManifest`:
  - `preferredBackends`: array of `1..5` unique `SandboxBackendId` values (`'macos-seatbelt' | 'linux-bwrap' | 'linux-landlock' | 'docker' | 'direct-dedicated'`).
  - `networkMode`: `'none' | 'loopback-only' | 'allow-outbound'` (default `'none'`).
  - `requiredCapabilities`: array of unique `SandboxCapability` values.
  - `deniedReadPaths`: array of relative or `~/` paths (rejecting `..` traversal).
- Existing `.loopwright/taskpack.yaml` manifests without `spec.sandbox` remain 100% valid and default to standard fail-closed sandbox settings when compiled or executed.

### 3.4 `PythonBridge` Sandbox Integration (`packages/taskpack-runner/src/python-bridge.ts`)

- Extend `PythonBridgeOptions` and `PythonRunOptions` with optional `sandbox?: { readonly enabled: boolean; readonly writablePaths?: readonly string[]; readonly protectedPaths?: readonly string[]; readonly networkMode?: 'none' | 'loopback-only' }`.
- When `sandbox.enabled === true` on `darwin` (where `/usr/bin/sandbox-exec` is available), `PythonBridge` wraps the spawned Python subprocess with `/usr/bin/sandbox-exec -p <profile> -- <pythonExecutable> ...` so kernel-level Seatbelt write/network containment enforces the boundary alongside the in-process `SITE_GUARD_CODE` audit hook.

---

## 4. Acceptance Criteria

- **`AC-1` (macOS Seatbelt Compiler & Real XNU Kernel Execution)**:
  - `compileMacosSeatbeltProfile` generates deterministic SBPL profiles with `realpath` normalization, credential-path read denial, global `(deny file-write*)`, explicit writable subpath grants, subsequent protected-path `(deny file-write*)` overrides, and network mode rules (`none`, `loopback-only`, `allow-outbound`).
  - On macOS (`darwin`), `executeSandboxedCommand` runs real `/usr/bin/sandbox-exec` subprocesses and proves:
    1. Writing to an approved writable path inside the workspace succeeds (`exitCode === 0`).
    2. Writing outside the workspace (e.g. `/private/tmp/...`) fails (`exitCode !== 0`, file not created).
    3. Writing to or creating `.git/config`, `.github/workflows/ci.yml`, or `AGENTS.md` inside the writable workspace is blocked by the kernel (`exitCode !== 0`, file not created/modified).
    4. Reading a denied credential path (`deniedReadPaths`) is blocked by the kernel (`exitCode !== 0`).
- **`AC-2` (Linux Bubblewrap + Seccomp Compiler & Mount-Order Verification)**:
  - `compileLinuxBwrapCommand` generates deterministic `bwrap` arguments with `--unshare-all`, `--die-with-parent`, `--new-session`, `--ro-bind / /`, `--tmpfs` masks over denied credential paths, `--bind` for writable paths, and subsequent `--ro-bind-try` read-only masks for all protected paths (`.git`, `.github`, `.loopwright`, `.claude`, `.agents`, `AGENTS.md`, `CLAUDE.md`, and custom `protectedPaths`).
  - `computeSandboxSeccompProfile` produces a canonical seccomp BPF JSON profile blocking dangerous kernel syscalls.
- **`AC-3` (Fail-Closed Capability Negotiation & Declarative Taskpack Support)**:
  - `negotiateSandboxBackend` refuses incompatible platforms, untrusted/missing sandbox binaries (`SANDBOX_BACKEND_UNAVAILABLE`), and backends that lack required capabilities such as `syscallFiltering` on macOS Seatbelt or `filesystemWriteContainment` on `direct-dedicated` without `allowDedicatedDirectOverride: true` (`SANDBOX_CAPABILITY_INSUFFICIENT`).
  - `parseTaskpackDocument` / `validateTaskpackManifest` validates optional `spec.sandbox` blocks in `.loopwright/taskpack.yaml` and rejects invalid backend names, duplicate entries, or unsafe paths with `TASKPACK_MANIFEST_INVALID`.
- **`AC-4` (`PythonBridge`, Closure Matrix, Failure Matrix, and Connected Docs/Site)**:
  - `PythonBridge` in `@loopwright/taskpack-runner` supports optional `sandbox: { enabled: true }` execution on macOS.
  - `CLOSURE_CAPABILITY_LEDGER` (`qualified-host-clock-and-storage-profile`) and `runIntegratedFailureMatrix` (Scenario 13 `untrusted_taskpack_and_oauth_boundary_refusal`) include OS sandbox evidence and assertions while preserving all 23 ledger rows and 14 failure scenarios.
  - `docs/README.md`, `docs/github-app.md`, `docs/operate/github-action.md`, `docs/operate/github-app.md`, and `docs/walkthroughs/declarative-taskpack.md` document the native OS sandbox backends, and `npm run lint:docs`, `npm run site`, `npm run build`, `npm run typecheck`, `npm run lint`, and `npm test` pass with zero errors.

---

## 5. Implementation Plan

### 5.1 Commands & Environment

Environment: local developer workstation or CI host (POSIX shell, Node `26.x`, npm `11.x` per root `engines`). Build, typecheck, lint, docs lint, Hugo site generation, and unit/integration suites require no Docker daemon, no cloud credentials, and no external network access. On `darwin`, `executeSandboxedCommand` and `PythonBridge` Seatbelt tests invoke `/usr/bin/sandbox-exec` directly against the XNU Seatbelt policy engine in temporary directories under `os.tmpdir()`.

```bash
npm run build
npm run typecheck
npm run lint
npm run lint:docs
npm run site
npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-build/packages/github-app/test/*.test.js .test-build/packages/taskpack-runner/test/*.test.js .test-build/packages/cli/test/*.test.js
npm test
```

### 5.2 Project Structure & Touch Set

`packages/core`, `packages/state`, `packages/agent-pi`, and `packages/controller` remain completely untouched so their qualification source manifests stay frozen. All changes are confined to `@loopwright/github-app`, `@loopwright/taskpack-runner`, `@loopwright/cli`, and `docs/`:

```text
packages/github-app/
  src/
    types.ts                                  # Adds SANDBOX_* error codes and sandbox policy/compiler/execution interfaces
    schema.ts                                 # Validates optional spec.sandbox in TaskpackManifest
    sandbox.ts                                # New module: Seatbelt SBPL compiler, Bubblewrap + seccomp compiler, capability negotiation, and execution
    index.ts                                  # Re-exports sandbox constants, types, and functions
  test/
    sandbox.test.ts                           # New suite: Seatbelt compiler + real XNU execution, Bubblewrap + seccomp compiler, fail-closed negotiation
    taskpack-intake.test.ts                   # Extended with spec.sandbox manifest validation cases
packages/taskpack-runner/
  src/
    python-bridge.ts                          # Adds PythonSandboxOptions and optional macOS /usr/bin/sandbox-exec wrapping
    index.ts                                  # Re-exports PythonSandboxOptions
  test/
    python-bridge.test.ts                     # Extended with macOS Seatbelt-wrapped Python execution and write-containment tests
packages/cli/
  src/
    closure.ts                                # Adds sandbox.ts and sandbox.test.ts to qualified-host-clock-and-storage-profile evidencePaths
    failure-matrix.ts                         # Extends Scenario 13 with negotiateSandboxBackend, compileMacosSeatbeltProfile, and compileLinuxBwrapCommand
  test/
    closure-and-failure-matrix.test.ts        # Verifies 23-row ledger integrity and 14-scenario failure matrix with sandbox assertions
docs/
  README.md                                   # Adds this spec to ## Specs and ### GitHub App and Action Control Plane while keeping 21 pages
  github-app.md                               # Documents src/sandbox.ts, spec.sandbox, and OS sandbox backends
  operate/github-action.md                    # Documents OS sandbox backend negotiation in Action runs
  operate/github-app.md                       # Documents OS sandbox host requirements (/usr/bin/sandbox-exec, bwrap)
  walkthroughs/declarative-taskpack.md        # Documents optional spec.sandbox manifest block
```

### 5.3 Code Style & Risks

- **Strict TypeScript (`ES2023`, `NodeNext`, `strict: true`, `exactOptionalPropertyTypes: true`, `noUncheckedIndexedAccess: true`)**: Use `readonly` properties, `Object.freeze` on exported constants and returned descriptors, explicit `.js` import specifiers, and zero `any`.
- **Risk: macOS `/tmp` -> `/private/tmp` and `/var` -> `/private/var` symlinks bypass Seatbelt `subpath` filters if paths are not canonicalized.** -> **Mitigation:** Resolve `workspaceRoot` and existing paths with `realpath`, and for non-existent target/protected paths resolve the nearest existing ancestor with `realpath` and join the normalized relative suffix before emitting SBPL or `bwrap` rules.
- **Risk: Protected repository paths (`.git`, `.github`, `.loopwright`, `.claude`, `.agents`, `AGENTS.md`, `CLAUDE.md`) nested inside a writable workspace root could be modified by a sandboxed command.** -> **Mitigation:** In `compileMacosSeatbeltProfile`, emit `(deny file-write* (subpath ...))` for all canonical protected paths **after** `(allow file-write* ...)` so XNU Seatbelt last-match-wins precedence blocks writes. In `compileLinuxBwrapCommand`, emit `--ro-bind-try <protectedPath> <protectedPath>` **after** `--bind <writablePath> <writablePath>` so the Linux mount table masks protected paths read-only.
- **Risk: Circular workspace dependency between `@loopwright/taskpack-runner` and `@loopwright/github-app`.** -> **Mitigation:** `@loopwright/taskpack-runner` builds before `@loopwright/github-app` in root `package.json` and does not depend on `@loopwright/github-app`; `PythonBridge` in `packages/taskpack-runner/src/python-bridge.ts` synthesizes its focused Seatbelt profile directly with `node:` built-ins without altering package dependency edges or root build order.

### 5.4 Task DAG (`T1`–`T4`)

`T1` and `T3` have disjoint `Owns:` sets and no dependency edge between them; `T2` depends on `T1` (`schema.ts` and `taskpack-intake.test.ts` consume the `TaskpackSandboxDeclaration` types from `T1`); `T4` depends on `T1`, `T2`, and `T3` to wire the closure ledger evidence paths, Scenario 13 failure-matrix assertions, and connected documentation.

- [x] **T1 · Native macOS Seatbelt and Linux Bubblewrap sandbox module, types, and unit/kernel tests (`AC-1`, `AC-2`, `AC-3`)**
      Blocked by: None
      Owns: `packages/github-app/src/types.ts`, `packages/github-app/src/sandbox.ts`, `packages/github-app/src/index.ts`, `packages/github-app/test/sandbox.test.ts`
      Gate: review
      Acceptance: `packages/github-app/src/types.ts` adds `'SANDBOX_POLICY_INVALID'`, `'SANDBOX_BACKEND_UNAVAILABLE'`, `'SANDBOX_CAPABILITY_INSUFFICIENT'`, and `'SANDBOX_EXECUTION_FAILED'` to `GITHUB_APP_ERROR_CODES` and exports `SandboxBackendId`, `SandboxNetworkMode`, `SandboxCapability`, `TaskpackSandboxDeclaration`, `SandboxPolicyInput`, `SandboxHostEnvironment`, `NegotiatedSandboxBackend`, `CompiledMacosSeatbeltProfile`, `CompiledLinuxBwrapCommand`, `SandboxedCommandInput`, and `SandboxedCommandResult`. `packages/github-app/src/sandbox.ts` exports `TRUSTED_SEATBELT_PATHS`, `TRUSTED_BWRAP_PATHS`, `DEFAULT_DENIED_HOME_SUBPATHS`, `ALWAYS_PROTECTED_WORKSPACE_SUBPATHS`, `SANDBOX_CAPABILITIES_BY_BACKEND`, `compileMacosSeatbeltProfile`, `computeSandboxSeccompProfile`, `compileLinuxBwrapCommand`, `negotiateSandboxBackend`, and `executeSandboxedCommand`, all re-exported from `packages/github-app/src/index.ts`. `packages/github-app/test/sandbox.test.ts` verifies deterministic SBPL compilation, real `/usr/bin/sandbox-exec` kernel enforcement on `darwin` (allowed workspace writes, denied outside-workspace writes, denied `.git`/`.github`/`AGENTS.md` writes inside writable workspace, denied credential-path reads, secret scrubbing, and timeout handling), deterministic `bwrap` argument and seccomp BPF profile compilation, and fail-closed backend negotiation (`SANDBOX_BACKEND_UNAVAILABLE`, `SANDBOX_CAPABILITY_INSUFFICIENT`, `SANDBOX_POLICY_INVALID`).
      Verify: `npm run build && npm run typecheck && npm run lint && npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-build/packages/github-app/test/sandbox.test.js`

- [x] **T2 · Declarative `.loopwright/taskpack.yaml` `spec.sandbox` schema validation (`AC-3`)**
      Blocked by: T1
      Owns: `packages/github-app/src/schema.ts`, `packages/github-app/test/taskpack-intake.test.ts`
      Acceptance: `TaskpackManifest['spec']` in `packages/github-app/src/types.ts` (from T1) and `validateTaskpackManifest` in `packages/github-app/src/schema.ts` accept an optional `spec.sandbox` block (`preferredBackends` of `1..5` unique `SandboxBackendId` entries, `networkMode` in `'none' | 'loopback-only' | 'allow-outbound'` defaulting to `'none'`, `requiredCapabilities` of unique `SandboxCapability` entries, and `deniedReadPaths` of normalized relative or `~/` subpaths rejecting `..` traversal, control characters, and duplicates). Manifests omitting `spec.sandbox` remain 100% backward-compatible. `packages/github-app/test/taskpack-intake.test.ts` tests valid `spec.sandbox` YAML/JSON manifests and negative refusal cases (`TASKPACK_MANIFEST_INVALID` on unknown fields, invalid backend/capability names, duplicate entries, or `..` traversal in `deniedReadPaths`).
      Verify: `npm run build && npm run typecheck && npm run lint && npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-build/packages/github-app/test/taskpack-intake.test.js`

- [x] **T3 · `PythonBridge` optional macOS Seatbelt sandbox wrapping in `@loopwright/taskpack-runner` (`AC-4`)**
      Blocked by: None
      Owns: `packages/taskpack-runner/src/python-bridge.ts`, `packages/taskpack-runner/src/index.ts`, `packages/taskpack-runner/test/python-bridge.test.ts`
      Gate: review
      Acceptance: `packages/taskpack-runner/src/python-bridge.ts` exports `PythonSandboxOptions` (`{ readonly enabled: boolean; readonly writablePaths?: readonly string[] | undefined; readonly protectedPaths?: readonly string[] | undefined; readonly networkMode?: 'none' | 'loopback-only' | undefined }`), extends `PythonBridgeOptions` and `PythonRunOptions` with `readonly sandbox?: PythonSandboxOptions | undefined`, and re-exports `PythonSandboxOptions` from `packages/taskpack-runner/src/index.ts`. When `sandbox.enabled === true` on `darwin` (with `/usr/bin/sandbox-exec` present), `PythonBridge` compiles a canonical SBPL profile permitting writes to the bridge scratch directory and canonicalized `writablePaths` while denying writes outside those paths and re-denying writes to `.git`, `.github`, `.loopwright`, `.claude`, `.agents`, `AGENTS.md`, `CLAUDE.md`, and `protectedPaths`, and wraps the Python subprocess in `/usr/bin/sandbox-exec -p <profile> -- <executable> ...` alongside `SITE_GUARD_CODE`. `packages/taskpack-runner/test/python-bridge.test.ts` verifies that Seatbelt-wrapped Python runs succeed for allowed scratch/workspace writes and fail closed when attempting to write outside `writablePaths` or into protected subpaths.
      Verify: `npm run build && npm run typecheck && npm run lint && npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-build/packages/taskpack-runner/test/python-bridge.test.js`

- [x] **T4 · CLI closure ledger, Scenario 13 failure matrix, and connected documentation & Hugo site (`AC-4`)**
      Blocked by: T1, T2, T3
      Owns: `packages/cli/src/closure.ts`, `packages/cli/src/failure-matrix.ts`, `packages/cli/test/closure-and-failure-matrix.test.ts`, `docs/README.md`, `docs/github-app.md`, `docs/operate/github-action.md`, `docs/operate/github-app.md`, `docs/walkthroughs/declarative-taskpack.md`
      Acceptance: `packages/cli/src/closure.ts` adds `'packages/github-app/src/sandbox.ts'` and `'packages/github-app/test/sandbox.test.ts'` to `evidencePaths` of row `'qualified-host-clock-and-storage-profile'` while keeping all 23 rows (18 `closed_local` + 5 `unprovisioned_external`) intact. `packages/cli/src/failure-matrix.ts` extends Scenario 13 (`untrusted_taskpack_and_oauth_boundary_refusal`) to assert `negotiateSandboxBackend` (`SANDBOX_CAPABILITY_INSUFFICIENT`), `compileMacosSeatbeltProfile`, and `compileLinuxBwrapCommand` while preserving Scenario 13's `diagnosticCode: 'MCP_OAUTH_UNSUPPORTED'` and all 14 scenario IDs. `docs/README.md` adds `specs/2026-11-11-native-os-sandbox-execution-backends.md` to `## Specs` and `### GitHub App and Action Control Plane` (`- Specs:`) while preserving the 21-row `## All pages` table. `docs/github-app.md`, `docs/operate/github-action.md`, `docs/operate/github-app.md`, and `docs/walkthroughs/declarative-taskpack.md` document the native OS sandbox backends in place with matching `## Contents` anchors. `npm run lint:docs`, `npm run site`, `npm run build`, `npm run typecheck`, `npm run lint`, and `npm test` pass with zero errors.
      Verify: `npm run build && npm run typecheck && npm run lint && npm run lint:docs && npm run site && npm test`

### 5.5 Test Plan

[x] I/we understand the owners of the involved components may require updates to existing tests to make this code solid enough prior to committing the changes necessary to implement this enhancement.

#### Prerequisite testing updates
None in frozen packages (`packages/core`, `packages/state`, `packages/agent-pi`, `packages/controller`). Existing test suites in `packages/github-app`, `packages/taskpack-runner`, and `packages/cli` remain backward-compatible and are extended in place alongside the new `packages/github-app/test/sandbox.test.ts` suite.

#### Unit tests
- `@loopwright/github-app`: `2026-11-11` - `>= 95%` line coverage across `src/sandbox.ts` and the `spec.sandbox` additions in `src/schema.ts` (`packages/github-app/test/sandbox.test.ts` and `packages/github-app/test/taskpack-intake.test.ts`), covering:
  - `compileMacosSeatbeltProfile`: `realpath` canonicalization (`/tmp` -> `/private/tmp`), credential-path read-denial rules, global `(deny file-write*)`, explicit writable subpath grants, post-allowlist protected-path `(deny file-write*)` overrides, network modes (`none`, `loopback-only`, `allow-outbound`), `profileDigest` determinism, and `SANDBOX_POLICY_INVALID` on path traversal, control/quote characters, or writable-vs-protected conflicts.
  - `compileLinuxBwrapCommand` & `computeSandboxSeccompProfile`: `--unshare-all` (and `--share-net` only for `allow-outbound`), `--die-with-parent`, `--new-session`, `--ro-bind / /`, `--tmpfs` masks on denied credential paths, `--bind` mounts for writable paths followed by `--ro-bind-try` read-only masks for protected paths, `--clearenv` + sanitized `--setenv` bindings, and canonical seccomp syscall blocklist digest calculation.
  - `negotiateSandboxBackend`: platform mismatch refusal (`SANDBOX_BACKEND_UNAVAILABLE`), untrusted or missing binary path refusal (`SANDBOX_BACKEND_UNAVAILABLE`), capability insufficiency refusal (`SANDBOX_CAPABILITY_INSUFFICIENT` when requesting `syscallFiltering` on `macos-seatbelt` or requesting containment on `direct-dedicated` without `allowDedicatedDirectOverride: true`), and explicit override acceptance.
  - `validateTaskpackManifest`: optional `spec.sandbox` parsing in YAML/JSON and `TASKPACK_MANIFEST_INVALID` refusal on invalid backends, duplicate items, or `..` in `deniedReadPaths`.
- `@loopwright/taskpack-runner`: `2026-11-11` - `>= 95%` line coverage on the `PythonBridge` `sandbox` option in `src/python-bridge.ts` (`packages/taskpack-runner/test/python-bridge.test.ts`).
- `@loopwright/cli`: `2026-11-11` - `>= 95%` line coverage on the updated `CLOSURE_CAPABILITY_LEDGER` row and Scenario 13 probe (`packages/cli/test/closure-and-failure-matrix.test.ts`).

#### Integration tests
- Real XNU Seatbelt kernel execution (`packages/github-app/test/sandbox.test.ts` and `packages/taskpack-runner/test/python-bridge.test.ts` on `darwin`):
  1. Sandboxed command writing inside an approved workspace writable path succeeds (`exitCode === 0`).
  2. Sandboxed command attempting to write outside the workspace (`/private/tmp/...`) is denied by the kernel (`exitCode !== 0`, file absent).
  3. Sandboxed command attempting to write to `.git/config`, `.github/workflows/ci.yml`, or `AGENTS.md` inside the writable workspace is denied by the kernel (`exitCode !== 0`, file uncreated/unmodified).
  4. Sandboxed command attempting to read a path in `deniedReadPaths` is denied by the kernel (`exitCode !== 0`).
  5. `PythonBridge` with `sandbox: { enabled: true }` enforces Seatbelt filesystem containment alongside `SITE_GUARD_CODE`.
- Cross-package Failure Matrix & Closure Ledger (`packages/cli/test/closure-and-failure-matrix.test.ts`):
  - `evaluateClosureMatrix({ repoRoot, verifyFailures: true })` verifies the committed `sandbox.ts` and `sandbox.test.ts` evidence files and executes all 14 failure scenarios including the new OS sandbox assertions in Scenario 13.

#### e2e tests
- `packages/cli/test/closure-and-failure-matrix.test.ts` and `packages/cli/test/docs-and-site.test.ts` run the production CLI subprocess (`loopwright closure --json`), documentation linter (`scripts/check-docs.mjs`), and Hugo site builder (`scripts/site.mjs build`) end-to-end against the repository root.
