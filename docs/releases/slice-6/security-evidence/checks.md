# Security evidence

Commands:

- `node --test --test-concurrency=1 tests/*.test.mjs`. Exit 0. Log `test-results/npm-test.log`.
- `node --test --test-concurrency=1 tests/slice6.test.mjs`. Exit 0. Start 2026-10-22T03:44:52Z. End 2026-10-22T03:45:14Z. Duration_ms 21785.249625. Log `test-results/slice6-gates.log`. Notes `api-evidence/gate-notes.log`.

CI run ID: unset.

Org-scoped assertions use a credential from organization A and a credential from organization B. Organization B reads its own OFF configuration. Organization B receives 404 for organization A's agent and for organization A's decision.

| Mandatory case | Result |
| --- | --- |
| Missing old scope stays forbidden | PASS. P07 is 403 `FORBIDDEN` with an active allow present for other principals. |
| Untrusted organization header | PASS. A01 and MCP-ENFORCE keep the authenticated organization. |
| Supplied subject on evaluate | PASS for the public evaluate route. It stays `not_enforced` and does not authorize the GET. T10 at 2026-10-22T04:56:46.017Z: a GET body is 400 `VALIDATION_ERROR`, and a following body-less GET still follows the stored tags. |
| Tenant isolation of config, decisions, and agents | PASS. S01, P17, A20, MCP foreign decision 404. |
| Composite foreign key cross-insert | PASS. S05 at 2026-10-22T04:56:46.165Z. SQLSTATE 23503 for the foreign key and 42501 for row security. Leftover rows 0. |
| No matching allow | PASS with a limit. P05 is 404. That principal also has an explicit deny. |
| Explicit deny | PASS for the SHADOW reason `EXPLICIT_DENY` (P02), for the race read `f0fdd388-429d-4380-960e-a9f650ae38f6` (404, `EXPLICIT_DENY`), and for update replay after a new deny (D17). |
| Inactive resource | PASS. P15 GET of a suspended agent is 404. Activate while `agent.update` is enforced is 403 `POLICY_DENIED`. |
| Inactive subject | PASS as 401 `UNAUTHORIZED` before the enforcement point (P16). A `SUBJECT_INACTIVE` decision row was not asserted. |
| Malformed stored policy | PASS. 2026-10-22T03:44:55.591Z. With `fad_policy_guard` disabled, the active allow `subjects` became `{"broken":true}`. GET returned 503 `DEPENDENCY_UNAVAILABLE`. Mode stayed `enforce`. The body omitted the agent id and a name field. The original subjects were written back and the trigger was enabled. The following GET was 200. |
| Failed decision audit | PASS. D08 is 503 and the body omits the agent id. |
| Database outage | PASS. D09 and DEPLOY-OUTAGE are 503. Mode stays `enforce`. |
| Pool exhaustion | PASS. 2026-10-22T03:45:03.863Z. Pool max 1. An exclusive fence was held. One GET returned 503 `DEPENDENCY_UNAVAILABLE` at 5509 ms. The GET that held the connection returned 200 at 5531 ms after the fence commit. Mode stayed `enforce`. The 503 body omitted the agent id and a name field. |
| Lock timeout | PASS. D10 is 503. Mode stays `enforce`. |
| Deadlock cycle `40P01` | PASS. 2026-10-22T04:56:15.148Z. PATCH 503 `DEPENDENCY_UNAVAILABLE` at 1021 ms. Deadlock counter 7 became 8. Request `9ad5d6e1-a886-4a9c-a8a0-155dece906d4`. Server log: `process 4462 detected deadlock while waiting for ShareLock on transaction 63400 after 1001.485 ms`. Name and revision stayed unchanged. Mode stayed `enforce`. D10 remains the separate held-lock case. |
| Policy or tag change between PEP and commit | PASS. D01, D02, and D03 in the race log. The in-flight read kept the pre-change result. The later call followed the committed change. |
| Ungoverned selector blocked | PASS. T01 and T11. |
| Ordinary tag writer cannot change a policy-driving tag | PASS. T03 and T04. |
| MCP audience, scopes, and concealment | PASS for audience 401, list filtering, and `NOT_FOUND` without the agent id. S09 at 2026-10-22T04:56:48.811Z called the hidden set-config tool and did not change mode. S08 rejected `organization_id` and left organization B at 0 rows. |
| Stale preflight, weak ETag, idempotency collision, stale If-Match | PASS. A05, A06, A08, A16, A17, A18, A19. |
| Cursor tamper and cross-tenant cursor reuse | PASS. 2026-10-22T03:44:55.788Z. Page 2 is 200 with one different id. A cursor with one extra character is 400 `VALIDATION_ERROR`. Organization B and principal A2 each received 400. C06 at 2026-10-22T04:56:45.870Z sent the same cursor with a different filter and received 400 `VALIDATION_ERROR`. |
| Old image on an enforced tenant | PASS. S20 and DEPLOY-OLD-IMAGE. |
| Audited OFF | PASS. OFF, OFF-LEGACY, DEPLOY-OFF-BACK, MCP-OFF-BACK. |
| Secrets in audit, preflight, or logs | PASS for the checked strings. S14 and S12. The copied logs were scanned for API keys and bearer tokens. The scan found none. |

The matrix counts are PASS 134, PARTIAL 0, NOT RUN 0. R19 is the successful Actions `pull_request` run whose headSha equals `git --no-replace-objects rev-parse HEAD`. This blob does not store the run id or the commit id. The previous image rerun covered P10, P25, and T14 on `sha256:e5861d49221dc9d4598c67e521f70720f3f6a50aba4ab388fe965eff907e2473`. The tested image `sha256:f3a44c87cf53cc184600db7dc07a0e348a6256740ff3839bc7d98f838082e3fc` repeated those checks at 2026-10-22T06:26:56Z. P10 request `9890e58a-a994-401b-9d90-32aaf8ed3cdf`. P25 request `b7cd95e5-905b-436f-a0ae-af85d200fdb2`. T14 request `8aa20a0a-7467-4fd5-b5ce-4156ed2fcd2e`. The production TLS boot on that image passed at 2026-10-22T06:27:50Z. Activate of an active agent is allowed. Activate of a suspended agent is 403 `POLICY_DENIED` with decision `RESOURCE_INACTIVE`. Restricted definition text is absent from low-privilege explanation, from the privileged explanation items, and from preflight and audit reads. The production TLS boot passed at 2026-10-22T05:34:55Z on the previous image. R19 is PASS. It is the successful Actions `pull_request` run whose headSha equals `git --no-replace-objects rev-parse HEAD`. This blob does not store the run id or the commit id. `kubectl apply` is not the Docker gate, and the 2026-10-22T05:39:36Z command created no object.
