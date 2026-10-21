# Slice 2 plan: typed tags

The served Slice 0 and Slice 1 contracts stay in force. This file records each reconciliation with `plans/fad-slice-2/`.

## Reconciliations

- The package file `20261020_002_typed_tags.up.sql` uses a version already shipped as `db/migrations/20261020_002_principal_lock.up.sql`. The tag migration is `db/migrations/20261021_001_typed_tags.up.sql`. The SQL is the package body plus `fad_lock_organization`. The down script is not installed.
- `fad_app` has `SELECT` only on `organizations`. `SELECT FOR UPDATE` needs `UPDATE`. `fad_lock_organization` is `SECURITY DEFINER`, owned by `fad_bootstrap`, and locks the organization row for the definition quota. It returns a row only when `fad.org_id` matches.
- Slice 1 `retire`, `suspend`, `activate`, and metadata update already take `FOR UPDATE` on the agent row. Tag writes take the same lock. A retirement that commits first makes the tag write return 409. External agent responses stay the same.
- `FAD_TAGS_ENABLED` defaults to false. Only the exact string `true` enables tag routes. When the flag is false, those routes are not mounted and return 404 `NOT_FOUND`. The process does not query tag tables for those routes. `/health/ready` still requires every migration file the process ships, including the tag migration, so a new image is not ready on an old schema.
- Quota overflow is 422 `VALIDATION_ERROR`. It is not 429. 429 stays the credential rate limit. The ceilings are 64 active assignments and 256 definitions. Configuration may lower them. It cannot raise them.
- A duplicate definition with a new idempotency key is 409 `TAG_DEFINITION_EXISTS`. Idempotency reuse with a different body or conditional header stays 409 `IDEMPOTENCY_CONFLICT`. A retired agent tag write is 409 `INVALID_AGENT_STATE`. Agent lifecycle keeps `INVALID_STATE_TRANSITION`.
- 412 and 428 keep the Slice 1 messages for `PRECONDITION_FAILED` and `PRECONDITION_REQUIRED`. The error code is shared. The Slice 1 text does not change.
- Search treats an unknown definition, a wrong value type, a repeated key, or an operator other than `eq` as 422 `VALIDATION_ERROR`. A restricted predicate without `tags:restricted:read` is 403 before the agent query runs. A direct read of a hidden tag stays 404, same as missing.
- Response schemas do not set Ajv `maxLength` on tag strings. Ajv counts UTF-16 code units. The service counts Unicode code points. The same choice is already in the Agent name schema.
- `POST /v1/agents/search` with only `status` needs `agents:read`. Tag predicates also need `tags:read`. `{}` is 422.
- Tag changes do not write `agents.revision`. The Agent JSON shape is unchanged.
- `GET /v1/agents/search` with the flag off still matches `GET /v1/agents/{agentId}` and returns 400 `VALIDATION_ERROR` for the word `search`. That is the Slice 1 invalid-id result. `POST /v1/agents/search` with the flag off is 404 `NOT_FOUND`. With the flag on, a non-POST method on that path is 405.
- Tag search casts namespace and key parameters to `varchar` and reads the first predicate from a `MATERIALIZED` CTE. On PostgreSQL 16, `OFFSET 0` did not keep the planner from probing `agent_tag_by_agent_idx`. After `ANALYZE`, the equality lookup uses `agent_tag_match_idx`.
- A JSON number that parses to an in-range integer, including `1e2`, is stored as that integer. Floats and out-of-range numbers are rejected.

## Checklist

- [x] Inventory and this plan. Migration version is `20261021_001_typed_tags`.
- [x] Additive OpenAPI paths and schemas. `node scripts/openapi-diff.mjs` reported `ok: true` and `breaking: []`. Every operation in parent `566bf826993bb7d783de6ea080bc0f4a9bc0d139` is deep-equal. The only new operations are the eight tag routes. `docs/releases/slice-2/openapi-diff.json`.
- [x] Migration applied on PostgreSQL 16. Checksum `0d167c6c212b2487afa8c1ba6ad0b0a0cf873c1b2dc1297bd1f5c7b8d9d7d45c` is stored once and matches the file. `fad_app` sees 0 rows without `fad.org_id`. Insert without that setting fails. `fad_app` has no `BYPASSRLS` and no delete grants. A bad later migration rolled back in R12.
- [x] Definitions, assignments, quotas, ETags, tombstones, idempotency, and audit. Matrix D and A and R cases passed on PostgreSQL 16.
- [x] Read-only search and SDK methods. Q01–Q16 passed, including an independent consumer.
- [x] One test for every id in the test matrix. `node --test --test-concurrency=1 tests/*.test.mjs` exited 0. 11 tests, 11 pass.
- [x] Flag off, restart, previous image, and a separate Node.js consumer. Launch logs show `false` and `0`. Rollback log shows the previous image ready and the new image ready.
- [x] Evidence is under this directory. One commit follows. Slice 3 is not started.

## Rollback

Disable `FAD_TAGS_ENABLED` and deploy the previous API image. Do not drop the new tables. Do not run the package down script on a database that has tag rows.
