# @fad/sdk

Network client for the FAD HTTP API. Version 0.4.0 adds capability publish, endpoint metadata, capability bindings, and local discovery. Those calls do not invoke an agent. Version 0.3.0 adds typed tag definitions, agent tags, and tag search. Version 0.2.0 adds agent registration and lifecycle. Version 0.1.0 clients keep `health` and `organizations.current`.

```ts
import { FadClient } from '@fad/sdk';

const fad = new FadClient({
  baseUrl: process.env.FAD_BASE_URL!,
  apiKey: () => process.env.FAD_API_KEY!,
});
const { data, meta } = await fad.organizations.current();
console.log({ organizationId: data.id, requestId: meta.request_id });

const created = await fad.agents.register(
  { name: 'Accounts Payable Agent', owner_principal_id: data.id },
  { idempotencyKey: 'agent-register-2026-001' },
);
const updated = await fad.agents.update(
  created.data.id,
  { description: 'Matches supplier invoices' },
  { idempotencyKey: 'agent-update-2026-001', ifMatch: created.etag },
);
console.log({ agentId: updated.data.id, etag: updated.etag });
```

`agents.register`, `get`, `list`, `update`, `suspend`, `activate`, `retire`, and `iterate` call the Slice 1 routes. A retried mutation sends the same `Idempotency-Key` and the same `If-Match`. The client retries a safe GET on HTTP 429, HTTP 503, or a connection failure. It retries a mutation only on those same failures. It does not retry 401, 403, 409, or 412. `credentialProvider` may supply the key instead of `apiKey`. The client uses HTTPS except loopback when `allowInsecureHttp` is set. It does not follow redirects and does not log the API key.
