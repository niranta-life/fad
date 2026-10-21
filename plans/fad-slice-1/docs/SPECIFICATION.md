# Federated Agent Directory (FAD) — Slice 1: Agent Registration

**Status:** Implementation-ready proposed contract, not implemented | **Version:** 1.0 | **Date:** 2026-10-20  
**Implementation target:** Node.js/TypeScript, PostgreSQL, OCI containers | **Scope:** backend, REST and TypeScript SDK only

## 1. Objective and boundaries

Register, retrieve, list, update, suspend, reactivate and permanently retire agents inside an authenticated organization. Make this independently valuable as an audited inventory. Do not implement capabilities, tags, tag policies, search across capability, MCP tools, federation, grants or verification of agent runtime identity.

**Hard production requirement:** Slice 0 must already provide credential verification, organization and principal ownership, scopes, secure database transaction/context, idempotency storage, audit infrastructure, structured errors, request IDs, OpenAPI generation/checking, and container orchestration. If actual Slice 0 schemas differ from the assumptions below, stop and reconcile *additively*. Never overwrite its contract or create a parallel identity system.

### Decisions fixed for this slice

- REST paths always begin `/v1`. OpenAPI 3.1.0 contract with semantic artifact version 1.0.0 (`contracts/openapi.yaml`).
- External `id`: application-generated cryptographically random UUIDv4; stored with `organization_id` composite primary key.
- Immutable `global_id`: `urn:fad:agent:<organization_uuid>:<agent_uuid>`; derived, never used as a writable field.
- Every agent has a name, description, owner principal, lifecycle state, monotonically increasing revision, created/updated timestamps and authors.
- Initial status `active` is *registry state only*, NOT attestation, runtime availability, or invocation approval.
- Statuses: `active`, `suspended`, `retired`. Retired is terminal. No DELETE API or physical deletion.
- `owner_principal_id` must resolve to an active principal in the same organization; ownership is metadata, not a permission grant.
- Authenticated credential resolves `organization_id`, `principal_id`, and actions; never trust a client-supplied tenant ID.
- Required `Idempotency-Key` on every `POST`/`PATCH`. Required strong `If-Match` on every mutation to an existing agent.
- `PATCH` uses `application/json` as an explicit partial update (NOT JSON Merge Patch). Only mutable fields accepted.
- Successful no-op writes retain the existing revision and create no new revision/lifecycle record. The request itself can still produce an operational access log.
- `Cache-Control: private, no-store` for all directory responses. TLS is required outside a trusted local development environment.
- Malformed UUIDs return 400; unknown and other-tenant valid UUIDs return indistinguishable 404s.
- Body size limit 16 KiB and fixed per-operation quotas (configurable downward, not unlimited).

## 2. Integration with Slice 0: mandatory preflight

Before writing code, establish from the existing repo:

| Prerequisite | Required contract |
|---|---|
| Organizations | `organizations(id uuid primary key)` or an equivalent explicit mapping |
| Principals | `principals(id uuid, organization_id uuid, status)` with unique `(organization_id,id)` |
| Authentication | `X-FAD-API-Key` in supplied illustrative OpenAPI, **replace with the actual existing Slice 0 credential scheme if different**; preserve published Slice 0 behavior |
| Authorization | Per-credential actions: `agents:read`, `agents:write`, `agents:lifecycle`. Add scopes through existing provisioning and policy infrastructure |
| Request context | `principal_id`, `organization_id`, scopes are created by trusted auth middleware |
| DB roles | Runtime `fad_app` no BYPASSRLS/no DDL/no ownership; separate controlled migrator role |
| RLS context | Transaction-local `fad.org_id` set by trusted server for *every* authenticated query using one transaction connection |
| Audit | Existing immutable audit format and app/service logging; insert audit mutation in same transaction as agent update |
| Idempotency | Existing atomic storage with 24-hour retention; add endpoint fingerprints as required, not a new divergent system |
| Errors | Existing error response convention; use `error.code`, `error.message`, `meta.request_id`, `meta.api_version` without breaking Slice 0 |

