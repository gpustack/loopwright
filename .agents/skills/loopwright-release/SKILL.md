---
name: loopwright-release
description: Run the explicitly authorized Loopwright release workflow.
disable-model-invocation: true
---

# Loopwright Release

Use SemVer2 tags matching `^v[0-9]+\.[0-9]+\.[0-9]+(-rc[0-9]+)?$`. Each external publication or promotion requires its own authorization.

## Phase 0: Scope

Confirm version, revision, authority and release destination.

## Phase 1: Audit

Run `loopwright closure --verify-failures`; retain all gaps and failure evidence.

## Phase 2: Validate

Run `npm run build`, `npm run typecheck`, `npm run lint`, `npm run lint:docs`, and `npm run site`.

## Phase 3: Synthesize notes

Group Conventional Commits into Features, Fixes, Refactor, Docs, Limitations and Appendix; identify unqualified capabilities.

## Phase 4: Review

Review exact artifacts and notes with the authorized owner.

## Phase 5: Tag

Create the signed-off release commit as applicable and create the approved tag at the reviewed revision.

## Phase 6: Publish

Publish only with explicit authorization and verify artifact identity.

## Phase 7: Promote

Promote an approved candidate only with separate authorization; record immutable references and remaining limitations. See [closure](../../../docs/closure-matrix.md).
