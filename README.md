# Federated Agent Directory

The Federated Agent Directory (FAD) is the control service for a future directory of enterprise agents. This repository contains Slice 0. Slice 0 is the first release. Slice 0 is the secure foundation for later releases.

## Contents of Slice 0

Slice 0 contains these parts:

- A Node.js HTTP API.
- A PostgreSQL 16 database.
- An offline administration program, `fad-admin`.
- A TypeScript client, `@fad/sdk`.
- A container image and a local Docker Compose stack.

The API has three routes:

- `GET /health/live` shows that the process is alive.
- `GET /health/ready` shows that the database and the schema are ready.
- `GET /v1/organizations/current` returns the organization of the API key.

The OpenAPI description is `contracts/openapi.yaml`.

## Limits of Slice 0

Slice 0 does not register agents. Slice 0 does not serve tags, policies, discovery, or delegation. Slice 0 does not serve federation, MCP, or OAuth. Slice 0 does not call an agent. Slice 0 has no user interface. Slice 0 has no public user registration.

## Security rules

Send the API key in the header `X-FAD-API-Key`. The API uses the organization of that key. The caller cannot select a different organization. A query that selects an organization returns status 400. The header `X-Organization-Id` has no effect.

The database stores a key verifier. The database does not store the key secret. The verifier is an HMAC-SHA256 digest. The pepper comes from the secret store. The program `fad-admin` shows a new key one time. Store that key in the secret store.

Each table isolates rows by organization. The runtime role `fad_app` cannot bypass that isolation. The API does not change the database schema when the API starts. Run migrations in a separate job.

## Requirements

You need Node.js 22 or later. The container uses Node.js 24. You need PostgreSQL 16. You need Docker when you use the Compose stack.

## Build the programs

Run these commands at the root of the repository:

1. Run `npm ci`.
2. Run `npm run build`.

## Start the local stack

1. Copy `.env.example` to a file that you do not commit.
2. Set `FAD_DEV_POSTGRES_PASSWORD`, `FAD_APP_DB_PASSWORD`, and `FAD_API_KEY_PEPPER_V1` in that file. The pepper must contain at least 32 bytes.
3. Run this command:

```sh
docker compose --env-file /path/to/dev.env -f deploy/docker/compose.yaml up --build
```

Compose starts PostgreSQL 16. Compose then runs the migration job. Compose then starts the API. The API listens on `127.0.0.1` port `8080`.

Do these checks:

```sh
curl -fsS http://127.0.0.1:8080/health/live
curl -fsS http://127.0.0.1:8080/health/ready
```

## Create an organization and a key

Run `fad-admin` on a trusted computer. Set `FAD_BOOTSTRAP_DATABASE_URL` and `FAD_API_KEY_PEPPER_V1`. Do not create a key through HTTP.

```sh
node apps/admin/dist/main.js organization create --name "Organization A"
node apps/admin/dist/main.js principal create --organization-id <uuid> --type service --name "Service A"
node apps/admin/dist/main.js credential issue --organization-id <uuid> --principal-id <uuid> --scopes organizations:read
```

To revoke a key, run:

```sh
node apps/admin/dist/main.js credential revoke --organization-id <uuid> --kid <kid> --reason rotation
```

## Read the current organization

Send the key in `X-FAD-API-Key`. The route requires the scope `organizations:read`.

```sh
curl -fsS http://127.0.0.1:8080/v1/organizations/current \
  -H "X-FAD-API-Key: <key>"
```

A success body has `data` and `meta`. The field `meta.api_version` is `v1`. An error body has `error` and `meta`. A missing key, a bad key, an expired key, or a revoked key returns status 401. A valid key without the scope `organizations:read` returns status 403. A database outage returns status 503.

## Use the client

Install `@fad/sdk` from this repository. Create a client with the base URL and the API key. Call `health.live()`, `health.ready()`, or `organizations.current()`. The client retries only a safe GET request. You can cancel a call with an `AbortSignal`. The client does not log the API key.

```ts
import { FadClient } from '@fad/sdk';

const fad = new FadClient({
  baseUrl: 'http://127.0.0.1:8080',
  apiKey: () => process.env.FAD_API_KEY ?? '',
  allowInsecureHttp: true,
});
const current = await fad.organizations.current();
```

Use `allowInsecureHttp` only for a loopback development URL.

## Operate a production service

Put a TLS proxy in front of the API. Set `NODE_ENV` to `production`. Set `FAD_INGRESS_TLS` to `terminated`. Use a database URL with `sslmode=require`, `sslmode=verify-ca`, or `sslmode=verify-full`. Read `docs/operations/RUNBOOK.md` before you deploy the service.

## License

This project uses the MIT license. Read the file `LICENSE`.
