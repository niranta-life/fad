# Slice 1 completion

Commit message: Add secure agent registration and lifecycle APIs

The commit id is the output of `git --no-replace-objects rev-parse HEAD` after this commit. This file does not store that id. No replace ref, graft, or skip-worktree bit is used.

CI job URL: not configured. Result: NOT RUN.

Parent on `develop` before this slice: `b01f9bfa7810131dcf59ca20039a28bec0b9c21c`.

## Changed files

Files in the Slice 1 squash onto `develop`:

- `.gitignore`
- `README.md`
- `apps/api/src/agent-routes.ts`
- `apps/api/src/app.ts`
- `apps/api/src/auth.ts`
- `contracts/openapi.yaml`
- `db/migrations/20261020_001_agents.up.sql`
- `db/migrations/20261020_002_principal_lock.up.sql`
- `docs/releases/slice-1/api-evidence/journey.log`
- `docs/releases/slice-1/completion.md`
- `docs/releases/slice-1/contract-openapi.yaml`
- `docs/releases/slice-1/db-evidence/failed-migration.log`
- `docs/releases/slice-1/db-evidence/restore.log`
- `docs/releases/slice-1/db-evidence/source-ready.log`
- `docs/releases/slice-1/deployment-evidence/docker-build.log`
- `docs/releases/slice-1/deployment-evidence/docker-proof.log`
- `docs/releases/slice-1/deployment-evidence/slice1-launch-1.log`
- `docs/releases/slice-1/deployment-evidence/slice1-launch-2.log`
- `docs/releases/slice-1/goal.md`
- `docs/releases/slice-1/limitations.md`
- `docs/releases/slice-1/openapi-diff.json`
- `docs/releases/slice-1/plan.md`
- `docs/releases/slice-1/sdk-evidence/slice1-sdk.log`
- `docs/releases/slice-1/test-evidence/named-suite.log`
- `docs/releases/slice-1/test-evidence/slice0-regression.log`
- `docs/releases/slice-1/test-evidence/slice1-db-http.log`
- `package-lock.json`
- `packages/contract/scripts/generate.mjs`
- `packages/contract/src/envelopes.ts`
- `packages/contract/src/generated.ts`
- `packages/contract/src/validators.ts`
- `packages/db/src/agent-rules.ts`
- `packages/db/src/agents.ts`
- `packages/db/src/audit.ts`
- `packages/db/src/idempotency.ts`
- `packages/db/src/index.ts`
- `packages/sdk/README.md`
- `packages/sdk/package.json`
- `packages/sdk/src/index.ts`
- `scripts/openapi-diff.mjs`
- `scripts/sdk-agent-smoke.mjs`
- `tests/agent-rules.test.mjs`
- `tests/agents.test.mjs`
- `tests/contract.test.mjs`
- `tests/http.test.mjs`
- `tests/sdk-agents.test.mjs`
- `tests/sdk.test.mjs`

## What shipped

The API registers an agent and can get, list, update, suspend, activate, and retire it. Each real change writes the current row, a revision snapshot, a lifecycle row when status changes, a Slice 0 audit row, and the idempotency response in one transaction. A no-op does not bump the revision. Row security is forced. `fad_app` does not own the tables and cannot bypass RLS.

`@fad/sdk` is version 0.2.0. A safe GET retries the same request on HTTP 429, HTTP 503, and a connection failure. Mutation retries repeat the same `Idempotency-Key` and the same `If-Match`. They retry 429, 503, and network failures only. The client does not retry 401.

The new image is `fad-api:slice1`, id `sha256:97f4db1dd59a83ba747b785f0c6334233c7e90dcbd2a31fd35983b0fa2394c60`, Node v24.22.0, user `node`, linux/arm64. The Slice 0 image `sha256:d2b388bf095974ce6028309c3918384c7d7b9570414c18fa0870340197fca49f` still served `GET /health/live`, `GET /health/ready`, and `GET /v1/organizations/current` on the database after the agent migrations. `GET /v1/agents` on that old image returned 404.

Migration checksums read from the database after the journey:

