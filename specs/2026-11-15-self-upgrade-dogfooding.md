# Spec: Self-Upgrade Dogfooding

Status: Building
Type: Feature

## Summary

Add a declarative self-upgrade Taskpack (`.loopwright/taskpack.yaml`), baseline proposal ledger (`.loopwright/proposal.json`), host preflight and offline lockfile staging helper (`scripts/prepare-self-upgrade.mjs`), author instructions (`.loopwright/instructions.md`), OS-contained candidate verifier (`.loopwright/checks/verify.sh`), and SHA-pinned GitHub Actions workflow (`.github/workflows/self-upgrade.yml`) so Loopwright upgrades and verifies its own runtime dependencies (`@earendil-works/pi-*` and `yaml`) through both GitHub Actions and local `loopwright step`.

## Motivation

### Goals

- Track upstream npm releases for `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-mcp`, `@earendil-works/pi-codemode`, `@earendil-works/pi-tui`, and `yaml` via `http-json` discovery in [`packages/github-app/src/upstreams.ts`](../packages/github-app/src/upstreams.ts) paired with strict SemVer eligibility checks in `scripts/prepare-self-upgrade.mjs`.
- Enforce lockstep version alignment across all six `@earendil-works/pi-*` packages in [`packages/agent-pi/package.json`](../packages/agent-pi/package.json) and uniform direct `yaml` versions across [`packages/cli/package.json`](../packages/cli/package.json), [`packages/controller/package.json`](../packages/controller/package.json), [`packages/decisions/package.json`](../packages/decisions/package.json), and [`packages/github-app/package.json`](../packages/github-app/package.json).
- Verify baseline ledger integrity against committed `package.json` and `package-lock.json` before selecting `no-change` mode, so runs settle cleanly as `no_change` only when repository state and upstream releases genuinely match.
- Run the identical `.loopwright/taskpack.yaml` in GitHub Actions (pinned to 40-character commit SHAs on trusted `refs/heads/main`) and locally via `loopwright step next` and `loopwright step submit`.
- Verify every candidate inside real OS containment (`bwrap` on Linux, `sandbox-exec` on macOS) with offline `npm ci --offline --ignore-scripts`, manifest diff guards, and portable repository gates (`build`, `typecheck`, `lint`, `lint:docs`, `closure --verify-failures`, `test`, and `site` when Hugo is provisioned).

### Non-Goals

- Auto-upgrading root developer toolchains (`typescript`, `eslint`, `typescript-eslint`, `@eslint/js`, or `@types/node`) inside the runtime self-upgrade Taskpack.
- Allowing candidate runs to modify root [`package.json`](../package.json), `scripts/**`, `tsconfig*.json`, [`eslint.config.mjs`](../eslint.config.mjs), [`action.yml`](../action.yml), `.github/**`, `.loopwright/taskpack.yaml`, `.loopwright/instructions.md`, `.loopwright/checks/**`, `.agents/**`, `.claude/**`, [`AGENTS.md`](../AGENTS.md), or `CLAUDE.md`.
- Changing public contracts in [`packages/core/src/contracts.ts`](../packages/core/src/contracts.ts), [`packages/state/src/index.ts`](../packages/state/src/index.ts), qualification harnesses (`packages/*/qualification/**`), or the 23-row Capability Closure Matrix in [`packages/cli/src/closure.ts`](../packages/cli/src/closure.ts).
- Requiring private Docker Desktop Linux arm64 qualification (`npm run qualify:pi -- --case all`) inside portable CI or local `command.v1` verification.
- Enabling `/loopwright status` on `issue_comment` while [`packages/github-app/src/action.ts`](../packages/github-app/src/action.ts) lacks an early read-only return path.

## Proposal

