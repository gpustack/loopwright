# Loopwright Self-Upgrade Instructions

You are maintaining Loopwright's own runtime dependency Taskpack (`self-upgrade`). Follow every scope, version-alignment, sandbox, and capture rule below.

## Dependency Groups & Alignment Invariants

1. **Lockstep `@earendil-works/pi-*` group (`packages/agent-pi/package.json`)**
   - Packages: `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-codemode`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-mcp`, `@earendil-works/pi-tui`.
   - All six packages MUST share one exact canonical `X.Y.Z` SemVer string (no `^`, `~`, range operators, or prerelease suffixes).
   - Never upgrade a subset of the six `@earendil-works/pi-*` packages. If `upstreamRecords` holds the Pi group `up_to_date` at baseline during partial publication, keep all six at their baseline version.

2. **Uniform `yaml` group (`packages/{cli,controller,decisions,github-app}/package.json`)**
   - Direct `yaml` dependencies across `packages/cli/package.json`, `packages/controller/package.json`, `packages/decisions/package.json`, and `packages/github-app/package.json` MUST share one exact canonical `X.Y.Z` SemVer string.
   - Preserve the twin `yaml` AST traversal caps (`MAX_NODES = 4096`, `MAX_DEPTH = 16`, `MAX_COLLECTION = 512`, `MAX_STRING = 8192`) in `packages/github-app/src/schema.ts` and `packages/decisions/src/schema.ts`, updating version comments if needed.

3. **Manifest & Scope Boundaries**
   - In `packages/*/package.json`, modify ONLY `dependencies["@earendil-works/pi-*"]` (in `packages/agent-pi/package.json`) and `dependencies["yaml"]` (in `packages/{cli,controller,decisions,github-app}/package.json`).
   - NEVER add, remove, or modify `scripts`, `bin`, `exports`, `devDependencies`, `peerDependencies`, `optionalDependencies`, or lifecycle hooks (`preinstall`, `install`, `postinstall`, `prepare`).
   - Writable paths are strictly limited to `.loopwright/proposal.json`, `package-lock.json`, `packages/agent-pi`, `packages/cli`, `packages/controller`, `packages/decisions`, `packages/github-app`, and `docs` (excluding `packages/agent-pi/qualification`, `packages/controller/qualification`, `packages/cli/src/closure.ts`, `packages/cli/src/failure-matrix.ts`, and `docs/contribute`).
   - Root `package.json`, `scripts/**`, `tsconfig*.json`, `eslint.config.mjs`, `action.yml`, `.github/**`, `.loopwright/taskpack.yaml`, `.loopwright/instructions.md`, and `.loopwright/checks/**` are non-writable.

## Offline Sandbox & Pre-Staged Bundle Workflow

In GitHub Actions Turnkey mode (`packages/agent-pi/src/host-session.ts`), `bash` runs in `scratchDir` with network disabled (`--unshare-net` / `sandbox-exec`) and `CANDIDATE_DIR` mounted read-only:

- **Never run `npm install`, `npm ci`, or `npm update` inside `CANDIDATE_DIR`.** Creating `node_modules/` or running networked `npm` commands inside the candidate tree will fail or violate capture limits.
- Read the host-staged bundle prepared by `scripts/prepare-self-upgrade.mjs`. The read-only stage directory defaults to `/tmp/loopwright-self-upgrade-stage` (`SELF_UPGRADE_STAGE_DIR`) and is also recorded as `stageDir=<path>` in the `reason` field of `available` entries in `upstreamRecords`:
  - `<stageDir>/target-versions.json`: exact target `X.Y.Z` versions for every upstream and workspace manifest.
  - `<stageDir>/package-lock.candidate.json`: pre-resolved clean lockfile (`<= 900 KiB`) matching `target-versions.json`.
- Inspect `<stageDir>/target-versions.json` and compare `$CANDIDATE_DIR/package-lock.json` against `<stageDir>/package-lock.candidate.json` in `bash` using the absolute `stageDir=<path>` from `upstreamRecords` (for example `cat "<stageDir>/target-versions.json"` and `diff -u "$CANDIDATE_DIR/package-lock.json" "<stageDir>/package-lock.candidate.json"`, since the `read`, `edit`, and `write` tools are confined to `candidateDir`), then apply updates inside `candidateDir` to `package-lock.json`, `packages/*/package.json`, `.loopwright/proposal.json`, TypeScript call sites, and `docs/` using `edit` and `write` tools (or direct workspace file edits when driving locally via `loopwright step`).
- Update `.loopwright/proposal.json` (`schema_version: 1`, `summary`, `upstreams`, and `packages`) so every version matches the updated workspace `package.json` files and `package-lock.json`.

## Candidate Capture Limits (`packages/controller/src/step.ts`)

Keep the candidate tree clean so `delegated-capture.v1` and Turnkey capture succeed:

- Every scanned file (including unchanged files) MUST stay `<= 1 MiB` (`1,048,576` bytes); `verify.sh` additionally enforces `package-lock.json <= 900 KiB` (`921,600` bytes).
- Aggregate changed file bytes MUST stay `<= 4 MiB` (`4,194,304` bytes).
- Total changed entries MUST stay `<= 128` files.
- Total scanned entries MUST stay `<= 16,384` files.
- Zero symlinks or hardlinks (`nlink > 1`) may exist anywhere in the candidate tree; never leave `node_modules/`, `dist/`, `.test-build/`, or `site/public/` inside the candidate workspace.
