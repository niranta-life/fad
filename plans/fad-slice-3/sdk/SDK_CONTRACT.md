# Node.js / TypeScript SDK Slice 3 Contract

**Package:** add to existing `@fad/sdk`, maintain all Slice 0–2 exports and methods, preserve existing `FadClient({baseUrl, apiKey})` option shapes. Publishing is a client-library API, not agent invocation.

## Surface

```typescript
class FadClient {
  // Slices 0–2 methods unchanged.
  readonly capabilities: {
    publish(req: CapabilityPublish, opts: {idempotencyKey:string; signal?:AbortSignal}): Promise<ApiResponse<Capability>>;
    get(id:string, version:string, opts?: ReadOptions): Promise<ApiResponse<Capability>>;
    list(req?: {id?:string;limit?:number;cursor?:string}, opts?:ReadOptions): Promise<ApiPage<Capability>>;
    pages(req?: {id?:string;limit?:number}, opts?:ReadOptions): AsyncIterable<Capability>;
  };
  readonly endpoints: {
    list(agentId:string, opts?:ReadOptions): Promise<ApiResponse<Endpoint[]>>;
    get(agentId:string,key:string, opts?:ReadOptions): Promise<ApiResponse<Endpoint>>;
    put(agentId:string,key:string,body:EndpointPut,opts: ConditionalMutationOptions): Promise<ApiResponse<Endpoint>>;
    delete(agentId:string,key:string,opts: ConditionalMutationOptions): Promise<void>;
  };
  readonly bindings: {
    list(agentId:string,opts?:ReadOptions): Promise<ApiResponse<Binding[]>>;
    get(agentId:string,capabilityId:string,opts?:ReadOptions): Promise<ApiResponse<Binding>>;
    put(agentId:string,capabilityId:string,body:BindingPut,opts:ConditionalMutationOptions): Promise<ApiResponse<Binding>>;
    delete(agentId:string,capabilityId:string,opts:ConditionalMutationOptions): Promise<void>;
  };
  readonly discovery: {
    agents(req:DiscoveryRequest,opts?:ReadOptions):Promise<ApiPage<DiscoveryMatch>>;
    pages(req:Omit<DiscoveryRequest,'cursor'>,opts?:ReadOptions):AsyncIterable<DiscoveryMatch>;
  };
}

type ReadOptions = {signal?:AbortSignal;timeoutMs?:number};
type ConditionalMutationOptions = {
  idempotencyKey:string;
  ifMatch?:string;
  ifNoneMatch?:'*';
  signal?:AbortSignal;
  timeoutMs?:number;
};
```

`ConditionalMutationOptions` requires exactly one of `ifMatch` or `ifNoneMatch` at runtime (encode union in TypeScript if feasible); DELETE requires `ifMatch`. Return ETag and X-Request-Id via existing response header access mechanism, not only the `data` envelope. If prior SDK response envelope differs, preserve prior behavior and extend non-breakingly.

## Semantics

1. Client never accepts or sets organization IDs for these methods; auth credential fixes org and actor.
2. Retry GET and read-only `POST /v1/discovery/agents` on network transient/429/503 with bounded exponential backoff and jitter; mutation retries only with Idempotency-Key. Respect `Retry-After` when present. Do not retry on validation, 401/403/404, 409, 412 or 428.
3. Support `AbortSignal`, connect/request timeouts and bounded total retry deadline. No unbounded automatic pagination.
4. URI-encode all path segments. Reject illegal capability IDs/versions/endpoint keys locally before a request without assuming local validation equals server authorization.
5. SDK makes **no** outbound network requests to declared endpoints; `discovery` only contacts directory.
6. Preserve unknown server response fields and future enum values safely, rather than throwing on additive changes. Typed errors include stable code, HTTP status, request ID and optional details without exposing API secrets.
7. Credential supplier callback is evaluated per attempt to support rotation. Headers redact in logs and error messages.
8. Version the SDK independently (e.g., next backwards-compatible minor), and state minimum compatible server `/v1` release. Existing interfaces stay intact.
9. Add independent package consumer tests using a packed/published tarball against real API (not monorepo imports or mocks). Cover auth, publication, endpoint ETags, bindings, discovery, cursor, missing permissions, old SDK regression and package installation under supported Node.js LTS.

## Release matrix

| Server | Old SDK (Slice 0–2) | New SDK (Slice 3) |
|---|---|---|
| Prior `/v1` backend | Must remain supported | Existing methods work; new methods return standard 404/unsupported feature handling |
| New Slice 3 backend | Must remain supported | All tested Slice 0–3 methods work |

Python, Java, Go and Kotlin are deferred but generated from the same OpenAPI models later. Do not introduce TypeScript-specific serialized JSON into API responses.
