# Federated Agent Directory (FAD) — Slice 0: Production Foundation

Status: **design and implementation contract**; **not an implemented or runtime-tested server**.

Start here:
1. `docs/SPECIFICATION.md` — architecture, data model, exact behavior, security and operations.
2. `contracts/openapi.yaml` — normative OpenAPI 3.1 REST API for Slice 0.
3. `migrations/0001_foundation.up.sql` — proposed initial PostgreSQL 16+ migration.
4. `deploy/postgres/00_roles.sql` — privileged, audited one-time role bootstrap (example).
5. `sdk/SDK_CONTRACT.md` — Node.js SDK surface and behavior.
6. `verification/TEST_MATRIX.md` and `verification/acceptance-smoke.sh` — test plan and executable smoke probe.
7. `docs/GROK_GOAL.md` — standalone bounded `/goal` prompt.
8. `docs/SLICE1_HANDOFF.md` — compatibility contract for subsequent agent registration release.

**Important:** These files specify what Grok Code must build; Docker files are deployment references for the required implementation. SQL and script syntax can be checked statically, but the service, schema roles, migrations, and operational properties require actual runtime tests in CI and staging.

## Stable interface choices

- Auth header `X-FAD-API-Key` (consistent with earlier Slice 1 draft).
- `GET /v1/organizations/current` plus `/health/live` and `/health/ready`.
- JSON success envelope `{data,meta}` and errors `{error,meta}`.
- Backend `Node.js` LTS and `TypeScript`, PostgreSQL 16+, stateless OCI app.
- Tenant selected exclusively by verified credential; no caller-controlled organization selector.
- Database tables `organizations`, `principals`, `api_credentials`, `audit_events`, `idempotency_records`; RLS session variable `fad.org_id`; database login `fad_app`.

## Verification performed before handoff

See `verification/STATIC_VALIDATION.md` for results of validation performed against this document package. Runtime evidence must be produced by implementing the software; no such evidence is claimed by this package.
