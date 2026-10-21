# REST/SDK compatibility and evolution rules

This file forms the baseline for every future Slice 1+ OpenAPI compatibility review.

## Required guarantees within `/v1`

1. Do not change `X-FAD-API-Key` authentication behavior or silently switch to a different header. New authentication schemes must be additive and explicit, not a forced migration.
2. Do not rename/delete fields, change field types, change casing, change response or error envelope, or mutate HTTP status semantics.
3. Do not introduce new required request fields for existing operations; add optional fields with safe defaults.
4. Do not tighten existing request validation without a security exception and compatibility review.
5. Preserve canonical error codes and security/privacy properties. Never sacrifice access control to API compatibility.
6. SDK consumers should ignore new response properties and safely handle unrecognized enum values for newly extended endpoints.
7. Keep `/health/live`, `/health/ready` and `/v1/organizations/current` available. Health is intentionally unauthenticated but reveals no internals.
8. Additive APIs for Slice 1 can reuse auth scopes and error convention; generated SDK changes must not change existing method signatures.
9. Breaking changes require a distinct `/v2` contract and published migration/deprecation policy.
10. CI checks OpenAPI diff, compiles compatibility fixtures for previous SDK versions, and runs golden HTTP tests against every supported released major version.

## Commit gate

Require OpenAPI 3.1 parse+resolution+semantic lint, request and response schema tests, unit tests, real PostgreSQL integration suite, static analysis, package lock reproducibility, and credential/tenant-negative tests. A new SDK release must test with previously supported server release fixtures.
