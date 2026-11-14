# Spec: Tree-Anchored Overlay Manifests and Mediated Candidate Deletion

Status: Shipped
Type: Feature

## Summary
Loopwright adds tree-anchored overlay `ArtifactManifest` support and a mediated `delete` tool across `@loopwright/core`, `@loopwright/agent-pi`, `@loopwright/controller`, and `@loopwright/github-app`. Repositories with up to `65,536` tracked regular files and multi-hundred-megabyte Git trees execute without copying untouched blobs into CAS. Classic manifests within `128` entries and `4 MiB` preserve bit-for-bit digest compatibility.

## Motivation
### Goals
- Support bounded execution on repositories with up to `65,536` tracked regular files and arbitrary baseline blob volume. Target workloads include a `10,206`-file, `118.44 MiB` Go and C++ repository (`1,223,921`-byte `git ls-tree -rz` output and three `120000` automation symlinks). Loopwright's own `598`-file, `6.9 MiB` TypeScript workspace is a second target workload.
- Remove the four admission bottlenecks in [source.ts](../packages/controller/src/source.ts). These are the `1 MiB` `ls-tree` cap, `256`-file cap, `4 MiB` full-snapshot cap, and per-file `git cat-file` fan-out.
- Respect `@loopwright/state` `STATE_LIMITS.collection = 128` in [boundary.ts](../packages/state/src/boundary.ts) and the `32,768`-byte canonical manifest limit in [verifier-protocol.ts](../packages/controller/src/verifier-protocol.ts) and [capture.ts](../packages/controller/src/capture.ts). Never trust host-reported diff summaries during independent Worker verification (`scope.v1`, `no-change.v1`, and `json-artifact.v1`).
- Add a mediated `delete` tool in `@loopwright/agent-pi`. Roles that list `'delete'` can remove writable candidate files with full scope, checkpoint, recovery, and publication support.
- Add `.codex` to default `PROTECTED_AUTOMATION_PATHS` in [types.ts](../packages/github-app/src/types.ts) so `.codex` automation symlinks pass protected-symlink admission automatically.
- Keep `100%` bit-for-bit manifest and digest compatibility whenever the classic full manifest fits every existing state, canonical-byte, and inventory limit.

### Non-Goals
- Mutating or registering Git worktrees inside the target repository's `.git/worktrees` directory during candidate sandboxing or PR publication. Candidate directories must remain `.git`-free and symlink-free, and `@loopwright/agent-pi` never receives `<repo>/.git` access.
- Allowing candidate mutations in one run to exceed `128` overlay `entries`, `128` `deleted` paths, or `4 MiB` aggregate overlay bytes.
- Supporting case-only renames, file-to-directory replacements, unprotected Git symlinks (`120000`), or unprotected Git submodules (`160000`) in one run.
- Changing `@loopwright/state` SQLite schemas, raising `STATE_LIMITS.collection` above `128`, or raising the `32,768`-byte canonical `ArtifactManifest` ceiling.

## Proposal
Loopwright introduces a discriminated dual-shape `ArtifactManifest` contract. Classic full manifests (`{ entries }`) serve small repositories that fit within `128` files, `4 MiB`, and `32,768` canonical bytes. Tree-anchored overlay manifests (`{ baseTree, entries, deleted }`) serve larger repositories automatically. In overlay mode, `baseTree` binds untouched baseline files via verified Git commit and tree OIDs. Controller materializes raw baseline blobs directly via `git cat-file --batch`, avoiding `.gitattributes` conversions and keeping `<repo>/.git` outside `@loopwright/agent-pi`. Only added/modified files (`entries <= 128`) and deleted baseline paths (`deleted <= 128`) enter checkpoints, CAS artifacts, and verifier packets.

### User Stories
#### Story 1
As a maintainer, I want to run Loopwright on repositories with up to `65,536` tracked files and `100+ MiB` trees, so that toolchains see the full checkout without copying untouched blobs into CAS.

#### Story 2
As a Loopwright developer, I want automatic tree-overlay switching above classic bounds plus default `.codex` protection, so that Loopwright can dogfood its own workspace while keeping existing classic digests unchanged.

#### Story 3
As a security auditor, I want candidate additions, edits, deletions, and untouched baseline JSON checks verified cryptographically against `baseTree`, so that no out-of-scope mutation or host mapping spoof bypasses policy.

