# Slice 4 completion

Commit message: Add secure MCP access to the agent directory

The commit id is the output of `git --no-replace-objects rev-parse HEAD` after this commit. This file does not store that id. The parent commit is the develop tip recorded in `goal.md`. No replace ref, graft, or skip-worktree bit is used.

`contract-diff.json` field `parent_commit` is the OpenAPI comparison base already used by `scripts/openapi-diff.mjs`. It is not the git parent of this commit.

CI job URL: not configured. Result: NOT RUN.

## What shipped

An internal client can call `POST /mcp` with `Authorization: Bearer` and a validated OAuth access token. A JSON-RPC array is rejected after authentication and before the rate limit. Duplicate object keys are rejected after JSON escape decoding, including `\uXXXX`. A missing bearer on a batch stays 401. The service publishes `GET /.well-known/oauth-protected-resource/mcp`. An unauthenticated POST returns 401 with a `WWW-Authenticate` challenge that names that metadata. Protocol `2026-07-28` supports `server/discover`, `tools/list`, and `tools/call`. Protocol `2025-11-25` supports stateless `initialize` and then `tools/list`. `GET` and `DELETE /mcp` return 405 and create no session.

The enabled tools are `fad_list_agents`, `fad_get_agent`, `fad_register_agent`, `fad_update_agent`, `fad_suspend_agent`, `fad_activate_agent`, `fad_list_agent_tags`, `fad_put_agent_tag`, `fad_search_agents_by_tags`, `fad_list_capabilities`, `fad_publish_capability`, `fad_put_endpoint`, `fad_put_binding`, and `fad_discover_agents`. `tools/list` returns only the tools the effective scopes allow, in that order. The other twelve catalog names are not registered. Effective scopes are the intersection of the token scopes and the binding scopes. Each call checks scopes again, including before an idempotency replay.

Every enabled write uses the existing organization service, audit row, idempotency identity, and revision check. The caller supplies `idempotency_key`. The JSON-RPC id is not that key. The same record is readable through unchanged `/v1` and unchanged `@fad/sdk` 0.4.0. Discovery stays local: `verification` `self_declared`, `availability` `not_checked`, `invocation_authorization` `not_evaluated`.

`FAD_MCP_ENABLED` accepts only the exact string `true`. The default is false. With the flag off, `/mcp` is 404 and `/v1` is unchanged. With the flag on and no issuer configuration, the process stays up, `/health/live` stays ok, and `/health/ready` and `/mcp` return 503. The service does not issue tokens. The runtime role cannot insert a binding. `X-FAD-API-Key` still authenticates `/v1` and is not accepted on `/mcp`.

The applied migration is `20261023_001_mcp_identity_bindings`. The package name `20261021_004_mcp_identity_bindings` was not used, because that name sorts before the shipped Slice 3 migration. There is no production down script. File SHA-256: `61f9d03c1bee2fbac1f97d6d845467b3f58667fae5957ac8fb71c2207ecbeec5`. The stored checksum matched the file.

The OpenAPI contract version is 1.4.0. Published SHA-256: `6ad489f43c0c043585e0ddff7181491a74118af06f82a93a7e620dc3b60f7ecc`. Preexisting operations stay deep-equal to the comparison base. The document changes are `info` and `tags`. The optional client is `@fad/mcp-client` 0.1.0.

The tested image is `fad-api:slice4`, id `sha256:2b7d3fc26c60b34a04827251d949a0e761c4dd0d58c9117c06643a569384c6ac`, user `node` uid 1000. A read-only container was ready. A whole-line PEM scan of the image found no private-key block. Application source in the image does not contain a PKCS#8 header. The `jose` package checks that header inside a type test. That source line is not a key.

## Environment

Host macOS 26.2 arm64, Node v25.1.0. PostgreSQL 16 in container `fad-s0-pg`, published on `127.0.0.1:54329`. The suite used the workspace build for the host API and `fad-api:slice4` for the three replicas, the read-only container, and the secret scan. Rollback used the existing `fad-api:slice3` image. No CI runner was attached.

## Commands

| Command | Result | Evidence |
| --- | --- | --- |
| `node --test --test-concurrency=1 tests/slice4.test.mjs` inside `npm test` | PASS | Exit 0 as part of the full suite. 117 matrix ids plus `COMP-08b`, `PROTO-BATCH`, and `PROTO-ESCAPE`. `test-results/*.json`. `test-results/index.json` count 120, missing empty. |
| `npm test` (`tests/*.test.mjs`) | PASS | 13 tests, 13 pass, 0 fail, duration 48479.692333 ms. First assertion 2026-10-21T19:00:06.234Z. Slice 4 duration 22231.128334 ms. `test-results/regression.log`. |
| `node scripts/openapi-diff.mjs` | PASS | `ok` true, `breaking` empty. `contract-diff.json`. |
| Two API launches, journey A–I | PASS | Both launches recorded steps A through I. `mcp-evidence/launch-1.json`. |
| Independent Node.js consumer of `@fad/mcp-client` | PASS | Six read tools, the known agent id, write denied as `FadMcpProtocolError`. `sdk-evidence/consumer.json`. |
| Modern and legacy official clients | PASS | `SDK-02`, `SDK-03`. |
| Three replicas and binding disable | PASS | `SEC-13`: list 200, then 401, 401, 401, REST 200. |
| Flag off and unconfigured MCP | PASS | `OPS-05` MCP 404 and agent 200. `OPS-06` live 200, ready 503, MCP 503. |
| Previous image on the migrated database | PASS | `OPS-02` ready 200, agent 200, table `mcp_principal_bindings` kept. `deployment-evidence/rollback.txt`. |
| Backup and restore | PASS | `OPS-08` restored_bindings=106. The restore database was dropped. |
| Database outage | PASS | `SEC-12` during 503, live 200 after PostgreSQL returned. |
| `fad_app` cross-tenant read | PASS | Organization setting null. Visible agents 0. `security-evidence/rls.log`. |
| Declared endpoint network | PASS | Net guard log empty. `security-evidence/net-guard.txt`. |
| Six concurrent REST reads | MEASURED | `OPS-07` measured_ms=26, concurrency 6, darwin, Node v25.1.0, six statuses 200. This is the elapsed time of that check. It is not a capacity target. `deployment-evidence/load.json`. |
| CI | NOT RUN | No workflow is configured. |
| Public npm publish | NOT RUN | Not approved. |

## Deployment

Run the existing migrator as the migration role before enabling MCP. Then set `FAD_MCP_ENABLED=true` and set `FAD_MCP_RESOURCE_URI`, `FAD_MCP_EXPECTED_AUDIENCE` to that same URI, `FAD_MCP_AUTH_ISSUERS`, and `FAD_HTTP_ALLOWED_HOSTS`. Bind each principal with `fad-admin mcp bind`. Rollback is `FAD_MCP_ENABLED=false` or the previous API image. Do not drop `mcp_principal_bindings`.

## Known limits

JWKS responses are cached per process for the configured cooldown. A binding change is read from PostgreSQL on every request. The per-organization concurrency counter is local to one process. Catalog order for capabilities stays lexical. Discovery does not probe an endpoint and does not authorize invocation. Slice 5 is not started.
