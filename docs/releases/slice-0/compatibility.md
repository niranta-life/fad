# Slice 0 compatibility notes

Published OpenAPI SHA-256: `bb5a6dc96ae93fb42ed6b69af1770cd435bba43809c8942b0702d9a748beb4cc`.

`contracts/openapi.yaml` is byte-identical to `plans/fad-slice-0/contracts/openapi.yaml`. See `openapi-diff.md`. Operations are `GET /health/live`, `GET /health/ready`, and `GET /v1/organizations/current`.

Migration `0001_foundation` checksum: `09fb08e50ca20f3c1f18a32e93c03260f476c52816a976e1754a8b34505dc463`.

Migration `0002_rate_limit` checksum: `2b8f86066af0b29968268db39ca3dd297677321339b947d46e46613f68811924`. This file is additive. It does not change the 0001 bytes.

`plans/fad-slice-1/contracts/openapi.yaml` was not modified. It proposes `/v1/agents` paths and does not list the Slice 0 health or organization paths. The running API does not serve `/v1/agents`.

Slice 1 can add tables and routes without renaming these three operations, the `X-FAD-API-Key` header, the success and error envelopes, or `principals(organization_id, id)`. Reserved scopes `agents:read`, `agents:write`, and `agents:lifecycle` can be stored. They do not expose agent routes in this release.

Architecture decisions for reference defects are `docs/adr/0001-migration-operator-ownership.md` through `docs/adr/0008-ingress-tls.md`.
