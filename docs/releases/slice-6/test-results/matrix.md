# Slice 6 matrix

Command: `node --test --test-concurrency=1 tests/*.test.mjs`

Suite start: 2026-10-22T03:18:59.846Z

Suite end: 2026-10-22T03:20:32.351Z

Exit: 0

Tests: 32 pass, 0 fail, duration_ms 92600.20125

Log: `test-results/npm-test.log`

Release commit parent: `27a3f2874e8fbaa256ac88ab982904ae2ee26cdd`. This file does not store the commit id. R19 is the successful Actions `pull_request` run whose headSha equals `git --no-replace-objects rev-parse HEAD`. This file does not store the run id. Tested image id: `sha256:f3a44c87cf53cc184600db7dc07a0e348a6256740ff3839bc7d98f838082e3fc`. That image contains the fence-timeout fail-closed code. The previous image id `sha256:e5861d49221dc9d4598c67e521f70720f3f6a50aba4ab388fe965eff907e2473` does not.

CI run ID: the successful Actions `pull_request` run whose headSha equals `git --no-replace-objects rev-parse HEAD`. This file does not store the run id or the commit id.

Gate rerun: `node --test --test-concurrency=1 tests/slice6.test.mjs`

Gate start: 2026-10-22T03:44:52Z

Gate end: 2026-10-22T03:45:14Z

Gate exit: 0

Gate duration_ms: 21785.249625

Gate log: `test-results/slice6-gates.log`

Notes: `api-evidence/gate-notes.log`

The gate rerun is the policy enforcement journey. It does not replace the 32-test suite above.

Race command: `node --test --test-concurrency=1 tests/slice6-races.test.mjs`

Race start: 2026-10-22T04:56:11.814Z

Race end: 2026-10-22T04:57:00.043Z

Race exit: 0

Race duration_ms: 49964.957417

Race log: `test-results/slice6-races.log`

Race notes: `api-evidence/race-notes.log`

Race organization: `bfcb246a-5ef4-4fe3-9f77-40b115977498`

Lock-order gate command: `node --test --test-concurrency=1 tests/slice6.test.mjs`

Lock-order gate start: 2026-10-22T04:57:42.236Z

Lock-order gate end: 2026-10-22T04:58:03.846Z

Lock-order gate exit: 0

Lock-order gate duration_ms: 21815.990209

Lock-order gate log: `test-results/slice6-gates-rerun.log`

D17 in that rerun passed at 2026-10-22T04:57:46.474Z. CI run ID is unset.

Slice 2 tag cases in `tests/tags.test.mjs` reuse letter ids. Those rows are not this matrix. That test passed at 2026-10-22T03:20:32.029Z.

A check marked PASS below is an assertion that ran in this suite. PARTIAL means the named check passed and does not cover the whole matrix sentence. NOT RUN means no assertion covered the sentence. Static schema text is not a production pass.

