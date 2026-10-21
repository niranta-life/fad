# Slice 0 implementation record

1. Copy the package OpenAPI, `0001_foundation` migration, and `00_roles.sql` without byte changes. Record reference defects in `docs/adr/0001` through `docs/adr/0008`.
2. Generate contract types and Ajv validators from the published OpenAPI file. Keep that file byte-identical to `plans/fad-slice-0/contracts/openapi.yaml`.
3. Apply roles and checksummed migrations with `fad-migrate`. The API process does not run DDL. Add additive migration `0002_rate_limit` for the shared limiter.
4. Issue organizations, principals, and API keys only from `fad-admin`. Store an HMAC verifier. Reveal the secret once. Audit each security change in the same transaction.
5. Serve the three HTTP routes with transaction-local `fad.org_id`, FORCE RLS, scope `organizations:read`, and generic 401 failures. Map database loss to 503.
6. Publish `@fad/sdk` with `health.live`, `health.ready`, and `organizations.current` only.
7. Build `deploy/docker` and run Compose. Migrations are the one-shot migrate service.
8. Run the Node 24 suite, the Compose journey, backup and restore, and the external SDK install. File the logs in this directory.

## Deviations

- `0002_rate_limit` is additive. `0001_foundation`, `db/roles/00_roles.sql`, and `contracts/openapi.yaml` match the package bytes.
- Compose and the Dockerfile live at `deploy/docker`. The package context `../..` is the package directory, not the repo root.
- Credential status is `active` or `revoked`. Disabled is not a status.
- Idempotency storage is commit-only. There is no in-progress row and no public idempotency route.
- The server under test is Node 24.22.0. The shipped image digest is `sha256:d2b388bf095974ce6028309c3918384c7d7b9570414c18fa0870340197fca49f`. The two-replica tenant, revoke, restart, and database-outage journey was run on that image at 2026-10-21T00:32:31Z. Log: `api-evidence/patched-journey.log`.
- The rate-limit backend is `postgres`.
- Ingress TLS is the `FAD_INGRESS_TLS=terminated` startup contract. Node does not terminate TLS.
- The HTTP server sets `httpAllowHalfOpen` so a client that sends the request and then FIN still receives an async response.
- The pool `error` listener keeps a Postgres stop from crashing the API process.
- `pg_restore` into a new cluster needs `00_roles.sql` first. Policies name `fad_app`, and roles are not inside the database dump.
- The packed SDK client in `sdk-evidence/sdk-external.log` ran on host Node v25.1.0 against the Node 24 API. The same SDK tests also passed inside the Node 24 suite.
- Backup proof includes a logical `pg_dump`/`pg_restore` and a separate WAL PITR drill. Measured archive lag 0.402 seconds. Measured restore-to-ready 1.942 seconds. Product RPO and RTO targets are not claimed.
- The runtime image upgrades `perl-base` to `5.36.0-7+deb12u4` and replaces Debian `zlib1g` with upstream zlib 1.3.1. Trivy 0.69.3 on the current image reported 0 critical and 0 secrets, and 60 high findings. `docker scout` did not scan because the CLI is not logged in.
- No CI job URL is configured.
- Each matrix id links to `by-id/<id>.log`, a verbatim excerpt. Shared logs no longer repeat the patched-image journey.
