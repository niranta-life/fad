# Rollback and recovery for Slice 3

This slice adds only new tables and APIs. For an application rollback **keep the tables and data**; deploy the previously verified Slice 2-compatible image, disable Slice 3 routes and do not run destructive down migrations. Existing clients continue using Slices 0–2. No Slice 3 authorization grants exist, so rollback cannot grant privilege.

## Database migration failure

The Slice 0 migration runner MUST execute the SQL and `schema_migrations` checksum insert in **one transaction**, with the global migration lock. A failed transaction rolls back all Slice 3 DDL. The script intentionally contains no `BEGIN` or `COMMIT`. Check preconditions and migration checksum before retrying. Never auto-migrate as the app DB role.

## Forward-only recovery

If application rollback must preserve data for a later Slice 3 redeployment, leave new tables in place. If a full environment reset is explicitly approved (nonproduction or restored backup only), remove tables in FK dependency order (binding revision, binding, endpoint revision, endpoint, capability versions). In production use point-in-time restore into a fresh database rather than dropping tables. Run restoration tests with real migrations and current backups.

## Semantic considerations

An existing Slice 1 `retire` operation does not cascade deletion of endpoints/bindings. Discovery filters retired/suspended agents. Tag definitions and assignments remain untouched. Parent agent and tag ETags are independent from endpoint and binding revisions.
