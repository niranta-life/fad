# FAD Slice 2 — Typed Tags: Production Implementation Specification

**Status:** design/implementation contract, not implemented. **Date:** 2026-10-20. **API:** `/v1`, combined OpenAPI contract version `1.2.0`. **Technology:** existing Slice 0–1 Node.js/TypeScript service, PostgreSQL 16+, TypeScript SDK, OCI containers. No separate tag service or database.

## 1. Value and exact boundary

Deliver typed, tenant-owned, searchable, governed agent tags. An authorized developer can define `department.name` as a string, assign `finance` to a non-retired agent and discover matching agents. A security administrator can define `security.risk` as restricted/governed enum, assign `high`, and prove a normal tag editor cannot alter it. These are classification/registry operations. **Tag labels never confer privileged authority** in this slice. Slices 5–6 introduce explicit tag-based policy evaluation/enforcement.

Included: immutable definitions; typed scalar values; scoped create/read; per-agent assignment create/read/update/remove; tombstones and immutable revisions; tagged agent search; tenant/scope/visibility checks; SDK methods; Docker rollout; negative tests and evidence. Excluded: inheritance, free-form JSON, collections/multivalued tags, bulk writes, arbitrary conditions, tag policy DSL, delegation, MCP, federation, public sharing, changes to existing `Agent` representation. No background process is required.

## 2. Mandatory preflight / immutable compatibility

Before implementation, inspect installed migrations and actual released contracts for **Slice 0** and **Slice 1**; do not assume files in this package were already applied to a running service. Required structures: `organizations(id)`, `principals(organization_id,id,status)`, `agents(organization_id,id,status,revision)`, `audit_events`, `idempotency_records`, migration-runner checksum/lock, credential scopes and revoked/disabled organization validation. Existing request context uses authenticated `organization_id` and `principal_id` plus scopes. Existing runtime DB role `fad_app` has no table ownership, DDL or `BYPASSRLS`. It sets `fad.org_id` using `set_config(..., true)` inside the current transaction connection. Existing agent APIs and status transitions MUST NOT change.

OpenAPI file `contracts/openapi.yaml` is a combined Slices 0–2 specification. Schema and response component names for Slice 0 may be renamed internally to avoid duplicate `$ref` identifiers; their HTTP representations, behaviors, routes, and auth header **must be identical** to published Slice 0. The spec assumes Slice 1's `X-FAD-API-Key` credential and `Idempotency-Key`, and uses Slice 1 response envelopes/error vocabulary. Check and lock an API baseline before changing code. No tag properties may be added as **required** to previously published `Agent` responses. Parent agent revision/ETag remains unchanged when only its tags change.

## 3. Canonical objects and invariants

### 3.1 TagDefinition

- Tenant-scoped identity: `(organization_id, namespace, key)`. Namespace/key are lowercase ASCII, 1–40 chars each, regex `^[a-z][a-z0-9_-]{0,39}$`, e.g. `department.name`, `security.risk`.
- `value_type`: `string` (nonempty NFC text, <=128 chars, no control characters), `integer` (JSON integer from -1,000,000,000 to +1,000,000,000), `boolean`, or `enum` (string equal to a declared case-sensitive member).
- `enum_values`: required only for enum; 2–32 distinct strings, length 1–64 each, NFC, no control chars, no duplicates.
- `governed`: boolean. Governed definitions require extra write authority for every mutation. `visibility`: `internal` or `restricted`. Governed implies restricted.
- Reserved namespaces `security`, `compliance`, `system` **must** be governed and restricted. Other namespaces can also opt into governance.
- `description` optional, max 500. Server sets `created_by` from authenticated principal and `created_at` from DB. Client cannot supply organization or principal IDs.
- Definitions are immutable after creation in Slice 2. To correct an incorrect definition, publish a new key; no update/delete API exists. Do not loosen definitions or rewrite existing assignments.
- A `tags:define` caller may create only ungoverned/internal definitions. Governed or restricted creation also requires `tags:governance`.

### 3.2 AgentTagAssignment

