# Handoff contract: Slice 0 → Slice 1 registration

The previously prepared Slice 1 agent-registration specification expects these stable prerequisites from the foundation:

| Interface | Slice 0 obligation | Slice 1 reliance |
|---|---|---|
| Auth header | `X-FAD-API-Key` | Used by all protected agent routes |
| Authenticated request context | `{organizationId,principalId,scopes,requestId}` | Agent creator and updater derived from principal |
| Scopes | `organizations:read`, plus reserved `agents:read`, `agents:write`, `agents:lifecycle` | Authorize each agent operation |
| DB table | `organizations(id uuid PRIMARY KEY)` | `agents.organization_id` FK |
| DB table | `principals(organization_id uuid,id uuid)` with unique `(organization_id,id)` | Composite owner/creator/updater FKs |
| DB role | `fad_app` no DDL, no BYPASSRLS | Agent tables use `TO fad_app` RLS policies |
| RLS setting | transaction-local `fad.org_id` | Agent queries use same setting |
| Idempotency | `idempotency_records`, scoped per org/principal/method/path/key | Registration and mutations store same result once |
| Audit | `audit_events` append-only | Atomic agent mutation and audit event |
| Success envelope | `{data,meta:{request_id,api_version:'v1'}}` | Same structure for agents |
| Error envelope | `{error:{code,message},meta:...}` | Same structure for agents |
| API versioning | `/v1` | Add agent paths, do not change existing routes |
| SDK | `new FadClient(...)`, `health.*`, `organizations.current()` | Add `agents.*` without changing existing types |

## Compatibility procedure

1. Before Slice 0 implementation, inspect Slice 1 package and preserve the prerequisites above.
2. Do not make organizationId a caller-supplied query, body, path or auth-scoping header.
3. Add only new routes, tables, scopes and SDK methods in Slice 1. `GET /v1/organizations/current` remains unchanged.
4. Test Slice 1 migration against a real Slice 0 database with both organizations and principals provisioned.
5. Run the old Slice 0 SDK against the new Slice 1 server and keep its golden tests passing.
6. If a necessary deviation emerges, document a compatibility exception before shipping the first version, not after old clients exist.

## Deliberate exclusions

- A bootstrap principal is not an agent identity.
- `fad_live` API key is a service credential, not a federated cross-organization delegation.
- A caller's `agents:write` scope is not authority to mutate a different organization's agent.
- Tags, delegated authority, policy evaluation and federation are future additive slices.
