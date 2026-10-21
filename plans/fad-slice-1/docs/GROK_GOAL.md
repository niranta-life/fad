/goal Implement Federated Agent Directory (FAD) Slice 1: production-grade agent registration, lifecycle APIs, and the Node.js SDK.

ROLE
You are implementing exactly one small, independently deployable backend vertical slice in an EXISTING secure multi-tenant FAD service. Follow its existing architecture, code style, framework, testing system, migrations and deployment pipeline. Do not redesign the platform. No frontend. Do not implement tags, capabilities, discovery, policy engine, delegation, MCP, federation or future SDK languages.

SOURCE OF TRUTH
- `{pwd}/fad-slice-1/docs/SPECIFICATION.md` (Slice 1 requirements; in this deliverable under `{pwd}/fad-slice-1/docs/SPECIFICATION.md`)
- `{pwd}/fad-slice-1/contracts/openapi.yaml` (proposed exact wire contract)
- `{pwd}/fad-slice-1/migrations/20261020_001_agents.up.sql`, `{pwd}/fad-slice-1/20261020_001_agents.down.sql`
- `{pwd}/fad-slice-1/verification/acceptance-smoke.sh`
- The existing, published Slice 0 OpenAPI, authentication, RLS, idempotency, audit, and migration contracts MUST take precedence over any assumption in these new files.

GOAL / USER OUTCOME
An authorized organization service can register and manage the lifecycle of AI agent records with stable identifiers, audit history, proper cross-tenant isolation, safe concurrent writes, consistent retry behavior, and a typed Node.js SDK. Another organization cannot view or modify those agents.

FIRST: REPOSITORY AUDIT (DO THIS BEFORE ANY CODE CHANGE)
1. Read architecture/ADR, Slice 0 OpenAPI/schema, auth middleware, principals, audit and idempotency implementations, transaction helpers, deployment manifests, and existing tests.
2. Check that organizations and principals exist, principals are organization-bound, credentials resolve authenticated org/principal/scopes, tenant context is transaction-local, existing idempotency store and immutable audit work, and DB runtime roles cannot bypass RLS.
3. Confirm openapi.yaml assumptions, including credential header, standard envelope, error schema, scope names, and timestamp/revision conventions. Update the *new* Slice 1 proposed contract additively to integrate with Slice 0. Never break Slice 0.
4. Verify repo is clean. Record current commit and a dependency matrix.
5. Write `docs/releases/slice-1/plan.md` with exact files to change, data model, query patterns, acceptance matrix, risk analysis, rollback, and test commands. DO NOT begin editing unrelated components.
6. If essential Slice 0 infrastructure is missing and cannot be integrated without a significant new slice, STOP and report the precise blocker. Do not silently implement Slice 0 in Slice 1.

API CONTRACT — MUST MATCH OPENAPI
- `POST /v1/agents` (201; requires `agents:write`, Idempotency-Key)
- `GET /v1/agents` (200; requires `agents:read`, status optional, limit default 25 max 100, signed opaque cursor)
- `GET /v1/agents/{agentId}` (200; requires `agents:read`)
- `PATCH /v1/agents/{agentId}` (200; requires `agents:write`, Idempotency-Key, strong If-Match)
- `POST /v1/agents/{agentId}/suspend` (200; requires `agents:lifecycle`, Idempotency-Key, If-Match, reason)
- `POST /v1/agents/{agentId}/activate` (same)
- `POST /v1/agents/{agentId}/retire` (same)
- If-Match mismatch: 412. Missing If-Match: 428. Forbidden: 403. Cross-tenant/nonexistent agent: identical 404. Retired invalid transition: 409. Unsupported/unknown fields: validation error. Full error semantics in the spec.
- All single-agent successful responses provide `ETag: "agent-v<revision>"`; create provides Location. Responses carry `data`, `meta.request_id`, `meta.api_version` and `Cache-Control: private, no-store`.
- No DELETE API. Never accept client-chosen organization_id, ID, status, global_id, revision or audit identity.

CANONICAL AGENT DATA
- org-scoped UUIDv4 id; immutable global URN `urn:fad:agent:<org_uuid>:<agent_uuid>`
- name 1–160 normalized Unicode code points
- description <=2000 Unicode code points, default empty; explicit null clears on PATCH
- owner principal UUID; existence, active status and same-tenant checks
- status active/suspended/retired, retired terminal
- revision starts at 1 and increases once per actual change
- created_at/updated_at and created_by/updated_by, server-controlled
- active means directory status only, never verified invocation permission.

DATABASE / SECURITY
1. Add only Slice 1 additive migration: agents, agent_revisions (immutable snapshots), agent_lifecycle_events (transition reasons), correct same-tenant FKs and read/list/owner indexes.
2. Add RLS ENABLE and FORCE policies for runtime DB role and explicit org predicates for every repository query.
3. Never use persistent session tenant config with a connection pool. Use transaction-scoped context on the same connection. Tests must include no-context queries returning no tenant rows.
4. Runtime DB account must not own tables, have BYPASSRLS or schema-migration rights, or have DELETE permissions. Do not grant UPDATE/DELETE on immutable history.
5. For each real mutation, atomically write current state, agent revision/history, Slice 0 audit, and idempotent response. An audit failure must roll back state.
6. Handle concurrent same-key and different-key requests with row locks/conditional updates. Prevent duplicate agents and lost updates. No-op updates do not increment revision.
7. Validate owner principal status during transfer, including concurrency with principal suspension.
8. Never persist API secrets or provider credentials in agent records, audit or revisions.

