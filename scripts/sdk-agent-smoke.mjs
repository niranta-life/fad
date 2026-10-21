import { FadClient } from '@fad/sdk';

const baseUrl = process.env.FAD_BASE_URL;
const apiKey = process.env.FAD_API_KEY;
const ownerPrincipalId = process.env.FAD_OWNER_PRINCIPAL_ID;
if (!baseUrl || !apiKey || !ownerPrincipalId) {
  console.error('missing FAD_BASE_URL, FAD_API_KEY, or FAD_OWNER_PRINCIPAL_ID');
  process.exit(1);
}

const client = new FadClient({
  baseUrl,
  credentialProvider: () => apiKey,
  allowInsecureHttp: true,
  timeoutMs: 10000,
  maxGetRetries: 1,
});

const created = await client.agents.register(
  { name: 'SDK Smoke Agent', owner_principal_id: ownerPrincipalId },
  { idempotencyKey: 'sdk-smoke-register-0001' },
);
const loaded = await client.agents.get(created.data.id);
const page = await client.agents.list({ limit: 25 });
const updated = await client.agents.update(
  created.data.id,
  { description: 'Registered by the SDK smoke client' },
  { idempotencyKey: 'sdk-smoke-update-0001', ifMatch: created.etag },
);
const found = page.data.some((item) => item.id === created.data.id);
if (loaded.data.id !== created.data.id || !found || updated.data.revision !== 2 || updated.etag !== '"agent-v2"') {
  console.error('sdk smoke mismatch');
  process.exit(1);
}
console.log(JSON.stringify({
  id: updated.data.id,
  organization_id: updated.data.organization_id,
  global_id: updated.data.global_id,
  revision: updated.data.revision,
  etag: updated.etag,
}));
