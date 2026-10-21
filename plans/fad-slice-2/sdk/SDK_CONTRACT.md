# Node.js SDK Slice 2 Contract

Package: existing `@fad/sdk`, additive API only. Uses the same `FadClient({baseUrl,apiKey})` constructor and error types as Slices 0–1. `@fad/sdk` version follows its own semantic release; adding namespaces/methods is a minor release; do not rename existing methods.

```ts
export type TagValue = string | number | boolean;
export type TagType = 'string' | 'integer' | 'boolean' | 'enum';
export type TagVisibility = 'internal' | 'restricted';
export interface TagDefinitionCreate {
  namespace: string; key: string; value_type: TagType;
  enum_values?: string[]; governed: boolean;
  visibility: TagVisibility; description?: string;
}
export interface AgentTagPut { value: TagValue; reason?: string; }
export interface SearchPredicate { namespace: string; key: string; operator: 'eq'; value: TagValue; }
export interface AgentSearchInput { tags?: SearchPredicate[]; status?: 'active'|'suspended'|'retired'; limit?: number; cursor?: string; }
export interface VersionedResult<T> { data: T; meta: { request_id: string; api_version: 'v1' }; etag?: string; }
export interface MutationOptions { idempotencyKey: string; ifMatch?: string; ifNoneMatch?: '*'; }

// Methods exposed via existing FadClient:
client.tagDefinitions.create(def, { idempotencyKey });
client.tagDefinitions.get(namespace, key);
client.tagDefinitions.list({ namespace, limit, cursor });
client.agentTags.list(agentId);
client.agentTags.get(agentId, namespace, key);
client.agentTags.put(agentId, namespace, key, { value, reason }, opts);
client.agentTags.delete(agentId, namespace, key, { idempotencyKey, ifMatch, reason });
client.agents.search({ tags: [{namespace:'department',key:'name',operator:'eq',value:'finance'}] });
```

- Expose `etag` from HTTP response headers without altering existing Agent DTO. `put` requires exactly one conditional header, even if the SDK's type system cannot express XOR statically. `delete` requires `ifMatch`.
- Persist `idempotencyKey` across application retry and do not generate a fresh key on retry. Never automatically repeat unsafe mutations without that key.
- SDK uses same authentication injection and never includes `organization_id` as tenant selector. Keep credential redacted in diagnostics, errors and tracing.
- JSON encode typed primitives; explicitly preserve `0` and `false`; reject `NaN`, infinity, floating numbers for integer, null, string >128, and empty string client-side as convenience only (server validation authoritative).
- Search is read-only despite POST method: SDK may retry documented transient failures according to existing safe-retry budget.
- Keep pagination helper for definitions and search; cursor is opaque and cannot be reused with changed filters or credential tenant. Do not manipulate cursors client-side.
- Preserve existing retry, timeout, abort signal, trace propagation, errors, unknown response field tolerance, and unknown future enum handling.
- Error accessors preserve HTTP status, stable `error.code`, `request_id`, and optional `Retry-After`.
- An independent Node.js sample must create an ungoverned definition, assign/retrieve tag, search agents, delete tag, and verify missing result. Governed sample requires separate privileged test credential and must confirm ordinary editor is denied.
- Generated SDK clients for Python, Java, Go, Kotlin are **deferred**. Preserve OpenAPI portable constructs (`oneOf` scalar, enums, response envelopes, standard conditional headers) to support them later.
