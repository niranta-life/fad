# @fad/sdk

Network client for FAD Slice 0.

```ts
import { FadClient } from '@fad/sdk';

const fad = new FadClient({
  baseUrl: process.env.FAD_BASE_URL!,
  apiKey: () => process.env.FAD_API_KEY!,
});
const { data, meta } = await fad.organizations.current();
console.log({ organizationId: data.id, requestId: meta.request_id });
```

`health.live()`, `health.ready()`, and `organizations.current()` are the only methods. The client uses HTTPS except loopback when `allowInsecureHttp` is set. It does not follow redirects and does not log the API key.
