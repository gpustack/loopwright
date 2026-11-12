# Development and Verification

Ensure your local toolchain matches the [runtime baseline](getting-started/architecture.md#runtime-baseline), then run these commands at the repository root:

```sh
npm ci
npm run build
npm run typecheck
npm run lint
npm test
```

Dependencies are exactly locked. Core has no runtime dependencies; state consumes core, and the private Pi adapter
uses pinned Pi 1.5.0 packages. The root minimatch override applies to the resolved graph, including SDK dependencies.
After installation, checks need no credentials, model, deployed service, Docker, or accelerator.
The package is private and is not published.

Build emits `dist` in core, state, agent-pi, controller and cli; test compilation emits `.test-build`. Both are ignored, as are dependencies and root `.claude` scratch. Git permits `.claude/skills` and `.claude/settings.json`; reports, handoffs, and worktrees remain ignored. Tests use Node's test runner and public package boundaries.

Private constructor seams isolate clock/transaction faults over actual SQLite; they are absent from the public state factories. Test files run serially to bound owned children. The integration fixture runs authoring, admission, candidate identity, evidence evaluation, and honest run construction. Example outputs are checked against this flow.

Boundary tests cover JSON grammar and duplicate decoded keys, unsafe objects/getters, immutability, Unicode/number restrictions, scope, graph relationships, identity substitution, evidence levels/bytes, result status, and partial usage. Limit tests use exact sizes and one-over-limit cases. Their assertions do not use elapsed-time thresholds. The graph tests exercise the 256-node/2,048-edge caps.

The parser tests exercise 1 MiB, depth 64, and 65,536-node bounds. Some structurally bounded fixtures deliberately fail later domain validation; that proves the boundary limit, not that the fixture is a valid contract.

Evidence labels in test/example data are fixture inputs. They do not establish a real verifier,
agent, hardware run, deployment, process sandbox, crash recovery, or provider billing guarantee.
All such boundaries require later host/runtime qualification.

## Contents

- [State package validation](#state-package-validation)
- [Pi adapter validation](#pi-adapter-validation)
- [Controller validation](#controller-validation)

## State package validation

Run the documentation gates after editing guides or module boundaries:

```sh
npm run lint:docs
node scripts/check-docs.mjs --report
npm run site
```

The report provides an audit summary; the strict lint command enforces the documentation contract. The site exports twelve public pages and excludes repository-only contributor pages. Configuration authoring uses `yaml@2.9.0` and the core schema.

Repository issue and pull request templates live under `.github/`. The `.github/workflows/` directory contains `ci.yml`, `test.yml`, `docs.yml`, `code-review.yml`, and `site.yml` for repository CI/CD. Use the five `.agents/skills/loopwright-*` guides for overview, docs, code review, issue and PR preparation, and release work.

The state runtime profile is deliberately narrower than the core toolchain: darwin/arm64 Node v26.13.0 with
bundled SQLite 3.54.1, one trusted host/boot and retained local disk. There is no separate SQLite installation or
new third-party native build. The workspace state dependency is core 0.0.0. An engine upgrade requires qualification.
Read the [state protocol](contribute/state.md) and [authority decision](contribute/adr/0001-local-state-authority.md).

State tests preserve the core acceptance families and add actual file/reopen/rollback/corruption/full/busy cases, IPC barriers, independent owner/admission contention and live stale-owner rejection. Crash tests park owned children at exact commit/dispatch boundaries, kill their exact PIDs, await exit and remove only owned temporary stores. The local effect fixture writes one marker before a lost receipt.

It is process-crash evidence, not external-effect deduplication. Clock fixtures do not alter the host clock. Synthetic evidence does not authenticate a provider.

A bounded production-fence mutation was compiled successfully, made an existing public stale-owner assertion fail,
and was restored byte-for-byte before rebuilding and measuring GREEN. This is regression sensitivity evidence,
not a production behavior switch. See the specification's A01-A07 matrix for the individual acceptance obligations.

## Pi adapter validation

The root commands compile, lint and test the adapter as well as core/state. Deterministic adapter tests use controlled
HTTP and private constructor seams; those seams are absent from package exports. They need no Docker or credentials.
`npm run test:pi -- --case all` runs the adapter subset; selectors include session, requests, tools, mcp, lifecycle and dispositions.

Separate native qualifications require Docker Desktop Linux arm64, the pinned base image, the installed locked graph,
and the qualified macOS state runtime. Run root build and tests first, then:

```sh
npm run qualify:pi -- --case all
npm run qualify:pi:live
```

The first command builds the derived image without network or pulling a new base, then runs both model selections, actual physical sends, context/parser controls, containment, MCP/codemode, recovery, dispositions, retained limits, context/parser and final owner/send-once mutation sensitivity, and descendant cleanup. Each case has its own finite deadline and records owned resource identities.

It stops nonzero at the first failed or blocked case. Required local fixture configuration is described in the [adapter guide](contribute/pi-adapter.md#qualification-setup). A missing prerequisite is not a passing skipped test.

The live command requires explicit estimated mode and a ready-token file; its default is BLOCKED before transport.
It is excluded from `--case all` and normal tests. Preserve its original retained state and eight-attempt allowance.
See [Sandbox Backends](configuration/sandbox-backends.md#live-observations) for the exact scope and remaining unknowns.

Whole-command deadline tests use a labeled simulated clock; they do not represent real 100 second SDK/provider timings.
Affected native lifecycle cases run separately. Qualification socket selection and historical-script status are in the adapter guide.

## Controller validation

`npm run test:controller -- --case config|progress|verification|scheduling|recovery|artifacts` selects focused offline
controller groups. It compiles current package outputs before tests that import public package roots. Root tests also
exercise CLI argument parsing and actual subprocess dry-run/run/resume/status/inspect without Docker or credentials.
The controller/CLI use only public core/state/adapter APIs. Test-only execution ports remain outside package exports.

Native qualification uses the same cumulative local experiment authority and explicit owned evidence. Failed result,
unknown effects, held reservations and observed/allocated time remain distinct. Image/daemon preparation is not native
SDK or live-provider acceptance. See the qualification README and retained program evidence for their actual scope.


---

**See also** — [Workspace Internals and Boundaries](contribute/internals.md) (package layers and authority boundaries)

**Next** → [Persistent Local State Store](contribute/state.md) — inspect lease fencing and recovery rules.
