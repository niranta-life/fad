import { createServer } from 'node:http';
import test from 'node:test';
import { FadApiError, FadClient } from '@fad/sdk';
import { check } from './support.mjs';

const agent = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  global_id: 'urn:fad:agent:cccccccc-cccc-4ccc-8ccc-cccccccccccc:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  organization_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  name: 'Accounts Payable Agent',
  description: '',
  owner_principal_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  status: 'active',
  revision: 2,
  created_at: '2026-10-20T20:00:00.000Z',
  updated_at: '2026-10-20T20:00:00.000Z',
  created_by: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  updated_by: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('SDK keeps one idempotency key and does not retry 412', async () => {
  const calls = [];
  const server = await listen((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const url = req.url ?? '';
      calls.push({
        url,
        key: req.headers['idempotency-key'],
        match: req.headers['if-match'],
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if (url.endsWith('/retire')) {
        res.writeHead(412, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: { code: 'PRECONDITION_FAILED', message: 'The agent has changed. Fetch its current representation and retry.' },
          meta: { request_id: '11111111-1111-4111-8111-111111111111', api_version: 'v1' },
        }));
        return;
      }
      const updates = calls.filter((item) => item.url === `/v1/agents/${agent.id}`);
      if (updates.length < 3) {
        res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '0' });
        res.end(JSON.stringify({
          error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'Service temporarily unavailable.' },
          meta: { request_id: '11111111-1111-4111-8111-111111111111', api_version: 'v1' },
        }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', etag: '"agent-v2"' });
      res.end(JSON.stringify({
        data: agent,
        meta: { request_id: '22222222-2222-4222-8222-222222222222', api_version: 'v1' },
      }));
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const client = new FadClient({
    baseUrl: `http://127.0.0.1:${port}`,
    credentialProvider: () => 'fad_live.test-key',
    allowInsecureHttp: true,
    timeoutMs: 5000,
    maxGetRetries: 2,
    sleep: async () => undefined,
  });
  try {
    const updated = await client.agents.update(agent.id, { description: 'next' }, {
      idempotencyKey: 'same-update-key',
      ifMatch: '"agent-v1"',
    });
    check('sdk-retry-etag', updated.etag === '"agent-v2"' && updated.data.revision === 2);
    const updateCalls = calls.filter((item) => item.url === `/v1/agents/${agent.id}`);
    check('sdk-retry-same-key', updateCalls.length === 3
      && updateCalls.every((item) => item.key === 'same-update-key' && item.match === '"agent-v1"' && item.body.includes('next')));
    let failed = null;
    try {
      await client.agents.retire(agent.id, { reason: 'done' }, { idempotencyKey: 'retire-key-001', ifMatch: '"agent-v1"' });
    } catch (error) {
      failed = error;
    }
    const retireCalls = calls.filter((item) => item.url.endsWith('/retire'));
    check('sdk-no-retry-412', failed instanceof FadApiError && failed.status === 412 && retireCalls.length === 1
      && retireCalls[0].key === 'retire-key-001' && retireCalls[0].match === '"agent-v1"');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('SDK retries a GET connection failure and does not retry 401', async () => {
  const key = 'fad_live.' + 'ab'.repeat(16) + '.' + 'C'.repeat(43);
  const path = `/v1/agents/${agent.id}`;
  const seen = [];
  let calls = 0;
  let clock = 0;
  const client = new FadClient({
    baseUrl: 'http://127.0.0.1:9',
    apiKey: key,
    allowInsecureHttp: true,
    timeoutMs: 5000,
    maxGetRetries: 2,
    maxRetryAfterMs: 1000,
    now: () => clock,
    random: () => 0,
    sleep: async (ms) => {
      clock += ms;
    },
    fetch: async (url, init) => {
      calls += 1;
      const headers = new Headers(init.headers);
      seen.push({ url: String(url), method: init.method, key: headers.get('x-fad-api-key') });
      if (calls === 1) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({
        data: agent,
        meta: { request_id: '33333333-3333-4333-8333-333333333333', api_version: 'v1' },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json', etag: '"agent-v1"' },
      });
    },
  });
  const loaded = await client.agents.get(agent.id);
  check('sdk-get-network-retry', loaded.data.id === agent.id && loaded.etag === '"agent-v1"' && calls === 2
    && seen.length === 2
    && seen.every((item) => item.method === 'GET' && item.key === key && item.url.endsWith(path)));

  let unauthorizedCalls = 0;
  const denied = new FadClient({
    baseUrl: 'http://127.0.0.1:9',
    apiKey: key,
    allowInsecureHttp: true,
    timeoutMs: 5000,
    maxGetRetries: 2,
    sleep: async () => {
      throw new Error('401 must not sleep');
    },
    fetch: async () => {
      unauthorizedCalls += 1;
      return new Response(JSON.stringify({
        error: { code: 'UNAUTHORIZED', message: 'Invalid or missing API credential.' },
        meta: { request_id: '11111111-1111-4111-8111-111111111111', api_version: 'v1' },
      }), { status: 401, headers: { 'content-type': 'application/json' } });
    },
  });
  let unauthorized = null;
  try {
    await denied.agents.get(agent.id);
  } catch (error) {
    unauthorized = error;
  }
  check('sdk-get-no-retry-401', unauthorized instanceof FadApiError && unauthorized.status === 401
    && unauthorized.code === 'UNAUTHORIZED' && unauthorizedCalls === 1);
});
