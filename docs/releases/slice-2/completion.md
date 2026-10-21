# Slice 2 completion

Commit message: Add secure, typed agent tags and tag search

The commit id is the output of `git --no-replace-objects rev-parse HEAD` after this commit. This file does not store that id. No replace ref, graft, or skip-worktree bit is used.

CI job URL: not configured. Result: NOT RUN.

Parent on `develop` before this slice: `566bf826993bb7d783de6ea080bc0f4a9bc0d139`.

## What shipped

An organization administrator can create an immutable typed tag definition. An authorized service can assign, read, list, tombstone, and search that tag on an existing agent. A security administrator can create and change a governed restricted tag. A credential without `tags:governance` cannot change it. A credential without `tags:restricted:read` does not see it. `false` and `0` persist. Tag ETags are `"tag-vN"` and do not change the agent ETag.

`FAD_TAGS_ENABLED` defaults to false. The migration version is `20261021_001_typed_tags`. `@fad/sdk` is 0.3.0. The OpenAPI contract version is 1.2.0.

The new image is `fad-api:slice2`, id `sha256:71d6dcf27db2f73ae71c564e63bbde8993f36f584a02bece2703c02b5cd2db50`, Node v24.22.0, linux/arm64. The Slice 1 image `sha256:97f4db1dd59a83ba747b785f0c6334233c7e90dcbd2a31fd35983b0fa2394c60` stayed ready on the migrated database, read an existing agent, and returned 404 for a tag route. The assignment row remained.

Migration checksum stored once and matched the file bytes:

| Version | SHA-256 |
| --- | --- |
| `20261021_001_typed_tags` | `0d167c6c212b2487afa8c1ba6ad0b0a0cf873c1b2dc1297bd1f5c7b8d9d7d45c` |

## Commands

| Command | Result | Evidence |
| --- | --- | --- |
| `node --test --test-concurrency=1 tests/*.test.mjs` | PASS | 11 tests, 11 pass, 0 fail, duration 13871.545958 ms. Every matrix id C01–C08, D01–D13, A01–A17, S01–S13, R01–R12, and Q01–Q16 logged PASS. `test-evidence/slice2-tests.log`. |
| `node scripts/openapi-diff.mjs` | PASS | `ok` true, `breaking` empty. Every operation in parent `566bf826993bb7d783de6ea080bc0f4a9bc0d139` is deep-equal. The only new operations are the eight tag routes. Slice 0 package hash unchanged. `openapi-diff.json`. |
| Direct `fad_app` reads and grants | PASS | No `fad.org_id`: 0 rows. Insert without that setting failed (`42501`) and did not commit. `rolbypassrls` false. No delete grant on definitions, assignments, or history. `db-evidence/slice2-db.log`. |
| Failed migration and checksum mismatch | PASS | R12 in the suite. Prior rows stayed. The bad migration left no tag table and no checksum row. A changed tag file raised `MigrationChecksumError` and the stored checksum stayed. `migration-checksum.txt`. |
| Two API launches with tags enabled | PASS | Launch 1 assigned `false`. Launch 2 assigned `0`. Both kept `"tag-v1"`, left the agent ETag at `"agent-v1"`, found the agent by search, and denied a non-governance write with 403. `deployment-evidence/slice2-launch-1.log` and `deployment-evidence/slice2-launch-2.log`. |
| Separate Node.js consumer of `@fad/sdk` | PASS | `false` and `0` round-tripped. Search found the agent. Agent keys include `revision` and do not include `tags`. Denied put returned 403. `sdk-evidence/slice2-sdk.log`. |
| `FAD_TAGS_ENABLED=false` and previous image | PASS | Q15 and Q16. Flag off: agent read 200, tag create 404. Previous image ready, agent read 200, tag read 404. New image ready. Assignment count stayed 1. `deployment-evidence/slice2-rollback.log` and `deployment-evidence/image.txt`. |
| `docker build -f deploy/docker/Dockerfile -t fad-api:slice2 .` | PASS | Image id above. |
| `docker scout` | NOT RUN | No scanner session was run. |
| Whole-database `pg_dump` / `pg_restore` | NOT RUN | R12 covered a failed migration rollback. Q16 covered the previous image reading the migrated database. |
| Measured latency SLO | NOT RUN | Not in this release. |
| CI | NOT RUN | No workflow is configured. |
| Public npm publish | NOT RUN | Not approved. |

## Deployment

Run the existing migrator as the migration role before enabling tags. Then set `FAD_TAGS_ENABLED=true` on the API. Rollback is `FAD_TAGS_ENABLED=false` and the previous API image. Do not drop the tag tables. Do not run the package down script.

## Known limits

`GET /v1/agents/search` while tags are disabled still returns 400 `VALIDATION_ERROR`, because that path matches the Slice 1 agent read. `POST` returns 404. Search uses `agent_tag_match_idx` after table statistics exist. A fresh database with no `ANALYZE` can pick `agent_tag_by_agent_idx` until autovacuum analyzes the table. Slice 3 is not started.
