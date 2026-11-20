# Loopwright Self-Upgrade Instructions

You are maintaining Loopwright's own runtime dependency Taskpack (`self-upgrade`). Follow every scope, version-alignment, sandbox, and capture rule below.

## Dependency Groups & Alignment Invariants

1. **Lockstep `@earendil-works/pi-*` group (`packages/agent-pi/package.json`)**
   - Packages: `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-codemode`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-mcp`, `@earendil-works/pi-tui`.
   - All six packages MUST share one exact canonical `X.Y.Z` SemVer string (no `^`, `~`, range operators, or prerelease suffixes).
   - Never upgrade a subset of the six `@earendil-works/pi-*` packages. When `upstreamGroups` (`pi-family`, `policy: lockstep`) holds the Pi group as `held_back` (or `up_to_date`) at baseline during partial publication, keep all six at their `currentVersion` baseline.

2. **Uniform `yaml` group (`packages/{cli,controller,decisions,github-app}/package.json`)**
   - Direct `yaml` dependencies across `packages/cli/package.json`, `packages/controller/package.json`, `packages/decisions/package.json`, and `packages/github-app/package.json` MUST share one exact canonical `X.Y.Z` SemVer string.
   - Preserve the twin `yaml` AST traversal caps (`MAX_NODES = 4096`, `MAX_DEPTH = 16`, `MAX_COLLECTION = 512`, `MAX_STRING = 8192`) in `packages/github-app/src/schema.ts` and `packages/decisions/src/schema.ts`, updating version comments if needed.

3. **Manifest & Scope Boundaries**
   - In `packages/*/package.json`, modify ONLY `dependencies["@earendil-works/pi-*"]` (in `packages/agent-pi/package.json`) and `dependencies["yaml"]` (in `packages/{cli,controller,decisions,github-app}/package.json`).
   - NEVER add, remove, or modify `scripts`, `bin`, `exports`, `devDependencies`, `peerDependencies`, `optionalDependencies`, or lifecycle hooks (`preinstall`, `install`, `postinstall`, `prepare`); built-in `json-keys-guard.v1` checks enforce these exact RFC 6901 JSON Pointers on all five managed `package.json` manifests prior to `command.v1`.
   - Writable paths are strictly limited to exact files `.auto-sync/proposal.json` and `package-lock.json`, plus explicit subtrees `packages/agent-pi/**`, `packages/cli/**`, `packages/controller/**`, `packages/decisions/**`, `packages/github-app/**`, and `docs/**` (excluding `packages/agent-pi/qualification/**`, `packages/controller/qualification/**`, `packages/cli/src/closure.ts`, `packages/cli/src/failure-matrix.ts`, `packages/*/tsconfig.json`, `packages/*/tsconfig.*.json`, `packages/*/eslint.config.*`, `docs/contribute/**`, and `scripts/**`).
   - Root `package.json`, `scripts/**`, `tsconfig*.json`, `eslint.config.mjs`, `action.yml`, `.github/**`, `.claude/**`, `.auto-sync/taskpack.yaml`, `.auto-sync/digests.lock.json`, `.auto-sync/instructions.md`, and `.auto-sync/checks/**` are non-writable.

## Isolated Runner & Taskpack 2.0 Preflight Staged Resources

In GitHub Actions Turnkey mode (`GITHUB_ACTIONS=true`), Loopwright runs in `direct-dedicated` isolation on the ephemeral runner VM with `CANDIDATE_DIR` mounted read-only; locally (`GITHUB_ACTIONS != true`), Loopwright enforces host OS containment (`macos-seatbelt` / `linux-bwrap`) with network disabled:

- **Never run `npm install`, `npm ci`, or `npm update` inside `CANDIDATE_DIR`.** Creating `node_modules/` or running networked `npm` commands inside the candidate tree will fail or violate capture limits.
- Host preflight (`spec.preflight`: `scripts/prepare-self-upgrade.mjs`) runs post-authorization before model turns and stages verified read-only resources without smuggling paths through `upstreamRecords.reason`:
  - `target-versions.json` (`mount: prompt` as `.loopwright-preflight/target-versions.json`, plus `mount: workspace`, `exposeToChecks: true`): exact target `X.Y.Z` versions for every upstream and workspace manifest.
  - `package-lock.patch` (`mount: prompt` as `.loopwright-preflight/package-lock.patch` when `<= 64 KiB`, or line-aligned `.loopwright-preflight/package-lock.patch.part1`..`partN` chunks when `64 KiB < diff <= 192 KiB`, `exposeToChecks: false`): deterministic unified diff (`--- a/package-lock.json` / `+++ b/package-lock.json`) from baseline `package-lock.json` to the pre-resolved candidate lockfile.
  - `package-lock.candidate.json` (`mount: workspace`, `exposeToChecks: true`): pre-resolved clean lockfile (`<= 900 KiB`) matching `target-versions.json`; `verify.sh` validates exact SHA-256 parity against this file via `$LOOPWRIGHT_STAGED_DIR`.
  - `preflight-metadata.json` (`mount: workspace`, `exposeToChecks: true`): signed host preflight attestation (`schema_version`, `force`, and optional `disposition`).
  - `npm-cache.tgz` (`mount: workspace`, `exposeToChecks: true`): deterministic offline npm cache archive exposed strictly to `command.v1` checks via `$LOOPWRIGHT_STAGED_DIR` (never decoded into the LLM prompt).
- **CRITICAL — Tool path confinement (`read`, `write`, `edit`, `delete`):** These tools ONLY accept repository-relative paths inside `candidateDir` (for example `"package-lock.json"` or `"packages/agent-pi/package.json"`). **NEVER pass `/tmp/...` or any absolute host path outside `candidateDir` to `read`, `write`, `edit`, or `delete`.**
- Read the prompt-mounted `target-versions.json` (`.loopwright-preflight/target-versions.json`) and `package-lock.patch` (`.loopwright-preflight/package-lock.patch`, or concatenated `.loopwright-preflight/package-lock.patch.part*` in part order) resources directly from your trusted context:
  - Apply the exact hunks from `package-lock.patch` (or concatenated `package-lock.patch.part*`) to `package-lock.json` (never referencing host `/tmp` paths and never running `npm install`) so `package-lock.json` matches the staged `package-lock.candidate.json` SHA-256 byte-for-byte.
  - Apply the exact target versions from `target-versions.json` to `packages/*/package.json`, `.auto-sync/proposal.json`, TypeScript call sites, and `docs/**` via `edit` and `write` using repository-relative paths (or direct workspace file edits when driving locally via `loopwright step`).
- Update `.auto-sync/proposal.json` (`schema_version: 1`, `summary`, `upstreams`, and `packages`) so every version matches the updated workspace `package.json` files and `package-lock.json`.

## Candidate Capture & Overlay Limits (`spec.limits.overlay`)

Keep the candidate tree clean so `delegated-capture.v1` and Turnkey capture succeed:

- Every scanned file (including unchanged files) MUST stay `<= 1 MiB` (`1,048,576` bytes); `verify.sh` additionally enforces `package-lock.json <= 900 KiB` (`921,600` bytes).
- Aggregate changed file bytes MUST stay `<= 2 MiB` (`2,097,152` bytes).
- Total changed entries MUST stay `<= 64` files.
- Total scanned entries MUST stay `<= 16,384` files.
- Zero symlinks or hardlinks (`nlink > 1`) may exist anywhere in the candidate tree; never leave `node_modules/`, `dist/`, `.test-build/`, or `site/public/` inside the candidate workspace.