- Identity: `(organization_id, agent_id, namespace, key)`; composite FKs to same-org agents/definitions.
- Exactly one current active scalar value per agent/tag key. Revision starts at 1 and increases with each real value change, deletion, or reactivation. Deletion writes a tombstone instead of physically removing the assignment, avoiding the ABA/stale-ETag problem. Server retains first creator, last mutator, times, and immutable revision history.
- `GET` hides tombstones; `PUT` with `If-None-Match: *` can recreate a previously deleted assignment and MUST increment the persisted revision, not reset it to 1.
- `PUT` with the same canonical value is a no-op: return 200 and unchanged revision/ETag. Re-check the precondition first; stale ETag still fails. No-op does not create a new history or mutation audit event.
- Update/delete is forbidden when agent is `retired`, even if the tag exists; read remains possible. Active/suspended agents can be classified. Exactly 64 *active* tags per agent maximum in this slice; serialize assignment creation through a `SELECT ... FOR UPDATE` lock on the parent agent and count active assignments within the same transaction.
- Assignment history rows are append-only (`assigned`, `updated`, `deleted`) and are protected separately from the current-state row.
- `value` and `reason` are request data. `actor_principal_id`, `organization_id`, timestamps, and revision are ALWAYS server-derived. For governed PUT and DELETE, a nonblank reason (1–500 characters) is mandatory.

### 3.3 Future policy safety

- Tags are claims, not proofs. Unverified/self-declared and ordinary descriptive tags MUST NOT authorize high-privilege actions in future slices.
- Existing governed tags are administered only by `tags:governance`-authorized services. This is coarse-grained scope enforcement, **not yet** an ABAC or per-resource policy system.
- If a security tag is removed, downstream policy systems must treat the attribute as missing and deny rules that require a trusted value. No "missing means safe" shortcut is allowed.
- Never merge remote tags into locally governed namespaces. Federation is out of scope, but the record model has organization and issuer provenance.

## 4. Authentication, authorization and visibility

Authentication is identical to Slice 0. Credential resolves tenant, principal, active status and scopes, and the request never takes tenant from query/header/body. All auth/scope checks happen **before** idempotency replay and before disclosing target existence.

| Operation | Required scopes | Additional rule |
|---|---|---|
| Create definition | `tags:define` | `tags:governance` if governed or restricted |
| List/get definition | `tags:read` | Restricted definitions omitted on list, 404 on get unless `tags:restricted:read` |
| Get/list agent tags | `agents:read` AND `tags:read` | Restricted omitted on list; get returns 404 without `tags:restricted:read` |
| PUT/DELETE assignment | `tags:write` | `tags:governance` if governed/restricted |
| POST tag search | `agents:read` | With tag predicates, also `tags:read`; restricted predicate additionally `tags:restricted:read` |

A caller authorized to alter tags still does **not** get agent metadata write permission by implication, and an owner principal does not acquire tag write permission by being an owner. The v1 public response never includes protected reasons or credential details. When listing tags, filter before pagination/collection construction; do not leak forbidden counts, restricted key names, or timing-sensitive distinctions. For direct reads, hidden/missing/other-tenant keys all produce indistinguishable 404s. For search predicates explicitly mentioning a restricted key, return 403 with generic message, not a list of matching agent IDs.

**Bootstrap:** existing Slice 0 credential provisioning must accept new narrowly scoped strings: `tags:define`, `tags:read`, `tags:write`, `tags:governance`, `tags:restricted:read`. Extend the existing allowlist additively if one exists. Do not build a new identity provider or credential issuance endpoint.

## 5. Exact HTTP APIs

Source of truth: `../contracts/openapi.yaml`; use request/response data examples in `../examples/api-examples.md`. All protected endpoints require `X-FAD-API-Key`, TLS outside local dev, `Cache-Control: private, no-store` on body responses, an `X-Request-Id` per attempt, and `meta.api_version: "v1"`. No tenant-selection fields. All writes are size-limited to 16 KiB.

| Method | Route | Success | Required conditional headers |
|---|---|---|---|
| POST | `/v1/tag-definitions` | 201 | `Idempotency-Key` |
| GET | `/v1/tag-definitions` | 200 | none |
| GET | `/v1/tag-definitions/{namespace}/{key}` | 200 | none |
| GET | `/v1/agents/{agentId}/tags` | 200 | none |
| GET | `/v1/agents/{agentId}/tags/{namespace}/{key}` | 200 + strong ETag | none |
| PUT | `/v1/agents/{agentId}/tags/{namespace}/{key}` | 201 if new/recreated, 200 if updated/no-op | `Idempotency-Key`; exactly one of `If-None-Match: *` or strong `If-Match: "tag-vN"` |
| DELETE | same assignment path | 204 | `Idempotency-Key`, strong `If-Match: "tag-vN"`; governed deletion also `X-Change-Reason` |
| POST | `/v1/agents/search` | 200 | none (read-only search) |

