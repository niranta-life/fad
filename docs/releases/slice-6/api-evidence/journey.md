# HTTP journey

Command: `node --test --test-concurrency=1 tests/*.test.mjs`

Test: `policy enforcement migration, rollout, and tenant isolation`

Time: 2026-10-22T03:20:09.253Z through 2026-10-22T03:20:23.977Z

Exit: the suite exited 0.

Two organizations were created with the existing admin CLI. Each received its own principals and API keys. Organization A registered agents, descriptive tags, a governed `security.risk` tag, a capability, and endpoint bindings. Organization B registered one agent. Policies were an active governed allow, an explicit deny for principal A2, an ungoverned allow, and a suspend allow.

| Step | Result |
| --- | --- |
| Flag off hides `GET /v1/enforcement/config` | 404. FLAG-OFF. |
| Own config | OFF revision 0. A01. Request id `30a6bacc-a843-489f-9b7d-a5eb5bbdc7f0`. |
| Legacy read and patch before enforcement | 200. P01. |
| Evaluate | `not_enforced` and `allow`. P18. |
| Shadow preflight and PUT | Preflight passes with `ungoverned_selector`. PUT revision 1. A15 and A03. |
| A2 GET in SHADOW | 200 with `would_deny`. P02. |
| Ungoverned ENFORCE preflight | Does not pass. T01. |
| Governed ENFORCE preflight and PUT | Passes. Revision 2. T02 and A06. Request id `ee58f55b-a668-4e99-8687-e2f88cfbd6dd`. |
| A1 GET / A2 GET / missing scope / foreign | 200 / 404 / 403 / 404. P04, P05, P07, P17. |
| List, search, discovery | Denied id omitted. C01, C02, C03. |
| Tag governance | Ordinary and governance-only writes 403. Admin write 200 and the next read follows the tag. T03 through T06. |
| Suspend and inactive read | P09 and P15. |
| Audit failure, lock, Postgres pause | 503. D08, D10, D09. |
| Audited OFF | 200. Following A2 GET 200. Request id `aa7b3277-a4d9-4682-99d6-e64bcbd2d0b2`. |

`api-evidence/pep-journey.log` contains the `note()` lines only. Pass lines for every check are in `test-results/npm-test.log`.

## Gate rerun

Command: `node --test --test-concurrency=1 tests/slice6.test.mjs`

Start 2026-10-22T03:44:52Z. End 2026-10-22T03:45:14Z. Exit 0. Duration_ms 21785.249625.

| Step | Result |
| --- | --- |
| Malformed active policy | GET 503 `DEPENDENCY_UNAVAILABLE`. Mode stayed `enforce`. Following GET 200. |
| Limit-1 page 2 | 200, id `341d8e6f-571c-4ef7-a1b6-1631ec5a5778`. Denied id absent. |
| Tampered cursor | 400 `VALIDATION_ERROR`. |
| Cursor from organization B and from principal A2 | 400 and 400. |
| Pool max 1 while the fence is held | 503 at 5509 ms and 200 at 5531 ms. Mode stayed `enforce`. |
| Side-database restore | `enforce` revision 9, 40 decisions, 9 config revisions, hidden config count 0. |
| 100 protected reads | p50 9.4 ms, p95 11.4 ms, p99 15.5 ms, max 20.7 ms. Decision growth 100. Policy-decision growth 100. Audit growth 0. |

Request ids from this rerun: GET config `fe9ec9b8-95ff-4d3d-a614-abd6c473967c`, PUT ENFORCE `fd2e2486-0672-4271-b8ac-9a9f9c34eb54`, PUT OFF `b58aae22-b72f-403d-a888-ad643e3f0edf`.

Notes: `api-evidence/gate-notes.log`. Pass lines: `test-results/slice6-gates.log`.

CI run ID: unset.