### Core Features & Acceptance Criteria
1. **Discriminated Dual-Shape `ArtifactManifest` Schema (`@loopwright/core`)**
   - [limits.ts](../packages/core/src/limits.ts) adds `LIMITS.overlayEntries = 128` and `LIMITS.baselineEntries = 65_536` while keeping classic `LIMITS.manifest = 256`.
   - [artifacts.ts](../packages/core/src/artifacts.ts) validates two mutually exclusive `ArtifactManifest.spec` shapes via a discriminated combinator in [contracts.ts](../packages/core/src/contracts.ts):
     - Classic full shape: `{ entries: readonly ArtifactRef[] }` (`0..256` entries), omitting `baseTree` and `deleted`. Existing serialized manifests and `candidateDigest` values remain bit-for-bit identical.
     - Tree-overlay shape: `{ baseTree: { objectFormat: 'sha1' | 'sha256', commitOid: string, treeOid: string }, entries: readonly ArtifactRef[], deleted: readonly string[] }`. Partial overlay shapes fail schema validation.
   - `commitOid` and `treeOid` enforce `^[0-9a-f]{40}$` when `objectFormat === 'sha1'` and `^[0-9a-f]{64}$` when `objectFormat === 'sha256'`.
   - In tree-overlay manifests, `entries` (`0..128`) and `deleted` (`0..128`) enforce `nameSchema` plus Git path rules (no `.git` segments and no segment `> 255` UTF-8 bytes). Both arrays require strict ascending UTF-16 code-unit order (`a < b`) with zero duplicates.
   - Across `entries` and `deleted` combined, `manifestSchema` rejects any case-insensitive exact match, NFC/NFD canonically equivalent match, or directory-vs-file prefix collision with `MANIFEST_AMBIGUOUS`. Case-only renames and file-to-directory replacements within one run are explicitly unsupported.
   - [acceptance.ts](../packages/core/src/acceptance.ts) validates `manifest.spec.entries` against `ResolvedArtifact[]` while binding `Subject.candidateDigest` over the full canonical `ArtifactManifest`.

2. **Scalable Source Admission, Raw Baseline Materialization, and Minimal-Overlay Rejection (`@loopwright/controller`)**
   - [source.ts](../packages/controller/src/source.ts) inspects `sourceObject` with one `git ls-tree -r -l -z --full-tree` call bounded at `16 MiB` stdout and `65,536` regular files (`LIMITS.baselineEntries`).
   - Git symlinks (`120000`) and gitlinks (`160000`) are skipped when covered by `task.spec.scope.protected` and refused with `CAPABILITY_UNSUPPORTED` otherwise.
   - Across all non-skipped regular files, `freezeSource` sorts by UTF-16 code-unit order and refuses case-insensitive duplicates, directory-vs-file prefix collisions, or Unicode NFC/NFD collisions with `CAPABILITY_UNSUPPORTED`.
   - `freezeSource` selects classic `version: 1` `full` mode **if and only if** `count <= 128`, `totalBytes <= 4,194,304`, `Buffer.byteLength(canonical(manifest)) <= 32,768`, and `Buffer.byteLength(inventoryJson) <= 262,144`. Otherwise it selects `version: 2` `tree_overlay` mode:
     - Resolves `treeOid` (`sourceObject^{tree}`) and `objectFormat` (`sha1` or `sha256`), verifying `commitOid === resolvedSourceObject`.
     - Stores compact baseline entries (`<mode>\t<oid>\t<byteLength>\t<jsonName>\n`) in a bounded NDJSON `source-tree` artifact (`<= 8 MiB` in `ArtifactStore.put`) parsed by a dedicated line-bounded reader (`<= 65,536` rows).
     - Emits initial `ArtifactManifest` with `{ baseTree, entries: [], deleted: [] }` and `artifacts: []`.
   - `FrozenSource` supports `version: 1 | 2`. `restoreSource` re-verifies `baseObject`, `sourceObject`, `commitOid`, `treeOid`, and `source-tree` digest integrity, refusing drift with `TARGET_MISMATCH`.
   - Before opening `@loopwright/agent-pi` in `tree_overlay` mode, Controller materializes raw baseline blobs into `join(hostDirectory, 'baseline')` via `git cat-file --batch` (never `git checkout-index`, preventing `.gitattributes` `eol`/`ident`/`filter` mutations and hook execution). Files are created with `O_CREAT | O_EXCL | O_NOFOLLOW` and explicit `chmod` (`0o444` for `100644`, `0o555` for `100755`), honoring run deadlines and abort signals.
   - [capture.ts](../packages/controller/src/capture.ts) (`adoptRoleCapture`) and [recovery.ts](../packages/controller/src/recovery.ts) (`restoredCandidate`) preserve `baseTree` and `deleted` without stripping them.
   - Controller validates **Canonical Minimal Overlay** invariants on every captured or restored `tree_overlay` candidate and **rejects** violations (`RECOVERY_REQUIRED`, never rewriting digests):
     - `candidate.spec.baseTree` equals `source.spec.baseTree`.
     - Every path in `candidate.spec.deleted` exists in `source-tree` (excluding skipped protected symlinks/gitlinks).
     - Every baseline path in `candidate.spec.entries` differs in Git blob OID (`"blob <len>\0" + bytes`) from its `source-tree` entry.
     - Every path in `candidate.spec.entries` has zero case-insensitive, NFC/NFD, or directory/file prefix collisions with `(baselinePaths \ candidate.spec.deleted)`.

