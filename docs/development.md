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

Build emits `packages/core/dist`; test compilation emits `.test-build`.
Both are ignored, as are dependencies and root `.claude` scratch.
Git permits `.claude/skills` and `.claude/settings.json`; reports, handoffs, and worktrees remain ignored.
Tests import the public root entrypoint and use Node's test runner.
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
