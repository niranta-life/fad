# Slice 6 architecture decisions

## Contract

Published OpenAPI `info.version` stays `1.5.0`. The frozen Slice 5 document has 27 paths and 41 operations. Those operations deep-equal the live document. The live document adds three paths and four operations: `GET/PUT /v1/enforcement/config`, `POST /v1/enforcement/preflight`, and `GET /v1/enforcement/decisions/{decisionId}`. Live operation count is 45.

The deployed MCP catalog has 21 tools. The package file lists 33 older tools. Those unpublished tools are not added. Four tools are appended when `FAD_ENFORCEMENT_CODE_ENABLED` is the exact string `true`: `fad_get_enforcement_config`, `fad_preflight_enforcement`, `fad_set_enforcement_config`, and `fad_get_enforcement_decision`. With policies and enforcement enabled and full scopes, `tools/list` returned 25 tools.

`@fad/mcp-client` `ENABLED_TOOL_NAMES` stays the Slice 4 list of 14 names. The new tools are called with the official MCP client.

The published search operation id remains `searchAgentsByTag`. The internal map name is `searchAgentsByTags`. The coverage test aliases the published id. The published id is not renamed.

## Enforcement point

Legacy authentication, tenant context, scoped ACL, row security, and metadata visibility run before the policy check. A policy allow does not add a missing scope. The subject is the authenticated principal. `X-Organization-Id` and tool arguments do not select the tenant. Tenant context is `set_config('fad.org_id', ...)`.

The matcher is the Slice 5 `evaluatePolicies` function. Tags, subject, principal, and agent state are loaded by the server.

OFF is the missing-config default and keeps the previous successful response. SHADOW evaluates with the real principal and records `would_allow` or `would_deny`. Evaluator or audit failure in SHADOW logs `ENFORCEMENT_SHADOW_EVALUATION_FAILED` and keeps the previous response. A Postgres outage still returns 503 because the old operation cannot run.

ENFORCE grants a covered action only on a live allow. A protected read denial is 404 `AGENT_NOT_FOUND`. The MCP tool maps that concealment to `NOT_FOUND`. A same-tenant protected write denial is 403 `POLICY_DENIED`. Matcher, database, audit, or lock failure in ENFORCE is 503. There is no decision cache and no environment switch that rewrites a stored `enforce` row to `off`.

`agent.invoke` is rejected on the configuration body. Agent creation, policy management, the capability catalog, enforcement configuration, public evaluation, organization introspection, OAuth metadata, and health stay on the existing ACL.

A disabled principal is rejected with 401 before the enforcement point. Activating a suspended agent while `agent.update` is enforced returns 403 `POLICY_DENIED`, because the matcher treats a non-active agent as inactive before an allow matches. Recovery is OFF, SHADOW, or a configuration that omits `agent.update`.

## Rollout

SHADOW and ENFORCE require a 10-minute, single-use, tenant-bound, principal-bound preflight. The configuration write requires `If-Match: "enforcement-vN"` and an idempotency key. ENFORCE also requires `acknowledge_default_deny: true` and a current policy snapshot digest. OFF does not require a preflight. OFF still requires the current ETag, an idempotency key, a reason, an audit row, and a committed revision. A preflight id on an OFF body is 422.

The reason stored for audit is `sha256(JSON.stringify(reason))`. The reason text is not stored in the audit details.

## Fence and schema

Transactions set the tenant and take the organization advisory fence, class `6816`, key `fad_s6_enforcement_key(org)`, before the policy snapshot and before an agent row lock. Configuration, policy status, and tag writes take the exclusive fence first. HTTP and MCP use the same service. A hash collision reduces concurrency. It does not authorize another tenant.

A fence timeout returns 503 `DEPENDENCY_UNAVAILABLE` in OFF, SHADOW, and ENFORCE. The service does not read the mode without the fence. It does not skip the policy check or the referenced-tag guard. A protected read or a tag write that loses the fence cannot commit after another transaction enables ENFORCE.

Denied decisions commit before the denial response. There is no instantaneous revocation of an agent that is already outside this directory.

