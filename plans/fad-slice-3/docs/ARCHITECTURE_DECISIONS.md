# Slice 3 decisions and deferred work

| ADR | Decision | Reason / invariant |
|---|---|---|
| S3-001 | Capability versions are immutable within an organization | Avoid changing published action contracts and confusing existing consumers. |
| S3-002 | Each agent binds at most one version of a capability ID at a time | Makes discovery deterministic in Slice 3; versioning remains in catalog. |
| S3-003 | A binding must name one endpoint belonging to the same agent | Prevents returning an agent with no mapped transport endpoint for its advertised capability. |
| S3-004 | Endpoints are metadata only, never probed by directory | Avoids SSRF, runtime coupling and false availability claims. |
| S3-005 | Discovery returns `self_declared`, `not_checked`, `not_evaluated` | Separates discovery from trust, liveness and authorization. |
| S3-006 | Tag filters reuse Slice 2 TagPredicate semantics | No conflicting duplicate DSL; restricted tags remain protected. |
| S3-007 | Independent endpoint and binding ETags / tombstones | Prevents stale writes and preserves Slice 1 Agent/2 Tag ETags. |
| S3-008 | RLS + tenant-qualified FK + service checks | Defense-in-depth across layers and pool reuse. |
| S3-009 | Strictly additive OpenAPI and SDK changes | Existing clients must remain compatible. |
| S3-010 | Read-only discovery uses POST without idempotency key | Allows structured bounded filters without claiming a mutation. |
| S3-011 | URL must be HTTPS DNS host with no query/userinfo/fragment | Prevents publishing accidental credential URLs; no remote calls. |
| S3-012 | No per-endpoint private visibility in Slice 3; explicit read scope required | More restrictive read permission keeps initial model simple; can later add individual visibility as additive metadata. |

**Future considerations:** semver range negotiation, deprecation, verified attestation, capability provenance trust, endpoint health, delegation, global federation, indexing, signatures and A2A card integration. None must be simulated or promised as implemented here.
