import { createServer } from 'node:http';
import test from 'node:test';
import pg from 'pg';
import { FadApiError, FadClient } from '@fad/sdk';
import { admin, check, parseJson, requiredEnv, startApi, stopApis } from './support.mjs';

requiredEnv('DATABASE_URL');
const pepper = requiredEnv('FAD_API_KEY_PEPPER_V1');

function listen(server) {
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => resolvePromise(server.address().port));
  });
}

test('SDK retries, cancellation, redirects, and the live API', async () => {
  try {
  let attempts = 0;
  const retryServer = createServer((req, res) => {
    attempts += 1;
    if (req.headers['x-fad-api-key']) res.setHeader('x-saw-key', 'yes');
    if (attempts < 3) {
      res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '0' });
      res.end(JSON.stringify({
        error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'Service temporarily unavailable.' },
        meta: { request_id: '3b0fb35b-3c4c-489a-90fa-17232c7b8fda', api_version: 'v1' },
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      data: { id: '00000000-0000-4000-8000-000000000001', name: 'Retry', status: 'active', created_at: '2026-10-20T00:00:00.000Z' },
      meta: { request_id: '3b0fb35b-3c4c-489a-90fa-17232c7b8fda', api_version: 'v1' },
    }));
  });
  const retryPort = await listen(retryServer);
  const retryClient = new FadClient({
    baseUrl: `http://127.0.0.1:${retryPort}`,
    apiKey: 'fad_live.' + 'ab'.repeat(16) + '.' + 'A'.repeat(43),
    allowInsecureHttp: true,
    maxGetRetries: 2,
    maxRetryAfterMs: 20,
    timeoutMs: 2000,
  });
  const retried = await retryClient.organizations.current();
  check('S0-K03-retry', retried.data.name === 'Retry' && attempts === 3);
  const exhausted = new FadClient({
    baseUrl: `http://127.0.0.1:${retryPort}`,
    apiKey: 'fad_live.' + 'cd'.repeat(16) + '.' + 'B'.repeat(43),
    allowInsecureHttp: true,
    maxGetRetries: 0,
    timeoutMs: 2000,
  });
  retryServer.removeAllListeners('request');
  retryServer.on('request', (_req, res) => {
    res.writeHead(503, {
      'content-type': 'application/json',
      'retry-after': '1',
      'x-request-id': '3b0fb35b-3c4c-489a-90fa-17232c7b8fda',
    });
    res.end(JSON.stringify({
      error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'Service temporarily unavailable.' },
      meta: { request_id: '3b0fb35b-3c4c-489a-90fa-17232c7b8fda', api_version: 'v1' },
    }));
  });
  let dependency = null;
  try {
    await exhausted.organizations.current();
  } catch (err) {
    dependency = err;
  }
  check('S0-K03-503', dependency instanceof FadApiError && dependency.status === 503
    && dependency.code === 'DEPENDENCY_UNAVAILABLE'
    && dependency.requestId === '3b0fb35b-3c4c-489a-90fa-17232c7b8fda'
    && dependency.retryAfterSeconds === 1);
  attempts = 0;
  const noRetry = new FadClient({
    baseUrl: `http://127.0.0.1:${retryPort}`,
    apiKey: 'do-not-log-this-key-value',
    allowInsecureHttp: true,
    maxGetRetries: 2,
    maxRetryAfterMs: 20,
    timeoutMs: 2000,
  });
  retryServer.removeAllListeners('request');
  let unauthorizedAttempts = 0;
  retryServer.on('request', (_req, res) => {
    unauthorizedAttempts += 1;
    res.writeHead(401, { 'content-type': 'application/json', 'x-request-id': '11111111-1111-4111-8111-111111111111' });
    res.end(JSON.stringify({
      error: { code: 'UNAUTHORIZED', message: 'Invalid or missing API credential.' },
      meta: { request_id: '11111111-1111-4111-8111-111111111111', api_version: 'v1' },
    }));
  });
  let unauthorized = null;
  try {
    await noRetry.organizations.current();
  } catch (err) {
    unauthorized = err;
  }
  check('S0-K03-no-retry-401', unauthorized instanceof FadApiError && unauthorized.status === 401 && unauthorized.code === 'UNAUTHORIZED'
    && unauthorized.requestId === '11111111-1111-4111-8111-111111111111' && unauthorizedAttempts === 1
    && !String(unauthorized.stack).includes('do-not-log-this-key-value'));
  retryServer.close();

  const backoffAttempts = { n: 0, header: null };
  const backoffServer = createServer((_req, res) => {
    backoffAttempts.n += 1;
    const headers = { 'content-type': 'application/json' };
    if (backoffAttempts.header) headers['retry-after'] = backoffAttempts.header;
    res.writeHead(503, headers);
    res.end(JSON.stringify({
      error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'Service temporarily unavailable.' },
      meta: { request_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', api_version: 'v1' },
    }));
  });
  const backoffPort = await listen(backoffServer);
  async function observeBackoff(random, timeoutMs, capMs, header) {
    const delays = [];
    let clock = 0;
    backoffAttempts.n = 0;
    backoffAttempts.header = header;
    const client = new FadClient({
      baseUrl: `http://127.0.0.1:${backoffPort}`,
      apiKey: 'backoff-observer',
      allowInsecureHttp: true,
      maxGetRetries: 2,
      maxRetryAfterMs: capMs,
      timeoutMs,
      now: () => clock,
      random: () => random,
      sleep: async (ms) => {
        delays.push(ms);
        clock += ms;
      },
    });
    let error = null;
    try {
      await client.organizations.current();
    } catch (err) {
      error = err;
    }
    return { delays, error, attempts: backoffAttempts.n };
  }
  const low = await observeBackoff(0, 10_000, 30_000, null);
  const high = await observeBackoff(1, 10_000, 30_000, null);
  check('sdk-backoff-exponential', low.error instanceof FadApiError && low.error.status === 503
    && low.delays.length === 2 && low.delays[0] > 0 && low.delays[1] > low.delays[0]
    && high.delays.length === 2 && high.delays[1] > high.delays[0]
    && high.delays[0] > low.delays[0]);
  const capped = await observeBackoff(0, 10_000, 1000, '30');
  const deadline = await observeBackoff(0, 2500, 30_000, '2');
  check('sdk-backoff-cap', capped.delays.length === 2 && capped.delays.every((ms) => ms === 1000) && capped.attempts === 3
    && deadline.delays.length === 1 && deadline.delays[0] === 2000 && deadline.delays[0] < 2500
    && deadline.error instanceof FadApiError && deadline.error.status === 503);
  console.log(`sdk-backoff low ${low.delays.join(',')} high ${high.delays.join(',')} capped ${capped.delays.join(',')} deadline ${deadline.delays.join(',')}`);
  backoffServer.close();

  let stolen = 0;
  const sink = createServer((req, res) => {
    if (req.headers['x-fad-api-key']) stolen += 1;
    res.writeHead(200);
    res.end('no');
  });
  const sinkPort = await listen(sink);
  const redirector = createServer((_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.1:${sinkPort}/steal` });
    res.end();
  });
  const redirectPort = await listen(redirector);
  const redirectClient = new FadClient({
    baseUrl: `http://127.0.0.1:${redirectPort}`,
    apiKey: 'redirect-secret-key-value',
    allowInsecureHttp: true,
    maxGetRetries: 0,
    timeoutMs: 2000,
  });
  let redirectError = null;
  try {
    await redirectClient.organizations.current();
  } catch (err) {
    redirectError = err;
  }
  check('S0-K05', redirectError instanceof Error && redirectError.name === 'FadRedirectError' && stolen === 0
    && !String(redirectError.message).includes('redirect-secret-key-value'));
  redirector.close();
  sink.close();

  const hanging = createServer(() => {});
  const hangPort = await listen(hanging);
  const abortClient = new FadClient({
    baseUrl: `http://127.0.0.1:${hangPort}`,
    apiKey: 'abort-secret-key-value',
    allowInsecureHttp: true,
    timeoutMs: 2000,
  });
  const controller = new AbortController();
  const pending = abortClient.health.live({ signal: controller.signal });
  controller.abort();
  let aborted = null;
  try {
    await pending;
  } catch (err) {
    aborted = err;
  }
  check('S0-K04', aborted instanceof Error && aborted.name === 'AbortError' && !String(aborted.message).includes('abort-secret-key-value'));
  hanging.close();

  let insecure = false;
  try {
    new FadClient({ baseUrl: 'http://example.com', apiKey: 'x', allowInsecureHttp: true });
  } catch {
    insecure = true;
  }
  check('sdk-https', insecure);

  const cleaner = new pg.Client({ connectionString: requiredEnv('DATABASE_URL'), application_name: 'fad-sdk-test' });
  await cleaner.connect();
  await cleaner.query('DELETE FROM rate_limit_buckets');
  await cleaner.end();

  const org = parseJson((await admin(['organization', 'create', '--name', 'SDK Org'])).stdout);
  const principal = parseJson((await admin(['principal', 'create', '--organization-id', org.id, '--type', 'service', '--name', 'SDK'])).stdout);
  const key = parseJson((await admin(['credential', 'issue', '--organization-id', org.id, '--principal-id', principal.id, '--scopes', 'organizations:read'])).stdout);
  const noScope = parseJson((await admin(['credential', 'issue', '--organization-id', org.id, '--principal-id', principal.id, '--scopes', 'agents:lifecycle'])).stdout);
  const api = await startApi({ FAD_RATE_LIMIT_MAX: '3' });
  const client = new FadClient({
    baseUrl: api.base,
    apiKey: () => key.api_key,
    allowInsecureHttp: true,
    maxGetRetries: 0,
    timeoutMs: 3000,
  });
  const current = await client.organizations.current();
  const health = await client.health.live();
  const ready = await client.health.ready();
  check('S0-K02', current.data.id === org.id && current.meta.api_version === 'v1' && health.status === 'ok' && ready.status === 'ready');
  const forbiddenClient = new FadClient({
    baseUrl: api.base,
    apiKey: noScope.api_key,
    allowInsecureHttp: true,
    maxGetRetries: 0,
    timeoutMs: 3000,
  });
  let forbidden = null;
  try {
    await forbiddenClient.organizations.current();
  } catch (err) {
    forbidden = err;
  }
  check('S0-K03-403', forbidden instanceof FadApiError && forbidden.status === 403 && forbidden.code === 'FORBIDDEN' && typeof forbidden.requestId === 'string');
  let limited = null;
  for (let i = 0; i < 4; i += 1) {
    try {
      await client.organizations.current();
    } catch (err) {
      limited = err;
      break;
    }
  }
  check('S0-K03-429', limited instanceof FadApiError && limited.status === 429 && limited.code === 'RATE_LIMITED' && limited.retryAfterSeconds >= 1);
  const reset = new pg.Client({ connectionString: requiredEnv('DATABASE_URL'), application_name: 'fad-sdk-test' });
  reset.on('error', () => undefined);
  await reset.connect();
  await reset.query('DELETE FROM rate_limit_buckets');
  await reset.end();
  const bad = new FadClient({ baseUrl: api.base, apiKey: 'broken', allowInsecureHttp: true, maxGetRetries: 1, timeoutMs: 3000 });
  let badError = null;
  try {
    await bad.organizations.current();
  } catch (err) {
    badError = err;
  }
  check('S0-K03-401', badError instanceof FadApiError && badError.status === 401 && !api.logs().includes(key.api_key) && !api.logs().includes(pepper),
    `status=${badError && badError.status} code=${badError && badError.code}`);
  const agents = Object.keys(client);
  check('sdk-no-agents', !agents.includes('agents') && typeof client.organizations.current === 'function');
  await api.stop();
  } finally {
    await stopApis();
  }
});
