# Sandbox Backends

Sandbox policy negotiates OS or container isolation before any agent step runs. When available host backends cannot satisfy your requested capabilities or network policy, negotiation fails closed (`SANDBOX_BACKEND_UNAVAILABLE` or `SANDBOX_CAPABILITY_INSUFFICIENT`).

## Contents

- [Sandbox policy](#sandbox-policy)
- [Policy fields](#policy-fields)
- [Backend choices](#backend-choices)
- [Network and capabilities](#network-and-capabilities)
- [Host qualification](#host-qualification)

## Sandbox policy

![Fail-closed OS and container sandbox negotiation](../assets/diagrams/sandbox-backends-flow.svg)

<!-- flowchart LR
  Policy["01 Declare spec.sandbox"] -> Negotiate["02 Negotiate capabilities"] -> Backend["03 Launch OS/container"] -> Cleanup["04 Reap process tree"]
-->

- **Declarative Taskpack mode**: Declare `spec.sandbox` inside `.loopwright/taskpack.yaml`. The GitHub Action or App negotiates a matching host backend automatically.
- **Managed Controller mode**: Pin container/runtime identities in `TrustedRegistry.spec.runtimeProfiles[]` (see [Controller and Registry](controller-and-registry.md)) and pass `SandboxPolicyInput` when invoking native host sandbox wrappers.

```yaml
apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: docs-sync
spec:
  # Other Taskpack sections omitted; see Taskpack.
  sandbox: # Optional host isolation policy
    preferredBackends: # Optional priority order
      - macos-seatbelt
      - linux-bwrap
      - linux-landlock
      - docker
    networkMode: none # Optional (defaults to none)
    requiredCapabilities: # Optional
      - filesystemReadContainment
      - filesystemWriteContainment
      - protectedPathReadOnlyMask
      - networkIsolation
      - processTreeCleanup
    deniedReadPaths: # Optional extra host paths masked unreadable
      - ~/.ssh
      - ~/.aws
      - ~/.config/gh
```

- **Priority order**: Loopwright probes `preferredBackends` in order and picks the first backend supporting every listed `requiredCapabilities` item.
- **Default network isolation**: Omitting `networkMode` defaults to `none` (all network sockets blocked).
- **Additive path masks**: `deniedReadPaths` supplements built-in `.github`, `.loopwright/policies`, `AGENTS.md`, and `CLAUDE.md` protections.

## Policy fields

`spec.sandbox` itself is **optional** inside `Taskpack`, and every subfield inside `spec.sandbox` is also optional:

| Field path | Required | Default and bounds | Meaning |
| --- | --- | --- | --- |
| `spec.sandbox` | No | Unset | Optional sandbox declaration block in `Taskpack` |
| `sandbox.preferredBackends` | No | Host default order (`1..5` unique) | Ordered candidate backends probed on the execution host |
| `sandbox.networkMode` | No | `'none'` (`'none'`, `'loopback-only'`, `'allow-outbound'`) | Socket policy enforced at the OS or container boundary |
| `sandbox.requiredCapabilities` | No | Unset (`0..6` unique) | Isolation guarantees that the chosen backend must provide |
| `sandbox.deniedReadPaths` | No | Unset (`0..64` entries) | Host or `~/`-relative paths blocked from read access |

## Backend choices

Configure `spec.sandbox.preferredBackends[]` in priority order:

| Backend | Isolation mechanism | Host prerequisite |
| --- | --- | --- |
| `macos-seatbelt` | macOS Seatbelt profile (`sandbox-exec`) | Qualified macOS host with `/usr/bin/sandbox-exec` |
| `linux-bwrap` | Linux namespaces and seccomp (`bwrap`) | Qualified Linux host with `/usr/bin/bwrap` |
| `linux-landlock` | Linux Landlock LSM rules | Linux kernel with Landlock ABI support |
| `docker` | Rootless or daemon container | Qualified Docker binary and verified daemon socket |
| `direct-dedicated` | Disposable dedicated runner | Explicit opt-in only; provides `processTreeCleanup` without filesystem/network masks |

## Network and capabilities

### Network modes

| Mode | Traffic policy | Constraint |
| --- | --- | --- |
| `none` | Blocks all outbound and loopback sockets | Default when `networkMode` is omitted |
| `loopback-only` | Permits `127.0.0.1` and `::1` traffic only | Used for local loopback MCP or runner bridges |
| `allow-outbound` | Permits outbound network connections | Requires explicit policy opt-in |

### Sandbox capabilities

| Capability | Protection boundary | Supporting backends |
| --- | --- | --- |
| `filesystemReadContainment` | Restricts reads outside workspace and `deniedReadPaths` | Seatbelt, bubblewrap, Landlock, Docker |
| `filesystemWriteContainment` | Restricts writes strictly to candidate writable paths | Seatbelt, bubblewrap, Landlock, Docker |
| `protectedPathReadOnlyMask` | Mounts or masks `protected` paths read-only | Seatbelt, bubblewrap, Landlock, Docker |
| `networkIsolation` | Enforces `networkMode` at kernel or container level | Seatbelt, bubblewrap, Landlock, Docker |
| `processTreeCleanup` | Terminates all descendant processes on step exit | All five backends |
| `syscallFiltering` | Applies seccomp or container syscall filter profile | Bubblewrap and Docker |

## Host qualification

### Live observations

Local fixture checks do not qualify a production host. Before relying on a backend in CI or production, verify the host OS/architecture (`darwin/arm64`, `linux/arm64`, `linux/x64`), installed sandbox binaries, and kernel user-namespace or Landlock support.

### Limits and costs

Resource limits, timeouts, and token consumption depend on the approved `RuntimeProfile` and `TaskContract.spec.budgets` envelope.

---

**See also** — [Taskpack](taskpack.md) (embed `spec.sandbox` in `.loopwright/taskpack.yaml`) · [Controller and Registry](controller-and-registry.md) (pin `runtimeProfiles` in `registry.yaml`)

**Next** → [Decision Routing](decision-routing.md) — configure optional calibrated triage and confidence zones.
