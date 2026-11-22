# Decision Routing

System-One decision routing uses fast, calibrated models to classify bounded triage questions (such as capability tier selection, cycle alignment, soft compaction, or candidate diff triage). Routing is strictly **advisory**: deterministic controller gates and `TrustedRegistry` rules retain full authority over execution, verification, and publication.

## Contents

- [DecisionPolicy](#decisionpolicy)
- [Confidence zones](#confidence-zones)
- [Policy reference](#policy-reference)
- [Live wiring and fallback](#live-wiring-and-fallback)

## DecisionPolicy

![Calibrated System-One advisory decision routing](/loopwright/0.0/docs/assets/diagrams/decision-routing-flow.svg)

<!-- flowchart LR
  OptIn["01 Explicit opt-in"] -> Redact["02 Scrub payload"] -> Zone["03 Calibrate zone"] -> Fallback["04 Deterministic fallback"]
-->

- **Standalone host policy (`decisions.yaml`)**: Load a `DecisionPolicy` document via `loadDecisionPolicyFile('decisions.yaml')` in custom controller or App integrations.
- **Declarative Taskpack (`spec.decisions`)**: Embed the policy under `spec.decisions` in `.loopwright/taskpack.yaml`. Taskpack 2.0 wires `spec.decisions` live through `ControllerPorts.decisions` in both GitHub Action and CLI runs.

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

For declarative `Taskpack` triage, declare `spec.decisions` with optional `triageRules`:

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

In a standalone `DecisionPolicy` document (`decisions.yaml`), `apiVersion`, `kind`, and `spec` are required while all `spec.*` keys default cleanly; when nested under `Taskpack` `spec.decisions`, `decisions.enabled` is **required** and the shared fields plus `triageRules` are optional:

| Field path | Required | Default | Bounds and meaning |
| --- | --- | --- | --- |
| `apiVersion` / `kind` | Conditional | — | **Required** in standalone envelope (`loopwright.dev/v1alpha1`, `DecisionPolicy`); omit in `taskpack.yaml` |
| `spec.enabled` | Conditional | `false` | **Required** inside `Taskpack` `spec.decisions`; optional in standalone `decisions.yaml` |
| `spec.disclosurePolicy` | No | `'disabled'` (standalone) / `'public-metadata-only'` (`Taskpack`) | Outbound payload redaction tier (`disabled`, `public-metadata-only`, `repo-approved-redacted-evidence`) |
| `spec.provider` | No | `'typesafe-jev'` | Target provider adapter and wire dialect |
| `spec.minConfidence` | No | `0.8` | Float in `0.5 .. 1.0`; minimum calibrated score required for `act` |
| `spec.confirmThreshold` | No | `0.6` | Float in `0.0 .. 1.0` (`<= minConfidence`); floor for `confirm` before `escalate` |
| `spec.hardDeadlineMs` | No | `5000` | Integer `100 .. 30000` ms shared across all attempts |
| `spec.maxAttempts` | No | `1` | `1` (single call) or `2` (one retry if time remains in `hardDeadlineMs`) |
| `spec.allowImages` | No | `false` | Permits image inputs and `box` bounding-box questions when `true` |
| `spec.triageRules` | No | Unset | `Taskpack` `spec.decisions`: `0..100` rules (`{ id, description, severity, kind, threshold? }`) |
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

## Live wiring and fallback

`ControllerPorts.decisions` exposes the zero-dependency `AdvisoryDecisionPort` interface so `@loopwright/github-app` and `@loopwright/cli` inject live `@loopwright/decisions` adapters without creating package cycles. Standalone `kind: DecisionPolicy` defaults `disclosurePolicy` to `disabled`, whereas omitting `spec.decisions.disclosurePolicy` when `spec.decisions.enabled: true` in `kind: Taskpack` defaults to `public-metadata-only`.

| Port hook | Lifecycle point | Safety guarantee |
| --- | --- | --- |
| `routeCapabilityTier` | Role preparation | Preserves pinned role models (`userOverridePreserved: true`) |
| `evaluateCycleAlignment` | Before repair or `rejectTo` rework | Advisory route (`continue`, `revise`, `needs_review`, `blocked`) |
| `adviseSoftCompaction` | Prior to `pi.compact.v1` steps | Cannot veto active hard-compaction triggers |
| `triageCandidateDiff` | Post-capture pre-publication | Skips cleanly when `triageRules` is empty; sets `verificationCertified: false` |

- **Deterministic fallback**: Missing provider credentials, timeouts, or unreachable endpoints fall back deterministically (`source: 'deterministic_fallback'`) without blocking or certifying runs.
- **Non-delegable authority**: All six `DECISION_FORBIDDEN_AUTHORITY_INTENTS` (such as certifying verification receipts, bypassing required gates, overriding pinned models, expanding `writable` scope, or granting execution authority) are permanently refused and never sent to a decision model. Recorded entries appear in run observations (`advisoryDecisions`) with `verificationCertified: false`.

---

**See also** — [Taskpack](/loopwright/0.0/docs/configuration/taskpack/index.md) (embed `spec.decisions` in `.loopwright/taskpack.yaml`) · [Controller and Registry](/loopwright/0.0/docs/configuration/controller-and-registry/index.md) (deterministic controller authority)

**Next** → [GitHub Action](/loopwright/0.0/docs/operations/github-action/index.md) — wire secrets and triggers in GitHub Actions.
