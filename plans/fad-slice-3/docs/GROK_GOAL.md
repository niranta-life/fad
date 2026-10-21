/goal Implement Federated Agent Directory Slice 3: Immutable Capabilities, Endpoint Metadata, Capability Bindings, and Local Discovery

OBJECTIVE
Build ONE independently deployable, production-safe, backend-only vertical slice on the existing FAD Slices 0–2 Node.js/TypeScript codebase. Deliver real value: administrators can publish immutable versioned capability schemas, declare HTTPS agent endpoints, bind capability versions to endpoints, and discover same-organization active agents by capability, typed tags and protocol through REST and the existing Node.js SDK. Never claim discovery means the agent is healthy, trusted or authorized for invocation.

SOURCE DOCUMENTS TO READ BEFORE IMPLEMENTING
1. `{pwd}/plans/fad-slice-3/docs/SPECIFICATION.md` in this Slice 3 package: canonical requirements, invariants and user journey.
2. `{pwd}/plans/fad-slice-3/contracts/openapi.yaml`: proposed combined additive Slices 0–3 `/v1` contract (new operations and exact schemas).
3. `{pwd}/plans/fad-slice-3/migrations/20261020_003_capabilities_discovery.up.sql` and accompanying rollback.md.
4. `{pwd}/plans/fad-slice-3/verification/TEST_MATRIX.md` and `{pwd}/plans/fad-slice-3/verification/acceptance-smoke.sh`.
5. `{pwd}/plans/fad-slice-3/sdk/SDK_CONTRACT.md`, `{pwd}/plans/fad-slice-3/deploy/OPERATIONS.md`, `{pwd}/plans/fad-slice-3/docs/ARCHITECTURE_DECISIONS.md`, and API examples.
6. The ACTUAL existing repository's deployed Slices 0–2 OpenAPI, SQL migrations, auth, request context, audit, idempotency, Docker setup, SDK and tests. Actual released behavior is authoritative. Do not assume proposed package files have been deployed.

ABSOLUTE CONSTRAINTS
- Use existing Node.js LTS + TypeScript service, PostgreSQL, container and tenancy architecture. No new microservice or separate database.
- Preserve all previously released `/v1` routes, request/response properties, status codes, headers, authentication scopes, error formats and ETag semantics; add new paths and component definitions only. Do not refactor old code unless necessary to resolve a verified issue and backward-compatible.
- Use credential-resolved organization and principal; never accept tenant from input. App SQL must be tenant-scoped with FORCE RLS and transaction-local `fad.org_id`. No unrestricted admin route.
- Scope checks deny by default. Extend credential allowlist with `capabilities:read/write`, `endpoints:read/write`, do not auto-grant to previous credentials.
- Do not introduce MCP server, A2A agent invocation, federation, tag-based access policies, OAuth identity flows, runtime probes or arbitrary outbound calls in Slice 3.
- No credentials/private keys in endpoint metadata, URLs, logs, examples or metrics.
- All mutations use existing idempotency infrastructure, authoritative transactions, audit, signed revision history where applicable, and optimistic ETags. Do not mutate parent agent/tag revisions for binding/endpoint changes.
- Do not claim tests pass without executed proof. Exactly one focused Git commit after all acceptance gates. Stop after Slice 3.

USER JOURNEY TO PROVE VIA REAL SERVICE
A. Bootstrap two independent organizations with separate active machine credentials using existing Slice 0 setup; each credential has explicit necessary read/write scopes, but Organization B is not entitled to Organization A's data.
B. In A, register a NEW active invoice-processing agent via existing Slice 1 endpoint (or use a freshly registered test fixture) and assign Slice 2 tag `department.name=finance`.
C. Publish version `1.0.0` of capability `finance.invoice.match` with valid bounded input and output JSON Schema 2020-12. Read it back and list catalog. Publish with same Idempotency-Key/body again; observe original 201 result with no duplicate rows. New key/duplicate version must be 409.
D. Register endpoint key `primary`, protocol `a2a`, `https://ap.internal.example/a2a`, auth scheme `oauth2` using `Idempotency-Key` and `If-None-Match:*`. Read exact endpoint and verify `"endpoint-v1"`.
E. Bind the capability to `primary` using `If-None-Match:*`. Read binding and verify `"cap-binding-v1"`.
F. Discover agents using capability ID/version, tag `department.name=finance`, protocol `a2a`. Response contains A agent, bound endpoint and provenance `self_declared`, plus `availability:not_checked` and `invocation_authorization:not_evaluated`. Old Slice 1 Agent schema/ETag unchanged.
G. Repeat reads/discovery from B: no A data, other-org direct IDs behave indistinguishably from missing IDs.
H. Disable endpoint via valid `If-Match` and check discovery excludes agent; reenable and verify it returns. Suspend agent through legacy lifecycle endpoint and check discovery excludes; reactivate and check it returns.
I. Show an endpoint with active binding cannot be deleted (409). Tombstone binding with its ETag; then tombstone endpoint. Discovery now omits agent. Recreate metadata using `If-None-Match:*`; revision must not reset, and old ETags cannot be used.
J. Exercise malicious/invalid schema, URL, cross-tenant FK, restricted tag filter, stale revision, wrong scope, duplicate content, replay races, DB failover and restart. Verify no DNS/HTTP requests ever go to declared endpoints.
K. Install packed SDK into a separate Node.js project; run the full journey through the SDK. Show Slices 0–2 regression suite still passes after deployment and when feature flag is off.