3. **Mediated `delete` Tool, Baseline Index Verification, and Targeted Relock (`@loopwright/agent-pi`)**
   - `'delete'` (`{ path: string }`) is added across all tool-list boundaries: custom `ToolDefinition` in [tools.ts](../packages/agent-pi/src/tools.ts), [execution.ts](../packages/agent-pi/src/execution.ts), [sdk-worker.ts](../packages/agent-pi/src/sdk-worker.ts) (raising the tool-name cap from `6` to `8`), [policy.ts](../packages/agent-pi/src/policy.ts), [registry.ts](../packages/controller/src/registry.ts), and mutating-role detection in [controller.ts](../packages/controller/src/controller.ts).
   - `Execution` operation receipts include an explicit `deleted: boolean` discriminator alongside `before` and `after` so succeeded `delete` (`after: null, deleted: true`) is unambiguous from failed writes. Crash-after-unlink with an unconfirmed operation refuses `RECOVERY_REQUIRED` without silent retry.
   - [candidate.ts](../packages/agent-pi/src/candidate.ts) switches `manifest()` sorting to strict UTF-16 code-unit order (`a < b`), fixing mixed-case session restore (`README.md` vs `package.json`). It enforces `<= 4,194,304` aggregate overlay bytes (`OUTPUT_LIMIT` at tool time) and `<= 32,768` canonical manifest bytes.
   - `Candidate.prepareDelete` enforces `#writable(path)` (including case-folded protected checks), refuses missing paths, directories, symlinks, or `nlink > 1` files with `TOOL_DENIED`, unlinks regular files under `guard()`, and prunes empty subdirectories up to `candidate.root` using a shared deterministic helper also used during restore.
   - In `tree_overlay` mode, `PiOpenInputV2['candidate']` supplies `baseline: { directory, entries }`:
     - [session-host.ts](../packages/agent-pi/src/session-host.ts) and [host-session.ts](../packages/agent-pi/src/host-session.ts) move/verify `baseline.directory` into `candidateDir`, apply restored `deleted` unlinks (with deterministic empty-dir pruning) and `artifacts` writes, verify `0o444`/`0o555` file modes via `lstat`, lock all directories in `candidateDir` to `0o555`, and record `(ino, size, mtimeMs, mode, nlink)` stat fingerprints for untouched baseline files.
     - `Candidate` lifts the `257`-entry `readdir` cap for baseline directories while capping `#overlayEntries <= 128` and `#deleted <= 128`. On first touch (`read`, `write`, `edit`, or `delete`) of an untouched baseline file, `Candidate` verifies its raw Git blob OID (`sha1` or `sha256` per `baseTree.objectFormat`) against `baseline.entries` before reading or mutating.
     - `Candidate.commit` writes `0o555` when `baselineEntry?.mode === '100755'` and `0o444` otherwise, keeping edited baseline scripts executable in sandbox `bash`. Reverting a file to its baseline Git blob OID removes it from `#overlayEntries` and `#deleted`.
     - At `capture`, `Candidate.manifest()` verifies untouched baseline files via an O(N) `lstat` fingerprint walk (`RECOVERY_REQUIRED` on any out-of-band modification or unexpected file). [capture.ts](../packages/agent-pi/src/capture.ts) and [decode-capture.ts](../packages/agent-pi/src/decode-capture.ts) write only `manifest.spec.entries` (`<= 128` files) into `workspace.ndjson`.
     - `HostExecution` gates `'write'`, `'edit'`, and `'delete'`, unlocks ancestor directories root-to-leaf (`0o755`), and relocks leaf-to-root (`0o555`) in `finally`, tolerating `ENOENT` only for subdirectories pruned by that `delete` and verifying `0o555` via `lstat`.

