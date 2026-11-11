# Loopwright

Loopwright is a nine-package TypeScript harness for bounded repository work, independent verification, and authenticated publication, with a GitHub Action and App control plane. Read the [documentation](docs/README.md) and [architecture](docs/getting-started/architecture.md) for authority and evidence boundaries.

## Usage

1. Review the reusable [GitHub Action](docs/operate/github-action.md) and `.loopwright/taskpack.yaml` [walkthrough](docs/walkthroughs/declarative-taskpack.md); the current Action runtime fails host qualification.
2. Deploy the [GitHub App control plane](docs/operate/github-app.md) with `@loopwright/github-app`.
3. Operate the local [CLI](docs/operate/cli.md), including closure audits.
4. Integrate the TypeScript SDK and optional [System-One decisions](docs/decisions.md) with `@loopwright/decisions`.

## Packages

| Package | Responsibility |
| --- | --- |
| [`@loopwright/core`](packages/core/) | Contracts and evidence |
| [`@loopwright/state`](packages/state/) | Fenced SQLite authority |
| [`@loopwright/agent-pi`](packages/agent-pi/) | Isolated Pi runtime |
| [`@loopwright/controller`](packages/controller/) | Bounded controller and verification |
| [`@loopwright/taskpack-runner`](packages/taskpack-runner/) | Runner parity and taskpacks |
| [`@loopwright/memory`](packages/memory/) | Reviewed memory and compaction |
| [`@loopwright/decisions`](packages/decisions/) | Advisory decision routing |
| [`@loopwright/github-app`](packages/github-app/) | GitHub intake and control plane |
| [`@loopwright/cli`](packages/cli/) | Local operations and closure |

See [development](docs/development.md) for build and verification commands.