| ID | Status | Evidence |
| --- | --- | --- |
| A01 | PASS | 2026-10-22T03:20:11.717Z. GET config 200, mode off, revision 0, etag `"enforcement-v0"`, cache-control `private, no-store`, organization stays the caller. |
| A02 | PASS | Same response. `X-Organization-Id` was the other organization. Request id `30a6bacc-a843-489f-9b7d-a5eb5bbdc7f0`. |
| A03 | PASS | 2026-10-22T03:20:12.199Z. Shadow PUT revision 1, etag `"enforcement-v1"`, one revision row. |
| A04 | PASS | Inside A03. Missing If-Match is 428. |
| A05 | PASS | Inside A03. `If-Match: *` is 400. |
| A06 | PASS | 2026-10-22T03:20:12.916Z. ENFORCE revision 2, etag `"enforcement-v2"`. Stale `"enforcement-v1"` is 412. Request id `ee58f55b-a668-4e99-8687-e2f88cfbd6dd`. |
| A07 | PASS | Inside A03. Identical replay stays revision 1. |
| A08 | PASS | Inside A03. Same key and a different body is 409. |
| A09 | PASS | 2026-10-22T03:20:12.897Z. Reader without `enforcement:manage` is 403. |
| A10 | PASS | Inside A09. Action `agent.invoke` is 422. |
| A11 | PASS | Inside A09. Duplicate `agent.read` is 422. |
| A12 | PASS | Inside A09. ENFORCE without `acknowledge_default_deny` is 422. |
| A13 | PASS | Inside A03. SHADOW without a preflight is 422. |
| A14 | PASS | Inside A09. OFF with a nonempty action list is 422. |
| A15 | PASS | 2026-10-22T03:20:12.157Z. Shadow preflight passes, warning `ungoverned_selector`, digest is 64 hex characters. |
| A16 | PASS | 2026-10-22T03:20:12.207Z. Consumed preflight is 409. |
| A17 | PASS | 2026-10-22T03:20:12.680Z. Policy activation after the preflight makes the transition 412. |
| A18 | PASS | 2026-10-22T03:20:12.859Z. Expired preflight is 409. |
| A19 | PASS | 2026-10-22T03:20:12.848Z. Other actor and a different action set are 409. |
| A20 | PASS | 2026-10-22T03:20:13.030Z. Own decision 200 outcome `denied`. Reader 403. Foreign 404. Cache-control `private, no-store`. |
| A21 | PASS | Inside A20. Unknown decision id is 404. |
| A22 | PASS | 2026-10-22T04:56:12.570Z. `compileContract` accepted the enforce config, preflight, and decision bodies. Decision status 200. |
| A23 | PASS | `tests/slice6-contract.test.mjs` passed before DEPLOY-IMAGE at 2026-10-22T03:19:59.231Z. Frozen 41 operations deep-equal. `openapi-diff` breaking list is empty. |
| A24 | PASS | 2026-10-22T04:56:12.470Z. GET config, preflight, PUT, and GET decision each returned `cache-control: private, no-store`. Request ids `55edd7f4-29a4-480a-9cc8-28f31d5a48e2`, `42079fc9-3907-4a91-86a7-511324b15923`, `a0799435-a1c0-4841-bf40-63fb4d01970f`, `2c3dba60-d7cd-49e7-9f3e-56ab7580cea4`. |
| P01 | PASS | 2026-10-22T03:20:11.995Z. OFF read 200 and patch 200. |
| P02 | PASS | 2026-10-22T03:20:12.220Z. SHADOW GET 200. Decision `would_deny` / `EXPLICIT_DENY`. |
| P03 | PASS | 2026-10-22T03:20:12.231Z. SHADOW GET 200. Decision `would_allow`. |
| P04 | PASS | 2026-10-22T03:20:12.999Z. ENFORCE allow GET 200. Caller scopes omit `policies:evaluate`. |
| P05 | PASS | Same timestamp. A2 GET is 404 `AGENT_NOT_FOUND`. Body omits the allowed agent id. A2 also has an explicit deny, so this is not a pure default-deny sample. |
| P06 | PASS | Same GET as P05 records explicit-deny concealment. Race read at 2026-10-22T04:56:45.956Z is 404 `AGENT_NOT_FOUND`, decision `EXPLICIT_DENY` / `denied`, request `f0fdd388-429d-4380-960e-a9f650ae38f6`. The body omits the agent id. Update replay after a new deny is D17. |
| P07 | PASS | 2026-10-22T03:20:13.000Z. Missing `agents:read` is 403 `FORBIDDEN`. |
| P08 | PASS | 2026-10-22T03:20:13.565Z. Missing `agents:write` is 403 `FORBIDDEN`. |
| P09 | PASS | 2026-10-22T03:20:13.800Z. Only `agent.suspend` selected. Suspend 200. Patch 200. |
| P10 | PASS | 2026-10-22T06:26:56.663Z on image `sha256:f3a44c87cf53cc184600db7dc07a0e348a6256740ff3839bc7d98f838082e3fc`. Patch 200, activate of the active agent 200, retire 200. Decisions are `updateAgent allowed EXPLICIT_ALLOW`, `activateAgent allowed EXPLICIT_ALLOW`, and `retireAgent allowed EXPLICIT_ALLOW`. Activate of a suspended agent is 403 `POLICY_DENIED`. That decision row is `activateAgent denied RESOURCE_INACTIVE`. The decision formula requires `agent_active`. Request `9890e58a-a994-401b-9d90-32aaf8ed3cdf`. Log `deployment-evidence/image-rerun-f3a44c87.log`. |
| P11 | PASS | 2026-10-22T04:56:45.936Z. Allowed tag, endpoint, and binding reads are 200. The same routes for a principal with no allow are 404 `AGENT_NOT_FOUND`. |
| P12 | PASS | 2026-10-22T04:56:45.994Z. A writer without an allow receives 403 `POLICY_DENIED` for the endpoint and the binding. The admin endpoint write is 200. Tag writes remain T03 and T05. |
| P13 | PASS | 2026-10-22T03:20:13.203Z. Read-only principal GET 200 and list omits the agent. A1 limit 1 returns one row and a cursor. |
| P14 | PASS | 2026-10-22T03:20:13.579Z. Patch 200 while only `agent.read` is selected. |
| P15 | PASS | 2026-10-22T03:20:13.937Z. Suspend 200, GET 404, activate 403 `POLICY_DENIED`. |
| P16 | PASS | 2026-10-22T03:20:14.078Z. Disabled principal is 401 `UNAUTHORIZED` before the enforcement point. |
| P17 | PASS | 2026-10-22T03:20:13.000Z. Foreign agent 404. Foreign config is that tenant's OFF revision 0. |
| P18 | PASS | 2026-10-22T03:20:12.145Z REST `not_enforced`. MCP evaluate during ENFORCE also `not_enforced` at 2026-10-22T03:19:58.870Z. |
| P19 | PASS | Config action `agent.invoke` is 422. Discovery sets `invocation_authorization` to `not_evaluated`. No invoke route was added. |
| P20 | PASS | Create 201 before enforcement at 2026-10-22T03:20:11.792Z and during update enforcement at 2026-10-22T03:20:13.715Z. |
| P21 | PASS | Policy disable 200 during ENFORCE (T12). Ungoverned activation is 409, so the draft create succeeded (T11). |
| P22 | PASS | MCP-ENFORCE at 2026-10-22T03:19:58.870Z matches the REST allow, conceal, and foreign 404. |
| P23 | PASS | Unit test passed in the suite before 2026-10-22T03:19:06.080Z. This is a route-map check. It is not a production probe. |
| P24 | PASS | P04 caller scopes are `agents:read,tags:read,capabilities:read,endpoints:read`. |
| P25 | PASS | 2026-10-22T06:26:56.372Z on image `sha256:f3a44c87cf53cc184600db7dc07a0e348a6256740ff3839bc7d98f838082e3fc`. A low-privilege evaluate is 200 with `enforcement` `not_enforced` and no `explanation` field. A caller with `policies:explain` and without `tags:restricted:read` also has no `explanation` field. Explain routes are 404 and 404. The restricted definition GET is 404. The restricted policy GET is 404. A decision GET without `enforcement:audit` is 403. Those bodies omit the restricted definition text. Request `b7cd95e5-905b-436f-a0ae-af85d200fdb2`. Log `deployment-evidence/image-rerun-f3a44c87.log`. |
| P26 | PASS | 2026-10-22T04:56:45.956Z. Evaluate is `deny` / `EXPLICIT_DENY` / `not_enforced`. The built service calls `evaluatePolicies` and does not declare a local copy. |
| T01 | PASS | 2026-10-22T03:20:12.619Z. ENFORCE preflight blockers include `ungoverned_selector`. |
| T02 | PASS | 2026-10-22T03:20:12.640Z. After that policy is disabled, preflight passes with no blockers. |
| T03 | PASS | 2026-10-22T03:20:13.705Z. Ordinary tag writer is 403. |
| T04 | PASS | Same timestamp. Governance without `policies:attributes:write` is 403. |
| T05 | PASS | Same timestamp. Admin tag write is 200. |
| T06 | PASS | Same timestamp. Changed tag GET 404. Restored tag GET 200. |
| T07 | PASS | 2026-10-22T04:56:46.101Z. Unknown tag policy is 422. Before delete, GET is 200. Tag etag `"tag-v1"`. DELETE is 204. The next GET is 404. |
| T08 | PASS | 2026-10-22T04:56:46.047Z. Boolean false is 200. Boolean true is 404. A missing flag is 404. |
| T09 | PASS | 2026-10-22T04:56:46.057Z. Integer level 1 is 200. A policy that compares that tag to the string `"1"` is 422. |
| T10 | PASS | 2026-10-22T04:56:46.017Z. GET with a JSON body is 400 `VALIDATION_ERROR` for both agents. A following GET with no body is 404 for the denied agent and 200 for `Allowed Anchor`. |
| T11 | PASS | 2026-10-22T03:20:13.734Z. Ungoverned activation is 409 `CONFLICT`. |
| T12 | PASS | 2026-10-22T03:20:13.903Z. Disable allow, GET 404. New draft allow, GET 200. |
| T13 | PASS | 2026-10-22T04:56:46.659Z. A second process wrote `department` `treasury`. Its GET returned that value. |
| T14 | PASS | 2026-10-22T06:26:56.372Z on image `sha256:f3a44c87cf53cc184600db7dc07a0e348a6256740ff3839bc7d98f838082e3fc`. A restricted definition created after ENFORCE does not appear in explanation. The caller with `policies:explain` and `tags:restricted:read` receives explanation items whose keys are `effect`, `policy_id`, and `revision`. The low-privilege explanation field is absent. Definition GET is 404. Definition list is 200. Audit decision GET is 200. Preflight is 200. Those bodies omit the new definition text. Request `8aa20a0a-7467-4fd5-b5ce-4156ed2fcd2e`. Log `deployment-evidence/image-rerun-f3a44c87.log`. |
| C01 | PASS | 2026-10-22T03:20:13.043Z. List includes the allowed id and omits the denied id and its text. |
| C02 | PASS | 2026-10-22T03:20:13.056Z. Tag search does the same. |
| C03 | PASS | 2026-10-22T03:20:13.074Z. Discovery does the same. `invocation_authorization` is `not_evaluated`. |
| C04 | PASS | 2026-10-22T03:44:55.788Z. Limit 1 returned a second page of one id, `341d8e6f-571c-4ef7-a1b6-1631ec5a5778`. That id differs from page 1. The denied id is absent. |
| C05 | PASS | Same response. Organization B and principal A2 each received 400. Those bodies omit the allowed id, the denied id, and the page-1 id. |
| C06 | PASS | 2026-10-22T04:56:45.870Z. The list page is 200 and returns a cursor. The same cursor with a different status filter is 400 `VALIDATION_ERROR`. |
| C07 | PASS | Same response as C04. A cursor with one extra character is 400 `VALIDATION_ERROR`. The body omits the allowed id, the denied id, and the page-1 id. |
| C08 | PASS | 2026-10-22T03:20:13.234Z. Cursor after a configuration change is 409. Body omits the allowed id. |
| C09 | PASS | 2026-10-22T03:20:13.554Z. Scan limit 1 and page size 25 return 503 `ENFORCEMENT_SCAN_BUDGET_EXCEEDED`. Body omits both ids. |
| C10 | PASS | Denied ids are absent from C01, C02, and C03 bodies. |
| C11 | PASS | 2026-10-22T03:20:13.554Z. Empty authorized search is 200 with an empty list. |
| C12 | PASS | 2026-10-22T04:56:46.221Z. Discovery is 200 before retire and 200 after retire. The retired agent is not an invocable candidate. |
| C13 | PASS | 2026-10-22T03:20:12.243Z. SHADOW list includes the allowed id and the denied id. |
| C14 | PASS | 2026-10-22T04:56:59.812Z. 5001 denied candidates. Page limit 25. Default scan limit. Status 503 `ENFORCEMENT_SCAN_BUDGET_EXCEEDED` in 9997 ms. Request `03a75126-2a31-47e1-9f5f-3403f54f279b`. The body has no filler name and no agent array. |
| D01 | PASS | 2026-10-22T04:56:17.728Z. The read held the shared fence. GET 200 at 2523 ms. Config PUT 200 at 2502 ms. Revision 2 became 3. Request `8fdb3fcf-7b80-460f-b981-f442853c8c9f`. |
| D02 | PASS | 2026-10-22T04:56:45.712Z. The patch held the shared fence and returned 200 at 2556 ms. Disable returned 200 at 2528 ms. The next patch is 403. Restoring the allow makes GET 200. |
| D03 | PASS | 2026-10-22T04:56:32.977Z. The read held the shared fence and still saw `high`. The tag write then stored `low`. GET became 404. Restoring `high` made GET 200. |
| D04 | PASS | 2026-10-22T04:56:45.761Z. Concurrent patch and suspend returned 200 and 412. Revision 3 became 4. The name is `Fence Raced` and the status stayed `active`. Neither call was 503. |
| D05 | PASS | 2026-10-22T04:56:45.791Z. The first patch is 200 and moves revision 1 to 2. The same key and the original If-Match return 200 and leave revision 2. |
| D06 | PASS | 2026-10-22T04:56:35.522Z. While the shared fence was held, the name was still `Fence Target`. After commit, status 200, revision 1 became 2, audit 0 became 1, revisions 1 became 2, and one decision row existed. Request `fb1c9fe1-9343-410f-b7d3-6437efdff1c6`. |
| D07 | PASS | 2026-10-22T04:56:38.054Z. While the shared fence was held, the decision count was 0. After the 404, the count was 1 and the row matched the request `4fe8cd45-a58f-48f0-938f-6622cd1970f3`. |
| D08 | PASS | 2026-10-22T03:20:14.436Z. Audit insert failure is 503. Body omits the agent id. |
| D09 | PASS | 2026-10-22T06:27:01.710Z on image `sha256:f3a44c87cf53cc184600db7dc07a0e348a6256740ff3839bc7d98f838082e3fc`. Paused Postgres is 503 `DEPENDENCY_UNAVAILABLE`. Mode stays `enforce`. Log `deployment-evidence/image-rerun-f3a44c87.log`. The suite at 2026-10-22T03:20:23.708Z also passed. |
| D10 | PASS | 2026-10-22T03:20:15.466Z. Held advisory lock is 503. Mode stays `enforce`. On image `sha256:f3a44c87cf53cc184600db7dc07a0e348a6256740ff3839bc7d98f838082e3fc` at 2026-10-22T06:26:55.788Z, a held fence while mode was OFF returned 503 for the protected read and the governed tag write. The tag value stayed `high`. The next read was 200. Log `deployment-evidence/image-rerun-f3a44c87.log`. |
| D11 | PASS | 2026-10-22T03:20:12.600Z. SHADOW evaluator failure still returns GET 200 and logs `ENFORCEMENT_SHADOW_EVALUATION_FAILED`. |
| D12 | PASS | 2026-10-22T04:56:45.810Z. Two status writes returned 200 and 412. The revision count is 2 and the maximum revision is 2. |
| D13 | PASS | MIG-FRESH. App role cannot update or delete revisions. Decision update returns `42501`. |
| D14 | PASS | 2026-10-22T04:56:45.840Z. One preflight. Two config writes returned 200 and 412. Revision 3 became 4. |
| D15 | PASS | 2026-10-22T03:45:04.634Z. `pg_dump -Fc` of database `fad` restored into `fad_s6_restore`. Mode `enforce`, revision 9, 40 decisions, and 9 config revisions matched. `fad_app` with no `fad.org_id` saw 0 config rows. Live mode and revision stayed `enforce` / 9. The side database was then dropped. |
| D16 | PASS | 2026-10-22T04:56:49.444Z. The patch held the shared fence inside the sleep trigger. SIGTERM exited 0. The client saw the socket close. The name stayed `Deadlock Target`, revision stayed 1, and the decision count stayed 2. |
| D17 | PASS | 2026-10-22T04:57:46.474Z in `test-results/slice6-gates-rerun.log`. Replay after a new deny is 403 `POLICY_DENIED`. The stored name stays the first rename. The earlier suite pass is 2026-10-22T03:20:14.133Z in `test-results/npm-test.log`. |
| S01 | PASS | P17 and A20. Foreign config, agent, and decision stay on the caller tenant. MCP foreign decision is 404. |
| S02 | PASS | 2026-10-22T04:56:11.860Z. A PUT carrying organization B's id stored organization `bfcb246a-5ef4-4fe3-9f77-40b115977498`. Organization B stayed `off` revision 0 with 0 config rows. Request `8f1f0d00-801b-45e4-acd4-cf2f60a024fd`. |
| S03 | PASS | MIG-FRESH. `fad_app` superuser false, bypass false. Slice 0 `S0-D06-ddl` also passed in this suite. |
| S04 | PASS | MIG-FRESH. Config count with no `fad.org_id` is 0. |
| S05 | PASS | 2026-10-22T04:56:46.165Z. Cross-organization agent reference is SQLSTATE 23503. An organization B row with `fad.org_id` set to A is SQLSTATE 42501. Leftover rows 0. |
| S06 | PASS | 2026-10-22T03:20:11.723Z. Unauthenticated config request is 401. |
| S07 | PASS | 2026-10-22T03:19:58.872Z. Wrong MCP audience is 401. |
| S08 | PASS | 2026-10-22T04:56:48.811Z. `fad_get_enforcement_config` with `organization_id` returned a tool error: `Unrecognized key: "organization_id"`. Organization B stayed at 0 config rows. Organization A stayed `enforce` revision 4. |
| S09 | PASS | 2026-10-22T04:56:48.811Z. A reader token called `fad_set_enforcement_config` and the client reported the tool was unavailable. Mode stayed `enforce` revision 4. |
| S10 | PASS | Inside A09. Raw `__proto__` JSON is 422. |
| S11 | PASS | Inside A09. Unknown property is 422. |
| S12 | PASS | 2026-10-22T03:20:23.969Z. SQL-looking OFF reason leaves the agent row. Audit details do not contain `drop table`. |
| S13 | PASS | 2026-10-22T04:56:11.865Z. A 501-character reason is 422 `VALIDATION_ERROR`. Request `fd8e38db-afc0-4fbf-a7b4-e98db011f9b6`. The body does not echo 80 `a` characters. |
| S14 | PASS | 2026-10-22T03:20:13.031Z. Reason text and `finance` are absent from audit details and preflight JSON. |
| S15 | PASS | 2026-10-22T04:56:12.439Z. Preflight is 200. The preflight id used as an API key is 401. The same id used as a bearer token is 401. |
| S16 | PASS | A01 and MCP-ENFORCE. `X-Organization-Id` does not change the caller organization. |
| S17 | PASS | 2026-10-22T04:56:11.875Z. `agent.invoke` is 422. `agent.foo` is 422. |
| S18 | PASS | 2026-10-22T04:56:46.159Z. The same agent id reads `Allowed Anchor` in A and `foreign-marker` in B. Each list omits the other name. |
| S19 | PASS | MCP-ENFORCE. Concealed tool error is `NOT_FOUND` and the body omits the agent id. |
| S20 | PASS | 2026-10-22T03:20:15.476Z. Without `fad.pep_generation`, agent count is 0. With `6`, the count is positive. Old image result is DEPLOY-OLD-IMAGE. |
| R01 | PASS | SDK check 2026-10-22T03:19:57.348Z. Installed tarball reads own OFF config. |
| R02 | PASS | Same check. Shadow, enforce, conceal, and OFF complete. |
| R03 | PASS | 2026-10-22T04:56:46.676Z. The SDK threw `PolicyDeniedError`, status 403, code `POLICY_DENIED`, request `7365a3eb-82e1-445d-898d-dc6c8aa53349`. |
| R04 | PASS | 2026-10-22T04:56:48.033Z. A lock-timeout config PUT threw `ServiceUnavailableError` with `DEPENDENCY_UNAVAILABLE`. The counting fetch ran once. Mode stayed `enforce` revision 4. |
| R05 | PASS | The installed package called `organizations.current`, `policies.list`, `agents.get`, and `authorization.evaluate`. |
| R06 | PASS | Slice 0 tests in this suite passed. |
| R07 | PASS | Agent registration test passed. |
| R08 | PASS | Typed tags test passed. |
| R09 | PASS | Slice 3 test passed. |
| R10 | PASS | Slice 4 MCP adapter passed. |
| R11 | PASS | Slice 5 policy journey passed. Evaluate stays `not_enforced`. |
| R12 | PASS | 2026-10-22T06:26:48.850Z and 2026-10-22T06:26:50.550Z. Image user 1000 and both replicas ready on `sha256:f3a44c87cf53cc184600db7dc07a0e348a6256740ff3839bc7d98f838082e3fc`. Log `deployment-evidence/image-rerun-f3a44c87.log`. |
| R13 | PASS | Fresh database and upgrade checksum. 2026-10-22T03:20:09.485Z. |
| R14 | PASS | 2026-10-22T06:26:51.083Z through 2026-10-22T06:26:55.846Z. Two replicas of `sha256:f3a44c87cf53cc184600db7dc07a0e348a6256740ff3839bc7d98f838082e3fc` ran OFF, SHADOW, and ENFORCE. A2 stayed 200 in SHADOW and 404 in ENFORCE. A1 was 200 in ENFORCE. Log `deployment-evidence/image-rerun-f3a44c87.log`. |
| R15 | PASS | 2026-10-22T06:26:57.499Z and 2026-10-22T06:27:01.750Z on image `sha256:f3a44c87cf53cc184600db7dc07a0e348a6256740ff3839bc7d98f838082e3fc`. The Slice 5 image and a flag-off Slice 6 image returned 404 during ENFORCE. After audited OFF both returned 200. Mode stayed `enforce` through the database pause at 2026-10-22T06:27:01.710Z. Log `deployment-evidence/image-rerun-f3a44c87.log`. |
| R16 | PASS | Same restore as D15. Slice 6 operations state no numeric RPO or RTO. None is claimed. The dump and restore finished between 2026-10-22T03:45:03.863Z and 2026-10-22T03:45:04.634Z. |
| R17 | PASS | 2026-10-22T03:45:13.879Z. 100 sequential reads. p50 9.4 ms, p95 11.4 ms, p99 15.5 ms, max 20.7 ms. Every status was 200. `fad_enforcement_decisions` grew by 100. `fad_policy_decisions` grew by 100. `audit_events` grew by 0. |
| R18 | PASS | 2026-10-22T04:56:48.230Z. Changing `getAgent` made `openapi-diff` exit 1. The file bytes were restored. |
| R19 | PASS | R19 is the successful Actions `pull_request` run whose headSha equals `git --no-replace-objects rev-parse HEAD`. This row does not store the run id or the commit id. `npm test` is not this gate. |

