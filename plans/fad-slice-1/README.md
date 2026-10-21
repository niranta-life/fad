# FAD Slice 1 — Agent Registration Specification Package

**Design-only deliverable.** No backend service, SDK, database migration, or deployment has been executed in a live FAD repository. Files are proposed implementation inputs to integrate with the actual Slice 0 codebase.

## Contents

- `docs/SPECIFICATION.md` — full requirements, contracts, architecture, threat cases, SDK, Docker, tests, proof criteria.
- `docs/GROK_GOAL.md` — standalone `/goal` prompt for Grok Code.
- `contracts/openapi.yaml` — self-contained proposed OpenAPI 3.1 contract for 7 agent operations.
- `migrations/20261020_001_agents.up.sql` — proposed additive SQL migration with tenant RLS.
- `migrations/20261020_001_agents.down.sql` — guarded development-only rollback, refuses when any data exists.
- `verification/acceptance-smoke.sh` — integration test for a *running implementation* with two provisioned organizations.
- `verification/validate-contract.py` — basic YAML/ref/operation consistency check (not a substitute for full OpenAPI validation).

## Validation performed on these design artifacts

```bash
python verification/validate-contract.py
bash -n verification/acceptance-smoke.sh
```

Do **not** apply migrations without checking existing Slice 0 `organizations`, `principals`, app role, audit/idempotency implementation, scopes, and auth header assumptions. Reconcile new contract additively before freezing.

## Acceptance smoke prerequisites (after implementation)

```bash
export FAD_URL='http://localhost:8080'
export FAD_KEY_A='[organization A scoped credential]'
export FAD_KEY_B='[organization B scoped credential]'
export FAD_OWNER_A='[active principal UUID in A]'
./verification/acceptance-smoke.sh
```

Values shown in brackets are placeholders, not actual secrets. Never commit real credentials or runtime proof containing secrets.
