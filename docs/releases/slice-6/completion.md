# Slice 6 completion

This commit's parent is `27a3f2874e8fbaa256ac88ab982904ae2ee26cdd`. This blob does not store its own id. No replace ref, graft, or skip-worktree bit is used. `plans/` stays untracked. Slice 7 is not in this commit.

CI run ID: the successful Actions `pull_request` run whose headSha equals `git --no-replace-objects rev-parse HEAD`. This blob does not store the run id or the commit id. `npm test` is not this gate.

Release status: the 134 matrix rows are PASS. R19 is that Actions run. `kubectl apply` is not a pass.

Notes:

- Matrix counts: PASS 134, PARTIAL 0, NOT RUN 0. R19 is the successful Actions `pull_request` run whose headSha equals `git --no-replace-objects rev-parse HEAD`. This blob does not store the run id or the commit id. The table is `test-results/matrix.md`. The production TLS boot is recorded with the deployment rows. It passed at 2026-10-22T06:27:50Z on image `sha256:f3a44c87cf53cc184600db7dc07a0e348a6256740ff3839bc7d98f838082e3fc`.
- `kubectl apply` is not the Docker gate. R12 is that gate and it passed. At 2026-10-22T05:39:36Z `kubectl apply` reached no cluster. See `deployment-evidence/kubectl.md`. That result is not a pass.

The gate rerun executed malformed stored policy, pool exhaustion, a real multi-page cursor, cross-tenant and cross-caller cursor reuse, a side-database restore, and a 100-read p99 sample with decision and audit counts. Those results are in `test-results/slice6-gates.log`.

## What shipped

A shared enforcement point covers agent read, discovery, update, and suspend when `FAD_ENFORCEMENT_CODE_ENABLED` is `true` and the tenant mode is `enforce`. OFF is the default and keeps the previous response. SHADOW records `would_allow` or `would_deny` and keeps the previous response. ENFORCE requires a passing preflight, `acknowledge_default_deny`, the current ETag, and an idempotency key.

The four REST operations are `GET/PUT /v1/enforcement/config`, `POST /v1/enforcement/preflight`, and `GET /v1/enforcement/decisions/{decisionId}`. Four MCP tools call the same service. `@fad/sdk` 0.5.0 adds `client.enforcement`. `@fad/mcp-client` 0.2.0 keeps 14 enabled tool names.

`POST /v1/authorization/evaluate` stays `not_enforced`. Invocation is not enforced.

Published OpenAPI SHA-256: `f3f7a7f410136ace9edf7daa5173b75a77ff6288ef7a35563ad7ca62368ae7e4`. Info version `1.5.0`. Frozen Slice 5 operations stay deep-equal. Live count is 30 paths and 45 operations.

The tested image is `fad-api:slice6`, id `sha256:f3a44c87cf53cc184600db7dc07a0e348a6256740ff3839bc7d98f838082e3fc`, created `2026-10-21T23:12:41.848694143-07:00`, user `node`. It was built from this commit's runtime tree. It contains the fence-timeout fail-closed code, the row lock before the decision insert, and `pg_terminate_backend`. `FAD_ENFORCEMENT_CODE_ENABLED` defaults to false. It was not pushed to a registry. The previous id `sha256:e5861d49221dc9d4598c67e521f70720f3f6a50aba4ab388fe965eff907e2473` does not contain the fence-timeout fail-closed code. The earlier id `sha256:38d932df2039c17ed7a07b94e89e6f9de667416d9102ad4b792b845ca1c4f150` does not contain the row lock or the shutdown cancel.

A fence timeout returns 503 `DEPENDENCY_UNAVAILABLE` in OFF, SHADOW, and ENFORCE. The service does not read the mode without the fence and does not skip the policy check or the tag guard. D10-OFF passed at 2026-10-22T06:06:35.302Z. The tenant had no config row. A held advisory lock made GET and the department tag PUT return 503. The tag value stayed `finance`. The next GET was 200. The separate SDK called `getDecision` and recorded decision `532e487f-9169-414a-8988-7dbf01f9e00a`, mode `enforce`, outcome `allowed`, and ETag `"enforcement-v2"` at 2026-10-22T06:06:29.824Z. Command `node --test --test-concurrency=1 tests/slice6.test.mjs tests/slice6-clients.test.mjs`. Exit 0. Duration_ms 27039.283666. First line 2026-10-22T06:06:28.279Z. Last line 2026-10-22T06:06:54.297Z. Log `test-results/fence-sdk.log`. That local command is not Actions run 39735925781.

