# Slice 3 deployment and operations runbook

## Dependencies and images

Use the **existing** Slice 0–2 API application image, Node.js LTS and PostgreSQL 16+; build once into immutable digest-addressed OCI image. The runtime image contains compiled JavaScript, runtime dependencies and health endpoints; runs as non-root and has no shell or secrets if distroless deployment is supported. Preserve the app's image entrypoint and existing `Dockerfile`, compose and Kubernetes manifests. Use a **separate migrator identity** and immutable migration bundle. The SQL file here is a specification artifact, not an independent runnable application.

Required environment settings (names should map to existing config; do not rename breaking settings):

| Setting | Purpose |
|---|---|
| `DATABASE_URL` | existing runtime `fad_app` DB connection via secret manager |
| `FAD_SLICE3_ENABLED` | feature flag, false until migration and canary tests pass |
| `FAD_DISCOVERY_CURSOR_HMAC_SECRET` | 256-bit signing material supplied through secret manager; rotate with key IDs |
| `FAD_MAX_DISCOVERY_LIMIT` | 50 maximum |
| `FAD_DISCOVERY_QUERY_TIMEOUT_MS` | bounded SELECT deadline, recommended 1500 initially |
| `FAD_REQUEST_MAX_BYTES` | endpoint-specific route body caps enforced at HTTP layer |
| Existing auth, rate limits, audit, trace config | retain without change |

Do NOT log database DSNs, credential materials or signing keys. Runtime must refuse Slice 3 feature enablement without expected schema migration checksum; liveness may remain up while readiness fails or compatibility routes remain functional, per established deployment policy.

## Step-by-step rollout

1. Record currently deployed API digest, OpenAPI hash and DB migration versions. Run current Slices 0–2 regression suites. Confirm backups and point-in-time restore policy; carry out a restore rehearsal into isolated environment.
2. Validate bundled combined OpenAPI contract against the actual deployed baseline. New paths/components only. Review indexes and SQL query plans on realistic sample data; validate schema size and URI guards.
3. Acquire migration lock with the existing privileged migration job. Run `20261020_003_capabilities_discovery.up.sql` plus SHA256 entry in `schema_migrations` in a single transaction. Verify `FORCE ROW LEVEL SECURITY`, expected grants, foreign keys and tables on all replicas. Do NOT execute app startup migration.
4. Deploy new OCI image to canary or staging with `FAD_SLICE3_ENABLED=false`. Check Slices 0–2 and startup/readiness. Increase replicas to >=3 and verify stateless behavior.
5. Enable Slice 3 for a test organization; run independent SDK user journey, acceptance smoke, RLS SQL tests, negative auth, concurrency, replay and rollback simulation.
6. Enable staged rollout; watch p95 latencies, DB pool saturation, lock waits, failed input guards, unusual discovery traffic and denied scope counts. Set explicit thresholds before deployment; automatic canary abort on major regression.
7. Make feature available generally only after evidence and signoff; record image digest, migration checksum, smoke output and committed Git hash.

## Container example (illustrative overlay only)

`deploy/docker-compose.slice3.example.yaml` assumes the existing base Compose services are called `api` and `postgres`; adapt rather than replacing baseline deployment. It adds a health gate and feature flag, but **does not** create the required services, secret stores, or migration runner. Do not use it as a standalone production deployment manifest.

## Failure and rollback

- If database migration fails, roll back its entire transaction, inspect error without logging secrets and leave old API available.
- If new app fails after migration, redeploy last verified application image with feature disabled, leave the additive Slice 3 tables in place. Do not drop data. Re-test existing `/v1` behavior.
- If auth, RLS, restricted tags or cursor integrity fail, disable Slice 3 immediately and investigate; no unsafe fallback to unfiltered discovery.
- Database outage: return 503, fail closed, do not return stale authorization-like results. Reads may be retried by SDK within bounded deadline; writes replay only with idempotency keys.
- Point-in-time recovery: restore into new DB and verify sequence of migrated schema and audit history before traffic cutover; do not silently fill missing data with defaults.
- Key rotation: retain previous cursor HMAC key until its maximum 15-minute TTL expires unless emergency revocation invalidates cursors. Credentials use Slice 0 rotation rules.

## Performance and scaling

- Prepared and parameterized SQL, tenant-qualified predicates, `LIMIT+1`, signed cursor keyset, and RLS. Limit predicates to 8, body size and schema complexity; reject invalid inputs before expensive DB work.
- Index `(organization_id, capability_id, version, agent_id)` supports bindings; endpoint/agent and tag partial indexes already tenant-qualified.
- Start without Redis or Elasticsearch. Add replicas based on latency and CPU. Keep PostgreSQL authoritative; introduce asynchronous search projection only after measured need and documented freshness semantics.
- Verify no RLS context survives reuse of a pooled connection across tenants by interleaving concurrent requests in automated tests.
- Metrics require request ID, route, result, duration, DB query timings, and audit references. Redact private endpoint URLs and governed tag values from low-trust metrics/logging.

## Evidence to store

Under `docs/releases/slice-3/` produce real: `goal.md`, `plan.md`, `api-contract-diff.json`, `migration-checksum.txt`, `schema-proof.txt`, `api-evidence/`, `security-evidence/`, `sdk-evidence/`, `container-evidence/`, `load-evidence/`, `rollback-evidence/`, `risks.md`, `completion.md`. Attach sanitized HTTP responses, DB verification query results, test commands/output, image digests and CI identifiers. No assertions of passed tests without evidence.