| Version | SHA-256 |
| --- | --- |
| `0001_foundation` | `09fb08e50ca20f3c1f18a32e93c03260f476c52816a976e1754a8b34505dc463` |
| `0002_rate_limit` | `2b8f86066af0b29968268db39ca3dd297677321339b947d46e46613f68811924` |
| `20261020_001_agents` | `96ad57d503b52926c3f83c90b66dbb37a6462bfeb4b1959a495e47a7508ffe12` |
| `20261020_002_principal_lock` | `93a7a7f269ffe076cce814b9157209d3efee11d3f7efa5b791e6d25891118db9` |

## Commands

| Command | Result | Evidence |
| --- | --- | --- |
| `docker build -f deploy/docker/Dockerfile -t fad-api:slice1 .` | PASS | `deployment-evidence/docker-build.log` names `fad-api:slice1` and manifest list `sha256:97f4db1dd59a83ba747b785f0c6334233c7e90dcbd2a31fd35983b0fa2394c60`. |
| `node --test --test-concurrency=1 tests/*.test.mjs` | PASS | 10 tests, 10 pass, 0 fail, duration 6889.79525 ms. `test-evidence/slice0-regression.log`. |
| `node --test --test-concurrency=1 tests/agents.test.mjs tests/agent-rules.test.mjs tests/sdk-agents.test.mjs tests/contract.test.mjs tests/db.test.mjs tests/http.test.mjs tests/sdk.test.mjs` | PASS | 8 tests, 8 pass, 0 fail, duration 6666.334041 ms. Concurrency, cursor rejection, audit rollback, pagination, same-millisecond paging, GET connection retry, and expired credential check passed. `test-evidence/named-suite.log`. |
| `node --test --test-concurrency=1 tests/agents.test.mjs` | PASS | 1 test, 1 pass, 0 fail. `test-evidence/slice1-db-http.log`. |
| `node scripts/openapi-diff.mjs` | PASS | `breaking` is empty. Slice 0 package hash unchanged. `openapi-diff.json`. |
| Curl journey on two host API processes, then PostgreSQL restart | PASS | Register 201, replay same id, cross-tenant 404, patch v2, stale 412, suspend, activate, retire, retired 409. After `docker restart fad-s0-pg`, the retired agent was readable and the original key replayed. `api-evidence/journey.log`. |
| Direct `fad_app` reads | PASS | No tenant context returned 0 rows. The other organization's setting returned 0 rows for that agent. |
| `pg_dump` and `pg_restore` into isolated `fad-s1-restore` | PASS | `db-evidence/restore.log`. Source and restored counts were `140,221,182` with the four migration versions. Forced row security stayed on. The container was removed. The dump file was deleted. |
| Failed migration on database `fad_s1_fail` | PASS | `db-evidence/failed-migration.log`. The runner threw. `schema_migrations` and `agents` were absent. The database was dropped. |
| SDK pack installed in a separate project | PASS | `sdk-exit 0`. Printed id, organization id, global id, revision 2, etag `"agent-v2"`. |
| Two rootless API containers from `fad-api:slice1` | PASS | Each replica returned 201 then 200. `data.global_id` was `urn:fad:agent:<org>:<id>`. ETag was `"agent-v1"`. `Cache-Control` was `private, no-store`. `deployment-evidence/slice1-launch-1.log` and `deployment-evidence/slice1-launch-2.log`. |
| Old Slice 0 image on the new schema | PASS | `deployment-evidence/docker-proof.log`: live 200, ready 200, current 200, `/v1/agents` 404. |
| Load sample, 40 sequential list requests | PASS | p50 4.56 ms, p95 5.50 ms, p99 10.18 ms. Not an SLO. See `limitations.md`. |
| `docker scout` | NOT RUN | The CLI is not logged in. |
| CI | NOT RUN | No workflow is configured. |
| Public npm publish | NOT RUN | Not approved. |

## Deployment

The API process does not apply DDL. Compose still runs `apps/migrator` once, then starts the API. Liveness does not query the database. Readiness does. The containers used `--read-only`, `--cap-drop ALL`, `no-new-privileges`, and user `node`.

Rollback keeps the new tables. An old API build accepts extra migration versions. Do not run the proposal down script on a database that contains agents.
