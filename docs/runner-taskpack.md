# Runner taskpack and offline parity

Operator documentation for `@loopwright/taskpack-runner`: the package that vendors the frozen
`gpustack/runner` auto-sync domain modules, drives them through a contained Python bridge, compiles
Loopwright taskpacks from Runner triggers, serves the authenticated validation gate and publication
endpoint on loopback, and proves byte-level parity against the frozen revision without any network,
Docker, or model access.

## Vendored frozen corpus

- Location: `packages/taskpack-runner/vendor/runner-auto-sync/`.
- Contents: the frozen domain modules (`tools/auto_sync/`), Dockerfile matrix helpers (`pack/`),
  documentation fixtures, and the original unit checks (`tests/auto_sync/`), each pinned in
  `manifest.json` by SHA-256, byte length, and executable bit.
- Verification: `verifyFrozenCorpus()` runs before every Python invocation and rejects missing files,
  digest or length mismatches, cleared executable bits, symlink substitution, and unlisted `.py`/`.sh`
  scripts under the frozen trees. A clean corpus yields a stable `corpusDigest` used in parity reports.
- The corpus is read-only by contract; never edit vendored files. Update the manifest only by
  re-vendoring from the pinned upstream revision.

## Contained Python bridge

`PythonBridge` (`src/python-bridge.ts`) is the only path from this package to Python.

- Interpreter: explicit option, `RUNNER_TASKPACK_PYTHON` environment override, or an allowlisted
  candidate name (`python3`, versioned names) resolved against the parent `PATH` and probed under
  containment. Preflight requires Python >= 3.10 plus the `packaging`, `yaml`, and `requests`
  site packages, and returns a structured `PYTHON_UNAVAILABLE` error otherwise.
