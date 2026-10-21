import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { contractSha256, readMigrationFiles } from '@fad/db';
import { applyMigrations } from '@fad/migrator';
import { matrix, sdkConsumer } from './slice3-matrix.mjs';
import { admin, check, parseJson, request, requiredEnv, scratch, startApi, stopApis, writeEvidence } from './support.mjs';

const { Client } = pg;
const appUrl = requiredEnv('DATABASE_URL');
const migratorUrl = requiredEnv('FAD_MIGRATOR_DATABASE_URL');
const pepper = requiredEnv('FAD_API_KEY_PEPPER_V1');
const migrationsDir = new URL('../db/migrations/', import.meta.url).pathname;
const FULL = [
  'organizations:read', 'agents:read', 'agents:write', 'agents:lifecycle',
  'tags:define', 'tags:read', 'tags:write', 'tags:governance', 'tags:restricted:read',
  'capabilities:read', 'capabilities:write', 'endpoints:read', 'endpoints:write',
].join(',');
const READER = 'agents:read,capabilities:read,endpoints:read,tags:read';
const NO_TAGS = 'agents:read,capabilities:read,endpoints:read';
const AGENT_ONLY = 'organizations:read,agents:read,agents:write,agents:lifecycle';
const SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  properties: { invoice_id: { type: 'string' } },
  required: ['invoice_id'],
};
const P0 = [
  'API-01', 'API-02', 'API-03', 'API-04', 'API-05', 'API-06', 'API-07', 'API-08', 'API-09', 'API-10',
  'API-11', 'API-12', 'API-13', 'API-14', 'API-15', 'API-16', 'API-17', 'API-18', 'API-19', 'API-20',
  'API-21', 'API-22', 'API-23', 'API-24',
  'AUTH-01', 'AUTH-02', 'AUTH-03', 'AUTH-04', 'AUTH-05', 'AUTH-06', 'AUTH-07', 'AUTH-08', 'AUTH-09',
  'AUTH-10', 'AUTH-11', 'AUTH-12', 'AUTH-13', 'AUTH-14', 'AUTH-15', 'AUTH-16', 'AUTH-17', 'AUTH-18',
  'AUTH-19', 'AUTH-20', 'AUTH-21', 'AUTH-22',
  'CON-01', 'CON-02', 'CON-03', 'CON-04', 'CON-05', 'CON-06', 'CON-07', 'CON-08', 'CON-09', 'CON-10',
  'CON-11', 'CON-12',
  'VAL-01', 'VAL-02', 'VAL-03', 'VAL-04', 'VAL-05', 'VAL-06', 'VAL-07', 'VAL-08', 'VAL-09', 'VAL-10',
  'VAL-11', 'VAL-12', 'VAL-13', 'VAL-14',
  'DUR-01', 'DUR-02', 'DUR-03', 'DUR-04', 'DUR-05', 'DUR-06', 'DUR-07', 'DUR-08',
  'SDK-01', 'SDK-02', 'SDK-03', 'SDK-04', 'SDK-05', 'SDK-06',
  'DEP-01', 'DEP-02', 'DEP-03', 'DEP-04',
];

