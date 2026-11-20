# Workspace Internals and Boundaries

The workspace separates contracts, authority, execution, verification and publication into explicit packages.

## Contents

- [Build order](#build-order)
- [Authority boundaries](#authority-boundaries)
- [Architecture decisions](#architecture-decisions)

## Build order

The root build compiles `core`, `state`, `agent-pi`, `controller`, `taskpack-runner`, `memory`, `decisions`, `taskpack`, `github-app`, then `cli`. Run `npm run build`, `npm run typecheck`, and `npm run lint` from the root.

## Authority boundaries

Core owns contracts, canonical digests, and verified CAS descriptor acceptance; state owns fenced local authority; the adapter owns isolated execution; controller coordinates CAS blob storage (`<artifactsDir>/blobs/sha256/<hex>`), independent verification, and authenticated effects.

The runner owns offline parity, memory owns reviewed compaction, decisions provide bounded advice, `@loopwright/taskpack` owns generic declarative taskpacks and OS sandboxes, `@loopwright/github-app` owns GitHub intake, token scoping, and streamed PR publication, and CLI exposes local operations. Preserve unknown outcomes and do not promote fixture evidence into deployed acceptance.

Controller admits `version: 2` `tree_overlay` sources with `git ls-tree -r -l -z --full-tree`.
Admission permits up to 65,536 regular files, an 8 MiB `source-tree` NDJSON artifact, and overlays up to 16,384 files / 16 GiB via `1 MiB` streaming CAS blobs and single-descriptor read-only projections.
It skips protected Git symlinks (`120000`) and gitlinks (`160000`); unprotected ones fail admission.
It rejects case, NFC-NFD, and file-prefix collisions.

Controller materializes raw baseline blobs with `git cat-file --batch`.
This bypasses `.gitattributes` filters and preserves Git blob bytes.

## Architecture decisions

The public site contains 13 pages; [Development](../development.md) and this guide remain repository-only. Run `npm run lint:docs`, `node scripts/check-docs.mjs --report`, and `npm run site` after documentation changes.

YAML-first configuration uses `yaml` with the strict 1.2 core schema. Repository issue and PR templates live under `.github/`; the six `.agents/skills/loopwright-*` guides cover overview, docs, step driving, code review, issue and PR preparation, and releases.

[Local state authority](adr/0001-local-state-authority.md) records the storage and fencing decision. [Isolated Pi SDK](adr/0002-isolated-pi-sdk.md) records runtime isolation and its limitations. Specifications retain rationale and measurements; current source determines implementation.


---

**See also** — [Development and Verification](../development.md) (build and verification commands)

**Next** → [Canonical Identity and Digests](identity.md) — trace canonical identities and their digests.
