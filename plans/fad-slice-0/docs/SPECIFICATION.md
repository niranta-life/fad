# FAD Slice 0 — Production Foundation — Detailed Implementation Specification

**Document status:** proposed implementation baseline; freeze after reconciling with the target repository. **Scope:** backend + TypeScript SDK bootstrap only. **Date:** 2026-10-20.

## 1. Goal and user value

A trusted internal service can use a single provisioned API key to contact an always-running FAD service and safely identify its organization. Two organizations can be provisioned independently. Compromising or misconfiguring an ordinary application request must never allow choosing another tenant. Operators can issue, rotate and revoke credentials through an offline privileged administration CLI. Logs, audit, health probes and deployment controls make the service operable in production. Slice 1 adds agents without replacing any of these foundations.

**Not in scope:** agent registration, tags, capabilities, MCP, SSO/OAuth, federation, general-purpose tenant administration HTTP endpoints, GUI, message broker, webhook, policy DSL, agent invocation. No public user creation or authentication API. Do not invent stand-in/mock agent CRUD responses.

### User journey / happy path

1. Operator deploys PostgreSQL and the stateless FAD HTTP container, then runs migrations under the migrator identity.
2. Operator runs the local, privileged `fad-admin organization create --name "Org A"`, receives org UUID; repeats for Org B.
3. Operator provisions a service principal in each org and separate credentials with scope `organizations:read`; copies each full secret **once** into an approved secret store. Principal and credential records do not allow cross-org references.
4. Service A initializes `@fad/sdk` from `FAD_BASE_URL` and `FAD_API_KEY`, calls `organizations.current()`; response says Org A.
5. Service B does likewise and sees Org B. Neither credential is allowed to select Org A/B by supplying a tenant header, query parameter or JSON body.
6. Operator rotates A's credential: issue the replacement, update consumer configuration and verify, revoke old credential. Reuse of the revoked key produces 401.
7. Restart both application replicas; persisted organizations, principals, credential status, and audit entries survive. Simulate database outage: readiness is 503 and authenticated business request does not claim success.

### Success criteria

- `GET /health/live` returns 200 when process is responsive; readiness reflects DB + schema-migration readiness, not downstream optional systems.
- `GET /health/ready` returns 200 only when safe to serve authenticated traffic, otherwise 503; neither endpoint exposes secrets or privileged internal diagnostics.
- `GET /v1/organizations/current` returns tenant bound to the credential and requires `organizations:read`.
- Invalid, revoked, expired, malformed, or unknown keys receive equivalent `401` bodies and timing-mitigated verification; insufficient scope receives `403` only after successful authentication.
- A valid credential from Org A cannot retrieve Org B's current organization, even when sending `X-Organization-Id: <Org B>` (header ignored or rejected; never trusted).
- Database is transactionally durable, tenant-scoped under RLS and explicit application filters. A runtime DB user has no DDL or global table access and cannot directly select credential verifiers.
- Replica-safe operations; no in-process authoritative state; transaction-safe request context; no leaked tenant context on pooled connections.
- Contract, tests, migration, Docker deployment, operator runbooks, and evidence all pass the release gate.

## 2. Frozen public API contract

- API base major version: `/v1`; published OpenAPI file in `contracts/openapi.yaml` is the single source of truth.
- Authentication: exactly one `X-FAD-API-Key` header on protected endpoints; never take the key from URI, query string, cookie, or payload. This intentionally matches the prior Slice 1 specification.
- Successful response: `Content-Type: application/json`, `Cache-Control: private, no-store`, `X-Request-Id: <server-generated UUID>`, envelope `{ "data": ..., "meta": {"request_id": "...", "api_version": "v1"}}`.
- Errors: `Content-Type: application/json`, `Cache-Control: private, no-store`, same request ID, envelope `{ "error": { "code": <stable SCREAMING_SNAKE_CASE>, "message": <safe text> }, "meta": { "request_id": ..., "api_version": "v1" } }`. Optional `error.details` is **not** required for Slice 0.
- Health endpoints omit authenticated envelopes by design, and return `{ "status": "ok" }` on liveness, `{ "status": "ready" }` or `{ "status": "not_ready" }` on readiness; must include `Cache-Control: no-store`.
- `GET /v1/organizations/current` has no path/query parameters, request body, organization selector, or pagination. Unknown query arguments return 400 `VALIDATION_ERROR` (rather than accidentally introducing tenant selection behavior).
- Return 401 `UNAUTHORIZED` for credential failures; 403 `FORBIDDEN` for insufficient scope; 429 `RATE_LIMITED` (with `Retry-After`) for quota; 503 `DEPENDENCY_UNAVAILABLE` if required DB dependency is unreachable; 500 `INTERNAL_ERROR` for unexpected failures. Never reveal which part of credential lookup failed.
- No body on GET; path casing, content negotiation and error shapes are stable in `/v1`. Allow future additive response properties without breaking old clients.
- A validated key with an inactive organization or principal is denied as an authentication failure (401) rather than disclosing its state. All authenticated requests are authorized again after credential verification.