function call(base, method, path, key, body, headers = {}) {
  const requestHeaders = { ...headers };
  if (key) requestHeaders['x-fad-api-key'] = key;
  if (body !== undefined) requestHeaders['content-type'] = requestHeaders['content-type'] ?? 'application/json';
  return request(`${base}${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

async function count(client, sql, params = []) {
  const result = await client.query(sql, params);
  return result.rows[0].n;
}

function publishBody(id, version, display = 'Match invoices') {
  return {
    id,
    version,
    display_name: display,
    description: 'Declared invoice match contract',
    input_schema: SCHEMA,
    output_schema: SCHEMA,
  };
}

test('slice 3 capabilities, endpoints, bindings, and local discovery', { timeout: 1_800_000 }, async () => {
  const seen = new Set();
  function pass(id, condition, detail = '') {
    seen.add(id);
    check(id, condition, detail);
  }
  await applyMigrations(migratorUrl, migrationsDir);
  const superuser = new Client({ connectionString: migratorUrl, application_name: 'fad-slice3-super' });
  const app = new Client({ connectionString: appUrl, application_name: 'fad-slice3-app' });
  superuser.on('error', () => undefined);
  app.on('error', () => undefined);
  await superuser.connect();
  await app.connect();
  const guardLog = join(scratch, 'slice3-net-guard.log');
  writeFileSync(guardLog, '');
  const guardUrl = new URL('./slice3-net-guard.mjs', import.meta.url).href;
  const apiEnv = {
    FAD_TAGS_ENABLED: 'true',
    FAD_SLICE3_ENABLED: 'true',
    FAD_HTTP_REQUEST_TIMEOUT_MS: '30000',
    FAD_SHUTDOWN_GRACE_MS: '30000',
    FAD_DB_POOL_MAX: '12',
    FAD_RATE_LIMIT_MAX: '8000',
    FAD_NET_GUARD_LOG: guardLog,
    NODE_OPTIONS: `--import ${guardUrl}`,
  };
  let api;
  try {
  api = await startApi(apiEnv);
  const secrets = [pepper];
  const slice3File = readMigrationFiles(migrationsDir).find((file) => file.version === '20261022_001_capabilities_discovery');
  const storedMigration = await superuser.query(
    'SELECT checksum_sha256 FROM schema_migrations WHERE version = $1',
    [slice3File.version],
  );
  const migrationProof = [
    `version=${slice3File.version}`,
    `file_sha256=${slice3File.checksum}`,
    `db_sha256=${storedMigration.rows[0]?.checksum_sha256 ?? 'missing'}`,
    `match=${storedMigration.rows[0]?.checksum_sha256 === slice3File.checksum}`,
  ].join('\n');
  writeEvidence('migration-proof.txt', `${migrationProof}\n`, secrets);
  check('MIGRATION', storedMigration.rows[0]?.checksum_sha256 === slice3File.checksum, migrationProof);
  const launchLog = [];
    pass('API-00-up', api.ready, api.logs().slice(-500));
    await superuser.query('DELETE FROM rate_limit_buckets');
    const journey = await runJourney(api.base, 'a', secrets, superuser, app, pass, launchLog);
    writeEvidence('launch-1.json', JSON.stringify(launchLog, null, 2), secrets);
    await api.stop();
    const api2 = await startApi(apiEnv);
    pass('DUR-04', api2.ready, api2.logs().slice(-400));
    const again = await call(api2.base, 'GET', `/v1/agents/${journey.agentId}/endpoints/primary`, journey.key);
    pass('DUR-04b', again.status === 200 && again.headers.etag === '"endpoint-v5"' && again.json.data.revision === 5, `${again.status} ${again.headers.etag} rev=${again.json?.data?.revision}`);
    const launch2 = [];
    await runJourney(api2.base, 'b', secrets, superuser, app, () => undefined, launch2);
    writeEvidence('launch-2.json', JSON.stringify(launch2, null, 2), secrets);
    check('JOURNEY-B', launch2.filter((item) => item.step >= 'A' && item.step <= 'K').length >= 11);

    await matrix(api2, journey, secrets, superuser, app, pass, guardLog);
    const missing = P0.filter((id) => !seen.has(id));
    check('P0-COVERAGE', missing.length === 0, missing.join(','));
    console.log('NOT RUN PERF-01 no published 100k dataset in this environment');
    console.log('NOT RUN PERF-02 no published 1M binding dataset in this environment');
    console.log('NOT RUN PERF-03 no hot-tenant load harness in this environment');
    writeEvidence('perf.txt', 'NOT RUN PERF-01\nNOT RUN PERF-02\nNOT RUN PERF-03\n', secrets);
    await api2.stop();
  } finally {
    await stopApis();
    execFileSync('docker', ['rm', '-f', 'fad-s3-old', 'fad-s3-new', 'fad-s3-a', 'fad-s3-b', 'fad-s3-c'], { stdio: 'ignore' });
    await superuser.end().catch(() => undefined);
    await app.end().catch(() => undefined);
  }

  async function runJourney(base, label, secretList, root, runtime, record, log) {
    const orgA = parseJson((await admin(['organization', 'create', '--name', `Slice3 ${label} A`])).stdout);
    const orgB = parseJson((await admin(['organization', 'create', '--name', `Slice3 ${label} B`])).stdout);
    const actorA = parseJson((await admin(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', `Actor ${label}`])).stdout);
    const owner = parseJson((await admin(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', `Owner ${label}`])).stdout);
    const actorB = parseJson((await admin(['principal', 'create', '--organization-id', orgB.id, '--type', 'service', '--name', `Actor B ${label}`])).stdout);
    const issued = async (org, principal, scopes) => parseJson((await admin([
      'credential', 'issue', '--organization-id', org, '--principal-id', principal, '--scopes', scopes,
    ])).stdout);
    const keyA = await issued(orgA.id, actorA.id, FULL);
    const keyB = await issued(orgB.id, actorB.id, FULL);
    const keyOld = await issued(orgA.id, actorA.id, AGENT_ONLY);
    secretList.push(keyA.api_key, keyB.api_key, keyOld.api_key);
    log.push({ step: 'A', orgA: orgA.id, orgB: orgB.id, request: 'credential issue' });

    const created = await call(base, 'POST', '/v1/agents', keyA.api_key, {
      name: 'Invoice Processing Agent',
      description: 'Matches supplier invoices',
      owner_principal_id: owner.id,
    }, { 'idempotency-key': `s3-${label}-agent-0001` });
    const agentId = created.json?.data?.id;
    const agentEtag = created.headers.etag;
    const defined = await call(base, 'POST', '/v1/tag-definitions', keyA.api_key, {
      namespace: 'department', key: 'name', value_type: 'string', governed: false, visibility: 'internal',
    }, { 'idempotency-key': `s3-${label}-tagdef-001` });
    const assigned = await call(base, 'PUT', `/v1/agents/${agentId}/tags/department/name`, keyA.api_key, {
      value: 'finance',
    }, { 'idempotency-key': `s3-${label}-tagput-001`, 'if-none-match': '*' });
    log.push({ step: 'B', status: created.status, tag: assigned.status, request_id: created.json?.meta?.request_id });
    if (label === 'a') {
      record('API-23', created.status === 201 && created.headers.etag === '"agent-v1"' && !('capabilities' in created.json.data));
    }

    const body = publishBody('finance.invoice.match', '1.0.0');
    const expectedHash = contractSha256({ ...body, description: body.description });
    const published = await call(base, 'POST', '/v1/capabilities', keyA.api_key, body, { 'idempotency-key': `s3-${label}-cap-000001` });
    const readBack = await call(base, 'GET', '/v1/capabilities/finance.invoice.match/versions/1.0.0', keyA.api_key);
    const listed = await call(base, 'GET', '/v1/capabilities?id=finance.invoice.match', keyA.api_key);
    const replay = await call(base, 'POST', '/v1/capabilities', keyA.api_key, body, { 'idempotency-key': `s3-${label}-cap-000001` });
    const rowsAfterReplay = await count(root, 'SELECT count(*)::int AS n FROM capability_versions WHERE organization_id = $1 AND capability_id = $2 AND version = $3', [orgA.id, 'finance.invoice.match', '1.0.0']);
    const conflict = await call(base, 'POST', '/v1/capabilities', keyA.api_key, body, { 'idempotency-key': `s3-${label}-cap-000002` });
    log.push({ step: 'C', status: published.status, hash: published.json?.data?.contract_sha256, replay: replay.status, conflict: conflict.status });
    if (label === 'a') {
      const capAudits = await count(root, `SELECT count(*)::int AS n FROM audit_events WHERE organization_id = $1 AND action = 'capability.published' AND target_id = $2`, [orgA.id, 'finance.invoice.match@1.0.0']);
      record('API-01', published.status === 201 && published.headers.location === '/v1/capabilities/finance.invoice.match/versions/1.0.0'
        && published.json.data.contract_sha256 === expectedHash && published.json.data.verification === 'self_declared'
        && published.json.data.published_by === actorA.id && published.json.meta.api_version === 'v1');
      record('API-02', readBack.status === 200 && readBack.json.data.contract_sha256 === expectedHash
        && JSON.stringify(readBack.json.data.input_schema) === JSON.stringify(published.json.data.input_schema));
      record('API-05', replay.status === 201 && replay.json.data.contract_sha256 === expectedHash && rowsAfterReplay === 1
        && replay.json.data.published_at === published.json.data.published_at && capAudits === 1);
      record('API-04', conflict.status === 409 && conflict.json.error.code === 'ALREADY_EXISTS');
    }

    const endpointBody = { protocol: 'a2a', url: 'https://ap.internal.example/a2a', auth_scheme: 'oauth2' };
    const endpoint = await call(base, 'PUT', `/v1/agents/${agentId}/endpoints/primary`, keyA.api_key, endpointBody, {
      'idempotency-key': `s3-${label}-ep-0000001`, 'if-none-match': '*',
    });
    const endpointGet = await call(base, 'GET', `/v1/agents/${agentId}/endpoints/primary`, keyA.api_key);
    log.push({ step: 'D', status: endpoint.status, etag: endpoint.headers.etag, request_id: endpoint.json?.meta?.request_id });
    if (label === 'a') {
      record('API-07', endpoint.status === 201 && endpoint.headers.etag === '"endpoint-v1"'
        && endpoint.json.data.url === 'https://ap.internal.example/a2a' && endpoint.json.data.verification === 'self_declared');
      record('API-08', endpointGet.status === 200 && endpointGet.headers.etag === '"endpoint-v1"'
        && endpointGet.json.data.protocol === 'a2a' && endpointGet.json.data.auth_scheme === 'oauth2' && endpointGet.json.data.enabled === true);
    }

    const binding = await call(base, 'PUT', `/v1/agents/${agentId}/capabilities/finance.invoice.match`, keyA.api_key, {
      version: '1.0.0', endpoint_key: 'primary',
    }, { 'idempotency-key': `s3-${label}-bind-00001`, 'if-none-match': '*' });
    const bindingGet = await call(base, 'GET', `/v1/agents/${agentId}/capabilities/finance.invoice.match`, keyA.api_key);
    log.push({ step: 'E', status: binding.status, etag: binding.headers.etag });
    if (label === 'a') {
      record('API-11', binding.status === 201 && binding.headers.etag === '"cap-binding-v1"' && binding.json.data.verification === 'self_declared');
      record('API-12', bindingGet.status === 200 && bindingGet.headers.etag === '"cap-binding-v1"'
        && bindingGet.json.data.version === '1.0.0' && bindingGet.json.data.endpoint_key === 'primary');
    }

    const discovered = await call(base, 'POST', '/v1/discovery/agents', keyA.api_key, {
      capability: { id: 'finance.invoice.match', version: '1.0.0' },
      tags: [{ namespace: 'department', key: 'name', operator: 'eq', value: 'finance' }],
      protocols: ['a2a'],
    });
    const agentAfter = await call(base, 'GET', `/v1/agents/${agentId}`, keyA.api_key);
    const tagAfter = await call(base, 'GET', `/v1/agents/${agentId}/tags/department/name`, keyA.api_key);
    log.push({
      step: 'F',
      status: discovered.status,
      availability: discovered.json?.data?.[0]?.availability,
      authorization: discovered.json?.data?.[0]?.invocation_authorization,
      request_id: discovered.json?.meta?.request_id,
    });
    if (label === 'a') {
      const match = discovered.json?.data?.[0];
      record('API-15', discovered.status === 200 && discovered.json.data.length === 1 && match.agent.id === agentId
        && match.capability.verification === 'self_declared' && match.endpoint.key === 'primary'
        && match.availability === 'not_checked' && match.invocation_authorization === 'not_evaluated'
        && match.agent.revision === 1);
      record('API-16', (await call(base, 'POST', '/v1/discovery/agents', keyA.api_key, {
        capability: { id: 'finance.invoice.match' }, protocols: ['a2a'],
      })).json.data.some((item) => item.agent.id === agentId));
      record('API-23', agentAfter.status === 200 && agentAfter.headers.etag === agentEtag && agentAfter.json.data.revision === 1
        && !('capabilities' in agentAfter.json.data) && !('endpoints' in agentAfter.json.data));
      record('API-24', assigned.headers.etag === '"tag-v1"' && tagAfter.headers.etag === '"tag-v1"' && tagAfter.json.data.value === 'finance');
    }

    const unknownAgent = '00000000-0000-4000-8000-000000000001';
    const foreignCap = await call(base, 'GET', '/v1/capabilities/finance.invoice.match/versions/1.0.0', keyB.api_key);
    const missingCap = await call(base, 'GET', '/v1/capabilities/finance.invoice.missing/versions/1.0.0', keyB.api_key);
    const foreignEp = await call(base, 'GET', `/v1/agents/${agentId}/endpoints/primary`, keyB.api_key);
    const unknownEp = await call(base, 'GET', `/v1/agents/${unknownAgent}/endpoints/primary`, keyB.api_key);
    const foreignBind = await call(base, 'GET', `/v1/agents/${agentId}/capabilities/finance.invoice.match`, keyB.api_key);
    const unknownBind = await call(base, 'GET', `/v1/agents/${unknownAgent}/capabilities/finance.invoice.match`, keyB.api_key);
    const foreignDisc = await call(base, 'POST', '/v1/discovery/agents', keyB.api_key, {
      capability: { id: 'finance.invoice.match', version: '1.0.0' },
      protocols: ['a2a'],
    });
    log.push({ step: 'G', foreign: foreignCap.status, discovery: foreignDisc.status, count: foreignDisc.json?.data?.length });
    if (label === 'a') {
      record('AUTH-09', foreignEp.status === 404 && unknownEp.status === 404
        && foreignEp.json.error.code === unknownEp.json.error.code
        && foreignBind.status === 404 && unknownBind.status === 404
        && foreignBind.json.error.code === unknownBind.json.error.code
        && !foreignEp.text.includes('ap.internal.example')
        && !foreignBind.text.includes('https://'));
      record('AUTH-10', foreignCap.status === 404 && missingCap.status === 404
        && foreignCap.json.error.code === missingCap.json.error.code && foreignCap.json.error.code === 'CAPABILITY_NOT_FOUND');
      record('AUTH-11', foreignDisc.status === 200 && foreignDisc.json.data.length === 0, `${foreignDisc.status} ${foreignDisc.text.slice(0, 240)}`);
    }

    const disabled = await call(base, 'PUT', `/v1/agents/${agentId}/endpoints/primary`, keyA.api_key, {
      ...endpointBody, enabled: false,
    }, { 'idempotency-key': `s3-${label}-ep-disable1`, 'if-match': '"endpoint-v1"' });
    const hidden = await call(base, 'POST', '/v1/discovery/agents', keyA.api_key, {
      capability: { id: 'finance.invoice.match', version: '1.0.0' }, protocols: ['a2a'],
    });
    const enabled = await call(base, 'PUT', `/v1/agents/${agentId}/endpoints/primary`, keyA.api_key, endpointBody, {
      'idempotency-key': `s3-${label}-ep-enable01`, 'if-match': disabled.headers.etag,
    });
    const shown = await call(base, 'POST', '/v1/discovery/agents', keyA.api_key, {
      capability: { id: 'finance.invoice.match', version: '1.0.0' }, protocols: ['a2a'],
    });
    const suspended = await call(base, 'POST', `/v1/agents/${agentId}/suspend`, keyA.api_key, { reason: 'Hold for review' }, {
      'idempotency-key': `s3-${label}-suspend-01`, 'if-match': agentEtag,
    });
    const hiddenAgent = await call(base, 'POST', '/v1/discovery/agents', keyA.api_key, {
      capability: { id: 'finance.invoice.match', version: '1.0.0' },
    });
    const readable = await call(base, 'GET', `/v1/agents/${agentId}/endpoints/primary`, keyA.api_key);
    const activated = await call(base, 'POST', `/v1/agents/${agentId}/activate`, keyA.api_key, { reason: 'Review complete' }, {
      'idempotency-key': `s3-${label}-activate-1`, 'if-match': suspended.headers.etag,
    });
    const shownAgent = await call(base, 'POST', '/v1/discovery/agents', keyA.api_key, {
      capability: { id: 'finance.invoice.match', version: '1.0.0' }, protocols: ['a2a'],
    });
    log.push({ step: 'H', disabled: hidden.status, enabled: shown.json?.data?.length, suspended: hiddenAgent.json?.data?.length, active: shownAgent.json?.data?.length });
    if (label === 'a') {
      record('API-17', disabled.status === 200 && disabled.json.data.enabled === false && hidden.status === 200 && hidden.json.data.length === 0
        && bindingGet.status === 200 && enabled.status === 200 && shown.json.data.some((item) => item.agent.id === agentId)
        && shown.json.data.every((item) => item.availability === 'not_checked'));
      record('API-18', suspended.status === 200 && hiddenAgent.json.data.length === 0 && readable.status === 200
        && activated.status === 200 && shownAgent.json.data.some((item) => item.agent.id === agentId));
      const epAudits = await count(root, `SELECT count(*)::int AS n FROM audit_events WHERE action = 'endpoint.updated' AND target_id = $1`, [`${agentId}/primary`]);
      record('API-09', disabled.json.data.revision === 2 && enabled.json.data.revision === 3 && epAudits === 2);
    }

    const blocked = await call(base, 'DELETE', `/v1/agents/${agentId}/endpoints/primary`, keyA.api_key, undefined, {
      'idempotency-key': `s3-${label}-ep-del-0001`, 'if-match': enabled.headers.etag,
    });
    const unbound = await call(base, 'DELETE', `/v1/agents/${agentId}/capabilities/finance.invoice.match`, keyA.api_key, undefined, {
      'idempotency-key': `s3-${label}-bind-del01`, 'if-match': '"cap-binding-v1"',
    });
    const removed = await call(base, 'DELETE', `/v1/agents/${agentId}/endpoints/primary`, keyA.api_key, undefined, {
      'idempotency-key': `s3-${label}-ep-del-0002`, 'if-match': enabled.headers.etag,
    });
    const afterDelete = await call(base, 'POST', '/v1/discovery/agents', keyA.api_key, {
      capability: { id: 'finance.invoice.match', version: '1.0.0' }, protocols: ['a2a'],
    });
    const recreatedEp = await call(base, 'PUT', `/v1/agents/${agentId}/endpoints/primary`, keyA.api_key, endpointBody, {
      'idempotency-key': `s3-${label}-ep-recreate`, 'if-none-match': '*',
    });
    const staleEp = await call(base, 'PUT', `/v1/agents/${agentId}/endpoints/primary`, keyA.api_key, {
      ...endpointBody, url: 'https://ap.internal.example/a2a/next',
    }, { 'idempotency-key': `s3-${label}-ep-stale001`, 'if-match': '"endpoint-v1"' });
    const recreatedBind = await call(base, 'PUT', `/v1/agents/${agentId}/capabilities/finance.invoice.match`, keyA.api_key, {
      version: '1.0.0', endpoint_key: 'primary',
    }, { 'idempotency-key': `s3-${label}-bind-re001`, 'if-none-match': '*' });
    const staleBind = await call(base, 'PUT', `/v1/agents/${agentId}/capabilities/finance.invoice.match`, keyA.api_key, {
      version: '1.0.0', endpoint_key: 'primary',
    }, { 'idempotency-key': `s3-${label}-bind-stale1`, 'if-match': '"cap-binding-v1"' });
    const finalDisc = await call(base, 'POST', '/v1/discovery/agents', keyA.api_key, {
      capability: { id: 'finance.invoice.match', version: '1.0.0' },
      tags: [{ namespace: 'department', key: 'name', operator: 'eq', value: 'finance' }],
      protocols: ['a2a'],
    });
    log.push({ step: 'I', blocked: blocked.status, unbound: unbound.status, removed: removed.status, recreated: recreatedEp.json?.data?.revision, discovery: finalDisc.json?.data?.length });
    if (label === 'a') {
      record('CON-09', blocked.status === 409 && blocked.json.error.code === 'ENDPOINT_IN_USE');
      record('API-19', unbound.status === 204 && afterDelete.json.data.length === 0);
      record('API-20', removed.status === 204);
      record('API-21', recreatedEp.status === 201 && recreatedEp.json.data.revision === 5 && recreatedEp.headers.etag === '"endpoint-v5"' && staleEp.status === 412, `${recreatedEp.status} ${recreatedEp.headers.etag} rev=${recreatedEp.json?.data?.revision} stale=${staleEp.status}`);
      record('API-22', recreatedBind.status === 201 && recreatedBind.json.data.revision === 3 && recreatedBind.headers.etag === '"cap-binding-v3"' && staleBind.status === 412
        && finalDisc.json.data.some((item) => item.agent.id === agentId), `${recreatedBind.status} ${recreatedBind.headers.etag} rev=${recreatedBind.json?.data?.revision}`);
    }

    log.push({ step: 'J', note: 'adversarial cases run in the matrix on launch 1' });
    const consumer = await sdkConsumer(base, keyA.api_key, agentId, secretList, label);
    log.push({ step: 'K', ok: consumer.ok, publish: consumer.publish, discovery: consumer.discovery });
    if (label === 'a') record('SDK-01', consumer.ok === true);
    return {
      orgA: orgA.id, orgB: orgB.id, actorA: actorA.id, actorB: actorB.id, owner: owner.id, agentId,
      key: keyA.api_key, keyB: keyB.api_key, keyOld: keyOld.api_key, keyARecord: keyA,
      endpointEtag: recreatedEp.headers.etag, bindingEtag: recreatedBind.headers.etag, consumer,
    };
  }
});
