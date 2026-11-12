# Library examples

`task.yaml` is a complete alpha TaskContract in human-authored YAML. `task.json` retains the equivalent JSON fixture for parity tests.

Run `loopwright init --directory ./drafts` to generate `controller.draft.yaml` and `registry.draft.yaml`. Review and approve their bindings before use; the drafts do not authorize execution.
The task's envelope and bounds begin as follows; use the complete [task.yaml](task.yaml) for parsing:

```yaml
apiVersion: loopwright.dev/v1alpha1
kind: TaskContract
spec:
  goal: Update the pinned package
  taskpack: package-update
  target:
    repository: team/repository # Replace with your target.
    baseRevision: base-1
    sourceRevision: source-1
    matrix: null
  scope:
    writable:
      - "packages/**"
    protected:
      - "packages/policy/**"
```

- **Excerpt**: Roles, budgets, steps, and acceptance remain in the complete file.
- **Evidence**: The example uses synthetic fixtures, not production verification.

See [controller examples](controller.md) for generated configuration and registry drafts.

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

For state integration, follow the [host protocol](../docs/contribute/state.md#host-protocol): create or explicitly reopen the same
identity, claim authority, reserve, authorize once, and record authenticated observations or explicit reconciliation.
These core JSON examples do not create a store, authenticate a receipt or grant a dispatch permit.

The [Pi adapter lifecycle](pi-adapter.md) demonstrates public execute, metadata consumption, safe capture and cleanup
using host-supplied authority and frozen inputs. It does not manufacture runtime identities or credentials.
