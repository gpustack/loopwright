# Controller acceptance authoring

The original TaskContract controls core acceptance. Controller scope and equality jobs are additional observations;
their IDs are not inserted into an admitted contract. A changed candidate can complete with a failed implicit equality
comparison if scope and every original required check pass.

To permit `no_change`, declare a required check in the original task:

```json
{
  "required": ["tests", "unchanged"],
  "checks": [
    {"id": "tests", "allowedEvidenceLevels": ["local_execution"]},
    {"id": "unchanged", "allowedEvidenceLevels": ["local_execution"]}
  ]
}
```

The operator's approved registry binds `unchanged` to the shipped `no-change.v1` handler with parameters
`{"checkId":"unchanged"}`, the installed handler digest, version 1, and capabilities `inert_bytes` and `read_only`.
The task selects approved identities; it cannot approve a digest or implementation. The declared check and the implicit
equality job execute separately. JSON plus declared equality plus both implicit slots gives C=4 in capacity preflight.

Static check/dry-run exposes `noChangeEligibility`. It selects the lexically first eligible originally required ID
before outcomes. Optional-only checks, disallowed evidence levels and other handlers cannot supply the proof.
The selected check needs its own current Worker/receipt evidence, and all required checks and implicit guards must pass.

A task without that declaration remains valid for completed. A requested no_change is blocked with
EVIDENCE_UNAVAILABLE when its original binding is absent, subject to higher terminal precedence. The controller preserves
the request and observed comparison, starts no repair and changes no contract. A failed actual predicate stays failed.
These are authoring rules; this document is not runtime or live-provider qualification.

JSON verification uses a single bounded packet with both complete source/candidate manifests inside its 16384-byte
header. All expectations and maximal dispatch framing count toward that header. A valid inventory or small selected
file can still exceed JSON header eligibility; it refuses before initial admission or later verifier dispatch.
The selected-file bound is 1032184 bytes, conditional on a fitting complete header. No truncation or extra packet is used.
The Worker distinguishes an absent path from a present zero-byte file using the complete manifest; both are honest
failed predicates with different reasons. Missing files never become invented empty content.

The local CLI accepts explicit configuration/registry paths and registry SHA256. `check` and `run --dry-run`
produce a bounded plan with no admission. A private role command appears as a SHA256 placeholder; execution reads
its original bytes only from the approved loaded registry. See [controller commands](../docs/controller.md).

## Configuration and MCP credential authoring

These JSON excerpts show the credential and MCP fields in the two envelopes. Complete the omitted task, profiles,
handlers, runtime identity and controls before use; the registry digest must match the exact approved registry bytes.

```json
{
  "apiVersion": "loopwright.dev/controller/v1alpha1",
  "kind": "TrustedRegistry",
  "metadata": {"id": "operator"},
  "spec": {
    "roleProfiles": [{
      "id": "builder",
      "providerCredentialRef": "provider-token",
      "mcp": {
        "serverId": "workspace",
        "transport": "sessionless-http-json-v1",
        "destinationRef": "mirror",
        "endpoint": "http://127.0.0.1:39101/mcp",
        "approvedAddresses": ["127.0.0.1"],
        "credentialRef": "mirror-token",
        "names": ["mcp__workspace__read_file"],
        "effects": ["read_only"],
        "idleTimeoutSeconds": 2,
        "absoluteTimeoutSeconds": 10
      }
    }],
    "credentialBindings": [
      {"id": "provider-token", "consumer": "provider", "destinationRef": "github-copilot", "environmentNames": ["PROVIDER_TOKEN"], "template": "${PROVIDER_TOKEN}"},
      {"id": "mirror-token", "consumer": "mcp", "destinationRef": "mirror", "environmentNames": ["MCP_TOKEN"], "template": "${MCP_TOKEN}"}
    ],
    "environmentBindings": [
      {"name": "PROVIDER_TOKEN", "classification": "credential", "paths": ["/spec/credentials/0/template"]},
      {"name": "MCP_TOKEN", "classification": "credential", "paths": ["/spec/credentials/1/template"]}
    ]
  }
}
```

```json
{
  "apiVersion": "loopwright.dev/controller/v1alpha1",
  "kind": "ControllerConfig",
  "metadata": {"id": "task"},
  "spec": {
    "credentials": [
      {"ref": "provider-token", "template": "${PROVIDER_TOKEN}"},
      {"ref": "mirror-token", "template": "${MCP_TOKEN}"}
    ]
  }
}
```

Use `$$` for a literal dollar sign; `$${NAME}` remains literal `${NAME}` after one pass. Loopback HTTP MCP uses
`http://127.0.0.1:<port>/...` with `approvedAddresses: ["127.0.0.1"]`; remote HTTPS MCP uses a DNS hostname endpoint
(SNI matches the endpoint hostname against the system trust store) with its pinned `approvedAddresses`.

```ts
import { loadTrustedConfiguration, compilePlan } from '@loopwright/controller';

const loaded = await loadTrustedConfiguration({
  configPath, registryPath, registrySha256, untrustedRoots: [repository],
});
if (!loaded.ok) throw new Error(loaded.error.code);
const plan = await compilePlan(loaded.value);
if (!plan.ok) throw new Error(plan.error.code);
```
