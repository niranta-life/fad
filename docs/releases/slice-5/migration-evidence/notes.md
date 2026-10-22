# Migration

The runner is `applyMigrations` in `@fad/migrator`. It reads `*.up.sql` in file-name order, takes advisory lock `764001`, and stores the SHA-256 of each file in `schema_migrations`. The API process does not apply migrations.

Fresh database `fad_s5_fresh` applied, then was dropped:

`0001_foundation`, `0002_rate_limit`, `20261020_001_agents`, `20261020_002_principal_lock`, `20261021_001_typed_tags`, `20261021_005_policy_evaluation`, `20261022_001_capabilities_discovery`, `20261023_001_mcp_identity_bindings`.

The shared database `fad` already had Slices 0–4. The same runner added `20261021_005_policy_evaluation` there. Both version lists are in `migration.log`.

File SHA-256 of `db/migrations/20261021_005_policy_evaluation.up.sql` equals the stored checksum:

`ad2885a9e1f7b77c679383f8f4cca1294da4b2076ffba0aee8c97cef4a49f120`

Observed grants and `FORCE` RLS are in `../schema-and-rls.txt`.

Backup of `fad` was restored to `fad_s5_restore` with `pg_dump -Fc` and `pg_restore`. The decision-row count matched the source. That database was then dropped. The live database `fad` was not dropped. Proof id: `RESTORE` at 2026-10-21T21:43:44.545Z.