4. **Independent Verifier Protocol and Merkle Baseline Proof (`@loopwright/controller`)**
   - [verifier-protocol.ts](../packages/controller/src/verifier-protocol.ts), [verification.ts](../packages/controller/src/verification.ts), and [refusal-record.ts](../packages/controller/src/refusal-record.ts) keep `ManifestDescriptor` keys strictly `{ metadataId, ref, entryCount }` (`entryCount = entries.length <= 128`).
   - Classic manifests keep their exact binary inventory encoding (`count` u32 `0..256`). Overlay manifests use magic u32 tag `0x4c574f56` (`> 256`), followed by `objectFormat`, `commitOid`, `treeOid`, `entries` (`<= 128`), and `deleted` (`<= 128`), fitting strictly within `<= 32,772` bytes per side and the `81,932`-byte inventory packet cap.
   - `evaluatePacket` rejects mixed classic/overlay shapes or mismatched `baseTree` anchors with `ARTIFACT_INVALID`.
   - `no-change.v1` compares both `entries` and `deleted` (`candidate_changed` on any difference). `scope.v1` checks `isWritablePath(contract, name)` across every added, modified, or deleted path (`outside_scope` on any disallowed path).
   - For `json-artifact.v1` in `tree_overlay` mode: modified paths validate from `entries`; `deleted` paths fail with `missing_file`; untouched baseline paths carry a bounded Git Merkle path proof (`<= 16` raw Git tree objects, `<= 262,144` raw tree proof bytes) plus the target blob (`<= 1,032,184` bytes). The Worker hashes each tree object from `source.spec.baseTree.treeOid` down to `(mode, name, blobOid)`, verifies `"blob <len>\0" + payloadBytes` matches `blobOid`, and parses JSON. Oversize proofs or headers emit `VerifierSizingFailure` (`OUTPUT_LIMIT` -> typed `blocked` check).

5. **Default `.codex` Protection, Role Tool Compilation, and Turnkey Overlay Support (`@loopwright/github-app`)**
   - [types.ts](../packages/github-app/src/types.ts) adds `'.codex'` to `PROTECTED_AUTOMATION_PATHS`, propagating automatically through `effectiveProtectedPaths` and `sandbox.ts` writable/protected overlap refusal.
   - [taskpack.ts](../packages/github-app/src/taskpack.ts) appends `'delete'` to compiled author role and profile tools (`['read', 'write', 'edit', 'bash', 'delete']`). [compile-taskpack.ts](../packages/taskpack-runner/src/compile-taskpack.ts) keeps its frozen `['read', 'write', 'edit', 'bash']` default so offline runner-parity fixtures stay unchanged.
   - [turnkey.ts](../packages/github-app/src/turnkey.ts) updates both `startLocalCommandGateServer` (`command.v1`) and `startNativePullRequestPublisherServer`:
     - In `tree_overlay` mode, `command.v1` first materializes non-skipped baseline regular files from `manifest.spec.baseTree` via `git ls-tree -rlz` (`<= 16 MiB`, `<= 65,536` entries) and `git cat-file --batch`, unlinks `manifest.spec.deleted`, and overlays `snapshot.files` (preserving `100755` executable mode) so local check scripts see the full candidate tree.
     - PR publication constructs commits via pure Git plumbing over a private temporary `GIT_INDEX_FILE` (`git read-tree` anchored on `baseRevision^{tree}`, carrying writable `sourceRevision^{tree}` regular entries when revising an open PR, writing `snapshot.files` via `git hash-object -w --stdin` + `git update-index --index-info` preserving `100755` modes, removing `manifest.spec.deleted` in overlay mode or omitted writable `sourceModes` in classic mode via `git update-index --force-remove`, `git write-tree`, and `git commit-tree` with the DCO `Signed-off-by` trailer), leaving `<repo>/.git/worktrees` untouched and never deleting untouched `tree_overlay` files.

