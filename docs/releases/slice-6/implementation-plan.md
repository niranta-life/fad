# Slice 6 implementation plan

Parent commit is the Slice 5 tip on `develop`. This slice adds a shared Policy Enforcement Point. It does not replace Slices 0–5.

## Contract freeze

- Published OpenAPI `info.version` stays `1.5.0`. The 27 existing path operations stay byte-for-byte identical, including `POST /v1/authorization/evaluate` and `enforcement: not_enforced`.
- The deployed MCP catalog has 21 tools. The package file lists 33 older tools plus four new ones. Those unpublished tools are not added. Four tools are appended: `fad_get_enforcement_config`, `fad_preflight_enforcement`, `fad_set_enforcement_config`, `fad_get_enforcement_decision`.
- `@fad/sdk` stays `0.5.0`. `@fad/mcp-client` stays `0.2.0`. `ENABLED_TOOL_NAMES` stays the Slice 4 list. New scopes are appended after `policies:explain`: `enforcement:read`, `enforcement:manage`, `enforcement:audit`, `policies:attributes:write`.

## Behavior

- `FAD_ENFORCEMENT_CODE_ENABLED=true` turns on routes and the PEP. The default is false. No environment value rewrites a stored `enforce` row to `off`.
- Missing config is synthetic OFF revision 0, ETag `"enforcement-v0"`.
- Legacy authentication, tenant, scope, RLS, and metadata checks run before the PEP. A policy allow never adds a scope.
- The Slice 5 `evaluatePolicies` function is the matcher. Tags, subject, principal, and agent state are loaded by the server.
- OFF keeps the previous response. SHADOW records `would_allow` or `would_deny` and still returns the legacy response. Evaluator or audit failure in SHADOW is logged as `ENFORCEMENT_SHADOW_EVALUATION_FAILED` and does not deny the operation. ENFORCE allows a covered action only on a live allow. A protected read denial is 404 `AGENT_NOT_FOUND`. A same-tenant protected write denial is 403 `POLICY_DENIED`. Matcher, database, audit, pool, or lock failure in ENFORCE is 503 and rolls back the protected success.
- Denied single-object decisions commit through `CommittedDenial` before the denial response. Allowed mutations commit with their decision rows. Collection omissions commit with the page. A scan that cannot fill a page returns 503 `ENFORCEMENT_SCAN_BUDGET_EXCEEDED` and no partial page.
- Transactions take the organization advisory fence (`6816`, `fad_s6_enforcement_key`) before a config, policy, or tag snapshot and before an agent row lock. Tag and policy status writes take the exclusive fence first. There is no instantaneous revocation of an agent that is already outside this directory.
- An old image does not set `fad.pep_generation=6`. A restrictive RLS policy hides `agents` rows while that tenant's mode is `enforce`.

## Covered operations

Protected operation ids and actions are `getAgent` `agent.read`; `listAgents`, `searchAgentsByTags`, and `discoverLocalAgents` `agent.discover` and `agent.read`; `updateAgent`, `activateAgent`, `retireAgent`, tag put/delete, endpoint put/delete, and binding put/delete `agent.update`; `suspendAgent` `agent.suspend`; tag, endpoint, and binding reads `agent.read`. `registerAgent` stays on `agents:write`. `agent.invoke` is not enforceable. Policy management, enforcement config, evaluation, catalog publish, organization, OAuth metadata, and health stay on the existing ACL.

## Files

- `db/migrations/20261021_006_policy_enforcement.up.sql` and a development-only `.down.sql` that production does not run
- `packages/db/src/enforcement.ts` plus call sites in agents, tags, slice 3, and policies
- `packages/contract` error codes, `packages/auth-core` scopes, `contracts/openapi.yaml` additions
- `apps/api` config, routes, and four MCP tools
- `packages/sdk` `client.enforcement` methods and `PolicyDeniedError`
- tests and `docs/releases/slice-6/` evidence

## Verification

Run the contract comparison, two-tenant HTTP journey, migration RLS checks, MCP OAuth client, separate SDK install, and the historical `npm test` suite. Record command output. A case that does not run is NOT RUN. R19 is the successful Actions `pull_request` run whose headSha equals `git --no-replace-objects rev-parse HEAD`. This blob does not store the run id or the commit id. The workflow file is on the default branch and is not in this commit.

## Risks

- Package MCP count 33 versus deployed 21. Frozen as 21 plus four.
- Local PostgreSQL `fad-s0-pg` has no TLS. A production boot against that database refuses to start. The passing TLS boot is `deployment-evidence/prod-tls-f3a44c87.log` at 2026-10-22T06:27:50Z.
- One process cannot prove every remote replica is Slice 6. Preflight fails when `FAD_ENFORCEMENT_OLD_PODS=true`. The database generation gate hides enforced tenants from old images. Multi-replica admission beyond the local two-replica test is an operator procedure.
- ENFORCE conceals suspended and retired agents on `getAgent` because the matcher returns `RESOURCE_INACTIVE`. Recovery is OFF or SHADOW.
- p95 figures are targets until a measured sample is recorded.
- A commit cannot contain its own object id. `completion.md` records the id only when `git --no-replace-objects rev-parse HEAD` equals it.

## Recorded verification

The execution record is `completion.md`. Measured samples are listed there. R19 is the successful Actions `pull_request` run whose headSha equals `git --no-replace-objects rev-parse HEAD`. This blob does not store the run id or the commit id.
