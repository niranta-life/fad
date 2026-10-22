# Migration proof

Command: `node --test --test-concurrency=1 tests/*.test.mjs`

Test: `policy enforcement migration, rollout, and tenant isolation`

| Check | Time | Result |
| --- | --- | --- |
| MIG-BASE | 2026-10-22T03:20:09.253Z | PASS. Live database already had `20261021_005_policy_evaluation` and `20261023_001_mcp_identity_bindings`. |
| MIG-UP | 2026-10-22T03:20:09.269Z | PASS. `20261021_006_policy_enforcement` was applied or skipped. |
| MIG-SUM | 2026-10-22T03:20:09.269Z | PASS. One stored checksum, 64 hex characters. |
| MIG-FRESH | 2026-10-22T03:20:09.484Z | PASS. Database `fad_s6_fresh` was created, migrated, checked, and dropped. |
| R13 | 2026-10-22T03:20:09.485Z | PASS. Fresh head `20261023_001_mcp_identity_bindings`. Upgrade checksum `ee3a5731d8d5723de0062287baef0bf37c3346092d9280ebb8693c91642951f1`. |

MIG-FRESH observed:

- Four `fad_enforcement_*` tables with row security and force row security.
- `fad_app` is not a superuser and does not bypass row security.
- Decision and revision `UPDATE` and `DELETE` are false. Config `DELETE` is false.
- Preflight `used_at` `UPDATE` is true. Preflight `passes` `UPDATE` is false.
- `fad_app` select of configs with no `fad.org_id` returned 0 rows.
- `fad_app` update of decisions returned SQLSTATE `42501`.

The catalog query at 2026-10-22T03:29:38Z on database `fad` repeats the checksum and the force row security flags. See `schema-and-rls.txt`.

The down script was not run.

CI run ID: unset.
