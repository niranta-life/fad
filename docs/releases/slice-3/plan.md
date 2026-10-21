# Slice 3 plan

## Reconciliations

The package under `plans/fad-slice-3/` is a design input. Shipped Slices 0–2 win where they disagree.

- Migration file `20261020_003_capabilities_discovery.up.sql` sorts before shipped `20261021_001_typed_tags.up.sql`. The applied version is `20261022_001_capabilities_discovery`. The SQL objects match the package. Shipped migration files are unchanged. There is no production down script.
- Served OpenAPI stays the shipped document plus new paths and components. Package copies of Agent, ErrorResponse, tag schemas, and `ApiKeyAuth` are not applied. New `Conflict`, `NotFound`, and `Unavailable` responses use shipped `ErrorResponse`. `info.version` is `1.3.0`.
- `scripts/openapi-diff.mjs` compares operations with parent `400c531d98685f8c93481ed3e527498c7b9d6fb3`. `added_operations` remains the Slice 2 tag routes so the existing compatibility check stays true. Slice 3 routes are `slice3_operations`.
- New scopes are `capabilities:read`, `capabilities:write`, `endpoints:read`, and `endpoints:write`. Existing credentials do not gain them.
- `FAD_SLICE3_ENABLED` defaults to false. Exact string `true` enables routes. Readiness then requires migration `20261022_001_capabilities_discovery`.
- Cursor HMAC reuses `FAD_API_KEY_PEPPER_V1`. Discovery and catalog cursors expire after 15 minutes. Tag cursors stay at 24 hours.
- A 204 idempotency body is JSON null, matching Slices 1 and 2.
- JSON Schema Draft 2020-12 is checked with Ajv 2020 after a local walk rejects `$ref`, `$dynamicRef`, `$id`, `$anchor`, `$dynamicAnchor`, `$recursiveRef`, and `$recursiveAnchor`. No schema loader is configured.
- Canonical contract digest is SHA-256 of RFC 8785 JSON Canonicalization Scheme (sorted keys, no insignificant space, ES6 number form, `-0` as `0`).
- Endpoint URLs are validated with the WHATWG URL parser. The service does not import DNS or HTTP clients in the Slice 3 modules. Hostnames must be dotted DNS names. IP literals, `localhost`, userinfo, query, fragment, and non-ASCII names are rejected. `xn--` labels are rejected as ambiguous IDN.
- Live limits are 8 endpoints and 32 bindings. Overage is 409 `VALIDATION_ERROR`. A duplicate capability version with a new idempotency key is 409 `ALREADY_EXISTS`.
- A disabled same-organization endpoint at bind time is 422. A missing or tombstoned endpoint or capability is 404. Cross-organization rows are indistinguishable from missing.
- Catalog list limit maximum is 100, matching the OpenAPI parameter. Discovery limit maximum is 50.
- `PRECONDITION_REQUIRED` keeps the shipped message `If-Match is required.` PUT also accepts `If-None-Match: *`.
- `@fad/sdk` is 0.4.0. Existing methods, the `Agent` shape, and ETag rules are unchanged.
- P1 load at 100k agents and a full point-in-time restore are recorded as NOT RUN when this workstation cannot produce them. P0 still gates.

## Behavior

Lock order for endpoint and binding writes is agent, then endpoint, then binding. The agent row lock serializes quota and retirement. Capability versions are insert-only. Endpoint and binding tombstones keep the revision counter. Recreation increments it. No-op writes skip history and audit. Agent and tag revisions are not updated.

Discovery returns only active agents, live bindings, and enabled non-tombstoned endpoints. Tag predicates are AND equality, at most eight, and use Slice 2 visibility. The page is ordered by agent UUID ascending. There is no total count.

## Rollback

Set `FAD_SLICE3_ENABLED` to false or start the previous API image. Leave the new tables in place.
