# FAD Slice 0 operations

Slice 0 is the organization control plane. The API serves `GET /health/live`, `GET /health/ready`, and `GET /v1/organizations/current`. It does not register agents and it does not run schema changes.

## Topology

Run at least two stateless API replicas behind a TLS-terminating reverse proxy. Do not publish PostgreSQL. Apply roles and migrations with a separate privileged job, then start the API as `fad_app`.

Production startup rejects the process unless all of the following are true:

- `NODE_ENV=production`
- `FAD_INGRESS_TLS=terminated`
- `FAD_TRUST_PROXY=true`
- `FAD_TRUSTED_PROXIES` is an explicit CIDR list (the process never trusts every hop)
- `DATABASE_URL` includes `sslmode=require`, `verify-ca`, or `verify-full`
- `FAD_API_KEY_PEPPER_V1` is at least 32 bytes and is not a known weak value
- `FAD_RATE_LIMIT_BACKEND=postgres`
- The connected role is not a superuser, does not have `BYPASSRLS`, and cannot `SELECT` `api_credentials`
- Every file in the migrations directory matches `schema_migrations`

The API process does not terminate public TLS. The proxy must set the trusted client address and must not forward `X-FAD-API-Key` into logs. Development cleartext is allowed only on a loopback bind, or when `FAD_DEV_LOOPBACK_PUBLISH=true` because Compose publishes `127.0.0.1` only.

## Local stack

From the repository root, with a password file that is not committed:

```sh
docker compose --env-file /path/to/dev.env -f deploy/docker/compose.yaml up --build
```

`dev.env` must set `FAD_DEV_POSTGRES_PASSWORD`, `FAD_APP_DB_PASSWORD`, and `FAD_API_KEY_PEPPER_V1`. Compose starts PostgreSQL 16, runs `node apps/migrator/dist/main.js bootstrap` once, then starts the API. The API image does not apply DDL.

Check:

```sh
curl -fsS http://127.0.0.1:8080/health/live
curl -fsS http://127.0.0.1:8080/health/ready
```

## Offline administration

`fad-admin` uses `FAD_BOOTSTRAP_DATABASE_URL` (a role that can `SET ROLE fad_bootstrap`) and `FAD_API_KEY_PEPPER_V1`. It is not an HTTP endpoint.

```sh
node apps/admin/dist/main.js organization create --name 'Org A'
node apps/admin/dist/main.js principal create --organization-id <uuid> --type service --name 'Service A'
node apps/admin/dist/main.js credential issue --organization-id <uuid> --principal-id <uuid> --scopes organizations:read
node apps/admin/dist/main.js credential list --organization-id <uuid>
node apps/admin/dist/main.js credential revoke --organization-id <uuid> --kid <kid> --reason rotation
node apps/admin/dist/main.js organization suspend --organization-id <uuid> --reason incident
node apps/admin/dist/main.js principal disable --organization-id <uuid> --principal-id <uuid> --reason incident
```

The issue command prints the API key once on stdout and a one-line warning on stderr. Store the key in the secret store. List output has no secret and no verifier. Unknown scopes and `*` are refused. A principal from another organization is refused.

Call the API with `X-FAD-API-Key`. Do not send `organization_id` as a query parameter. `X-Organization-Id` is ignored. The key's organization is the only tenant.

## Credential rotation

1. Issue a successor with the same minimum scopes.
2. Store it, update the consumer, and call `GET /v1/organizations/current`.
3. Revoke the predecessor with a reason.
4. Confirm the old key returns 401 on every replica and the successor still returns the same organization.

A lost key is revoked the same way. Unauthenticated callers still receive the generic 401. Pepper rotation is a new pepper version plus reissued keys. A missing pepper is a startup failure.

## Backup and restore

Take a logical backup from the privileged database role:

```sh
pg_dump --format=custom --no-owner --file fad.dump "$FAD_MIGRATOR_DATABASE_URL"
```

Restore into an empty PostgreSQL 16 database that already has the roles from `db/roles/00_roles.sql`. Then compare organization counts, credential status, audit rows, and `schema_migrations.checksum_sha256`. Do not restore production secrets into a lower-trust environment. Point-in-time recovery targets are unmeasured in this slice. A checksum mismatch or a missing migration fails API startup and readiness. Do not drop tables to repair that.

## Shutdown

`SIGTERM` marks the process not ready, stops accepting new connections, closes the pool, and exits 0. `FAD_SHUTDOWN_GRACE_MS` must be at least `FAD_HTTP_REQUEST_TIMEOUT_MS`. A committed audit row is not rolled back by shutdown.

## What the API will not do

- Choose a tenant from a caller-supplied organization id
- Log the API key, verifier, pepper, or database URL
- Create a database superuser
- Expose agent, tag, MCP, federation, or OAuth routes
