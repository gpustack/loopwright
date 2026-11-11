# CLI Operations

The local CLI validates trusted configuration, runs or resumes bounded work, and reports closure. Commands use the installed `loopwright` executable.

## Contents

- [Commands](#commands)
- [JSON and exit codes](#json-and-exit-codes)

## Commands

```sh
loopwright init --directory ./loopwright-config
loopwright check --config CONFIG --registry REGISTRY --registry-sha256 DIGEST --json
loopwright run --dry-run --config CONFIG --registry REGISTRY --registry-sha256 DIGEST --json
loopwright run --config CONFIG --registry REGISTRY --registry-sha256 DIGEST --repo REPO --run-root TRUSTED_ROOT --run-id demo
loopwright resume --config CONFIG --registry REGISTRY --registry-sha256 DIGEST --repo REPO --run-root TRUSTED_ROOT --run-id demo
loopwright status --run-root TRUSTED_ROOT --run-id demo --json
loopwright closure --verify-failures --json
```

`init` creates configuration; there is no `init-config` command in this revision. Run roots and trusted configuration must be outside the untrusted checkout. `check` and `run --dry-run` are static validation, not proof of readiness. `reconcile` accepts a receipt and `inspect` exports inspection artifacts; see [controller reference](../controller.md).

## JSON and exit codes

`--json` emits structured envelopes with kind, sequence, run identity and data; closure emits one closure envelope. Treat missing or untrusted state as unknown.

| Code | Meaning |
| --- | --- |
| 0 | Successful static command or completed/no-change run |
| 2 | Usage or configuration rejected |
| 3 | Unsupported capability or blocked work |
| 4 | Failed acceptance or execution |
| 5 | Allowance exhausted |
| 6 | Deadline expired |
| 7 | Reconciliation or ownership needed |
| 8 | Authoritative result unavailable or incident |
| 130 | Accounted SIGINT, subject to uncertainty precedence |
| 143 | Accounted SIGTERM, subject to uncertainty precedence |

Closure has command-specific exit semantics documented in the [closure reference](../closure-matrix.md#closure-command).

**See also**: [Controller](../controller.md)

**Next**: [Taskpack walkthrough](../walkthroughs/declarative-taskpack.md)