A non-replay agent update, lifecycle change, endpoint write, or binding write locks the agent row with `FOR UPDATE` before the enforcement decision insert. The decision foreign key takes `KEY SHARE`. Inserting the decision first and then upgrading to `FOR UPDATE` deadlocks two writers. A replay still evaluates the current policy before it returns the stored result, so a later deny stays 403.

SIGTERM marks the listener draining and then terminates this process's non-idle Postgres backends. The application name is `fad-api-<pid>`, so one replica does not cancel another. Those transactions roll back. Fastify closes with `forceCloseConnections` set to true. Close and pool shutdown each wait at most 2 seconds, and the process then exits 0. A keep-alive client cannot hold an open mutation through shutdown.

Migration `20261021_006_policy_enforcement` is additive. The four new tables use `FORCE ROW LEVEL SECURITY`. `fad_app` can insert decisions and revisions and cannot update or delete them. Preflight update is limited to `used_at`. The down script is not applied in production.

A restrictive policy `fad_s6_agent_pep_generation` hides a tenant's `agents` rows while that tenant is ENFORCE unless the transaction sets `fad.pep_generation` to `6`. Current code sets that value when the code flag is true. An old image and a flag-off process do not, so they cannot read that tenant. A tenant that is not ENFORCE is unchanged. One tenant in ENFORCE does not hide another tenant.

## Collections and tags

List, tag search, and discovery filter candidates before the page and the cursor are built. The cursor is bound to the tenant, caller, filter, mode, and configuration revision. A scan that cannot fill a safe page returns 503 `ENFORCEMENT_SCAN_BUDGET_EXCEEDED`. SHADOW collections keep the legacy page and record decisions for the returned members.

ENFORCE preflight blocks an active policy for a selected action when a selector uses a tag that is not governed and restricted. SHADOW records that condition as a warning. While ENFORCE includes `agent.update`, a write to a tag referenced by an active selected policy also requires `tags:governance` and `policies:attributes:write`. Ordinary tags stay on `tags:write`. Activating an ungoverned selector for an enforced action returns 409 `CONFLICT`.

## Deployment

The image and the compose overlay default `FAD_ENFORCEMENT_CODE_ENABLED` to false. The local proof used two replicas of `fad-api:slice6`, the one-shot migrator command `node apps/migrator/dist/main.js up`, the Slice 5 image as the old image, and a paused Postgres. `kubectl apply` is not the Docker gate. The 2026-10-22T05:39:36Z command found no cluster. `fad-s0-pg` has no TLS, so production mode exits against it. A separate Postgres with TLS accepted image `sha256:f3a44c87cf53cc184600db7dc07a0e348a6256740ff3839bc7d98f838082e3fc` at 2026-10-22T06:27:50Z. The API role was `fad_app`. The process used `sslmode=require`, `FAD_INGRESS_TLS=terminated`, and `FAD_TRUST_PROXY=true`. The session was TLSv1.3. The image still refuses production mode when `sslmode` or `FAD_INGRESS_TLS=terminated` is missing.

Image `fad-api:slice6` id `sha256:f3a44c87cf53cc184600db7dc07a0e348a6256740ff3839bc7d98f838082e3fc` was created at `2026-10-21T23:12:41.848694143-07:00`. It was built from this commit's runtime tree. The commit id is the output of `git --no-replace-objects rev-parse HEAD`. This blob does not copy that id. The parent is `27a3f2874e8fbaa256ac88ab982904ae2ee26cdd`. This image contains the fence-timeout fail-closed code. `packages/db/dist/enforcement.js` contains `A timeout is 503 in every mode` and does not contain `s6_skip_pep`. The image user is `node`. `packages/db/dist/agents.js` contains the row lock before the decision insert. `apps/api/dist/main.js` contains `pg_terminate_backend`. The previous id `sha256:e5861d49221dc9d4598c67e521f70720f3f6a50aba4ab388fe965eff907e2473` does not contain the fence-timeout fail-closed code. The earlier local id `sha256:38d932df2039c17ed7a07b94e89e6f9de667416d9102ad4b792b845ca1c4f150` does not contain the row lock or the shutdown cancel. The image was not pushed to a registry.
