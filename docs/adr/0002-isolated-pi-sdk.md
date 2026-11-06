# Isolated Pi SDK under persistent host authority

Date: 2026-11-06
Status: Accepted

## Context

An admitted role needs real model/tool execution without granting its repository, transcript or runtime control over
parent budgets. Pi coding-agent and durable 1.5.0 offer different session/task mechanisms. S02 already owns retained
allowance, uncertainty and current dispatch authority on one qualified macOS host/boot.

## Decision

Select the coding-agent SDK 1.5.0 under S02. Put SDK/native VM, tools and the fixed local read-only MCP server in
separate network-none Linux arm64 containers. Keep state, ready credentials, physical HTTP dispatch and mediated
candidate writes on the trusted host. Every send and nested effect needs its own original one-use S02 admission.

Use one persistent execution-owner guard with exact process/container identities in addition to S02 leases. Publish
validated immutable native/workspace artifacts before their S02 checkpoint; restore sends nothing automatically.
Compile trusted native factories once in an already empty namespace, retain their actual runtime/event bus and use
an immutable final loader. Disable ambient discovery, native retries, automatic compaction and optional pi-retry.

Keep strict proven context as the default refusal. Explicit immutable estimated mode uses complete finalized JSON
bytes and fixed headroom/output caps; it remains soft accounting with unproven context fit. Live qualification needs
an explicit ready-token source and a retained eight-attempt allowance. Its absence is BLOCKED.

## Alternatives

- Direct durable+S02 offers phase checkpoints, sleep and versioned documents, but needs separate model/tool/resource/event
  bridges and cross-store crash qualification. Its single-writer storage is a host precondition, not a budget authority.
- Durable with an SDK child adds both runtime bridges and a child invocation/receipt lifecycle. Phase replay cannot
  safely repeat an uncertain child effect or make the two stores atomic.
- Running tools beside the owner would expose host filesystem/credentials. A final diff or tool-name check cannot enforce that boundary.
- Enabling pi-retry unchanged adds direct settings reads, private session hooks and another continuation scheduler.
  The optional package is evaluated and explicitly refused rather than silently adapted.

## Consequences

The selected route preserves native SDK/MCP/codemode behavior while keeping one allowance authority. It costs Docker
startup, host mediation, explicit resource preparation, bounded IPC and exact cleanup/recovery bookkeeping. Shell
candidate writes are deliberately unavailable; write/edit mediation and per-call scratch are the supported profile.

Retained S02 checks grow with ledger size, so fixed limits and measured local costs remain part of the contract.
SDK, dependency, image or runtime changes require conformance qualification. Local fixture counts do not establish
provider billing, internal effort, deployed tenant isolation or remote host-loss recovery. An in-flight request cannot
be remotely fenced by a lease, local process death or container cleanup.

See the [adapter guide](../pi-adapter.md) and [runtime comparison](../pi-runtime-evaluation.md) for operation and evidence limits.
