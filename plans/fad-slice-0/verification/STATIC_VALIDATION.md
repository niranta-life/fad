# Package static-validation results — 2026-10-20

This report covers only the generated **specification artifacts** in this package. It is **not** evidence of a built or running backend.

## Checks executed

| Check | Result | What it establishes |
|---|---|---|
| `python verification/validate-package.py` | PASS | YAML loads, local OpenAPI references resolve, representative JSON examples validate against schemas, intended tables and RLS guards are present, Compose YAML loads, Slice 1 handoff exists |
| `bash -n verification/acceptance-smoke.sh` | PASS | Bash syntax is valid |
| ZIP `ZipFile.testzip()` | PASS | Archive integrity, once assembled |

## Still unverified; must be proven by implementation

- SQL syntax and migration execution against real PostgreSQL; database roles, grants, FORCE RLS and SECURITY DEFINER behavior.
- Runtime HTTP requests and actual response/header wire compatibility.
- Offline `fad-admin` CLI operation, credential generation/rotation/revocation, audit atomics.
- Node SDK install/build, timeout, cancellation, redirects, typing, and HTTP integration.
- OCI Docker build and actual Compose startup/restart, non-root runtime, DB outage and restore.
- Multi-replica concurrency, isolation, key revocation propagation, auth rate limiting.
- Postgres backup/PITR restoration, load tests and stated SLO targets.
- Secure code scanning, SBOM production image pinning, CI audit and one focused Git commit.

**Do not interpret PASS above as production readiness.** All mandatory runtime gates are in `verification/TEST_MATRIX.md`.
