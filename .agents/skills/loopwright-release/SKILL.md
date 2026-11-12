---
name: loopwright-release
description: >-
  Run the explicitly authorized Loopwright SemVer2 release workflow: verify
  preconditions, audit workspace versions and closure matrix boundaries, execute
  full build/test/docs/site gates, synthesize honest release notes with Residual
  Boundaries, and gate every commit, tag, push, or GitHub release on explicit
  operator confirmation.
disable-model-invocation: true
allowed-tools: Bash, Read, Grep, Glob, Edit, Write, AskUserQuestion
---

# Loopwright Release Runbook

Drive a deterministic Loopwright release from preflight verification and closure-matrix auditing through release-note synthesis and explicitly authorized git tagging and GitHub Release publication.

## Hard Rules

1. **Explicit-only invocation (`disable-model-invocation: true`, `allow_implicit_invocation: false`)**:
   - Never invoke this workflow implicitly or opportunistically during feature development or bug fixing.
2. **Strict SemVer2 tag format (`^v[0-9]+\.[0-9]+\.[0-9]+(-rc(\.[0-9]+|[0-9]+))?$`)**:
   - Every release tag must match `^v[0-9]+\.[0-9]+\.[0-9]+(-rc(\.[0-9]+|[0-9]+))?$` (for example, `v0.1.0` or `v0.1.0-rc.1`). Hyphen-less pre-release suffixes (`v0.1.0rc1`) or unprefixed versions (`0.1.0`) are rejected.
3. **Separate explicit operator confirmation for every mutating step**:
   - Read-only preflight, version checks, build/test gates, and `loopwright closure --verify-failures` run automatically.
   - You MUST obtain explicit operator confirmation in the active turn before:
     1. Creating a version-bump commit (`git commit -s`),
     2. Creating a local annotated/signed tag (`git tag -a vX.Y.Z`),
     3. Pushing any branch or tag to a remote (`git push`),
     4. Creating, editing, deleting, or promoting a GitHub Release (`gh release create` / `gh release edit` / `gh release delete`).
4. **Honest capability closure reporting**:
   - Every release note must include a `## Known Residual Boundaries` (or `## Residual Boundaries`) section derived directly from `node packages/cli/dist/main.js closure --verify-failures`, naming any `blocked_external` rows (such as live external provider billing or live GitHub production App credentials) rather than claiming universal production qualification.
5. **Protected `.github/workflows/` invariant**:
   - `.github/workflows/` must maintain least-privilege `permissions`, consist only of regular non-symlink `.yml`/`.yaml` files, and remain strictly protected against untrusted taskpack and sandbox writes.

## Execution Modes

- **`Interactive` (default)**: Run Phases 0–3, present the verification results, closure report, and drafted release notes, and ask for explicit operator confirmation (`AskUserQuestion`) at each mutating gate in Phases 4–7.
- **`Auto` (preflight & dry-run audit)**: Run Phases 0–3 unattended (read-only preflight, workspace version consistency audit, full verification suite + closure verification, and release-note draft generation), then **stop before Phase 4** without creating commits, tags, pushes, or GitHub releases.
- **`Unpublished-Tag Recovery` (interactive-only)**: Used only when an operator needs to replace or clean up a local or unpublished tag (`vX.Y.Z`) that has not yet been published as an immutable release artifact. Exports existing release notes before any deletion and requires explicit operator confirmation before removing or recreating the tag.

## Deterministic Release Phases (Phases 0–7)

### Phase 0: Preconditions & Tag Validation (Read-Only)

Validate the requested version `VER` (`^v[0-9]+\.[0-9]+\.[0-9]+(-rc(\.[0-9]+|[0-9]+))?$`), clean working tree, branch lineage, tool availability, and repository hygiene:

```bash
# 1. Validate SemVer2 tag format
printf '%s\n' "$VER" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-rc(\.[0-9]+|[0-9]+))?$'

# 2. Confirm clean git working tree and valid .github/workflows/ directory
git status --porcelain                 # must be empty
test -d .github/workflows && test ! -L .github/workflows

# 3. Inspect target branch / commit and existing tags
git rev-parse HEAD
git tag -l 'v*' --sort=-v:refname | head -n 10
```

### Phase 1: Workspace Version & Lockfile Consistency Audit (Read-Only)

Verify that root `package.json`, all nine workspace package manifests (`packages/{core,state,agent-pi,controller,taskpack-runner,memory,decisions,github-app,cli}/package.json`), `package-lock.json`, and `action.yml` are internally consistent:

