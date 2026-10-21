# Federated Agent Directory — Slice 2: Typed Tags

**Production-oriented implementation specification package.** This is **not** a server implementation and has not passed runtime tests.

## Primary artifacts

| File | Purpose |
|---|---|
| `{pwd}/plans/fad-slice-2/docs/SPECIFICATION.md` | Architecture, exact behavior, canonical model, security, discovery, reliability and rollout |
| `{pwd}/plans/fad-slice-2/contracts/openapi.yaml` | Combined additive OpenAPI 3.1 specification for Slices 0–2 |
| `{pwd}/plans/fad-slice-2/contracts/slice2-paths-review.yaml` | Review-only list of newly added paths (not a standalone contract) |
| `{pwd}/plans/fad-slice-2/migrations/20261020_002_typed_tags.up.sql` | Additive PostgreSQL 16+ migration (to be wrapped by existing runner) |
| `{pwd}/plans/fad-slice-2/migrations/20261020_002_typed_tags.down.sql` | Destructive **development-only** teardown, prohibited for production rollback |
| `{pwd}/plans/fad-slice-2/sdk/SDK_CONTRACT.md` | Node.js/TypeScript API design and compatibility notes |
| `{pwd}/plans/fad-slice-2/verification/TEST_MATRIX.md` | 79 named acceptance/security/reliability tests |
| `{pwd}/plans/fad-slice-2/verification/acceptance-smoke.sh` | Real-API user-journey smoke script (requires server, configured users) |
| `{pwd}/plans/fad-slice-2/examples/api-examples.md` | Illustrative HTTP requests/responses |
| `{pwd}/plans/fad-slice-2/deploy/OPERATIONS.md` | Docker deployment, migration, rollback, failure handling |
| `{pwd}/plans/fad-slice-2/docs/COMPATIBILITY_HANDOFF.md` | Required compatibility checks and next-slice handoff |
| `{pwd}/plans/fad-slice-2/docs/GROK_GOAL.md` | Standalone Grok Code `/goal` implementation prompt |

## Implementation sequence

1. Freeze and compare actual Slices 0/1 contracts in the repository.
2. Apply additive migration through existing transactional runner and lock.
3. Implement tag definition and assignment modules using shared authentication, tenant-scope transaction, idempotency and audit infrastructure.
4. Add read-only tag-based agent search and TypeScript SDK methods.
5. Run DB/API/SDK/container/negative tests with stored evidence.
6. Deploy with `FAD_TAGS_ENABLED=false`; enable for an authorized test organization and verify; roll out gradually.
7. Commit one focused verified slice. Do not start policy engine, MCP, or federation here.

**No runtime verification was performed while preparing this package.** OpenAPI parse/reference checks and shell syntax checks are static only; real PostgreSQL, API, SDK and container validations are mandatory before production use.
