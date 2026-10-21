import { FadApiError, FadClient } from '@fad/sdk';

const base = process.env.FAD_BASE_URL;
const apiKey = process.env.FAD_API_KEY;
const agentId = process.env.FAD_AGENT_ID;
const label = process.env.FAD_LABEL || 'a';
const hosts = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  hosts.push(new URL(url, base).hostname);
  return realFetch(url, options);
};

const id = `sdk.${label}.match`;
const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  properties: { invoice_id: { type: 'string' } },
  required: ['invoice_id'],
};
const body = {
  id,
  version: '1.0.0',
  display_name: 'SDK match',
  description: 'Packed client declaration',
  input_schema: schema,
  output_schema: schema,
};
const client = new FadClient({
  baseUrl: base,
  apiKey,
  allowInsecureHttp: true,
  timeoutMs: 20000,
});

const result = {
  ok: false,
  hosts,
  publish: 0,
  discovery: 0,
  etag: '',
  bindingEtag: '',
  availability: '',
  authorization: '',
  iterated: 0,
  aborted: false,
  duplicate: 0,
  legacyAgent: '',
  legacyKeys: [],
  futureProtocol: '',
  retryAttempts: 0,
  retrySameKey: false,
};

try {
  const published = await client.capabilities.publish(body, { idempotencyKey: `sdk-${label}-cap-0001` });
  result.publish = 201;
  await client.capabilities.publish({ ...body, version: '1.0.1' }, { idempotencyKey: `sdk-${label}-cap-0002` });
  const loaded = await client.capabilities.get(id, '1.0.0');
  if (loaded.data.contract_sha256 !== published.data.contract_sha256) throw new Error('hash mismatch');
  if (loaded.data.verification !== 'self_declared') throw new Error('verification mismatch');
  let count = 0;
  for await (const item of client.capabilities.iterate({ id, limit: 1 })) {
    count += 1;
    if (item.id !== id) throw new Error('iterate id mismatch');
  }
  result.iterated = count;
  const endpoint = await client.endpoints.put(agentId, 'sdkpack', {
    protocol: 'a2a',
    url: 'https://ap.internal.example/a2a',
    auth_scheme: 'oauth2',
  }, { idempotencyKey: `sdk-${label}-ep-00001`, ifNoneMatch: '*' });
  result.etag = endpoint.etag;
  const binding = await client.bindings.put(agentId, id, {
    version: '1.0.0',
    endpoint_key: 'sdkpack',
  }, { idempotencyKey: `sdk-${label}-bind-001`, ifNoneMatch: '*' });
  result.bindingEtag = binding.etag;
  const found = await client.discovery.query({
    capability: { id, version: '1.0.0' },
    protocols: ['a2a'],
  });
  result.discovery = found.data.length;
  const match = found.data.find((item) => item.agent.id === agentId);
  result.availability = match?.availability ?? '';
  result.authorization = match?.invocation_authorization ?? '';
  const agent = await client.agents.get(agentId);
  result.legacyAgent = agent.data.id;
  result.legacyKeys = Object.keys(agent.data);
  const org = await client.organizations.current();
  if (typeof org.data.id !== 'string') throw new Error('organization missing');
  try {
    await client.capabilities.publish(body, { idempotencyKey: `sdk-${label}-cap-0003` });
  } catch (error) {
    if (error instanceof FadApiError) result.duplicate = error.status;
    else throw error;
  }
  const aborted = new AbortController();
  aborted.abort();
  try {
    await client.capabilities.list({ id, limit: 1 }, { signal: aborted.signal });
  } catch (error) {
    result.aborted = error instanceof Error && error.name === 'AbortError';
  }
  const future = new FadClient({
    baseUrl: base,
    apiKey,
    allowInsecureHttp: true,
    timeoutMs: 5000,
    fetch: async () => new Response(JSON.stringify({
      data: [{
        agent: agent.data,
        capability: { id, version: '1.0.0', verification: 'future_claim' },
        binding: binding.data,
        endpoint: { ...endpoint.data, protocol: 'future_bus', auth_scheme: 'future_auth' },
        availability: 'future_state',
        invocation_authorization: 'future_authz',
      }],
      meta: { request_id: '11111111-1111-4111-8111-111111111111', api_version: 'v1', limit: 1, next_cursor: null },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  const futurePage = await future.discovery.query({ capability: { id } });
  result.futureProtocol = futurePage.data[0].endpoint.protocol;
  let attempts = 0;
  let seenKey = '';
  const retry = new FadClient({
    baseUrl: base,
    apiKey,
    allowInsecureHttp: true,
    timeoutMs: 5000,
    maxGetRetries: 2,
    random: () => 0,
    sleep: async () => undefined,
    fetch: async (_url, init) => {
      attempts += 1;
      seenKey = new Headers(init.headers).get('idempotency-key') ?? '';
      if (attempts === 1) {
        return new Response(JSON.stringify({
          error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'down' },
          meta: { request_id: '11111111-1111-4111-8111-111111111111', api_version: 'v1' },
        }), { status: 503, headers: { 'content-type': 'application/json', 'retry-after': '0' } });
      }
      return new Response(JSON.stringify({ data: endpoint.data, meta: { request_id: '22222222-2222-4222-8222-222222222222', api_version: 'v1' } }), {
        status: 201,
        headers: { 'content-type': 'application/json', etag: '"endpoint-v1"' },
      });
    },
  });
  const retried = await retry.endpoints.put(agentId, 'sdkpack', {
    protocol: 'a2a',
    url: 'https://ap.internal.example/a2a',
    auth_scheme: 'oauth2',
  }, { idempotencyKey: `sdk-${label}-retry-01`, ifNoneMatch: '*' });
  result.retryAttempts = attempts;
  result.retrySameKey = seenKey === `sdk-${label}-retry-01` && retried.etag === '"endpoint-v1"';
  result.ok = result.publish === 201
    && result.iterated === 2
    && result.etag === '"endpoint-v1"'
    && result.bindingEtag === '"cap-binding-v1"'
    && result.discovery >= 1
    && result.availability === 'not_checked'
    && result.authorization === 'not_evaluated'
    && result.duplicate === 409
    && result.aborted === true
    && result.futureProtocol === 'future_bus'
    && result.retryAttempts === 2
    && result.retrySameKey === true
    && result.legacyAgent === agentId
    && !result.legacyKeys.includes('capabilities')
    && hosts.every((host) => host === '127.0.0.1' || host === 'localhost');
} catch (error) {
  result.ok = false;
  result.error = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown';
  if (error instanceof FadApiError) {
    result.errorStatus = error.status;
    result.errorCode = error.code;
  }
}
console.log(JSON.stringify(result));
if (!result.ok) process.exit(1);