Loopwright dogfoods its own declarative Taskpack control plane through a two-stage trust boundary. First, a protected host preflight script (`scripts/prepare-self-upgrade.mjs`) verifies that `.loopwright/proposal.json` matches committed manifests and `package-lock.json`, evaluates upstream npm `/latest` SemVer eligibility (monotonic `discovered > baseline`, six-package lockstep for `@earendil-works/pi-*`, independent advancement for `yaml`), selects the run mode (`no-change`, `candidate`, or `blocked`), and—when `candidate` work is eligible—stages a read-only bundle containing `target-versions.json`, a clean `package-lock.candidate.json` (`< 900 KiB`), and an offline npm cache. Second, Loopwright executes `.loopwright/taskpack.yaml` in the selected mode: `no-change` runs verify tree invariance via `no-change.v1`, while `candidate` runs let the author apply staged dependency updates and TypeScript/documentation adaptations without needing network access inside the author sandbox (`bwrap --unshare-net` / `sandbox-exec`), then validate the candidate through `json-artifact.v1`, `scope.v1`, and an OS-contained offline `.loopwright/checks/verify.sh` gate.

### User Stories

#### Story 1

As a Loopwright maintainer, I want Loopwright to track upstream `@earendil-works/pi-*` and `yaml` npm releases via `.loopwright/taskpack.yaml`, update package manifests, lockfile, and adapter code, and pass independent verification gates, so that core runtime components upgrade safely with minimal manual effort.

#### Story 2

As a Loopwright maintainer, I want runs to settle as `no_change` when `.loopwright/proposal.json` and committed manifests already match upstream versions, so that scheduled checks never create noisy pull requests.

#### Story 3

As a Loopwright contributor, I want to drive the same `.loopwright/taskpack.yaml` both in GitHub Actions (pinned to a stable Loopwright commit SHA) and locally via `loopwright step`, so that every self-upgrade dogfoods both execution modes.

### Core Features & Acceptance Criteria

1. **Host Preflight Staging & Declarative Self-Upgrade Taskpack**
   - Add `scripts/prepare-self-upgrade.mjs` (protected outside `spec.scope.writable`) to validate baseline integrity across `.loopwright/proposal.json`, `packages/*/package.json`, and `package-lock.json` before discovery; malformed ledgers or baseline drift exit nonzero instead of masquerading as `no_change`.
   - Enforce strict release eligibility in `scripts/prepare-self-upgrade.mjs`: require canonical `X.Y.Z` SemVer strings (rejecting prereleases, missing `version` hashes, and rollbacks `<= baseline`), require all six `@earendil-works/pi-*` packages to share one target version before advancing the Pi group, allow `yaml` to advance independently when the Pi group is held at baseline during partial publication, return `recommendedMode: 'blocked'` when only partial Pi publication is present, return `recommendedMode: 'no-change'` when all eligible groups match baseline, and stage read-only `target-versions.json`, `package-lock.candidate.json`, and `npm-cache/` when `recommendedMode: 'candidate'`.
   - Add `.loopwright/taskpack.yaml` (`apiVersion: loopwright.dev/v1alpha1`, `kind: Taskpack`, `metadata.name: self-upgrade`) validated by `loadDeclarativeTaskpack` in [`packages/github-app/src/taskpack.ts`](../packages/github-app/src/taskpack.ts), declaring the seven `http-json` npm `/latest` upstreams (`watchedPaths: []`), `commandTimeoutSeconds: 900`, and `triggers.commentCommands: [retry, revise]` (excluding `status`).
   - Restrict `spec.scope.writable` to `.loopwright/proposal.json`, `package-lock.json`, `packages/agent-pi`, `packages/cli`, `packages/controller`, `packages/decisions`, `packages/github-app`, and `docs`. Set `spec.scope.protected` to `packages/agent-pi/qualification`, `packages/controller/qualification`, `packages/cli/src/closure.ts`, `packages/cli/src/failure-matrix.ts`, and `docs/contribute` (in addition to built-in `.github`, `.loopwright`, `.agents`, `.claude`, and root files outside `writable`).
   - Seed `.loopwright/proposal.json` (`schema_version: 1`) with `summary`, `upstreams` (`1.5.0` for all six `@earendil-works/pi-*` packages and `2.9.0` for `yaml`), and `packages` audit metadata matching `HEAD`, and add `.serena/` to [`.gitignore`](../.gitignore).

