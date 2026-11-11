---
name: loopwright-code-review
description: Review Loopwright changes against standards and specifications.
---

# Loopwright Code-Review

## Standards

Review repository conventions and engineering quality independently of task intent.

## Spec

Review the approved specification and acceptance criteria independently of general standards.

### 1. Pin the diff and intent

Record base, head, scope and the authoritative spec; inspect the exact diff.

### 2. Review tests first

Find behavioral cases, negative paths and evidence gaps without inferring uninspected tests are absent.

### 3. Review the implementation across five axes

Examine Correctness, Readability, Architecture/Layer Ownership across all nine packages, Security/Redaction/Containment, and Performance/Boundedness.

### 4. Check the repo's hard invariants

Use [architecture and module routing](../../../docs/README.md#module-map); check fencing, uncertain effects, secret handling and independent verification.

### 5. Over-engineering pass

Consider `delete:`, `reuse:`, `stdlib:`, `native:`, `yagni:`, `merge:`, and `shrink:` only when each has concrete benefit.

### 6. Aggregate and label

| Severity | Meaning |
| --- | --- |
| Critical | Immediate security or data loss risk |
| High | Material incorrect behavior or broken authority |
| Medium | Scoped defect with meaningful impact |
| Low | Minor actionable defect |

Report concrete scenarios and file lines, separating Standards from Spec. State verification scope and unresolved uncertainty.