IMPLEMENTATION STEPS (STOP AFTER EACH TO VERIFY)
1. Inspect repository and create `docs/releases/slice-3/goal.md` plus bounded `plan.md`. Inventory currently deployed contracts/migrations, auth scopes, SDK APIs and image build. Record SHA256 for released Slice 2 OpenAPI and a machine-readable additive compatibility diff. If actual baseline differs from bundled one, stop changes to old behavior; adapt only new API and document discrepancy.
2. Add immutable capability version domain model + SQL table + tenant FK and RLS. Implement strict ID and semver grammar, numeric bounds, bounded JSON Schema Draft 2020-12 syntax validation, no `$ref`/`$dynamicRef`/`$id` or network fetch. Compute RFC 8785 SHA256 on canonical contract. Publish/read/list HTTP and SDK, with idempotency, audit, error/cursor behavior.
3. Add per-agent versioned endpoint metadata model (including tombstones/history) and secure HTTPS URL validation WITHOUT making outbound requests. Add read/list/conditional PUT/DELETE and SDK methods. Limit 8 live per agent; maintain revisions, locks, authorization, idempotency and audit. Prevent deletion while referenced by a live binding.
4. Add per-agent capability bindings. One active version per capability ID and one endpoint per binding; same-org FK to immutable catalog and same-agent endpoint. Implement read/list/conditional PUT/DELETE, no-op, strong ETags, 32-binding limit and tombstones. Keep agent/tag ETags untouched.
5. Implement read-only local discovery POST using exact capability ID/optional exact version, up to eight authorized typed tag predicates from existing Slice 2, protocol filter, sorted UUID keyset, query-bounded signed cursor scoped to org/principal/scopes/query, no total count, no remote network. Only active agents, live bindings and enabled endpoints. Never claim trust/health/invocation authorization.
6. Extend `@fad/sdk` without altering older exports or method semantics. Add typed models, cancellation, bounded retries on safe/idempotent requests, cursor helpers and stable error translation. Run independent package consumer tests. Do not auto-invoke any agent.
7. Extend Docker/migrator deployment additively. Use one privileged transactionally executed migration and separate unprivileged runtime role, false-by-default feature flag. Run canary with existing Slices 0–2 regression suite, then new tests. Run multi-replica tests and feature rollback keeping new tables.
8. Run all P0 cases in `verification/TEST_MATRIX.md`. Fix failures before proceeding; load benchmark P1 with published reproducible hardware and dataset. Include unit, integration, DB/RLS, concurrency, schema fuzz/bounds, cursors, HTTP contract, SDK and deployment. Include SQL injection/SSRF negative tests. No forbidden admin fallback.
9. Assemble proof under `docs/releases/slice-3/`: goal.md, plan.md, contract-diff.json, migration proof/checksum, executed HTTP requests/responses with secrets redacted, API smoke logs, SQL/RLS test output, npm packed consumer output, perf plans and actual results, Docker image digest and restart/failover logs, rollback evidence, risk list, completion.md. Include request IDs, environment, test command, result, commit hash and CI link where available. No mock outputs as production evidence.
10. Review implementation for security, durability, API compatibility and complexity. Verify existing Slices 0–2 contracts are byte-semantically compatible and current SDK works. Create exactly ONE focused Git commit with short ASD-STE100-style message, such as `Add secure local capability discovery to agent directory`. Record hash and evidence; STOP. Do not start Slice 4.

DETAILED HARD RULES
- One DB source of truth. Do not add Redis, Elastic, federation gossip, or background jobs before measured need.
- Serializable limit enforcement: lock agent first, then endpoint, then binding in a consistent order. Retirement races and limit races must have deterministic safe outcomes. DB role must not own tables or BYPASSRLS.
- All organization-qualified foreign keys; prohibit cross-tenant references. Failed writes must not produce partial history or success audit/idempotency rows.
- Endpoints do not contain credentials, query strings, URI userinfo, fragments or IP literals. Must be HTTPS. Do not resolve, probe or invoke declared endpoints.
- Capability versions cannot be updated, deleted or replaced in place. All claims are `self_declared`. A published schema is a declaration, not runtime compliance evidence.
- Endpoint and binding writes support IF preconditions exactly as OpenAPI; never silently overwrite. Tombstoning cannot reset revision on later recreation. Missing preconditions 428; stale 412; already-in-use 409.
- Discovery must honor restricted-tag visibility and return no data when current credential lacks scopes. A derived or cached attribute never bypasses primary tenant check. Query remains bounded under malicious predicates. Cursor replay across principal/org/filter fails.
- All responses use the existing envelope and `meta.api_version:v1`. Unknown future enum values should not crash SDK clients. In all error responses avoid revealing hidden target presence.
- Audit includes provenance, never secrets. Use operational tracing and measurable latency. Replay checks authorization again before returning saved result.

SUCCESS / DEFINITION OF DONE
- Every end-to-end step A–K is executed against real containers and PostgreSQL, not mocks.
- New API routes pass OpenAPI contract and request/response schema checks; Slices 0–2 exact behavior and Node.js SDK are preserved.
- All P0 acceptance and adversarial cases pass and are evidenced; migration/restart/rollback proven.
- Multi-tenancy and RLS defense verified against independent org credentials and direct SQL.
- New SDK methods work from independent Node.js consumer against deployed test environment.
- Source, docs, migrations, deployment and evidence are in ONE commit; no uncommitted implementation changes; no unrequested Slice 4 code.