```bash
node -e '
  const fs = require("node:fs");
  const root = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const pkgs = [
    "core", "state", "agent-pi", "controller",
    "taskpack-runner", "memory", "decisions", "github-app", "cli"
  ];
  for (const p of pkgs) {
    const m = JSON.parse(fs.readFileSync(`packages/${p}/package.json`, "utf8"));
    console.log(p, m.name, m.version);
  }
'
```

### Phase 2: Full Deterministic Local Verification Gate (Read-Only)

Run the complete Loopwright build, typecheck, lint, documentation contract, Hugo site build, test suite, and capability closure failure verification:

```bash
npm run build \
  && npm run typecheck \
  && npm run lint \
  && npm run lint:docs \
  && npm run site \
  && npm test \
  && node packages/cli/dist/main.js closure --verify-failures \
  && npm run pack:npm -- --version "${VER#v}"
```

Note: All nine internal workspace packages (`@loopwright/*`) keep `"private": true`; `npm run pack:npm` stages and packs the single public CLI package `@gpustack/loopwright` (published via `.github/workflows/ci.yml` `publish-npm` with `--provenance` on `v*` tags).

If any command exits non-zero, **stop immediately** and report the failing gate. Never tag or release a failing tree. See [closure matrix](../../../docs/contribute/closure-matrix.md) and [development](../../../docs/development.md).

### Phase 3: Release Notes Synthesis (Read-Only Draft)

Identify the previous release tag (`LAST`) reachable from `HEAD` and inspect the commit range:

```bash
LAST=$(git tag -l 'v*' --merged HEAD --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | grep -Fvx "$VER" | head -n 1)
git log --no-merges --pretty='%h %s (%an)' ${LAST:+"$LAST.."}HEAD
```

Draft the release notes categorized in this exact order (omitting empty change categories, but **always** keeping `Residual Boundaries`):

1. `## Breaking Changes`
2. `## Features`
3. `## Bug Fixes`
4. `## Documentation & Site`
5. `## Known Residual Boundaries` (honestly citing `blocked_external` rows and local-vs-live qualification boundaries from `node packages/cli/dist/main.js closure --verify-failures`)

In **`Auto` (preflight)** mode, stop here and present the verification summary and release-note draft to the operator.

### Phase 4: Version Bump Review & Commit Gate (Explicit Confirmation Required)

If workspace `package.json` files need a version bump to `${VER#v}`:

1. Present the exact `git diff` of `package.json` / `package-lock.json` and the drafted release notes to the operator.
2. Request explicit confirmation via `AskUserQuestion` before creating the signed-off release commit:
   ```bash
   git commit -s -m "chore(release): prepare $VER"
   ```

### Phase 5: Annotated Git Tag Gate (Explicit Confirmation Required)

Confirm the exact target commit SHA (`git rev-parse HEAD`) with the operator before creating the local annotated tag:

```bash
git tag -a "$VER" -m "Release $VER"
git show "$VER" --quiet
```

#### Unpublished-Tag Recovery (When Replacing an Unpublished Tag)

If `$VER` already exists locally or as an unpublished remote tag and the operator explicitly selects **`Unpublished-Tag Recovery`**:

1. Verify that no immutable external release consumers depend on the tag.
2. If a draft/pre-release object exists on GitHub, export its notes before deletion (`gh release view "$VER" --json body --jq '.body'`).
3. Obtain explicit operator confirmation before deleting the old tag (`git tag -d "$VER"` / `gh release delete "$VER" --yes --cleanup-tag`) and recreating `git tag -a "$VER"`.

### Phase 6: Remote Push & Pre-Release Publication Gate (Explicit Confirmation Required)

Only after separate explicit operator confirmation in the active turn:

```bash
git push origin "$VER"
gh release create "$VER" \
  --title "$VER" \
  --notes-file <release-notes-file> \
  --prerelease
```

For `-rc.N` (or `-rcN`) candidate tags, stop after pre-release publication (`--prerelease` remains set; note `.github/workflows/ci.yml` also attaches `dist-release/*` and publishes `@gpustack/loopwright` under the `next` dist-tag on `v*` tag push).

### Phase 7: Official Release Promotion & Summary (Explicit Confirmation Required)

For a final GA version (`^v[0-9]+\.[0-9]+\.[0-9]+$`), request separate operator confirmation after verifying published release artifacts, then promote:

```bash
gh release edit "$VER" --prerelease=false --latest
gh release view "$VER" --json tagName,isPrerelease,isDraft,url
```

Record the immutable commit SHA, tag name, verification gate summary, and `Known Residual Boundaries` in the final operator report.
