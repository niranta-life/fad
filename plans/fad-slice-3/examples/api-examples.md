# Executable HTTP contract examples (proposed; not recorded runtime results)

For all requests use TLS, `X-FAD-API-Key: <redacted>`. Every response body follows existing `{data,meta}` or `{error,meta}` envelopes. The values below are illustrative, not actual test evidence.

Prerequisites: `AGENT_ID = 9c06a006-8a93-4f7b-b360-ff0628f2c5e1`, `ORG_ID = 6c6498a5-b814-473a-9a4a-af0988e4c3b1`, `PRINCIPAL_ID = 65b8df1d-334f-4c2d-975b-fdbf1574ebcf` (all illustrative). Existing agent status `active`. Previously created tag `department.name=finance`.

## 1. Publish capability

```http
POST /v1/capabilities HTTP/1.1
X-FAD-API-Key: <redacted>
Content-Type: application/json
Idempotency-Key: cap-finance-invoice-match-v1

{
  "id": "finance.invoice.match",
  "version": "1.0.0",
  "display_name": "Invoice matching",
  "description": "Compare invoice and purchase order",
  "input_schema": {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {"invoice_id": {"type": "string"}},
    "required": ["invoice_id"],
    "additionalProperties": false
  },
  "output_schema": {
    "type": "object",
    "properties": {"matched": {"type": "boolean"}},
    "required": ["matched"],
    "additionalProperties": false
  }
}
```

```http
HTTP/1.1 201 Created
Location: /v1/capabilities/finance.invoice.match/versions/1.0.0
X-Request-Id: req-example-1
Cache-Control: private, no-store
```

```json
{
  "data": {
    "id": "finance.invoice.match", "version": "1.0.0",
    "organization_id": "6c6498a5-b814-473a-9a4a-af0988e4c3b1",
    "display_name": "Invoice matching", "description": "Compare invoice and purchase order",
    "input_schema": {"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"invoice_id":{"type":"string"}},"required":["invoice_id"],"additionalProperties":false},
    "output_schema": {"type":"object","properties":{"matched":{"type":"boolean"}},"required":["matched"],"additionalProperties":false},
    "contract_sha256": "85e8d76c97899e834ce7dff698e097581908222a008f8e177a5cfbdba5762998",
    "verification": "self_declared",
    "published_by": "65b8df1d-334f-4c2d-975b-fdbf1574ebcf",
    "published_at": "2026-10-20T12:00:00Z"
  },
  "meta": {"request_id": "req-example-1", "api_version": "v1"}
}
```

## 2. Register endpoint metadata

```http
PUT /v1/agents/9c06a006-8a93-4f7b-b360-ff0628f2c5e1/endpoints/primary HTTP/1.1
X-FAD-API-Key: <redacted>
Content-Type: application/json
Idempotency-Key: endpoint-primary-create
If-None-Match: *

{"protocol":"a2a","url":"https://ap.internal.example/a2a","auth_scheme":"oauth2","enabled":true}
```

```http
HTTP/1.1 201 Created
ETag: "endpoint-v1"
Location: /v1/agents/9c06a006-8a93-4f7b-b360-ff0628f2c5e1/endpoints/primary
Cache-Control: private, no-store
```

Response body:

```json
{
  "data": {
    "agent_id":"9c06a006-8a93-4f7b-b360-ff0628f2c5e1",
    "key":"primary","protocol":"a2a","url":"https://ap.internal.example/a2a","auth_scheme":"oauth2","enabled":true,"revision":1,"verification":"self_declared",
    "created_by":"65b8df1d-334f-4c2d-975b-fdbf1574ebcf","updated_by":"65b8df1d-334f-4c2d-975b-fdbf1574ebcf",
    "created_at":"2026-10-20T12:00:00Z","updated_at":"2026-10-20T12:00:00Z"
  },
  "meta":{"request_id":"req-example-2","api_version":"v1"}
}
```

## 3. Bind version to endpoint

```http
PUT /v1/agents/9c06a006-8a93-4f7b-b360-ff0628f2c5e1/capabilities/finance.invoice.match HTTP/1.1
X-FAD-API-Key: <redacted>
Content-Type: application/json
Idempotency-Key: binding-invoice-v1
If-None-Match: *

{"version":"1.0.0","endpoint_key":"primary"}
```

```http
HTTP/1.1 201 Created
ETag: "cap-binding-v1"
```

Response body:

```json
{
  "data": {
    "agent_id":"9c06a006-8a93-4f7b-b360-ff0628f2c5e1",
    "capability_id":"finance.invoice.match","version":"1.0.0","endpoint_key":"primary",
    "revision":1,"verification":"self_declared","created_by":"65b8df1d-334f-4c2d-975b-fdbf1574ebcf",
    "updated_by":"65b8df1d-334f-4c2d-975b-fdbf1574ebcf",
    "created_at":"2026-10-20T12:00:00Z","updated_at":"2026-10-20T12:00:00Z"
  },
  "meta":{"request_id":"req-example-3","api_version":"v1"}
}
```

## 4. Find agents with capability and governed tags

```http
POST /v1/discovery/agents HTTP/1.1
X-FAD-API-Key: <redacted>
Content-Type: application/json

{
  "capability":{"id":"finance.invoice.match","version":"1.0.0"},
  "tags":[{"namespace":"department","key":"name","operator":"eq","value":"finance"}],
  "protocols":["a2a"],"limit":25
}
```

`HTTP 200`; `data` is an array of `{agent,capability,binding,endpoint,invocation_authorization:"not_evaluated",availability:"not_checked"}`. Agent is **exactly** the previously published Slice 1 schema, unchanged. `capability.verification` and `binding.verification` are `self_declared`. `meta` is existing Slice 2 `PageMeta` (`request_id`,`api_version`,`limit`,`next_cursor`). A caller lacking `tags:restricted:read` and filtering on `security.risk` gets `403`, never a list revealing sensitive matches.

## 5. Error example

```http
HTTP/1.1 412 Precondition Failed
Cache-Control: private, no-store
X-Request-Id: req-example-4
```

```json
{
  "error": {"code": "REVISION_CONFLICT", "message": "The resource revision does not match."},
  "meta": {"request_id": "req-example-4", "api_version": "v1"}
}
```

## 6. SDK examples

```typescript
const fad = new FadClient({baseUrl: process.env.FAD_URL!, apiKey: () => process.env.FAD_API_KEY!});
await fad.capabilities.publish({id: 'finance.invoice.match',version:'1.0.0',display_name:'Invoice matching',input_schema:{type:'object'},output_schema:{type:'object'}}, {idempotencyKey:'cap-v1'});
await fad.endpoints.put(agentId,'primary',{protocol:'a2a',url:'https://ap.internal.example/a2a',auth_scheme:'oauth2'}, {idempotencyKey:'endpoint-1',ifNoneMatch:'*'});
await fad.bindings.put(agentId,'finance.invoice.match',{version:'1.0.0',endpoint_key:'primary'}, {idempotencyKey:'binding-1',ifNoneMatch:'*'});
const matches = await fad.discovery.agents({capability:{id:'finance.invoice.match',version:'1.0.0'},limit:25});
// matches.data[*].invocation_authorization === 'not_evaluated'
```