### Notes / Constraints / Caveats
- Preserve strict ESM `NodeNext` imports (`.js` specifiers), `no any`, null-prototype safe validation, DCO sign-off, and `@loopwright/agent-pi` root export lock (`['decodePiCapture', 'describePiAdapterFiles', 'openPiAdapter', 'openPiAdapterV2']`).
- Cryptographic strength note: in Git `sha1` repositories, untouched baseline blobs inherit Git's `160`-bit `commitOid`/`treeOid` binding while all overlay `entries` carry `256`-bit SHA-256 `ArtifactRef`s; Git `sha256` repositories bind both at `256`-bit strength.
- Updating [verifier-protocol.ts](../packages/controller/src/verifier-protocol.ts) rotates built-in check handler digests (`handlers.ts`), which is expected across controller upgrades; keep `closure --verify-failures` green.

### Boundaries
- **Always:** Select classic `full` mode iff `count <= 128`, `bytes <= 4 MiB`, `canonical <= 32,768`, and `inventory <= 262,144`; materialize raw blobs via `git cat-file --batch` inside Controller and `command.v1`; verify untouched `json-artifact.v1` targets via Git Merkle proofs; and enforce `isWritablePath` on `entries` and `deleted`.
- **Ask first:** Changing `@loopwright/state` `STATE_LIMITS.collection` (`128`), raising `32,768`-byte manifest limits, or changing `taskpack-runner` frozen parity tool lists.
- **Never:** Run `git checkout-index` on untrusted `.gitattributes`, expose `<repo>/.git` to `@loopwright/agent-pi`, rewrite candidate digests inside Controller capture/recovery, or allow `delete` on `protected` paths.

### Risks and Mitigations
- **Risk:** Array sizes `129..256` pass `LIMITS.manifest` (`256`) yet fail `writeCheckpoint` (`STATE_LIMITS.collection = 128`) or exceed `32,768` canonical bytes. → **Mitigation:** Cap overlay `entries` and `deleted` at `128` each, preflight `canonical(manifest) <= 32,768`, and switch `freezeSource` to `tree_overlay` whenever classic bounds (`128` entries, `32,768` canonical bytes, `262,144` inventory bytes, `4 MiB`) would be exceeded.
- **Risk:** `git checkout-index` executes filter drivers or mutates line endings via in-tree `.gitattributes`, breaking blob OID verification. → **Mitigation:** Stream raw blobs via `git cat-file --batch` in Controller and write files directly with `O_CREAT | O_EXCL | O_NOFOLLOW` and explicit `0o444`/`0o555` modes.
- **Risk:** `adoptRoleCapture` or `restoredCandidate` strips `baseTree`/`deleted`, or `localeCompare('en')` vs code-unit sorting splits native and canonical digests. → **Mitigation:** Preserve full overlay spec fields in `capture.ts` and `recovery.ts`, and sort by UTF-16 code units in `Candidate.manifest()`.
- **Risk:** O(depth) directory relock hits `ENOENT` on a subdirectory pruned by `delete` and leaves parent directories unlocked (`0o755`). → **Mitigation:** Relock leaf-to-root, skip only directories removed by that operation, and assert `0o555` via `lstat` on remaining ancestors.

## Design Details
### Commands
Execution environment: local macOS (`darwin/arm64`) or Linux (`linux/x64`, `linux/arm64`) workspace with Node.js `26.x`, `npm` `11.x`, Git `2.x`, and Hugo `0.152.2` extended.

- Build all packages: `npm run build`
- Typecheck workspace and tests: `npm run typecheck`
- Lint sources: `npm run lint`
- Lint connected documentation: `npm run lint:docs`
- Build Hugo documentation site: `npm run site`
- Run full test suite: `npm test`
- Run focused package tests: `npx tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-build/packages/<pkg>/test/*.test.js`
- Verify closure and failure matrix: `node packages/cli/dist/main.js closure --verify-failures`

