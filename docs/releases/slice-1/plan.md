# Slice 1 plan

Workspace: `/Users/nitin/Work/Y/fad`. Current commit before this slice: `ad2193df81fd0b0c3d34f32cfe00f402201f1a7b` (`Add the README and the MIT license.`). Its parent is `b10ca84` (`Build tenant-safe FAD API foundation`). Do not amend either commit. Add one new commit after verification.

## Dependency matrix

| Item | State |
|---|---|
| Git | `main` at `ad2193df81fd0b0c3d34f32cfe00f402201f1a7b`. Remote `origin` is `niranta-life/fad`, default branch `develop`. This slice does not push. |
| Node | Application engines `>=22`. Container image uses Node 24. |
| HTTP | Fastify 5 in `apps/api`. |
| Database | PostgreSQL 16. Roles in `db/roles/00_roles.sql`. Migrations `0001_foundation`, `0002_rate_limit`. Runner `apps/migrator`. API does not apply DDL. |
| Auth | Header `X-FAD-API-Key`. Lookup `fad_lookup_api_credential`. Scopes already include `agents:read`, `agents:write`, `agents:lifecycle`. |
| Tenant | `withTenant` sets `set_config('fad.org_id', ..., true)` inside the transaction. |
| Audit | `insertAudit` inserts into `audit_events` in the caller transaction. No UPDATE grant. |
| Idempotency | `idempotency_records`. Insert only on commit. No UPDATE grant. ADR 0005. |
| SDK | `@fad/sdk` 0.1.0. Health and current organization only. |
| CI | No job is configured. CI run id is NOT RUN. |

## Reconciliation

Slice 0 wins where the proposal disagrees.

- Credential header stays `X-FAD-API-Key`. Security scheme name stays `FadApiKey`.
- Error envelope stays `{error:{code,message}, meta:{request_id,api_version}}`. `request_id` stays a server UUID.
- Malformed input uses `400 VALIDATION_ERROR`, not `BAD_REQUEST`. Missing or bad credentials use `401 UNAUTHORIZED`, not `UNAUTHENTICATED`.
- Unknown JSON fields and invalid owner use `422 VALIDATION_ERROR`. The code is the Slice 0 validation code. The status is 422 only on the new routes.
- New codes: `AGENT_NOT_FOUND`, `INVALID_STATE_TRANSITION`, `IDEMPOTENCY_CONFLICT`, `PRECONDITION_FAILED`, `PRECONDITION_REQUIRED`, `UNSUPPORTED_MEDIA_TYPE`.
- Idempotency does not add an in-progress row and does not grant UPDATE. A transaction advisory lock serializes the same key. The final row is inserted with the agent change. Retention is 24 hours. An expired row is deleted and the key can be used again. Replay rewrites `meta.request_id` and keeps the stored business data.
- Cursor MAC uses `FAD_API_KEY_PEPPER_V1`. No new key table.
- `global_id` is derived. It is not a column.
- The proposal down script is not a migration the runner applies. Production rollback is roll the application forward or restore a backup. Do not run the down script on a database that has agent rows.

## Files to change

- `contracts/openapi.yaml` — add the seven agent operations. Keep every Slice 0 path and the `X-FAD-API-Key` scheme.
- `plans/fad-slice-1/contracts/openapi.yaml` — same wire decisions, so the proposal matches the service.
- `db/migrations/20261020_001_agents.up.sql` — byte copy of the proposal up script.
- `packages/db/src/idempotency.ts` — claim/replay helper. No second store.
- `packages/db/src/audit.ts` — optional request id on the existing insert.
- `packages/db/src/agent-rules.ts` — normalization, state machine, ETag, cursor.
- `packages/db/src/agents.ts` — tenant-scoped commands.
- `packages/contract/src/envelopes.ts` — new error codes.
- `apps/api/src/auth.ts` — shared credential check. Organization route behavior stays.
- `apps/api/src/agent-routes.ts` — thin HTTP adapter.
- `apps/api/src/app.ts` — mount the routes. Liveness stays independent of the database.
- `packages/sdk/src/index.ts` — agent methods and mutation retry.
- `tests/contract.test.mjs`, `scripts/openapi-diff.mjs` — Slice 0 paths stay compatible. Agent routes are allowed.
- `tests/agents.test.mjs`, `tests/sdk.test.mjs` — real database and client checks.
- `docs/releases/slice-1/` — evidence after the commands run.

## Data model

`agents` holds the current row. Primary key `(organization_id, id)`. `agent_revisions` stores one snapshot per real change. `agent_lifecycle_events` stores the transition and the reason. Foreign keys use `(organization_id, principal_id)`. RLS is enabled and forced for `fad_app`. The role gets SELECT, INSERT, UPDATE on `agents` and SELECT, INSERT on the history tables. It does not get DELETE. It does not own the tables.

Every query includes `organization_id` and runs inside `withTenant`.

List order is `created_at DESC, id DESC`. The cursor contains version, organization, status filter, last position, and expiry. A bad, expired, cross-tenant, or filter-mismatched cursor is 400.

## Query pattern

1. Authenticate the key and require the operation scope.
2. Validate the body and headers.
3. Begin a transaction and set `fad.org_id` for that transaction only.
4. Take an advisory lock for the idempotency identity. Replay or reject before any agent write.
5. Lock the actor principal. Lock the agent row when it exists. Lock the owner principal on create or owner change.
6. Apply the change only when the locked revision matches `If-Match` and the state machine allows it.
7. Insert the revision, the lifecycle row when status changes, the audit row, and the idempotency row.
8. Commit. A failure in any insert rolls the transaction back.

