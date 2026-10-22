# Rollback proof

The schema down file `db/migrations/20261021_006_policy_enforcement.down.sql` was not applied. The migrator reads `*.up.sql` only. After software rollback the enforcement tables stay.

## Old image while ENFORCE

Image `fad-api:slice5` id `sha256:45fbe99e5656fdac4a3f07b703c356684c6520769bf252708ab70de122f48ba8` served GET 404 while the tenant mode stayed `enforce`. A flag-off Slice 6 process also served GET 404. Check `DEPLOY-OLD-IMAGE` at 2026-10-22T03:20:02.759Z.

`S20` at 2026-10-22T03:20:15.476Z: `fad_app` with `fad.org_id` and without `fad.pep_generation` saw 0 agent rows. The same role with `fad.pep_generation=6` saw rows.

## Audited OFF

`DEPLOY-OFF-BACK` at 2026-10-22T03:20:06.959Z returned the tenant to `off`. The old image and the flag-off image then returned the agent with 200.

The HTTP journey `OFF` check at 2026-10-22T03:20:23.969Z rejected an OFF body that included a preflight id (422), then accepted OFF without a preflight. The agent row remained. Audit details did not contain `drop table`. Request id `aa7b3277-a4d9-4682-99d6-e64bcbd2d0b2`. The following A2 GET was 200.

MCP `MCP-OFF-BACK` at 2026-10-22T03:19:58.896Z performed the same OFF transition through `fad_set_enforcement_config`.

## Database restore

Command: `node --test --test-concurrency=1 tests/slice6.test.mjs`

Time: 2026-10-22T03:45:04.634Z. Exit 0. Log `test-results/slice6-gates.log`.

`pg_dump -U postgres -d fad -Fc` wrote `/tmp/fad_s6_restore.dump` inside `fad-s0-pg`. `pg_restore --no-owner --exit-on-error` loaded that dump into database `fad_s6_restore`.

Observed: live and restored mode `enforce`, revision 9, 40 enforcement decisions, 9 config revisions. `fad_app` connected to `fad_s6_restore` with no `fad.org_id` saw 0 config rows. A following read of database `fad` still showed mode `enforce` and revision 9. The side database and the dump file were removed. The schema down file was not applied.

Slice 6 operations state no numeric RPO or RTO. None is claimed. The dump and restore on this host finished between the pool check at 2026-10-22T03:45:03.863Z and this check. Matrix rows D15 and R16 are PASS.

CI run ID: unset.
