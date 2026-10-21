# Slice 3 Verification Matrix

**Status:** test plan, not test results. **Gate:** all P0 cases must pass before release, with executed evidence in `docs/releases/slice-3/`.

| ID | Priority | Test | Expected result |
|---|---|---|---|
| API-01 | P0 | POST capability valid | 201, Location, canonical hash, actor provenance |
| API-02 | P0 | GET capability exact version | 200, same immutable contract |
| API-03 | P0 | List capability cursor | Stable keyset, no duplicates in static dataset |
| API-04 | P0 | Duplicate cap version new key | 409 ALREADY_EXISTS |
| API-05 | P0 | Exact retry same Idempotency-Key | Same 201 response without new row/audit event |
| API-06 | P0 | Same key different payload | 409 IDEMPOTENCY_CONFLICT |
| API-07 | P0 | PUT new endpoint If-None-Match | 201, endpoint-v1 ETag |
| API-08 | P0 | GET endpoint | 200, exact declaration and ETag |
| API-09 | P0 | Update endpoint If-Match | 200, revision 2, audit event |
| API-10 | P0 | No-op endpoint PUT | 200, no extra revision/audit |
| API-11 | P0 | PUT binding new | 201, cap-binding-v1 |
| API-12 | P0 | GET binding | 200, exact binding and ETag |
| API-13 | P0 | Update binding version and endpoint | 200 revision 2 |
| API-14 | P0 | List bindings/endpoints | All live records, no tombstones |
| API-15 | P0 | Discovery capability + tags + protocol | 200, matching active agent only |
| API-16 | P0 | Discovery capability ID no version | Any currently bound version only |
| API-17 | P0 | Disable endpoint | Excluded from discovery, binding preserved |
| API-18 | P0 | Suspend/retire agent | Excluded from discovery, metadata readable |
| API-19 | P0 | Delete binding | 204, tombstone, absent from discovery |
| API-20 | P0 | Delete endpoint after unbind | 204, tombstone |
| API-21 | P0 | Recreate tombstoned endpoint | 201, increased revision, old ETag fails |
| API-22 | P0 | Recreate tombstoned binding | 201, increased revision, old ETag fails |
| API-23 | P0 | Existing agent GET/ETag after binding | Byte-compatible previous Agent fields; ETag unchanged |
| API-24 | P0 | Existing tag GET/ETag after endpoint mutation | Tag ETag unchanged |
| AUTH-01 | P0 | No credential | 401 |
| AUTH-02 | P0 | Revoked/expired credential | 401, no data |
| AUTH-03 | P0 | Missing capabilities:write on publish | 403 |
| AUTH-04 | P0 | Missing endpoints:write on endpoint PUT | 403 |
| AUTH-05 | P0 | Missing capabilities:write on binding PUT | 403 |
| AUTH-06 | P0 | Missing read scopes on discovery | 403, no result data |
| AUTH-07 | P0 | Tag filter no tags:read | 403 |
| AUTH-08 | P0 | Restricted tag predicate without restricted permission | 403, no match/count/key leak |
| AUTH-09 | P0 | Cross-org GET agent endpoint and binding | Indistinguishable 404 |
| AUTH-10 | P0 | Cross-org capability exact version | 404 |
| AUTH-11 | P0 | Cross-org discovery (same capability ID) | Only local agents returned |
| AUTH-12 | P0 | Forge organization header/body | Cannot change authenticated tenant |
| AUTH-13 | P0 | Runtime DB role direct other-tenant SQL | RLS denies; no BYPASSRLS |
| AUTH-14 | P0 | Missing SET LOCAL fad.org_id | Rows hidden, writes fail |
| AUTH-15 | P0 | Pooled DB reuse A then B | No stale tenant context |
| AUTH-16 | P0 | Cross-tenant composite FK insert | Rejected by PostgreSQL |
| AUTH-17 | P0 | Mutation actor spoof body | Unknown field rejected; actor from credential |
| AUTH-18 | P0 | Malicious endpoint URL with localhost/IP/userinfo/query/fragment | 422; no network request |
| AUTH-19 | P0 | Malicious schema `$ref`/`$dynamicRef`/remote URI | 422, no outbound network |
| AUTH-20 | P0 | Unknown vendor auth scheme / secret-looking extra field | 422, no credential storage |
| AUTH-21 | P0 | SQL injection and Unicode control chars | Safe validation, no bypass |
| AUTH-22 | P0 | Scope change between first request and idempotent replay | Auth rechecked, no leaked saved response |
| CON-01 | P0 | Missing If-Match and If-None-Match on PUT | 428 |
| CON-02 | P0 | Both conditional headers | 400 |
| CON-03 | P0 | Stale ETag on endpoint/binding | 412 |
| CON-04 | P0 | Weak ETag or wildcard If-Match | 400 or 412 as documented |
| CON-05 | P0 | Two concurrent PUT with same ETag | Only one succeeds; loser 412 |
| CON-06 | P0 | Concurrent endpoint creation at limit 8 | Never >8 live endpoints |
| CON-07 | P0 | Concurrent binding creation at limit 32 | Never >32 live bindings |
| CON-08 | P0 | Agent retirement races with endpoint/binding PUT | Either valid committed order; retired never modified after retirement |
| CON-09 | P0 | Delete endpoint with live binding | 409 ENDPOINT_IN_USE |
| CON-10 | P0 | Disable endpoint while discovering | Queries show committed state only; no phantom authorization |
| CON-11 | P0 | Concurrent duplicate capability publish | Exactly one published record |
| CON-12 | P0 | Invalid endpoint/capability reference | 404 or 422 without foreign existence leak |
| VAL-01 | P0 | Invalid capability ID/version | 422 |
| VAL-02 | P0 | Excessive numeric semver component | 422 |
| VAL-03 | P0 | Schema malformed / too deep / too large | 422/413 |
| VAL-04 | P0 | Invalid input schema draft / unknown dialect | 422 |
| VAL-05 | P0 | Invalid endpoint key/protocol/URL | 422 |
| VAL-06 | P0 | Missing/extra body properties | 422 |
| VAL-07 | P0 | Oversized discovery body | 413 |
| VAL-08 | P0 | Duplicate tag predicates | 422 |
| VAL-09 | P0 | Invalid tag type/missing definition | 422/404 without leakage |
| VAL-10 | P0 | Cursor altered or wrong filter | 400 INVALID_CURSOR |
| VAL-11 | P0 | Cursor reused by different tenant/principal/scope | 400 INVALID_CURSOR |
| VAL-12 | P0 | Expired cursor | 400 INVALID_CURSOR |
| VAL-13 | P0 | Huge query limit | 422 |
| VAL-14 | P0 | Catalog request cursor sorted ID + lexical version | Correct page behavior |
| DUR-01 | P0 | DB rollback fault injection before audit | No partial state/history/idempotency |
| DUR-02 | P0 | DB rollback fault injection after audit before commit | All rolled back |
| DUR-03 | P0 | Concurrent replay with same idem key | One mutation, stable replay response |
| DUR-04 | P0 | Restart API instances | State and ETags persist |
| DUR-05 | P0 | Database outage | 503 fail closed, no phantom success |
| DUR-06 | P0 | Migration abort | No partial tables or checksum |
| DUR-07 | P0 | Restore backup / PITR simulation | Consistent catalog/bindings/history |
| DUR-08 | P0 | Rollback to old app after additive migration | Slices 0–2 still work |
| SDK-01 | P0 | Fresh external npm consumer | Loads package and calls live API |
| SDK-02 | P0 | Existing SDK methods | No changed signatures or behavior |
| SDK-03 | P0 | New typed capability/endpoint/binding methods | Correct serialization and errors |
| SDK-04 | P0 | SDK cursor pagination and cancellation | Bounded and abortable |
| SDK-05 | P0 | SDK retry idempotent mutation | Safe replay only |
| SDK-06 | P0 | SDK no endpoint fetch | Only FAD API host receives calls |
| DEP-01 | P0 | OCI image non-root runtime | Runs, no DDL privileges |
| DEP-02 | P0 | Three replicas behind proxy | Identical results and keyset pagination |
| DEP-03 | P0 | Feature flag off after deployment | All prior APIs work; Slice3 unavailable |
| DEP-04 | P0 | Canary / rollback | Restored old binary works without down migration |
| PERF-01 | P1 | 100k agents/tenant indexed discovery | p95 measured with query plan and load profile |
| PERF-02 | P1 | 1M bindings/tenant, eight predicates | Bounded query time and no sequential tenant-wide scan in benchmark |
| PERF-03 | P1 | Tenant fairness under hot-tenant load | Rate/concurrency limits isolate resources |

## Release proof requirements

Each test record contains test ID, exact command, timestamp, environment, sanitized input, status and result, log artifact path and CI run ID. Some P1 performance targets may be an explicit exception only with risk acceptance and release owner approval; **no P0 exceptions** for a production release. Do not mark tests passed based only on code inspection. Existing Slices 0–2 regression tests and OpenAPI compatibility gates must also pass.
