# ADR 0001: Migration operator must be able to set function owner

`0001_foundation.up.sql` runs `ALTER FUNCTION fad_lookup_api_credential(text) OWNER TO fad_auth_reader`. PostgreSQL allows that only for a superuser, or for a role that can `SET ROLE fad_auth_reader` and that has `CREATE` on the schema. `00_roles.sql` creates `fad_auth_reader` and does not grant it to `fad_migrator`.

Decision: keep the package SQL unchanged. The migration job connects as a superuser (local Postgres image) or as an operator who is a member of both `fad_migrator` and `fad_auth_reader`. The API never runs this statement. `fad_app` is not a member of `fad_auth_reader`.

Contract check: the shipped `0001_foundation.up.sql` stays byte-identical to `plans/fad-slice-0/migrations/0001_foundation.up.sql`, and a live catalog check shows the function owner is `fad_auth_reader`.