A metadata no-op or a repeated status does not increment `revision` and does not insert history.

## Acceptance matrix

| Case | Proof |
|---|---|
| Register, get, list, patch, suspend, activate, retire | HTTP test and journey |
| Same key replay, one row | HTTP test |
| Other organization 404 | HTTP test |
| Missing If-Match 428, stale If-Match 412 | HTTP test |
| Retired 409, no-op revision | HTTP test |
| Concurrent same ETag | HTTP test |
| Same key, different body 409 | HTTP test |
| Audit failure rolls back | Trigger on `audit_events` |
| No tenant context | Direct `fad_app` query |
| SDK retry keeps key and If-Match, does not retry 412 | SDK test and separate project |

## Risks

- Cursor MAC depends on the API pepper. Pepper rotation invalidates cursors. Clients must restart the list.
- `fad_app` can DELETE idempotency rows. That grant is from Slice 0 and is required to drop an expired key.
- The 10,000-agent performance profile is not a release gate. Record only a sample that was run.
- No CI job exists.

## Rollback

Keep the additive tables. Roll the application back only if that build tolerates the extra tables. Slice 0 `migrationsMatch` accepts extra applied versions. Do not run `20261020_001_agents.down.sql` against a database that contains agents. Restore from backup when the data must disappear.

## Test commands

```sh
npm run build
node --test --test-concurrency=1 tests/contract.test.mjs tests/unit.test.mjs tests/db.test.mjs tests/http.test.mjs tests/sdk.test.mjs tests/agents.test.mjs
node scripts/openapi-diff.mjs
```

Run the database tests against PostgreSQL 16 with `DATABASE_URL`, `FAD_MIGRATOR_DATABASE_URL`, `FAD_BOOTSTRAP_DATABASE_URL`, and `FAD_API_KEY_PEPPER_V1` set. Do not print those values.

## Deviations

The Slice 0 migration runner wraps each file and its checksum insert in one transaction. The proposal script also contained `BEGIN` and `COMMIT`. Those statements were removed from `db/migrations/20261020_001_agents.up.sql` so the checksum insert stays in the same transaction.

`fad_app` has `SELECT` on `principals` and no `UPDATE`. PostgreSQL 16 rejects `SELECT FOR SHARE` and `SELECT FOR UPDATE` without `UPDATE`. `db/migrations/20261020_002_principal_lock.up.sql` adds `fad_lock_principal`, owned by `fad_bootstrap`. The function takes `FOR SHARE` and returns a row only when `fad.org_id` matches. The lock lasts until the caller transaction ends. `fad_app` still cannot update principals.

The idempotency read does not use `FOR UPDATE`. The same-key advisory lock serializes writers. `fad_app` has no `UPDATE` on `idempotency_records`.

The Slice 0 expired-credential HTTP check used to set `expires_at` one millisecond after `created_at`. That window could still be in the future when the next request ran. The check now sets both timestamps in year 2000, with `expires_at` still later than `created_at`. Product authentication is unchanged.

List cursors store `created_at` from PostgreSQL with microsecond precision. `Date.toISOString()` drops microseconds. A keyset bound at the truncated millisecond skipped older rows in that same millisecond. The list query now reads `to_char(..., US)` and compares that exact `timestamptz`.

`@fad/sdk` retries a safe GET after a connection failure. The retry uses the same URL, method, and credential. It uses the same bounded backoff as HTTP 429 and 503. It does not retry 401.

The served OpenAPI file adds seven operations. The Slice 0 package file is unchanged. Previously published operations stay deep-equal.

## Status

The commands in `completion.md` record pass, fail, or not run. The `develop` commit message is `Add secure agent registration and lifecycle APIs`. The commit id is `git --no-replace-objects rev-parse HEAD`.

- [x] Additive agent migration, forced row security, no-context reads, and runtime role grants. Proof: `db/migrations/20261020_001_agents.up.sql`, `db/migrations/20261020_002_principal_lock.up.sql`, `api-evidence/journey.log` (`relforcerowsecurity` true, `fad-app-no-context 0`), `test-evidence/named-suite.log` (`agent-no-context`, `agent-rls-cross`, `agent-grants`).
- [x] Register, get, list, patch, suspend, activate, and retire, with idempotency, ETag, and audit in one transaction. Proof: `apps/api/src/agent-routes.ts`, `api-evidence/journey.log`, `test-evidence/slice1-db-http.log`.
- [x] SDK agent methods, retry rules, and a separate-project smoke call. Proof: `packages/sdk/src/index.ts`, `sdk-evidence/slice1-sdk.log` (`sdk-exit 0`), `test-evidence/named-suite.log` (`sdk-get-network-retry`, `sdk-get-no-retry-401`).
- [x] Journey, Slice 0 suite, and new tests, then one implementation commit. Proof: `api-evidence/journey.log`, `test-evidence/slice0-regression.log` (10 pass, 0 fail), `test-evidence/named-suite.log` (8 pass, 0 fail).
- [x] Backup and restore on an isolated PostgreSQL 16 container. Proof: `db-evidence/restore.log`. `pg_dump` exit 0. `pg_restore` exit 0. Counts matched `140,221,182` and the four migration versions. Result: PASS.
- [x] Failed migration rolls back on an isolated database. Proof: `db-evidence/failed-migration.log`. The runner threw. `schema_migrations` and `agents` were absent. The database was dropped. Result: PASS.
