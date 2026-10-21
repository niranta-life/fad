# Slice 0 automated verification matrix

The /goal implementation must add actual tests with these stable IDs. `acceptance-smoke.sh` is a real probe for a running API, but by itself it cannot validate database isolation or bootstrap security. Evidence is mandatory.

| ID | Layer | Test | Expected proof |
|---|---|---|---|
| S0-A01 | API | Live endpoint without key | 200, `{status:ok}`, no internals |
| S0-A02 | API | Ready with DB migrated | 200 `{status:ready}` |
| S0-A03 | API | DB down or incompatible schema | 503 `{status:not_ready}`; current returns 503 |
| S0-A04 | API | Org A key current | 200, Org A id, request ID and no-store |
| S0-A05 | API | Org B key current | 200, Org B id |
| S0-A06 | API | Header `X-Organization-Id: B` with A key | Still A or rejected, never B |
| S0-A07 | API | `organization_id` query override | 400 `VALIDATION_ERROR` |
| S0-A08 | API | Missing, malformed, unknown kid/wrong secret | Uniform 401 error; no verifier leak |
| S0-A09 | API | Expired/revoked key | 401 all replicas, no grace for new requests |
| S0-A10 | API | Valid key without org read scope | 403 |
| S0-A11 | API | Inactive org/principal | 401 generic, no status leak |
| S0-A12 | API | Oversized/multiple credential headers | 401/400 per documented parser rule, no crash |
| S0-A13 | API | Unsupported method/body/unknown query | 405/400 consistent, no auth bypass |
| S0-A14 | API | Rate limiting (distributed) | 429 + `Retry-After` |
| S0-D01 | SQL | Composite principal FK prevents cross-tenant credential | SQL rejection |
| S0-D02 | SQL | RLS without `fad.org_id` | No records visible, writes refused |
| S0-D03 | SQL | RLS under A sees only A, after B only B | Tenant-bounded SELECT/INSERT |
| S0-D04 | SQL | Reused pooled connection after transaction | No context carry-over |
| S0-D05 | SQL | `fad_app` SELECT on credential table | Permission denied |
| S0-D06 | SQL | `fad_app` direct UPDATE or DELETE audit | Permission denied |
| S0-D07 | SQL | Privileged security-definer only for kid lookup | Only matched verifier returned; unexpected SQL prevented |
| S0-D08 | SQL | Failed audit insert rolls back security mutation | No mutation without audit |
| S0-D09 | SQL | Idempotency unique conflict (same org, principal, key) | One committed result; request hash mismatch rejected |
| S0-D10 | SQL | Idempotency across two orgs | No shared replay keys |
| S0-D11 | SQL | Migration re-run and bad checksum | Safe reject, no partial mutation |
| S0-I01 | Credentials | Issue key with full-entropy kid and secret | Issued once, only verifier stored |
| S0-I02 | Credentials | Wrong secret for correct kid | 401, no leak; constant-time digest comparison |
| S0-I03 | Credentials | Rotate successor and revoke predecessor | Success with new; 401 old |
| S0-I04 | Credentials | Invalid/unknown scope issuance | CLI refuses |
| S0-I05 | Credentials | Cross-org principal attachment | DB FK + CLI rejects |
| S0-I06 | Credentials | Pepper unset or weak | Fail startup/readiness, not fallback |
| S0-O01 | Docker | Build and run as nonroot with read-only FS | UID != 0, 200 health |
| S0-O02 | Docker | 2 replicas behind load balancer | No cross-tenant confusion |
| S0-O03 | Docker | Graceful shutdown | No leaked connection or corrupt transaction |
| S0-O04 | Docker | DB outage/recovery | 503 during outage, 200 after recovery |
| S0-O05 | Docker | Container restart | Durable organization, revocation and audit |
| S0-O06 | Ops | Backup PITR restore drill | Verified RPO/RTO under target |
| S0-O07 | Ops | Static scan, dependencies, SBOM | Zero accepted critical vulnerabilities/secret leaks |
| S0-K01 | SDK | Install packed @fad/sdk in clean project | Works without server internals |
| S0-K02 | SDK | Real `organizations.current()` | Typed data + meta |
| S0-K03 | SDK | 401/403/429/503 error mapping | Stable error type and requestId |
| S0-K04 | SDK | Aborted/timed-out fetch | Cancellation and no secret leak |
| S0-K05 | SDK | Redirect with credential | Error, never forwards key |
| S0-C01 | Contract | OpenAPI parse, resolve and wire validate | No undefined references and exact envelopes |
| S0-C02 | Contract | Slice 1 compatibility fixture | `principals(organization_id,id)`, `fad_app`, `fad.org_id` |
| S0-C03 | Contract | OpenAPI diff on next slice | No breaking existing paths/schemas |

### Artifacts

`docs/releases/slice-0/` must contain `goal.md`, `plan.md`, `api-evidence/`, `db-evidence/`, `security-evidence/`, `sdk-evidence/`, `deployment-evidence/`, `coverage/`, `openapi-diff.md`, `risks.md`, `completion.md`. Include unaltered test command output, timestamps, sanitized trace IDs, CI job URL and commit hash. Do not fabricate successful results. Store redacted evidence only.
