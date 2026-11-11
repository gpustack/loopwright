---
name: loopwright-docs
description: Maintain connected Loopwright documentation and site exports.
---

# Loopwright Docs

## Shared index and generated exports

The [module map](../../../docs/README.md#module-map) owns routing. The index drives generated site exports; do not hand-edit generated files. See [conventions](references/conventions.md).

## The rule that keeps the overview small

Keep [architecture](../../../docs/getting-started/architecture.md) at or below 200 lines; put detail on its owning page.

## Where a fact belongs

| Topic | Owner |
| --- | --- |
| Contracts, identity, evidence | [Contracts](../../../docs/contracts.md), [identity](../../../docs/identity.md), [evidence](../../../docs/evidence.md) |
| State and Pi | [State](../../../docs/state.md), [adapter](../../../docs/pi-adapter.md), [evaluation](../../../docs/pi-runtime-evaluation.md) |
| Controller and runner | [Controller](../../../docs/controller.md), [runner](../../../docs/runner-taskpack.md) |
| Memory and decisions | [Memory](../../../docs/memory.md), [decisions](../../../docs/decisions.md) |
| App, Action, CLI | [App](../../../docs/github-app.md), [Action](../../../docs/operate/github-action.md), [deployment](../../../docs/operate/github-app.md), [CLI](../../../docs/operate/cli.md) |
| Taskpack and closure | [Walkthrough](../../../docs/walkthroughs/declarative-taskpack.md), [closure](../../../docs/closure-matrix.md) |
| Development and decisions | [Development](../../../docs/development.md), [internals](../../../docs/contribute/internals.md), [local state ADR](../../../docs/adr/0001-local-state-authority.md), [Pi ADR](../../../docs/adr/0002-isolated-pi-sdk.md) |

## Pretty YAML and configuration examples

Use annotated, two-space Pretty YAML for taskpacks and consumer Action workflows, and clear JSON examples for configuration. Follow each macro example with micro constraint bullets and tables. Never embed real secrets.

## Site rendering

Place SVG diagrams under `docs/assets/diagrams/`. Hidden Mermaid flowgraph comments use `->` and `..>` in place of `-->` and `-.->` so the comment remains valid.

## Page shape

Use `# Title`, a short introduction, `## Contents` matching all subsequent H2 headings in order, and `**See also**` / `**Next**` footer links. Avoid interrogative words in headings and table headers.

## Sync invariants

Update the index, module map and cross-links when pages or ownership change. Describe current source behavior and preserve evidence boundaries.

## Before you finish

Run `npm run lint:docs` and `npm run site`.
