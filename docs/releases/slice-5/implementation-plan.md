# Slice 5 implementation plan

The normative package is `plans/fad-slice-5/`. It is not the build root. The shipped code follows the existing service, error, and migration boundaries.

## Requirements to files

| Requirement | Files |
| --- | --- |
| Flag default off; prior routes unchanged | `apps/api/src/config.ts`, `apps/api/src/app.ts`, `tests/fixtures/slice4-baseline.json`, `tests/slice5-baseline.test.mjs` |
| Seven REST operations, strong ETags, idempotency, payload limit | `apps/api/src/policy-routes.ts`, `contracts/openapi.yaml`, `packages/contract/src/generated.ts`, `packages/contract/src/envelopes.ts` |
| Typed compiler and deny-overrides matcher | `packages/db/src/policy-rules.ts`, `tests/policy-rules.test.mjs` |
| Lifecycle and one decision row per returned evaluation | `packages/db/src/policies.ts` |
| Additive migration, FORCE RLS, `fad_app` grants | `db/migrations/20261021_005_policy_evaluation.up.sql` through `apps/migrator` |
| Seven MCP tools on the same service | `apps/api/src/mcp-catalog.ts`, `apps/api/src/mcp-tools.ts`, `packages/mcp-client/src/index.ts` |
| Additive SDK methods | `packages/sdk/src/index.ts` at 0.5.0 |
| Image and Compose default off | `deploy/docker/Dockerfile`, `deploy/docker/compose.yaml`, `deploy/k8s/policy-overlay.yaml`, `.env.example` |
| Journey, isolation, MCP, SDK, faults | `tests/slice5.test.mjs`, `tests/slice5-proof.test.mjs` |

## Risk register

| Risk | Handling |
| --- | --- |
| A prior contract change would hide a Slice 0–4 break | Frozen `tests/fixtures/slice4-baseline.json`. The comparison test deep-equals each baseline operation. |
| Evaluation could be treated as invocation | Response field `enforcement` is `not_enforced`. SDK has no `invokeAgent`. Existing routes do not read decisions. |
| Restricted tag values could leak | Server-resolved Slice 2 assignments. Reads, explanations, and idempotency replay hide a restricted policy without `tags:restricted:read`. Decision rows store digests, not tag values. |
| A failed decision insert could still return allow | Insert and snapshot share one transaction. Insert failure and engine failure return 503. |
| Active policy count could grow without a bound | Activation takes a transaction advisory lock and returns 409 `CONFLICT` at 256. Evaluation returns 503 when it sees more than 256. |
| Migration on API startup | Not done. Readiness only checks the checksum. The migrator applies `*.up.sql`. |
| Package OpenAPI names differ from the published contract | Additive reconciliation. See `api-contract-diff.md`. |
| No GitHub Actions in this repo | CI run ID stays unset. |
| `kubectl` overlay has no cluster | The overlay is documented. Live apply is BLOCKED. |
| p95 of 100 ms | A target. A measured profile is recorded separately or left BLOCKED. |
