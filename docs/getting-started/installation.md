# Installation

Run Loopwright as a zero-install GitHub Action in target repositories or install the `@gpustack/loopwright` CLI on a macOS or Linux laptop. After setup, paste a single bootstrap prompt into your coding agent to initialize or migrate repository configuration interactively.

## Contents

- [Entry points](#entry-points)
- [Prerequisites](#prerequisites)
- [Step 1: Install CLI](#step-1-install-cli)
- [Step 2: Verify CLI](#step-2-verify-cli)
- [GitHub Actions](#github-actions)
- [Prompt bootstrap](#prompt-bootstrap)

## Entry points

| Surface | Operating mode | Installation method |
| --- | --- | --- |
| GitHub Action | Declarative Taskpack (Simple) | Zero local setup; reference `uses: gpustack/loopwright@main` |
| Host coding agent (`loopwright step`) | Delegated Taskpack or Controller | Install `@gpustack/loopwright` and follow [Coding Agents](../operations/coding-agents.md) |
| Laptop CLI (`npm` / `pnpm`) | Managed Controller or local audit | `npm install -g --ignore-scripts @gpustack/loopwright` or `pnpm add -g --ignore-scripts @gpustack/loopwright` |
| Release tarball | Pinned or air-gapped hosts | Install `gpustack-loopwright-<version>.tgz` from GitHub Releases |
| Source checkout | Contributors and testers | Clone repository, run `npm ci && npm run build`, and run `npm link` |

## Prerequisites

Local CLI and `app-serve` hosts must satisfy the [runtime baseline](architecture.md#runtime-baseline): Node.js `26.x` (with built-in `node:sqlite`), `npm 11.x`, and a local POSIX filesystem on `darwin/arm64`, `linux/arm64`, or `linux/x64`. Provision an approved [sandbox backend](../configuration/sandbox-backends.md) before executing isolated agent steps.

## Step 1: Install CLI

### npm package

Install [`@gpustack/loopwright`](https://www.npmjs.com/package/@gpustack/loopwright) globally from `npmjs.com` using `npm` or `pnpm`. Pass `--ignore-scripts` to skip optional transitive lifecycle scripts.

```sh
npm install -g --ignore-scripts @gpustack/loopwright
# or with pnpm:
pnpm add -g --ignore-scripts @gpustack/loopwright
```

Run one-off commands without a global install using `npx` or `pnpm dlx`:

```sh
npx --ignore-scripts @gpustack/loopwright --help
# or with pnpm:
pnpm --ignore-scripts dlx @gpustack/loopwright --help
```

Each release publishes from GitHub Actions via npm Trusted Publishers with signed SLSA build provenance.

### Release archive

Install an immutable release archive from [GitHub Releases](https://github.com/gpustack/loopwright/releases) and verify its matching `.sha256` checksum (replace `0.0.3` with your target version):

```sh
npm install -g --ignore-scripts https://github.com/gpustack/loopwright/releases/download/v0.0.3/gpustack-loopwright-0.0.3.tgz
```

### Source build

Clone the repository to develop locally or test unreleased commits:

```sh
git clone https://github.com/gpustack/loopwright.git
cd loopwright
npm ci
npm run build
npm link
```

## Step 2: Verify CLI

Confirm the binary resolves on your `PATH`:

```sh
loopwright --version
loopwright --help
```

For Managed Controller runs, `loopwright init --directory "$HOME/loopwright-ops"` writes low-level `controller.draft.yaml` and `registry.draft.yaml` skeletons (`0600`). To initialize a repository `.loopwright/taskpack.yaml` or migrate existing sync scripts without manual boilerplate, use the interactive bootstrap prompt below.

## GitHub Actions

Consumer repositories using Declarative Taskpack mode do not need local CLI installation. Add `.loopwright/taskpack.yaml` and reference `gpustack/loopwright@main` in `.github/workflows/loopwright.yml`:

```yaml
name: loopwright
on:
  workflow_dispatch: {}
permissions:
  contents: read
jobs:
  taskpack:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: gpustack/loopwright@main
        with:
          taskpack-path: .loopwright/taskpack.yaml
          event-name: ${{ github.event_name }}
          event-path: ${{ github.event_path }}
          dry-run: 'true'
```

The composite Action provisions Node.js `26` automatically on the runner. Follow [GitHub Action](../operations/github-action.md) for App token wiring and secret bindings.

## Prompt bootstrap

No custom skill or plugin is required to author Loopwright YAML. Open your coding agent inside the target repository (for example, when migrating an existing automatic synchronized workflow) and paste one prompt:

### Taskpack prompt

```text
Read https://docs.gpustack.ai/loopwright/llms.txt and its Bootstrap Interview Reference (https://docs.gpustack.ai/loopwright/references/bootstrap-interview.md). Inspect this repository first WITHOUT editing any files yet, then interview me one question at a time with repository-grounded defaults to agree on which modules to automate or exclude, domain boundaries, update cadence, version/promotion holds, bounded host preflight -> offline sandbox -> independent verifier design, model pool (LOOPWRIGHT_PROVIDER_TOKEN), and workflow panel. Wait for my approval on the design summary before generating Loopwright config (apiVersion: loopwright.dev/v1alpha1) and running dry-run verification.
```

### Controller prompt

```text
Read https://docs.gpustack.ai/loopwright/llms.txt and its Bootstrap Interview Reference (https://docs.gpustack.ai/loopwright/references/bootstrap-interview.md). Inspect this repository first WITHOUT editing any files yet, then interview me one question at a time with repository-grounded defaults to align on writable/protected scope, budgets, verification checks, and role bindings. Wait for my approval on the design summary before computing local Loopwright handler and graph SHA-256 digests, writing out-of-repo registry.yaml and controller.yaml, and validating with loopwright check.
```

### Evolution prompt

```text
Read https://docs.gpustack.ai/loopwright/llms.txt and its Bootstrap Interview Reference (https://docs.gpustack.ai/loopwright/references/bootstrap-interview.md). Inspect this repository first WITHOUT editing any files yet, then follow Evolutionary campaign mode (Mode 3) to interview me one question at a time with repository-grounded defaults on EVOLVE-BLOCK guarded files, target hardware cell and Stage A static audit limits, held-out benchmark-gate.v1 workloads and runner relay/worker topology, objectives, island/niche budgets, optional teamEvolution, and bundle export. Wait for my approval on the design summary before generating .loopwright/taskpack.yaml and .loopwright/campaign.yaml and validating with loopwright evolve check.
```

---

**See also** — [Coding Agents](../operations/coding-agents.md) (drive zero-secret `loopwright step` loops from OAuth agents) · [Declarative Taskpack](../walkthroughs/declarative-taskpack.md) (simple automated repository mode) · [Managed Controller](../walkthroughs/managed-controller.md) (fine-grained registry and contract mode) · [Evolutionary Campaign](../walkthroughs/evolutionary-campaign.md) (multi-generation evolutionary optimization)

**Next** → [Declarative Taskpack](../walkthroughs/declarative-taskpack.md) — author or migrate a `.loopwright/taskpack.yaml` workflow.