### 2.1 Exact successful HTTP exchange

```http
GET /v1/organizations/current HTTP/1.1
Host: fad.example.internal
X-FAD-API-Key: <REDACTED>
Accept: application/json

HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: private, no-store
X-Request-Id: 3b0fb35b-3c4c-489a-90fa-17232c7b8fda

{"data":{"id":"b4fbb090-335b-4c59-bc0e-5b382ee986b5","name":"Example Finance","status":"active","created_at":"2026-10-20T12:00:00.000Z"},"meta":{"request_id":"3b0fb35b-3c4c-489a-90fa-17232c7b8fda","api_version":"v1"}}
```

### 2.2 Error examples

```http
HTTP/1.1 401 Unauthorized
Content-Type: application/json
Cache-Control: private, no-store
X-Request-Id: 3b0fb35b-3c4c-489a-90fa-17232c7b8fda

{"error":{"code":"UNAUTHORIZED","message":"Invalid or missing API credential."},"meta":{"request_id":"3b0fb35b-3c4c-489a-90fa-17232c7b8fda","api_version":"v1"}}
```

```http
HTTP/1.1 403 Forbidden
Content-Type: application/json
Cache-Control: private, no-store
X-Request-Id: 4e579e86-2963-4ba4-98c3-33f5d48cfb4b

{"error":{"code":"FORBIDDEN","message":"Insufficient permission."},"meta":{"request_id":"4e579e86-2963-4ba4-98c3-33f5d48cfb4b","api_version":"v1"}}
```

A key must not be reflected in any response, error object, tracing tag, log line, or metrics label. Disable HTTP intermediary caching.

## 3. Multi-tenant security and identity

### 3.1 Service credential

Use opaque key format `fad_live.<kid>.<secret>`: `<kid>` exactly 32 lowercase hexadecimal characters, randomly generated; `<secret>` exactly 43 base64url characters encoding 32 cryptographically random bytes without padding. Reject unexpected patterns and oversized header values early; max header value length 256. `kid` is a lookup identifier, **not** an authorization identity.

At issuance, generate a fresh key and compute `HMAC-SHA256(server_pepper, UTF8("fad-api-key:v1:" + kid + ":" + secret))`. Store `kid`, digest, principal and organization IDs, scopes, status, timestamps, optional expiration; **never persist or log the raw key**. Pepper comes from a secret manager; reject startup when absent or too weak. Support planned pepper rotation with `pepper_version` and overlapping verification through a controlled operator procedure; never silently revoke all organizations because one pepper changes.

Implementation order:
1. Parse key and normalize no part of the secret; syntax mismatch => 401.
2. Perform the single restricted credential lookup by kid through `lookup_api_credential` SECURITY DEFINER function (see migration).
3. Compute digest in the Node application, compare using a constant-time primitive; use dummy digest comparison if kid unknown and rate-limit authentication attempts.
4. Reject expired, revoked, disabled keys; credential status + scope come from the authoritative DB. **No cross-replica credential-status caching in Slice 0**.
5. Open a transaction on one DB connection; `SET LOCAL` tenant + principal context; read active org and principal, ensure principal's organization equals credential's; authorize operation scope; run query in same transaction; commit/rollback; release connection.
6. Never select tenants based on user-provided headers. No wildcard matching of permission strings; unknown scopes do not grant anything.

If DB unavailable, fail with 503 (not a misleading 401). All external HTTP access requires TLS 1.2+ at ingress, with enforced TLS between components according to deployment policy. Only development loopback may use cleartext.

### 3.2 Scopes and principals

Principal types: `service` (only type provisioned in Slice 0); later `user`, `agent`, or others can be added through compatible migrations. All principals have status `active|disabled` and immutable organization membership. Credentials have scope arrays with exact string matching. Initial supported scope registry:

- `organizations:read` — used in Slice 0.
- `agents:read`, `agents:write`, `agents:lifecycle` — recognized for future Slice 1, but do not expose agent endpoints now.

The provisioning CLI validates scopes against the allowlist and explicitly restricts who can issue credentials. A principal's ownership of an agent does not automatically grant scopes. Use no blanket `*` scope in production.

### 3.3 Database roles, RLS and connection safety

Roles:
- `fad_migrator`: controlled DDL/migration owner, never used by the API.
- `fad_app`: LOGIN runtime role, no `BYPASSRLS`, no CREATE/DDL, not table owner.
- `fad_auth_reader`: NOLOGIN role with narrowly required `BYPASSRLS` and SELECT on credential table; may only be assumed by hardened SECURITY DEFINER lookup function. Never grant membership to `fad_app`.
- `fad_bootstrap`: privileged offline operator role, not available to application pods; database authority must be narrowly provisioned and access audited. Avoid embedding bootstrap credentials in the API container.

Tenant-owned tables use composite organization keys and RLS; policies read `nullif(current_setting('fad.org_id',true),'')::uuid`. Runtime app sets `fad.org_id` with transaction-local `set_config('fad.org_id', orgId, true)` while using the **same acquired connection**, and does not use `SET SESSION`. If tenant context is missing or invalid, access must fail closed. Application SQL *also* includes `organization_id = authenticated_organization_id`.

Special case: credential lookup occurs before a tenant is known, so the table is *not* broadly readable by `fad_app`; a tightly scoped security-definer function bridges this unavoidable pre-tenant lookup. Its function owner is NOLOGIN, its execution is restricted, and it returns only a verifier and bound metadata, never a raw credential. Carefully test search_path and function ownership. Avoid running the app as a PostgreSQL superuser or table owner.

**Note:** Custom `SET LOCAL` variables are not a substitute for authentication. They are set by trusted application code. SQL injection can undermine both SQL filtering and session settings; parameterization, no raw user SQL, least-privilege roles and integration tests remain mandatory.

### 3.4 Operational security

- No credentials in process arguments, URL parameters, exception text, source code, container images, build logs or startup banners.
- Issue keys once on stdout/secure output of the offline CLI; warn on terminal capture; support writing to a locked file or secret store. Do not write issued secrets to audit payloads.
- Credential rotate: issue successor, activate deployment, verify, revoke predecessor. Preserve key ID and digest history as audit evidence; prevent reuse of revoked kid.
- Rate-limit per visible source / key ID without unbounded memory; secure forward-header handling behind trusted reverse proxy only. Do not rely solely on in-memory per-process counters for production-wide enforcement.
- Server request IDs are fresh UUIDs. Trace context may be accepted from a trusted caller but cannot replace security/audit IDs.
- TLS, dependency pinning, SBOM, build reproducibility, secret scanning and container vulnerability scanning required in CI.

## 4. Database model and SQL

Source of truth: `migrations/0001_foundation.up.sql`. PostgreSQL **16+**; prefer a supported production release as operations dictate. All timestamps `timestamptz` in UTC at serialization. UUIDv4 from secure application generator or `gen_random_uuid()`.

| Table | Primary key | Purpose and critical invariants |
|---|---|---|
| `organizations` | `id uuid` | Stable org ID, unique name not required, active/suspended; no self-service org creation endpoint |
| `principals` | `(organization_id,id)` | Typed actor, same-organization ownership, `active|disabled` |
| `api_credentials` | `(organization_id,id)` + unique `kid` | HMAC verifier, scopes, principal FK, status, expiry, non-reusable kid |
| `audit_events` | `(organization_id,id)` | Immutable events; JSON redacted; actor may be null for trusted system event |
| `idempotency_records` | `(organization_id,principal_id,method,route,key)` | Atomic unique request fingerprint and replay result for future mutations; expiry and state |

All FKs from tenant-owned tables must contain `organization_id`. Never cascade-delete organizations, principals, credentials, or audit records. The public `organizations` table is not modifiable by `fad_app`; credential issuance is offline/privileged. RLS enabled + forced on tenant-owned tables. Explicit grants for `fad_app` are narrower than table ownership. RLS policy can be tested by `SET LOCAL fad.org_id` in an authorized test transaction.