The formal OpenAPI file captures the selected Slice 1 shape. If matching an existing Slice 0 interface requires different header or envelope naming, update the new Slice 1 spec **before** implementing; preserve Slice 0 public contracts. Store the reconciliation in the evidence package.

## 3. Authorization

| Operation | Minimum action scope |
|---|---|
| GET agent / GET list | `agents:read` |
| POST register / PATCH metadata | `agents:write` |
| POST suspend / activate / retire | `agents:lifecycle` |

All actions also require authenticated, active organization and principal. Agent owner status is validated on registration and ownership transfer. The caller need not be the agent owner if they possess the relevant scope. Access to revisions/audit is via privileged Slice 0 audit facilities, not a new public endpoint.

**Security order:** authenticate → establish tenant and principal → check scope → validate path/body → resolve resource within tenant → idempotency replay check → locked transactional revision/precondition check → write record/history/audit/idempotency → commit. The implementation must not expose whether an agent ID exists in another organization. Authentication/scope checks happen *before* any replayed result can be returned.

## 4. Field definitions and validation

| Field | Type | Create | Update | Rule |
|---|---|---|---|---|
| `id` | UUID string | server | never | immutable UUIDv4 |
| `global_id` | URN string | server | never | derived from org UUID + agent UUID |
| `organization_id` | UUID | credential | never | cannot appear in create/patch body |
| `name` | string | required | optional | NFC + trim, 1–160 Unicode code points, no control characters |
| `description` | string | optional | optional, null clears | defaults to empty string, 0–2000 code points, no NUL/control chars except tabs and newlines if sanitized by policy |
| `owner_principal_id` | UUID | required | optional | active, same organization |
| `status` | enum | active | transition only | active, suspended, retired |
| `revision` | int64 | 1 | server | increments once per actual change |
| `created_at`/`updated_at` | RFC 3339 UTC | server | server | from database clock, UTC serialization |
| `created_by`/`updated_by` | UUID | server | server | authenticated principal |

Agent names need not be unique. Never change identity based on name or endpoint. Do not accept arbitrary public `metadata` objects in Slice 1; tags and capabilities will get governed schemas later. Reject unknown request fields (`422 VALIDATION_ERROR`). Canonicalize `name` before change detection so normalization-only patches do not create meaningless revisions.

### State machine

| Current | suspend | activate | retire | metadata update |
|---|---|---|---|---|
| active | suspended | active (no-op) | retired | allowed |
| suspended | suspended (no-op) | active | retired | allowed |
| retired | `409` | `409` | retired (no-op) | `409` |

Lifecycle requests require `{ "reason": "..." }`, trimmed length 1–500. Persist reasons in protected lifecycle/audit history, not the public agent representation. No-op transition still requires valid `If-Match`; stale `If-Match` always returns 412 (unless it is a replay of a previously committed identical request with the same idempotency key).

## 5. Exact HTTP contract

Source of truth: [`../contracts/openapi.yaml`](../contracts/openapi.yaml). All operations require the Slice 0 organization-scoped machine credential; `X-FAD-API-Key` is the assumed header only if Slice 0 has not frozen something else.

| Method | Route | Scope | Success | Required headers |
|---|---|---|---|---|
| POST | `/v1/agents` | `agents:write` | 201 | `Idempotency-Key` |
| GET | `/v1/agents` | `agents:read` | 200 | — |
| GET | `/v1/agents/{agentId}` | `agents:read` | 200 | — |
| PATCH | `/v1/agents/{agentId}` | `agents:write` | 200 | `Idempotency-Key`, `If-Match` |
| POST | `/v1/agents/{agentId}/suspend` | `agents:lifecycle` | 200 | same |
| POST | `/v1/agents/{agentId}/activate` | `agents:lifecycle` | 200 | same |
| POST | `/v1/agents/{agentId}/retire` | `agents:lifecycle` | 200 | same |

