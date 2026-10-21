# Slice 2 Docker / Kubernetes Deployment and Recovery

## Build

Use the existing Slice 1 Dockerfile, base image lock, unprivileged UID, production dependency install, immutable image digest, vulnerability scan and health checks. No new runtime container is required. Use the existing PostgreSQL service/managed instance and a separate one-shot migrator role. Do not put DB owner secrets into API container env.

Suggested configuration additions, applied through existing config validator:

```
FAD_TAGS_ENABLED=false
FAD_TAG_MAX_PER_AGENT=64
FAD_TAG_DEFINITIONS_MAX_PER_ORG=256
FAD_TAG_SEARCH_MAX_PREDICATES=8
FAD_TAG_SEARCH_MAX_LIMIT=100
FAD_TAG_WRITE_BODY_MAX_BYTES=16384
```

These must be bounded by server-compiled ceilings: admins may lower, not silently raise. Credentials and cursor signing secrets supplied using existing secret manager; no new hard-coded secrets or insecure defaults.

## Upgrade order (expand then enable)

1. Confirm Slice 0/1 production backups/PITR, migrations and tests. Capture old image digest and OpenAPI contract snapshot.
2. Apply additive SQL migration via existing migrator using DB advisory lock and recorded SHA256 checksum. Preflight all table/role dependencies. Never run migrations from API startup or a multi-replica boot path.
3. Deploy new API image with tag routes disabled. Existing Slice 0/1 routes and SDK functions continue serving traffic; check old contract tests.
4. Enable Slice 2 for one test organization using existing tenant feature-flag framework, or global toggle if tenant flags do not exist yet. Do not introduce an unsafe runtime tenant selector.
5. Use `verification/acceptance-smoke.sh` with real tenant-scoped credentials, check DB and security matrix. Gradually expand.
6. Watch HTTP error rates (401/403/412/429/5xx), DB lock waits, definition count, assignment count, p95 tag lookup/search latency, audit write failures, migration checksums, memory and CPU.

## Health/readiness

`/health/live` remains minimal and unchanged. `/health/ready` checks DB reachability, minimum compatible schema; when tag endpoints are enabled it must check the tag migration is applied. It must not disclose internal database error messages or secrets.

## Rollback

- Immediate: disable `FAD_TAGS_ENABLED`, remove tag-write scopes from affected credentials if security risk, then deploy previous image. **Leave new tables and rows untouched**; old code ignores them.
- Do not run `down.sql` on production data. The down migration is destructive and exists for ephemeral developer/test databases only.
- For data corruption, stop affected mutation routes, preserve evidence, restore with audited PITR procedure or correct through an additive migration; quantify potential unrelated writes before PITR.
- Restart test: API replicas restart without losing PostgreSQL state. Test migration restart/crash recovery and verify exactly one recorded checksum/version.

## Failure semantics

- DB outage: return 503; never return success for writes or governed reads based on stale cache.
- Audit insert failed: abort tag transaction; return controlled error.
- Concurrent conditional writes: exactly one succeeds, the other 412 (unless same idempotency key and same fingerprint -> replay).
- Supplied tenant header/query is ignored for selecting organization and should be rejected if recognized as an unauthorized selector.
- Return `Cache-Control: private, no-store` on all protected tag API responses. TLS mandatory outside local development.
