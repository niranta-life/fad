# OpenAPI compatibility

Published file SHA-256: bb5a6dc96ae93fb42ed6b69af1770cd435bba43809c8942b0702d9a748beb4cc
Byte-identical to plans/fad-slice-0/contracts/openapi.yaml: true

## Published operations

- get /health/live
- get /health/ready
- get /v1/organizations/current

## Slice 0 contract diff

No added, removed, or changed bytes. Health and GET /v1/organizations/current are unchanged.

## Slice 1 proposed file

plans/fad-slice-1/contracts/openapi.yaml is a separate proposal. This check does not edit it.
Paths only in that proposal: /v1/agents, /v1/agents/{agentId}, /v1/agents/{agentId}/activate, /v1/agents/{agentId}/retire, /v1/agents/{agentId}/suspend
Slice 0 paths absent from that proposal: /health/live, /health/ready, /v1/organizations/current

The running API does not serve the Slice 1 agent paths. Shipping Slice 0 did not remove or alter the Slice 0 operations.

