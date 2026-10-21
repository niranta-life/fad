# FAD Slice 3 — Versioned Capabilities and Local Agent Discovery

**Status:** proposed production implementation contract, **not implemented**. **Date:** 2026-10-20. **OpenAPI:** 1.3.0 (`/v1`), additive over combined Slice 2 contract 1.2.0. **Backend only:** Node.js/TypeScript, PostgreSQL 16+, existing Node.js SDK and Docker deployment. No MCP, federation, invocation or policy engine in this slice.

## 1. Business value and scope

**User story:** An organization registers an AP matching capability as a versioned JSON Schema contract. An administrator adds an HTTPS endpoint to an existing agent, binds capability version 1.0.0 to that endpoint, and discovers the agent with the matching Finance tag. An application replaces a hard-coded endpoint with a directory query. A second organization cannot see or use any of the first organization's records. A suspended agent or disabled endpoint does not appear in results. Discovery explicitly says neither invocation authority nor runtime availability was checked.

**Included:** immutable tenant-scoped capability contracts and versions; endpoint declarations and versioned tombstones; one active version/endpoint binding per agent/capability ID; local capability+tag+protocol discovery; input size and query cost limits; scoped permissions; immutable audit/revision history; idempotent mutations; strong ETags; additive Node.js SDK; OCI rollout and evidence.

**Excluded:** endpoint probing or outbound HTTP; agent execution or calling A2A/MCP; runtime identity verification; health/latency/ranking claims; agent-card import; delegated authority; policy evaluation; tags inheritance; global/federated search; credential storage; Python/Java/Go/Kotlin SDK; bulk mutation; endpoint-scoped authorization or human approvals. Later slices own those areas.

## 2. Mandatory compatibility preflight

Before editing the source repository, inspect **actual deployed** Slice 0, Slice 1 and Slice 2 OpenAPI specs, migrations, SDK, auth scopes, DB roles and routes. Do not assume staged designs are deployed. The bundled `contracts/openapi.yaml` combines Slices 0–3 and passes semantic preservation checks against the attached Slice 2 baseline; actual deployed contracts remain authoritative. If they differ, reconcile **additively** and document the deviation. Never replace existing path operations, schema constraints, error formats, authentication behavior or agent/tag ETags. Preserve `X-FAD-API-Key` credential auth, `meta.api_version = v1`, existing Slice 0 current organization, Slice 1 CRUD/lifecycle and Slice 2 typed tags/search. An agent/tag-only change must NOT update a capability binding or endpoint revision; conversely a capability/endpoint operation MUST NOT bump agent/tag ETags.

Dependencies: `organizations`, `principals`, `agents`, `agent_revisions`, `audit_events`, `idempotency_records`, `tag_definitions`, `agent_tag_assignments`, `schema_migrations`, `fad_app` RLS role, tenant `SET LOCAL fad.org_id`, migration checksum lock, credential issuance allowlist. Stop if missing; do not silently regenerate older tables.

## 3. Canonical objects and invariants

### 3.1 `CapabilityVersion` (immutable)

- Primary key: `(organization_id, capability_id, version)`; no global catalog or shared organization namespace yet.
- `capability_id`: lowercase dot-separated 2–4 segments; each `^[a-z][a-z0-9_-]{0,39}$`; length up to 164. Example `finance.invoice.match`.
- `version`: strict three-part numeric `MAJOR.MINOR.PATCH` without `v`, leading zeros, prerelease or build. Example `1.0.0`. Range: each numeric component must also be <= 2^31-1; validate in application (regex alone does not bound magnitude).
- `display_name`: 1–160 NFC characters without control chars; `description`: 0–2000.
- `input_schema` and `output_schema`: JSON Schema Draft 2020-12 objects with bounded size (each <= 32 KiB), nesting <= 12 and <= 300 nodes. Must be syntactically validated using a pinned Draft 2020-12 validator. In Slice 3 reject `$ref`, `$dynamicRef`, `$id`, `$anchor`, `$dynamicAnchor`, `$recursiveRef` and any remote fetch; no network resolution or code execution. Reject unknown dialect declarations. An optional `$schema` must be the supported Draft 2020-12 URI. Validate formats consistently and avoid executing custom formats. Store canonical JSON; publish immutable objects. Constraint is contract syntax only, not verification that an agent really complies.
- `contract_sha256`: lowercase digest of RFC 8785 canonical JSON of `{id,version,display_name,description,input_schema,output_schema}` with default `description=""` inserted. Reject NaN/Infinity and malformed Unicode. The server computes digest and stores provenance (`published_by`, `published_at`). `verification` is always `self_declared` in responses.
- Publication of same ID+version with a new Idempotency-Key returns 409 `ALREADY_EXISTS` even if body is identical; exact previously committed replay with same key returns saved 201. Publish a new version for any contract changes. No deprecation or hard delete in Slice 3.

