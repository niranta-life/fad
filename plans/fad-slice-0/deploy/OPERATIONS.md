# Deploy and operations runbook — Slice 0

## Production topology

- At least two stateless app replicas behind TLS-enforcing ingress, health-gated rollout. Do not expose DB to public network.
- HA Postgres with PITR backups, capacity-monitored connection pool, encrypted links and storage.
- Separate identity for DB migrator; use externally reviewed DB role bootstrap. Never embed migrator/DBA credentials in app container.
- Distributed auth rate limiting at ingress and/or shared protected store. Per-process only is explicitly development-only.
- Metrics, logs and traces transported with TLS to authorized sinks; redact API keys, verifiers and raw principal secrets before serialization.
- Secrets injected at runtime; no secrets in `docker build`, Git, printed `docker inspect` outputs, public CI artifacts, or commits.
- Pin immutable OCI image digests. Perform SBOM, dependency, image and secret scanning before promotion.

## Local environment outline

1. Provision dev Postgres with `deploy/docker/compose.yaml`; supply explicitly named local development secret vars without committing them.
2. Execute roles SQL as DBA in a controlled SQL session (`deploy/postgres/00_roles.sql`).
3. Provision a scoped `fad_app` DB login; issue an independent privileged migrator identity.
4. Run the migration framework to apply `migrations/0001_foundation.up.sql` and insert its SHA-256 checksum in `schema_migrations` atomically; prevent double-run.
5. Use offline CLI commands in the implemented service to create organizations A/B, service principals and credentials. Keep issued keys only in secret store.
6. Start API; `curl -fsS http://127.0.0.1:8080/health/live`; readiness should be ready after migration.
7. Execute `verification/acceptance-smoke.sh` with A/B organization IDs and credentials set in environment.
8. Run integration suite and role/RLS negative test under the actual `fad_app` DB identity.

## Critical CLI contract (offline admin only)

All commands below are proposals the implementation must supply. They do **not** travel through the REST API.

```sh
fad-admin organization create --name 'Org A'
fad-admin principal create --organization-id <uuid> --type service --name 'Service A'
fad-admin credential issue --organization-id <uuid> --principal-id <uuid> --scopes organizations:read
fad-admin credential revoke --organization-id <uuid> --kid <kid> --reason rotation
fad-admin credential list --organization-id <uuid>  # Never prints verifier or secret
fad-admin organization suspend --organization-id <uuid> --reason incident
```

Enforce explicit environment and role guardrails. The CLI must record audit entries in the same DB transaction as changes. It must never accept an org ID that mismatches a principal, and never print a raw secret except once at issue time. A privileged operator can issue credentials, but neither an ordinary `fad_app` login nor HTTP API caller can.

## Credential rotation / incident response

- Planned rotation: issue successor with minimum scopes, place in authorized secret store, update consumer and verify, revoke predecessor, audit the transition and test 401 across all replicas.
- Lost key: immediately revoke using admin path; rotate downstream integration credentials if compromise impact warrants; inspect redacted audit and access logs; do not reveal whether a stolen key exists to unauthenticated callers.
- Pepper rotation: add a new version, keep older version available only during audited migration window, reissue credentials or controlled verifier migration. Failure to locate a configured pepper is a **startup error**, never an auth bypass.

## Restore + migration

- Back up Postgres with PITR and test full restore in an isolated environment. Verify organizations, principals, credential statuses, audit event consistency, and migration checksum after restore. Avoid restoring secrets to lower-trust environments.
- Schema migration failure: fail readiness and rollout; never auto-drop tables. See `migrations/ROLLBACK.md`.
- Version skew: older app replicas must work with expanded schema; phase rollouts with compatibility tests.

## Suggested alerts

High 5xx/503, DB pool exhaustion, migration mismatch, auth spikes, rate limiter unavailable, audit write error, stale backups, failed restoration drills, elevated latency, exposed header in log tests.
