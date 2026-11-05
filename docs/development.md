# Local development

Tested: macOS arm64, Node v26.13.0, npm 11.20.0.
Run these commands at the repository root:

```sh
npm ci
npm run build
npm run typecheck
npm run lint
npm test
```

Dependencies are development-only and exactly locked. The minimatch override pins its patched version
for the development lint toolchain. No runtime dependency is installed for the core library.
After installation, checks need no credentials, model, deployed service, Docker, or accelerator.
The package is private and is not published.

Build emits `packages/core/dist` and `packages/state/dist`; test compilation emits `.test-build`.
Both are ignored, as are dependencies and root `.claude` scratch.
Git permits `.claude/skills` and `.claude/settings.json`; reports, handoffs, and worktrees remain ignored.
Tests use Node's test runner and public package boundaries. Private constructor seams isolate clock/transaction
faults over actual SQLite; they are absent from the public state factories. Test files run serially to bound owned children.
The integration fixture runs authoring, admission, candidate identity, evidence evaluation,
and honest run construction. Example outputs are checked against this flow.

Boundary tests cover JSON grammar and duplicate decoded keys, unsafe objects/getters,
immutability, Unicode/number restrictions, scope, graph relationships, identity substitution,
evidence levels/bytes, result status, and partial usage.
Limit tests use exact sizes and one-over-limit cases. Their assertions do not use elapsed-time thresholds.
The graph tests exercise the 256-node/2,048-edge caps.
The parser tests exercise 1 MiB, depth 64, and 65,536-node bounds.
Some structurally bounded fixtures deliberately fail later domain validation;
that proves the boundary limit, not that the fixture is a valid contract.

Evidence labels in test/example data are fixture inputs. They do not establish a real verifier,
agent, hardware run, deployment, process sandbox, crash recovery, or provider billing guarantee.
All such boundaries require later host/runtime qualification.

## State package validation

The state runtime profile is deliberately narrower than the core toolchain: darwin/arm64 Node v26.13.0 with
bundled SQLite 3.54.1, one trusted host/boot and retained local disk. There is no separate SQLite installation or
new third-party native build. The workspace state dependency is core 0.0.0. An engine upgrade requires qualification.
Read the [state protocol](state.md) and [authority decision](adr/0001-local-state-authority.md).

State tests preserve the core acceptance families and add actual file/reopen/rollback/corruption/full/busy cases,
IPC barriers, independent owner/admission contention and live stale-owner rejection. Crash tests park owned children
at exact commit/dispatch boundaries, kill their exact PIDs, await exit and remove only owned temporary stores.
The local effect fixture writes one marker before a lost receipt. It is process-crash evidence, not external-effect
deduplication. Clock fixtures do not alter the host clock. Synthetic evidence does not authenticate a provider.

A bounded production-fence mutation was compiled successfully, made an existing public stale-owner assertion fail,
and was restored byte-for-byte before rebuilding and measuring GREEN. This is regression sensitivity evidence,
not a production behavior switch. See the specification's A01-A07 matrix for the individual acceptance obligations.