### 3.2 `AgentEndpoint` (declared connection metadata)

- Primary key `(organization_id, agent_id, endpoint_key)`; `endpoint_key` lowercase ASCII 1–40 chars. Up to **8 active** endpoints per agent.
- `protocol`: `a2a`, `mcp`, `http_json`. `url`: absolute HTTPS URI <=2048 characters; host DNS name, not IPv4/IPv6 literal; forbid userinfo, query, fragments, embedded credentials, control characters and IDN ambiguity (canonicalize hostname with a vetted URL parser, reject malformed inputs). Retain legitimate private DNS hostnames, because private cloud deployment is expected. **Never resolve DNS, connect to, test or fetch the URL in this slice.** Future network clients must enforce SSRF-safe egress separately.
- `auth_scheme`: declared one of `oauth2`, `mtls`, `api_key`, `none`; never accept a secret, token, private key, custom request header, or credential in metadata.
- `enabled`: boolean, default true. A disabled endpoint is not discoverable, though existing bindings may remain for reenable. Endpoint `verification` is `self_declared`.
- `revision` starts 1, increments on true update, deletion or recreation; tombstones retained to defeat ABA. Strong ETag `"endpoint-vN"`. PUT requires either `If-None-Match:*` or `If-Match:"endpoint-vN"` (exactly one). Stale returns 412, missing returns 428. Delete with active bindings returns 409 `ENDPOINT_IN_USE`. Same canonical data + satisfied precondition returns 200, unchanged ETag, no history mutation.
- Agent must be active or suspended for writes; retired is immutable, though it remains readable by authorized parties. Require `SELECT ... FOR UPDATE` on agent before endpoint mutations to serialize limits and retirement.

### 3.3 `AgentCapabilityBinding` (mutable declaration)

- Primary key `(organization_id, agent_id, capability_id)`; one active version per agent/capability ID; up to **32 active** bindings per agent. A binding references an immutable published capability version in the same org and a declared endpoint belonging to the same agent. Endpoints must be active (`is_deleted=false`) and `enabled=true` when creating/updating a binding. Endpoint disable later excludes matches but does not delete bindings.
- `version` and `endpoint_key` can change through conditional PUT. `revision` monotonically increases across deletion/recreation, strong ETag `"cap-binding-vN"`; no-op semantics match Slice 2 tags. Tombstones preserve history. Agent must not be retired for writes. Binding `verification` is always `self_declared`.
- Binding version does **not** imply semantic compatibility with another version. Discovery `version` is exact when provided, any registered version when absent. No automatic negotiation, fallback, or semantic version selection.
- A suspended/retired agent can retain endpoint/binding metadata, but discovery excludes it by default and exclusively returns active agents.

### 3.4 Audit and provenance

- Every successful new or changed endpoint/binding and capability publication commits state, immutable history (where applicable), idempotency record and existing `audit_events` in **one DB transaction**. For GET/search no mutation audit required, but structured read telemetry is expected without leaking restricted tag attributes.
- Record actor from authenticated credential, not request body. Record operation, org, target, revision, old/new metadata where safe, request id, outcome and time. Never include API keys, raw auth headers or secrets. Preserve existing `audit_events` semantics.
- On exact no-op with valid precondition, write no revision/audit mutation; on failed mutation record denial/failed outcome through existing security logging without pretending it was committed. Do not place credential secrets or hidden foreign IDs in audit details.

## 4. Auth and tenant-isolation matrix

All APIs use Slice 0 `X-FAD-API-Key`. Organization and actor come from verified credential only. All SQL includes authenticated `organization_id` and runs with `SET LOCAL fad.org_id` on the **same transaction connection**. App role is non-owner, non-superuser, no `BYPASSRLS` or DDL; new tables use FORCE RLS and same-org composite foreign keys. Cross-org/missing target IDs return identical 404 (not a federation lookup). Per-org quotas apply.

