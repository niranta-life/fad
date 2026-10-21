# Migration rollout and recovery policy

Production migrations must be forward-only after go-live. Never run `DROP TABLE organizations CASCADE` as an emergency rollback: that destroys identities and audit history and breaks later slices.

## Fresh environment

1. Execute `deploy/postgres/00_roles.sql` as privileged DBA.
2. Grant an audited migrator operator appropriate role membership, install migration tool.
3. Verify checksum of `0001_foundation.up.sql` and acquire an exclusive migration lock.
4. Run DDL and migration version insert in **one transaction**. The SQL file contains no transaction delimiters: the migration runner MUST own one transaction containing the DDL and checksum/version insert. Do not accidentally commit schema while failing to record version.
5. Restrict DB user grants and audit role membership.
6. Apply bootstrap actions and run role / RLS regression suite.

## Failed rollout

- If transaction did not commit: PostgreSQL rolls back the schema changes. Repair configuration and rerun.
- If transaction committed: treat the migration as deployed, confirm recorded checksum, and use a forward-fix migration for defects.
- If application cannot work with the new schema: roll back **application image only**, provided the old image still supports this schema; if not, restore from a tested PITR backup into a separate recovery environment and follow incident procedure.
- No destructive down migration is shipped; dev environments can be re-created from zero.

## Expand/contract rule

Future schema migrations must add fields/tables while old app replicas still function. Backfill separately, verify, then change writers/readers; only remove legacy structures in a new major compatibility window. Never mutate an already-applied migration file.