`idempotency_records` is an implementation primitive, not a public endpoint. Requirements:
- Scope key to organization, principal, method, route and key text.
- Include stable SHA-256 request fingerprint (canonical method/path/body; exclude tracing headers and secret); record original status, selected response headers (allowlist), result payload, timestamp and expiry. Never store secrets.
- Use unique constraint plus row lock / INSERT conflict behavior for concurrent same-key requests. A second request with identical fingerprint must receive same business result; different fingerprint => 409 `IDEMPOTENCY_CONFLICT`.
- Store final business mutation + committed response + corresponding audit record **in one database transaction**; rollback must leave no success record. New request IDs are generated for retries. If a request is in progress, bounded wait with retryable conflict; do not double-execute.
- Retention default 24h; cleanup by background maintenance transaction, preserving durable audit separately. `expires_at` governs eligible deletion, not expiration of a business resource.

`audit_events` is append-only to `fad_app`, with event type, actor, target, operation, outcome, correlation/request ID, timestamps and sanitized details. Bootstrap/issuance/revocation events must be auditable. If recording a security mutation's audit entry fails, the mutation must fail atomically.

`0001_foundation.up.sql` is additive on a clean deployment; migrations run under an exclusive advisory lock or a migration framework with locking, record checksums and use one transaction for DDL. Production rollback uses restore/forward-fix rather than dropping foundational tables. See `migrations/ROLLBACK.md`.

### 4.1 Contract for Slice 1

The next slice expects these **exact** relationships:

```sql
organizations(id uuid PRIMARY KEY)
principals(organization_id uuid NOT NULL, id uuid NOT NULL,
           UNIQUE (organization_id,id))
-- Runtime database role: fad_app, never BYPASSRLS.
-- RLS request tenant setting: fad.org_id.
```

It can add `agents`, `agent_revisions`, `agent_lifecycle_events` with a composite FK to principals. Scope strings `agents:read`, `agents:write`, and `agents:lifecycle` are reserved and provisionable. It must reuse Slice 0 credential verification, audit, idempotency, request context and error envelopes; **no new parallel security layer**.

## 5. REST and SDK implementation

- HTTP implementation can use Fastify (recommended) or existing equivalent, but behavior and OpenAPI remain normative.
- Validation on all requests (headers, URLs, unknown parameters, method, payload shape); default request body size cap 16 KiB, reduced where appropriate. Health endpoints return constant-size bodies.
- Authentication happens before scope check. Central middleware creates immutable `{requestId, organizationId, principalId, scopes}` context; do not mutate from request input.
- Limit DB pool size per process; ensure `replicas × maxPool <= safe DB connections`. Budget timeouts for HTTP, auth lookup, SQL and graceful termination.
- Use structured errors; internal cause only in restricted server logs, not HTTP. An unexpected exception is 500 and generates an internal error metric.
- Implement JSON serialization from typed models, no sensitive auth verifier exposure in organization model.

SDK contract: `sdk/SDK_CONTRACT.md`. SDK implementation is a **thin but real** Node.js/TypeScript package; independent of server code, no DB access. It must perform network calls to actual APIs. Provide scoped credential, base URL, request timeouts, caller cancellation, safe optional retry of GET 429/503 on bounded policy, typed result/error, request ID and no logging secrets. Provide `health.live()`, `health.ready()` and `organizations.current()`. Package name recommendation `@fad/sdk`.

## 6. Docker / deployment

See `deploy/docker/Dockerfile` and `deploy/docker/compose.yaml` for reference assets to build from the implemented server. Required implementation conventions: API entrypoint `apps/api/dist/server.js`, port 8080, non-root UID, image build without credentials, only production dependencies in runtime image, multi-stage Node LTS image pinned to an approved digest for release, no auto migrations in API process.

Production configuration (document and validate on startup):

| Env | Requirement |
|---|---|
| `NODE_ENV` | `production` |
| `PORT` | default 8080 |
| `DATABASE_URL` | secret, pooled DB connection string |
| `FAD_API_KEY_PEPPER_V1` | secret, >=32 random bytes, key-versioned |
| `FAD_LOG_LEVEL` | info/warn/error/debug; default info |
| `FAD_DB_POOL_MAX` | positive integer, bounded |
| `FAD_HTTP_REQUEST_TIMEOUT_MS` | bounded positive integer |
| `FAD_SHUTDOWN_GRACE_MS` | >= largest expected in-flight transaction timeout |
| `FAD_RATE_LIMIT_BACKEND` | distributed rate limiter configuration (development can use isolated limiter) |
| `FAD_TRUST_PROXY` | explicit trusted proxy configuration, never trust arbitrary forwarded headers |