| Operation | Required scopes | Notes |
|---|---|---|
| Publish | `capabilities:write` | Only within resolved organization; schema check |
| Get/list catalog | `capabilities:read` | No global catalog |
| Endpoint get/list | `agents:read` AND `endpoints:read` | May reveal internal hostnames; least privilege |
| Endpoint PUT/DELETE | `endpoints:write` | No implicit authorization from owner |
| Binding get/list | `agents:read` AND `capabilities:read` | No invocation authority inferred |
| Binding PUT/DELETE | `capabilities:write` | Must resolve agent, endpoint and catalog in org |
| Discovery | `agents:read`, `capabilities:read`, `endpoints:read` | Add `tags:read` when tag predicates present; add `tags:restricted:read` for restricted predicate |

Extend existing credential scope allowlist additively: `capabilities:read`, `capabilities:write`, `endpoints:read`, `endpoints:write`. Do not grant new scopes to any previously issued credential automatically. If a client supplies a restricted tag predicate without permission, return generic 403 without echoing the tag value; missing/unauthorized restricted tag definitions must not be distinguishable. Restrict body size: publish <= 72 KiB, endpoint PUT <= 4 KiB, binding PUT <= 4 KiB, discovery <= 16 KiB.

## 5. Exact HTTP contracts

**Contract source:** `../contracts/openapi.yaml` (combined immutable earlier paths). **Examples:** `../examples/api-examples.md`. **Headers:** auth `X-FAD-API-Key` on all protected requests; `Idempotency-Key` required for POST publication and PUT/DELETE mutations; conditional headers for PUT/DELETE; response `X-Request-Id`, `Cache-Control: private, no-store`, `ETag` where applicable, `Location` on creates. Reuse existing `{data,meta}` and `{error,meta}` envelopes; on `204` send no body. Keep HTTP `POST /v1/discovery/agents` explicitly **read-only**, thus no idempotency key needed.

| Method | Path | Success | Notes |
|---|---|---|---|
| POST | `/v1/capabilities` | 201 | Publish immutable capability version |
| GET | `/v1/capabilities?id=...&limit=...&cursor=...` | 200 | Tenant catalog pagination |
| GET | `/v1/capabilities/{capabilityId}/versions/{version}` | 200 | Versioned contract |
| GET | `/v1/agents/{agentId}/endpoints` | 200 | Active endpoints, <=8; no page |
| GET | `/v1/agents/{agentId}/endpoints/{endpointKey}` | 200 | Current endpoint + ETag |
| PUT | `/v1/agents/{agentId}/endpoints/{endpointKey}` | 201/200 | Create/update, conditional |
| DELETE | `/v1/agents/{agentId}/endpoints/{endpointKey}` | 204 | Tombstone, must not have live binding |
| GET | `/v1/agents/{agentId}/capabilities` | 200 | Active bindings, <=32; no page |
| GET | `/v1/agents/{agentId}/capabilities/{capabilityId}` | 200 | Current binding + ETag |
| PUT | `/v1/agents/{agentId}/capabilities/{capabilityId}` | 201/200 | Create/update binding |
| DELETE | `/v1/agents/{agentId}/capabilities/{capabilityId}` | 204 | Tombstone binding |
| POST | `/v1/discovery/agents` | 200 | Local lookup, never calls endpoints |

**Errors:** Use prior format and stable codes. 400 invalid cursor/precondition shape; 401 invalid key; 403 scope denied; 404 unknown/other tenant; 409 duplicate version, invalid lifecycle, referenced endpoint, max cardinality; 412 stale ETag; 413 oversized; 415 incorrect content type; 422 contract/URL/semantic validation; 428 missing precondition; 429 throttling; 503 database unavailable; 500 redacted internal failure (global prior behavior). Never return private resource existence through error details. Retry only safe/idempotent operations.

### 5.1 Discovery semantics

Required `capability.id`; optional exact `capability.version`; optional `tags` (1–8 inherited Slice 2 `TagPredicate` objects with AND/equality), optional `protocols`, `limit` 1–50 (default 25), opaque `cursor`. Resolve tag visibility **before** composing the query. Reject repeated predicates of the same tag key. Search within one organization only.

