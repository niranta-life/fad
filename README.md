# Federated Agent Directory

The Federated Agent Directory (FAD) is the control service for the agents in an organization. An administrator runs the service. A developer calls it from an agent with the TypeScript client `@fad/sdk`.

The directory binds every API key to one organization, registers that organization's agents, and keeps a directory status for each agent: `active`, `suspended`, or `retired`. It also records capability versions, HTTPS endpoints, and bindings, and it lists active agents that declare a capability.

Each agent has a stable id, a global URN of the form `urn:fad:agent:<organization-uuid>:<agent-uuid>`, and a revision. A real change writes an audit row, and one organization cannot read or change another organization's agents. The directory stores the record. The agent process does the work, and another system decides whether to call the agent.

The repository contains a Node.js HTTP API, a PostgreSQL 16 database, the offline program `fad-admin`, the client `@fad/sdk` 0.5.0, the optional client `@fad/mcp-client` 0.2.0, and a container image with a local Docker Compose stack. The HTTP contract is `contracts/openapi.yaml`, contract version 1.5.0. Every success and error body uses API version `v1`.

- [Server](#server) is for the administrator who runs the service and issues keys.
- [Client](#client) is the call reference, with examples.
- [Use the client in an agent](#use-the-client-in-an-agent) is the startup path a developer puts in an agent.

## Server

You run four parts: PostgreSQL 16, a migration job, the API, and `fad-admin`. The API serves HTTP. `fad-admin` talks to PostgreSQL and is the only way to create an organization, a service principal, or an API key. Callers never send those commands to the API.

You need Node.js 22 or later on a workstation that builds or runs `fad-admin`. The container image uses Node.js 24. Use Docker when you start the Compose stack yourself. The development commands below also need [Colima](https://github.com/abiosoft/colima).

### Start the local stack

The local stack needs two database passwords and an API pepper. The API accepts a pepper only when it is at least 32 bytes, contains at least 8 different byte values, and is not a well-known placeholder such as `password` or `changeme`. Every API replica and `fad-admin` use this same pepper. The database stores an HMAC-SHA256 verifier for each key and does not store the key secret.

On a development computer with Colima, use the [development commands](#development-commands). They write the uncommitted file `.env.development`, check the machine, and start the stack. To start the stack without those commands, follow [Start with Compose](#start-with-compose) and copy `.env.example` to a file you do not commit.

#### Development commands

These three commands are for development only. They stop immediately when `NODE_ENV` is anything other than empty or `development`, and they use the running Colima Docker engine. If Colima is not running, or Docker is pointed at a different engine, they stop before they create or change a container.

From the repository root:

```sh
npm run dev:setup
npm run dev:config -- set postgres-password "a long password"
npm run dev:config -- set app-password "another long password"
npm run dev:config -- set pepper "a long random pepper"
npm run dev:config -- set port 8080
npm run dev:config -- review
npm run dev:server -- start
npm run dev:server -- status
```

The same programs are `node scripts/dev-setup.mjs`, `node scripts/dev-config.mjs`, and `node scripts/dev-server.mjs`.

`dev:setup` checks that Colima is running, that Docker is that Colima engine, that Node.js is 22 or later, and that the installed packages match the lockfile. When packages are missing, it installs them from the lockfile. It does not install Colima, Docker, or Node.js, and it does not restart Colima when the checks already pass.

`dev:config` creates and updates `.env.development` in the repository root. Git ignores that file, and the command saves it so that only your user can read it. `review` shows which settings are set and which are missing, and it prints `set` or `missing` for the passwords and the pepper instead of the values. `set` changes one setting. If the value is refused, the previous file stays unchanged.

| Setting | What to enter |
| --- | --- |
| `postgres-password` | Password for the local PostgreSQL superuser. It cannot be blank. |
| `app-password` | Password for the `fad_app` login. It cannot be blank. |
| `pepper` | The API pepper described above. |
| `port` | A whole number from 1 to 65535. The API is published on `127.0.0.1` and this port. |
| `publish-address` | `127.0.0.1`, `localhost`, or `::1`. Any other address is refused. The Compose port stays on `127.0.0.1`. |
| `tags`, `slice3`, `mcp` | `on` or `off`. The default is off. |
| `mcp-issuer` | One or more `https` issuer addresses, separated by commas, with no user, password, query, fragment, or path. |
| `mcp-resource` | The MCP resource address. `http` is accepted only for `127.0.0.1`, `localhost`, or `::1`. |
| `mcp-audience` | The same address as `mcp-resource`. |
| `allowed-hosts` | The host names the API accepts when MCP is on. |

Turn `mcp` on only after the issuer, resource, audience, and allowed host are set, and only when the audience is the same address as the resource. While MCP is off, you can change the resource and the audience one at a time. While MCP is on, turn it off before you change either address, set both addresses, and then turn MCP on again.

```sh
npm run dev:config -- set mcp-issuer https://issuer.example
npm run dev:config -- set mcp-resource http://127.0.0.1:8080/mcp
npm run dev:config -- set mcp-audience http://127.0.0.1:8080/mcp
npm run dev:config -- set allowed-hosts 127.0.0.1:8080
npm run dev:config -- set mcp on
```

`dev:server` accepts `start`, `stop`, `restart`, and `status`. `start` builds the image when necessary and waits until the server is ready. The first start can take a few minutes, and a second start does not add a second copy. `stop` and `restart` keep the local database. `status` reports that the server is up, down, or not ready yet. None of these commands print a password, the pepper, or a database URL.

```sh
npm run dev:server -- restart
npm run dev:server -- stop
```

After a successful start, `status` and the ready check below both agree that the server is up.

#### Start with Compose

From the repository root, with your own env file:

```sh
docker compose --env-file /path/to/dev.env -f deploy/docker/compose.yaml up --build
```

Compose starts PostgreSQL 16, runs the migration job once, and then starts the API. The API listens on `127.0.0.1` port `8080` unless `FAD_PUBLISH_PORT` says otherwise. The API process does not change the schema. PostgreSQL stays on the Compose network and is not published to the host.

#### Confirm the API

```sh
curl -fsS http://127.0.0.1:8080/health/live
curl -fsS http://127.0.0.1:8080/health/ready
```

`/health/live` returns `{"status":"ok"}` when the process is up. `/health/ready` returns `{"status":"ready"}` when the database is reachable and the applied migrations match the files in the image. A database outage or a migration mismatch returns `{"status":"not_ready"}` with status 503. Use the port you set if it is not 8080.

### Issue an organization and keys

Run `fad-admin` on a trusted computer. Set `FAD_BOOTSTRAP_DATABASE_URL` to a login that can `SET ROLE fad_bootstrap`, and set `FAD_API_KEY_PEPPER_V1` to the pepper the API uses. The runtime login `fad_app` cannot issue keys. In production, grant `fad_bootstrap` to the operator login and keep that grant off `fad_app`.

On the local stack, load the env file and point the bootstrap URL at the Compose network. After the migration job has finished, the local superuser can assume `fad_bootstrap`:

```sh
set -a
. /path/to/dev.env
set +a
export FAD_BOOTSTRAP_DATABASE_URL="postgres://postgres:${FAD_DEV_POSTGRES_PASSWORD}@postgres:5432/fad"

docker compose --env-file /path/to/dev.env -f deploy/docker/compose.yaml run --rm --no-deps \
  -e FAD_BOOTSTRAP_DATABASE_URL \
  api \
  node apps/admin/dist/main.js organization create --name "Organization A"
```

If you used the development commands, `/path/to/dev.env` is `.env.development` in the repository root.

On a workstation that can already reach PostgreSQL, build first and use the npm script:

```sh
npm ci
npm run build
export FAD_BOOTSTRAP_DATABASE_URL="postgres://..."
export FAD_API_KEY_PEPPER_V1="..."
npm run fad-admin -- organization create --name "Organization A"
```

Each command prints one JSON object on stdout. `organization create` returns `id`. Use that id as `--organization-id` for the next commands. `principal create` returns the principal `id`. Give that id to the developer as `FAD_OWNER_PRINCIPAL_ID`. The only principal type you can create is `service`.

```sh
npm run fad-admin -- principal create \
  --organization-id <organization-uuid> \
  --type service \
  --name "Accounts Payable"
```

`credential issue` prints the API key in the field `api_key` and writes a one-line warning to stderr. The key looks like `fad_live.<kid>.<secret>`. Store it in the secret store immediately, because the program shows that secret once. `credential list` prints the key id, principal, scopes, and status, and it prints neither the secret nor the verifier.

Issue a separate key for each program. Repeat `--scopes` or pass a comma-separated list. A scope must be one of the names below. A wildcard is rejected.

```sh
npm run fad-admin -- credential issue \
  --organization-id <organization-uuid> \
  --principal-id <principal-uuid> \
  --scopes organizations:read,agents:write
```

Optional `--expires-at` takes a future timestamp. If you omit it, the key stays active until you revoke it.

| Scope | Give it to | What the holder can do |
| --- | --- | --- |
| `organizations:read` | Any program that must confirm which organization its key belongs to | `GET /v1/organizations/current` |
| `agents:read` | The running agent | Read one agent, list agents, and walk every page in its organization |
| `agents:write` | The deploy job, or the agent process when that process registers itself | Register an agent and edit its name, description, or owner |
| `agents:lifecycle` | An operator tool | Suspend, activate, or retire an agent |
| `tags:define` | The administrator who creates tag definitions | Create a typed tag definition |
| `tags:read` | A program that reads or searches tags | Read tag definitions and tags on an agent, and send tag predicates |
| `tags:write` | The deploy job that labels an agent | Assign or remove a tag on an agent |
| `tags:governance` | A security administrator | Create or change a governed or restricted tag |
| `tags:restricted:read` | A program allowed to see restricted tags | Read a restricted tag and use it as a predicate |
| `capabilities:read` | A program that reads the catalog or discovers agents | Read capability versions and bindings |
| `capabilities:write` | The administrator who publishes or binds a capability | Publish an immutable capability version, and bind or remove that binding |
| `endpoints:read` | A program that reads endpoint metadata or discovers agents | Read declared endpoints |
| `endpoints:write` | The deploy job that declares where an agent is reached | Create, update, disable, or remove an endpoint declaration |
| `policies:read` | A program that lists policy drafts | Read policies that do not select a restricted tag |
| `policies:write` | The administrator who drafts a policy | Create or replace a draft policy |
| `policies:activate` | The administrator who publishes a policy | Activate a draft or disable an active policy. Also requires `policies:write` |
| `policies:evaluate:self` | A service that checks its own subject | Evaluate access for the calling principal |
| `policies:evaluate:any` | An operator tool that checks another subject | Evaluate access for any principal in the organization. Also requires `agents:read` |
| `policies:explain` | An auditor | Receive decision digests and matched policy ids when restricted selectors are also visible |

A key that already exists does not gain a scope you add to the product later. Issue a new key when a program needs another name from this table. A registrar key needs `organizations:read` and `agents:write`. A running agent that loads its record and lists peers needs `agents:read`. Keep `agents:lifecycle` on the operator tool, because suspending, activating, and retiring are administrator actions. Publishing or binding a capability needs `capabilities:write`, declaring an endpoint needs `endpoints:write`, and discovering agents needs `agents:read`, `capabilities:read`, and `endpoints:read`.

Confirm a new key from the workstation:

```sh
curl -fsS http://127.0.0.1:8080/v1/organizations/current \
  -H "X-FAD-API-Key: $FAD_API_KEY"
```

A success body has `data` and `meta`, and `data.id` is the organization of the key. An error body has `error` and `meta`. A missing, unknown, expired, or revoked key returns status 401, as does a key whose principal or organization is inactive. A valid key without the required scope returns status 403. A database outage on an authenticated route returns status 503. Send the key only in `X-FAD-API-Key`. The header `X-Organization-Id` has no effect, and a query parameter that names an organization returns status 400. The key selects the organization.

### Operate the directory

To register an agent with curl, send `agents:write`, a JSON body, and an `Idempotency-Key` of 8 to 128 characters from `A-Z`, `a-z`, `0-9`, and `.`, `_`, `:`, `-`. The server chooses the agent id, the URN, the initial status `active`, and revision 1. The response carries `ETag` and `Location`. The same key and the same body, from the same principal, replay the original result for 24 hours. After that record expires, the same key is a new request.

```sh
curl -fsS -D - http://127.0.0.1:8080/v1/agents \
  -H "X-FAD-API-Key: $FAD_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: register-accounts-payable" \
  -d '{"name":"Accounts Payable Agent","owner_principal_id":"<principal-uuid>"}'
```

A name is 1 to 160 Unicode code points after trim. A description is optional and at most 2000 code points. The owner must be a service principal in the same organization.

Later edits and status changes require `If-Match` with the current strong ETag, for example `"agent-v1"`, including the quotes. Read `GET /v1/agents/<agent-id>` first. `PATCH /v1/agents/<agent-id>` changes the name, description, or owner and requires `agents:write`. Send `description: null` to clear the description. Status changes use `POST /v1/agents/<agent-id>/suspend`, `/activate`, or `/retire`, require `agents:lifecycle`, and take `{"reason":"..."}`. The reason is 1 to 500 code points and is stored in the lifecycle history. A retired agent stays readable, but it cannot be edited or activated. Repeating suspend, activate, or retire when the agent is already in that status leaves the revision unchanged. A missing agent and an agent in another organization both return status 404.

List with `GET /v1/agents`. The optional query fields are `status` (`active`, `suspended`, or `retired`), `limit` (default 25, maximum 100), and `cursor`. Any other query parameter returns status 400. Pages are ordered by `created_at` descending, then id descending. `meta.next_cursor` is null on the last page.

The default limit is 60 authenticated requests per key per 60 seconds. A limited call returns status 429 and `Retry-After`. Change the ceiling with `FAD_RATE_LIMIT_MAX` and `FAD_RATE_LIMIT_WINDOW_SECONDS`. `FAD_RATE_LIMIT_BACKEND` stays `postgres`.

Tags, Slice 3, MCP, and policies stay off until the matching value is the exact string `true`. The configuration command writes that string when you set `tags`, `slice3`, `mcp`, or `policies` to `on`. Run the migration job before you enable a flag. To roll back, set the flag to `false`, or deploy the previous API image, and leave the new tables in place.

### Typed tags

An administrator creates a typed tag definition. A service assigns that tag to an existing agent and searches agents by the tag value. A security administrator creates a governed tag, which a service without `tags:governance` cannot change. A service without `tags:restricted:read` cannot see a restricted tag.

While `FAD_TAGS_ENABLED` is not `true`, tag routes answer 404. Agent routes stay the same, and the agent record does not gain tag fields. A tag has its own ETag, `tag-vN`.

Creating a definition requires `tags:define`. A governed or restricted definition also requires `tags:governance`. Assigning or removing a tag requires `tags:write`, and a governed tag also requires `tags:governance`. Reading tags requires `tags:read` together with `agents:read` when the tags are on an agent. Search with tag predicates requires `agents:read` and `tags:read`, and a restricted predicate also requires `tags:restricted:read`. The reserved namespaces `security`, `compliance`, and `system` are governed and restricted.

### Capabilities and local discovery

While `FAD_SLICE3_ENABLED` is not `true`, the capability, endpoint, binding, and discovery routes answer 404. Agent and tag routes stay the same. An endpoint or binding change does not change the agent ETag or a tag ETag.

`POST /v1/capabilities` publishes one immutable version. Send `capabilities:write`, an idempotency key, a capability id, a semantic version, a display name, and bounded JSON Schema Draft 2020-12 input and output schemas. The server stores a canonical contract digest and `verification` `self_declared`. The same key and the same body replay the original 201. A new key for a version that already exists returns 409. A published version stays as published.

`PUT /v1/agents/<agent-id>/endpoints/<key>` declares where that agent is reached. Send `endpoints:write`. The URL is `https`, with a hostname, and with no username, password, query, fragment, or IP address. Put no credential in the URL or in any other field. The protocol is `a2a`, `mcp`, or `http_json`. The auth scheme is a label: `oauth2`, `mtls`, `api_key`, or `none`. The service stores that label and does not resolve or call the URL. Create with `If-None-Match: *`. The first ETag is `"endpoint-v1"`. A later change sends `If-Match` with the current strong ETag. A missing precondition returns 428, and a stale ETag returns 412. An agent has at most 8 live endpoints. Deleting an endpoint that still has a live binding returns 409, so remove the binding first. A later create continues the revision, and the old ETag stays stale. Read an endpoint with `agents:read` and `endpoints:read`.

`PUT /v1/agents/<agent-id>/capabilities/<capability-id>` binds one published version to one endpoint on that same agent. Send `capabilities:write`. The body is `version` and `endpoint_key`. Create with `If-None-Match: *`. The first ETag is `"cap-binding-v1"`. An agent has at most 32 live bindings, and one live binding for each capability id. Read a binding with `agents:read` and `capabilities:read`. Remove an endpoint or a binding with `DELETE`, `If-Match`, and the current ETag.

`POST /v1/discovery/agents` lists active agents in the caller's organization. The caller needs `agents:read`, `capabilities:read`, and `endpoints:read`. The body names an exact capability id, an optional exact version, up to eight tag predicates, and an optional protocol list. A tag predicate also requires `tags:read`, and a restricted predicate requires `tags:restricted:read`. Without that scope, a restricted tag and a tag the organization has not defined both return 403, and the body does not include the tag value. Each match includes the agent, the binding, the endpoint, `verification` `self_declared`, `availability` `not_checked`, and `invocation_authorization` `not_evaluated`. A disabled endpoint, a suspended or retired agent, or a tombstoned binding is omitted. The client methods are `capabilities`, `endpoints`, `bindings`, and `discovery`. Older methods keep their arguments and results.

### MCP

While `FAD_MCP_ENABLED` is not `true`, `POST /mcp` answers 404. `/v1` stays the same and still uses `X-FAD-API-Key`. MCP accepts only `Authorization: Bearer`.

When you enable MCP, set `FAD_MCP_RESOURCE_URI`, set `FAD_MCP_EXPECTED_AUDIENCE` to that same URI, and set `FAD_MCP_AUTH_ISSUERS` and `FAD_HTTP_ALLOWED_HOSTS`. The development configuration command enforces the same rule. The service does not issue tokens. Bind a principal offline, then disable that binding to stop MCP access. The runtime database role cannot insert a binding, and a disabled binding does not revoke the principal's API key.

```sh
npm run fad-admin -- mcp bind \
  --organization-id <organization-uuid> \
  --principal-id <principal-uuid> \
  --issuer https://issuer.example \
  --subject <oauth-subject> \
  --client-id <oauth-client-id> \
  --scopes agents:read,agents:write
npm run fad-admin -- mcp disable --binding-id <binding-uuid>
```

If the flag is on and the issuer settings are absent or incomplete, the process stays up, `/health/live` stays ok, and `/health/ready` and `/mcp` answer 503. Do not drop `mcp_principal_bindings` when you roll back. The optional client is `@fad/mcp-client`. `@fad/sdk` keeps its arguments and results.

### Policy evaluation

While `FAD_POLICIES_ENABLED` is not `true`, `/v1/policies` and `/v1/authorization/evaluate` answer 404. Existing routes stay the same. An evaluation is a recorded hypothesis. `enforcement` is always `not_enforced`. An allow does not call an agent and does not change any other route.

Create a draft with `policies:write`, an idempotency key, and a definition. The first ETag is `"policy-v1"`. Replace a draft with `PUT`, `If-Match`, and a new idempotency key. Activate or disable with `policies:write`, `policies:activate`, `If-Match`, and an idempotency key. A draft cannot be disabled. A disabled policy stays disabled. An active definition does not change.

`POST /v1/authorization/evaluate` needs `agents:read` and either `policies:evaluate:self` or `policies:evaluate:any`. The server reads the agent, the subject, and the tags. A caller cannot supply those values. No matching allow is a deny. A matching deny overrides a matching allow. A policy that selects a restricted tag is hidden without `tags:restricted:read`. The client methods are `policies` and `authorization.evaluate`. Evaluation is not retried.

### Rotate a key and stop a caller

Issue the successor with the scopes that program needs. Store it, point the program at it, and call `GET /v1/organizations/current`. Then revoke the predecessor. Revoking a key that is already revoked succeeds and reports `already_revoked`.

```sh
npm run fad-admin -- credential list --organization-id <organization-uuid>
npm run fad-admin -- credential revoke \
  --organization-id <organization-uuid> \
  --kid <kid> \
  --reason rotation
```

`organization suspend --organization-id <uuid> --reason <text>` stops every key in that organization. `principal disable --organization-id <uuid> --principal-id <uuid> --reason <text>` stops that principal's keys. Both require a reason of 1 to 160 characters. Revoke a lost key the same way. Replacing the pepper means a new pepper value plus newly issued keys. The API refuses to start when the pepper is missing or weak.

### Run it in production

Put a TLS-terminating proxy in front of the API. The API process does not terminate public TLS. Run at least two API replicas, keep PostgreSQL unpublished, and apply roles and migrations with a privileged job before you start the API as `fad_app`. The development commands do not run in production.

Production startup requires all of the following:

- `NODE_ENV=production`
- `FAD_INGRESS_TLS=terminated`
- `FAD_TRUST_PROXY=true` and `FAD_TRUSTED_PROXIES` set to the proxy CIDRs
- `DATABASE_URL` with `sslmode=require`, `sslmode=verify-ca`, or `sslmode=verify-full`
- `FAD_API_KEY_PEPPER_V1` set from the secret store
- `FAD_RATE_LIMIT_BACKEND=postgres`
- A connected role that is not a superuser, lacks `BYPASSRLS`, and cannot read `api_credentials`
- A migrations directory whose files match `schema_migrations`

The migration commands are `node apps/migrator/dist/main.js roles`, `up`, and `bootstrap`. `bootstrap` applies roles and then migrations. Set `FAD_MIGRATOR_DATABASE_URL` and, for roles, `FAD_APP_DB_PASSWORD`. A checksum mismatch or a missing migration fails API startup and readiness.

`SIGTERM` marks the process not ready, stops accepting connections, closes the pool, and exits 0. Set `FAD_SHUTDOWN_GRACE_MS` to at least `FAD_HTTP_REQUEST_TIMEOUT_MS`. A committed audit row stays committed across shutdown.

The proxy must not write `X-FAD-API-Key` into access logs. The API does not log the key, the verifier, the pepper, or the database URL. Read `docs/operations/RUNBOOK.md` for backup, restore, and shutdown. The routes in this README are the current API.

## Client

`@fad/sdk` is the TypeScript client for the HTTP API. It has no database access and no administration commands. An agent, a deploy job, and an operator tool each construct a `FadClient` with the base URL and the key you issued for that program.

The package builds for ESM and CommonJS and requires Node.js 22 or later. From another project, pack it in this repository and install the tarball. `npm pack` prints the file name:

```sh
npm pack -w @fad/sdk
npm install /path/to/fad-sdk-0.5.0.tgz
```

Create one client for the life of the process. Pass the key through a function so a rotated secret is picked up on the next call. Use `credentialProvider` when you prefer that name. When both are set, `apiKey` is the one that is called.

```ts
import { FadClient } from '@fad/sdk';

const fad = new FadClient({
  baseUrl: process.env.FAD_BASE_URL ?? '',
  apiKey: () => {
    const key = process.env.FAD_API_KEY;
    if (!key) throw new Error('FAD_API_KEY is empty');
    return key;
  },
  userAgentSuffix: 'accounts-payable-agent',
});
```

`baseUrl` is HTTPS. For a loopback development URL, set `allowInsecureHttp: true`. Any other `http` URL is rejected. The client refuses a base URL that contains a username or password, refuses redirects, and removes the API key from error text. The default timeout is 5 seconds. `timeoutMs` must be greater than 0 and at most 120000. Pass an `AbortSignal` on any call to cancel it.

### Check the directory and read the organization

Health calls are unauthenticated. `health.ready()` resolves with `{ status: 'not_ready' }` on a 503 readiness response, so the caller can wait and try again. `organizations.current()` requires `organizations:read`.

```ts
const live = await fad.health.live();
const ready = await fad.health.ready();
const organization = await fad.organizations.current();

console.log(live.status); // ok
console.log(ready.status); // ready
console.log(organization.data.id, organization.meta.request_id);
```

### Register an agent

`agents.register` requires `agents:write` and an `idempotencyKey`. Keep the body and the key stable when you retry that same registration. The directory retains the result for 24 hours. During that window, the same principal, key, and body return the original response, including the original revision. After the record expires, the same key is a new registration and creates another agent. Store `data.id` and call `agents.get` on later startups.

```ts
const registered = await fad.agents.register(
  {
    name: 'Accounts Payable Agent',
    description: 'Matches supplier invoices',
    owner_principal_id: process.env.FAD_OWNER_PRINCIPAL_ID ?? '',
  },
  { idempotencyKey: 'register-accounts-payable' },
);

console.log(registered.data.id);
console.log(registered.data.global_id);
console.log(registered.etag); // "agent-v1"
console.log(registered.location); // /v1/agents/<id>
```

`owner_principal_id` is the service principal the administrator created. The current-organization response does not include it, so configure it beside the API key.

### Read and list agents

`get`, `list`, and `iterate` require `agents:read`. `get` returns the live row and its current ETag. Use that ETag for a later write. A missing agent and an agent in another organization both throw status 404 with code `AGENT_NOT_FOUND`.

```ts
const loaded = await fad.agents.get(registered.data.id);
console.log(loaded.data.status, loaded.etag);

const page = await fad.agents.list({ status: 'active', limit: 25 });
for (const agent of page.data) {
  console.log(agent.id, agent.global_id, agent.name);
}
console.log(page.meta.next_cursor);

for await (const agent of fad.agents.iterate({ status: 'active' })) {
  console.log(agent.id);
}
```

`iterate` follows `next_cursor` until the last page. `list` without a status returns every status. `limit` defaults to 25 and cannot exceed 100.

### Change an agent

`agents.update` requires `agents:write`, an idempotency key, and `ifMatch` set to the ETag from `get` or from the previous write. Only the fields you send are changed. `description: null` clears the description. A retired agent cannot be edited. A call that changes nothing keeps the current revision. Reuse the idempotency key only to retry that same body and the same ETag. A new edit uses a new key, because the key and the ETag are both part of the stored request.

```ts
const updated = await fad.agents.update(
  loaded.data.id,
  { description: 'Matches supplier invoices and flags duplicates' },
  { idempotencyKey: 'describe-accounts-payable-2026-10-20', ifMatch: loaded.etag },
);

console.log(updated.data.revision, updated.etag);
```

### Change directory status

`suspend`, `activate`, and `retire` require `agents:lifecycle`. The body is `{ reason }`. A transition that is already in effect keeps the revision. Retire is terminal: the agent stays readable, and a later activate or edit returns status 409 with code `INVALID_STATE_TRANSITION`.

```ts
const suspended = await fad.agents.suspend(
  updated.data.id,
  { reason: 'Invoice source is offline' },
  { idempotencyKey: 'suspend-accounts-payable-2026-10-20', ifMatch: updated.etag },
);

const activated = await fad.agents.activate(
  suspended.data.id,
  { reason: 'Invoice source is back' },
  { idempotencyKey: 'activate-accounts-payable-2026-10-20', ifMatch: suspended.etag },
);
```

`agents.retire` takes the same arguments.

### When a call fails

Failures throw `FadApiError` with `status`, `code`, `message`, and, when the server sent one, `requestId` and `retryAfterSeconds`.

```ts
import { FadApiError } from '@fad/sdk';

try {
  await fad.agents.update(loaded.data.id, { name: 'Accounts Payable' }, {
    idempotencyKey: 'rename-accounts-payable-2026-10-20',
    ifMatch: loaded.etag,
  });
} catch (err) {
  if (err instanceof FadApiError && err.status === 412) {
    const fresh = await fad.agents.get(loaded.data.id);
    await fad.agents.update(fresh.data.id, { name: 'Accounts Payable' }, {
      idempotencyKey: 'rename-accounts-payable-2026-10-20-r2',
      ifMatch: fresh.etag,
    });
  }
}
```

Status 412 means the ETag is stale. Read the agent again and send the edit with the new ETag and a new idempotency key. Status 428 means `If-Match` was missing. Status 409 with code `IDEMPOTENCY_CONFLICT` means that key was already used for a different body or a different ETag.

The client retries a request at most twice (`maxGetRetries`, maximum 5) when the status is 429 or 503, or when the connection fails. It honors `Retry-After` up to `maxRetryAfterMs` (default 30 seconds) and up to the time left on the timeout. It retries a mutation only for those same failures, and the retry sends the same idempotency key and the same `If-Match`. It leaves 401, 403, 409, and 412 to the caller.

| Method | Scope | Route |
| --- | --- | --- |
| `health.live()` | none | `GET /health/live` |
| `health.ready()` | none | `GET /health/ready` |
| `organizations.current()` | `organizations:read` | `GET /v1/organizations/current` |
| `agents.register(body, { idempotencyKey })` | `agents:write` | `POST /v1/agents` |
| `agents.get(agentId)` | `agents:read` | `GET /v1/agents/{agentId}` |
| `agents.list(query)` | `agents:read` | `GET /v1/agents` |
| `agents.iterate(query)` | `agents:read` | `GET /v1/agents`, following `next_cursor` |
| `agents.update(agentId, body, { idempotencyKey, ifMatch })` | `agents:write` | `PATCH /v1/agents/{agentId}` |
| `agents.suspend(agentId, { reason }, { idempotencyKey, ifMatch })` | `agents:lifecycle` | `POST /v1/agents/{agentId}/suspend` |
| `agents.activate(agentId, { reason }, { idempotencyKey, ifMatch })` | `agents:lifecycle` | `POST /v1/agents/{agentId}/activate` |
| `agents.retire(agentId, { reason }, { idempotencyKey, ifMatch })` | `agents:lifecycle` | `POST /v1/agents/{agentId}/retire` |
| `agents.search(body)` | `agents:read` | `POST /v1/agents/search` |
| `agents.iterateSearch(body)` | `agents:read` | `POST /v1/agents/search`, following `next_cursor` |
| `tagDefinitions.create(body, { idempotencyKey })` | `tags:define` | `POST /v1/tag-definitions` |
| `tagDefinitions.get(namespace, key)` | `tags:read` | `GET /v1/tag-definitions/{namespace}/{key}` |
| `tagDefinitions.list(query)` | `tags:read` | `GET /v1/tag-definitions` |
| `tagDefinitions.iterate(query)` | `tags:read` | `GET /v1/tag-definitions`, following `next_cursor` |
| `agentTags.list(agentId)` | `agents:read` and `tags:read` | `GET /v1/agents/{agentId}/tags` |
| `agentTags.get(agentId, namespace, key)` | `agents:read` and `tags:read` | `GET /v1/agents/{agentId}/tags/{namespace}/{key}` |
| `agentTags.put(agentId, namespace, key, body, { idempotencyKey, ifMatch or ifNoneMatch })` | `tags:write` | `PUT /v1/agents/{agentId}/tags/{namespace}/{key}` |
| `agentTags.delete(agentId, namespace, key, { idempotencyKey, ifMatch })` | `tags:write` | `DELETE /v1/agents/{agentId}/tags/{namespace}/{key}` |
| `capabilities.publish(body, { idempotencyKey })` | `capabilities:write` | `POST /v1/capabilities` |
| `capabilities.get(capabilityId, version)` | `capabilities:read` | `GET /v1/capabilities/{capabilityId}/versions/{version}` |
| `capabilities.list(query)` | `capabilities:read` | `GET /v1/capabilities` |
| `capabilities.iterate(query)` | `capabilities:read` | `GET /v1/capabilities`, following `next_cursor` |
| `endpoints.list(agentId)` | `agents:read` and `endpoints:read` | `GET /v1/agents/{agentId}/endpoints` |
| `endpoints.get(agentId, endpointKey)` | `agents:read` and `endpoints:read` | `GET /v1/agents/{agentId}/endpoints/{endpointKey}` |
| `endpoints.put(agentId, endpointKey, body, { idempotencyKey, ifMatch or ifNoneMatch })` | `endpoints:write` | `PUT /v1/agents/{agentId}/endpoints/{endpointKey}` |
| `endpoints.delete(agentId, endpointKey, { idempotencyKey, ifMatch })` | `endpoints:write` | `DELETE /v1/agents/{agentId}/endpoints/{endpointKey}` |
| `bindings.list(agentId)` | `agents:read` and `capabilities:read` | `GET /v1/agents/{agentId}/capabilities` |
| `bindings.get(agentId, capabilityId)` | `agents:read` and `capabilities:read` | `GET /v1/agents/{agentId}/capabilities/{capabilityId}` |
| `bindings.put(agentId, capabilityId, body, { idempotencyKey, ifMatch or ifNoneMatch })` | `capabilities:write` | `PUT /v1/agents/{agentId}/capabilities/{capabilityId}` |
| `bindings.delete(agentId, capabilityId, { idempotencyKey, ifMatch })` | `capabilities:write` | `DELETE /v1/agents/{agentId}/capabilities/{capabilityId}` |
| `discovery.query(body)` | `agents:read`, `capabilities:read`, and `endpoints:read` | `POST /v1/discovery/agents` |
| `discovery.iterate(body)` | `agents:read`, `capabilities:read`, and `endpoints:read` | `POST /v1/discovery/agents`, following `next_cursor` |

## Use the client in an agent

The directory does not start your agent. You start the agent, and the agent uses `@fad/sdk` to publish its directory record and to read the other agents in its organization.

Ask the administrator for four values and put them in the secret store the agent already uses:

- `FAD_BASE_URL`, the HTTPS URL of the API.
- `FAD_API_KEY`, the key issued to this process.
- `FAD_ORGANIZATION_ID`, the organization id you expect that key to return.
- `FAD_OWNER_PRINCIPAL_ID`, the service principal that owns the agent. You need this only in the process that registers.

Choose the key for the work that process does, using the scopes in the table above. A deploy job that registers the agent holds `organizations:read` and `agents:write`. The running agent holds `agents:read`. An operator tool holds `agents:lifecycle`. When the agent process itself registers on startup, that process holds `agents:write`, and lifecycle stays on the operator tool. The agent never runs `fad-admin` and never opens PostgreSQL.

On startup, wait until the directory is ready, confirm the organization, register once, and then read the live record. Persist `data.id`. On the next start, skip registration and call `agents.get` with the saved id. Registration is safe to retry with the same body and the same idempotency key for 24 hours. It is not a permanent get-or-create: after the idempotency record expires, repeating it creates a second agent.

```ts
import { FadClient } from '@fad/sdk';

const fad = new FadClient({
  baseUrl: process.env.FAD_BASE_URL ?? '',
  apiKey: () => process.env.FAD_API_KEY ?? '',
  userAgentSuffix: 'accounts-payable-agent',
});

export async function joinDirectory(signal: AbortSignal): Promise<{ id: string; globalId: string; etag: string }> {
  const ready = await fad.health.ready({ signal });
  if (ready.status !== 'ready') throw new Error('Directory is not ready');

  const organization = await fad.organizations.current({ signal });
  if (organization.data.id !== process.env.FAD_ORGANIZATION_ID) {
    throw new Error('API key is for a different organization');
  }
  if (organization.data.status !== 'active') throw new Error('Organization is not active');

  const savedId = process.env.FAD_AGENT_ID;
  if (savedId) {
    const current = await fad.agents.get(savedId, { signal });
    return { id: current.data.id, globalId: current.data.global_id, etag: current.etag };
  }

  const registered = await fad.agents.register(
    {
      name: 'Accounts Payable Agent',
      owner_principal_id: process.env.FAD_OWNER_PRINCIPAL_ID ?? '',
    },
    { idempotencyKey: 'register-accounts-payable', signal },
  );
  const current = await fad.agents.get(registered.data.id, { signal });
  return { id: current.data.id, globalId: current.data.global_id, etag: current.etag };
}
```

Save the returned `id` as `FAD_AGENT_ID` before the next start. Publish `globalId` where another system needs a stable name for this agent, and keep `etag` for the next update. When the agent's behavior changes, call `agents.update` with a new idempotency key and that ETag. Leave suspend, activate, and retire to the operator tool unless this process was issued `agents:lifecycle`.

To see the other active agents in the same organization, walk the directory with the read key:

```ts
const peers: { id: string; globalId: string; name: string }[] = [];
for await (const agent of fad.agents.iterate({ status: 'active' })) {
  if (agent.id === process.env.FAD_AGENT_ID) continue;
  peers.push({ id: agent.id, globalId: agent.global_id, name: agent.name });
}
```

That list is the organization's directory. The client does not open a connection to those agents. Your agent uses `id`, `global_id`, `name`, `description`, and `status` to decide what to do next.

To find active agents that declare a capability, call `discovery.query` or `discovery.iterate`. Add `tags:read` when the body includes a tag predicate.

```ts
const matches = await fad.discovery.query({
  capability: { id: 'finance.invoice.match', version: '1.0.0' },
  tags: [{ namespace: 'department', key: 'name', operator: 'eq', value: 'finance' }],
  protocols: ['a2a'],
});
for (const match of matches.data) {
  console.log(match.agent.id, match.endpoint.url, match.availability, match.invocation_authorization);
}
```

`availability` is `not_checked` and `invocation_authorization` is `not_evaluated`. The client does not open `match.endpoint.url`.

## License

This project uses the MIT license. Read the file `LICENSE`.