Run a dedicated migration/one-off admin job using different permissions, not in every API replica. Compose file is a local/staging reference: **not a substitute for TLS ingress, secrets manager, external Postgres HA, or distributed rate limiting**. Never run privileged admin shell from the production API pod.

### Database failure behavior

- API startup checks secrets and migrator version; fail readiness if schema is absent or incompatible.
- Lose Postgres: readiness immediately or within configured probe interval becomes 503, authorized API calls fail safely with 503. Do not silently select a default tenant.
- During rolling deploy, old and new replicas both work against backward-compatible schema. Use expand/migrate/contract, with no destructive schema changes while old instances run.
- API SIGTERM: stop accepting new work, wait bounded grace for existing connections, close pool, exit. A forced restart must not corrupt committed transactions.
- Rotate credentials and database passwords without rebuilding image.

## 7. Test matrix and deployment gates

See `verification/TEST_MATRIX.md` for test IDs. **Every item below is required to declare a production-ready release**, not merely a passing unit suite.

1. Unit tests: key parser boundaries, HMAC matching, scoped authorization, response schemas, error mapping, redaction, request IDs.
2. Database integration tests (real PostgreSQL 16+): migration, FK integrity, RLS fail-closed, cross-org accesses, role privileges, atomic audit and idempotency storage, clean rollback of failed transaction.
3. API tests: health responses, current org success, missing/invalid/expired/revoked credentials, no organization selector, scope denial, DB failure 503, malformed headers and method handling, oversized headers, rate limit.
4. Security tests: direct SQL from `fad_app` fails to read another organization; cannot select `api_credentials`; only lookup function works; SQL injection attempts; log/trace redaction; unauthorized credential issuance disabled.
5. Multi-replica: load-balanced requests never swap org, pooled connection reuse retains no request context, revoked keys fail on all replicas.
6. Operations: container build, non-root check, startup, readiness, migration, restart durability, secret rotation, backups and restore drill, graceful shutdown.
7. Contract: OpenAPI syntax and spec validation; wire responses validate against schema; additive-only gate for future `/v1` changes.
8. SDK: works against running API, typed exceptions, timeouts, abort, retry only for safe GET, secure key handling.

**Evidence package** required under `docs/releases/slice-0/`: user journey, sanitized curl transcript, test junit/coverage, schema migration output, RLS negative proofs, SDK example result, Docker build/digest/container UID, restart/persistence proof, readiness outage proof, scan results, backup/restore, risk register, API diff, commit hash, operator sign-off.

## 8. Reliability and scale baseline

Goals (proposed, not measured): 99.9% monthly API availability in supported production topology; 100% rejection of known cross-tenant isolation violations; no acknowledged writes lost after DB COMMIT; p95 current organization lookup <=100 ms under agreed volume; RPO <=5m, RTO <=30m with tested backup/restore. Quantify workload, DB hardware, cardinalities and load before accepting latency numbers. Monitoring must alert on 5xx, auth anomaly spikes, DB saturation, RLS-deny anomalies, rate limiting, migration mismatch, restore failures and audit write failure. Business mutations in later slices are transactional and idempotent by design.

## 9. Compatibility and change-control policy

Within `/v1`, do not delete/rename fields, change types, change response envelopes, change path semantics, add required request fields, or tighten accepted inputs without explicit exception review. New response fields are additive; SDKs must tolerate unknown response fields and status values. Errors preserve stable machine-readable codes. Compare new OpenAPI to previous published baseline in CI; changes failing compatibility gate cannot be released. Any breaking feature goes under a new major route `/v2` while `/v1` remains supported under published deprecation policy. Security corrections that must deny insecure access are allowed with documented impact and negative tests.

**Do not use the same API path to expose future federated tenant switching.** Federation will use explicit mutual trust and a separate authorization model.

## 10. Out-of-scope checks / next slice handoff

Slice 1 registers and manages agents via `POST /v1/agents`, etc.; it depends on Slice 0's tables/roles/context and scopes. No LDAP protocol or SCIM mapping yet. No MCP endpoint until Slice 4. No claims of production usability until tested in a real runtime.
