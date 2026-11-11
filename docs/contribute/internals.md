# Workspace Internals and Boundaries

The workspace separates contracts, authority, execution, verification and publication into explicit packages.

## Contents

- [Build order](#build-order)
- [Authority boundaries](#authority-boundaries)
- [Architecture decisions](#architecture-decisions)

## Build order

The root build compiles `core`, `state`, `agent-pi`, `controller`, `taskpack-runner`, `memory`, `decisions`, `github-app`, then `cli`. Run `npm run build`, `npm run typecheck`, and `npm run lint` from the root.

## Authority boundaries

Core owns contracts and evidence; state owns fenced local authority; the adapter owns isolated execution; controller coordinates independent verification and authenticated effects. The runner owns offline parity, memory owns reviewed compaction, decisions provide bounded advice, the App owns intake and token scoping, and the CLI exposes operations. Preserve unknown outcomes and do not promote fixture evidence into deployed acceptance.

## Architecture decisions

[Local state authority](../adr/0001-local-state-authority.md) records the storage and fencing decision. [Isolated Pi SDK](../adr/0002-isolated-pi-sdk.md) records runtime isolation and its limitations. Specifications retain rationale and measurements; current source determines implementation.

**See also**: [Development](../development.md)

**Next**: [Module map](../README.md#module-map)
