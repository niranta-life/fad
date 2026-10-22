# Security checks

Source: `node --test --test-concurrency=1 tests/slice5.test.mjs` and `tests/slice5-proof.test.mjs` against `fad-s0-pg` on 2026-10-21. Request ids and pass lines are in `api-evidence/journey.log`, `api-evidence/launch.log`, and `test-results/proof.log`.

| Check | Result | Evidence |
| --- | --- | --- |
| SQL injection in a policy name does not drop `fad_policies` | PASS | `REJECT` in the journey |
| Duplicate JSON keys | PASS | 400 in `REJECT` |
| Depth past 8 | PASS | 400 in `REJECT` |
| Caller `organization_id` and `tags` claims | PASS | 422 in `REJECT` |
| Malformed subject UUID | PASS | 422 in `REJECT` |
| Cross-tenant agent | PASS | 404, response does not include the other agent id |
| Self-only evaluation of another principal | PASS | 403 |
| Restricted policy hidden without `tags:restricted:read` | PASS | `RESTRICTED`. Ordinary tag writer cannot change governed `security.risk` (`TAG-ASSIGN` 403) |
| Mixed-case agent and principal UUIDs | PASS | `UUID-CASE`. A stored uppercase agent id still returns `EXPLICIT_DENY` |
| Referenced tag value `1.5` | PASS | `BAD-TAG`. 503, decision is not allow, row count unchanged. Objects cannot pass `agent_tag_tombstone`; the unit test covers `{v:high}`, arrays, null, and `1.5` |
| Decision insert revoked | PASS | 503, row count unchanged (`FAIL-CLOSED`) |
| Audit insert revoked | PASS | 503, policy count unchanged (`AUDIT-FAIL`) |
| Invalid stored selector | PASS | 503, then allow after restore (`CORRUPT`) |
| 257th activation | PASS | 409 `CONFLICT` (`OVERFLOW`) |
| More than 256 active rows at evaluate | PASS | 503, no new decision (`OVERFLOW`) |
| `ACCESS EXCLUSIVE` on `fad_policies` | PASS | 503 (`LOCK`) |
| Database port closed at startup | PASS | process not ready, log contains `Database is unavailable`, no `EXPLICIT_ALLOW` (`DB-OUT`) |
| RLS without tenant and with the other tenant | PASS | counts 0 (`RLS`) |
| `fad_app` update of revisions and delete of decisions | PASS | SQLSTATE 42501 |
| `fad_app` `rolbypassrls` | PASS | false. See `schema-and-rls.txt` |
| MCP invalid audience, scope ceiling, foreign subject, missing or stale If-Match | PASS | `mcp-evidence/mcp.log` |
| API logs for the journey | PASS | issued keys absent; the restricted value `high` absent (`LOGS`) |

No production key was written into these files.