2. **Author Instructions & Offline Sandbox Compatibility**
   - Add `.loopwright/instructions.md` pinned via `spec.instructions`.
   - Instruct the author in Action Turnkey mode (where [`packages/agent-pi/src/host-session.ts`](../packages/agent-pi/src/host-session.ts) runs `bash` in `scratchDir` with `--unshare-net` and read-only `candidateDir`) to read staged `target-versions.json` and `package-lock.candidate.json` from `SELF_UPGRADE_STAGE_DIR` (or injected `upstreamRecords`) and apply edits via `write`/`edit` tools without running `npm install` inside `candidateDir`.
   - Document exact [`packages/controller/src/step.ts`](../packages/controller/src/step.ts) capture limits (`<= 1 MiB` per scanned file including unchanged files, `<= 4 MiB` aggregate changed bytes, `<= 128` changed entries, `<= 16,384` scanned entries, zero symlinks or hardlinks).

3. **OS-Contained Candidate Verification Gate (`command.v1`)**
   - Add `.loopwright/checks/verify.sh` (`timeoutSeconds: 900`) bound as a `command.v1` local check alongside `json-artifact.v1` and `scope.v1`.
   - Audit candidate manifests against baseline git `HEAD` (`SELF_UPGRADE_REPO_ROOT` or repository parent) before running any candidate code: reject any change in `packages/*/package.json` outside `dependencies["@earendil-works/pi-*"]` (in `agent-pi`) and `dependencies["yaml"]` (in `cli`, `controller`, `decisions`, `github-app`); reject `scripts`, `bin`, `exports`, `devDependencies`, or lifecycle hook additions; verify lockstep `@earendil-works/pi-*` versions and direct workspace `yaml` resolutions in `package-lock.json` (`packages["packages/..."]` and top-level `packages["node_modules/..."]` without falsely rejecting nested transitive `node_modules/**/node_modules/yaml`); and assert `package-lock.json` stays `<= 900 KiB`.
   - Materialize an isolated verification directory under `$TMPDIR`, install `node_modules` offline with `npm ci --offline --ignore-scripts --no-audit --no-fund --cache "$SELF_UPGRADE_NPM_CACHE"` (or a test-only `SELF_UPGRADE_TEST_NODE_MODULES` fixture gated by `SELF_UPGRADE_ALLOW_TEST_FIXTURE=1` and rejected when `GITHUB_ACTIONS=true`), and execute pinned tool invocations (`node scripts/build.mjs`, `./node_modules/.bin/tsc -p tsconfig.test.json --noEmit`, `./node_modules/.bin/eslint .`, `node scripts/check-docs.mjs`, `node packages/cli/dist/main.js closure --verify-failures`, `node scripts/run-tests.mjs`, and `node scripts/site.mjs build` when `HUGO_BIN` or `hugo` is present; required when `SELF_UPGRADE_REQUIRE_HUGO=1`) inside OS containment (`bwrap --unshare-net` on Linux or `sandbox-exec` denying network, checkout writes, sensitive `$HOME` paths, and `.taskpack-*` secret directories on macOS; fail closed if containment is unavailable).

