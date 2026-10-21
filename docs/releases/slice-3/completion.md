# Slice 3 completion

Commit message: Add secure local capability discovery to agent directory

The commit id is the output of `git --no-replace-objects rev-parse HEAD` after this commit. This file does not store that id. The parent commit is the `parent_commit` field in `contract-diff.json`. No replace ref, graft, or skip-worktree bit is used.

CI job URL: not configured. Result: NOT RUN.

## What shipped

An organization administrator can publish an immutable capability version, declare an HTTPS endpoint on an agent, and bind one published version to one endpoint of that same agent. `POST /v1/discovery/agents` returns same-organization agents that are active, have a live binding, and have an enabled endpoint of a requested protocol. Each hit sets `verification` to `self_declared`, `availability` to `not_checked`, and `invocation_authorization` to `not_evaluated`. Discovery does not mean the agent is healthy, trusted, or authorized to invoke.

`FAD_SLICE3_ENABLED` defaults to false. New scopes `capabilities:read`, `capabilities:write`, `endpoints:read`, and `endpoints:write` are not granted to credentials that already exist. The migration version is `20261022_001_capabilities_discovery`. `@fad/sdk` is 0.4.0. The OpenAPI contract version is 1.3.0. Endpoint and binding writes do not change the agent ETag or a tag ETag.

A credential with `tags:read` and without `tags:restricted:read` receives the same generic 403 for a restricted tag predicate and for a missing tag definition. The error body does not include the tag value, and the discovery query does not run. An endpoint URL whose input or serialized form contains `?` or `#`, including an empty query or fragment, is rejected with 422 and is not stored.

The new image is `fad-api:slice3`, id `sha256:dd669a8fdc8a0bde7e959a23aba21bffee3ad661dfe82cf401374bad4046f78b`, user `node` uid 1000. With the flag off, an agent read stayed 200 and a capability route stayed unavailable. The previous image stayed ready, read an existing agent, and returned 404 for a capability route. Capability rows remained.

Migration checksum stored once and matched the file bytes:

| Version | SHA-256 |
| --- | --- |
| `20261022_001_capabilities_discovery` | `318417c2914327049cf6a5700d190174bace51d9866c0a4f0f19f3fe24cff1e6` |

## Environment

Host macOS 26.2 arm64, Node v25.1.0. PostgreSQL 16 in container `fad-s0-pg`, published on `127.0.0.1:54329`. The suite used the workspace build for in-process routes and `fad-api:slice3` for the image checks. No CI runner was attached.

## Commands

| Command | Result | Evidence |
| --- | --- | --- |
| `node --test --test-concurrency=1 tests/*.test.mjs` | PASS | Exit 0. 12 tests, 12 pass, 0 fail, duration 22316.107 ms. Started 2026-10-21T07:36:51.087Z. Every P0 id logged PASS, including `P0-COVERAGE`, `AUTH-08`, `AUTH-18`, and `DUR-03`. `test-evidence/slice3-tests.log`. |
| `node scripts/openapi-diff.mjs` | PASS | `ok` true, `breaking` empty. Pre-existing operations are deep-equal to the parent contract. New operations are the twelve Slice 3 routes. `contract-diff.json`. |
| Direct `fad_app` reads, grants, and cross-org foreign keys | PASS | Owner `postgres`, `rolbypassrls` false, hidden rows 0, RLS and DDL `42501`, cross-org agent and catalog foreign keys `23503`. `sql-rls.txt`. |
| Failed migration inside one transaction | PASS | `DUR-06` in the suite. The abort table was absent and the bad checksum was absent. Existing capability rows remained. |
| Two API launches, journey A–K | PASS | Launch 1 organization A `e2498c63-e75b-4f64-9e83-5c22f3404235`. Agent create request `a7461e73-026a-489d-b0a0-97bb490a6e56`. Publish 201, replay 201, conflict 409, contract `e15ff099f78a9d90dcfc648302cfffc72e66862a149546f592709115ec87de2a`. Endpoint request `d264962a-cad2-4258-b3a8-a31bfa099722`, ETag `"endpoint-v1"`. Binding ETag `"cap-binding-v1"`. Discovery request `dfa502ad-0401-499f-a830-ca8eeda66816`, availability `not_checked`, authorization `not_evaluated`. Organization B foreign read 404 and discovery count 0. Recreate revision 5. Launch 2 discovery request `c4afb9d3-3b37-4a4d-ae57-8a777a772a9c` with the same assertions. `launch-1.json`, `launch-2.json`. |
| Separate Node.js consumer of `@fad/sdk` | PASS | Publish 201, discovery count 1, endpoint ETag `"endpoint-v1"`, binding ETag `"cap-binding-v1"`, availability `not_checked`, authorization `not_evaluated`. Hosts were only `127.0.0.1`. Legacy agent keys omit capabilities and endpoints. `sdk-consumer.json`. |
| `FAD_SLICE3_ENABLED=false`, restart, and previous image | PASS | `DEP-03`, `DUR-04`, `DUR-04b`, `DEP-01`, `DEP-04` in the suite. `rollback.log`. Restart kept endpoint ETag `"endpoint-v5"` at revision 5. |
| Declared endpoint network | PASS | Net guard log empty. No DNS or HTTP request was made to a declared host. `net-guard.txt`. |
| P1 `PERF-01`, `PERF-02`, `PERF-03` | NOT RUN | No published 100k-agent or 1M-binding dataset, and no hot-tenant harness, on this host. No latency number is claimed. `perf.txt`. |
| Full point-in-time restore | NOT RUN | `DUR-07` restored one organization's Slice 3 rows inside a transaction (`restored_capabilities=51` in `sql-rls.txt`). |
| CI | NOT RUN | No workflow is configured. |
| Public npm publish | NOT RUN | Not approved. |

## Deployment

Run the existing migrator as the migration role before enabling Slice 3. Then set `FAD_SLICE3_ENABLED=true` on the API. Rollback is `FAD_SLICE3_ENABLED=false` or the previous API image. Do not drop the new tables. There is no production down script.

## Known limits

Catalog order is lexical on the version text, not semver order. Live caps are 8 endpoints and 32 bindings per agent. A published schema is a declaration, not proof that the agent implements it. Cursor MAC reuse of the API-key pepper means a pepper rotation invalidates outstanding cursors. Slice 4 is not started.