An agent matches when ALL are true:
1. It belongs to caller org and `status = active`.
2. It has a non-tombstoned binding for requested capability ID and optional exact version.
3. Bound endpoint is non-tombstoned and `enabled=true`; its protocol matches any provided `protocols`.
4. Every visible, authorized tag predicate matches an active assignment exactly by typed value.

At most one row per agent because binding key is `(agent, capability_id)`; result includes existing Slice 1 `Agent` schema unchanged, the matching binding and endpoint declarations, `verification:self_declared`, `availability:not_checked`, `invocation_authorization:not_evaluated`. No runtime probe, cross-tenant fetch or federated lookup. Do not construct guessed invocation URLs.

Sort by immutable agent UUID ascending. Cursor contains version, authenticated org ID, principal ID and permissions fingerprint, canonical filter digest, last agent UUID and expiration (<=15 min); sign with rotated deployment-held HMAC key, verify constant-time, no raw secrets. After token expiry/key rotation return generic 400 `INVALID_CURSOR`. **Pagination is not a snapshot:** modifications between pages can cause an item to appear/disappear. No total count is returned. Bounded read statement timeout, `LIMIT limit+1` and appropriate tenant-first indexes. For large workloads later add catalog/search projections after measuring usage, without making them authoritative.

### 5.2 Unverified metadata boundary

Endpoint declarations and capability bindings are supplied by authorized administrators, not attested runtime evidence. `verification = self_declared` is mandatory even for `auth_scheme=mtls`. Another agent MAY discover a suitable candidate but MUST independently authenticate, authorize and validate protocol semantics before invoking it. Discovery is not an authorization decision. A2A card import/export and MCP management are explicitly later slices; do not add either here.

## 6. Database migration and consistency

Migration: `../migrations/20261020_003_capabilities_discovery.up.sql`. Adds five tables: `capability_versions`, `agent_endpoints`, `agent_endpoint_revisions`, `agent_capability_bindings`, `agent_capability_binding_revisions`. Adds tenant-first indexes, FK constraints, RLS policies, read/write grants. It does **not** change existing tables. Migration runner acquires a migration lock, validates checksums, applies this file + its `schema_migrations` record in one transaction; never app startup and never `fad_app`. A PostgreSQL `CHECK` is a second line of validation, not a complete URI/Schema validator.

Mutation transaction lock order: lock `agents` row first; then endpoint row (if any); then binding row (if any). For capability version publish, catalog unique constraint serializes conflict. For binding PUT, verify endpoint state under lock and lock parent to serialize concurrent endpoint disable/delete/retirement. Endpoint disable/delete obtains parent lock and checks live bindings for deletion before commit. Count current live endpoints/bindings within locked agent transaction to enforce 8/32 limits. Do not update `agents.revision` or tag revision. Use idempotency service from Slice 0 to atomically save committed HTTP status/headers/body; an exact replay after re-auth and current permission verification returns the recorded result. A duplicate key with different method/path/headers/body has conflict semantics per existing idempotency contract. `204` responses store `{}` in database envelope as required but never send an HTTP body.

Use per-field DB checks, application-level JSON Schema guards and URL validation. Consider DB role-verified immutable history protections in security tests. `up.sql` is forward-only; see adjacent `rollback.md`. To revert service, deploy previous binary while preserving tables/data. Do not run destructive down migration in production.

## 7. End-to-end user journey (real system required)

Precondition: two active orgs A/B, distinct auth credentials and principals, one active A-owned registered agent and optional B-owned agent; valid scoped credentials, and an A tag `department.name=finance` from Slice 2. See `../verification/acceptance-smoke.sh` for API journey.

