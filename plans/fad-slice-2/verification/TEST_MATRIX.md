# Slice 2 Required Test Matrix

Tests must run against real PostgreSQL 16+, actual API, real credentials, and independently installed Node.js SDK. Static contract checks are necessary but not sufficient. Every passing case records command, fixture, redacted HTTP/database output, and test log.

## A. Backward compatibility (8)

- C01 Slice 0 GET `/health/live` response/schema unchanged.
- C02 Slice 0 GET `/health/ready` unchanged except expected schema-ready status.
- C03 Slice 0 GET `/v1/organizations/current` unchanged with existing credential.
- C04 Slice 1 POST `/v1/agents` unchanged; same request, response and scope.
- C05 Slice 1 GET list/get unchanged; same pagination and ETag.
- C06 Slice 1 PATCH and lifecycle endpoints unchanged including stale ETag handling.
- C07 Previously released Node.js SDK works unmodified against Slice 2 image.
- C08 All prior OpenAPI operations and required fields remain; compatibility checker reports additive changes only.

## B. Definition validation and governance (13)

- D01 Create string definition -> 201, immutable server-derived metadata.
- D02 Create integer/boolean/enum definitions -> 201.
- D03 `enum_values` missing on enum, present on non-enum -> 422.
- D04 Duplicate enum member, empty member, >32 members, >64 chars -> 422.
- D05 Invalid uppercase/space/slash/unicode-confusable namespace/key -> 422.
- D06 Reserved `security` / `compliance` / `system` ungoverned/internal -> 422, no row.
- D07 Governed or restricted creation without `tags:governance` -> 403.
- D08 Governed+restricted creation by authorized admin -> 201.
- D09 Definition ID unique within tenant; same key in different tenants allowed.
- D10 Duplicate create with new key -> 409 conflict; identical idempotency replay -> original 201.
- D11 Definition list excludes restricted definitions for unprivileged reader with no hidden counts.
- D12 Direct read of restricted definition without permission indistinguishable from nonexistent -> 404.
- D13 Definition quota 256 under parallel create; no bypass; rejected overage stable 422/429 per documented quota mapping.

## C. Assignment validation and lifecycle (17)

- A01 Assign normal tag with `If-None-Match:*` -> 201, ETag `"tag-v1"`.
- A02 Update with valid `If-Match` -> 200, revision increments exactly once.
- A03 Read tag -> typed value, ETag, provenance; parent agent ETag unchanged.
- A04 Assign boolean `false` and integer `0` successfully.
- A05 Reject string empty/null/array/object/control chars >128/NFC violation.
- A06 Reject integer float/exponent beyond bounds/`NaN`/incorrect primitive type.
- A07 Reject enum string not in allowed set (case sensitive).
- A08 PUT missing both preconditions -> 428, both -> 400, weak/list/wildcard improper -> 400.
- A09 PUT absent with `If-Match` -> 412; present with `If-None-Match:*` -> 412.
- A10 Repeated same value with matching ETag -> 200 no revision/history mutation.
- A11 Governed write without `tags:governance` -> 403; missing reason by authorized governance writer -> 422.
- A12 Governed DELETE without reason -> 422; normal authorized delete -> 204.
- A13 DELETE with stale ETag -> 412, missing ETag -> 428, absent -> 404.
- A14 Delete + recreate -> revision > deleted revision (ABA prevention); stale prior ETag remains invalid.
- A15 Retired agent refuses PUT/DELETE (409); suspended permits classification.
- A16 Max 64 active tags enforced even with parallel writes to distinct keys.
- A17 Reads include at most authorized active assignments; tombstones invisible.

## D. Tenant and privilege attacks (13)

- S01 Org A cannot read Org B definition, even with identical names.
- S02 Org A cannot assign/delete tag on Org B agent; 404 indistinguishable.
- S03 Org A cannot filter for Org B agent via search or cursor.
- S04 Direct DB session without `fad.org_id` sees zero rows/cannot insert.
- S05 Forged `fad.org_id` header/query/body cannot change authenticated scope.
- S06 Composite FK blocks mismatched `(organization_id,agent_id)`.
- S07 No BYPASSRLS on `fad_app`; no DDL, no DELETE, no direct UPDATE on definitions/history.
- S08 Tag editor cannot assign self `security.risk=low` without governance scope.
- S09 Restricted tag lookup without restricted-read -> 404 (not value leak).
- S10 Restricted tag search predicate without restricted-read -> 403, no matches.
- S11 Credential with `tags:write` but no `agents:write` can tag but cannot modify agent metadata.
- S12 Agent owner metadata alone does not give tags write permission.
- S13 Invalid/revoked/expired key -> 401, and disabled organization/principal denied.

## E. Concurrency / idempotency / durability (12)

- R01 Concurrent PUT same absent assignment with unique keys -> exactly one 201; loser 412.
- R02 Concurrent PUT same existing revision -> exactly one update; loser 412.
- R03 Idempotency same key+same fingerprint -> same business result/revision; new request ID.
- R04 Idempotency same key+different body -> 409 no change.
- R05 Idempotency same key+different conditional headers -> 409 no change.
- R06 Identical concurrent retries -> one history row/audit mutation, same response.
- R07 Idempotency replay after independent later change returns original business result (not current state) without mutation.
- R08 Audit insert failure rolls back assignment, history and idempotency response.
- R09 Transaction aborted before commit -> no partial rows.
- R10 Race with Slice 1 `retire` cannot commit tag mutation *after* retirement wins.
- R11 Container restart preserves definitions, assignments and revisions.
- R12 Checksum migration applied once; concurrent migrators locked; migrate from prev version without data loss.

## F. Search, SDK and operations (16)

- Q01 Tag search exact AND predicates returns matching active agents only.
- Q02 Search with zero/one/many predicates enforces minProperties, 8 max, duplicate key validation.
- Q03 Unknown definition, wrong value type, unsupported operator -> 422.
- Q04 Search `status` filter, limit and page cursor stable order, no duplicate agents.
- Q05 Cursor cannot be reused with different org, filters, scope-set or expiry.
- Q06 Definition list cursor pagination sorted and visibility-safe.
- Q07 Search SQL plan uses bounded tenant-first index and parameter binding.
- Q08 No tag value or governed change reason in access logs/metrics.
- Q09 New SDK create/list/get definition works in independent Node.js consumer.
- Q10 New SDK put/get/delete and ETag propagation works.
- Q11 New SDK tag search and pagination work without modifying existing agent type.
- Q12 SDK `false` and `0` round-trip; timeout/cancel; typed errors.
- Q13 Existing SDK error/timeout/retry behavior still passes.
- Q14 DB outage fails closed with 503 and no speculative success.
- Q15 Tag feature disabled -> old routes healthy; tag routes unavailable as documented, no schema access.
- Q16 Rolling deployment and rollback to previous API image preserve data and old endpoints.

**Total: 79 named cases.** High-priority acceptance subset is C01-C08, D01/D06/D07/D08, A01/A02/A04/A11/A14, S01/S02/S04/S08/S10, R01/R02/R06/R08/R10, Q01/Q05/Q09/Q10/Q14/Q16. Any tenant-isolation, governed-edit bypass, partial durable write, or API backward-compatibility failure blocks release.