### 5.1 Register

```http
POST /v1/agents HTTP/1.1
X-FAD-API-Key: <REDACTED>
Idempotency-Key: agent-register-2026-001
Content-Type: application/json

{"name":"Accounts Payable Agent","description":"Manages supplier invoice workflow","owner_principal_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}
```

**Illustrative server-generated identifiers and times:**

```http
HTTP/1.1 201 Created
Location: /v1/agents/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb
ETag: "agent-v1"
Cache-Control: private, no-store
Content-Type: application/json
X-Request-Id: req-001
```

```json
{
  "data": {
    "id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "global_id": "urn:fad:agent:cccccccc-cccc-4ccc-8ccc-cccccccccccc:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "organization_id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "name": "Accounts Payable Agent",
    "description": "Manages supplier invoice workflow",
    "owner_principal_id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "status": "active", "revision": 1,
    "created_at": "2026-10-20T20:00:00.000Z",
    "updated_at": "2026-10-20T20:00:00.000Z",
    "created_by": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "updated_by": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  },
  "meta": {"request_id":"req-001","api_version":"v1"}
}
```

An identical replay within the 24-hour retention window returns 201 with the same agent ID, revision, and business data, and a fresh per-attempt request ID. A different request with the same key returns `409 IDEMPOTENCY_CONFLICT`. Duplicates caused by concurrent retries must not create a second agent or a second revision/audit mutation.

### 5.2 Get one

```http
GET /v1/agents/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb
```

Returns 200 with the same `AgentResponse` envelope and the current strong ETag. Retired agents remain retrievable to authorized callers. Never disclose a cross-tenant existence difference.

### 5.3 List and paginate

```http
GET /v1/agents?status=active&limit=25
```

```json
{
  "data": [],
  "meta": {"request_id":"req-002","api_version":"v1","limit":25,"next_cursor":null}
}
```

The comment is explanatory; actual API JSON never includes comments. `status` is optional; omission lists all states. `limit` defaults to 25 and maxes at 100. Ordering: `created_at DESC, id DESC`. Cursors use signed opaque server payloads including organization, filter, last `(created_at,id)`, version, and expiry (24 hours), protected by persisted rotating signing keys. A filter or tenant change with the same cursor returns 400, not a data leak. A new agent created during pagination may be absent from that pagination run; this is acceptable and documented. Each page is consistent at query time; this is not a repeatable snapshot across pages.

### 5.4 Partial update

```http
PATCH /v1/agents/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb
Idempotency-Key: update-description-001
If-Match: "agent-v1"
Content-Type: application/json

{"description":"Matches supplier invoices against POs"}
```

Returns `200`, full updated representation, and `ETag: "agent-v2"`. Change `description` to `null` to clear it; omitted fields remain unchanged. An empty patch, `status`, unknown keys, unsupported body content, or invalid owner principal is rejected. A true no-op returns 200 with unchanged revision and ETag.

### 5.5 Lifecycle

```http
POST /v1/agents/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/suspend
Idempotency-Key: suspend-001
If-Match: "agent-v2"
Content-Type: application/json

{"reason":"Security review required"}
```

Returns 200, agent with `status: "suspended"`, `revision: 3`, strong `ETag: "agent-v3"`. `/activate` and `/retire` follow the same input/output shape. Only authorized services can perform transitions.

### 5.6 Standard errors

```json
{
  "error": {
    "code": "PRECONDITION_FAILED",
    "message": "The agent has changed. Fetch its current representation and retry."
  },
  "meta": {"request_id":"req-003","api_version":"v1"}
}
```