**PUT precondition rules:** no active assignment -> only `If-None-Match: *` succeeds; active assignment -> only matching strong `If-Match` succeeds. Missing both => 428; both supplied => 400; weak values/ETag lists/`If-Match:*` => 400; incorrect but well-formed precondition => 412. Unknown/other-tenant agent => 404. Unknown definition => 404. Retired agent => 409. Missing governed reason => 422. Idempotency conflicts => 409. Replays are resolved before checking the new current ETag, **after** credentials and scopes have been checked.

**DELETE:** missing assignment or tombstone => 404; stale ETag => 412; real delete => 204 no response body, tombstone + revision + audit. Replay with same authenticated caller, normalized request and key yields 204 even if the resource is now absent. A different key against missing resource yields 404. Never return hidden tag values through errors.

**Errors:** retain the Slice 1 envelope and codes. New failures use `TAG_DEFINITION_NOT_FOUND` (404), `TAG_ASSIGNMENT_NOT_FOUND` (404), `PRECONDITION_REQUIRED` (428), `PRECONDITION_FAILED` (412), `VALIDATION_ERROR` (422), `IDEMPOTENCY_CONFLICT` (409), `INVALID_AGENT_STATE` (409), `FORBIDDEN` (403), `RATE_LIMITED` (429), `DEPENDENCY_UNAVAILABLE` (503). Include `error.code`, `error.message`, `meta.request_id`, `meta.api_version`. Do not add newly required fields to old error responses.

### 5.1 Search contract

`POST /v1/agents/search` is a **read**, not a mutation. Request contains `tags` with 1–8 AND predicates using `operator: "eq"`, `namespace`, `key`, and correctly typed `value`. It may additionally include `status`, `limit` (1–100, default 25), and `cursor`. An omitted `tags` array searches agents using only the optional status predicate. An empty request `{}` is rejected, so accidental broad scans are avoided. Repeated tag keys, unknown tag definitions, mismatched value types, unsupported operators, and unbounded filters are rejected. No arbitrary SQL or regular expressions. Any restricted predicate requires restricted-read permission. For `status` omitted, include all lifecycle states, matching Slice 1 listing semantics.

Return the **unchanged** Slice 1 `AgentListResponse` and `Agent` schema. Sort by `(created_at DESC, id DESC)`; filter via tenant-bounded `EXISTS` to avoid duplicates. Cursor includes authenticated tenant, canonical filter hash, last sort keys, version and expiry; sign with Slice 1 key management. Cursor with changed filter/tenant/key/expiration -> 400. No snapshot guarantee across pages; each page is consistent at query execution time. Queries require index-backed plans and strict tenant/caller quotas; never scan other tenants.

### 5.2 Definition listing

`GET /v1/tag-definitions?namespace=department&limit=25&cursor=...`. Sort `(namespace ASC, tag_key ASC)`. Restrict visibility *before* selecting page keys. Opaque signed cursor binds authenticated tenant, filters and visibility scope; prior cursor reused with different permission set fails. `GET` list returns visible definitions only; no total count. Enforce definition quota initially max **256 per tenant**; tag assignment quota max **64 active per agent**; both limits configurable downward. Use tenant-scoped row locking to prevent concurrent quota bypass during definition creation; lock `organizations` row inside tenant transaction.

## 6. Database design and query algorithm

Migration: `../migrations/20261020_002_typed_tags.up.sql`. Creates: `tag_definitions`, `agent_tag_assignments`, `agent_tag_assignment_revisions`, validation triggers, indexes, strict composite FKs, RLS `ENABLE` and `FORCE`, `fad_app` SELECT/INSERT/UPDATE as required. Runtime cannot UPDATE/DELETE definitions or history; it cannot DELETE assignment rows. Tag current-state rows are tombstoned. No renaming or altering Slice 0/1 tables.