### Project Structure
- `packages/core/src/{limits,contracts,artifacts,acceptance,index}.ts`: `LIMITS.overlayEntries = 128`, `LIMITS.baselineEntries = 65_536`, discriminated `ArtifactManifest` (`baseTree` + `deleted`), and `BaseTreeAnchor` export.
- `packages/agent-pi/src/{types,types-v2,preflight,policy,tools,sdk-worker,execution,candidate,session-host,host-session,capture,decode-capture,recovery}.ts`: custom `'delete'` tool (`cap = 8`), `deleted` receipt discriminator, baseline OID first-touch check, `0o555` script mode preservation, `lstat` capture fingerprint, UTF-16 code-unit sort, and O(depth) leaf-to-root relock.
- `packages/controller/src/{source,capture,recovery,registry,controller,verification,verifier-protocol,refusal-record,progress,types}.ts`: `16 MiB` `ls-tree -rlz` admission, exact classic-vs-overlay selector, NDJSON `source-tree` (`<= 8 MiB`), raw `cat-file --batch` baseline materialization, minimal-overlay rejection, `0x4c574f56` inventory framing, and Git Merkle proof verification for `json-artifact.v1`.
- `packages/github-app/src/{types,taskpack,turnkey}.ts`: `'.codex'` in `PROTECTED_AUTOMATION_PATHS`, `'delete'` in compiled author tools, `command.v1` baseline overlay materialization, and private-index Git plumbing commit builder for turnkey PR publication.
- `docs/configuration/{task-contract,taskpack}.md`, `docs/contribute/{evidence,pi-adapter,internals,github-app-internals}.md`, `docs/README.md`: connected documentation updates.

### Code Style
Follow strict ESM `NodeNext`, explicit `readonly` domain records, format-aware hex validation, null-prototype safe parsing, and deterministic refusal codes as in [artifacts.ts](../packages/core/src/artifacts.ts):

```ts
export interface BaseTreeAnchor {
  readonly objectFormat: 'sha1' | 'sha256';
  readonly commitOid: string;
  readonly treeOid: string;
}
```

### Implementation Plan
- [x] **T1 · Core discriminated `ArtifactManifest` (`baseTree` & `deleted`) and overlay/baseline limits**
      Blocked by: None
      Owns: `packages/core/src/**`, `packages/core/test/**`
      Gate: review
      Acceptance: `LIMITS.overlayEntries = 128` and `LIMITS.baselineEntries = 65_536` land in `packages/core/src/limits.ts`. `manifestSchema` keeps classic `{ entries }` (`0..256`) manifests bit-for-bit unchanged and validates `{ baseTree, entries, deleted }` (`0..128` each) with format-matched hex OID regexes (`40` vs `64`), `.git`/segment-length path rules, strict UTF-16 code-unit order on both arrays, and cross-set case/NFC-NFD/prefix `MANIFEST_AMBIGUOUS` checks. Classic `128`-entry and overlay `128+128`-entry manifests round-trip cleanly through `@loopwright/state` `writeCheckpoint`.
      Verify: `npm run build && npm run typecheck && node --test --test-concurrency=1 .test-build/packages/core/test/*.test.js .test-build/packages/state/test/*.test.js`

- [x] **T2 · Agent-Pi mediated `delete` tool, baseline OID index, mode/stat guards, and leaf-to-root relock**
      Blocked by: T1
      Owns: `packages/agent-pi/src/**`, `packages/agent-pi/test/**`
      Gate: review
      Acceptance: `'delete'` (`{ path: string }`) lands in `tools.ts`, `sdk-worker.ts` (`<= 8` tools), `policy.ts`, and `execution.ts` with `deleted: boolean` receipt discrimination and `RECOVERY_REQUIRED` on unconfirmed crash-after-unlink. `Candidate` sorts in UTF-16 code-unit order, enforces `<= 4 MiB` overlay bytes and `<= 32,768` canonical bytes at tool time, verifies untouched baseline files by Git blob OID on first touch, preserves `0o555` for `100755` baseline files, lifts the `257`-entry directory cap for baseline directories, and validates untouched files via O(N) `lstat` fingerprints at `capture`. `RuntimeSession` and `HostSession` verify `0o444`/`0o555` modes and lock directories to `0o555`; `HostExecution` gates `write`/`edit`/`delete` with leaf-to-root relock; `workspace.ndjson` stores only `entries`; root exports stay locked.
      Verify: `npm run build && npm run typecheck && node --test --test-concurrency=1 .test-build/packages/agent-pi/test/*.test.js`