| HTTP | Stable error code | When |
|---|---|---|
| 400 | `BAD_REQUEST` | Invalid syntax, malformed UUID/cursor, missing or malformed idempotency key |
| 401 | `UNAUTHENTICATED` | Missing, expired or disabled credential |
| 403 | `FORBIDDEN` | Caller lacks required scope |
| 404 | `AGENT_NOT_FOUND` | Missing ID or agent in different tenant |
| 409 | `INVALID_STATE_TRANSITION` | Retired agent modified/reactivated |
| 409 | `IDEMPOTENCY_CONFLICT` | Same key with distinct normalized request fingerprint |
| 412 | `PRECONDITION_FAILED` | Stale/wrong strong ETag |
| 413 | `PAYLOAD_TOO_LARGE` | Body > 16 KiB |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Mutation body not application/json |
| 422 | `VALIDATION_ERROR` | Unknown field, invalid type, invalid owner, invalid name/reason |
| 428 | `PRECONDITION_REQUIRED` | Missing If-Match on existing-resource mutation |
| 429 | `RATE_LIMITED` | Tenant/principal quota exceeded; Retry-After header |
| 503 | `DEPENDENCY_UNAVAILABLE` | Cannot safely reach required DB/audit/idempotency dependency |

Never return raw SQL diagnostics, cross-tenant row counts, key material, secrets, or stack traces. Error details may contain safe field names and issue codes, but not sensitive stored values.

## 6. Idempotency and concurrency

Every mutation has a key of 8–128 ASCII characters from `[A-Za-z0-9._:-]`. The business request identity includes authenticated org, principal, method, canonical path, normalized body, and precondition. Verify current credential and scopes before consulting replay storage.

Persist key, fingerprint, terminal status, business response, and expiry atomically in Slice 0 idempotency infrastructure. For concurrent same-key requests, only one transaction creates or changes the resource; other attempts wait/receive the stored result or a safely retryable conflict. Never mark a request committed if agent write, history or audit failed. If the DB commit is uncertain, retrying with the same key must recover the committed result.

For existing agents, row-lock or use conditional `UPDATE ... WHERE revision = expected_revision` inside a transaction. Evaluate `If-Match` against the latest locked row. All actual changes increment revision once, record immutable snapshot, and insert audit in the same transaction. No-op transitions and identical metadata writes do not create new revisions. `If-Match: *` and weak ETags are rejected in Slice 1 rather than being accepted as overwrite permissions.

**Replays precede current revision check** only after credential/scope validation; otherwise a legitimate retry of a committed PATCH would incorrectly fail its old ETag. A request with a different idempotency key must satisfy the current ETag, even if its desired values match.

## 7. Database migrations

`migrations/20261020_001_agents.up.sql` is the proposed forward migration. `down.sql` refuses to drop tables containing data. Apply through the existing migrations framework after validating Slice 0 prerequisite names, role, constraints, and ownership.

**Tables:**

- `agents`: authoritative current state; composite `(organization_id,id)` primary key.
- `agent_revisions`: immutable revision snapshots, one per actual change, including creation.
- `agent_lifecycle_events`: auditable status changes and reasons, with FK to revision.

**Indexes:** `(organization_id,created_at DESC,id DESC)` and `(organization_id,status,created_at DESC,id DESC)` for pagination, plus owner lookup. Keep indexes limited until query plans establish need.

**RLS:** RLS enabled and forced on all three tables; runtime SQL role has no BYPASSRLS; policies only match transaction-local `fad.org_id`. Every application query also includes explicit tenant predicates. Never set tenant context in a persistent, pool-wide session setting. Migration and application roles must be distinct. Test malicious direct-SQL attempts through a restricted app-role connection.

**Audit:** New agent mutations must write existing Slice 0 audit events (actor, org, target, action, previous/current revision, result, timestamp, request ID) in the same transaction as the domain mutation. No secrets or private credentials in agent rows or revision snapshots. Do not introduce outbox/event delivery yet; that is Slice 7.

**Concurrency:** Use DB constraints for owner/creator/updater same-tenant references, but still verify owner is *active* at transaction time because FKs cannot enforce principal lifecycle status. Lock owner row or design equivalent serialization against principal disablement. If the existing principal schema has additional lifecycle semantics, conform to them.

