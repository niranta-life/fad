import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileContract } from '@fad/contract';
import {
  discoveryFilterKey,
  encodeCatalogCursor,
  encodeDiscoveryCursor,
  scopeFingerprint,
} from '@fad/db';
import { applyMigrations } from '@fad/migrator';
import { buildApp } from '@fad/api/app';
import { loadConfig } from '@fad/api/config';
import { createPool } from '@fad/db';
import { admin, parseJson, request, requiredEnv, scratch, startApi, writeEvidence } from './support.mjs';

const FULL = [
  'organizations:read', 'agents:read', 'agents:write', 'agents:lifecycle',
  'tags:define', 'tags:read', 'tags:write', 'tags:governance', 'tags:restricted:read',
  'capabilities:read', 'capabilities:write', 'endpoints:read', 'endpoints:write',
].join(',');
const READER = 'agents:read,capabilities:read,endpoints:read,tags:read';
const NO_TAGS = 'agents:read,capabilities:read,endpoints:read';
const DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const SCHEMA = {
  $schema: DRAFT,
  type: 'object',
  additionalProperties: false,
  properties: { invoice_id: { type: 'string' } },
  required: ['invoice_id'],
};
const MIGRATIONS = new URL('../db/migrations/', import.meta.url).pathname;

function call(base, method, path, key, body, headers = {}) {
  const requestHeaders = { ...headers };
  if (key) requestHeaders['x-fad-api-key'] = key;
  if (body !== undefined) requestHeaders['content-type'] = 'application/json';
  return request(`${base}${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

function snip(response) {
  return `${response?.status ?? 'none'} ${(response?.text ?? '').slice(0, 220)}`;
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

async function count(client, sql, params = []) {
  const result = await client.query(sql, params);
  return result.rows[0].n;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function issue(org, principal, scopes, secrets) {
  const issued = parseJson((await admin([
    'credential', 'issue', '--organization-id', org, '--principal-id', principal, '--scopes', scopes,
  ])).stdout);
  secrets.push(issued.api_key);
  return issued;
}

async function makeAgent(base, key, ownerId, name, idem) {
  const created = await call(base, 'POST', '/v1/agents', key, {
    name, owner_principal_id: ownerId,
  }, { 'idempotency-key': idem });
  if (created.status !== 201) throw new Error(`agent ${snip(created)}`);
  return created.json.data.id;
}

async function waitReady(base) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await request(`${base}/health/ready`);
      if (response.status === 200 && response.json?.status === 'ready') return response.json;
    } catch {
      /* container still starting */
    }
    await sleep(250);
  }
  return null;
}

async function waitForImage() {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const inspected = spawnSync('docker', ['image', 'inspect', 'fad-api:slice3', '--format', '{{.Id}} {{.Config.User}}'], { encoding: 'utf8' });
    if (inspected.status === 0) return inspected.stdout.trim();
    await sleep(5000);
  }
  throw new Error('fad-api:slice3 was not built');
}

export async function sdkConsumer(base, apiKey, agentId, _secrets, label) {
  const dir = mkdtempSync(join(tmpdir(), 'fad-s3-sdk-'));
  execFileSync('npm', ['pack', '-w', '@fad/sdk', '--pack-destination', dir], { cwd: process.cwd(), stdio: 'pipe' });
  const tarball = readdirSync(dir).find((name) => name.endsWith('.tgz'));
  if (!tarball) return { ok: false, error: 'sdk pack missing' };
  const proj = mkdtempSync(join(tmpdir(), 'fad-s3-consumer-'));
  writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'fad-s3-consumer', private: true, type: 'module' }));
  execFileSync('npm', ['install', '--no-audit', '--no-fund', join(dir, tarball)], { cwd: proj, stdio: 'pipe' });
  cpSync(fileURLToPath(new URL('./slice3-consumer.mjs', import.meta.url)), join(proj, 'consumer.mjs'));
  let stdout = '';
  let stderr = '';
  try {
    stdout = execFileSync(process.execPath, ['consumer.mjs'], {
      cwd: proj,
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        FAD_BASE_URL: base,
        FAD_API_KEY: apiKey,
        FAD_AGENT_ID: agentId,
        FAD_LABEL: label,
      },
    });
  } catch (error) {
    stdout = `${error.stdout ?? ''}`;
    stderr = `${error.stderr ?? ''}`;
  }
  const line = stdout.trim().split('\n').at(-1) ?? '';
  try {
    return JSON.parse(line);
  } catch {
    return { ok: false, error: (stderr || stdout).slice(0, 500) };
  }
}

export async function matrix(api, journey, secrets, superuser, appClient, pass, guardLog) {
  const base = api.base;
  const key = journey.key;
  const pepper = Buffer.from(requiredEnv('FAD_API_KEY_PEPPER_V1'));
  const evidence = [];
  await superuser.query('DELETE FROM rate_limit_buckets');
  const lab = await makeAgent(base, key, journey.owner, 'Lab Agent', 's3-matrix-lab-agent1');

  const pageId = 'finance.cursor.page';
  const versions = ['1.0.0', '1.0.1', '1.10.0', '1.9.0'];
  for (const version of versions) {
    const published = await call(base, 'POST', '/v1/capabilities', key, publishBody(pageId, version, `Page ${version}`), {
      'idempotency-key': `s3-matrix-page-${version.replaceAll('.', '')}`,
    });
    if (published.status !== 201) throw new Error(`page publish ${version} ${snip(published)}`);
  }
  const seen = [];
  let cursor = null;
  let pages = 0;
  do {
    const path = cursor
      ? `/v1/capabilities?id=${encodeURIComponent(pageId)}&limit=1&cursor=${encodeURIComponent(cursor)}`
      : `/v1/capabilities?id=${encodeURIComponent(pageId)}&limit=1`;
    const page = await call(base, 'GET', path, key);
    if (page.status !== 200) throw new Error(`catalog ${snip(page)}`);
    if (page.json.data.length !== 1) throw new Error(`catalog page size ${page.json.data.length}`);
    seen.push(`${page.json.data[0].id}@${page.json.data[0].version}`);
    cursor = page.json.meta.next_cursor;
    pages += 1;
  } while (cursor && pages < 8);
  const lexical = versions.slice().sort();
  pass('API-03', pages === 4 && new Set(seen).size === seen.length && seen.join() === lexical.map((version) => `${pageId}@${version}`).join(), seen.join());
  pass('VAL-14', seen.join() === ['1.0.0', '1.0.1', '1.10.0', '1.9.0'].map((version) => `${pageId}@${version}`).join(), seen.join());

  const sameKey = await call(base, 'POST', '/v1/capabilities', key, publishBody('finance.lab.idem', '1.0.0', 'First'), {
    'idempotency-key': 's3-matrix-idem-same1',
  });
  const otherBody = await call(base, 'POST', '/v1/capabilities', key, publishBody('finance.lab.idem', '1.0.0', 'Second'), {
    'idempotency-key': 's3-matrix-idem-same1',
  });
  pass('API-06', sameKey.status === 201 && otherBody.status === 409 && otherBody.json.error.code === 'IDEMPOTENCY_CONFLICT', snip(otherBody));

  const endpointBody = { protocol: 'a2a', url: 'https://ap.internal.example/a2a', auth_scheme: 'oauth2' };
  const primary = await call(base, 'PUT', `/v1/agents/${lab}/endpoints/primary`, key, endpointBody, {
    'idempotency-key': 's3-matrix-ep-primary1', 'if-none-match': '*',
  });
  const beforeAudit = await count(superuser, `SELECT count(*)::int AS n FROM audit_events WHERE target_id = $1 AND action = 'endpoint.updated'`, [`${lab}/primary`]);
  const beforeRev = await count(superuser, `SELECT count(*)::int AS n FROM agent_endpoint_revisions WHERE agent_id = $1 AND endpoint_key = 'primary'`, [lab]);
  const noop = await call(base, 'PUT', `/v1/agents/${lab}/endpoints/primary`, key, endpointBody, {
    'idempotency-key': 's3-matrix-ep-noop001', 'if-match': primary.headers.etag,
  });
  const afterAudit = await count(superuser, `SELECT count(*)::int AS n FROM audit_events WHERE target_id = $1 AND action = 'endpoint.updated'`, [`${lab}/primary`]);
  const afterRev = await count(superuser, `SELECT count(*)::int AS n FROM agent_endpoint_revisions WHERE agent_id = $1 AND endpoint_key = 'primary'`, [lab]);
  pass('API-10', noop.status === 200 && noop.json.data.revision === 1 && noop.headers.etag === '"endpoint-v1"'
    && afterAudit === beforeAudit && afterRev === beforeRev, snip(noop));

  await call(base, 'POST', '/v1/capabilities', key, publishBody('finance.lab.match', '1.0.0'), { 'idempotency-key': 's3-matrix-lab-cap001' });
  await call(base, 'POST', '/v1/capabilities', key, publishBody('finance.lab.match', '1.0.1'), { 'idempotency-key': 's3-matrix-lab-cap002' });
  const secondary = await call(base, 'PUT', `/v1/agents/${lab}/endpoints/secondary`, key, {
    ...endpointBody, url: 'https://ap.internal.example/secondary',
  }, { 'idempotency-key': 's3-matrix-ep-second01', 'if-none-match': '*' });
  const bound = await call(base, 'PUT', `/v1/agents/${lab}/capabilities/finance.lab.match`, key, {
    version: '1.0.0', endpoint_key: 'primary',
  }, { 'idempotency-key': 's3-matrix-bind-lab01', 'if-none-match': '*' });
  const moved = await call(base, 'PUT', `/v1/agents/${lab}/capabilities/finance.lab.match`, key, {
    version: '1.0.1', endpoint_key: 'secondary',
  }, { 'idempotency-key': 's3-matrix-bind-move1', 'if-match': bound.headers.etag });
  pass('API-13', secondary.status === 201 && moved.status === 200 && moved.json.data.revision === 2
    && moved.json.data.version === '1.0.1' && moved.json.data.endpoint_key === 'secondary'
    && moved.headers.etag === '"cap-binding-v2"', snip(moved));
  const removedEp = await call(base, 'DELETE', `/v1/agents/${lab}/endpoints/primary`, key, undefined, {
    'idempotency-key': 's3-matrix-ep-del-lab', 'if-match': '"endpoint-v1"',
  });
  const liveEps = await call(base, 'GET', `/v1/agents/${lab}/endpoints`, key);
  const liveBinds = await call(base, 'GET', `/v1/agents/${lab}/capabilities`, key);
  const tomb = await count(superuser, `SELECT count(*)::int AS n FROM agent_endpoints WHERE agent_id = $1 AND endpoint_key = 'primary' AND is_deleted = true`, [lab]);
  pass('API-14', removedEp.status === 204 && liveEps.status === 200 && liveEps.json.data.length === 1
    && liveEps.json.data[0].key === 'secondary' && liveBinds.json.data.length === 1
    && liveBinds.json.data[0].version === '1.0.1' && tomb === 1, snip(liveEps));

  const anon = await call(base, 'GET', '/v1/capabilities/finance.lab.match/versions/1.0.0');
  pass('AUTH-01', anon.status === 401 && anon.json.error.code === 'UNAUTHORIZED' && anon.json.data === undefined, snip(anon));
  const expiring = await issue(journey.orgA, journey.actorA, FULL, secrets);
  await superuser.query(
    `UPDATE api_credentials SET created_at = timestamptz '2000-01-01T00:00:00Z', expires_at = timestamptz '2000-01-01T00:00:01Z' WHERE kid = $1`,
    [expiring.kid],
  );
  const expired = await call(base, 'GET', `/v1/agents/${lab}/endpoints`, expiring.api_key);
  const doomed = await issue(journey.orgA, journey.actorA, FULL, secrets);
  await admin(['credential', 'revoke', '--organization-id', journey.orgA, '--kid', doomed.kid, '--reason', 'Rotate the key']);
  const revoked = await call(base, 'GET', `/v1/agents/${lab}/endpoints`, doomed.api_key);
  pass('AUTH-02', expired.status === 401 && revoked.status === 401 && expired.json.data === undefined && revoked.json.data === undefined
    && !expired.text.includes(lab) && !revoked.text.includes('ap.internal.example'), `${snip(expired)} ${snip(revoked)}`);

  const oldPut = await call(base, 'PUT', `/v1/agents/${lab}/endpoints/legacy`, journey.keyOld, endpointBody, {
    'idempotency-key': 's3-matrix-old-ep-001', 'if-none-match': '*',
  });
  const oldBind = await call(base, 'PUT', `/v1/agents/${lab}/capabilities/finance.lab.match`, journey.keyOld, {
    version: '1.0.0', endpoint_key: 'secondary',
  }, { 'idempotency-key': 's3-matrix-old-bind01', 'if-match': '"cap-binding-v2"' });
  const oldPublish = await call(base, 'POST', '/v1/capabilities', journey.keyOld, publishBody('finance.lab.denied', '1.0.0'), {
    'idempotency-key': 's3-matrix-old-cap001',
  });
  pass('AUTH-03', oldPublish.status === 403 && oldPublish.json.error.code === 'FORBIDDEN' && oldPublish.json.data === undefined, snip(oldPublish));
  pass('AUTH-04', oldPut.status === 403 && oldPut.json.error.code === 'FORBIDDEN', snip(oldPut));
  pass('AUTH-05', oldBind.status === 403 && oldBind.json.error.code === 'FORBIDDEN', snip(oldBind));
  const readerOnly = await issue(journey.orgA, journey.actorA, 'agents:read', secrets);
  const noDisc = await call(base, 'POST', '/v1/discovery/agents', readerOnly.api_key, {
    capability: { id: 'finance.invoice.match' },
  });
  pass('AUTH-06', noDisc.status === 403 && noDisc.json.error.code === 'FORBIDDEN' && noDisc.json.data === undefined, snip(noDisc));
  const noTags = await issue(journey.orgA, journey.actorA, NO_TAGS, secrets);
  const tagDenied = await call(base, 'POST', '/v1/discovery/agents', noTags.api_key, {
    capability: { id: 'finance.invoice.match' },
    tags: [{ namespace: 'department', key: 'name', operator: 'eq', value: 'finance' }],
  });
  pass('AUTH-07', tagDenied.status === 403 && tagDenied.json.data === undefined && !tagDenied.text.includes('finance'), snip(tagDenied));

  const secretToken = 'restricted-clearance-token';
  const defined = await call(base, 'POST', '/v1/tag-definitions', key, {
    namespace: 'clearance', key: 'level', value_type: 'string', governed: false, visibility: 'restricted',
  }, { 'idempotency-key': 's3-matrix-restricted1' });
  const tagged = await call(base, 'PUT', `/v1/agents/${journey.agentId}/tags/clearance/level`, key, { value: secretToken }, {
    'idempotency-key': 's3-matrix-rest-tag01', 'if-none-match': '*',
  });
  const plainReader = await issue(journey.orgA, journey.actorA, READER, secrets);
  const restricted = await call(base, 'POST', '/v1/discovery/agents', plainReader.api_key, {
    capability: { id: 'finance.invoice.match', version: '1.0.0' },
    tags: [{ namespace: 'clearance', key: 'level', operator: 'eq', value: secretToken }],
  });
  const restrictedMissing = await call(base, 'POST', '/v1/discovery/agents', plainReader.api_key, {
    capability: { id: 'finance.invoice.match', version: '1.0.0' },
    tags: [{ namespace: 'clearance', key: 'absent', operator: 'eq', value: 'missing-restricted-probe' }],
  });
  const forbidBody = (response) => {
    const body = JSON.parse(response.text);
    return JSON.stringify({ error: body.error, api_version: body.meta?.api_version });
  };
  pass('AUTH-08', defined.status === 201 && tagged.status === 201 && restricted.status === 403
    && restrictedMissing.status === 403 && forbidBody(restricted) === forbidBody(restrictedMissing)
    && restricted.json.data === undefined && restrictedMissing.json.data === undefined
    && !restricted.text.includes(secretToken) && !restricted.text.includes(journey.agentId)
    && !restricted.text.includes('clearance') && !restrictedMissing.text.includes('missing-restricted-probe')
    && !restrictedMissing.text.includes('absent'),
  `define=${defined.status} tag=${tagged.status} existing=${restricted.status} missing=${restrictedMissing.status}`);

  const forgedHeader = await call(base, 'POST', '/v1/capabilities', key, publishBody('finance.lab.tenant', '1.0.0'), {
    'idempotency-key': 's3-matrix-forge-hdr1', 'x-organization-id': journey.orgB,
  });
  const forgedBody = await call(base, 'POST', '/v1/capabilities', key, {
    ...publishBody('finance.lab.tenant', '1.0.1'), organization_id: journey.orgB,
  }, { 'idempotency-key': 's3-matrix-forge-body' });
  const forgedRow = await count(superuser, `SELECT count(*)::int AS n FROM capability_versions WHERE capability_id = 'finance.lab.tenant' AND organization_id = $1`, [journey.orgA]);
  const forgedOther = await count(superuser, `SELECT count(*)::int AS n FROM capability_versions WHERE capability_id = 'finance.lab.tenant' AND organization_id = $1`, [journey.orgB]);
  pass('AUTH-12', forgedHeader.status === 201 && forgedHeader.json.data.organization_id === journey.orgA
    && forgedBody.status === 422 && forgedRow === 1 && forgedOther === 0, snip(forgedBody));
  const spoof = await call(base, 'POST', '/v1/capabilities', key, {
    ...publishBody('finance.lab.actor', '1.0.0'), published_by: journey.actorB,
  }, { 'idempotency-key': 's3-matrix-spoof-act1' });
  pass('AUTH-17', spoof.status === 422 && spoof.json.error.code === 'VALIDATION_ERROR', snip(spoof));

  const role = await superuser.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'fad_app'`);
  const owner = await superuser.query(`SELECT pg_get_userbyid(relowner) AS owner, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'capability_versions'`);
  const grants = await superuser.query(`
    SELECT has_table_privilege('fad_app', 'capability_versions', 'UPDATE') AS cap_update,
           has_table_privilege('fad_app', 'capability_versions', 'DELETE') AS cap_delete,
           has_table_privilege('fad_app', 'agent_endpoints', 'DELETE') AS ep_delete,
           has_table_privilege('fad_app', 'agent_endpoint_revisions', 'UPDATE') AS hist_update`);
  await appClient.query('BEGIN');
  await appClient.query(`SELECT set_config('fad.org_id', $1, true)`, [journey.orgB]);
  const hidden = await count(appClient, `SELECT count(*)::int AS n FROM capability_versions WHERE capability_id = 'finance.invoice.match'`);
  let crossInsert = null;
  try {
    await appClient.query(
      `INSERT INTO capability_versions (organization_id, capability_id, version, display_name, input_schema, output_schema, contract_sha256, published_by)
       VALUES ($1, 'finance.lab.cross', '1.0.0', 'Cross', '{}'::jsonb, '{}'::jsonb, $2, $3)`,
      [journey.orgA, 'a'.repeat(64), journey.actorA],
    );
  } catch (error) {
    crossInsert = error;
  }
  await appClient.query('ROLLBACK');
  let ddl = null;
  await appClient.query('BEGIN');
  try {
    await appClient.query('CREATE TABLE fad_s3_should_fail (id int)');
  } catch (error) {
    ddl = error;
  }
  await appClient.query('ROLLBACK');
  const grantRow = grants.rows[0];
  const roleRow = role.rows[0];
  const ownerRow = owner.rows[0];
  pass('AUTH-13', roleRow.rolsuper === false && roleRow.rolbypassrls === false && ownerRow.owner !== 'fad_app'
    && ownerRow.relrowsecurity === true && ownerRow.relforcerowsecurity === true
    && grantRow.cap_update === false && grantRow.cap_delete === false && grantRow.ep_delete === false && grantRow.hist_update === false
    && hidden === 0 && crossInsert?.code === '42501' && ddl?.code === '42501',
  `hidden=${hidden} rls=${crossInsert?.code} ddl=${ddl?.code}`);
  evidence.push(`AUTH-13 owner=${ownerRow.owner} bypass=${roleRow.rolbypassrls} hidden=${hidden} rls=${crossInsert?.code} ddl=${ddl?.code}`);

  await appClient.query('BEGIN');
  const unset = await count(appClient, 'SELECT count(*)::int AS n FROM capability_versions');
  let unsetWrite = null;
  try {
    await appClient.query(
      `INSERT INTO capability_versions (organization_id, capability_id, version, display_name, input_schema, output_schema, contract_sha256, published_by)
       VALUES ($1, 'finance.lab.unset', '1.0.0', 'Unset', '{}'::jsonb, '{}'::jsonb, $2, $3)`,
      [journey.orgA, 'b'.repeat(64), journey.actorA],
    );
  } catch (error) {
    unsetWrite = error;
  }
  await appClient.query('ROLLBACK');
  pass('AUTH-14', unset === 0 && unsetWrite?.code === '42501', `rows=${unset} write=${unsetWrite?.code}`);

  await appClient.query('BEGIN');
  await appClient.query(`SELECT set_config('fad.org_id', $1, true)`, [journey.orgA]);
  const seenA = await count(appClient, `SELECT count(*)::int AS n FROM capability_versions WHERE capability_id = 'finance.invoice.match'`);
  await appClient.query('COMMIT');
  await appClient.query('BEGIN');
  const staleTenant = await count(appClient, `SELECT count(*)::int AS n FROM capability_versions WHERE capability_id = 'finance.invoice.match'`);
  await appClient.query('ROLLBACK');
  await appClient.query('BEGIN');
  await appClient.query(`SELECT set_config('fad.org_id', $1, true)`, [journey.orgB]);
  const seenB = await count(appClient, `SELECT count(*)::int AS n FROM capability_versions WHERE capability_id = 'finance.invoice.match'`);
  await appClient.query('COMMIT');
  pass('AUTH-15', seenA === 1 && staleTenant === 0 && seenB === 0, `a=${seenA} stale=${staleTenant} b=${seenB}`);

  const ownerB = parseJson((await admin(['principal', 'create', '--organization-id', journey.orgB, '--type', 'service', '--name', 'Owner B matrix'])).stdout);
  const agentB = await makeAgent(base, journey.keyB, ownerB.id, 'Org B Agent', 's3-matrix-orgb-agent');
  let fkAgent = null;
  let fkCatalog = null;
  try {
    await superuser.query(
      `INSERT INTO agent_capability_bindings (organization_id, agent_id, capability_id, version, endpoint_key, created_by, updated_by)
       VALUES ($1, $2, 'finance.invoice.match', '1.0.0', 'primary', $3, $3)`,
      [journey.orgA, agentB, journey.actorA],
    );
  } catch (error) {
    fkAgent = error;
  }
  try {
    await superuser.query(
      `INSERT INTO agent_capability_bindings (organization_id, agent_id, capability_id, version, endpoint_key, created_by, updated_by)
       VALUES ($1, $2, 'finance.invoice.match', '1.0.0', 'primary', $3, $3)`,
      [journey.orgB, agentB, journey.actorB],
    );
  } catch (error) {
    fkCatalog = error;
  }
  pass('AUTH-16', fkAgent?.code === '23503' && fkCatalog?.code === '23503', `${fkAgent?.code} ${fkCatalog?.code}`);
  evidence.push(`AUTH-16 fk_agent=${fkAgent?.code} fk_catalog=${fkCatalog?.code}`);

  const badUrls = [
    'http://ap.internal.example/a2a',
    'https://user:pass@ap.internal.example/a2a',
    'https://127.0.0.1/a2a',
    'https://10.1.2.3/a2a',
    'https://localhost/a2a',
    'https://ap.internal.example/a2a?token=secret',
    'https://ap.internal.example/a2a#frag',
    'https://ap.internal.example/a2a?',
    'https://ap.internal.example/a2a#',
    'https://ap.internal.example/a2a?#',
  ];
  const urlStatuses = [];
  for (const [index, url] of badUrls.entries()) {
    const response = await call(base, 'PUT', `/v1/agents/${lab}/endpoints/badurl`, key, {
      protocol: 'a2a', url, auth_scheme: 'oauth2',
    }, { 'idempotency-key': `s3-matrix-bad-url-${index}`, 'if-none-match': '*' });
    urlStatuses.push(response.status);
  }
  const storedBad = await count(superuser, `SELECT count(*)::int AS n FROM agent_endpoints WHERE url LIKE '%user:pass%' OR url LIKE '%token=%' OR url LIKE '%127.0.0.1%' OR url LIKE '%10.1.2.3%' OR url LIKE '%?%' OR url LIKE '%#%'`);
  const badScheme = await call(base, 'PUT', `/v1/agents/${lab}/endpoints/badurl`, key, {
    protocol: 'a2a', url: 'https://ap.internal.example/a2a', auth_scheme: 'bearer',
  }, { 'idempotency-key': 's3-matrix-bad-scheme', 'if-none-match': '*' });
  const badExtra = await call(base, 'PUT', `/v1/agents/${lab}/endpoints/badurl`, key, {
    protocol: 'a2a', url: 'https://ap.internal.example/a2a', auth_scheme: 'oauth2', client_secret: 'super-secret-value',
  }, { 'idempotency-key': 's3-matrix-bad-extra1', 'if-none-match': '*' });
  const secretRows = await count(superuser, `SELECT count(*)::int AS n FROM agent_endpoints WHERE url ILIKE '%super-secret-value%' OR auth_scheme = 'bearer'`);
  const secretAudit = await count(superuser, `SELECT count(*)::int AS n FROM audit_events WHERE details::text ILIKE '%super-secret-value%' OR details::text ILIKE '%client_secret%'`);
  const guardText = readFileSync(guardLog, 'utf8');
  pass('AUTH-18', urlStatuses.every((status) => status === 422) && storedBad === 0 && !guardText.includes('ap.internal.example')
    && !guardText.includes('evil.example') && guardText.trim() === '', `${urlStatuses.join(',')} guard=${guardText.trim()}`);
  pass('AUTH-20', badScheme.status === 422 && badExtra.status === 422 && secretRows === 0 && secretAudit === 0, `${snip(badScheme)} ${snip(badExtra)}`);
  const refSchema = { $schema: DRAFT, $ref: 'https://evil.example/schema.json' };
  const dynamicSchema = { $schema: DRAFT, $dynamicRef: '#secret' };
  const idSchema = { $schema: DRAFT, $id: 'https://evil.example/root', type: 'object' };
  const refStatuses = [];
  for (const [index, input] of [refSchema, dynamicSchema, idSchema].entries()) {
    const response = await call(base, 'POST', '/v1/capabilities', key, {
      ...publishBody('finance.lab.schema', '1.0.0'), input_schema: input,
    }, { 'idempotency-key': `s3-matrix-bad-schema${index}` });
    refStatuses.push(response.status);
  }
  const guardAfter = readFileSync(guardLog, 'utf8');
  pass('AUTH-19', refStatuses.every((status) => status === 422) && guardAfter.trim() === '', refStatuses.join(','));
  const injected = await call(base, 'POST', '/v1/capabilities', key, publishBody(`finance.invoice.match'; DROP TABLE agents; --`, '1.0.0'), {
    'idempotency-key': 's3-matrix-sqli-cap01',
  });
  const control = await call(base, 'POST', '/v1/capabilities', key, {
    ...publishBody('finance.lab.control', '1.0.0'), display_name: 'Match\u0001invoices',
  }, { 'idempotency-key': 's3-matrix-control-01' });
  const injectedQuery = await call(base, 'POST', '/v1/discovery/agents', key, {
    capability: { id: 'finance.invoice.match', version: '1.0.0' },
    tags: [{ namespace: 'department', key: 'name', operator: 'eq', value: `' OR 1=1 --` }],
  });
  const agentsRemain = await count(superuser, 'SELECT count(*)::int AS n FROM agents WHERE id = $1', [journey.agentId]);
  pass('AUTH-21', injected.status === 422 && control.status === 422 && injectedQuery.status === 200
    && injectedQuery.json.data.length === 0 && agentsRemain === 1, `${snip(injected)} ${snip(control)}`);

  const replayKey = await issue(journey.orgA, journey.actorA, FULL, secrets);
  const firstReplay = await call(base, 'POST', '/v1/capabilities', replayKey.api_key, publishBody('finance.lab.replay', '1.0.0'), {
    'idempotency-key': 's3-matrix-replay-cap',
  });
  await superuser.query(`UPDATE api_credentials SET scopes = ARRAY['organizations:read']::text[] WHERE kid = $1`, [replayKey.kid]);
  const secondReplay = await call(base, 'POST', '/v1/capabilities', replayKey.api_key, publishBody('finance.lab.replay', '1.0.0'), {
    'idempotency-key': 's3-matrix-replay-cap',
  });
  pass('AUTH-22', firstReplay.status === 201 && secondReplay.status === 403 && secondReplay.json.error.code === 'FORBIDDEN'
    && secondReplay.json.data === undefined && !secondReplay.text.includes(firstReplay.json.data.contract_sha256), snip(secondReplay));

  const missingPre = await call(base, 'PUT', `/v1/agents/${lab}/endpoints/secondary`, key, endpointBody, {
    'idempotency-key': 's3-matrix-no-precond',
  });
  const bothPre = await call(base, 'PUT', `/v1/agents/${lab}/endpoints/secondary`, key, endpointBody, {
    'idempotency-key': 's3-matrix-both-pre01', 'if-match': '"endpoint-v1"', 'if-none-match': '*',
  });
  const stale = await call(base, 'PUT', `/v1/agents/${lab}/endpoints/secondary`, key, {
    ...endpointBody, url: 'https://ap.internal.example/stale',
  }, { 'idempotency-key': 's3-matrix-stale-ep01', 'if-match': '"endpoint-v9"' });
  const weak = await call(base, 'PUT', `/v1/agents/${lab}/endpoints/secondary`, key, endpointBody, {
    'idempotency-key': 's3-matrix-weak-etag1', 'if-match': 'W/"endpoint-v1"',
  });
  const wild = await call(base, 'PUT', `/v1/agents/${lab}/endpoints/secondary`, key, endpointBody, {
    'idempotency-key': 's3-matrix-wild-etag1', 'if-match': '*',
  });
  pass('CON-01', missingPre.status === 428 && missingPre.json.error.code === 'PRECONDITION_REQUIRED', snip(missingPre));
  pass('CON-02', bothPre.status === 400 && bothPre.json.error.code === 'VALIDATION_ERROR', snip(bothPre));
  pass('CON-03', stale.status === 412 && stale.json.error.code === 'PRECONDITION_FAILED', snip(stale));
  pass('CON-04', weak.status === 400 && wild.status === 400, `${snip(weak)} ${snip(wild)}`);

  const raceEp = await call(base, 'PUT', `/v1/agents/${lab}/endpoints/raceput`, key, endpointBody, {
    'idempotency-key': 's3-matrix-race-create', 'if-none-match': '*',
  });
  const races = await Promise.all([0, 1].map((index) => call(base, 'PUT', `/v1/agents/${lab}/endpoints/raceput`, key, {
    ...endpointBody, url: `https://ap.internal.example/race${index}`,
  }, { 'idempotency-key': `s3-matrix-race-put${index}`, 'if-match': raceEp.headers.etag })));
  const raceRow = await superuser.query(`SELECT revision FROM agent_endpoints WHERE agent_id = $1 AND endpoint_key = 'raceput'`, [lab]);
  pass('CON-05', races.filter((item) => item.status === 200).length === 1 && races.filter((item) => item.status === 412).length === 1
    && Number(raceRow.rows[0].revision) === 2, races.map((item) => item.status).join(','));

  const quotaAgent = await makeAgent(base, key, journey.owner, 'Quota Agent', 's3-matrix-quota-agent');
  for (let index = 0; index < 7; index += 1) {
    const created = await call(base, 'PUT', `/v1/agents/${quotaAgent}/endpoints/e${index}`, key, endpointBody, {
      'idempotency-key': `s3-matrix-quota-e${index}`, 'if-none-match': '*',
    });
    if (created.status !== 201) throw new Error(`seed endpoint ${snip(created)}`);
  }
  const burst = await Promise.all([7, 8, 9, 10].map((index) => call(base, 'PUT', `/v1/agents/${quotaAgent}/endpoints/e${index}`, key, endpointBody, {
    'idempotency-key': `s3-matrix-quota-b${index}`, 'if-none-match': '*',
  })));
  const liveQuota = await count(superuser, `SELECT count(*)::int AS n FROM agent_endpoints WHERE agent_id = $1 AND is_deleted = false`, [quotaAgent]);
  pass('CON-06', liveQuota === 8 && burst.filter((item) => item.status === 201).length === 1
    && burst.filter((item) => item.status === 409).length === 3, `${liveQuota} ${burst.map((item) => item.status).join(',')}`);

  for (let index = 0; index < 35; index += 1) {
    const capId = `quota.n${String(index).padStart(2, '0')}`;
    const published = await call(base, 'POST', '/v1/capabilities', key, publishBody(capId, '1.0.0', `Quota ${index}`), {
      'idempotency-key': `s3-matrix-qcap-${String(index).padStart(2, '0')}`,
    });
    if (published.status !== 201) throw new Error(`quota cap ${snip(published)}`);
  }
  for (let index = 0; index < 31; index += 1) {
    const capId = `quota.n${String(index).padStart(2, '0')}`;
    const boundQuota = await call(base, 'PUT', `/v1/agents/${quotaAgent}/capabilities/${capId}`, key, {
      version: '1.0.0', endpoint_key: 'e0',
    }, { 'idempotency-key': `s3-matrix-qbind-${String(index).padStart(2, '0')}`, 'if-none-match': '*' });
    if (boundQuota.status !== 201) throw new Error(`quota bind ${snip(boundQuota)}`);
  }
  const bindBurst = await Promise.all([31, 32, 33, 34].map((index) => {
    const capId = `quota.n${String(index).padStart(2, '0')}`;
    return call(base, 'PUT', `/v1/agents/${quotaAgent}/capabilities/${capId}`, key, {
      version: '1.0.0', endpoint_key: 'e0',
    }, { 'idempotency-key': `s3-matrix-qbind-b${index}`, 'if-none-match': '*' });
  }));
  const liveBindsN = await count(superuser, `SELECT count(*)::int AS n FROM agent_capability_bindings WHERE agent_id = $1 AND is_deleted = false`, [quotaAgent]);
  pass('CON-07', liveBindsN === 32 && bindBurst.filter((item) => item.status === 201).length === 1
    && bindBurst.filter((item) => item.status === 409).length === 3, `${liveBindsN} ${bindBurst.map((item) => item.status).join(',')}`);

  const retireAgent = await makeAgent(base, key, journey.owner, 'Retire Race', 's3-matrix-retire-agent');
  await superuser.query('BEGIN');
  await superuser.query('SELECT id FROM agents WHERE id = $1 FOR UPDATE', [retireAgent]);
  const retirePut = call(base, 'PUT', `/v1/agents/${retireAgent}/endpoints/primary`, key, endpointBody, {
    'idempotency-key': 's3-matrix-retire-put1', 'if-none-match': '*',
  });
  await sleep(300);
  await superuser.query(`UPDATE agents SET status = 'retired', revision = revision + 1, updated_at = transaction_timestamp() WHERE id = $1`, [retireAgent]);
  await superuser.query('COMMIT');
  const retireResult = await retirePut;
  const retireRows = await count(superuser, 'SELECT count(*)::int AS n FROM agent_endpoints WHERE agent_id = $1', [retireAgent]);
  pass('CON-08', retireResult.status === 409 && retireResult.json.error.code === 'INVALID_AGENT_STATE' && retireRows === 0, snip(retireResult));

  await superuser.query('BEGIN');
  await superuser.query(
    `UPDATE agent_endpoints SET enabled = false WHERE organization_id = $1 AND agent_id = $2 AND endpoint_key = 'primary'`,
    [journey.orgA, journey.agentId],
  );
  const during = await call(base, 'POST', '/v1/discovery/agents', key, {
    capability: { id: 'finance.invoice.match', version: '1.0.0' }, protocols: ['a2a'],
  });
  await superuser.query('COMMIT');
  const afterDisable = await call(base, 'POST', '/v1/discovery/agents', key, {
    capability: { id: 'finance.invoice.match', version: '1.0.0' }, protocols: ['a2a'],
  });
  const restored = await call(base, 'PUT', `/v1/agents/${journey.agentId}/endpoints/primary`, key, endpointBody, {
    'idempotency-key': 's3-matrix-restore-ep', 'if-match': journey.endpointEtag,
  });
  pass('CON-10', during.status === 200 && during.json.data.some((item) => item.agent.id === journey.agentId)
    && afterDisable.status === 200 && afterDisable.json.data.length === 0 && restored.status === 200, snip(afterDisable));

  const dupId = 'finance.lab.duplicate';
  const dupBody = publishBody(dupId, '1.0.0');
  const dup = await Promise.all([0, 1].map((index) => call(base, 'POST', '/v1/capabilities', key, dupBody, {
    'idempotency-key': `s3-matrix-dup-cap-${index}`,
  })));
  const dupRows = await count(superuser, `SELECT count(*)::int AS n FROM capability_versions WHERE organization_id = $1 AND capability_id = $2`, [journey.orgA, dupId]);
  pass('CON-11', dup.filter((item) => item.status === 201).length === 1 && dup.filter((item) => item.status === 409).length === 1 && dupRows === 1,
    dup.map((item) => item.status).join(','));

  const missingEndpoint = await call(base, 'PUT', `/v1/agents/${lab}/capabilities/finance.lab.match`, key, {
    version: '1.0.1', endpoint_key: 'missing',
  }, { 'idempotency-key': 's3-matrix-miss-ep-01', 'if-match': '"cap-binding-v2"' });
  const missingCap = await call(base, 'PUT', `/v1/agents/${lab}/capabilities/finance.lab.missing`, key, {
    version: '1.0.0', endpoint_key: 'secondary',
  }, { 'idempotency-key': 's3-matrix-miss-cap01', 'if-none-match': '*' });
  const disabledEp = await call(base, 'PUT', `/v1/agents/${lab}/endpoints/secondary`, key, { ...endpointBody, enabled: false }, {
    'idempotency-key': 's3-matrix-disable-sec', 'if-match': '"endpoint-v1"',
  });
  const otherCap = await call(base, 'POST', '/v1/capabilities', key, publishBody('finance.lab.other', '1.0.0'), {
    'idempotency-key': 's3-matrix-other-cap01',
  });
  const bindDisabled = await call(base, 'PUT', `/v1/agents/${lab}/capabilities/finance.lab.other`, key, {
    version: '1.0.0', endpoint_key: 'secondary',
  }, { 'idempotency-key': 's3-matrix-bind-dis001', 'if-none-match': '*' });
  pass('CON-12', missingEndpoint.status === 404 && missingEndpoint.json.error.code === 'ENDPOINT_NOT_FOUND'
    && missingCap.status === 404 && missingCap.json.error.code === 'CAPABILITY_NOT_FOUND'
    && disabledEp.status === 200 && otherCap.status === 201 && bindDisabled.status === 422
    && !missingCap.text.includes('secondary'), `${snip(missingEndpoint)} ${snip(missingCap)} ${snip(bindDisabled)}`);

  const badId = await call(base, 'POST', '/v1/capabilities', key, publishBody('Finance.Bad', '1.0.0'), { 'idempotency-key': 's3-matrix-bad-id-001' });
  const badVer = await call(base, 'POST', '/v1/capabilities', key, publishBody('finance.lab.badver', '1'), { 'idempotency-key': 's3-matrix-bad-ver001' });
  pass('VAL-01', badId.status === 422 && badVer.status === 422, `${snip(badId)} ${snip(badVer)}`);
  const hugeVer = await call(base, 'POST', '/v1/capabilities', key, publishBody('finance.lab.hugever', '1.0.2147483648'), {
    'idempotency-key': 's3-matrix-huge-ver01',
  });
  pass('VAL-02', hugeVer.status === 422 && hugeVer.json.error.code === 'VALIDATION_ERROR', snip(hugeVer));
  const mediumSchema = { $schema: DRAFT, type: 'object', properties: { blob: { type: 'string', description: 'm'.repeat(20000) } } };
  const medium = await call(base, 'POST', '/v1/capabilities', key, {
    ...publishBody('finance.lab.medium', '1.0.0'), input_schema: mediumSchema, output_schema: SCHEMA,
  }, { 'idempotency-key': 's3-matrix-medium-cap' });
  let deep = { type: 'string' };
  for (let index = 0; index < 20; index += 1) deep = { type: 'object', properties: { n: deep } };
  const tooDeep = await call(base, 'POST', '/v1/capabilities', key, {
    ...publishBody('finance.lab.deep', '1.0.0'), input_schema: { $schema: DRAFT, ...deep },
  }, { 'idempotency-key': 's3-matrix-deep-cap01' });
  const wideProps = {};
  for (let index = 0; index < 320; index += 1) wideProps[`p${index}`] = { type: 'string' };
  const tooWide = await call(base, 'POST', '/v1/capabilities', key, {
    ...publishBody('finance.lab.wide', '1.0.0'), input_schema: { $schema: DRAFT, type: 'object', properties: wideProps },
  }, { 'idempotency-key': 's3-matrix-wide-cap01' });
  const tooBig = await call(base, 'POST', '/v1/capabilities', key, {
    ...publishBody('finance.lab.big', '1.0.0'),
    input_schema: { $schema: DRAFT, type: 'object', properties: { blob: { type: 'string', description: 'x'.repeat(33000) } } },
  }, { 'idempotency-key': 's3-matrix-big-cap001' });
  pass('VAL-03', medium.status === 201 && tooDeep.status === 422 && tooWide.status === 422 && tooBig.status === 422,
    `medium=${medium.status} deep=${tooDeep.status} wide=${tooWide.status} big=${tooBig.status}`);
  const oldDraft = await call(base, 'POST', '/v1/capabilities', key, {
    ...publishBody('finance.lab.draft', '1.0.0'),
    input_schema: { $schema: 'https://json-schema.org/draft-07/schema', type: 'object' },
  }, { 'idempotency-key': 's3-matrix-draft-0701' });
  const remoteDraft = await call(base, 'POST', '/v1/capabilities', key, {
    ...publishBody('finance.lab.draft', '1.0.1'),
    input_schema: { $schema: 'https://evil.example/schema', type: 'object' },
  }, { 'idempotency-key': 's3-matrix-draft-evil' });
  pass('VAL-04', oldDraft.status === 422 && remoteDraft.status === 422, `${snip(oldDraft)} ${snip(remoteDraft)}`);
  const badKey = await call(base, 'PUT', `/v1/agents/${lab}/endpoints/Bad`, key, endpointBody, {
    'idempotency-key': 's3-matrix-bad-key001', 'if-none-match': '*',
  });
  const badProto = await call(base, 'PUT', `/v1/agents/${lab}/endpoints/badproto`, key, {
    protocol: 'grpc', url: 'https://ap.internal.example/a2a', auth_scheme: 'oauth2',
  }, { 'idempotency-key': 's3-matrix-bad-proto1', 'if-none-match': '*' });
  pass('VAL-05', badKey.status === 400 && badProto.status === 422 && urlStatuses[0] === 422, `${snip(badKey)} ${snip(badProto)}`);
  const extraField = await call(base, 'PUT', `/v1/agents/${lab}/endpoints/extra`, key, {
    ...endpointBody, note: 'nope',
  }, { 'idempotency-key': 's3-matrix-extra-fld1', 'if-none-match': '*' });
  const missingField = await call(base, 'PUT', `/v1/agents/${lab}/endpoints/extra`, key, { url: 'https://ap.internal.example/a2a' }, {
    'idempotency-key': 's3-matrix-miss-field', 'if-none-match': '*',
  });
  pass('VAL-06', extraField.status === 422 && missingField.status === 422, `${snip(extraField)} ${snip(missingField)}`);
  const hugeBody = JSON.stringify({ capability: { id: 'finance.invoice.match' }, cursor: 'a'.repeat(17000) });
  const oversized = await call(base, 'POST', '/v1/discovery/agents', key, hugeBody);
  pass('VAL-07', hugeBody.length > 16384 && oversized.status === 413 && oversized.json.error.code === 'PAYLOAD_TOO_LARGE', snip(oversized));
  const duplicateTags = await call(base, 'POST', '/v1/discovery/agents', key, {
    capability: { id: 'finance.invoice.match' },
    tags: [
      { namespace: 'department', key: 'name', operator: 'eq', value: 'finance' },
      { namespace: 'department', key: 'name', operator: 'eq', value: 'other' },
    ],
  });
  pass('VAL-08', duplicateTags.status === 422, snip(duplicateTags));
  const wrongType = await call(base, 'POST', '/v1/discovery/agents', key, {
    capability: { id: 'finance.invoice.match' },
    tags: [{ namespace: 'department', key: 'name', operator: 'eq', value: 1 }],
  });
  const missingTag = await call(base, 'POST', '/v1/discovery/agents', key, {
    capability: { id: 'finance.invoice.match' },
    tags: [{ namespace: 'missing', key: 'nope', operator: 'eq', value: 'x' }],
  });
  pass('VAL-09', wrongType.status === 422 && missingTag.status === 422 && !missingTag.text.includes(journey.agentId), `${snip(wrongType)} ${snip(missingTag)}`);

  const scopes = scopeFingerprint(FULL.split(','));
  const filter = discoveryFilterKey({ capabilityId: 'finance.invoice.match', version: '1.0.0', tags: null, protocols: ['a2a'] });
  const catalog = await call(base, 'GET', `/v1/capabilities?id=${encodeURIComponent(pageId)}&limit=1`, key);
  const catalogCursor = catalog.json.meta.next_cursor;
  const macStart = catalogCursor.indexOf('.') + 1;
  const flipped = `${catalogCursor.slice(0, macStart)}${catalogCursor[macStart] === 'A' ? 'B' : 'A'}${catalogCursor.slice(macStart + 1)}`;
  const badCursor = await call(base, 'GET', `/v1/capabilities?id=${encodeURIComponent(pageId)}&cursor=${encodeURIComponent(flipped)}`, key);
  const wrongFilter = encodeDiscoveryCursor(pepper, {
    org: journey.orgA, principal: journey.actorA, scopes, filter: discoveryFilterKey({
      capabilityId: 'finance.invoice.match', version: null, tags: null, protocols: null,
    }), id: journey.agentId,
  });
  const wrong = await call(base, 'POST', '/v1/discovery/agents', key, {
    capability: { id: 'finance.invoice.match', version: '1.0.0' }, protocols: ['a2a'], cursor: wrongFilter,
  });
  pass('VAL-10', badCursor.status === 400 && badCursor.json.error.code === 'INVALID_CURSOR'
    && wrong.status === 400 && wrong.json.error.code === 'INVALID_CURSOR', `${snip(badCursor)} ${snip(wrong)}`);
  const otherPrincipal = encodeDiscoveryCursor(pepper, {
    org: journey.orgA, principal: journey.actorB, scopes, filter, id: journey.agentId,
  });
  const otherOrg = encodeCatalogCursor(pepper, {
    org: journey.orgB, principal: journey.actorA, scopes, filter: '{"id":null}', id: pageId, version: '1.0.0',
  });
  const principalDenied = await call(base, 'POST', '/v1/discovery/agents', key, {
    capability: { id: 'finance.invoice.match', version: '1.0.0' }, protocols: ['a2a'], cursor: otherPrincipal,
  });
  const orgDenied = await call(base, 'GET', `/v1/capabilities?cursor=${encodeURIComponent(otherOrg)}`, key);
  pass('VAL-11', principalDenied.status === 400 && principalDenied.json.error.code === 'INVALID_CURSOR'
    && orgDenied.status === 400 && orgDenied.json.error.code === 'INVALID_CURSOR', `${snip(principalDenied)} ${snip(orgDenied)}`);
  const expiredCursor = encodeDiscoveryCursor(pepper, {
    org: journey.orgA, principal: journey.actorA, scopes, filter, id: journey.agentId,
  }, Date.now(), 0);
  const expiredRead = await call(base, 'POST', '/v1/discovery/agents', key, {
    capability: { id: 'finance.invoice.match', version: '1.0.0' }, protocols: ['a2a'], cursor: expiredCursor,
  });
  pass('VAL-12', expiredRead.status === 400 && expiredRead.json.error.code === 'INVALID_CURSOR', snip(expiredRead));
  const hugeLimit = await call(base, 'POST', '/v1/discovery/agents', key, { capability: { id: 'finance.invoice.match' }, limit: 51 });
  const hugeCatalog = await call(base, 'GET', '/v1/capabilities?limit=101', key);
  pass('VAL-13', hugeLimit.status === 422 && hugeCatalog.status === 422, `${snip(hugeLimit)} ${snip(hugeCatalog)}`);

  const contractError = (() => {
    try {
      compileContract().validate('CapabilityResponse', catalog.json.data ? { data: catalog.json.data[0], meta: { request_id: catalog.json.meta.request_id, api_version: 'v1' } } : catalog.json);
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : 'invalid';
    }
  })();
  const oneCap = await call(base, 'GET', `/v1/capabilities/${pageId}/versions/1.0.0`, key);
  let contractDetail = contractError;
  try {
    compileContract().validate('CapabilityResponse', oneCap.json);
  } catch (error) {
    contractDetail = error instanceof Error ? error.message : 'invalid';
  }
  if (contractDetail) throw new Error(`contract ${contractDetail}`);

  await superuser.query(`
    CREATE OR REPLACE FUNCTION fad_s3_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN RAISE EXCEPTION 'audit failed' USING ERRCODE = 'P0001'; END; $fn$`);
  await superuser.query('CREATE TRIGGER fad_s3_audit_fail BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fad_s3_audit_fail()');
  let beforeFail;
  try {
    beforeFail = await call(base, 'POST', '/v1/capabilities', key, publishBody('finance.lab.rollback', '1.0.0'), {
      'idempotency-key': 's3-matrix-audit-before',
    });
  } finally {
    await superuser.query('DROP TRIGGER IF EXISTS fad_s3_audit_fail ON audit_events');
  }
  const beforeRows = await count(superuser, `SELECT count(*)::int AS n FROM capability_versions WHERE organization_id = $1 AND capability_id = 'finance.lab.rollback'`, [journey.orgA]);
  const beforeIdem = await count(superuser, `SELECT count(*)::int AS n FROM idempotency_records WHERE organization_id = $1 AND idem_key = 's3-matrix-audit-before'`, [journey.orgA]);
  pass('DUR-01', beforeFail.status === 500 && beforeRows === 0 && beforeIdem === 0, snip(beforeFail));
  await superuser.query('CREATE TRIGGER fad_s3_audit_fail AFTER INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fad_s3_audit_fail()');
  let afterFail;
  try {
    afterFail = await call(base, 'POST', '/v1/capabilities', key, publishBody('finance.lab.rollback', '1.0.1'), {
      'idempotency-key': 's3-matrix-audit-after1',
    });
  } finally {
    await superuser.query('DROP TRIGGER IF EXISTS fad_s3_audit_fail ON audit_events');
    await superuser.query('DROP FUNCTION IF EXISTS fad_s3_audit_fail()');
  }
  const afterRows = await count(superuser, `SELECT count(*)::int AS n FROM capability_versions WHERE organization_id = $1 AND capability_id = 'finance.lab.rollback'`, [journey.orgA]);
  const afterIdem = await count(superuser, `SELECT count(*)::int AS n FROM idempotency_records WHERE organization_id = $1 AND idem_key = 's3-matrix-audit-after1'`, [journey.orgA]);
  pass('DUR-02', afterFail.status === 500 && afterRows === 0 && afterIdem === 0, snip(afterFail));

  const replayBody = publishBody('finance.lab.samereplay', '1.0.0');
  const parallelReplay = await Promise.all([0, 1].map(() => call(base, 'POST', '/v1/capabilities', key, replayBody, {
    'idempotency-key': 's3-matrix-same-replay',
  })));
  const replayRows = await count(superuser, `SELECT count(*)::int AS n FROM capability_versions WHERE organization_id = $1 AND capability_id = 'finance.lab.samereplay'`, [journey.orgA]);
  const replayAudit = await count(superuser, `SELECT count(*)::int AS n FROM audit_events WHERE organization_id = $1 AND action = 'capability.published' AND target_id = 'finance.lab.samereplay@1.0.0'`, [journey.orgA]);
  const replayHashes = parallelReplay.map((item) => item.json?.data?.contract_sha256 ?? 'none').join(',');
  pass('DUR-03', parallelReplay.every((item) => item.status === 201) && replayRows === 1 && replayAudit === 1
    && parallelReplay[0].json.data.contract_sha256 === parallelReplay[1].json.data.contract_sha256,
  `${parallelReplay.map((item) => item.status).join(',')} rows=${replayRows} audits=${replayAudit} hashes=${replayHashes}`);

  const downConfig = loadConfig({
    ...process.env,
    NODE_ENV: 'development',
    FAD_BIND_HOST: '127.0.0.1',
    FAD_INGRESS_TLS: 'cleartext',
    FAD_TRUST_PROXY: 'false',
    FAD_SLICE3_ENABLED: 'true',
    FAD_TAGS_ENABLED: 'true',
    DATABASE_URL: 'postgres://fad_app:x@127.0.0.1:1/fad',
  });
  const downPool = createPool({ connectionString: downConfig.databaseUrl, max: 1, statementTimeoutMs: 1000, applicationName: 'fad-s3-down', ssl: false });
  const downApp = await buildApp({ config: downConfig, pool: downPool });
  await downApp.app.listen({ port: 0, host: '127.0.0.1' });
  const downAddress = downApp.app.server.address();
  const downBase = `http://127.0.0.1:${downAddress.port}`;
  const downLive = await request(`${downBase}/health/live`);
  const downWrite = await call(downBase, 'POST', '/v1/capabilities', key, publishBody('finance.lab.down', '1.0.0'), {
    'idempotency-key': 's3-matrix-down-cap01',
  });
  await downApp.app.close();
  await downPool.end();
  const downRows = await count(superuser, `SELECT count(*)::int AS n FROM capability_versions WHERE organization_id = $1 AND capability_id = 'finance.lab.down'`, [journey.orgA]);
  pass('DUR-05', downLive.status === 200 && downWrite.status === 503 && downWrite.json.error.code === 'DEPENDENCY_UNAVAILABLE' && downRows === 0, snip(downWrite));

  const failDir = mkdtempSync(join(scratch, 's3-fail-'));
  cpSync(MIGRATIONS, failDir, { recursive: true });
  writeFileSync(join(failDir, '20261023_001_abort.up.sql'), `CREATE TABLE fad_s3_migration_abort (id int);\nDO $$ BEGIN RAISE EXCEPTION 'abort slice3 migration proof'; END $$;\n`);
  let aborted = false;
  try {
    await applyMigrations(requiredEnv('FAD_MIGRATOR_DATABASE_URL'), failDir);
  } catch {
    aborted = true;
  }
  const abortTable = await superuser.query(`SELECT to_regclass('public.fad_s3_migration_abort') AS name`);
  const abortChecksum = await count(superuser, `SELECT count(*)::int AS n FROM schema_migrations WHERE version = '20261023_001_abort'`);
  const kept = await count(superuser, `SELECT count(*)::int AS n FROM capability_versions`);
  pass('DUR-06', aborted && abortTable.rows[0].name === null && abortChecksum === 0 && kept > 0, `abort=${aborted} table=${abortTable.rows[0].name} kept=${kept}`);

  await superuser.query('BEGIN');
  await superuser.query(`CREATE TEMP TABLE s3_cap AS SELECT * FROM capability_versions WHERE organization_id = $1`, [journey.orgA]);
  await superuser.query(`CREATE TEMP TABLE s3_ep AS SELECT * FROM agent_endpoints WHERE organization_id = $1`, [journey.orgA]);
  await superuser.query(`CREATE TEMP TABLE s3_epr AS SELECT * FROM agent_endpoint_revisions WHERE organization_id = $1`, [journey.orgA]);
  await superuser.query(`CREATE TEMP TABLE s3_bind AS SELECT * FROM agent_capability_bindings WHERE organization_id = $1`, [journey.orgA]);
  await superuser.query(`CREATE TEMP TABLE s3_br AS SELECT * FROM agent_capability_binding_revisions WHERE organization_id = $1`, [journey.orgA]);
  const beforeRestore = await count(superuser, `SELECT count(*)::int AS n FROM s3_cap`);
  await superuser.query('DELETE FROM agent_capability_binding_revisions WHERE organization_id = $1', [journey.orgA]);
  await superuser.query('DELETE FROM agent_capability_bindings WHERE organization_id = $1', [journey.orgA]);
  await superuser.query('DELETE FROM agent_endpoint_revisions WHERE organization_id = $1', [journey.orgA]);
  await superuser.query('DELETE FROM agent_endpoints WHERE organization_id = $1', [journey.orgA]);
  await superuser.query('DELETE FROM capability_versions WHERE organization_id = $1', [journey.orgA]);
  await superuser.query('INSERT INTO capability_versions SELECT * FROM s3_cap');
  await superuser.query('INSERT INTO agent_endpoints SELECT * FROM s3_ep');
  await superuser.query('INSERT INTO agent_endpoint_revisions SELECT * FROM s3_epr');
  await superuser.query('INSERT INTO agent_capability_bindings SELECT * FROM s3_bind');
  await superuser.query('INSERT INTO agent_capability_binding_revisions SELECT * FROM s3_br');
  const afterRestore = await count(superuser, `SELECT count(*)::int AS n FROM capability_versions WHERE organization_id = $1`, [journey.orgA]);
  await superuser.query('COMMIT');
  pass('DUR-07', beforeRestore > 0 && beforeRestore === afterRestore, `before=${beforeRestore} after=${afterRestore}`);
  evidence.push(`DUR-07 restored_capabilities=${afterRestore}`);

  const guardUrl = fileURLToPath(new URL('./slice3-net-guard.mjs', import.meta.url));
  const apiEnv = {
    FAD_TAGS_ENABLED: 'true',
    FAD_SLICE3_ENABLED: 'true',
    FAD_HTTP_REQUEST_TIMEOUT_MS: '30000',
    FAD_SHUTDOWN_GRACE_MS: '30000',
    FAD_DB_POOL_MAX: '8',
    FAD_RATE_LIMIT_MAX: '8000',
    FAD_NET_GUARD_LOG: guardLog,
    NODE_OPTIONS: `--import ${guardUrl.startsWith('/') ? `file://${guardUrl}` : guardUrl}`,
  };
  const replicaB = await startApi(apiEnv);
  const replicaC = await startApi(apiEnv);
  const targets = [base, replicaB.base, replicaC.base];
  let turn = 0;
  const proxy = http.createServer((req, res) => {
    const target = new URL(targets[turn % targets.length]);
    turn += 1;
    const outbound = http.request({
      hostname: target.hostname,
      port: target.port,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: target.host },
    }, (upstream) => {
      res.writeHead(upstream.statusCode ?? 502, upstream.headers);
      upstream.pipe(res);
    });
    outbound.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(outbound);
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const proxyPort = proxy.address().port;
  const proxyBase = `http://127.0.0.1:${proxyPort}`;
  const via = [];
  for (let index = 0; index < 3; index += 1) {
    via.push(await call(proxyBase, 'GET', `/v1/capabilities/${pageId}/versions/1.0.0`, key));
  }
  const direct = await Promise.all(targets.map((item) => call(item, 'GET', `/v1/capabilities/${pageId}/versions/1.10.0`, key)));
  const pageA = await call(targets[0], 'GET', `/v1/capabilities?id=${encodeURIComponent(pageId)}&limit=1`, key);
  const pageB = await call(targets[1], 'GET', `/v1/capabilities?id=${encodeURIComponent(pageId)}&limit=1&cursor=${encodeURIComponent(pageA.json.meta.next_cursor)}`, key);
  pass('DEP-02', replicaB.ready && replicaC.ready && via.every((item) => item.status === 200 && item.json.data.version === '1.0.0')
    && direct.every((item) => item.status === 200 && item.json.data.contract_sha256 === direct[0].json.data.contract_sha256)
    && pageB.status === 200 && pageB.json.data[0].version === '1.0.1' && pageA.json.data[0].version === '1.0.0',
  via.map((item) => item.status).join(','));
  proxy.close();
  await replicaB.stop();
  await replicaC.stop();

  const flaggedOff = await startApi({ ...apiEnv, FAD_SLICE3_ENABLED: 'false' });
  const offAgent = await call(flaggedOff.base, 'GET', `/v1/agents/${journey.agentId}`, key);
  const offCap = await call(flaggedOff.base, 'POST', '/v1/capabilities', key, publishBody('finance.lab.off', '1.0.0'), {
    'idempotency-key': 's3-matrix-flag-off01',
  });
  const offDisc = await call(flaggedOff.base, 'POST', '/v1/discovery/agents', key, { capability: { id: 'finance.invoice.match' } });
  const onMethod = await call(base, 'GET', '/v1/discovery/agents', key);
  pass('DEP-03', flaggedOff.ready && offAgent.status === 200 && offAgent.json.data.id === journey.agentId
    && offCap.status === 404 && offCap.json.error.code === 'NOT_FOUND'
    && offDisc.status === 404 && onMethod.status === 405 && onMethod.json.error.code === 'METHOD_NOT_ALLOWED',
  `${snip(offCap)} ${snip(onMethod)}`);
  await flaggedOff.stop();

  const image = await waitForImage();
  const db = new URL(requiredEnv('DATABASE_URL'));
  db.hostname = 'fad-s0-pg';
  db.port = '5432';
  const envFile = join(scratch, 'slice3-image.env');
  writeFileSync(envFile, [
    'NODE_ENV=development',
    'PORT=8080',
    'FAD_BIND_HOST=0.0.0.0',
    'FAD_DEV_LOOPBACK_PUBLISH=true',
    'FAD_INGRESS_TLS=cleartext',
    'FAD_TRUST_PROXY=false',
    'FAD_RATE_LIMIT_BACKEND=postgres',
    'FAD_RATE_LIMIT_MAX=1000',
    `DATABASE_URL=${db.toString()}`,
    `FAD_API_KEY_PEPPER_V1=${pepper.toString('utf8')}`,
    'FAD_TAGS_ENABLED=true',
    'FAD_SLICE3_ENABLED=false',
  ].join('\n'));
  execFileSync('docker', ['rm', '-f', 'fad-s3-old', 'fad-s3-new'], { stdio: 'ignore' });
  let oldHealth = null;
  let oldAgent = null;
  let oldCap = null;
  let newHealth = null;
  let newCap = null;
  try {
    execFileSync('docker', ['run', '-d', '--name', 'fad-s3-old', '--network', 'fad-s0', '-p', '127.0.0.1:18110:8080', '--env-file', envFile, 'fad-api:slice2'], { stdio: 'ignore' });
    oldHealth = await waitReady('http://127.0.0.1:18110');
    oldAgent = await call('http://127.0.0.1:18110', 'GET', `/v1/agents/${journey.agentId}`, key);
    oldCap = await call('http://127.0.0.1:18110', 'GET', `/v1/capabilities/${pageId}/versions/1.0.0`, key);
    const enabled = readFileSync(envFile, 'utf8').replace('FAD_SLICE3_ENABLED=false', 'FAD_SLICE3_ENABLED=true');
    writeFileSync(envFile, enabled);
    execFileSync('docker', ['run', '-d', '--name', 'fad-s3-new', '--network', 'fad-s0', '-p', '127.0.0.1:18111:8080', '--env-file', envFile, 'fad-api:slice3'], { stdio: 'ignore' });
    newHealth = await waitReady('http://127.0.0.1:18111');
    newCap = await call('http://127.0.0.1:18111', 'GET', `/v1/capabilities/${pageId}/versions/1.0.0`, key);
    const who = execFileSync('docker', ['exec', 'fad-s3-new', 'id', '-u'], { encoding: 'utf8' }).trim();
    evidence.push(`image=${image} uid=${who}`);
    pass('DEP-01', image.includes('node') && who === '1000' && ddl?.code === '42501', `${image} uid=${who}`);
  } finally {
    execFileSync('docker', ['rm', '-f', 'fad-s3-old', 'fad-s3-new'], { stdio: 'ignore' });
  }
  const stillThere = await count(superuser, `SELECT count(*)::int AS n FROM capability_versions WHERE organization_id = $1 AND capability_id = $2`, [journey.orgA, 'finance.invoice.match']);
  const rollbackLog = [
    `old_ready=${oldHealth?.status ?? 'missing'}`,
    `old_agent=${oldAgent?.status ?? 'missing'}`,
    `old_capability=${oldCap?.status ?? 'missing'}`,
    `new_ready=${newHealth?.status ?? 'missing'}`,
    `new_capability=${newCap?.status ?? 'missing'}`,
    `capability_rows=${stillThere}`,
    `image=${image}`,
  ].join('\n');
  writeEvidence('rollback.log', `${rollbackLog}\n`, secrets);
  pass('DUR-08', oldHealth?.status === 'ready' && oldAgent?.status === 200 && oldAgent.json.data.id === journey.agentId
    && oldCap?.status === 404 && stillThere >= 1, rollbackLog);
  pass('DEP-04', oldHealth?.status === 'ready' && oldAgent?.status === 200 && oldCap?.status === 404
    && newHealth?.status === 'ready' && newCap?.status === 200 && stillThere >= 1, rollbackLog);

  const oldDir = mkdtempSync(join(tmpdir(), 'fad-s3-old-sdk-'));
  mkdirSync(join(oldDir, 'src'));
  writeFileSync(join(oldDir, 'src/index.ts'), execFileSync('git', ['show', '400c531d98685f8c93481ed3e527498c7b9d6fb3:packages/sdk/src/index.ts']));
  writeFileSync(join(oldDir, 'package.json'), JSON.stringify({ name: 'old-sdk', private: true, type: 'module' }));
  writeFileSync(join(oldDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, outDir: 'dist' },
    include: ['src'],
  }));
  execFileSync(process.execPath, [join(process.cwd(), 'node_modules/typescript/lib/tsc.js'), '-p', join(oldDir, 'tsconfig.json')], { stdio: 'pipe' });
  writeFileSync(join(oldDir, 'smoke.mjs'), `
    const { FadClient } = await import('./dist/index.js');
    const client = new FadClient({ baseUrl: process.env.FAD_BASE_URL, apiKey: process.env.FAD_API_KEY, allowInsecureHttp: true, timeoutMs: 20000 });
    const agent = await client.agents.get(process.env.FAD_AGENT_ID);
    const tag = await client.agentTags.get(process.env.FAD_AGENT_ID, 'department', 'name');
    console.log(JSON.stringify({ id: agent.data.id, etag: agent.etag, tag: tag.data.value, tagEtag: tag.etag, keys: Object.keys(agent.data) }));
  `);
  const oldOut = execFileSync(process.execPath, ['smoke.mjs'], {
    cwd: oldDir,
    encoding: 'utf8',
    env: { ...process.env, FAD_BASE_URL: base, FAD_API_KEY: key, FAD_AGENT_ID: journey.agentId },
  });
  const oldJson = JSON.parse(oldOut);
  const consumer = journey.consumer ?? { ok: false };
  pass('SDK-02', oldJson.id === journey.agentId && oldJson.etag.startsWith('"agent-v') && oldJson.tag === 'finance'
    && oldJson.tagEtag === '"tag-v1"' && !oldJson.keys.includes('capabilities') && !oldJson.keys.includes('endpoints')
    && consumer.legacyAgent === journey.agentId, oldOut.trim());
  pass('SDK-03', consumer.ok === true && consumer.publish === 201 && consumer.etag === '"endpoint-v1"'
    && consumer.bindingEtag === '"cap-binding-v1"' && consumer.availability === 'not_checked'
    && consumer.authorization === 'not_evaluated' && consumer.duplicate === 409 && consumer.futureProtocol === 'future_bus',
  JSON.stringify({ publish: consumer.publish, etag: consumer.etag, error: consumer.error, status: consumer.errorStatus, code: consumer.errorCode }));
  pass('SDK-04', consumer.iterated === 2 && consumer.aborted === true, `iterated=${consumer.iterated} aborted=${consumer.aborted}`);
  pass('SDK-05', consumer.retryAttempts === 2 && consumer.retrySameKey === true, `attempts=${consumer.retryAttempts}`);
  pass('SDK-06', Array.isArray(consumer.hosts) && consumer.hosts.length > 0
    && consumer.hosts.every((host) => host === '127.0.0.1' || host === 'localhost')
    && !consumer.hosts.includes('ap.internal.example'), (consumer.hosts ?? []).join(','));
  writeEvidence('sdk-consumer.json', `${JSON.stringify({ ...consumer, hosts: consumer.hosts }, null, 2)}\n`, secrets);
  writeEvidence('sql-rls.txt', `${evidence.join('\n')}\n`, secrets);
  writeEvidence('net-guard.txt', guardAfter.length === 0 ? '(empty)\n' : guardAfter, secrets);
}
