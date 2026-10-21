# Standalone Grok Code `/goal` — FAD Slice 2 Typed Tags

Copy the complete block below into Grok Code from the **existing backend repository**. Attach this Slice 2 package and the previously published Slice 0/1 artifacts if they are not already in the repo. **Implement only Slice 2; do not start Slice 3.**

```text
/goal Implement Federated Agent Directory Slice 2: Typed Tags as a small independently deployable, secure, production-ready backend release.

PRIMARY USER VALUE
An organization administrator creates an ordinary typed tag definition. An authorized service assigns a tag to an existing agent and searches agents by that tag. A security administrator creates and changes a governed/restricted tag. A non-governance service cannot alter or discover that sensitive tag. All changes survive restart, maintain immutable history, and do not alter existing agent APIs or ETags.

SOURCE OF TRUTH
0. Required files in {pwd}/plans/fad-slice-2/README.md
1. Read {pwd}/plans/fad-slice-2/docs/SPECIFICATION.md, {pwd}/plans/fad-slice-2/contracts/openapi.yaml, {pwd}/plans/fad-slice-2/sdk/SDK_CONTRACT.md, {pwd}/plans/fad-slice-2/migrations/20261020_002_typed_tags.up.sql, {pwd}/plans/fad-slice-2/verification/TEST_MATRIX.md, {pwd}/plans/fad-slice-2/examples/api-examples.md, {pwd}/plans/fad-slice-2/docs/COMPATIBILITY_HANDOFF.md and {pwd}/plans/fad-slice-2/deploy/OPERATIONS.md from the supplied Slice 2 package.
2. Inspect the ACTUAL repository and deployed baseline first: Slice 0/1 OpenAPI, migrations, DB role definitions, credential scope provisioning, authentication middleware, tenant transaction wrapper, idempotency code, audit insert, SDK exports, Docker workflow, tests and build scripts.
3. Do not assume previous specification files are installed or identical to deployed code. Reconcile interface differences only with backward-compatible changes. Document every reconciliation decision.
4. Preserve all published /v1 endpoints, response shapes, error behavior, ETags, cursor and credential semantics. No changes to Slice 1 Agent DTO. Tag revisions are independent of agent revisions.

HARD TECHNICAL CONSTRAINTS
- Node.js LTS + strict TypeScript; existing backend architecture and HTTP framework.
- PostgreSQL 16+ authoritative database; single migration runner, transactional version+checksum, advisory lock. Keep schema migrations immutable after shipping.
- Stateless OCI API container and existing deployment; no new service, cache or queue required.
- Strong tenant isolation at application query, composite FK and PostgreSQL RLS levels. Runtime DB role fad_app has no BYPASSRLS, DDL, ownership, history update or physical delete.
- Derive org/principal/scopes only from existing verified X-FAD-API-Key authentication; do not accept tenant switching via user fields.
- Each transactional request sets fad.org_id using SET LOCAL on one transaction connection. Fail closed otherwise.
- Per-tenant agent tagging limited to 64 active assignments per agent; tenant definitions limited to 256. Serialize quota checks with lock so parallel writes cannot bypass them.
- New scopes: tags:define, tags:read, tags:write, tags:governance, tags:restricted:read. Extend existing credential provisioning additively.
- Governed and restricted definitions require tags:governance to create and alter. Reserved namespaces security/compliance/system MUST be governed + restricted. Non-governed tags must never grant authority.
- Tag definition schema immutable; string/integer/boolean/enum scalar support, strict UTF-8/NFC and numeric validation, enum uniqueness, capped lengths.
- Per-tag ETags ("tag-vN"), required Idempotency-Key on mutations. PUT must have exactly one of If-None-Match:* or exact strong If-Match. DELETE requires strong If-Match. Return HTTP 412/428 for mismatches/missing precondition.
- DELETE records tombstone and immutable revision, no hard deletion. Reactivation after tombstone increments revision; prevents ABA.
- History revision, current-state change, audit event and idempotency response MUST commit atomically. No-op and replay must not duplicate history/audit.
- `POST /v1/agents/search` is read-only with exact typed tag equality, AND semantics, max 8 predicates, opaque signed cursor and unchanged Slice 1 agent response envelope. Ensure permissions are checked BEFORE using restricted tags in any predicate; never leak counts/results.
- Use a parameterized, indexed, tenant-filtered query. No arbitrary SQL, regex queries or unbounded scans.
- Per-credential rate limiting, bounded body sizes and query complexity. Logs must redact secrets, restricted values, governed change reasons.
- No MCP tools, federation, delegated authority, general policy engine, inherited tags, new Python/Java/Go/Kotlin SDKs, frontend or agent runtime in this goal.

WORKFLOW — DO THESE IN ORDER, STOP ON FAILURES
A. INVENTORY: inspect repository; report differences with requirements and precise old-contract baseline. Check all affected types, SQL tables and auth scopes.
B. PLAN: write an implementation checklist to docs/releases/slice-2/plan.md with one small substep per module. Include failure injection, rollback and schema-forward compatibility. Keep plan updated with evidence as you complete each substep.
C. CONTRACT: add Slice 2 paths and schemas to the OpenAPI source of truth. Run OpenAPI parse, ref validation, DTO generation and automated semantic backward-compatibility comparison to published Slice 0/1 spec. Resolve any discrepancies before coding.
D. DATABASE: implement new additive tables and indexes only. Validate SQL with real PostgreSQL 16 (not just parser). Ensure migration runner wraps migration and checksum insertion in one atomic transaction. Verify triggers/FKs/constraints/RLS, least-privilege table grants, cross-org insert failures, checksum immutability and concurrent migrator exclusion.
E. DOMAIN: implement typed tag definition create/get/list and agent assignment put/get/list/delete. Enforce immutable definitions, governed permissions, visibility, quota limits and exact state/ETag transitions. Share Slice 0 authentication, idempotency, audit and Slice 1 agent transaction/session code.
F. SEARCH: add read-only POST /v1/agents/search. Filter with bounded index-backed EXISTS queries, same pagination response as Slice 1. Cursor binds tenant/filter/scope set; enforce restricted-read requirements before query. Verify SQL query plans under representative fixtures.
G. SDK: add strongly typed Node.js methods, preserving existing constructor and exports. Preserve 0/false, ETags, typed errors, safe retries, AbortSignal and pagination. Do not modify existing Agent types. Verify from an independent Node.js consumer project.
H. DEPLOY: use existing Dockerfile/Compose and deployment process. Add config validation and disabled-by-default FAD_TAGS_ENABLED flag. Run migration before rollout using separate role. Test rollback to previous image without dropping tables; old APIs stay healthy.
I. VERIFY: implement automated tests corresponding to ALL cases in verification/TEST_MATRIX.md. Run tests, real end-to-end HTTP smoke, RLS direct DB negative tests, concurrency, idempotency, failure injection, old SDK/new server regression, docker restart, backup/restore drill as feasible. No mocked results count as proof of integration.
J. EVIDENCE: save actual redacted HTTP requests/responses, schema checksum, DB RLS queries/output, test logs, SDK independent consumer output, Docker image digest/health/restart output, old/new OpenAPI compatibility output, a list of known risks and deployment/rollback evidence. Never fabricate pass reports or screenshots.
K. FINISH: run ALL relevant repository lint/typecheck/unit/integration/security/contract tests. Record outcomes and unresolved limits honestly. Update docs/releases/slice-2/completion.md with real commit hash, commands, and evidence links. Create EXACTLY ONE focused Git commit with an ASD-STE100-style short message, e.g. 'Add secure, typed agent tags and tag search'. Stop. Do not start Slice 3.

REQUIRED PUBLIC ROUTES
POST /v1/tag-definitions
GET /v1/tag-definitions
GET /v1/tag-definitions/{namespace}/{key}
GET /v1/agents/{agentId}/tags
GET /v1/agents/{agentId}/tags/{namespace}/{key}
PUT /v1/agents/{agentId}/tags/{namespace}/{key}
DELETE /v1/agents/{agentId}/tags/{namespace}/{key}
POST /v1/agents/search

NONNEGOTIABLE NEGATIVE TESTS
- Cross-organization agent or tag access never leaks existence.
- Runtime SQL context omitted or forged cannot read/write another tenant.
- Ordinary tags:write credential cannot change security.risk or other governed tags.
- Restricted keys do not appear in unprivileged listing or search results.
- Unknown tag types, missing reason, malformed enum, invalid integer, wrong primitive, null/array/object rejected.
- `false` and `0` accepted.
- Two concurrent PUTs against one ETag cannot both mutate.
- Delete + recreate advances monotonically, making previous ETags stale.
- Retries with the same idempotency key do not duplicate history; key with different payload/conditional headers conflicts.
- No tag update can commit while agent retirement wins the race.
- Audit write failure aborts actual tag change.
- Definition/assignment quota not bypassed by concurrent writes.
- Existing Slice 0/1 REST APIs and old SDK behavior unchanged.
- Container restarts preserve data; schema migration is safe and reversible at code level.

DEFINITION OF DONE
A separate Node.js project can call existing SDK and new tag methods; real API and DB tests pass; unauthorized sensitive changes are denied; tags and search return correct data; audit and revisions persist; backward compatibility gate passes; container image is deployable, with migration and rollback runbook; evidence exists under docs/releases/slice-2/; exactly one commit was made. If any mandatory gate fails, report failure, leave implementation unfinished, and do not claim production-ready.
```
