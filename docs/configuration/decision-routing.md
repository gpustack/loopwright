# Decision Routing

System-One decision routing uses fast, calibrated models to classify bounded triage questions (such as capability tier selection, cycle alignment, soft compaction, or candidate diff triage). Routing is strictly **advisory**: deterministic controller gates and `TrustedRegistry` rules retain full authority over execution, verification, and publication.

## Contents

- [DecisionPolicy](#decisionpolicy)
- [Confidence zones](#confidence-zones)
- [Providers and disclosure](#providers-and-disclosure)
- [Live wiring and fallback](#live-wiring-and-fallback)

## DecisionPolicy

![Calibrated System-One advisory decision routing](../assets/diagrams/decision-routing-flow.svg)

<!-- flowchart LR
  OptIn["01 Explicit opt-in"] -> Redact["02 Scrub payload"] -> Zone["03 Calibrate zone"] -> Fallback["04 Deterministic fallback"]
-->

- **Standalone host policy (`decisions.yaml`)**: Load a `DecisionPolicy` document via `loadDecisionPolicyFile('decisions.yaml')` (`disclosurePolicy` defaults to `disabled`).
- **Declarative Taskpack (`spec.decisions`)**: Embed policy fields under `spec.decisions` in `.loopwright/taskpack.yaml` (`enabled` required; `disclosurePolicy` defaults to `public-metadata-only`).

```yaml
apiVersion: loopwright.dev/v1alpha1
kind: DecisionPolicy
spec:
  enabled: true # Optional in standalone decisions.yaml (defaults to false)
  disclosurePolicy: public-metadata-only # Optional (defaults to disabled)
  provider: typesafe-jev # Optional (defaults to typesafe-jev)
  minConfidence: 0.8 # Optional (0.5..1.0, defaults to 0.8)
  confirmThreshold: 0.6 # Optional (0.0..minConfidence, defaults to 0.6)
  hardDeadlineMs: 5000 # Optional (100..30000 ms, defaults to 5000)
  maxAttempts: 1 # Optional (1 or 2, defaults to 1)
  allowImages: false # Optional (defaults to false)
```

For declarative `Taskpack` triage, declare `spec.decisions` with optional `triageRules` (`0..100` rules):

```yaml
apiVersion: loopwright.dev/v1alpha1
kind: Taskpack
metadata:
  name: docs-sync
spec:
  # Other Taskpack sections omitted; see Taskpack.
  decisions:
    enabled: true
    provider: typesafe-jev # Optional
    disclosurePolicy: public-metadata-only # Optional
    minConfidence: 0.8 # Optional
    confirmThreshold: 0.6 # Optional
    triageRules: # Optional pre-publication candidate diff rules (0..100)
      - id: docs-only-risk
        description: Flag risky config edits outside expected doc files.
        severity: important
        kind: noul
        threshold: 0.7 # Optional finite score in 0.0..1.0
```

- **Threshold order**: Policies with `confirmThreshold > minConfidence` fail closed (`DECISION_POLICY_INVALID`).
- **Question primitives**: Programmatic callers compose `choice` (`<= 255` options), `score` (`2..10` criteria), `noul` (`0.0..1.0`), and `box` (`allowImages: true`).

## Confidence zones

Every calibrated response routes into one of three deterministic zones:

| Zone | Confidence range | Router action |
| --- | --- | --- |
| `act` | `confidence >= minConfidence` | Accepts the advisory choice within bounded non-authority scope |
| `confirm` | `confirmThreshold <= confidence < minConfidence` | Requests secondary confirmation or conservative check |
| `escalate` | `confidence < confirmThreshold` (or timeout/error) | Rejects model advice and runs deterministic fallback |

## Providers and disclosure

### Providers

| Provider | Wire dialect | Default model | Secret variable |
| --- | --- | --- | --- |
| `typesafe-jev` | `systemone` | `jev-latest` | `TYPESAFE_API_KEY` |
| `openai-decisions` | `openai-decisions` | `gpt-6-luna` | `OPENAI_API_KEY` |
| `startlux-decision` | `systemone` | `startlux-decision-27b-autothink` | `STARTLUX_API_KEY` |
| `microsoft-decision` | `systemone` | `microsoft-decision-1` | `MICROSOFT_DECISION_API_KEY` |
| `perplexity-decider` | `systemone` | `pplx-decider-v1.2` | `PERPLEXITY_API_KEY` |
| `cloudflare-clef` | `systemone` | `@cf/cloudflare/clef` | `CLOUDFLARE_API_TOKEN` |
| `liquid-d1` | `systemone` | `liquid/d1-ultra` | `LIQUID_API_KEY` |

### Disclosure policies

| Policy | Outbound payload ceiling | Security rule |
| --- | --- | --- |
| `disabled` | `0` bytes (no network call) | Blocks all outbound provider requests |
| `public-metadata-only` | Redacted metadata (`<= 512` chars) | Strips raw file contents, diffs, and secrets |
| `repo-approved-redacted-evidence` | Secret-scrubbed evidence (`<= 64 KiB`) | Requires explicit operator approval for repository snippets |

## Live wiring and fallback

Both the GitHub Action and CLI inject live `@loopwright/decisions` adapters through `ControllerPorts.decisions` (`AdvisoryDecisionPort`) covering capability routing, cycle alignment, soft compaction, candidate diff triage, and evolutionary novelty/strategy/cascade hooks.

- **Advisory stamps**: Every decision stamps `advisoryOnly: true` and `verificationCertified: false`.
- **Deterministic fallback**: Missing credentials, timeouts, or unreachable endpoints fall back deterministically (`deterministic_fallback` / `deterministic_heuristic`) without blocking runs.
- **Non-delegable authority**: Forbidden intents (granting authority, certifying evidence, skipping review, approving gates, overriding pinned models, or vetoing hard compaction) throw `DECISION_AUTHORITY_VIOLATION`.

---

**See also** — [Taskpack](taskpack.md) (embed `spec.decisions` in `.loopwright/taskpack.yaml`) · [Controller and Registry](controller-and-registry.md) (deterministic controller authority)

**Next** → [GitHub Action](../operations/github-action.md) — wire secrets and triggers in GitHub Actions.