- [x] **T3 · Controller `tree_overlay` admission, raw `cat-file` materialization, and Merkle verifier protocol**
      Blocked by: T1, T2
      Owns: `packages/controller/src/**`, `packages/controller/test/**`
      Gate: review
      Acceptance: `freezeSource` runs one `git ls-tree -r -l -z --full-tree` call (`<= 16 MiB`, `<= 65,536` regular files), enforces case/NFC-NFD/prefix uniqueness, selects classic `version: 1` iff `count <= 128 && bytes <= 4 MiB && canonical <= 32768 && inventory <= 262144`, and otherwise emits `version: 2` `tree_overlay` with an `<= 8 MiB` NDJSON `source-tree`. Controller materializes raw baseline blobs via `git cat-file --batch` (`O_CREAT | O_EXCL | O_NOFOLLOW`, `0o444`/`0o555`), treats `'delete'` roles as mutating, preserves `baseTree`/`deleted` in `capture.ts` and `recovery.ts`, and rejects non-minimal overlays. `verifier-protocol.ts`, `verification.ts`, and `refusal-record.ts` keep `ManifestDescriptor` unchanged, frame overlays with `0x4c574f56`, reject mixed shapes, verify `scope.v1` and `no-change.v1` over `entries` + `deleted`, and authenticate untouched `json-artifact.v1` blobs via Git Merkle path proofs. `closure --verify-failures` stays green.
      Verify: `npm run build && npm run typecheck && node --test --test-concurrency=1 .test-build/packages/controller/test/*.test.js && node packages/cli/dist/main.js closure --verify-failures`

- [x] **T4 · GitHub App `.codex` default protection, `'delete'` role compilation, `command.v1` overlay materialization, and Git plumbing PR publication**
      Blocked by: T2, T3
      Owns: `packages/github-app/src/**`, `packages/github-app/test/**`
      Gate: review
      Acceptance: `PROTECTED_AUTOMATION_PATHS` includes `'.codex'` (refusing writable `.codex` overlap in `sandbox.ts`). `compileTaskpack` compiles `['read', 'write', 'edit', 'bash', 'delete']` for author roles while `taskpack-runner` parity suites remain green. `startLocalCommandGateServer` materializes `baseTree` regular files (`<= 16 MiB`, `<= 65,536` entries) via `git cat-file --batch`, unlinks `deleted`, and overlays `snapshot.files` so `command.v1` scripts see full `tree_overlay` checkouts. `startNativePullRequestPublisherServer` builds commits via private `GIT_INDEX_FILE` Git plumbing (`read-tree`, `hash-object -w`, `update-index` preserving `100755` modes and removing `deleted` in overlay mode or omitted writable files in classic mode, `write-tree`, `commit-tree` with DCO sign-off) without touching `<repo>/.git/worktrees` or deleting untouched `tree_overlay` files. Integration tests cover a `600+`-file repository (initial PR + `revise`) with `.claude` and `.codex` symlinks and `.gitattributes` filters.
      Verify: `npm run build && npm run typecheck && node --test --test-concurrency=1 .test-build/packages/github-app/test/*.test.js .test-build/packages/taskpack-runner/test/*.test.js .test-build/packages/cli/test/*.test.js`

- [x] **T5 · Connected documentation and Hugo site synchronization**
      Blocked by: T4
      Owns: `docs/**`, `README.md`, `examples/**`, `site/**`, `scripts/check-docs.mjs`
      Acceptance: `docs/configuration/{task-contract,taskpack}.md`, `docs/contribute/{evidence,pi-adapter,internals,github-app-internals}.md`, and `docs/README.md` (`Specs` table) document `tree_overlay` scaling (`65,536` baseline files, `128` overlay entries/deletions), `.codex` default protection, and the mediated `delete` tool. All edited pages satisfy `loopwright-docs` rules (80% ASD-STE100, Macro + Micro YAML blocks, zero broken links).
      Verify: `npm run lint:docs && npm run site`

### Test Plan
[x] I/we understand the owners of the involved components may require updates to existing tests to make this
code solid enough prior to committing the changes necessary to implement this enhancement.

#### Prerequisite testing updates
Update any exact-key snapshot assertions on `LIMITS` in `packages/core/test/` for `overlayEntries` and `baselineEntries`, and handler digest assertions in `packages/controller/test/` if pinned to pre-overlay check bundles.