**Important:** migration must be run with migration lock and version/checksum record in same transaction, using the established runner. The SQL file contains **no** standalone `BEGIN`/`COMMIT`; the migration runner must wrap the schema statements plus the migration checksum insertion in one transaction. Once shipped, migration bytes are immutable; fixes use a new migration.

### Assign/change transaction

1. Authenticate and resolve scoped org/principal; check required scopes.
2. Validate content type, headers, normalized body (including NFC and enum values) and size.
3. Begin DB transaction on one connection; set local `fad.org_id` from trusted context.
4. Check committed idempotency record for exact `(org,principal,method,path,key,fingerprint including body and conditional headers)`. Return existing result if identical. If different, 409. Credential authorization is still rechecked for replay.
5. Lock target agent row `SELECT ... FOR UPDATE` scoped by organization; 404 if absent, 409 if retired. This serializes assignment count changes and prevents races with agent retirement.
6. Load tag definition in same organization, enforce governed/restricted scopes and reason; 404 for nonexistent tag definition. For sensitive write attempts without scope, deny without exposing values.
7. Lock current assignment row; apply If-Match/If-None-Match atomically, distinguishing active and tombstoned versions. Concurrent `PUT` for the same new key must serialize on agent lock or resolve unique conflicts as 412.
8. Enforce <=64 active tags per agent for new/recreated assignments. Compare canonical typed values. If unchanged, 200 with existing ETag and no mutation history.
9. For actual changes, write current assignment/tombstone, append exactly one immutable history revision, insert one audit event and one idempotency result **in the same transaction**.
10. Commit; return strong ETag for current assignment. API `meta.request_id` must be fresh for this HTTP attempt even on replay (reconstruct envelope from stored business result). On database error, rollback and do not emit success.

**Race with Slice 1 retirement:** If retirement code does not acquire the parent agent row lock, adjust the Slice 1 transition implementation so it serializes with tag assignment writes without changing external API behavior. Otherwise the transaction can validate an active agent while a concurrent retirement commits. Record reconciliation decision in `docs/releases/slice-2/compatibility.md`.

### Read transaction

Use scoped authenticated transaction; verify target agent belongs to caller's org, apply visibility filters at SQL level (not after an unbounded fetch), return typed JSON scalars and the per-assignment ETag. Failure to set transaction context returns no rows. Never accept org IDs from request metadata.

### Indexes and scale

- Equality filter index `(organization_id,namespace,tag_key,tag_value,agent_id) WHERE NOT is_deleted`.
- Agent tag listing index `(organization_id,agent_id) WHERE NOT is_deleted`.
- Primary keys `(organization_id, agent_id, namespace, tag_key)` and `(organization_id, namespace, tag_key)`.
- Query predicates use parameterized SQL + indexed `EXISTS` and bounded page size.
- If index size or large-tenant skew grows, measure before changing to hash/projection tables. Redis is not required for Slice 2 and must never be source of truth for governed tags.
- Strong read-after-write consistency from PostgreSQL primary for governance operations; replicas may be introduced only with documented staleness constraints, not for authoritative security decisions.

## 7. SDK integration

Implement methods in existing Node.js SDK, without breaking its Slice 0 or 1 exports:

```ts
fad.tagDefinitions.create(input, { idempotencyKey })
fad.tagDefinitions.get(namespace, key)
fad.tagDefinitions.list({ namespace?, limit?, cursor? })
fad.agentTags.list(agentId)
fad.agentTags.get(agentId, namespace, key)
fad.agentTags.put(agentId, namespace, key, { value, reason? }, { idempotencyKey, ifMatch?: string, ifNoneMatch?: '*' })
fad.agentTags.delete(agentId, namespace, key, { idempotencyKey, ifMatch, reason? })
fad.agents.search({ tags?, status?, limit?, cursor? })
```

Use generated transport client/OpenAPI typed models where practical, then a thin handwritten ergonomic layer. Expose strong ETags in typed result metadata, not by editing the existing `Agent` type. SDK must preserve `false`, `0`, and empty-but-valid values correctly (empty strings are invalid; false/zero valid). GET retries may use existing safe retry logic. Read-only `POST /v1/agents/search` may retry because route is documented as safe. NEVER automatically retry arbitrary mutating POST/PUT/DELETE without stable idempotency keys. Support cancellation, timeouts, backoff/jitter, structured error codes, tracing headers, and secret redaction. See `../sdk/SDK_CONTRACT.md`.