4. **Bootstrap-Pinned GitHub Actions Workflow & Connected Documentation**
   - Add `.github/workflows/self-upgrade.yml` supporting weekly `schedule`, manual `workflow_dispatch`, and PR `/loopwright` (`retry`, `revise`) `issue_comment` triggers.
   - Enforce workflow provenance and authorization: gate `issue_comment` jobs to pull-request comments starting with `/loopwright` by `OWNER`, `MEMBER`, or `COLLABORATOR` actors; check out trusted `ref: refs/heads/main` with `persist-credentials: false` (never checking out unreviewed PR heads); pin `gpustack/loopwright` and every third-party Action to 40-character commit SHAs; run `node scripts/prepare-self-upgrade.mjs` to compute `mode` (`no-change` / `candidate` / `blocked`), `upstream-records`, and `SELF_UPGRADE_STAGE_DIR`; and pass explicit `mode`, `event-name: ${{ github.event_name }}`, `event-path: ${{ github.event_path }}`, and `run-root: ${{ runner.temp }}/loopwright-self-upgrade`.
   - Update [`docs/walkthroughs/declarative-taskpack.md`](../docs/walkthroughs/declarative-taskpack.md), [`docs/operations/coding-agents.md`](../docs/operations/coding-agents.md), [`docs/development.md`](../docs/development.md), and [`docs/README.md`](../docs/README.md), keeping `npm run lint:docs` and `npm run site` green.

### Notes / Constraints / Caveats

- `command.v1` in [`packages/github-app/src/turnkey.ts`](../packages/github-app/src/turnkey.ts) spawns scripts directly under a sanitized environment (`PATH=/usr/local/bin:/usr/bin:/bin`); `.loopwright/checks/verify.sh` therefore enforces its own `bwrap` / `sandbox-exec` containment boundary and passes only safe uppercase names (`NODE_BIN_DIR`, `HUGO_BIN`, `PYTHON_BIN`, `SELF_UPGRADE_STAGE_DIR`, `SELF_UPGRADE_NPM_CACHE`, `SELF_UPGRADE_REPO_ROOT`, `SELF_UPGRADE_REQUIRE_HUGO`, `SELF_UPGRADE_ALLOW_TEST_FIXTURE`, `SELF_UPGRADE_TEST_NODE_MODULES`) through `parameters.env`.
- Local `loopwright step next --taskpack .loopwright/taskpack.yaml` defaults to `candidate` mode (`no-change.v1` is compiled only in `--mode no-change`). Operators and coding agents run `node scripts/prepare-self-upgrade.mjs` first and pass `--mode no-change` when no eligible upgrade exists.

### Boundaries

- **Always:** Pin all GitHub Actions in `.github/workflows/self-upgrade.yml` to 40-character commit SHAs; check out `refs/heads/main` for control assets; pass `event-name` and `event-path` explicitly; contain `verify.sh` candidate execution in `bwrap` or `sandbox-exec` with network disabled; pass `--ignore-scripts` on every `npm` lockfile/install operation; sign every commit with DCO (`git commit -s`).
- **Ask first:** Expanding `spec.upstreams` to compiler/linter toolchains (`typescript`, `eslint`), modifying `packages/github-app/src/**` or `packages/controller/src/**`, adding runtime npm dependencies, or enabling `/loopwright status` comment triggers.
- **Never:** Invoke `uses: ./` in `.github/workflows/self-upgrade.yml`; check out unreviewed PR heads in privileged `issue_comment` runs; make root `package.json` or `scripts/**` writable to candidates; invoke untrusted candidate `npm run` script definitions in `verify.sh`; or allow `SELF_UPGRADE_TEST_NODE_MODULES` when `GITHUB_ACTIONS=true`.

### Risks and Mitigations

