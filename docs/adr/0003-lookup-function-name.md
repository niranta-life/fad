# ADR 0003: Credential lookup function name

The specification prose says `lookup_api_credential`. The migration defines `fad_lookup_api_credential(text)`.

Decision: the SQL name is normative. Application code calls `fad_lookup_api_credential` only. Do not add a second function.

Contract check: the migration text and `pg_proc` both use `fad_lookup_api_credential`, and `fad_app` has `EXECUTE` and no `SELECT` on `api_credentials`.