**Rollback:** Prefer rolling the application binary back while preserving additive schema. Never execute destructive `down.sql` on nonempty production tables. Test restored backups, and document RPO/RTO inherited from Slice 0.

## 8. Service design

```text
HTTP adapter (existing Node.js framework)
  -> Slice 0 authentication / tenant context
  -> required-scope authorization
  -> OpenAPI request validator
  -> AgentApplicationService
       -> AgentRepository (tenant-scoped, transactional)
       -> PrincipalRepository (owner validation)
       -> IdempotencyRepository (Slice 0)
       -> AuditRepository (Slice 0)
  -> response serializer + trace headers
```

Use the existing framework and repository patterns. Do not swap frameworks or refactor unrelated modules. Keep `AgentApplicationService` independent of HTTP and future MCP transport so the MCP adapter can reuse it in Slice 4. Introduce service interfaces for future capabilities/tags only when a current code path requires them; do not create unused abstraction layers.

Transaction outline:

1. Authenticate caller and authorize action.
2. Validate request body/headers and normalize immutable request fingerprint.
3. Begin transaction, set tenant-local RLS context.
4. Atomically claim/replay idempotency key.
5. Validate same-tenant owner, and lock current agent row if relevant.
6. Verify strong ETag and allowed lifecycle transition.
7. Apply change; increment revision if and only if domain state actually differs.
8. Insert immutable revision snapshot, lifecycle event if status changes, and audit event.
9. Commit business write and stored idempotent response together.
10. Return result with strong ETag, Location when created, Cache-Control and request ID.

All external calls must stay outside the DB transaction. Avoid unnecessary long-running locks. Do not start asynchronous jobs for a synchronous register/update operation.

## 9. Node.js SDK

Suggested package: `@fad/sdk` (reserve name internally until package ownership is established). The SDK should accept a credential provider rather than require raw API keys as options, but may offer a simple convenience `apiKey` for server-side local use.

```typescript
import { FadClient } from '@fad/sdk';

const client = new FadClient({
  baseUrl: process.env.FAD_URL!,
  credentialProvider: async () => process.env.FAD_API_KEY!,
  timeoutMs: 10_000
});

const { agent, etag } = await client.agents.register({
  name: 'AP Agent',
  ownerPrincipalId: process.env.FAD_OWNER_PRINCIPAL_ID!
}, { idempotencyKey: crypto.randomUUID() });

const updated = await client.agents.update(agent.id,
  { description: 'Invoice matching and validation' },
  { ifMatch: etag, idempotencyKey: crypto.randomUUID() });

const page = await client.agents.list({ status: 'active', limit: 25 });
const retired = await client.agents.retire(agent.id,
  { reason: 'Replaced by a newer implementation' },
  { ifMatch: updated.etag, idempotencyKey: crypto.randomUUID() });
```

**Methods:** `agents.register`, `get`, `list`, `update`, `suspend`, `activate`, `retire`, and `iterate` (cursor iterator). The SDK returns a typed object plus ETag where applicable. The SDK MUST preserve an exact supplied idempotency key across retries and must not invent a new key per retry. SDK generation should derive transport types from `openapi.yaml`, with a thin handwritten ergonomic wrapper.

**Client behavior:** AbortSignal support, configurable timeout, standard errors (HTTP status/code/request ID), safe retries for GET; retry mutating operations only with the same idempotency key and unchanged precondition; exponential backoff/jitter for 429/503 and connection failures, honoring Retry-After; configurable maximum attempts; no retries for 400/401/403/404/409/412/422/428. Reject cross-host redirects and never send credentials to an untrusted URL. Use HTTPS outside local dev. Do not log API keys or full request bodies by default.

**Publishing:** Publish a typed package, declaration files, source map policy, ESM/CJS strategy matching repository conventions, Node LTS engines requirement, package-level integration tests, README with running examples, and SemVer release notes. Future SDKs (Python, Java, Kotlin, Go) will use the same OpenAPI contract and conformance scenarios without changing Slice 1 wire semantics.