- Containment per invocation: private `HOME` scratch directory (mode `0700`), pinned git settings
  (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`,
  `GIT_ASKPASS=/usr/bin/false`), `PYTHONDONTWRITEBYTECODE=1`, an allowlisted `PATH`, and a
  `sitecustomize` socket guard that permits loopback connections only. Streams are bounded at one
  megabyte and every call carries a hard timeout.
- Frozen unit checks: `runFrozenUnitChecks()` runs the vendored pytest suite when the configured
  interpreter provides pytest, and module import self-checks otherwise, so `npm test` never requires a
  global pytest installation. A resident helper variant (`residentSpawn`) hosts the loopback GitHub
  service double under the same containment.

## Runner intake

`prepareRunnerIntake` (`src/intake.ts`) compiles Runner triggers into typed dispositions.

- Discovery mode executes the vendored `discover` through the bridge: `blocked` with per-subscription
  errors when feeds failed and no update exists, `no_change` when nothing needs doing, and `ready`
  with frozen identity, evidence, and prerelease permissions otherwise.
- Revise mode enforces the frozen guidance contract exactly (40 lines, 2048 UTF-8 bytes, the
  `=== .*? ===` sentinel, `REQUIRED:`/`NEVER:` prefixes) and restricts commands to `OWNER`/`MEMBER`/
  `COLLABORATOR` authors or explicit allowlisted operators, binding each accepted command to the pull
  request head, command id, and command digest.
- Pack-run-url mode parses managed-repository Actions URLs only, rejects cross-repository targets,
  truncates job logs to 4000 characters, and strips sentinel sequences before attaching diagnostics.

## Taskpack compilation

`compileRunnerTaskpack` (`src/compile-taskpack.ts`) emits a trusted registry plus controller
configuration accepted by `loadTrustedConfiguration` and `compilePlan`:

- Candidate mode wires the author role, the `.autosync/proposal.json` document check, and the
  external candidate-validation gate into a publication-bound graph.
- No-change mode wires the author role and an explicit no-change check so the run settles as
  `no_change` with no publication effect.
- Runner stage budgets map onto capped controller budgets; signing secrets exist only inside
  credential and environment bindings and never appear in handlers, steps, or compiled plans.

## Loopback gate and publication service

`startRunnerTaskpackService` (`src/service.ts`) serves the controller wire protocols on
`127.0.0.1` with HMAC authentication in both directions.

- `/gate` validates the complete request binding, runs frozen `assemble`, `validate_proposal`, and
  `validate_candidate` in a disposable clone, caches the verified checked artifact keyed by run and
  candidate digest, and returns signed `approved`/`denied` verdicts. Candidate bytes are never
  trusted on first contact: the gate reconstructs them from the run's checkpoint workspace snapshots
  (`candidateFilesFromRunArtifacts`) or from the registered snapshot plus proposal
  (`computeRunnerCandidateDigest`), identifies the reconstructed set with the controller's manifest
  discipline, and denies the request when the manifest digest does not match the request binding or
  when `registration.candidateDigest` pins a different candidate. Registrations bind strictly by
  `storeId|runId`; discover candidates validate on the registered snapshot head, and revise
  candidates validate on a local `pr-head` branch of the managed pull request inside the service
  double (only `.autosync/` candidate files are written, so baseline files cannot clobber the PR
  working tree). A proposal that passes schema checks but yields zero accepted groups is denied with
  a `zero accepted groups` reason.
- `/publish` validates bindings, deduplicates by idempotency key, requires the gate-verified
  artifact, re-checks the snapshot head against the bound revisions, guards authorized revisions
  (command digest binding, managed PR head, and the frozen `command_id` duplicate-command record
  written by `publish.py`), and runs frozen `publish` against the resident GitHub service double.
  Every outcome maps to one of three signed receipts: `succeeded` for a landed pull request,
  `not_executed` with a structured reason for safe refusals (gate revalidation required, revision
  binding mismatch, head changed, revise head moved, duplicate command id, frozen deferral), and
  `failed` for transport or publisher faults. With `publicationChaos: 'drop_after_write'` the
  service drops the response after the write lands, leaving the remote write confirmed but the
  receipt missing so the controller must reconcile.
- `deriveOperatorReceipt` reconstructs an authenticated receipt from the service double's landed
  pull-request state for operator reconciliation; `fakeHumanCommit` moves the managed PR branch to
  exercise head-movement guards in tests.

## Containment boundaries

The `sitecustomize.py` socket guard (`sys.addaudithook` plus patched `connect`/`connect_ex`) applies
to Python processes run through the bridge: it permits loopback addresses only, checking both
string and bytes/bytearray hosts and rejecting non-inet addresses. Child tools invoked by the
frozen helpers (`git`, `yq`) are not Python and are instead isolated by sanitized environment
variables (`GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=/usr/bin/false`,
`SSH_ASKPASS=/usr/bin/false`), an allowlisted `PATH`, a private `HOME`, and strictly local
repository paths, so no child tool can reach a remote host or read host git configuration.

## Offline parity harness

`src/parity.ts` (including the deterministic fake adapter) plus `test/parity.test.ts` prove all fourteen specified
scenarios:

- The legacy side executes the vendored frozen functions through the bridge on disposable fixture
  repositories with the vendored GitHub service double, recording raw dispositions (for example
  `published`, `deferred`, `ignored`, `no_changes`) plus normalized outcomes and remote-write counts.
- The Loopwright side runs complete controller cycles through `runCycleWithPorts` with a
  deterministic fake adapter (in `src/parity.ts`) that produces candidate captures through the real checkpoint and
  capture discipline — no Docker, SDK, model, or network — against the loopback service.
- Per-case results classify as `exact_match` or `intentional_improvement` with explanations; the
  known improvements are fail-closed sentinel rejection and unauthorized-commander blocking before
  any model eligibility, where the legacy orchestrator passed or ignored them.

## Commands

```bash
npm run build
npm run typecheck
npm run lint
npm test
```

Parity-specific targets:

```bash
node --test .test-build/packages/taskpack-runner/test/corpus-intake.test.js
node --test .test-build/packages/taskpack-runner/test/python-bridge.test.js
node --test .test-build/packages/taskpack-runner/test/service-compile.test.js
node --test .test-build/packages/taskpack-runner/test/parity.test.js
```

All verification runs locally on the development host; no remote host, container farm, or network
service participates.