Migration checksum `20261021_006_policy_enforcement`: `ee3a5731d8d5723de0062287baef0bf37c3346092d9280ebb8693c91642951f1`.

## Environment

Host macOS arm64, Node v25.1.0. PostgreSQL 16 in container `fad-s0-pg`, published on `127.0.0.1:54329`. The suite used the workspace build. Image checks used `fad-api:slice6` and `fad-api:slice5` on Docker network `fad-s0`.

## Commands and checks

| Check | Result | Evidence |
| --- | --- | --- |
| `node --test --test-concurrency=1 tests/*.test.mjs` | PASS | 32 tests, 32 pass, 0 fail, duration_ms 92600.20125. First line 2026-10-22T03:18:59.846Z. Last line 2026-10-22T03:20:32.351Z. `test-results/npm-test.log`. |
| Frozen Slice 5 contract comparison | PASS | `tests/slice6-contract.test.mjs`. `api-contract-diff.md`. |
| OpenAPI diff script | PASS | `api-evidence/openapi-diff.json`. `ok` true. `breaking` empty. |
| Two-organization HTTP journey | PASS | `api-evidence/journey.md`. `api-evidence/pep-journey.log`. |
| MCP OAuth client on a second replica | PASS | `mcp-contract-diff.md`. Decision `98db2ee8-4790-41e1-82e1-b907edb5e163`. |
| Separate Node `@fad/sdk` project | PASS | `sdk-compatibility.md`. 2026-10-22T03:19:57.348Z. |
| Fresh database and upgraded database | PASS | `migration-evidence/fresh-and-upgrade.md`. |
| Catalog after the suite | RECORDED | `schema-and-rls.txt`. Query 2026-10-22T03:29:38Z. This file is a catalog read. It is not a production verification by itself. |
| Two image replicas, old image, database pause, audited OFF | PASS | `deployment-evidence/run.md`. |
| Production TLS boot on the tested image | PASS | 2026-10-22T06:27:45Z through 2026-10-22T06:27:50Z. Image `sha256:f3a44c87cf53cc184600db7dc07a0e348a6256740ff3839bc7d98f838082e3fc`. State `running 0`. Live 200, request `8db22478-4456-4958-a6c0-4154ae728436`. Ready 200, request `baaa791c-d03a-4cf9-918b-a38a606f9a9a`. `pg_stat_ssl` `fad-api-1`, ssl true, TLSv1.3, `TLS_AES_256_GCM_SHA384`. Cleartext TCP rejected. The API role was `fad_app`. `deployment-evidence/prod-tls-f3a44c87.log`. The 2026-10-22T05:34:55Z boot used the previous image. `DEPLOY-PROD-BOOT` against `fad-s0-pg` is a refusal, not this boot. |
| `kubectl apply` | not a Docker gate | 2026-10-22T05:39:36Z. Client v1.34.1. No context. `cluster-info` connection refused. `kind`, `minikube`, `k3d`, and `k3s` are absent. Apply did not create an object. `deployment-evidence/kubectl.md`. R12 stays the Docker check. |
| `node --test --test-concurrency=1 tests/slice6.test.mjs` | PASS | Exit 0. Start 2026-10-22T03:44:52Z. End 2026-10-22T03:45:14Z. Duration_ms 21785.249625. `test-results/slice6-gates.log`. |
| 100 sequential protected reads | MEASURED | p50 9.4 ms, p95 11.4 ms, p99 15.5 ms, max 20.7 ms. Decision growth 100. Policy-decision growth 100. Audit growth 0. `performance-evidence/r17.md`. |
| Side-database restore | PASS | `enforce` revision 9, 40 decisions, 9 config revisions, hidden count 0. `rollback-evidence/run.md`. |
| Malformed stored policy | PASS | 503 `DEPENDENCY_UNAVAILABLE`. Mode stayed `enforce`. `security-evidence/checks.md`. |
| Pool exhaustion | PASS | 503 at 5509 ms and 200 at 5531 ms. Mode stayed `enforce`. `security-evidence/checks.md`. |
| Real cursor tamper and reuse | PASS | Page 2 is 200. Tamper, organization B, and principal A2 are 400. `api-evidence/journey.md`. |
| `node --test --test-concurrency=1 tests/slice6-races.test.mjs` | PASS | Exit 0. Start 2026-10-22T04:56:11.814Z. End 2026-10-22T04:57:00.043Z. Duration_ms 49964.957417. Organization `bfcb246a-5ef4-4fe3-9f77-40b115977498`. `test-results/slice6-races.log`. |
| Deadlock `40P01` | PASS | Request `9ad5d6e1-a886-4a9c-a8a0-155dece906d4`. Status 503 at 1021 ms. `pg_stat_database.deadlocks` moved from 7 to 8. Postgres logged `process 4462 detected deadlock while waiting for ShareLock on transaction 63400 after 1001.485 ms`. Name and revision stayed unchanged. Mode stayed `enforce`. |
| Lock-order gate `node --test --test-concurrency=1 tests/slice6.test.mjs` | PASS | Exit 0. Start 2026-10-22T04:57:42.236Z. End 2026-10-22T04:58:03.846Z. Duration_ms 21815.990209. D17 at 2026-10-22T04:57:46.474Z. `test-results/slice6-gates-rerun.log`. |
| `node --test --test-concurrency=1 tests/slice6-deploy.test.mjs` on the previous image | PASS for the replica rollout | Exit 0. Start 2026-10-22T05:16:30.396Z. End 2026-10-22T05:16:41.042Z. Duration_ms 11238.407583. Image `sha256:e5861d49221dc9d4598c67e521f70720f3f6a50aba4ab388fe965eff907e2473`. `deployment-evidence/image-rerun.log`. That image does not contain the fence-timeout fail-closed code. The refusal in that log is not the live TLS boot. The live boot is the PASS row above. |
| P10, P25, T14 on that previous image | PASS | P10 request `3d44028b-268c-4d35-ba2a-c229fc5ec61c`. P25 request `3875a5a6-3a0f-4cbb-afff-8632637fbcff`. T14 request `02a797e7-63a8-4b14-928b-62322dca5a22`. |
| `node --test --test-concurrency=1 tests/slice6-deploy.test.mjs` on the tested image | PASS | Exit 0. Start 2026-10-22T06:26:47.550Z. End 2026-10-22T06:27:03.606Z. Duration_ms 16638.868167. Image `sha256:f3a44c87cf53cc184600db7dc07a0e348a6256740ff3839bc7d98f838082e3fc`. `deployment-evidence/image-rerun-f3a44c87.log`. DEPLOY-FENCE phrase exit 0 and `s6_skip_pep` exit 1 at 2026-10-22T06:26:48.658Z. DEPLOY-FENCE-OFF at 2026-10-22T06:26:55.788Z: hold=0, held=true, read=503, tag=503, value `high`, next read 200. OFF, SHADOW, and ENFORCE passed. A1 200 and A2 404. P25 request `b7cd95e5-905b-436f-a0ae-af85d200fdb2`. T14 request `8aa20a0a-7467-4fd5-b5ce-4156ed2fcd2e`. P10 request `9890e58a-a994-401b-9d90-32aaf8ed3cdf`. Old image 404 while mode stayed `enforce`. Database pause 503 `DEPENDENCY_UNAVAILABLE`. Audited OFF put 200. `DEPLOY-PROD-BOOT` exited 1 against `fad-s0-pg`. That line is a refusal check, not the live TLS pass above. An earlier run of this same image is `deployment-evidence/image-rebuild.log` at 2026-10-22T06:13:26.723Z. That image run is not Actions run 39735925781. |
| CI for this commit | PASS | R19 is the successful Actions `pull_request` run whose headSha equals `git --no-replace-objects rev-parse HEAD`. This blob does not store the run id or the commit id. `npm test` is not this gate. |

## Journey request ids

GET config: `30a6bacc-a843-489f-9b7d-a5eb5bbdc7f0`.

PUT ENFORCE: `ee58f55b-a668-4e99-8687-e2f88cfbd6dd`.

PUT OFF: `aa7b3277-a4d9-4682-99d6-e64bcbd2d0b2`.

MCP shadow decision: `98db2ee8-4790-41e1-82e1-b907edb5e163`.

Gate rerun GET config: `fe9ec9b8-95ff-4d3d-a614-abd6c473967c`.

Gate rerun PUT ENFORCE: `fd2e2486-0672-4271-b8ac-9a9f9c34eb54`.

Gate rerun PUT OFF: `b58aae22-b72f-403d-a888-ad643e3f0edf`.