## 10. Docker and deployment

Use the existing Slice 0 OCI image and PostgreSQL. Add only migration and module code. Build reproducibly with locked dependencies, multi-stage build, non-root runtime user, pinned supported Node.js LTS base by immutable image digest in CI, filesystem read-only where possible, minimal Linux capabilities, no compiler or development dependencies in runtime image.

**Reference development Compose topology (adapt existing Compose; not a standalone working service until application code exists):**

```yaml
services:
  postgres:
    image: postgres:17
    environment:
      POSTGRES_DB: fad
      POSTGRES_USER: fad_owner
      POSTGRES_PASSWORD_FILE: /run/secrets/postgres_password
    secrets: [postgres_password]
    volumes: [fad_pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U fad_owner -d fad"]
      interval: 10s
      timeout: 5s
      retries: 10
    networks: [internal]
  api:
    build: ./apps/api
    environment:
      NODE_ENV: production
      PORT: "8080"
      DATABASE_URL_FILE: /run/secrets/database_url
    secrets: [database_url]
    depends_on:
      postgres: {condition: service_healthy}
    ports: ["127.0.0.1:8080:8080"]
    networks: [internal]
    read_only: true
    tmpfs: [/tmp]
    security_opt: ["no-new-privileges:true"]
volumes:
  fad_pgdata: {}
networks:
  internal: {}
secrets:
  postgres_password:
    file: ./secrets/postgres_password
  database_url:
    file: ./secrets/database_url
```

**Important:** This is local-dev infrastructure guidance, not a complete production security profile. The app image build path, supported `DATABASE_URL_FILE` reading, service user, and health endpoints must be implemented or matched to existing Slice 0. Do not commit secret files. For production, use managed Postgres/secret manager, TLS ingress, image scanning/signing, backups/PITR, Kubernetes probes, resource requests/limits, NetworkPolicy, deployment disruption budgets and separate migration Job. App instances must never all race to run schema migration.

**Deployment sequence:** backup/PITR verified → contract compatibility CI → apply additive migration with a single controlled migrator → roll out app replicas → health/readiness, functional and isolation smoke tests → observe errors/latency → continue or roll back app image (schema retained). If schema/app cannot interoperate, halt roll out. Test old Slice 0 binary against new schema beforehand.

**Production readiness conditions:** Database unavailable => readiness fails, liveness stays independent; all mutations fail closed if audit/idempotency storage cannot commit. Graceful shutdown finishes or rolls back in-flight transactions. Reconnect handling prevents duplicate writes. Structured log filters redact credentials, header values and sensitive reasons.

## 11. Tests and edge cases

### Unit tests

- Valid/invalid normalization and lengths: blank, whitespace-only, Unicode NFC, emojis/multibyte, control chars, oversized UTF-8, null description.
- Unknown JSON fields rejected; negative limit, invalid status, malformed UUID, invalid cursor.
- State matrix: allowed transitions, no-ops, retired terminal, metadata edits to suspended allowed.
- ETag parser: weak tags, wildcard, malformed quote, stale version, absent header.
- Idempotency fingerprints for same/different body/path/principal/org/precondition.
- Response serializer and SDK type parsing including unknown future response properties.

### Integration/security tests