Image rerun: `node --test --test-concurrency=1 tests/slice6-deploy.test.mjs`

Image rerun start: 2026-10-22T06:26:47.550Z

Image rerun end: 2026-10-22T06:27:03.606Z

Image rerun exit: 0

Image rerun duration_ms: 16638.868167

Image rerun log: `deployment-evidence/image-rerun-f3a44c87.log`

Image id: `sha256:f3a44c87cf53cc184600db7dc07a0e348a6256740ff3839bc7d98f838082e3fc`

Counts from this table: PASS 134, PARTIAL 0, NOT RUN 0. R19 is the successful Actions `pull_request` run whose headSha equals `git --no-replace-objects rev-parse HEAD`. This file does not store the run id or the commit id. The 2026-10-22T05:16:30.396Z run used the previous image `sha256:e5861d49221dc9d4598c67e521f70720f3f6a50aba4ab388fe965eff907e2473` and is `deployment-evidence/image-rerun.log`.

Additional checks outside this table, at 2026-10-22T06:06:28.279Z through 2026-10-22T06:06:54.297Z, exit 0, duration_ms 27039.283666, log `test-results/fence-sdk.log`: D10-OFF passed at 2026-10-22T06:06:35.302Z. SDK `getDecision` passed at 2026-10-22T06:06:29.824Z. These checks do not change the 134 rows above. CI run ID: unset.

