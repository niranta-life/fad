# Compatibility and Future-Phase Handoff

## Baseline frozen from previous artifacts

Slice 0 publishes `GET /health/live`, `/health/ready`, `/v1/organizations/current`, machine-key `X-FAD-API-Key`, org/principal/credential/audit/idempotency DB foundation and request envelope. Slice 1 publishes `/v1/agents` CRUD-ish registry, lifecycle endpoints, full agent DTO, `"agent-vN"` ETags, `Idempotency-Key` and signed cursor-based listing. **Do not alter these wire contracts** in Slice 2. The combined OpenAPI artifact includes both plus additive Slice 2 endpoints. Run semantic compatibility checks against the actual service/OpenAPI published in the repository, not merely against planning archives.

The earlier planning files in this conversation contain `Slice1 20261020_001_agents.up.sql` and Slice0 `0001_foundation.up.sql`. Confirm real repository migration names and checksums. Do not blindly apply SQL or rely on filename ordering; use the existing migration runner. Slice 2 migration requires tables/roles and follows their actual applied versions.

## Compatibility assertions

- No new required response properties on `Agent` or `Organization`.
- No existing endpoint changes method, path, auth header, success/error status, pagination, default sorting or ETag format.
- Tag edits do not change `agents.revision` or `"agent-vN"`.
- New agent search endpoint is separate from Slice 1 `GET /v1/agents`. No new interpretation of existing `status`, `limit`, `cursor` queries.
- New `tags:*` scopes are additive; existing key scopes work unchanged.
- New SQL tables have foreign keys to old tables but **do not drop/modify** any old table/column.
- The OpenAPI component-renaming for colliding Slice 0 schema/response names is internal-only; actual JSON behavior remains byte-level semantically identical.
- Source-compatible SDK: existing `client.organizations.current` and `client.agents.register/get/list/update/suspend/activate/retire` unaffected.
- New API paths `/v1/agents/{agentId}/tags/...` must not conflict with existing `/v1/agents/{agentId}` routes.
- Retired-agent tag writes require cross-module serialization; modify internal retirement transaction locking if needed, without changing external Slice 1 semantics.
- Tag governance is coarse scope-based in this slice. Never claim that merely creating `security.risk` automatically enforces payment or invocation authorization.

## Future slices

- Slice 3 Capability and Discovery: merge capability match and optionally tag predicates; reuse tag query module and governance filtering, but don't alter Slice 2 schema semantics.
- Slice 4 MCP: expose read/mutate MCP tools as adapters to the **same** application services and policy gates; no bypasses.
- Slices 5–6 Policy: add explicit issuer assurance/trusted tag decisions; default deny for missing governed data; do not trust arbitrary tags.
- Slice 7 Events: add transactional outbox going forward; immutable tag history supports audited backfill, not automatic exactly-once delivery.
- Slices 11–13 Federation: remote tags are claims, not authority; retain provenance, scope metadata sharing, and require explicit trust before use.
