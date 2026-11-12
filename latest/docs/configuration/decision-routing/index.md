# Decision Routing

System-One decision routing uses fast, calibrated models to classify bounded triage questions (such as retry classification, scope pre-screening, or review routing). Routing is strictly **advisory**: deterministic controller gates and `TrustedRegistry` rules retain full authority over execution, verification, and publication.

## Contents

- [DecisionPolicy](#decisionpolicy)
- [Confidence zones](#confidence-zones)
- [Policy reference](#policy-reference)
- [Fallback and authority](#fallback-and-authority)

## DecisionPolicy

![Calibrated System-One advisory decision routing](/loopwright/latest/docs/assets/diagrams/decision-routing-flow.svg)

<!-- flowchart LR
  OptIn["01 Explicit opt-in"] -> Redact["02 Scrub payload"] -> Zone["03 Calibrate zone"] -> Fallback["04 Deterministic fallback"]
-->

- **Standalone host policy (`decisions.yaml`)**: Load a `DecisionPolicy` document via `loadDecisionPolicyFile('decisions.yaml')` in custom controller or App integrations.
- **Declarative Taskpack (`spec.decisions`)**: Embed the same fields under `spec.decisions` in `.loopwright/taskpack.yaml` (`Taskpack` validates the block and exposes it to host callers; `runGitHubActionEntrypoint` does not instantiate a live provider automatically).

```yaml
apiVersion: loopwright.dev/v1alpha1
kind: DecisionPolicy
spec:
  enabled: true # Optional in standalone decisions.yaml (defaults to false)
  disclosurePolicy: public-metadata-only # Optional (defaults to disabled)
  provider: typesafe-jev # Optional (defaults to typesafe-jev)
  minConfidence: 0.8 # Optional (defaults to 0.8)
  confirmThreshold: 0.6 # Optional (defaults to 0.6)
  hardDeadlineMs: 5000 # Optional (defaults to 5000)
  maxAttempts: 1 # Optional (defaults to 1)
  allowImages: false # Optional (defaults to false)
```

- **Taskpack nesting**: Inside `.loopwright/taskpack.yaml` (`kind: Taskpack`), place the `spec.*` fields under `spec.decisions` rather than repeating a nested `DecisionPolicy` header.
- **Threshold order**: Validation rejects policies where `confirmThreshold > minConfidence` (`DECISION_POLICY_INVALID`).

## Confidence zones

Every calibrated response is routed into one of three deterministic zones based on `minConfidence` and `confirmThreshold`:

| Zone | Confidence range | Router action |
| --- | --- | --- |
| `act` | `confidence >= minConfidence` | Accepts the advisory choice within bounded non-authority scope |
| `confirm` | `confirmThreshold <= confidence < minConfidence` | Requests secondary confirmation or conservative check |
| `escalate` | `confidence < confirmThreshold` (or timeout/error) | Rejects model advice and executes deterministic fallback |

## Policy reference

### Policy fields

In a standalone `DecisionPolicy` document (`decisions.yaml`), `apiVersion`, `kind`, and `spec` are required while all `spec.*` keys default cleanly; when nested under `Taskpack` `spec.decisions`, `decisions.enabled` is **required** and the remaining 7 shared fields are optional:

| Field path | Required | Default | Bounds and meaning |
| --- | --- | --- | --- |
| `apiVersion` / `kind` | Conditional | — | **Required** in standalone envelope (`loopwright.dev/v1alpha1`, `DecisionPolicy`); omit in `taskpack.yaml` |
| `spec.enabled` | Conditional | `false` | **Required** inside `Taskpack` `spec.decisions`; optional in standalone `decisions.yaml` |
| `spec.disclosurePolicy` | No | `'disabled'` | Outbound payload redaction tier (`disabled`, `public-metadata-only`, `repo-approved-redacted-evidence`) |
| `spec.provider` | No | `'typesafe-jev'` | Target provider adapter and wire dialect |
| `spec.minConfidence` | No | `0.8` | Float in `0.5 .. 1.0`; minimum calibrated score required for `act` |
| `spec.confirmThreshold` | No | `0.6` | Float in `0.0 .. 1.0` (`<= minConfidence`); floor for `confirm` before `escalate` |
| `spec.hardDeadlineMs` | No | `5000` | Integer `100 .. 30000` ms shared across all attempts |
| `spec.maxAttempts` | No | `1` | `1` (single call) or `2` (one retry if time remains in `hardDeadlineMs`) |
| `spec.allowImages` | No | `false` | Permits image inputs and `box` bounding-box questions when `true` |
| `spec.endpoint` / `spec.model` | No | Provider default | Standalone `DecisionPolicy` only: custom `http(s)://` URL and model ID override |
| `spec.fallbackRole` | No | `null` | Standalone `DecisionPolicy` only: fallback role ID or `null` |
| `spec.onFallbackUnavailable` | No | `'blocked'` | Standalone `DecisionPolicy` only: `'blocked'` or `'deterministic_default'` |
| `spec.startluxOptions` | No | `null` | Standalone `DecisionPolicy` only: `thinkMode`, `thinkBudget`, `gate`, `allowNone` tuning |

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

### Question primitives

Programmatic `@loopwright/decisions` callers compose structured requests from four primitives:

| Primitive | Output shape | Constraint |
| --- | --- | --- |
| `choice` | Single option key (`<= 255` options) | Supported across all seven providers |
| `score` | Weighted score across `2..10` criteria | Supported across all seven providers |
| `noul` | Calibrated binary probability (`0.0..1.0`) | Supported across all seven providers |
| `box` | Normalized bounding box coordinates | Requires `allowImages: true` and vision-capable provider |

## Fallback and authority

Six safety-critical intents (such as bypassing verification receipts, expanding `writable` scope, or overriding lease fences) are permanently **non-delegable** and never sent to a decision model. When a provider is disabled, unreachable, or returns low confidence, Loopwright falls back to deterministic rules and retains any uncertain provider consumption in run observations.

---

**See also** — [Taskpack](/loopwright/latest/docs/configuration/taskpack/index.md) (embed `spec.decisions` in `.loopwright/taskpack.yaml`) · [Controller and Registry](/loopwright/latest/docs/configuration/controller-and-registry/index.md) (deterministic controller authority)

**Next** → [GitHub Action](/loopwright/latest/docs/operations/github-action/index.md) — wire secrets and triggers in GitHub Actions.
