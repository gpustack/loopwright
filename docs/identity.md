# Identity and original bytes

Task contracts identify both the destination `baseRevision` and candidate `sourceRevision`.
The host supplies immutable revision identities. Equal values are allowed.
The library performs no Git, filesystem, or network lookup.

Canonical JSON sorts object keys by UTF-16 code units, preserves every array order,
uses standard JSON escaping and no insignificant whitespace, and admits only safe-integer numbers.
Unpaired surrogates, negative zero, non-finite numbers, and unsupported values are rejected first.
This restricted number domain is not full RFC 8785 number support.
The serializer receives only owned validated data and invokes no custom serialization.

The SHA-256 hash domains are UTF-8 prefixes with a terminating NUL byte:

| Digest | Prefix and payload |
| --- | --- |
| contractHash | `loopwright.dev/task-contract/v1alpha1` + NUL + canonical TaskContract |
| lockHash | `loopwright.dev/task-lock/v1alpha1` + NUL + canonical `{admissionId,runId,contractHash}` |
| candidateDigest | `loopwright.dev/artifact-manifest/v1alpha1` + NUL + canonical ArtifactManifest |
| targetMatrixDigest | `loopwright.dev/target-matrix/v1alpha1` + NUL + canonical matrix; null for no matrix |
| ArtifactRef.digest | SHA-256 of original bytes, without a domain prefix |

Contract changes to permissions, source, base, model, tool spelling/order, repair caps,
budgets, matrix, or acceptance change its identity. A new admission/run changes the lock identity.
A destination-base-only change invalidates old evidence even when source and candidate bytes stay fixed.
Every parsed TaskLock recomputes both stored hashes.

Manifests contain normalized relative names, byte lengths, and lowercase SHA-256 digests.
Duplicate names, ASCII case-fold collisions, and file/descendant conflicts are rejected.
Entry order remains part of manifest identity. Artifact bytes are never decoded or reformatted for hashing.
Candidate manifest identity and each referenced original-byte digest are separate checks.
Digests identify content; they do not authenticate its producer.