| ID | Scenario | Required proof |
|---|---|---|
| SEC-01 | A key reads B's agent by UUID | 404 identical to nonexistent, no side channel |
| SEC-02 | A key tries to create with B's owner | 422, no FK side-channel or B identity disclosure |
| SEC-03 | Credential missing, invalid, suspended | 401, no mutation |
| SEC-04 | Read-only principal attempts POST/PATCH/lifecycle | 403, no mutation |
| SEC-05 | Direct DB read as app role without tenant context | No rows |
| SEC-06 | Direct DB read as app role with context A | Only A rows |
| SEC-07 | RLS context not retained between pooled transactions | Cross-tenant rows never leak |
| SEC-08 | Crafted `organization_id`, `status`, `created_by` in body | 422 |
| SEC-09 | SQL injection, Unicode controls, huge payload | Validated/parameterized, bounded, no leaking stack traces |
| SEC-10 | Credential disabled just before idempotent replay | 401 (never return cached secret/response) |
| CON-01 | Two concurrent PATCH requests with same ETag, different keys | Exactly one succeeds, other 412 |
| CON-02 | 100 parallel register requests, same idempotency key/payload | Exactly one agent/revision/audit event |
| CON-03 | Same key with different payload | 409, no second agent |
| CON-04 | Replay successful PATCH with old ETag and same key | Same result, no second change |
| CON-05 | Request dies after transaction commits but before HTTP response | Retry recovers same result |
| CON-06 | DB errors during history or audit write | Entire domain mutation rolls back |
| CON-07 | Invalid owner reassignment | 422, revision unchanged |
| API-01 | List ordering and multi-page cursor | No skipped/duplicated preexisting rows |
| API-02 | Tampered, expired, cross-tenant or changed-filter cursor | 400 |
| API-03 | No-op metadata update or repeated status transition | Revision unchanged |
| API-04 | Retired record fetched/listed | 200 with retired state |
| API-05 | Retired agent reactivated or metadata patched | 409 |
| API-06 | Missing If-Match vs wrong If-Match | 428 vs 412 |
| SDK-01 | SDK ETag extraction and passthrough | Correct headers and typed return |
| SDK-02 | SDK retried mutation uses same idempotency key | One domain effect |
| DEP-01 | Restart API and Postgres container | Committed state persists |
| DEP-02 | Run two API replicas against one DB | Correct concurrent behavior |
| DEP-03 | Old Slice 0 smoke suite after migration/release | All pass |
| DEP-04 | Restore DB from backup in isolation | Stored agents and history recover |
| PERF-01 | Tenant-scoped get/list under agreed dataset | p95 targets supported by measured query plans |

**Test both API and repository isolation.** A test suite that only exercises a mocked repository cannot prove multi-tenant security.

### Baseline performance test profile (proposed, not verified)

- 100 organizations; 10,000 agents in a representative large tenant, 100 in each of 99 other tenants.
- Steady 100 GET/s and 20 list/s, mixed with 10 writes/s. Increase until saturation to identify safe deployment envelope.
- Proposed goals: p95 agent GET <100 ms and indexed list <250 ms at baseline; zero inconsistent writes or cross-tenant responses. Report environment, DB size, query plans, CPU/memory, p95/p99, connection pool utilization.
- This is not a mandatory benchmark of future federation; use as a baseline with real measurements and an explicit pass/fail threshold before release.

## 12. End-to-end user journey

1. Start from a deployed Slice 0 environment with two provisioned organizations (A, B), distinct credentials, and an active owner principal in A.
2. A registers "Accounts Payable Agent". API returns 201, Location, immutable ID, global ID, revision 1 and ETag.
3. A resends the exact request with the same Idempotency-Key. The same agent ID is returned; DB has one row and one creation revision.
4. A gets its agent and lists agents with `status=active`, including pagination.
5. B attempts to retrieve A's agent ID. API returns 404 indistinguishable from a nonexistent agent.
6. A updates description using the ETag; revision becomes 2.
7. A repeats an update with a stale ETag and a new idempotency key; API returns 412.
8. A suspends using a reason; agent is visible as suspended, but not active.
9. A reactivates the agent; revision increments.
10. A retires the agent; subsequent activate or PATCH returns 409; GET still works.
11. Restart service replicas; records, revisions and audit survive.
12. Repeat through Node.js SDK. Verify old Slice 0 smoke tests still pass.

Executable starter: `verification/acceptance-smoke.sh`. It requires a running service, `jq`, `node`, `curl`, and `FAD_URL`, `FAD_KEY_A`, `FAD_KEY_B`, `FAD_OWNER_A`. It is **not executable against an unimplemented service**.

## 13. Evidence and one-commit release discipline