- **Risk:** `command.v1` executes on the host without built-in filesystem/network confinement, allowing candidate tests to read `.taskpack-*/secrets.json` or mutate the base checkout. → **Mitigation:** Wrap candidate build/test execution inside `.loopwright/checks/verify.sh` using Linux `bwrap --unshare-net` or macOS `sandbox-exec` (denying network, checkout writes, and `.taskpack-*` / `$HOME` credential reads), failing closed when neither OS sandbox is available.
- **Risk:** A candidate modifies `package.json` `scripts` (`test`, `lint`, `pretest`) to no-ops or malicious commands. → **Mitigation:** Keep root `package.json` and `scripts/**` non-writable, reject any `packages/*/package.json` diff outside exact `@earendil-works/pi-*` and `yaml` dependency versions before building, and invoke pinned tool binaries directly rather than `npm run`.
- **Risk:** Omitting `event-name` in GitHub Actions defaults `action.yml` to `workflow_dispatch`, bypassing `issue_comment` authorization, while `/loopwright status` falls through into candidate execution in `action.ts`. → **Mitigation:** Pass explicit `event-name: ${{ github.event_name }}` and `event-path: ${{ github.event_path }}`, restrict workflow `if:` conditions on `issue_comment`, check out `refs/heads/main`, and set `commentCommands: [retry, revise]` (excluding `status`).
- **Risk:** Author `bash` inside `host-session.ts` runs with `--unshare-net` and read-only `candidateDir`, preventing live `npm install --package-lock-only` on Linux Actions runners. → **Mitigation:** Pre-stage `package-lock.candidate.json` and an offline `npm-cache` on the trusted host in `scripts/prepare-self-upgrade.mjs` before invoking Loopwright.
- **Risk:** Partial npm publication skews `@earendil-works/pi-*` versions, aligned registry tags roll versions backward, or drifted `.loopwright/proposal.json` hides broken baselines. → **Mitigation:** Validate baseline ledger parity against `package.json` and `package-lock.json` first, require strict SemVer `discovered > baseline`, hold the Pi group during partial publication while still permitting independent `yaml` upgrades, and enforce direct-dependency lockfile parity in `verify.sh`.

## Design Details

### Commands

Target build and test environment: **local** macOS (`darwin/arm64`, Node `26.x`, `npm` `11.x`, `python3`, `sandbox-exec`, and Hugo binary via `HUGO_BIN=/Users/thxcode/Documents/github.com/thxcode/loopwright/.sbin/hugo` when building `site/`).

```sh
npm ci
npm run build
npm run typecheck
npm run lint
npm run lint:docs
HUGO_BIN=/Users/thxcode/Documents/github.com/thxcode/loopwright/.sbin/hugo npm run site
node packages/cli/dist/main.js closure --verify-failures
npm test
```

### Project Structure

```text
.loopwright/
  taskpack.yaml              # Declarative self-upgrade manifest (protected)
  instructions.md            # Lockstep upgrade, staging, & capture rules (protected)
  proposal.json              # Writable baseline/candidate upstream version ledger
  checks/
    verify.sh                # OS-contained command.v1 verification gate (protected)
scripts/
  prepare-self-upgrade.mjs   # Host baseline audit, SemVer eligibility, & offline lockfile/cache stager
.github/workflows/
  self-upgrade.yml           # SHA-pinned main-checkout workflow with explicit event & mode binding
packages/github-app/test/
  self-upgrade-taskpack.test.ts  # Offline compilation, preflight, step mode, containment, & gate tests
docs/
  README.md                  # Spec index entry for self-upgrade dogfooding
  development.md             # Contributor self-upgrade dogfooding verification commands
  operations/coding-agents.md    # Local prepare-self-upgrade + loopwright step workflow
  walkthroughs/declarative-taskpack.md # Bootstrap SHA-pinning & main-checkout provenance guide
```

### Code Style

Follow strict ESM TypeScript (`NodeNext`) and zero-dependency Node `.mjs` automation with explicit types, null-prototype record checks, bounded file I/O (`O_NOFOLLOW`), and zero `any`, matching [`packages/github-app/src/upstreams.ts`](../packages/github-app/src/upstreams.ts):

```ts
if (isPlainRecord(res.data)) {
  for (const key of ['version', 'tag_name', 'latest', 'sha'] as const) {
    const candidate = res.data[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return { version: candidate.trim() };
    }
  }
}
```

### Implementation Plan

