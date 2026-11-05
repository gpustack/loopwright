# Library examples

`task.json` is a complete alpha TaskContract with synthetic-fixture acceptance.
The other files are deterministic RunResult examples produced through the public library:

| File | Meaning |
| --- | --- |
| satisfied.json | Every required fixture check passed |
| failed.json | Explicit failed verification is retained |
| missing.json | Missing required submission is not_run; acceptance is false |
| unknown-usage.json | Fixture acceptance passed while usage remains unknown and partial |

The integration tests recreate the lock, manifest, original-byte inventory, eligible observation,
acceptance matrix, and run result. They compare these outputs and parse each result as data.
The fixture patch is UTF-8 `candidate patch\n`; its log is UTF-8 `test output: pass\n`.
These observations are synthetic example data, not receipts from a real external verifier.

Parsing these files does not authorize acceptance for another run.
A host must supply its own expected lock and authenticated current evidence to `constructRunResult`.

For state integration, follow the [host protocol](../docs/state.md#host-protocol): create or explicitly reopen the same
identity, claim authority, reserve, authorize once, and record authenticated observations or explicit reconciliation.
These core JSON examples do not create a store, authenticate a receipt or grant a dispatch permit.
