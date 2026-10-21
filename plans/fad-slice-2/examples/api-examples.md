# Illustrative HTTP Requests and Responses (Not Executed)

All IDs, keys, times, request IDs and ETags below are examples only. `X-FAD-API-Key` must be a real organization-bound credential in deployment. Server responses include `Cache-Control: private, no-store`, `X-Request-Id` and JSON response envelopes unless 204.

## 1. Create ordinary definition

```http
POST /v1/tag-definitions
X-FAD-API-Key: <REDACTED>
Idempotency-Key: define-department-name-1
Content-Type: application/json

{"namespace":"department","key":"name","value_type":"string","governed":false,"visibility":"internal","description":"Responsible business team"}
```

```http
HTTP/1.1 201 Created
Location: /v1/tag-definitions/department/name
```

```json
{"data":{"organization_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc","namespace":"department","key":"name","value_type":"string","enum_values":null,"governed":false,"visibility":"internal","description":"Responsible business team","created_by":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","created_at":"2026-10-20T18:00:00.000Z"},"meta":{"request_id":"req-example-1","api_version":"v1"}}
```

## 2. Create governed definition

```http
POST /v1/tag-definitions
X-FAD-API-Key: <GOVERNANCE-CREDENTIAL>
Idempotency-Key: define-security-risk-1
Content-Type: application/json

{"namespace":"security","key":"risk","value_type":"enum","enum_values":["low","medium","high"],"governed":true,"visibility":"restricted"}
```

Ordinary `tags:define` credentials without `tags:governance` receive 403 and cannot create this definition.

## 3. Assign ordinary tag (first assignment)

```http
PUT /v1/agents/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/tags/department/name
X-FAD-API-Key: <TAG-EDITOR-CREDENTIAL>
Idempotency-Key: assign-dept-name-1
If-None-Match: *
Content-Type: application/json

{"value":"finance"}
```

```http
HTTP/1.1 201 Created
ETag: "tag-v1"
Location: /v1/agents/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/tags/department/name
```

```json
{"data":{"agent_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","namespace":"department","key":"name","value":"finance","revision":1,"governed":false,"visibility":"internal","created_by":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","updated_by":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","created_at":"2026-10-20T18:01:00.000Z","updated_at":"2026-10-20T18:01:00.000Z"},"meta":{"request_id":"req-example-2","api_version":"v1"}}
```

## 4. Update value

```http
PUT /v1/agents/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/tags/department/name
X-FAD-API-Key: <TAG-EDITOR-CREDENTIAL>
Idempotency-Key: update-dept-name-2
If-Match: "tag-v1"
Content-Type: application/json

{"value":"accounts-payable"}
```

Returns 200 and `ETag: "tag-v2"`. A stale `If-Match: "tag-v1"` with a new idempotency key returns `412 PRECONDITION_FAILED`.

## 5. Governed tag assignment

```http
PUT /v1/agents/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/tags/security/risk
X-FAD-API-Key: <GOVERNANCE-CREDENTIAL>
Idempotency-Key: classify-risk-1
If-None-Match: *
Content-Type: application/json

{"value":"high","reason":"Completed security assessment"}
```

Requires both `tags:write` and `tags:governance`. Ordinary editor receives 403; unauthorized read receives 404 for this specific tag. Never infer allowed operations from this tag alone.

## 6. Search agents

```http
POST /v1/agents/search
X-FAD-API-Key: <READER-CREDENTIAL>
Content-Type: application/json

{"tags":[{"namespace":"department","key":"name","operator":"eq","value":"accounts-payable"}],"status":"active","limit":25}
```

Returns the **unchanged Slice 1** `AgentListResponse` (same complete `Agent` objects and `meta.limit`, `meta.next_cursor`). A query on restricted `security.risk` without `tags:restricted:read` receives 403; no results/count are exposed.

## 7. Delete

```http
DELETE /v1/agents/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/tags/department/name
X-FAD-API-Key: <TAG-EDITOR-CREDENTIAL>
Idempotency-Key: delete-dept-name-1
If-Match: "tag-v2"
```

Returns HTTP 204, no body. The assignment becomes a tombstone with revision 3. A subsequent `If-None-Match: *` assignment is allowed; its new revision is 4, not 1. Governed deletion additionally requires `X-Change-Reason`.

## 8. Error response

```json
{"error":{"code":"PRECONDITION_FAILED","message":"The tag assignment has changed; read it and retry."},"meta":{"request_id":"req-example-3","api_version":"v1"}}
```