- [x] **T1 · Self-upgrade preflight helper & Taskpack control assets**
      Blocked by: None
      Owns: `scripts/prepare-self-upgrade.mjs`, `.loopwright/taskpack.yaml`, `.loopwright/proposal.json`, `.loopwright/instructions.md`, `.gitignore`
      Gate: review
      Acceptance: `scripts/prepare-self-upgrade.mjs` validates baseline `.loopwright/proposal.json` parity against `packages/*/package.json` and `package-lock.json`, enforces monotonic SemVer `X.Y.Z` eligibility (holding `@earendil-works/pi-*` on partial publish while allowing independent `yaml` advancement, rejecting rollbacks and missing-version hashes, and emitting `recommendedMode: 'no-change' | 'candidate' | 'blocked'`), and stages read-only `target-versions.json`, `package-lock.candidate.json`, and `npm-cache/` when `candidate` is selected; `.loopwright/taskpack.yaml` compiles cleanly in both `candidate` and `no-change` modes with narrow `scope.writable` and explicit `scope.protected`; `.gitignore` ignores `.serena/`.
      Verify: `npm run build && node scripts/prepare-self-upgrade.mjs --offline-check && npx tsc -p tsconfig.test.json --noEmit && npm run lint`

- [x] **T2 · Contained `command.v1` verifier & offline integration test suite**
      Blocked by: T1
      Owns: `.loopwright/checks/verify.sh`, `packages/github-app/test/self-upgrade-taskpack.test.ts`
      Gate: review
      Acceptance: `.loopwright/checks/verify.sh` rejects unauthorized `packages/*/package.json` field or script edits before running candidate code, checks lockstep `@earendil-works/pi-*` and direct `yaml` lockfile resolutions (permitting nested transitive `yaml` differences), enforces `package-lock.json <= 900 KiB`, runs pinned build/typecheck/lint/docs/closure/test commands offline inside `bwrap` (Linux) or `sandbox-exec` (macOS) containment (blocking canary secret reads and checkout writes), and `self-upgrade-taskpack.test.ts` covers positive and negative preflight, compilation, `loopwright step` (`no-change` and `candidate`), manifest tampering, lockfile skew, and sandbox containment cases offline.
      Verify: `npm run build && npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-build/packages/github-app/test/self-upgrade-taskpack.test.js`

- [ ] **T3 · SHA-pinned GitHub Actions workflow & connected documentation**
      Blocked by: T1
      Owns: `.github/workflows/self-upgrade.yml`, `docs/README.md`, `docs/development.md`, `docs/operations/coding-agents.md`, `docs/walkthroughs/declarative-taskpack.md`
      Gate: review
      Acceptance: `.github/workflows/self-upgrade.yml` pins all Actions (including `gpustack/loopwright`) to 40-character commit SHAs, checks out `refs/heads/main` (`persist-credentials: false`), gates `issue_comment` to authorized PR `/loopwright` (`retry`, `revise`) actors, runs `scripts/prepare-self-upgrade.mjs` to bind explicit `mode`, `upstream-records`, `event-name`, `event-path`, and `run-root`, installs Node 26, Python bridge packages, and Hugo `0.152.2`, and documentation updates pass `npm run lint:docs`, `npm run site`, and `docs-and-site.test.js`.
      Verify: `npm run build && npm run lint:docs && HUGO_BIN=/Users/thxcode/Documents/github.com/thxcode/loopwright/.sbin/hugo npm run site && npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-build/packages/cli/test/check-docs-rules.test.js .test-build/packages/cli/test/docs-and-site.test.js`

### Test Plan

[ ] I/we understand the owners of the involved components may require updates to existing tests to make this
code solid enough prior to committing the changes necessary to implement this enhancement.

#### Prerequisite testing updates

None. Existing offline test harnesses in `packages/github-app/test/` and `packages/cli/test/` already support temporary git repositories, local `command.v1` gates, and `loopwright step` staging without network or credentials.

#### Unit tests