APPLICATION DESIGN
- Keep HTTP controllers thin. Add agent domain/application module and tenant-scoped repository using existing patterns.
- Preserve transport neutrality for future MCP. Future MCP must call the same services and authorization; do not build MCP now.
- No new microservice, cache, outbox or message broker for this slice.
- Use bounded request size, strict JSON validation, parameterized queries, rate limits, HTTP timeouts and safe error handling.
- Return identical behavior across all stateless API replicas.

TYPESCRIPT SDK
- Add typed package `@fad/sdk` (if the namespace is not available, use an agreed internal package name; do not publish externally without approval).
- APIs: `agents.register`, `get`, `list`, `update`, `suspend`, `activate`, `retire`, `iterate`.
- Typed agent/error/request models generated or aligned from OpenAPI. Expose strong ETag for updates.
- Credential-provider abstraction, request timeout, cancellation/AbortSignal, pagination helper, custom base URL.
- SDK must retain the SAME idempotency key on each retry and the SAME If-Match precondition. Retry safe GET and constrained 429/503/network failures only; bounded exponential backoff/jitter and Retry-After. No retries for 401/403/409/412 etc.
- HTTPS in production, no cross-origin secret forwarding, no credential logging.
- Package build/typecheck, executable SDK integration example, tests and SemVer notes.

END-TO-END JOURNEY — MUST ACTUALLY RUN
1. Start a real Dockerized FAD server and PostgreSQL using existing Slice 0 provisioning.
2. Provision two organizations A/B with separate credentials; create active owner principal in A.
3. Register a named agent in A. Verify 201, Location, stable global_id, ETag v1, revision history and audit.
4. Replay identical POST with same key. Verify 201 and SAME agent ID, no duplicate row/history.
5. Get/list as A; query A's UUID as B and verify indistinguishable 404.
6. PATCH description as A with ETag v1, verify ETag v2. Verify stale If-Match with a new key yields 412.
7. Suspend, activate, and retire with reasons and fresh ETags. Retired stays readable but cannot be reactivated or patched.
8. Restart API replicas and database; verify committed records persist and idempotency replays still work.
9. Run equivalent register/get/update/list with Node SDK.
10. Re-run the existing full Slice 0 suite and confirm compatibility.

TESTS (REQUIRED, REAL DATABASE — NOT MOCK-ONLY)
- Unit/validation: NFC Unicode and lengths, whitespace, null clearing, unknown fields, invalid IDs/cursors/limits, state machine and ETag parser.
- Security: tenant A cannot read/list/update B, cannot assign B principal as owner, cannot spoof organization_id or server fields, missing/disabled/read-only credentials fail, RLS direct queries cannot cross tenants, DB pool connection context never leaks.
- Concurrency: simultaneous PATCH with same ETag (one 200, rest 412), 100 same-key registrations (one created row/audit/history), different payload same key (409), uncertain commit retries (single effect), audit failure (transaction rollback).
- Idempotency: identical POST response business data, same-key PATCH replay with old If-Match, expired-key behavior, principal revoked before replay.
- Lifecycle: all state transitions and no-ops, terminal retired, metadata updates on suspended allowed.
- Pagination: deterministic stable created_at/id, cursor tampering/filter mismatch/tenant mismatch/expiry rejected.
- Contract: all HTTP codes, response schema, default headers; OpenAPI lint, contract diff, old Slice 0 regression, SDK conformance.
- Deployment: multi-replica race, container restart, failed migrations, recover from real backup in isolated test environment.
- Performance: run baseline query plans/load at an agreed representative dataset, record actual p95/p99 (do not invent results).

DEPLOYMENT
- Extend existing multi-stage OCI image, keep rootless runtime, pinned Node LTS and locked deps, no committed secrets.
- Use a dedicated controlled migration job rather than letting every API replica run migrations.
- Keep Readiness dependent on DB and other required stores, Liveness independent of DB.
- Test old app image on new additive schema before rollout. Use expand/roll-forward rather than destructive production down migration.
- Test Docker Compose locally; provide Kubernetes-compatible readiness and shutdown config if that exists in repo.

EVIDENCE PACKAGE — MANDATORY
Create `docs/releases/slice-1/` and save:
- goal.md, plan.md, completion.md, limitations.md
- contract-openapi.yaml and machine-readable contract diff
- real redacted curl requests/responses and status/ETag/Location
- DB schema/RLS and cross-tenant query proof
- unit/integration/SDK/security/concurrency test output
- Docker build/deployment/health/restart proof
- backup/restore and migration evidence
- optional load test results with methodology if run
- source commit hash and CI run ID
Only mark PASS when the specific command actually ran and returned success; otherwise mark NOT RUN or FAILED. Never fabricate evidence or retain keys in logs/screenshots.

COMPATIBILITY GATES
- Slice 0 existing paths, auth method, error envelopes, idempotency, tenant isolation continue unchanged.
- OpenAPI breaking-diff check must be clean for all previously published /v1 paths.
- All new API fields and SDK conventions enable future tags, capabilities, authorization, federation and language SDKs without making them part of this slice.
- No undocumented response/scope/permission behavior. No breaking database migrations.

DELIVERY RULES
1. Implement the minimum useful code. Avoid unrelated refactors or premature feature scaffolding.
2. Track completed acceptance cases and remaining risks in plan.md.
3. Run all tests you can run and record commands, real outcomes and blockers.
4. If a critical security or tenant-isolation test fails, STOP release and repair before proceeding.
5. Create EXACTLY ONE focused implementation commit only after verification, using ASD-STE100 language: `Add secure agent registration and lifecycle APIs`.
6. Record final commit hash, changed files, actual tests run, deployment result and known limitations in completion.md.
7. STOP after Slice 1. DO NOT begin Slice 2.
