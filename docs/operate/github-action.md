# GitHub Action Configuration

The root Action declares a reusable entrypoint. The current Action runtime and host qualification do not agree, so the workflow below is illustrative and cannot currently complete qualification under the declared runtime.

## Contents

- [Workflow](#workflow)
- [Inputs and output](#inputs-and-output)
- [Taskpack and triggers](#taskpack-and-triggers)

## Workflow

```yaml
name: loopwright
on:
  schedule:
    - cron: '0 3 * * *'
  workflow_dispatch: {}
  issue_comment:
    types: [created]
permissions:
  contents: read
jobs:
  taskpack:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: loopwright/loopwright@main # Pin a reviewed immutable revision.
        id: loopwright
        with:
          taskpack-path: .loopwright/taskpack.yaml
          event-name: ${{ github.event_name }}
          event-path: ${{ github.event_path }}
          dry-run: 'true'
        env:
          LOOPWRIGHT_PROVIDER_TOKEN: ${{ secrets.LOOPWRIGHT_PROVIDER_TOKEN }}
          LOOPWRIGHT_GATE_SIGNING_SECRET: ${{ secrets.LOOPWRIGHT_GATE_SIGNING_SECRET }}
          LOOPWRIGHT_PUBLICATION_SIGNING_SECRET: ${{ secrets.LOOPWRIGHT_PUBLICATION_SIGNING_SECRET }}
```

- Start with read-only permissions and dry-run; publication requires a separately authorized integration.
- Comment commands such as `/loopwright status`, `/loopwright retry`, and `/loopwright revise` require eligible events and authorized actors. Set the taskpack triggers accordingly.
- Provider and signing secrets belong in the consumer's secret store; never commit them.

## Inputs and output

| Input | Purpose |
| --- | --- |
| `taskpack-path` | Manifest path; defaults to `.loopwright/taskpack.yaml` |
| `mode` | `candidate` or `no-change` |
| `event-name`, `event-path` | Event type and payload path |
| `run-root`, `run-id` | Trusted artifact root outside checkout and stable run identity |
| `storage-profile` | `actions-basic` or `durable` |
| `provider`, `model`, `thinking` | Author selection |
| `dry-run` | Compile without controller delegate |
| `gate-endpoint-url`, `publication-endpoint-url` | External gate and publication endpoints |

The Action metadata declares a `result` output, but the current CLI shim prints JSON to stdout and does not write `GITHUB_OUTPUT`. The shim also does not forward either endpoint input or supply a controller delegate; compilation alone does not execute or publish. `action.yml` declares Node 20 while host qualification accepts Node 26.x, so the declared Action runtime is refused before compilation. Resolve these implementation gaps before relying on the example; they are outside this documentation change.

## Taskpack and triggers

Configure writable and protected scope, checks, publication, triggers, and optional `spec.sandbox` preferences (`macos-seatbelt`, `linux-bwrap`, `linux-landlock`, `docker`) in the [taskpack walkthrough](../walkthroughs/declarative-taskpack.md). When a taskpack declares `spec.sandbox`, backend negotiation (`negotiateSandboxBackend`) fails closed if the runner lacks the required OS sandbox binary or isolation capabilities. Scheduled, manual, repository dispatch, release, issue comment and pull request review events are supported by intake subject to taskpack policy. The Action itself does not install a workflow in this repository.

**See also**: [Control plane](../github-app.md)

**Next**: [Taskpack walkthrough](../walkthroughs/declarative-taskpack.md)