After implementation, generate real proof into the repository:

```text
docs/releases/slice-1/
  goal.md
  plan.md
  contract-openapi.yaml
  compatibility-report.md
  migration-and-rollback.md
  api-evidence/            # redacted curl requests/responses, status, headers
  db-evidence/             # schema and RLS assertion results
  tests/                   # named test reports, coverage, concurrency
  sdk/                     # compiled package, example output, SDK tests
  security/                # tenant boundaries, forbidden operations, tampering
  deployment/              # container build, health, roll-forward/back checks
  performance/             # methodology and measured p95/p99, if run
  limitations.md
  completion.md            # commit hash, CI job IDs, checked acceptance matrix
```

Never fabricate evidence. Mask credentials and other secrets before storing proof. Store test commands, exit codes, environment/version summaries, and actual results. A test that was not run must be marked NOT RUN, not PASS. There should be exactly one focused implementation commit for the slice, preceded by a clean working tree and followed by verification that its recorded hash matches the completion report. Use a short ASD-STE100-style commit message, e.g. `Add secure agent registration APIs and Node.js SDK`.

**Definition of done:** deployed container works; OpenAPI lint/codegen passes; all Slice 0 regression tests pass; migration forward succeeds; RLS and cross-tenant tests pass; lifecycle, idempotency, concurrency and SDK tests pass; redacted evidence saved; measured limitations documented; no future-slice behavior accidentally added.

## 14. Compatibility and future extensibility

- Do not change Slice 0 routes, scope meanings, authentication, error semantics, or idempotency behavior without explicit additive migration.
- Publish the baseline OpenAPI in source control and run contract-diff CI for every subsequent change; run a small set of old SDK binaries against the new server.
- Preserve `id`, `global_id`, `owner_principal_id`, status values, revision semantics and lifecycle terminal behavior through all future slices.
- Tags and capabilities will use separate versioned tables/endpoints and may be exposed later as *additive optional fields* in agent responses, if compatibility tests allow. Do not introduce them as required request fields.
- Agent runtime identity (Slice 8) must remain independent of the logical directory agent ID.
- Discovery (Slice 3), tag policy (Slice 5), delegation (Slice 9) and federation (Slice 11+) can read Slice 1 data but may not reinterpret status `active` as authorization to execute.
- MCP (Slice 4) will reuse `AgentApplicationService` with identical security checks; do not implement its transport in Slice 1.
- Subsequent Python, Java, Kotlin and Go SDKs follow this OpenAPI contract; their existence must not require a server wire-format change.

## 15. Explicit design reviews before coding

1. Does the *actual* Slice 0 authentication header differ from `X-FAD-API-Key`? If yes, update new contract to match the existing scheme.
2. Does Slice 0 already have UUID principal IDs and a unique composite `(organization_id,id)` key? If not, perform a reviewed additive prerequisite migration separately, not an ad hoc mutation.
3. Does Slice 0 have a transaction-safe idempotency store retaining successful responses for 24 hours? Confirm behavior after an uncertain commit.
4. Can Slice 0 audit insertions participate in the same PostgreSQL transaction? If not, resolve durability before implementing mutation APIs.
5. Are the selected scope strings already in the authz vocabulary? Add scopes additively with least privilege.
6. Are Node SDK module packaging and CI contract-diff rules consistent with existing repo conventions?

**Principle:** Do not push unresolved Slice 0 assumptions into production simply because this document defines a reasonable default. Freeze the new Slice 1 contract only after reconciling prerequisites, and never silently break existing public interfaces.

## Primary references

- OpenAPI 3.1: https://spec.openapis.org/oas/v3.1.2.html
- HTTP conditional requests/strong ETags: https://www.rfc-editor.org/rfc/rfc9110.html
- HTTP 428: https://www.rfc-editor.org/rfc/rfc6585.html
- PostgreSQL Row-Level Security: https://www.postgresql.org/docs/17/ddl-rowsecurity.html