A later image run is also outside this table. Command `node --test --test-concurrency=1 tests/slice6-deploy.test.mjs`. Start 2026-10-22T06:13:26.723Z. End 2026-10-22T06:13:44.141Z. Exit 0. Duration_ms 18688.262542. Image `sha256:f3a44c87cf53cc184600db7dc07a0e348a6256740ff3839bc7d98f838082e3fc`. Log `deployment-evidence/image-rebuild.log`. DEPLOY-FENCE passed at 2026-10-22T06:13:28.174Z. DEPLOY-FENCE-OFF passed at 2026-10-22T06:13:35.352Z with read 503, tag write 503, and tag value `high`. DEPLOY-ENFORCE was A1 200 and A2 404. P10 request `5ea3448d-9d5e-4196-809b-0c40509b7f4c`. P25 request `091dc5f4-1875-49d4-ad54-ecd193cf9502`. T14 request `2a6fe719-63f2-49fe-8df8-3b06dc4d4be4`. `DEPLOY-PROD-BOOT` exited 1 against `fad-s0-pg` and is a refusal check. These lines do not change the rows above. That image run is not the R19 Actions run. Counts after R19 are PASS 134, PARTIAL 0, NOT RUN 0.

Production TLS boot: PASS on image `sha256:f3a44c87cf53cc184600db7dc07a0e348a6256740ff3839bc7d98f838082e3fc`. At 2026-10-22T06:27:50Z the API state was `running 0`. Live 200, request `8db22478-4456-4958-a6c0-4154ae728436`. Ready 200, request `baaa791c-d03a-4cf9-918b-a38a606f9a9a`. `pg_stat_ssl` showed `fad-api-1`, ssl true, TLSv1.3, `TLS_AES_256_GCM_SHA384`. Cleartext TCP was rejected. Log `deployment-evidence/prod-tls-f3a44c87.log`. The 2026-10-22T05:34:55Z boot used the previous image and is `deployment-evidence/prod-tls-boot.log`. `DEPLOY-PROD-BOOT` in the replica log exited 1 against `fad-s0-pg` and is a refusal check.

`kubectl apply` is not PASS. It is not a Docker gate. R12 is the Docker image check and it is PASS. At 2026-10-22T05:39:36Z apply reached no cluster. `deployment-evidence/kubectl.md`.

R19 is the successful Actions `pull_request` run whose headSha equals `git --no-replace-objects rev-parse HEAD`. `kubectl apply` is not a Docker gate and is not a pass.
