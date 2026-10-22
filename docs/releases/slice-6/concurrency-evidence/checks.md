# Concurrency evidence

Command: `node --test --test-concurrency=1 tests/*.test.mjs`

Exit: 0. CI run ID: unset.

| Check | Time | Result | Observation |
| --- | --- | --- | --- |
| A03 replay | 2026-10-22T03:20:12.199Z | PASS | One configuration revision after the identical replay. |
| A08 | same | PASS | Same idempotency key and a different body is 409. |
| D08 | 2026-10-22T03:20:14.436Z | PASS | Audit failure returns 503 and does not disclose the agent. |
| D09 | 2026-10-22T03:20:23.708Z | PASS | `docker pause fad-s0-pg` during GET. 503 `DEPENDENCY_UNAVAILABLE`. Mode stays `enforce`. |
| D10 | 2026-10-22T03:20:15.466Z | PASS | Superuser holds `pg_advisory_xact_lock(6816, fad_s6_enforcement_key(org))`. GET is 503. Mode stays `enforce`. |
| D11 | 2026-10-22T03:20:12.600Z | PASS | SHADOW evaluation failure keeps GET 200. |
| D17 | 2026-10-22T03:20:14.133Z | PASS | After a new deny, the old idempotency key does not replay the rename. Status 403 `POLICY_DENIED`. |
| DEPLOY-OUTAGE | 2026-10-22T03:20:06.934Z | PASS | Second replica path. Paused database. Mode stays `enforce`. |
| POOL | 2026-10-22T03:45:03.863Z | PASS | Gate rerun. Pool max 1. Exclusive fence held. Checkout 503 at 5509 ms. The held request returned 200 at 5531 ms after commit. Mode stays `enforce`. |
| D15 | 2026-10-22T03:45:04.634Z | PASS | Side database `fad_s6_restore` kept mode `enforce`, revision 9, 40 decisions, and 9 config revisions. |

The POOL and D15 rows are from `node --test --test-concurrency=1 tests/slice6.test.mjs`, exit 0, log `test-results/slice6-gates.log`.

Race command: `node --test --test-concurrency=1 tests/slice6-races.test.mjs`

Exit: 0. Start 2026-10-22T04:56:11.814Z. End 2026-10-22T04:57:00.043Z. Duration_ms 49964.957417. Log `test-results/slice6-races.log`. Organization `bfcb246a-5ef4-4fe3-9f77-40b115977498`. CI run ID: unset.

| Check | Time | Result | Observation |
| --- | --- | --- | --- |
| D01 | 2026-10-22T04:56:17.728Z | PASS | Shared fence held. GET 200 at 2523 ms. Config PUT 200 at 2502 ms. Revision 2 became 3. Request `8fdb3fcf-7b80-460f-b981-f442853c8c9f`. |
| D02 | 2026-10-22T04:56:45.712Z | PASS | Patch 200 at 2556 ms while the fence was held. Disable 200 at 2528 ms. The next patch is 403. |
| D03 | 2026-10-22T04:56:32.977Z | PASS | The in-flight read still saw tag `high`. After the write, GET is 404. Restoring `high` makes GET 200. |
| D04 | 2026-10-22T04:56:45.761Z | PASS | Patch and suspend returned 200 and 412. Revision 3 became 4. No 503. |
| D05 | 2026-10-22T04:56:45.791Z | PASS | Replay with the original If-Match stays revision 2. |
| D06 | 2026-10-22T04:56:35.522Z | PASS | Name unchanged while the fence was held. After commit, revision, audit, config revision, and one decision row advanced together. Request `fb1c9fe1-9343-410f-b7d3-6437efdff1c6`. |
| D07 | 2026-10-22T04:56:38.054Z | PASS | Decision count was 0 while the fence was held and 1 after the 404. Request `4fe8cd45-a58f-48f0-938f-6622cd1970f3`. |
| D12 | 2026-10-22T04:56:45.810Z | PASS | Two policy status writes returned 200 and 412. Maximum revision 2. |
| D14 | 2026-10-22T04:56:45.840Z | PASS | Two consumers of one preflight returned 200 and 412. Revision 3 became 4. |
| D16 | 2026-10-22T04:56:49.444Z | PASS | SIGTERM during the open transaction exited 0. The client saw the socket close. Name, revision, and decision count stayed unchanged. |
| Deadlock | 2026-10-22T04:56:15.148Z | PASS | PATCH 503 at 1021 ms. `pg_stat_database.deadlocks` moved from 7 to 8. Request `9ad5d6e1-a886-4a9c-a8a0-155dece906d4`. Postgres logged `process 4462 detected deadlock while waiting for ShareLock on transaction 63400 after 1001.485 ms`. Name and revision stayed unchanged. Mode stayed `enforce`. |

D10 remains a held lock during ENFORCE. The deadlock row is the separate `40P01` cycle. The lock-order gate rerun passed D17 at 2026-10-22T04:57:46.474Z. Log `test-results/slice6-gates-rerun.log`. Exit 0.

D10-OFF passed at 2026-10-22T06:06:35.302Z. The tenant had no enforcement config row. A superuser transaction held `pg_advisory_xact_lock(6816, fad_s6_enforcement_key(org))`. GET and the department tag PUT both returned 503 `DEPENDENCY_UNAVAILABLE`. The tag value stayed `finance`. After rollback, GET returned 200. Command `node --test --test-concurrency=1 tests/slice6.test.mjs tests/slice6-clients.test.mjs`. Exit 0. Duration_ms 27039.283666. Log `test-results/fence-sdk.log`. CI run ID: unset.

DEPLOY-FENCE-OFF on image `sha256:f3a44c87cf53cc184600db7dc07a0e348a6256740ff3839bc7d98f838082e3fc` passed at 2026-10-22T06:13:35.352Z. Mode was still OFF. A held advisory lock made GET and the governed tag PUT return 503 `DEPENDENCY_UNAVAILABLE`. The tag value stayed `high`. The next GET was 200. Log `deployment-evidence/image-rebuild.log`. CI run ID: unset.

Historical agent race checks `agent-race-status`, `agent-race-row`, `agent-race-history`, and `agent-concurrent-patch` passed at 2026-10-22T03:19:01Z. Those are Slice 1 checks. They are not Slice 6 fence races.
