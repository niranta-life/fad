import { mkdtempSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { buildApp } from '../apps/api/dist/app.js';
import { loadConfig } from '../apps/api/dist/config.js';
import { admin, check, freePort, parseJson, request, requiredEnv, run, scratch, startApi, stopApis, writeEvidence } from './support.mjs';

const { Client } = pg;
const pepper = requiredEnv('FAD_API_KEY_PEPPER_V1');
const appUrl = requiredEnv('DATABASE_URL');
const migratorUrl = requiredEnv('FAD_MIGRATOR_DATABASE_URL');

function rawHttp(port, raw) {
  return new Promise((resolvePromise, reject) => {
    const socket = connect(port, '127.0.0.1');
    let data = '';
    socket.setTimeout(4000);
    socket.on('timeout', () => {
      socket.destroy();
      resolvePromise(data || 'TIMEOUT');
    });
    socket.on('data', (chunk) => {
      data += chunk;
    });
    socket.on('error', reject);
    socket.on('end', () => resolvePromise(data));
    socket.end(raw);
  });
}

test('HTTP tenant boundary, credentials, replicas, and database outage', async () => {
  const cleaner = new Client({ connectionString: migratorUrl });
  cleaner.on('error', () => undefined);
  await cleaner.connect();
  try {
  await cleaner.query('DELETE FROM rate_limit_buckets');
  const orgA = parseJson((await admin(['organization', 'create', '--name', 'HTTP Org A'])).stdout);
  const orgB = parseJson((await admin(['organization', 'create', '--name', 'HTTP Org B'])).stdout);
  const principalA = parseJson((await admin(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'HTTP A'])).stdout);
  const principalB = parseJson((await admin(['principal', 'create', '--organization-id', orgB.id, '--type', 'service', '--name', 'HTTP B'])).stdout);
  const issuedA = parseJson((await admin(['credential', 'issue', '--organization-id', orgA.id, '--principal-id', principalA.id, '--scopes', 'organizations:read'])).stdout);
  const issuedB = parseJson((await admin(['credential', 'issue', '--organization-id', orgB.id, '--principal-id', principalB.id, '--scopes', 'organizations:read'])).stdout);
  const noScope = parseJson((await admin(['credential', 'issue', '--organization-id', orgA.id, '--principal-id', principalA.id, '--scopes', 'agents:read'])).stdout);
  const listed = await admin(['credential', 'list', '--organization-id', orgA.id]);
  const listText = listed.stdout + listed.stderr;
  check('S0-I01', issuedA.api_key.startsWith('fad_live.') && issuedA.api_key.length === 85 && !listText.includes(issuedA.api_key) && !listText.includes('verifier'));
  const audit = await cleaner.query(`SELECT details::text AS details FROM audit_events WHERE action = 'credential.issue'`);
  const auditText = audit.rows.map((row) => row.details).join('\n');
  check('S0-I01-audit', !auditText.includes(issuedA.api_key) && !auditText.includes('verifier_hmac'));

  const secrets = [issuedA.api_key, issuedB.api_key, noScope.api_key, pepper];
  async function exercise(server, label) {
    const live = await request(`${server.base}/health/live`);
    check(`${label}-A01`, live.status === 200 && live.json.status === 'ok' && live.headers['cache-control'] === 'no-store' && !live.text.includes('postgres'));
    const ready = await request(`${server.base}/health/ready`);
    check(`${label}-A02`, ready.status === 200 && ready.json.status === 'ready' && ready.headers['cache-control'] === 'no-store');
    const currentA = await request(`${server.base}/v1/organizations/current`, { headers: { 'X-FAD-API-Key': issuedA.api_key } });
    check('S0-A04', currentA.status === 200 && currentA.json.data.id === orgA.id && currentA.json.meta.api_version === 'v1'
      && currentA.headers['cache-control'] === 'private, no-store'
      && currentA.headers['x-request-id'] === currentA.json.meta.request_id
      && !currentA.text.includes(issuedA.api_key));
    const currentB = await request(`${server.base}/v1/organizations/current`, { headers: { 'X-FAD-API-Key': issuedB.api_key } });
    check('S0-A05', currentB.status === 200 && currentB.json.data.id === orgB.id && currentB.json.data.id !== orgA.id);
    const switched = await request(`${server.base}/v1/organizations/current`, {
      headers: { 'X-FAD-API-Key': issuedA.api_key, 'X-Organization-Id': orgB.id },
    });
    check('S0-A06', switched.status === 200 && switched.json.data.id === orgA.id);
    const query = await request(`${server.base}/v1/organizations/current?organization_id=${orgB.id}`, {
      headers: { 'X-FAD-API-Key': issuedA.api_key },
    });
    check('S0-A07', query.status === 400 && query.json.error.code === 'VALIDATION_ERROR');
    const missing = await request(`${server.base}/v1/organizations/current`);
    const malformed = await request(`${server.base}/v1/organizations/current`, { headers: { 'X-FAD-API-Key': 'broken' } });
    const unknown = await request(`${server.base}/v1/organizations/current`, {
      headers: { 'X-FAD-API-Key': `fad_live.${'ab'.repeat(16)}.${'A'.repeat(43)}` },
    });
    const wrong = await request(`${server.base}/v1/organizations/current`, {
      headers: { 'X-FAD-API-Key': `${issuedA.api_key.slice(0, -2)}aa` },
    });
    const unauthorized = [missing, malformed, unknown, wrong];
    check('S0-A08', unauthorized.every((item) => item.status === 401 && item.json.error.code === 'UNAUTHORIZED' && item.json.error.message === missing.json.error.message)
      && unauthorized.every((item) => !item.text.includes(issuedA.kid) && !item.text.includes('verifier')));
    const forbidden = await request(`${server.base}/v1/organizations/current`, { headers: { 'X-FAD-API-Key': noScope.api_key } });
    check('S0-A10', forbidden.status === 403 && forbidden.json.error.code === 'FORBIDDEN');
    const posted = await request(`${server.base}/v1/organizations/current`, { method: 'POST', headers: { 'X-FAD-API-Key': issuedA.api_key } });
    check('S0-A13', posted.status === 405 && posted.json.error.code === 'METHOD_NOT_ALLOWED');
    const transcript = [live, ready, currentA, currentB, switched, query, missing, malformed, unknown, wrong, forbidden, posted]
      .map((item) => `${item.status} ${JSON.stringify(item.json)}`)
      .join('\n');
    writeEvidence(`${label}.json`, transcript, secrets);
    check(`${label}-logs`, !server.logs().includes(issuedA.api_key) && !server.logs().includes(pepper));
    return { currentA, missing };
  }

  const first = await startApi({});
  check('launch-1-up', first.ready);
  await exercise(first, 'launch-1');
  const firstExit = await first.stop();
  check('launch-1-stop', firstExit === 0);

  const second = await startApi({});
  check('launch-2-up', second.ready);
  const live2 = await request(`${second.base}/health/live`);
  const ready2 = await request(`${second.base}/health/ready`);
  const again = await request(`${second.base}/v1/organizations/current`, { headers: { 'X-FAD-API-Key': issuedA.api_key } });
  check('S0-A01', live2.status === 200 && live2.json.status === 'ok');
  check('S0-A02', ready2.status === 200 && ready2.json.status === 'ready');
  check('launch-2-org', again.status === 200 && again.json.data.id === orgA.id && again.json.meta.api_version === 'v1');

  const expired = parseJson((await admin([
    'credential', 'issue', '--organization-id', orgA.id, '--principal-id', principalA.id, '--scopes', 'organizations:read',
  ])).stdout);
  await cleaner.query(`UPDATE api_credentials SET expires_at = created_at + interval '1 millisecond' WHERE kid = $1`, [expired.kid]);
  const expiredResponse = await request(`${second.base}/v1/organizations/current`, { headers: { 'X-FAD-API-Key': expired.api_key } });
  check('S0-A09-expired', expiredResponse.status === 401 && expiredResponse.json.error.code === 'UNAUTHORIZED');

  const orgC = parseJson((await admin(['organization', 'create', '--name', 'HTTP Suspended'])).stdout);
  const principalC = parseJson((await admin(['principal', 'create', '--organization-id', orgC.id, '--type', 'service', '--name', 'HTTP C'])).stdout);
  const suspendedKey = parseJson((await admin(['credential', 'issue', '--organization-id', orgC.id, '--principal-id', principalC.id, '--scopes', 'organizations:read'])).stdout);
  check('suspend', (await admin(['organization', 'suspend', '--organization-id', orgC.id, '--reason', 'incident'])).code === 0);
  const suspended = await request(`${second.base}/v1/organizations/current`, { headers: { 'X-FAD-API-Key': suspendedKey.api_key } });
  const orgD = parseJson((await admin(['organization', 'create', '--name', 'HTTP Disabled'])).stdout);
  const principalD = parseJson((await admin(['principal', 'create', '--organization-id', orgD.id, '--type', 'service', '--name', 'HTTP D'])).stdout);
  const disabledKey = parseJson((await admin(['credential', 'issue', '--organization-id', orgD.id, '--principal-id', principalD.id, '--scopes', 'organizations:read'])).stdout);
  check('disable', (await admin(['principal', 'disable', '--organization-id', orgD.id, '--principal-id', principalD.id, '--reason', 'incident'])).code === 0);
  const disabled = await request(`${second.base}/v1/organizations/current`, { headers: { 'X-FAD-API-Key': disabledKey.api_key } });
  check('S0-A11', suspended.status === 401 && disabled.status === 401 && suspended.json.error.message === disabled.json.error.message
    && !suspended.text.includes('suspended') && !disabled.text.includes('disabled'));

  const oversized = await rawHttp(second.port, `GET /v1/organizations/current HTTP/1.1\r\nHost: 127.0.0.1\r\nX-FAD-API-Key: ${'a'.repeat(300)}\r\nConnection: close\r\n\r\n`);
  const repeated = await rawHttp(second.port, `GET /v1/organizations/current HTTP/1.1\r\nHost: 127.0.0.1\r\nX-FAD-API-Key: ${issuedA.api_key}\r\nX-FAD-API-Key: ${issuedB.api_key}\r\nConnection: close\r\n\r\n`);
  const withBody = await rawHttp(second.port, `GET /v1/organizations/current HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`);
  check('S0-A12', oversized.includes(' 401 ') && repeated.includes(' 401 ') && withBody.includes(' 400 ') && !oversized.includes(pepper));

  const successor = parseJson((await admin(['credential', 'issue', '--organization-id', orgA.id, '--principal-id', principalA.id, '--scopes', 'organizations:read'])).stdout);
  const revoked = await admin(['credential', 'revoke', '--organization-id', orgA.id, '--kid', issuedA.kid, '--reason', 'rotation']);
  check('S0-I03-cli', revoked.code === 0 && successor.api_key !== issuedA.api_key);
  secrets.push(successor.api_key);

  const portB = await freePort();
  const replica = await startApi({ PORT: String(portB), FAD_RATE_LIMIT_MAX: '1000' });
  const oldOnSecond = await request(`${second.base}/v1/organizations/current`, { headers: { 'X-FAD-API-Key': issuedA.api_key } });
  const oldOnReplica = await request(`${replica.base}/v1/organizations/current`, { headers: { 'X-FAD-API-Key': issuedA.api_key } });
  const newOnSecond = await request(`${second.base}/v1/organizations/current`, { headers: { 'X-FAD-API-Key': successor.api_key } });
  const newOnReplica = await request(`${replica.base}/v1/organizations/current`, { headers: { 'X-FAD-API-Key': successor.api_key } });
  check('S0-A09', oldOnSecond.status === 401 && oldOnReplica.status === 401 && newOnSecond.json.data.id === orgA.id && newOnReplica.json.data.id === orgA.id);
  check('S0-O02', newOnSecond.json.data.id === orgA.id && newOnReplica.json.data.id === orgB.id
    ? false
    : newOnReplica.json.data.id === orgA.id && (await request(`${replica.base}/v1/organizations/current`, { headers: { 'X-FAD-API-Key': issuedB.api_key } })).json.data.id === orgB.id);

  await second.stop();
  await replica.stop();
  await cleaner.query('DELETE FROM rate_limit_buckets');
  const limitA = await startApi({ FAD_RATE_LIMIT_MAX: '2', FAD_RATE_LIMIT_WINDOW_SECONDS: '60' });
  const limitB = await startApi({ FAD_RATE_LIMIT_MAX: '2', FAD_RATE_LIMIT_WINDOW_SECONDS: '60' });
  const firstHit = await request(`${limitA.base}/v1/organizations/current`, { headers: { 'X-FAD-API-Key': successor.api_key } });
  const secondHit = await request(`${limitA.base}/v1/organizations/current`, { headers: { 'X-FAD-API-Key': successor.api_key } });
  const thirdHit = await request(`${limitB.base}/v1/organizations/current`, { headers: { 'X-FAD-API-Key': successor.api_key } });
  check('S0-A14', firstHit.status === 200 && secondHit.status === 200 && thirdHit.status === 429
    && thirdHit.json.error.code === 'RATE_LIMITED' && Number(thirdHit.headers['retry-after']) >= 1);

  const emptyDir = mkdtempSync(join(scratch, 'empty-migrations-'));
  const missingStartup = await startApi({ FAD_MIGRATIONS_DIR: emptyDir });
  check('S0-A03-empty-startup', missingStartup.ready === false && missingStartup.child.exitCode !== null
    && missingStartup.logs().includes('schema migration is missing'));
  await missingStartup.stop();
  const emptyConfig = loadConfig({
    ...process.env,
    NODE_ENV: 'development',
    FAD_BIND_HOST: '127.0.0.1',
    FAD_INGRESS_TLS: 'cleartext',
    FAD_TRUST_PROXY: 'false',
    FAD_MIGRATIONS_DIR: emptyDir,
    FAD_RATE_LIMIT_BACKEND: 'postgres',
  });
  const emptyPool = new Client({ connectionString: appUrl });
  emptyPool.on('error', () => undefined);
  await emptyPool.connect();
  const emptyApp = await buildApp({ config: emptyConfig, pool: emptyPool });
  await emptyApp.app.listen({ port: 0, host: '127.0.0.1' });
  const emptyListen = emptyApp.app.server.address();
  const emptyPort = typeof emptyListen === 'object' && emptyListen ? emptyListen.port : 0;
  const emptyBase = `http://127.0.0.1:${emptyPort}`;
  const emptyReady = await request(`${emptyBase}/health/ready`);
  const emptyCurrent = await request(`${emptyBase}/v1/organizations/current`, { headers: { 'X-FAD-API-Key': successor.api_key } });
  await emptyApp.app.close();
  await emptyPool.end();
  check('S0-A03-empty-ready', emptyReady.status === 503 && emptyReady.json.status === 'not_ready'
    && emptyCurrent.status === 503 && emptyCurrent.json.error.code === 'DEPENDENCY_UNAVAILABLE' && emptyCurrent.json.data === undefined);

  const schemaApi = await startApi({ FAD_RATE_LIMIT_MAX: '1000' });
  const savedMigrations = await cleaner.query('SELECT version, checksum_sha256 FROM schema_migrations ORDER BY version');
  let readyBad = null;
  let currentBad = null;
  try {
    await cleaner.query('UPDATE schema_migrations SET checksum_sha256 = $2 WHERE version = $1', [savedMigrations.rows[0].version, 'ab'.repeat(32)]);
    readyBad = await request(`${schemaApi.base}/health/ready`);
    currentBad = await request(`${schemaApi.base}/v1/organizations/current`, { headers: { 'X-FAD-API-Key': successor.api_key } });
  } finally {
    for (const row of savedMigrations.rows) {
      await cleaner.query('UPDATE schema_migrations SET checksum_sha256 = $2 WHERE version = $1', [row.version, row.checksum_sha256]);
    }
  }
  const readyRestored = await request(`${schemaApi.base}/health/ready`);
  const currentRestored = await request(`${schemaApi.base}/v1/organizations/current`, { headers: { 'X-FAD-API-Key': successor.api_key } });
  check('S0-A03-schema', readyBad?.status === 503 && readyBad.json.status === 'not_ready'
    && currentBad?.status === 503 && currentBad.json.error.code === 'DEPENDENCY_UNAVAILABLE' && currentBad.json.data === undefined
    && readyRestored.status === 200 && readyRestored.json.status === 'ready'
    && currentRestored.status === 200 && currentRestored.json.data.id === orgA.id);
  console.log(`S0-A03-schema ready ${readyBad.status} ${JSON.stringify(readyBad.json)} current ${currentBad.status} ${JSON.stringify(currentBad.json)} restored-ready ${readyRestored.status} restored-current ${currentRestored.status}`);
  await schemaApi.stop();

  const outage = await startApi({ FAD_RATE_LIMIT_MAX: '1000' });
  const { spawn } = await import('node:child_process');
  await new Promise((resolvePromise, reject) => {
    const child = spawn('docker', ['stop', 'fad-s0-pg']);
    child.on('close', (code) => (code === 0 ? resolvePromise() : reject(new Error('docker stop failed'))));
  });
  let notReady = null;
  let unavailable = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    notReady = await request(`${outage.base}/health/ready`);
    unavailable = await request(`${outage.base}/v1/organizations/current`, { headers: { 'X-FAD-API-Key': successor.api_key } });
    if (notReady.status === 503 && unavailable.status === 503) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  const liveDuring = await request(`${outage.base}/health/live`);
  check('S0-A03', liveDuring.status === 200 && notReady?.status === 503 && notReady.json.status === 'not_ready'
    && unavailable?.status === 503 && unavailable.json.error.code === 'DEPENDENCY_UNAVAILABLE');
  await new Promise((resolvePromise, reject) => {
    const child = spawn('docker', ['start', 'fad-s0-pg']);
    child.on('close', (code) => (code === 0 ? resolvePromise() : reject(new Error('docker start failed'))));
  });
  let recovered = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    recovered = await request(`${outage.base}/health/ready`);
    if (recovered.status === 200) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  }
  const after = await request(`${outage.base}/v1/organizations/current`, { headers: { 'X-FAD-API-Key': successor.api_key } });
  check('S0-O04', recovered?.status === 200 && recovered.json.status === 'ready' && after.status === 200 && after.json.data.id === orgA.id);
  const shutdown = await outage.stop();
  check('S0-O03', shutdown === 0);
  await limitA.stop();
  await limitB.stop();

  await cleaner.end().catch(() => undefined);
  const afterOutage = new Client({ connectionString: migratorUrl });
  afterOutage.on('error', () => undefined);
  await afterOutage.connect();
  const durable = await afterOutage.query(`SELECT count(*)::int AS orgs FROM organizations`);
  const audits = await afterOutage.query(`SELECT count(*)::int AS audits FROM audit_events WHERE action = 'organization.create'`);
  check('S0-O05-db', durable.rows[0].orgs > 0 && audits.rows[0].audits > 0);
  await afterOutage.end();
  writeEvidence('http-summary.txt', `orgA ${orgA.id}\norgB ${orgB.id}\nrevoked ${issuedA.kid}\n`, secrets);
  } finally {
  await stopApis();
  await run('docker', ['start', 'fad-s0-pg']);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const ready = await run('docker', ['exec', 'fad-s0-pg', 'pg_isready', '-U', 'postgres', '-d', 'fad']);
    if (ready.code === 0) break;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  await cleaner.end().catch(() => undefined);
}
});