## 8. Deployment/rollback

Build one new API container image using existing Dockerfile and runtime profile, no second service. Migration runs once as separate deployment job with migrator identity and checksum lock before deployment, not during each API startup. Rolling upgrade:

1. Confirm a verified backup and Slice 0/1 tests; ensure migrations 0001 and 0002-agent exist.
2. Apply **additive** tag schema with independent migrator.
3. Deploy API image with Slice 2 routes gated by `FAD_TAGS_ENABLED=false` initially; health/readiness remains compatible.
4. Run old API smoke tests and SDK contract tests while feature disabled.
5. Turn on tag APIs for one authorized test tenant, execute real end-to-end and negative tests, then incrementally enable by tenant or service setting.
6. Observe error rates, audit consistency, DB locks, request latency and quota enforcement. Old replicas that do not know new tables still function.
7. Roll back code/config by disabling new routes and restoring previous container image **without dropping tables**. Preserve data and history. Any breaking security incident -> immediately suspend access to affected credential scopes.

A separate `down.sql` file is **development-only and destructive**. Never apply automatically in production. Backup, PITR and recovery tests remain Slice 0 obligations.

## 9. Operational requirements

- Use structured security logs with `request_id`, `organization_id` and internal principal ID, but no API key, raw secrets, protected values or governed change reasons. Avoid high-cardinality tag metrics.
- Record successful actual mutations in Slice 0 `audit_events` (action `tag_definition.created`, `agent_tag.assigned`, `agent_tag.updated`, `agent_tag.deleted`). Record denied security attempts according to existing Slice 0 denied-audit strategy without creating cross-tenant leakage. Store reason in protected audit/history only.
- The database and audit must commit atomically; if audit insert fails, no tag mutation commits. No new event bus. Future Slice 7 events will use an outbox.
- Define per-credential and tenant quotas for write volume, body sizes and search cost. Return 429 with `Retry-After`.
- Production SLO proposals: tag get p95 <100ms; indexed search p95 <250ms under documented representative load; 99.9% service availability. Do not claim achievement without measured proof.
- Set readiness to false if required Slice 2 schema is missing while route flag enabled. Keep `/health/live` behavior unchanged. Do not expose schema names or credentials in health responses.

## 10. Edge cases and negative acceptance

Reference `../verification/TEST_MATRIX.md` for exhaustive cases. Critical cases: false/zero values; duplicate enum members; Unicode normalization; reserved namespace underprivileged creation; governed attribute self-downgrade; restricted search inference; across-tenant FK attempts; missing RLS tenant context; stale ETag; delete + recreate ABA; simultaneous different-value writes; 64-tag boundary under concurrency; 256 definitions under concurrency; idempotency replay after further change; key reuse with changed headers; retired-agent mutation; suspend/read behavior; failing audit insert; PostgreSQL downtime; Docker restart; SDK unknown future response fields; Slice 0/1 old-contract regression.

## 11. Evidence and done gate

A slice is not done without executable proof. Save into `docs/releases/slice-2/`: `goal.md`, `plan.md`, `contracts/`, `api-evidence/`, `db-evidence/`, `security-evidence/`, `sdk-evidence/`, `deployment-evidence/`, `test-results/`, `compatibility.md`, `risks.md`, `completion.md` with commit SHA and test commands. Every API example requires raw **redacted** HTTP request/response. DB evidence must include migration checksum and row-scope/RLS tests. SDK proof must run from an independent Node.js consumer. Capture a passing old SDK test against new server. Security proof must include denied governed write and prevented cross-tenant lookup. Exactly one implementation commit with a concise ASD-STE100-style message. No claims of implementation or runtime testing may appear without attached logs.

## 12. Explicit post-slice handoff

Slice 3 consumes tags for local discovery, but must not infer invocation authority. Slices 5–6 add tag-based policy: only trusted governed values should be eligible for high-impact allow decisions. Slice 4 adds MCP adapter reusing the same tag application services and authorization, never parallel unsafe implementation. Slices 11–13 can exchange only explicitly approved tag metadata with provenance; remotely supplied tags never overwrite governed local tags.