- `packages/github-app`: `2026-11-15` - `100%` of new self-upgrade preflight eligibility branches (`up_to_date` -> `no-change`, aligned Pi bump -> `candidate`, partial Pi publish + unchanged YAML -> `blocked`, partial Pi publish + YAML bump -> YAML-only `candidate`, aligned rollback -> rejected, prerelease / missing `version` hash -> rejected, corrupted or drifted `.loopwright/proposal.json` -> nonzero failure) and `verify.sh` manifest/lockfile guards (`scripts`/`postinstall` injection rejected, Pi version skew rejected, nested transitive `yaml` allowed while direct workspace `yaml` skew rejected, `SELF_UPGRADE_TEST_NODE_MODULES` refused when `GITHUB_ACTIONS=true`).

#### Integration tests

- `packages/github-app/test/self-upgrade-taskpack.test.ts`:
  - Compile the committed `.loopwright/taskpack.yaml` in both `candidate` and `no-change` modes via `loadDeclarativeTaskpack` and `compileDeclarativeTaskpack`, verifying `.loopwright/proposal.json` carve-out, protected `.loopwright/checks/verify.sh`, `scope.protected` exclusions (`packages/core`, `packages/state`, `closure.ts`, `qualification`), `commandTimeoutSeconds: 900`, and `commentCommands: ['retry', 'revise']`.
  - Exercise `loopwright step next` and `loopwright step submit` in `--mode no-change` (settling `no_change` with `no-change.v1`) and in `--mode candidate` (applying a staged `yaml` / `@earendil-works/pi-*` update and passing `json-artifact.v1`, `scope.v1`, and `command.v1`).
  - Exercise OS containment inside `.loopwright/checks/verify.sh`: a candidate test attempting to read a canary `.taskpack-canary/secrets.json` file or mutate a file in the base checkout fails inside `sandbox-exec` / `bwrap` and causes `verify.sh` to deny the check.
- `packages/cli/test/check-docs-rules.test.ts` and `packages/cli/test/docs-and-site.test.ts`:
  - Verify `specs/2026-11-15-self-upgrade-dogfooding.md` registration in `docs/README.md`, page line/H2 budgets, complete YAML envelopes, relative markdown links in `.github/`, and clean Hugo `site/` output.

#### e2e tests

Live end-to-end GitHub Actions self-upgrade execution against `registry.npmjs.org` and GitHub pull-request APIs requires repository secrets (`ZAI_API_KEY` / GitHub App credentials) and live upstream releases, so CI runs offline deterministic unit/integration gates on every PR while live `workflow_dispatch` (`dry-run: 'true'` followed by `mode: 'no-change'`) qualifies the deployed workflow after merge.

## Alternatives

- **GitHub Dependabot / Renovate only:** Dependabot bumps `package.json` and `package-lock.json` mechanically, but it cannot adapt TypeScript call sites in `packages/agent-pi`, update documentation, enforce `@earendil-works/pi-*` six-package lockstep invariants before opening a PR, or dogfood Loopwright's own `Taskpack` and `loopwright step` runtime.
- **Including `typescript` and `eslint` in the same Taskpack:** Compiler and linter upgrades frequently trigger mechanical edits across all nine workspace packages, substantially increasing merge conflict surface and repair iterations compared to isolating runtime dependencies (`@earendil-works/pi-*` and `yaml`).
- **Running `npm install --package-lock-only` inside the Turnkey author sandbox or running uncontained `npm run` inside `verify.sh`:** Linux `host-session.ts` disables network access (`--unshare-net`) and mounts `candidateDir` read-only for `bash`, while uncontained `command.v1` execution exposes host files and trusts candidate `package.json` scripts; host preflight lockfile/cache staging plus OS-contained pinned tool execution in `verify.sh` closes both gaps without modifying `@loopwright/github-app` runtime code.
- **Referencing `uses: ./` or checking out PR heads in `.github/workflows/self-upgrade.yml`:** Using the local checkout or an unreviewed PR head lets candidate branches supply control-plane code or `verify.sh`; checking out `refs/heads/main` and pinning `gpustack/loopwright@<40-char-sha>` preserves bootstrap provenance.

## Open Questions

None.
