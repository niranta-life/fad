# `@fad/sdk` — Slice 0 Node.js / TypeScript client contract

This SDK is a *real network client* with no database dependencies or privileged admin methods. The REST OpenAPI schema is the source of truth; a thin ergonomic wrapper is acceptable. Separate npm package version (SemVer) from API major `/v1`.

## Supported client API

```ts
export interface FadClientOptions {
  baseUrl: string;              // https://fad.company.internal
  apiKey: string | (() => Promise<string> | string);
  timeoutMs?: number;           // default 5000, must be bounded
  fetch?: typeof globalThis.fetch;
  maxGetRetries?: number;       // default 2; never retry 401/403/400
  userAgentSuffix?: string;
}

export interface Organization {
  id: string;                   // UUID
  name: string;
  status: 'active' | 'suspended' | (string & {});
  created_at: string;           // ISO 8601
}
export interface FadResponse<T> {
  data: T;
  meta: { request_id: string; api_version: 'v1'; [key: string]: unknown };
}
export class FadClient {
  constructor(options: FadClientOptions);
  readonly health: {
    live(options?: { signal?: AbortSignal }): Promise<{status: 'ok'}>;
    ready(options?: { signal?: AbortSignal }): Promise<{status: 'ready'|'not_ready'}>;
  };
  readonly organizations: {
    current(options?: { signal?: AbortSignal }): Promise<FadResponse<Organization>>;
  };
}
export class FadApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;
  readonly retryAfterSeconds?: number;
}
```

Use Node.js supported LTS with native `fetch`, not an old/unsupported runtime. Secret provider callback allows runtime key rotation without reconstructing the SDK. Validate HTTPS baseUrl except loopback/local dev with opt-in. Never log the callback result or put the key in URL parameters.

## Example integration

```ts
import { FadClient } from '@fad/sdk';

const fad = new FadClient({
  baseUrl: process.env.FAD_BASE_URL!,
  apiKey: () => process.env.FAD_API_KEY!
});
const {data, meta} = await fad.organizations.current();
console.log({ organizationId: data.id, requestId: meta.request_id });
```

## Retries and deadlines

- At most 2 retries for GET on 429 and 503 with exponential backoff, jitter, `Retry-After` honored with a bounded maximum, one total request deadline.
- Do not retry 401, 403, malformed response, or general 500 unless a future policy explicitly allows it.
- Enforce caller AbortSignal and internal timeout; propagate cancellation promptly.
- Reject untrusted redirect to a different origin; do not forward API key on redirects; safest initial setting is `redirect: 'error'`.
- Expose typed errors with `status`, `code`, `requestId`, and documented `retryAfterSeconds`; discard raw request objects and keys from thrown exceptions.
- Strictly validate server envelope for success and API errors; preserve unknown response properties for forwards compatibility.
- Keep a consistent method namespace for future `client.agents.register()` without modifying `organizations.current()` signature.

## Publishing and quality

- ESM and CommonJS compatibility if build supports both without duplicated code; clear package `exports` and `types`.
- Build type declarations, source maps if safe; pin API major support.
- Test install from packed tarball in a separate Node application; tests must not import the server's internal services.
- Contract tests against local running API plus explicit 401/403/503, abort, timeout, wrong JSON, missing header, redirects and redaction.
- Python, Java, Kotlin and Go clients belong to later releases and should be generated using the same OpenAPI models.
