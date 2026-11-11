# Task Contracts and Schemas

The exact alpha schemas, field ranges, and limits are in the
[task contract specification](../specs/2026-11-05-task-contracts-and-evidence.md).
All six persisted kinds use `apiVersion: loopwright.dev/v1alpha1` and the hierarchy
`metadata` / `spec`. Unknown fields and versions are rejected, including nested policy fields.
There are no permissive policy defaults or scalar coercions.

## Contents

- [Boundary](#boundary)

## Boundary

The private package exports `validateDocument`, `admitTask`, `digestArtifact`,
`identifyManifest`, `bindSubject`, `isWritablePath`, `aggregateUsage`,
`evaluateAcceptance`, and `constructRunResult`, plus readonly types and `LIMITS`.
Each operation returns `{ ok: true, value }` or `{ ok: false, errors }`.
Diagnostics contain fixed machine codes, JSON Pointer locations, and a validated check ID or null.
Structural input failures use the root location. Unknown fields use their containing record location.
Diagnostics do not echo arbitrary input values or unknown keys.
Claim paths start at `/claims` for `evaluateAcceptance` and `/candidate/checks` for `constructRunResult`.
Run-construction usage paths start at `/trusted/usage`; serialized RunResult request paths start at `/spec/usage/requests`.
`aggregateUsage` takes an array directly: its root is the empty pointer, and a duplicate second record is `/1`.
The separately passed byte inventory uses the reserved `/artifacts` argument namespace.

`validateDocument(input, kind)` checks shape and internal consistency.
It does not authenticate an admission, producer, or serialized passed matrix.
Only `constructRunResult` evaluates current host-selected evidence for the expected lock.

Inputs may be JSON text or ordinary JSON trees with enumerable own data properties.
Ordinary and null-prototype records and ordinary dense arrays are supported.
Accessors, functions, custom prototypes, non-enumerable data, symbols, undefined,
bigint, cycles, and shared object aliases are rejected. No ordinary getter or `toJSON` hook runs.
Numbers are safe integers, excluding negative zero. Strings must contain Unicode scalar values.
Exact labels additionally exclude whitespace and Unicode category C (control, format, surrogate,
private-use, and unassigned code points). Printable letters/symbols/combining marks are not normalized.
Returned values own their data and are deeply frozen.
Proxies, concurrent hostile mutation, and built-in prototype tampering are outside the supported domain.
This same-process JavaScript API is not a hostile-process security boundary.
Caller allocation and the engine's first own-key enumeration cannot be bounded by this library.

`digestArtifact` and explicit resolved inventories accept bounded ordinary Uint8Array/Buffer byte leaves.
They use native typed-array intrinsics and owned byte copies, ignoring shadowed instance getters/methods.
SharedArrayBuffer-backed, detached, and unsupported views are rejected.
Whole-byte hashing supports 8 MiB per artifact and 16 MiB total per evaluation.
Larger declared manifest sizes do not imply streaming verification support.

Tool allowlists use exact `ToolName` values such as `read` and `mcp__probe__allowed`.
Case is preserved. Internal task/role/check IDs retain their stricter Identifier grammar.
Format repair, implementation repair, and transport retries have separate zero-disable caps.
They share the parent model-call/token allowance. Caps do not reserve or reset that allowance.
Validation does not certify that an adapter can enforce a hard budget.

Scope uses exact POSIX relative names, final `dir/**`, or explicit `**`.
Other globs, parent traversal, absolute names, backslashes, encoded separators,
device names, and ambiguous segments are rejected. Protected patterns win.
Matching is case-sensitive and lexical. It does not resolve symlinks or enforce filesystem containment.

**See also**: [Documentation index](README.md)

**Next**: [Architecture](getting-started/architecture.md)