1. A publishes `finance.invoice.match` at `1.0.0` with input/output JSON Schemas. Verify 201, stable id/version/hash, published_by A principal.
2. A reads catalog, exact version and immutable content. Retry publish with same idempotency key and payload; verify saved response and no duplicate audit change. Different body with same key must conflict.
3. A defines endpoint `primary` on registered agent using HTTPS, protocol `a2a`, `auth_scheme=oauth2` and `If-None-Match:*`. Verify 201 and `"endpoint-v1"`; follow with GET.
4. A binds `finance.invoice.match` version `1.0.0` to `primary` using `If-None-Match:*`. Verify 201 and `"cap-binding-v1"`.
5. A calls discovery for capability and `department.name=finance`, `protocols:["a2a"]`. Verify one matching agent, provenance `self_declared`, no auth or uptime claim. Verify standard Slice 1 GET `ETag` unchanged.
6. B calls GET using known A agent, capability ID and endpoint key: no leakage (404 or tenant-empty results as appropriate). B's discovery returns zero A agents.
7. Disable A endpoint with valid `If-Match` and new idempotency key. Discovery must exclude agent. Reenable and verify it returns. Suspend the agent via Slice 1; discovery excludes it; reactivate and returns.
8. Submit stale endpoint/binding `If-Match`, disallowed protocol, URL containing credentials, invalid schema refs, missing required scope, and duplicate version; assert correct non-success errors.
9. Attempt endpoint deletion while binding is active => 409. Delete binding with current ETag; delete endpoint with current ETag; discovery excludes agent. Recreate endpoint with `If-None-Match:*` => revision exceeds old tombstone; stale old ETag never succeeds.
10. Restart API containers; verify catalog and remaining agent metadata persist. Verify continued Slice 0–2 smoke tests and SDK integration through an independent Node.js consumer.

## 8. Scale, resilience and observability

Initial budgets (targets, not measured): catalog GET p95 <100ms, indexed local discovery p95 <250ms with 100k agents/org, 1M live bindings/org, 8 tag predicates, 100 concurrent discovery requests on benchmark deployment; API availability 99.9%; no cross-org exposure. Actual performance must be load-tested with documented hardware, traffic and data distribution. Full DB is authoritative. No cache initially; cache only after measuring and with invalidation rules. Stateless server replicas, pooled DB, bounded connections, fixed request sizes, slow query instrumentation, rate/quota limits, per-tenant fair use and circuit-safe dependency failure. RLS security on pooled connections must reset when transaction ends; test reuse across orgs. Do not put secrets, restricted tag values or private agent URLs in public metrics/logs.

Telemetry: request latency/status by route and anonymized tenant index; discovery match count histogram but not leaked to unauthorized callers; publish/bind/endpoint mutation outcomes; DB pool wait, query timeout, cursor rejects, idempotency replay count, security denials, RLS tests. Carry request IDs and trace context from REST through SQL/audit. Disable sampling for security mutation audit records, but not necessarily all traces.

## 9. Deployment, rollout, rollback

Use the Slice 0 OCI application image and deployment pattern; add migrations and new code without altering old endpoints. Migration process uses isolated privileged credentials; runtime uses `fad_app`; credentials from secret store/env (never embedded image or Compose). `docs/releases/slice-3/` stores migration checksum, commands, real HTTP evidence, SDK test output, smoke result, load benchmark and rollback simulation. Staged rollout: backup/restore check; assert Slice 0–2 contracts; apply forward-only migration transactionally; deploy image with Slice 3 endpoints **disabled by feature flag**; health/readiness and old regression suite; enable slice3 for test org, then canary then general rollout; monitor error/latency/denials. Roll back application using old image and retain Slice 3 tables. Ensure startup fails if a required schema migration is absent when Slice 3 is enabled, while Slice 0–2 endpoints continue to operate when disabled. See `../deploy/OPERATIONS.md`.

## 10. Verification and evidence gates

`../verification/TEST_MATRIX.md` contains test IDs, expected outcomes and mandatory evidence. **Must execute**, not merely design: happy-path API script; independent SDK consumer; 3+ parallel API replicas sharing DB; concurrent PUT/DELETE and agent retirement races; tag-restricted search; malicious schema and URL inputs; RLS direct SQL negative tests; transaction rollback injection (no partial audit/revision/idempotency); retry/replay; cursor tamper; restart/failover; deployment rollback; full Slices 0–2 compatibility suite; OpenAPI schema/conformance; selected load test. Track checksums and test results in evidence. No fabricated results, screenshots, logs or claims. One focused Git commit after all tests; concise ASD-STE100 message. Stop at Slice 3.

## 11. Handoff

Slice 4 MCP adapter MUST wrap these same application services and authorization. Slices 5–6 treat tag and capability claims as input but never as proof of action authority. Slice 8 introduces verified workload identity; Slices 9–10 add delegation and revocation. Slices 11–13 add federation and issuer trust. Future A2A Agent Card import/export must map external schemas and metadata with provenance, not silently elevate self-declared claims.