#### Unit tests
- `@loopwright/core` & `@loopwright/state`: `2026-11-13` - `100%` of new `baseTree`/`deleted` branches (`128`-entry classic and `128+128` overlay `writeCheckpoint` round-trips, `41`-char/uppercase/mismatched OID rejection, unsorted/duplicate/NFC-NFD/prefix `MANIFEST_AMBIGUOUS`, partial shape failure).
- `@loopwright/agent-pi`: `2026-11-13` - `>= 90%` branch coverage on `delete` and `tree_overlay` paths (missing/dir/symlink/protected/`nlink>1` refusals, crash-after-unlink `RECOVERY_REQUIRED`, edit-then-revert and delete-then-recreate `100755` normalization, `>257`-entry baseline directory writes, first-touch OID verification, `umask 077` `0o444`/`0o555` modes, mid-chain `ENOENT` leaf-to-root relock, out-of-band baseline edit `lstat` capture refusal, `sdk-worker` `7`-tool acceptance).
- `@loopwright/controller`: `2026-11-13` - `>= 90%` branch coverage on overlay admission and verification (`240`-file `40`-char path auto-switching to `tree_overlay`, `.gitattributes` `eol=crlf`/`ident`/`filter=lfs` raw blob fidelity, `adoptRoleCapture` + `restoredCandidate` `baseTree`/`deleted` preservation, mixed-case `README.md`/`package.json` repair + compaction restore, `restoreSource` v2 `TARGET_MISMATCH` after branch move, `['read', 'delete']` mutating role classification, `0x4c574f56` mixed-shape/truncated-list `ARTIFACT_INVALID`, `no-change.v1` deleted-only `candidate_changed`, `scope.v1` deleted protected `outside_scope`, `json-artifact.v1` Merkle proof valid/tampered/oversize `VerifierSizingFailure` at exact `16,384`/`32,768`/`81,932` byte boundaries).
- `@loopwright/github-app`: `2026-11-13` - `>= 90%` branch coverage on `.codex` writable-overlap refusal, `'delete'` author tool compilation with `taskpack-runner` parity intact, `command.v1` baseline overlay materialization, and private `GIT_INDEX_FILE` commit building (preserving untouched `tree_overlay` files, `100755` modes, `deleted` removal, and `revise` delta carry-forward).

#### Integration tests
- `packages/controller/test/`: Full run + `resume` + repair + compaction cycle on a `600`-file mixed-case repository exercising `read`, `bash`, `write`, `edit`, `delete`, edit-then-revert `no_change`, `outside_scope` deletion refusal, and Merkle-authenticated baseline `json-artifact.v1`.
- `packages/github-app/test/`: Turnkey Action run + `revise` run on a `600+`-file repository with `.claude/skills` and `.codex/hooks.json` symlinks and `.gitattributes` rules, verifying zero untouched CAS copies, `command.v1` full-tree visibility, `delete` retirement, untouched writable baseline preservation in published PR commits, and zero `<repo>/.git/worktrees` mutations.

#### e2e tests
- Run `node packages/cli/dist/main.js closure --verify-failures` (`18` `closed_local`, `5` `unprovisioned_external`, `14/14` failure scenarios). Run a local read-only admission smoke check against Loopwright's `598`-file repository to confirm self-hosting readiness. Live GitHub-hosted runner execution remains gated on repository deployment credentials.

## Alternatives
- **Raise `LIMITS.manifest` and `STATE_LIMITS.collection` to `65,536` and keep full-manifest snapshots:** Rejected. A `10,206`-entry JSON manifest exceeds `1.3 MiB`. That breaks `@loopwright/state` `64 KiB` call caps and `32 KiB` verifier packet bounds while copying `100+ MiB` of untouched blobs into CAS.
- **Populate `candidateDir` via `git worktree add` or `git checkout-index` inside `@loopwright/agent-pi`:** Rejected. `git worktree add` mutates `<repo>/.git/worktrees` and leaks `.git` pointers; `git checkout-index` honors in-tree `.gitattributes` (`eol`, `ident`, `filter`) and widens `@loopwright/agent-pi` authority to read `<repo>/.git`. Streaming raw blobs via `git cat-file --batch` inside Controller preserves exact blob OIDs and runtime isolation.
- **Pass an unverified host `(path -> blob)` map to `json-artifact.v1` in `tree_overlay` mode:** Rejected. Trusting a host path map weakens independent Worker verification. A bounded Git Merkle tree-path proof from `baseTree.treeOid` authenticates untouched baseline JSON files with zero host trust.

## Open Questions
None.
