import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { compileContract } from '@fad/contract';
import { buildAgentSearchQuery, encodeSearchCursor, searchFilterKey } from '@fad/db';
import { applyMigrations } from '@fad/migrator';
import { buildApp } from '@fad/api/app';
import { loadConfig } from '@fad/api/config';
import { createPool } from '@fad/db';
import { admin, check, parseJson, request, requiredEnv, scratch, startApi, stopApis, writeEvidence } from './support.mjs';

const { Client } = pg;
const appUrl = requiredEnv('DATABASE_URL');
const migratorUrl = requiredEnv('FAD_MIGRATOR_DATABASE_URL');
const pepper = requiredEnv('FAD_API_KEY_PEPPER_V1');
const migrationsDir = new URL('../db/migrations/', import.meta.url).pathname;
const FULL = 'organizations:read,agents:read,agents:write,agents:lifecycle,tags:define,tags:read,tags:write,tags:governance,tags:restricted:read';
const EDITOR = 'agents:read,agents:write,tags:define,tags:read,tags:write';
const TAG_WRITER = 'agents:read,tags:read,tags:write';
const AGENT_ONLY = 'organizations:read,agents:read,agents:write,agents:lifecycle';

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

async function count(client, sql, params) {
  const result = await client.query(sql, params);
  return result.rows[0].n;
}

function keyName(prefix) {
  return `${prefix}-${Date.now().toString(36)}`.slice(0, 40);
}

test('typed tags, search, isolation, and compatibility', { timeout: 300_000 }, async () => {
  await applyMigrations(migratorUrl, migrationsDir);
  const superuser = new Client({ connectionString: migratorUrl, application_name: 'fad-tag-super' });
  const app = new Client({ connectionString: appUrl, application_name: 'fad-tag-app' });
  superuser.on('error', () => undefined);
  app.on('error', () => undefined);
  await superuser.connect();
  await app.connect();
  const api = await startApi({
    FAD_TAGS_ENABLED: 'true',
    FAD_HTTP_REQUEST_TIMEOUT_MS: '30000',
    FAD_SHUTDOWN_GRACE_MS: '30000',
    FAD_DB_POOL_MAX: '12',
    FAD_RATE_LIMIT_MAX: '8000',
  });
  const secrets = [pepper];
  let keyA;
  try {
    check('tag-api-up', api.ready, api.logs().slice(-400));
    await superuser.query('DELETE FROM rate_limit_buckets');
    const orgA = parseJson((await admin(['organization', 'create', '--name', 'Tag Org A'])).stdout);
    const orgB = parseJson((await admin(['organization', 'create', '--name', 'Tag Org B'])).stdout);
    const orgQ = parseJson((await admin(['organization', 'create', '--name', 'Tag Org Quota'])).stdout);
    const orgT = parseJson((await admin(['organization', 'create', '--name', 'Tag Org Tomb'])).stdout);
    const actor = parseJson((await admin(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Tag Actor'])).stdout);
    const owner = parseJson((await admin(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Tag Owner'])).stdout);
    const editorP = parseJson((await admin(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Tag Editor'])).stdout);
    const writerP = parseJson((await admin(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Tag Writer'])).stdout);
    const ownerOnly = parseJson((await admin(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Tag Owner Only'])).stdout);
    const actorB = parseJson((await admin(['principal', 'create', '--organization-id', orgB.id, '--type', 'service', '--name', 'Tag Actor B'])).stdout);
    const quotaP = parseJson((await admin(['principal', 'create', '--organization-id', orgQ.id, '--type', 'service', '--name', 'Tag Quota'])).stdout);
    const tombP = parseJson((await admin(['principal', 'create', '--organization-id', orgT.id, '--type', 'service', '--name', 'Tag Tomb'])).stdout);
    const authP = parseJson((await admin(['principal', 'create', '--organization-id', orgT.id, '--type', 'service', '--name', 'Tag Auth'])).stdout);
    const issued = async (org, principal, scopes) => parseJson((await admin([
      'credential', 'issue', '--organization-id', org, '--principal-id', principal, '--scopes', scopes,
    ])).stdout);
    keyA = await issued(orgA.id, actor.id, FULL);
    const keyEdit = await issued(orgA.id, editorP.id, EDITOR);
    const keyWrite = await issued(orgA.id, writerP.id, TAG_WRITER);
    const keyOwner = await issued(orgA.id, ownerOnly.id, 'agents:read');
    const keyAgent = await issued(orgA.id, actor.id, AGENT_ONLY);
    const keyB = await issued(orgB.id, actorB.id, FULL);
    const keyQ = await issued(orgQ.id, quotaP.id, FULL);
    const keyT = await issued(orgT.id, tombP.id, FULL);
    const keyAuth = await issued(orgT.id, authP.id, FULL);
    for (const item of [keyA, keyEdit, keyWrite, keyOwner, keyAgent, keyB, keyQ, keyT, keyAuth]) secrets.push(item.api_key);

    const live = await call(api.base, 'GET', '/health/live');
    const ready = await call(api.base, 'GET', '/health/ready');
    const current = await call(api.base, 'GET', '/v1/organizations/current', keyAgent.api_key);
    check('C01', live.status === 200 && live.json.status === 'ok' && live.json.schema === undefined);
    check('C02', ready.status === 200 && ready.json.status === 'ready' && Object.keys(ready.json).join() === 'status');
    check('C03', current.status === 200 && current.json.data.id === orgA.id && current.json.meta.api_version === 'v1'
      && current.json.data.name === 'Tag Org A' && current.json.data.status === 'active');

    const createdAgent = await call(api.base, 'POST', '/v1/agents', keyA.api_key, {
      name: 'Accounts Payable Agent',
      description: 'Manages supplier invoice workflow',
      owner_principal_id: ownerOnly.id,
    }, { 'idempotency-key': 'tag-agent-create-0001' });
    const agentId = createdAgent.json?.data?.id;
    check('C04', createdAgent.status === 201 && createdAgent.headers.etag === '"agent-v1"'
      && createdAgent.json.data.revision === 1 && createdAgent.json.data.organization_id === orgA.id
      && !('tags' in createdAgent.json.data));
    const listed = await call(api.base, 'GET', '/v1/agents?limit=25', keyA.api_key);
    const loaded = await call(api.base, 'GET', `/v1/agents/${agentId}`, keyA.api_key);
    check('C05', loaded.status === 200 && loaded.headers.etag === '"agent-v1"'
      && listed.status === 200 && listed.json.meta.limit === 25 && listed.json.meta.next_cursor === null
      && listed.json.data.some((item) => item.id === agentId));
    const patched = await call(api.base, 'PATCH', `/v1/agents/${agentId}`, keyA.api_key, {
      description: 'Matches supplier invoices',
    }, { 'idempotency-key': 'tag-agent-patch-0001', 'if-match': '"agent-v1"' });
    const stale = await call(api.base, 'PATCH', `/v1/agents/${agentId}`, keyA.api_key, {
      description: 'stale',
    }, { 'idempotency-key': 'tag-agent-patch-stale', 'if-match': '"agent-v1"' });
    const suspended = await call(api.base, 'POST', `/v1/agents/${agentId}/suspend`, keyA.api_key, {
      reason: 'Hold for review',
    }, { 'idempotency-key': 'tag-agent-suspend-01', 'if-match': '"agent-v2"' });
    const activated = await call(api.base, 'POST', `/v1/agents/${agentId}/activate`, keyA.api_key, {
      reason: 'Review complete',
    }, { 'idempotency-key': 'tag-agent-activate-1', 'if-match': suspended.headers.etag });
    check('C06', patched.status === 200 && patched.headers.etag === '"agent-v2"'
      && stale.status === 412 && stale.json.error.code === 'PRECONDITION_FAILED'
      && suspended.status === 200 && activated.status === 200 && activated.json.data.status === 'active');

    const diff = execFileSync(process.execPath, ['scripts/openapi-diff.mjs'], { encoding: 'utf8' });
    const diffJson = JSON.parse(diff);
    const tagOps = [
      'post /v1/tag-definitions',
      'get /v1/tag-definitions',
      'get /v1/tag-definitions/{namespace}/{key}',
      'get /v1/agents/{agentId}/tags',
      'get /v1/agents/{agentId}/tags/{namespace}/{key}',
      'put /v1/agents/{agentId}/tags/{namespace}/{key}',
      'delete /v1/agents/{agentId}/tags/{namespace}/{key}',
      'post /v1/agents/search',
    ];
    check('C08', diffJson.ok === true && diffJson.breaking.length === 0
      && tagOps.every((item) => diffJson.added_operations.includes(item))
      && diffJson.preserved_operations.includes('get /v1/organizations/current'));
    writeEvidence('openapi-diff.json', diff, secrets);

    const contract = compileContract();
    const sampleMeta = { request_id: '3b0fb35b-3c4c-489a-90fa-17232c7b8fda', api_version: 'v1' };
    contract.validate('TagAssignmentResponse', {
      data: {
        agent_id: agentId,
        namespace: 'department',
        key: 'name',
        value: false,
        revision: 1,
        governed: false,
        visibility: 'internal',
        created_by: actor.id,
        updated_by: actor.id,
        created_at: '2026-10-20T20:00:00.000Z',
        updated_at: '2026-10-20T20:00:00.000Z',
      },
      meta: sampleMeta,
    });
    contract.validate('TagAssignmentResponse', {
      data: {
        agent_id: agentId,
        namespace: 'department',
        key: 'count',
        value: 0,
        revision: 1,
        governed: false,
        visibility: 'internal',
        created_by: actor.id,
        updated_by: actor.id,
        created_at: '2026-10-20T20:00:00.000Z',
        updated_at: '2026-10-20T20:00:00.000Z',
      },
      meta: sampleMeta,
    });

    const define = (body, idem, key = keyA.api_key) => call(api.base, 'POST', '/v1/tag-definitions', key, body, { 'idempotency-key': idem });
    const stringDef = await define({
      namespace: 'department', key: 'name', value_type: 'string', governed: false, visibility: 'internal', description: 'Department name',
    }, 'tag-def-string-0001');
    check('D01', stringDef.status === 201
      && stringDef.json.data.organization_id === orgA.id
      && stringDef.json.data.created_by === actor.id
      && stringDef.json.data.namespace === 'department'
      && stringDef.json.data.key === 'name'
      && stringDef.json.data.value_type === 'string'
      && stringDef.json.data.enum_values === null
      && stringDef.json.data.governed === false
      && stringDef.headers.location === '/v1/tag-definitions/department/name'
      && stringDef.headers['cache-control'] === 'private, no-store');
    writeEvidence('http-d01.json', JSON.stringify({ status: stringDef.status, body: stringDef.json, location: stringDef.headers.location }, null, 2), secrets);
    const intDef = await define({ namespace: 'billing', key: 'count', value_type: 'integer', governed: false, visibility: 'internal' }, 'tag-def-integer-001');
    const boolDef = await define({ namespace: 'billing', key: 'active', value_type: 'boolean', governed: false, visibility: 'internal' }, 'tag-def-boolean-001');
    const enumDef = await define({
      namespace: 'billing', key: 'tier', value_type: 'enum', enum_values: ['low', 'high'], governed: false, visibility: 'internal',
    }, 'tag-def-enum-000001');
    check('D02', intDef.status === 201 && boolDef.status === 201 && enumDef.status === 201 && enumDef.json.data.enum_values.join() === 'low,high');
    const enumMissing = await define({ namespace: 'billing', key: 'bad', value_type: 'enum', governed: false, visibility: 'internal' }, 'tag-def-enum-missing');
    const enumExtra = await define({
      namespace: 'billing', key: 'extra', value_type: 'string', enum_values: ['a', 'b'], governed: false, visibility: 'internal',
    }, 'tag-def-enum-extra01');
    check('D03', enumMissing.status === 422 && enumExtra.status === 422);
    const dupEnum = await define({
      namespace: 'billing', key: 'dup', value_type: 'enum', enum_values: ['low', 'low'], governed: false, visibility: 'internal',
    }, 'tag-def-enum-dup001');
    const emptyEnum = await define({
      namespace: 'billing', key: 'empty', value_type: 'enum', enum_values: ['', 'ok'], governed: false, visibility: 'internal',
    }, 'tag-def-enum-empty01');
    const manyEnum = await define({
      namespace: 'billing', key: 'many', value_type: 'enum', enum_values: Array.from({ length: 33 }, (_, i) => `v${i}`), governed: false, visibility: 'internal',
    }, 'tag-def-enum-many001');
    const longEnum = await define({
      namespace: 'billing', key: 'long', value_type: 'enum', enum_values: ['ok', 'x'.repeat(65)], governed: false, visibility: 'internal',
    }, 'tag-def-enum-long001');
    check('D04', [dupEnum, emptyEnum, manyEnum, longEnum].every((item) => item.status === 422));
    const badNames = [];
    for (const [namespace, key, idem] of [
      ['Department', 'name', 'tag-def-upper-00001'],
      ['bad name', 'name', 'tag-def-space-00001'],
      ['bad/name', 'name', 'tag-def-slash-00001'],
      ['ѕecurity', 'name', 'tag-def-look-000001'],
    ]) {
      badNames.push(await define({ namespace, key, value_type: 'string', governed: false, visibility: 'internal' }, idem));
    }
    check('D05', badNames.every((item) => item.status === 422));
    const reserved = [];
    for (const namespace of ['security', 'compliance', 'system']) {
      reserved.push(await define({
        namespace, key: 'plain', value_type: 'string', governed: false, visibility: 'internal',
      }, `tag-def-reserved-${namespace}`));
    }
    const reservedRows = await count(superuser, `SELECT count(*)::int AS n FROM tag_definitions WHERE organization_id = $1 AND tag_key = 'plain'`, [orgA.id]);
    check('D06', reserved.every((item) => item.status === 422) && reservedRows === 0);
    const noGov = await define({
      namespace: 'security', key: 'risk', value_type: 'enum', enum_values: ['low', 'high'], governed: true, visibility: 'restricted',
    }, 'tag-def-nogov-00001', keyEdit.api_key);
    check('D07', noGov.status === 403 && noGov.json.error.code === 'FORBIDDEN');
    const governed = await define({
      namespace: 'security', key: 'risk', value_type: 'enum', enum_values: ['low', 'high'], governed: true, visibility: 'restricted', description: 'Risk classification',
    }, 'tag-def-governed-001');
    check('D08', governed.status === 201 && governed.json.data.governed === true && governed.json.data.visibility === 'restricted');
    const sameOther = await define({
      namespace: 'department', key: 'name', value_type: 'string', governed: false, visibility: 'internal',
    }, 'tag-def-other-org001', keyB.api_key);
    const dupNew = await define({
      namespace: 'department', key: 'name', value_type: 'string', governed: false, visibility: 'internal',
    }, 'tag-def-dup-new-0001');
    check('D09', sameOther.status === 201 && sameOther.json.data.organization_id === orgB.id);
    const replayDef = await define({
      namespace: 'department', key: 'name', value_type: 'string', governed: false, visibility: 'internal', description: 'Department name',
    }, 'tag-def-string-0001');
    check('D10', dupNew.status === 409 && dupNew.json.error.code === 'TAG_DEFINITION_EXISTS'
      && replayDef.status === 201 && replayDef.json.data.created_at === stringDef.json.data.created_at
      && replayDef.json.meta.request_id !== stringDef.json.meta.request_id);
    const hiddenList = await call(api.base, 'GET', '/v1/tag-definitions', keyEdit.api_key);
    const openList = await call(api.base, 'GET', '/v1/tag-definitions', keyA.api_key);
    check('D11', hiddenList.status === 200
      && !hiddenList.json.data.some((item) => item.visibility === 'restricted' || item.key === 'risk')
      && hiddenList.json.meta.total === undefined
      && !hiddenList.text.includes('"risk"')
      && openList.json.data.some((item) => item.namespace === 'security' && item.key === 'risk'));
    const hiddenGet = await call(api.base, 'GET', '/v1/tag-definitions/security/risk', keyEdit.api_key);
    const missingGet = await call(api.base, 'GET', '/v1/tag-definitions/department/missing', keyEdit.api_key);
    check('D12', hiddenGet.status === 404 && missingGet.status === 404
      && hiddenGet.json.error.code === 'TAG_DEFINITION_NOT_FOUND'
      && hiddenGet.json.error.code === missingGet.json.error.code
      && hiddenGet.json.error.message === missingGet.json.error.message
      && !hiddenGet.text.includes('low'));

    let ceilingRejected = false;
    try {
      loadConfig({
        ...process.env,
        NODE_ENV: 'development',
        FAD_BIND_HOST: '127.0.0.1',
        FAD_INGRESS_TLS: 'cleartext',
        FAD_TRUST_PROXY: 'false',
        FAD_TAG_DEFINITIONS_MAX_PER_ORG: '257',
      });
    } catch {
      ceilingRejected = true;
    }
    await superuser.query(
      `INSERT INTO tag_definitions (organization_id, namespace, tag_key, value_type, governed, visibility, description, created_by)
       SELECT $1, 'quota', 'k' || lpad(g::text, 3, '0'), 'string', false, 'internal', '', $2
       FROM generate_series(0, 254) AS g`,
      [orgQ.id, quotaP.id],
    );
    const burst = await Promise.all(Array.from({ length: 8 }, (_, i) => define({
      namespace: 'quota', key: `h${i}`, value_type: 'string', governed: false, visibility: 'internal',
    }, `tag-def-quota-${i}-001`, keyQ.api_key)));
    const quotaCount = await count(superuser, 'SELECT count(*)::int AS n FROM tag_definitions WHERE organization_id = $1', [orgQ.id]);
    check('D13', ceilingRejected && burst.filter((item) => item.status === 201).length === 1
      && burst.filter((item) => item.status === 422).length === 7 && quotaCount === 256);

    const put = (id, namespace, key, body, headers, token = keyA.api_key) => call(
      api.base, 'PUT', `/v1/agents/${id}/tags/${namespace}/${key}`, token, body, headers,
    );
    const assigned = await put(agentId, 'department', 'name', { value: 'finance' }, {
      'idempotency-key': 'tag-put-create-0001', 'if-none-match': '*',
    });
    const agentAfter = await call(api.base, 'GET', `/v1/agents/${agentId}`, keyA.api_key);
    check('A01', assigned.status === 201 && assigned.headers.etag === '"tag-v1"'
      && assigned.json.data.value === 'finance' && assigned.json.data.revision === 1
      && agentAfter.headers.etag === '"agent-v4"');
    const updated = await put(agentId, 'department', 'name', { value: 'treasury' }, {
      'idempotency-key': 'tag-put-update-0001', 'if-match': '"tag-v1"',
    });
    check('A02', updated.status === 200 && updated.headers.etag === '"tag-v2"' && updated.json.data.revision === 2);
    const readTag = await call(api.base, 'GET', `/v1/agents/${agentId}/tags/department/name`, keyA.api_key);
    const agentStill = await call(api.base, 'GET', `/v1/agents/${agentId}`, keyA.api_key);
    check('A03', readTag.status === 200 && readTag.json.data.value === 'treasury' && readTag.headers.etag === '"tag-v2"'
      && readTag.json.data.created_by === actor.id && agentStill.headers.etag === agentAfter.headers.etag
      && agentStill.json.data.revision === agentAfter.json.data.revision);
    const putFalse = await put(agentId, 'billing', 'active', { value: false }, {
      'idempotency-key': 'tag-put-false-0001', 'if-none-match': '*',
    });
    const putZero = await put(agentId, 'billing', 'count', { value: 0 }, {
      'idempotency-key': 'tag-put-zero-00001', 'if-none-match': '*',
    });
    const gotFalse = await call(api.base, 'GET', `/v1/agents/${agentId}/tags/billing/active`, keyA.api_key);
    const gotZero = await call(api.base, 'GET', `/v1/agents/${agentId}/tags/billing/count`, keyA.api_key);
    check('A04', putFalse.status === 201 && putFalse.json.data.value === false && gotFalse.json.data.value === false
      && putZero.status === 201 && putZero.json.data.value === 0 && gotZero.json.data.value === 0);
    const badValues = [];
    for (const [value, idem] of [
      ['', 'tag-put-empty-00001'],
      [null, 'tag-put-null-000001'],
      [[], 'tag-put-array-00001'],
      [{}, 'tag-put-object-0001'],
      ['bad\u0001', 'tag-put-control-001'],
      ['x'.repeat(129), 'tag-put-long-000001'],
      ['e\u0301', 'tag-put-nfc-0000001'],
    ]) {
      badValues.push(await put(agentId, 'department', 'name', { value }, {
        'idempotency-key': idem, 'if-match': '"tag-v2"',
      }));
    }
    check('A05', badValues.every((item) => item.status === 422) && badValues.every((item) => item.json.error.code === 'VALIDATION_ERROR'));
    const badInts = [];
    for (const [value, idem] of [
      [1.5, 'tag-put-float-00001'],
      [1e10, 'tag-put-exp-0000001'],
      ['1', 'tag-put-string-int01'],
      [true, 'tag-put-bool-int001'],
    ]) {
      badInts.push(await put(agentId, 'billing', 'count', { value }, {
        'idempotency-key': idem, 'if-match': '"tag-v1"',
      }));
    }
    check('A06', badInts.every((item) => item.status === 422));
    const badEnum = await put(agentId, 'billing', 'tier', { value: 'Low' }, {
      'idempotency-key': 'tag-put-enum-case01', 'if-none-match': '*',
    });
    check('A07', badEnum.status === 422);
    const missingPre = await put(agentId, 'department', 'name', { value: 'finance' }, { 'idempotency-key': 'tag-put-nopre-0001' });
    const bothPre = await put(agentId, 'department', 'name', { value: 'finance' }, {
      'idempotency-key': 'tag-put-both-00001', 'if-match': '"tag-v2"', 'if-none-match': '*',
    });
    const weakPre = await put(agentId, 'department', 'name', { value: 'finance' }, {
      'idempotency-key': 'tag-put-weak-00001', 'if-match': 'W/"tag-v2"',
    });
    const wildPre = await put(agentId, 'department', 'name', { value: 'finance' }, {
      'idempotency-key': 'tag-put-wild-00001', 'if-match': '*',
    });
    check('A08', missingPre.status === 428 && missingPre.json.error.code === 'PRECONDITION_REQUIRED'
      && [bothPre, weakPre, wildPre].every((item) => item.status === 400));
    const absentMatch = await put(agentId, 'billing', 'tier', { value: 'low' }, {
      'idempotency-key': 'tag-put-absent-0001', 'if-match': '"tag-v1"',
    });
    const presentStar = await put(agentId, 'department', 'name', { value: 'finance' }, {
      'idempotency-key': 'tag-put-star-000001', 'if-none-match': '*',
    });
    check('A09', absentMatch.status === 412 && presentStar.status === 412);
    const beforeHistory = await count(superuser, `SELECT count(*)::int AS n FROM agent_tag_assignment_revisions WHERE organization_id = $1 AND agent_id = $2 AND namespace = 'department' AND tag_key = 'name'`, [orgA.id, agentId]);
    const beforeAudit = await count(superuser, `SELECT count(*)::int AS n FROM audit_events WHERE organization_id = $1 AND action = 'agent_tag.updated' AND target_id = $2`, [orgA.id, `${agentId}/department/name`]);
    const noop = await put(agentId, 'department', 'name', { value: 'treasury' }, {
      'idempotency-key': 'tag-put-noop-000001', 'if-match': '"tag-v2"',
    });
    const afterHistory = await count(superuser, `SELECT count(*)::int AS n FROM agent_tag_assignment_revisions WHERE organization_id = $1 AND agent_id = $2 AND namespace = 'department' AND tag_key = 'name'`, [orgA.id, agentId]);
    const afterAudit = await count(superuser, `SELECT count(*)::int AS n FROM audit_events WHERE organization_id = $1 AND action = 'agent_tag.updated' AND target_id = $2`, [orgA.id, `${agentId}/department/name`]);
    check('A10', noop.status === 200 && noop.headers.etag === '"tag-v2"' && afterHistory === beforeHistory && afterAudit === beforeAudit);
    const govDenied = await put(agentId, 'security', 'risk', { value: 'low', reason: 'Editor attempt' }, {
      'idempotency-key': 'tag-put-gov-deny01', 'if-none-match': '*',
    }, keyEdit.api_key);
    const govNoReason = await put(agentId, 'security', 'risk', { value: 'low' }, {
      'idempotency-key': 'tag-put-gov-noreas', 'if-none-match': '*',
    });
    check('A11', govDenied.status === 403 && govNoReason.status === 422);
    const govPut = await put(agentId, 'security', 'risk', { value: 'high', reason: 'Initial classification' }, {
      'idempotency-key': 'tag-put-gov-ok0001', 'if-none-match': '*',
    });
    const govDeleteBare = await call(api.base, 'DELETE', `/v1/agents/${agentId}/tags/security/risk`, keyA.api_key, undefined, {
      'idempotency-key': 'tag-del-gov-noreas', 'if-match': govPut.headers.etag,
    });
    const normalDelete = await call(api.base, 'DELETE', `/v1/agents/${agentId}/tags/billing/tier`, keyA.api_key, undefined, {
      'idempotency-key': 'tag-del-missing-001', 'if-match': '"tag-v1"',
    });
    const activeDelete = await call(api.base, 'DELETE', `/v1/agents/${agentId}/tags/billing/active`, keyA.api_key, undefined, {
      'idempotency-key': 'tag-del-active-0001', 'if-match': '"tag-v1"',
    });
    check('A12', govPut.status === 201 && govDeleteBare.status === 422 && normalDelete.status === 404 && activeDelete.status === 204 && activeDelete.text === '');
    const staleDelete = await call(api.base, 'DELETE', `/v1/agents/${agentId}/tags/department/name`, keyA.api_key, undefined, {
      'idempotency-key': 'tag-del-stale-0001', 'if-match': '"tag-v1"',
    });
    const noDeleteMatch = await call(api.base, 'DELETE', `/v1/agents/${agentId}/tags/department/name`, keyA.api_key, undefined, {
      'idempotency-key': 'tag-del-nomatch-01',
    });
    const absentDelete = await call(api.base, 'DELETE', `/v1/agents/${agentId}/tags/billing/active`, keyA.api_key, undefined, {
      'idempotency-key': 'tag-del-absent-001', 'if-match': '"tag-v2"',
    });
    check('A13', staleDelete.status === 412 && noDeleteMatch.status === 428 && absentDelete.status === 404);
    const deleted = await call(api.base, 'DELETE', `/v1/agents/${agentId}/tags/department/name`, keyA.api_key, undefined, {
      'idempotency-key': 'tag-del-name-00001', 'if-match': '"tag-v2"',
    });
    const recreated = await put(agentId, 'department', 'name', { value: 'finance' }, {
      'idempotency-key': 'tag-put-recreate01', 'if-none-match': '*',
    });
    const staleOld = await put(agentId, 'department', 'name', { value: 'audit' }, {
      'idempotency-key': 'tag-put-stale-old1', 'if-match': '"tag-v1"',
    });
    const tombRevision = await superuser.query(
      `SELECT revision, is_deleted FROM agent_tag_assignments WHERE organization_id = $1 AND agent_id = $2 AND namespace = 'department' AND tag_key = 'name'`,
      [orgA.id, agentId],
    );
    check('A14', deleted.status === 204 && recreated.status === 201 && recreated.json.data.revision > 2
      && staleOld.status === 412 && tombRevision.rows[0].is_deleted === false && Number(tombRevision.rows[0].revision) === recreated.json.data.revision);
    const retireAgent = await call(api.base, 'POST', '/v1/agents', keyA.api_key, {
      name: 'Retiring Agent', owner_principal_id: owner.id,
    }, { 'idempotency-key': 'tag-agent-retire-001' });
    const retireId = retireAgent.json.data.id;
    const retired = await call(api.base, 'POST', `/v1/agents/${retireId}/retire`, keyA.api_key, {
      reason: 'End of life',
    }, { 'idempotency-key': 'tag-retire-agent01', 'if-match': '"agent-v1"' });
    const retiredPut = await put(retireId, 'department', 'name', { value: 'finance' }, {
      'idempotency-key': 'tag-put-retired001', 'if-none-match': '*',
    });
    const suspendedAgent = await call(api.base, 'POST', '/v1/agents', keyA.api_key, {
      name: 'Suspended Agent', owner_principal_id: owner.id,
    }, { 'idempotency-key': 'tag-agent-susp-0001' });
    const suspId = suspendedAgent.json.data.id;
    await call(api.base, 'POST', `/v1/agents/${suspId}/suspend`, keyA.api_key, {
      reason: 'Pause',
    }, { 'idempotency-key': 'tag-susp-agent0001', 'if-match': '"agent-v1"' });
    const suspPut = await put(suspId, 'department', 'name', { value: 'finance' }, {
      'idempotency-key': 'tag-put-susp-00001', 'if-none-match': '*',
    });
    check('A15', retired.status === 200 && retiredPut.status === 409 && retiredPut.json.error.code === 'INVALID_AGENT_STATE'
      && suspPut.status === 201);
    const existingActive = await count(superuser, `SELECT count(*)::int AS n FROM agent_tag_assignments WHERE organization_id = $1 AND agent_id = $2 AND is_deleted = false`, [orgA.id, agentId]);
    const fill = 63 - existingActive;
    if (fill < 1) throw new Error(`quota prefill has no room: ${existingActive}`);
    await superuser.query(
      `INSERT INTO tag_definitions (organization_id, namespace, tag_key, value_type, governed, visibility, description, created_by)
       SELECT $1, 'cap', 't' || lpad(g::text, 2, '0'), 'string', false, 'internal', '', $2
       FROM generate_series(0, $3) AS g`,
      [orgA.id, actor.id, fill - 1],
    );
    await superuser.query(
      `INSERT INTO agent_tag_assignments (organization_id, agent_id, namespace, tag_key, tag_value, is_deleted, revision, created_by, updated_by)
       SELECT $1, $2, 'cap', 't' || lpad(g::text, 2, '0'), to_jsonb('v'::text), false, 1, $3, $3
       FROM generate_series(0, $4) AS g`,
      [orgA.id, agentId, actor.id, fill - 1],
    );
    for (let i = 0; i < 8; i += 1) {
      const made = await define({ namespace: 'cap', key: `p${i}`, value_type: 'string', governed: false, visibility: 'internal' }, `tag-def-cap-p${i}-001`);
      if (made.status !== 201) throw new Error(`cap def ${i} ${made.status}`);
    }
    const capBurst = await Promise.all(Array.from({ length: 8 }, (_, i) => put(agentId, 'cap', `p${i}`, { value: 'v' }, {
      'idempotency-key': `tag-put-cap-${i}-0001`, 'if-none-match': '*',
    })));
    const activeCount = await count(superuser, `SELECT count(*)::int AS n FROM agent_tag_assignments WHERE organization_id = $1 AND agent_id = $2 AND is_deleted = false`, [orgA.id, agentId]);
    check('A16', capBurst.filter((item) => item.status === 201).length === 1
      && capBurst.filter((item) => item.status === 422).length === 7 && activeCount === 64);
    const tagList = await call(api.base, 'GET', `/v1/agents/${agentId}/tags`, keyEdit.api_key);
    check('A17', tagList.status === 200
      && tagList.json.data.every((item) => item.visibility !== 'restricted')
      && !tagList.json.data.some((item) => item.namespace === 'billing' && item.key === 'active')
      && !tagList.text.includes('"risk"'));

    const ownA = await call(api.base, 'GET', '/v1/tag-definitions/department/name', keyA.api_key);
    const ownB = await call(api.base, 'GET', '/v1/tag-definitions/department/name', keyB.api_key);
    await define({
      namespace: 'billing', key: 'foreign', value_type: 'string', governed: false, visibility: 'internal', description: 'org b only',
    }, 'tag-def-b-only-0001', keyB.api_key);
    const crossOnly = await call(api.base, 'GET', '/v1/tag-definitions/billing/foreign', keyA.api_key);
    const crossMissing = await call(api.base, 'GET', '/v1/tag-definitions/billing/absent', keyA.api_key);
    check('S01', ownA.status === 200 && ownA.json.data.organization_id === orgA.id && ownA.json.data.created_by === actor.id
      && ownB.status === 200 && ownB.json.data.organization_id === orgB.id && ownB.json.data.created_by === actorB.id
      && !ownA.text.includes(orgB.id) && !ownB.text.includes(actor.id)
      && crossOnly.status === 404 && crossMissing.status === 404
      && crossOnly.json.error.message === crossMissing.json.error.message
      && !crossOnly.text.includes('org b only'));
    const crossPut = await put(agentId, 'department', 'name', { value: 'finance' }, {
      'idempotency-key': 'tag-put-cross-0001', 'if-none-match': '*',
    }, keyB.api_key);
    const missingAgent = '11111111-1111-4111-8111-111111111111';
    const crossMissingAgent = await put(missingAgent, 'department', 'name', { value: 'finance' }, {
      'idempotency-key': 'tag-put-missing-ag1', 'if-none-match': '*',
    }, keyB.api_key);
    check('S02', crossPut.status === 404 && crossMissingAgent.status === 404
      && crossPut.json.error.code === 'AGENT_NOT_FOUND' && crossPut.json.error.code === crossMissingAgent.json.error.code);
    const searchA = await call(api.base, 'POST', '/v1/agents/search', keyA.api_key, {
      tags: [{ namespace: 'department', key: 'name', operator: 'eq', value: 'finance' }],
    });
    const searchB = await call(api.base, 'POST', '/v1/agents/search', keyB.api_key, {
      tags: [{ namespace: 'department', key: 'name', operator: 'eq', value: 'finance' }],
    });
    check('S03', searchA.status === 200 && searchA.json.data.some((item) => item.id === agentId)
      && searchB.status === 200 && !searchB.json.data.some((item) => item.id === agentId));
    const bare = await app.query('SELECT count(*)::int AS n FROM tag_definitions');
    let bareInsert = '';
    try {
      await app.query('BEGIN');
      await app.query(
        `INSERT INTO tag_definitions (organization_id, namespace, tag_key, value_type, governed, visibility, description, created_by)
         VALUES ($1, 'department', 'stolen', 'string', false, 'internal', '', $2)`,
        [orgA.id, actor.id],
      );
      await app.query('COMMIT');
      bareInsert = 'committed';
    } catch (err) {
      bareInsert = err.code || 'error';
      await app.query('ROLLBACK').catch(() => undefined);
    }
    check('S04', bare.rows[0].n === 0 && bareInsert !== 'committed');
    const spoof = await call(api.base, 'POST', '/v1/tag-definitions', keyA.api_key, {
      namespace: 'department', key: 'spoof', value_type: 'string', governed: false, visibility: 'internal', organization_id: orgB.id,
    }, { 'idempotency-key': 'tag-def-spoof-0001', 'x-organization-id': orgB.id });
    check('S05', spoof.status === 422);
    let fk = '';
    try {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('fad.org_id', $1, true)`, [orgA.id]);
      await app.query(
        `INSERT INTO agent_tag_assignments (organization_id, agent_id, namespace, tag_key, tag_value, is_deleted, revision, created_by, updated_by)
         VALUES ($1, $2, 'department', 'name', '"x"'::jsonb, false, 1, $3, $3)`,
        [orgA.id, missingAgent, actor.id],
      );
      await app.query('COMMIT');
      fk = 'committed';
    } catch (err) {
      fk = err.code || 'error';
      await app.query('ROLLBACK').catch(() => undefined);
    }
    check('S06', fk === '23503');
    const priv = await superuser.query(`
      SELECT r.rolbypassrls, r.rolsuper,
        has_table_privilege('fad_app', 'tag_definitions', 'DELETE') AS def_delete,
        has_table_privilege('fad_app', 'tag_definitions', 'UPDATE') AS def_update,
        has_table_privilege('fad_app', 'agent_tag_assignment_revisions', 'UPDATE') AS hist_update,
        has_table_privilege('fad_app', 'agent_tag_assignment_revisions', 'DELETE') AS hist_delete,
        has_table_privilege('fad_app', 'agent_tag_assignments', 'DELETE') AS asg_delete
      FROM pg_roles r WHERE r.rolname = 'fad_app'`);
    const row = priv.rows[0];
    check('S07', row.rolbypassrls === false && row.rolsuper === false && row.def_delete === false
      && row.def_update === false && row.hist_update === false && row.hist_delete === false && row.asg_delete === false);
    check('S08', govDenied.status === 403);
    const restrictedRead = await call(api.base, 'GET', `/v1/agents/${agentId}/tags/security/risk`, keyEdit.api_key);
    const absentRead = await call(api.base, 'GET', `/v1/agents/${agentId}/tags/security/missing`, keyEdit.api_key);
    check('S09', restrictedRead.status === 404 && absentRead.status === 404
      && restrictedRead.json.error.code === absentRead.json.error.code && !restrictedRead.text.includes('high'));
    const restrictedSearch = await call(api.base, 'POST', '/v1/agents/search', keyEdit.api_key, {
      tags: [{ namespace: 'security', key: 'risk', operator: 'eq', value: 'high' }],
    });
    check('S10', restrictedSearch.status === 403 && restrictedSearch.json.error.code === 'FORBIDDEN'
      && restrictedSearch.json.data === undefined && !restrictedSearch.text.includes(createdAgent.json.data.name));
    const writerPut = await put(suspId, 'billing', 'count', { value: 0 }, {
      'idempotency-key': 'tag-put-writer-001', 'if-none-match': '*',
    }, keyWrite.api_key);
    const writerPatch = await call(api.base, 'PATCH', `/v1/agents/${suspId}`, keyWrite.api_key, {
      description: 'should fail',
    }, { 'idempotency-key': 'tag-writer-patch01', 'if-match': '"agent-v2"' });
    check('S11', writerPut.status === 201 && writerPatch.status === 403);
    const ownerPut = await put(agentId, 'billing', 'count', { value: 1 }, {
      'idempotency-key': 'tag-put-owner-0001', 'if-match': '"tag-v1"',
    }, keyOwner.api_key);
    check('S12', ownerPut.status === 403 && ownerOnly.id === createdAgent.json.data.owner_principal_id);
    const badKey = await call(api.base, 'GET', '/v1/tag-definitions', 'fad_live.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.not-a-real-secret');
    await admin(['credential', 'revoke', '--organization-id', orgT.id, '--kid', keyAuth.kid, '--reason', 'Rotate the key']);
    const revoked = await call(api.base, 'GET', '/v1/tag-definitions', keyAuth.api_key);
    const expiring = await issued(orgT.id, tombP.id, FULL);
    secrets.push(expiring.api_key);
    await superuser.query(
      `UPDATE api_credentials
       SET created_at = timestamptz '2000-01-01T00:00:00Z',
           expires_at = timestamptz '2000-01-01T00:00:01Z'
       WHERE kid = $1`,
      [expiring.kid],
    );
    const expired = await call(api.base, 'GET', '/v1/tag-definitions', expiring.api_key);
    await admin(['principal', 'disable', '--organization-id', orgT.id, '--principal-id', authP.id, '--reason', 'Disable the actor']);
    const disabledKey = await issued(orgT.id, authP.id, FULL);
    secrets.push(disabledKey.api_key);
    const disabled = await call(api.base, 'GET', '/v1/organizations/current', disabledKey.api_key);
    await admin(['organization', 'suspend', '--organization-id', orgT.id, '--reason', 'Suspend the organization']);
    const suspendedOrg = await call(api.base, 'GET', '/v1/tag-definitions', keyT.api_key);
    check('S13', badKey.status === 401 && revoked.status === 401 && expired.status === 401
      && disabled.status === 401 && suspendedOrg.status === 401
      && [badKey, revoked, expired, disabled, suspendedOrg].every((item) => item.json.error.code === 'UNAUTHORIZED'));

    const raceAgent = await call(api.base, 'POST', '/v1/agents', keyA.api_key, {
      name: 'Race Agent', owner_principal_id: owner.id,
    }, { 'idempotency-key': 'tag-agent-race-0001' });
    const raceId = raceAgent.json.data.id;
    const race = await Promise.all([0, 1].map((i) => put(raceId, 'department', 'name', { value: 'finance' }, {
      'idempotency-key': `tag-put-race-${i}-0001`, 'if-none-match': '*',
    })));
    const raceHistory = await count(superuser, `SELECT count(*)::int AS n FROM agent_tag_assignment_revisions WHERE agent_id = $1 AND namespace = 'department' AND tag_key = 'name'`, [raceId]);
    check('R01', race.filter((item) => item.status === 201).length === 1 && race.filter((item) => item.status === 412).length === 1 && raceHistory === 1);
    const raceUpdate = await Promise.all([0, 1].map((i) => put(raceId, 'department', 'name', { value: i === 0 ? 'alpha' : 'beta' }, {
      'idempotency-key': `tag-put-race-u${i}-001`, 'if-match': '"tag-v1"',
    })));
    const raceRev = await superuser.query(`SELECT revision FROM agent_tag_assignments WHERE agent_id = $1 AND namespace = 'department' AND tag_key = 'name'`, [raceId]);
    check('R02', raceUpdate.filter((item) => item.status === 200).length === 1
      && raceUpdate.filter((item) => item.status === 412).length === 1 && Number(raceRev.rows[0].revision) === 2);
    const winnerIndex = raceUpdate.findIndex((item) => item.status === 200);
    const winnerKey = winnerIndex === 0 ? 'tag-put-race-u0-001' : 'tag-put-race-u1-001';
    const winner = raceUpdate[winnerIndex];
    const replayed = await put(raceId, 'department', 'name', { value: winner.json.data.value }, {
      'idempotency-key': winnerKey,
      'if-match': '"tag-v1"',
    });
    check('R03', replayed.status === 200 && replayed.json.data.revision === winner.json.data.revision
      && replayed.json.meta.request_id !== winner.json.meta.request_id);
    const conflictBody = await put(raceId, 'department', 'name', { value: 'other' }, {
      'idempotency-key': winnerKey, 'if-match': '"tag-v1"',
    });
    check('R04', conflictBody.status === 409 && conflictBody.json.error.code === 'IDEMPOTENCY_CONFLICT');
    const conflictHeader = await put(raceId, 'department', 'name', { value: winner.json.data.value }, {
      'idempotency-key': winnerKey,
      'if-match': '"tag-v9"',
    });
    check('R05', conflictHeader.status === 409);
    const retryAgent = await call(api.base, 'POST', '/v1/agents', keyA.api_key, {
      name: 'Retry Agent', owner_principal_id: owner.id,
    }, { 'idempotency-key': 'tag-agent-retry-001' });
    const retryId = retryAgent.json.data.id;
    const retries = await Promise.all([0, 1].map(() => put(retryId, 'billing', 'active', { value: false }, {
      'idempotency-key': 'tag-put-retry-same1', 'if-none-match': '*',
    })));
    const retryHistory = await count(superuser, `SELECT count(*)::int AS n FROM agent_tag_assignment_revisions WHERE agent_id = $1 AND namespace = 'billing' AND tag_key = 'active'`, [retryId]);
    const retryAudit = await count(superuser, `SELECT count(*)::int AS n FROM audit_events WHERE action = 'agent_tag.assigned' AND target_id = $1`, [`${retryId}/billing/active`]);
    check('R06', retries.every((item) => item.status === 201) && retries[0].json.data.revision === retries[1].json.data.revision
      && retryHistory === 1 && retryAudit === 1);
    const later = await put(retryId, 'billing', 'active', { value: true }, {
      'idempotency-key': 'tag-put-retry-later', 'if-match': '"tag-v1"',
    });
    const originalReplay = await put(retryId, 'billing', 'active', { value: false }, {
      'idempotency-key': 'tag-put-retry-same1', 'if-none-match': '*',
    });
    const currentTag = await call(api.base, 'GET', `/v1/agents/${retryId}/tags/billing/active`, keyA.api_key);
    check('R07', later.status === 200 && later.json.data.value === true
      && originalReplay.status === 201 && originalReplay.json.data.value === false && originalReplay.json.data.revision === 1
      && currentTag.json.data.value === true && currentTag.json.data.revision === 2);
    await superuser.query(`
      CREATE OR REPLACE FUNCTION fad_s2_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN RAISE EXCEPTION 'audit failed' USING ERRCODE = 'P0001'; END; $fn$`);
    await superuser.query(`CREATE TRIGGER fad_s2_audit_fail BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fad_s2_audit_fail()`);
    let auditPut;
    try {
      auditPut = await put(retryId, 'billing', 'count', { value: 0 }, {
        'idempotency-key': 'tag-put-audit-fail1', 'if-none-match': '*',
      });
    } finally {
      await superuser.query('DROP TRIGGER IF EXISTS fad_s2_audit_fail ON audit_events');
      await superuser.query('DROP FUNCTION IF EXISTS fad_s2_audit_fail()');
    }
    const auditRow = await count(superuser, `SELECT count(*)::int AS n FROM agent_tag_assignments WHERE agent_id = $1 AND namespace = 'billing' AND tag_key = 'count'`, [retryId]);
    check('R08', auditPut.status === 500 && auditRow === 0);
    await app.query('BEGIN');
    await app.query(`SELECT set_config('fad.org_id', $1, true)`, [orgA.id]);
    await app.query(
      `INSERT INTO tag_definitions (organization_id, namespace, tag_key, value_type, governed, visibility, description, created_by)
       VALUES ($1, 'department', 'temp', 'string', false, 'internal', '', $2)`,
      [orgA.id, actor.id],
    );
    await app.query('ROLLBACK');
    const tempRow = await count(superuser, `SELECT count(*)::int AS n FROM tag_definitions WHERE organization_id = $1 AND namespace = 'department' AND tag_key = 'temp'`, [orgA.id]);
    check('R09', tempRow === 0);
    const lockAgent = await call(api.base, 'POST', '/v1/agents', keyA.api_key, {
      name: 'Lock Agent', owner_principal_id: owner.id,
    }, { 'idempotency-key': 'tag-agent-lock-0001' });
    const lockId = lockAgent.json.data.id;
    await superuser.query('BEGIN');
    await superuser.query('SELECT id FROM agents WHERE id = $1 FOR UPDATE', [lockId]);
    const blocked = put(lockId, 'department', 'name', { value: 'finance' }, {
      'idempotency-key': 'tag-put-lock-00001', 'if-none-match': '*',
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await superuser.query(`UPDATE agents SET status = 'retired', revision = revision + 1, updated_at = transaction_timestamp() WHERE id = $1`, [lockId]);
    await superuser.query('COMMIT');
    const blockedResult = await blocked;
    const lockRows = await count(superuser, 'SELECT count(*)::int AS n FROM agent_tag_assignments WHERE agent_id = $1', [lockId]);
    check('R10', blockedResult.status === 409 && blockedResult.json.error.code === 'INVALID_AGENT_STATE' && lockRows === 0);

    const durable = await call(api.base, 'GET', `/v1/agents/${agentId}/tags/billing/count`, keyA.api_key);
    await api.stop();
    const restarted = await startApi({
      FAD_TAGS_ENABLED: 'true',
      FAD_HTTP_REQUEST_TIMEOUT_MS: '30000',
      FAD_SHUTDOWN_GRACE_MS: '30000',
      FAD_DB_POOL_MAX: '8',
      FAD_RATE_LIMIT_MAX: '8000',
    });
    const afterRestart = await call(restarted.base, 'GET', `/v1/agents/${agentId}/tags/billing/count`, keyA.api_key);
    check('R11', restarted.ready && afterRestart.status === 200 && afterRestart.json.data.value === 0
      && afterRestart.json.data.revision === durable.json.data.revision);

    const gateName = 'fad_s2_gate';
    const failName = 'fad_s2_fail';
    const maintUrl = new URL(migratorUrl);
    maintUrl.pathname = '/postgres';
    const maint = new Client({ connectionString: maintUrl.toString(), application_name: 'fad-tag-maint' });
    maint.on('error', () => undefined);
    await maint.connect();
    for (const name of [gateName, failName]) {
      await maint.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [name]);
      await maint.query(`DROP DATABASE IF EXISTS ${name}`);
      await maint.query(`CREATE DATABASE ${name}`);
    }
    const gateUrl = new URL(migratorUrl);
    gateUrl.pathname = `/${gateName}`;
    const failUrl = new URL(migratorUrl);
    failUrl.pathname = `/${failName}`;
    const previousDir = mkdtempSync(join(scratch, 's2-prev-'));
    cpSync(migrationsDir, previousDir, { recursive: true });
    rmSync(join(previousDir, '20261021_001_typed_tags.up.sql'));
    // The enforcement trigger is created on agent_tag_assignments. A copy that
    // omits the tags migration cannot apply that later trigger.
    rmSync(join(previousDir, '20261021_006_policy_enforcement.up.sql'));
    await applyMigrations(gateUrl.toString(), previousDir);
    const gate = new Client({ connectionString: gateUrl.toString(), application_name: 'fad-tag-gate' });
    gate.on('error', () => undefined);
    await gate.connect();
    const orgKeep = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    await gate.query(
      `INSERT INTO organizations (id, name, status) VALUES ($1, 'Keep', 'active')`,
      [orgKeep],
    );
    await gate.end();
    const pair = await Promise.all([
      applyMigrations(gateUrl.toString(), migrationsDir),
      applyMigrations(gateUrl.toString(), migrationsDir),
    ]);
    const gateCheck = new Client({ connectionString: gateUrl.toString(), application_name: 'fad-tag-gate-check' });
    gateCheck.on('error', () => undefined);
    await gateCheck.connect();
    const kept = await gateCheck.query('SELECT name FROM organizations WHERE id = $1', [orgKeep]);
    const tagChecksums = await gateCheck.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE version = '20261021_001_typed_tags'`);
    const tagTable = await gateCheck.query(`SELECT to_regclass('public.tag_definitions') AS t`);
    await gateCheck.end();
    await applyMigrations(failUrl.toString(), previousDir);
    const failSeed = new Client({ connectionString: failUrl.toString(), application_name: 'fad-tag-fail-seed' });
    failSeed.on('error', () => undefined);
    await failSeed.connect();
    await failSeed.query(`INSERT INTO organizations (id, name, status) VALUES ($1, 'Keep', 'active')`, [orgKeep]);
    await failSeed.end();
    const badDir = mkdtempSync(join(scratch, 's2-bad-'));
    cpSync(migrationsDir, badDir, { recursive: true });
    writeFileSync(join(badDir, '20261022_001_bad.up.sql'), 'CREATE TABLE fad_s2_should_not_exist (id int);\nSELECT 1/0;\n');
    let failed = false;
    try {
      await applyMigrations(failUrl.toString(), badDir);
    } catch {
      failed = true;
    }
    const failCheck = new Client({ connectionString: failUrl.toString(), application_name: 'fad-tag-fail-check' });
    failCheck.on('error', () => undefined);
    await failCheck.connect();
    const failOrg = await failCheck.query('SELECT count(*)::int AS n FROM organizations WHERE id = $1', [orgKeep]);
    const failTag = await failCheck.query(`SELECT to_regclass('public.tag_definitions') AS t`);
    const failBad = await failCheck.query(`SELECT to_regclass('public.fad_s2_should_not_exist') AS t`);
    const failSum = await failCheck.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE version = '20261022_001_bad'`);
    await failCheck.end();
    const changedDir = mkdtempSync(join(scratch, 's2-changed-'));
    cpSync(migrationsDir, changedDir, { recursive: true });
    writeFileSync(join(changedDir, '20261021_001_typed_tags.up.sql'), `${readFileSync(join(migrationsDir, '20261021_001_typed_tags.up.sql'), 'utf8')}\n`);
    const beforeSum = await superuser.query(`SELECT checksum_sha256 FROM schema_migrations WHERE version = '20261021_001_typed_tags'`);
    let mismatch = false;
    try {
      await applyMigrations(migratorUrl, changedDir);
    } catch (err) {
      mismatch = err.name === 'MigrationChecksumError';
    }
    const afterSum = await superuser.query(`SELECT checksum_sha256 FROM schema_migrations WHERE version = '20261021_001_typed_tags'`);
    await maint.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ANY($1) AND pid <> pg_backend_pid()', [[gateName, failName]]);
    await maint.query(`DROP DATABASE IF EXISTS ${gateName}`);
    await maint.query(`DROP DATABASE IF EXISTS ${failName}`);
    await maint.end();
    check('R12', pair.every((item) => item.applied.includes('20261021_001_typed_tags') || item.skipped.includes('20261021_001_typed_tags'))
      && kept.rows[0].name === 'Keep' && tagChecksums.rows[0].n === 1 && tagTable.rows[0].t === 'tag_definitions'
      && failed && failOrg.rows[0].n === 1 && failTag.rows[0].t === null && failBad.rows[0].t === null && failSum.rows[0].n === 0
      && mismatch && beforeSum.rows[0].checksum_sha256 === afterSum.rows[0].checksum_sha256 && beforeSum.rows[0].checksum_sha256.length === 64);
    writeEvidence('migration-checksum.txt', `${beforeSum.rows[0].checksum_sha256}\n`, secrets);

    const other = await call(restarted.base, 'POST', '/v1/agents', keyA.api_key, {
      name: 'Other Agent', owner_principal_id: owner.id,
    }, { 'idempotency-key': 'tag-agent-other-001' });
    const otherId = other.json.data.id;
    await putOn(restarted.base, otherId, 'department', 'name', 'finance');
    await putOn(restarted.base, otherId, 'billing', 'active', false);
    const retiredSearchAgent = await call(restarted.base, 'POST', '/v1/agents', keyA.api_key, {
      name: 'Retired Search', owner_principal_id: owner.id,
    }, { 'idempotency-key': 'tag-agent-rsearch01' });
    await putOn(restarted.base, retiredSearchAgent.json.data.id, 'department', 'name', 'finance');
    await call(restarted.base, 'POST', `/v1/agents/${retiredSearchAgent.json.data.id}/retire`, keyA.api_key, {
      reason: 'Done',
    }, { 'idempotency-key': 'tag-rsearch-retire1', 'if-match': '"agent-v1"' });
    const andSearch = await call(restarted.base, 'POST', '/v1/agents/search', keyA.api_key, {
      status: 'active',
      tags: [
        { namespace: 'department', key: 'name', operator: 'eq', value: 'finance' },
        { namespace: 'billing', key: 'active', operator: 'eq', value: false },
      ],
    });
    check('Q01', andSearch.status === 200 && andSearch.json.data.some((item) => item.id === otherId)
      && !andSearch.json.data.some((item) => item.id === agentId || item.id === retiredSearchAgent.json.data.id));
    const emptySearch = await call(restarted.base, 'POST', '/v1/agents/search', keyA.api_key, {});
    const zeroTags = await call(restarted.base, 'POST', '/v1/agents/search', keyA.api_key, { tags: [] });
    const tooMany = await call(restarted.base, 'POST', '/v1/agents/search', keyA.api_key, {
      tags: Array.from({ length: 9 }, (_, i) => ({ namespace: 'department', key: 'name', operator: 'eq', value: `v${i}` })),
    });
    const duplicatePred = await call(restarted.base, 'POST', '/v1/agents/search', keyA.api_key, {
      tags: [
        { namespace: 'department', key: 'name', operator: 'eq', value: 'finance' },
        { namespace: 'department', key: 'name', operator: 'eq', value: 'treasury' },
      ],
    });
    const onePred = await call(restarted.base, 'POST', '/v1/agents/search', keyA.api_key, {
      tags: [{ namespace: 'department', key: 'name', operator: 'eq', value: 'finance' }],
    });
    check('Q02', emptySearch.status === 422 && zeroTags.status === 422 && tooMany.status === 422
      && duplicatePred.status === 422 && onePred.status === 200);
    const unknownPred = await call(restarted.base, 'POST', '/v1/agents/search', keyA.api_key, {
      tags: [{ namespace: 'department', key: 'missing', operator: 'eq', value: 'finance' }],
    });
    const wrongType = await call(restarted.base, 'POST', '/v1/agents/search', keyA.api_key, {
      tags: [{ namespace: 'billing', key: 'count', operator: 'eq', value: '0' }],
    });
    const badOp = await call(restarted.base, 'POST', '/v1/agents/search', keyA.api_key, {
      tags: [{ namespace: 'department', key: 'name', operator: 'neq', value: 'finance' }],
    });
    check('Q03', unknownPred.status === 422 && wrongType.status === 422 && badOp.status === 422);
    const page1 = await call(restarted.base, 'POST', '/v1/agents/search', keyA.api_key, { status: 'active', limit: 1 });
    const page2 = await call(restarted.base, 'POST', '/v1/agents/search', keyA.api_key, {
      status: 'active', limit: 1, cursor: page1.json.meta.next_cursor,
    });
    const ids = [...page1.json.data, ...page2.json.data].map((item) => item.id);
    check('Q04', page1.status === 200 && page1.json.data.length === 1 && page1.json.meta.next_cursor
      && page2.status === 200 && page2.json.data.length === 1 && ids[0] !== ids[1]);
    const foreignCursor = await call(restarted.base, 'POST', '/v1/agents/search', keyB.api_key, {
      status: 'active', limit: 1, cursor: page1.json.meta.next_cursor,
    });
    const changedFilter = await call(restarted.base, 'POST', '/v1/agents/search', keyA.api_key, {
      status: 'suspended', limit: 1, cursor: page1.json.meta.next_cursor,
    });
    const restrictedCursor = await call(restarted.base, 'POST', '/v1/agents/search', keyA.api_key, {
      status: 'active', limit: 1, cursor: page1.json.meta.next_cursor,
    });
    const editorCursor = await call(restarted.base, 'POST', '/v1/agents/search', keyEdit.api_key, {
      status: 'active', limit: 1, cursor: page1.json.meta.next_cursor,
    });
    const expiredCursor = encodeSearchCursor(Buffer.from(pepper), {
      org: orgA.id,
      filter: searchFilterKey({ tags: null, status: 'active' }),
      restricted: true,
      at: '2026-10-20T00:00:00.000000Z',
      id: agentId,
    }, Date.now() - 25 * 60 * 60 * 1000);
    const expiredSearch = await call(restarted.base, 'POST', '/v1/agents/search', keyA.api_key, {
      status: 'active', limit: 1, cursor: expiredCursor,
    });
    check('Q05', foreignCursor.status === 400 && changedFilter.status === 400
      && (restrictedCursor.status === 200 || editorCursor.status === 400)
      && editorCursor.status === 400 && expiredSearch.status === 400);
    const defPage = await call(restarted.base, 'GET', '/v1/tag-definitions?limit=1', keyEdit.api_key);
    const defPage2 = await call(restarted.base, 'GET', `/v1/tag-definitions?limit=1&cursor=${encodeURIComponent(defPage.json.meta.next_cursor)}`, keyEdit.api_key);
    const defNames = [...defPage.json.data, ...defPage2.json.data].map((item) => `${item.namespace}/${item.key}`);
    check('Q06', defPage.status === 200 && defPage2.status === 200 && defNames[0] < defNames[1]
      && defPage.json.data.every((item) => item.visibility === 'internal')
      && defPage2.json.data.every((item) => item.visibility === 'internal'));
    const built = buildAgentSearchQuery({
      organizationId: orgA.id,
      status: 'active',
      predicates: [{ namespace: 'department', key: 'name', value: 'finance' }],
      cursor: null,
      limit: 5,
    });
    await superuser.query('ANALYZE agent_tag_assignments');
    await superuser.query('ANALYZE agents');
    await superuser.query('BEGIN');
    await superuser.query('SET LOCAL enable_seqscan = off');
    const plan = await superuser.query(`EXPLAIN (FORMAT TEXT) ${built.text}`, built.values);
    await superuser.query('ROLLBACK');
    const planText = plan.rows.map((item) => item['QUERY PLAN']).join('\n');
    writeEvidence('search-plan.txt', planText, secrets);
    check('Q07', built.text.includes('agents.organization_id = $1') && built.values[0] === orgA.id
      && !built.text.includes('finance') && /Index Scan|Bitmap Index Scan/i.test(planText) && planText.includes('agent_tag_match_idx'));
    const reasonToken = 'reason-token-q08-zebra';
    const valueToken = 'value-token-q08-orchid';
    await defineOn(restarted.base, { namespace: 'notes', key: 'text', value_type: 'string', governed: true, visibility: 'restricted' }, 'tag-def-notes-00001');
    await putOn(restarted.base, otherId, 'notes', 'text', valueToken, { reason: reasonToken, match: '*' });
    const logs = restarted.logs();
    check('Q08', !logs.includes(reasonToken) && !logs.includes(valueToken) && !logs.includes(pepper));

    const consumerDir = join(scratch, 'sdk-consumer');
    rmSync(consumerDir, { recursive: true, force: true });
    mkdirSync(consumerDir, { recursive: true });
    writeFileSync(join(consumerDir, 'package.json'), JSON.stringify({
      name: 'fad-slice2-consumer',
      private: true,
      type: 'module',
      dependencies: { '@fad/sdk': `file:${join(process.cwd(), 'packages/sdk')}` },
    }));
    writeFileSync(join(consumerDir, 'main.mjs'), `
      import { FadClient, FadApiError } from '@fad/sdk';
      const client = new FadClient({ baseUrl: process.env.FAD_BASE_URL, apiKey: process.env.FAD_API_KEY, allowInsecureHttp: true, timeoutMs: 10000 });
      const created = await client.tagDefinitions.create({ namespace: 'sdk', key: 'flag', value_type: 'boolean', governed: false, visibility: 'internal' }, { idempotencyKey: 'sdk-def-flag-00001' });
      const counted = await client.tagDefinitions.create({ namespace: 'sdk', key: 'count', value_type: 'integer', governed: false, visibility: 'internal' }, { idempotencyKey: 'sdk-def-count-0001' });
      const listed = await client.tagDefinitions.list({ namespace: 'sdk', limit: 10 });
      const loaded = await client.tagDefinitions.get('sdk', 'flag');
      const flag = await client.agentTags.put(process.env.FAD_AGENT_ID, 'sdk', 'flag', { value: false }, { idempotencyKey: 'sdk-put-false-0001', ifNoneMatch: '*' });
      const zero = await client.agentTags.put(process.env.FAD_AGENT_ID, 'sdk', 'count', { value: 0 }, { idempotencyKey: 'sdk-put-zero-00001', ifNoneMatch: '*' });
      const got = await client.agentTags.get(process.env.FAD_AGENT_ID, 'sdk', 'flag');
      const found = await client.agents.search({ tags: [{ namespace: 'sdk', key: 'flag', operator: 'eq', value: false }] });
      const agent = await client.agents.get(process.env.FAD_AGENT_ID);
      await client.agentTags.delete(process.env.FAD_AGENT_ID, 'sdk', 'flag', { idempotencyKey: 'sdk-del-flag-00001', ifMatch: flag.etag });
      let missing = null;
      try { await client.agentTags.get(process.env.FAD_AGENT_ID, 'sdk', 'flag'); } catch (err) { missing = err; }
      const deniedClient = new FadClient({ baseUrl: process.env.FAD_BASE_URL, apiKey: process.env.FAD_DENY_KEY, allowInsecureHttp: true, timeoutMs: 10000 });
      let denied = null;
      try {
        await deniedClient.agentTags.put(process.env.FAD_AGENT_ID, 'security', 'risk', { value: 'low', reason: 'nope' }, { idempotencyKey: 'sdk-put-deny-00001', ifNoneMatch: '*' });
      } catch (err) { denied = err; }
      const ac = new AbortController();
      ac.abort();
      let aborted = null;
      try { await client.agents.get(process.env.FAD_AGENT_ID, { signal: ac.signal }); } catch (err) { aborted = err; }
      console.log(JSON.stringify({
        created: created.data.key,
        counted: counted.data.value_type,
        listed: listed.data.map((item) => item.key).sort(),
        loaded: loaded.data.namespace,
        flag: flag.data.value,
        zero: zero.data.value,
        etag: flag.etag,
        got: got.data.value,
        found: found.data.some((item) => item.id === process.env.FAD_AGENT_ID),
        agentKeys: Object.keys(agent.data).sort(),
        missing: missing instanceof FadApiError ? missing.status : null,
        denied: denied instanceof FadApiError ? denied.status : null,
        aborted: aborted instanceof Error ? aborted.name : null,
      }));
    `);
    const installed = await import('node:child_process').then(({ spawn }) => new Promise((resolve) => {
      const child = spawn('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: consumerDir });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (code) => resolve({ code: code ?? 1, stderr }));
    }));
    check('sdk-consumer-install', installed.code === 0, installed.stderr.slice(-300));
    const consumed = execFileSync(process.execPath, ['main.mjs'], {
      cwd: consumerDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        FAD_BASE_URL: restarted.base,
        FAD_API_KEY: keyA.api_key,
        FAD_DENY_KEY: keyEdit.api_key,
        FAD_AGENT_ID: otherId,
      },
    });
    writeEvidence('sdk-consumer.json', consumed, secrets);
    const consumer = JSON.parse(consumed);
    check('Q09', consumer.created === 'flag' && consumer.loaded === 'sdk' && consumer.listed.includes('flag') && consumer.listed.includes('count'));
    check('Q10', consumer.etag === '"tag-v1"' && consumer.got === false && consumer.missing === 404);
    check('Q11', consumer.found === true && !consumer.agentKeys.includes('tags') && consumer.agentKeys.includes('revision'));
    const { createServer } = await import('node:net');
    const hang = await new Promise((resolve, reject) => {
      const server = createServer(() => undefined);
      server.listen(0, '127.0.0.1', () => resolve(server));
      server.on('error', reject);
    });
    const hangPort = hang.address().port;
    const { FadClient, FadApiError } = await import('@fad/sdk');
    let timedOut = false;
    try {
      const slow = new FadClient({
        baseUrl: `http://127.0.0.1:${hangPort}`,
        apiKey: 'fad_live.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.secret',
        allowInsecureHttp: true,
        timeoutMs: 200,
        maxGetRetries: 0,
      });
      await slow.health.live();
    } catch (err) {
      timedOut = err.name === 'TimeoutError';
    }
    hang.close();
    check('Q12', consumer.flag === false && consumer.zero === 0 && consumer.denied === 403 && consumer.aborted === 'AbortError' && timedOut);
    const { createServer: createHttpServer } = await import('node:http');
    let q13Attempts = 0;
    const q13Server = createHttpServer((_req, res) => {
      q13Attempts += 1;
      if (q13Attempts < 3) {
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
    const q13Port = await new Promise((resolve, reject) => {
      q13Server.listen(0, '127.0.0.1', () => resolve(q13Server.address().port));
      q13Server.on('error', reject);
    });
    const q13Client = new FadClient({
      baseUrl: `http://127.0.0.1:${q13Port}`,
      apiKey: `fad_live.${'ab'.repeat(16)}.${'A'.repeat(43)}`,
      allowInsecureHttp: true,
      maxGetRetries: 2,
      maxRetryAfterMs: 20,
      timeoutMs: 2000,
    });
    const q13Retried = await q13Client.organizations.current();
    q13Server.removeAllListeners('request');
    let q13Unauth = 0;
    q13Server.on('request', (_req, res) => {
      q13Unauth += 1;
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: { code: 'UNAUTHORIZED', message: 'Invalid or missing API credential.' },
        meta: { request_id: '11111111-1111-4111-8111-111111111111', api_version: 'v1' },
      }));
    });
    let q13Denied = null;
    try {
      await q13Client.organizations.current();
    } catch (err) {
      q13Denied = err;
    }
    q13Server.close();
    check('Q13', q13Retried.data.name === 'Retry' && q13Attempts === 3
      && q13Denied instanceof FadApiError && q13Denied.status === 401 && q13Unauth === 1);

    const oldDir = join(scratch, 'old-sdk');
    rmSync(oldDir, { recursive: true, force: true });
    mkdirSync(join(oldDir, 'src'), { recursive: true });
    writeFileSync(join(oldDir, 'src/index.ts'), execFileSync('git', ['show', '566bf826993bb7d783de6ea080bc0f4a9bc0d139:packages/sdk/src/index.ts']));
    writeFileSync(join(oldDir, 'package.json'), JSON.stringify({ name: 'old-sdk', private: true, type: 'module' }));
    writeFileSync(join(oldDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, outDir: 'dist' },
      include: ['src'],
    }));
    execFileSync(process.execPath, [join(process.cwd(), 'node_modules/typescript/lib/tsc.js'), '-p', join(oldDir, 'tsconfig.json')]);
    writeFileSync(join(oldDir, 'smoke.mjs'), `
      const { FadClient } = await import('./dist/index.js');
      const client = new FadClient({ baseUrl: process.env.FAD_BASE_URL, apiKey: process.env.FAD_API_KEY, allowInsecureHttp: true, timeoutMs: 10000 });
      const agent = await client.agents.get(process.env.FAD_AGENT_ID);
      console.log(JSON.stringify({ id: agent.data.id, etag: agent.etag, revision: agent.data.revision, keys: Object.keys(agent.data).sort() }));
    `);
    const oldOut = execFileSync(process.execPath, ['smoke.mjs'], {
      cwd: oldDir,
      encoding: 'utf8',
      env: { ...process.env, FAD_BASE_URL: restarted.base, FAD_API_KEY: keyA.api_key, FAD_AGENT_ID: otherId },
    });
    const oldJson = JSON.parse(oldOut);
    check('C07', oldJson.id === otherId && oldJson.etag.startsWith('"agent-v') && !oldJson.keys.includes('tags'));

    const downConfig = loadConfig({
      ...process.env,
      NODE_ENV: 'development',
      FAD_BIND_HOST: '127.0.0.1',
      FAD_INGRESS_TLS: 'cleartext',
      FAD_TRUST_PROXY: 'false',
      FAD_TAGS_ENABLED: 'true',
      DATABASE_URL: 'postgres://fad_app:x@127.0.0.1:1/fad',
    });
    const downPool = createPool({
      connectionString: downConfig.databaseUrl,
      max: 1,
      statementTimeoutMs: 1000,
      applicationName: 'fad-q14',
      ssl: false,
    });
    const downApp = await buildApp({ config: downConfig, pool: downPool });
    await downApp.app.listen({ port: 0, host: '127.0.0.1' });
    const downAddress = downApp.app.server.address();
    const downBase = `http://127.0.0.1:${downAddress.port}`;
    const downLive = await request(`${downBase}/health/live`);
    const downTag = await request(`${downBase}/v1/tag-definitions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'tag-down-00000001', 'x-fad-api-key': keyA.api_key },
      body: JSON.stringify({ namespace: 'department', key: 'down', value_type: 'string', governed: false, visibility: 'internal' }),
    });
    await downApp.app.close();
    await downPool.end();
    check('Q14', downLive.status === 200 && downLive.json.status === 'ok' && downTag.status === 503
      && downTag.json.error.code === 'DEPENDENCY_UNAVAILABLE' && downTag.json.data === undefined);

    const flaggedOff = await startApi({
      FAD_TAGS_ENABLED: 'false',
      FAD_RATE_LIMIT_MAX: '1000',
      FAD_HTTP_REQUEST_TIMEOUT_MS: '30000',
      FAD_SHUTDOWN_GRACE_MS: '30000',
    });
    const offAgent = await call(flaggedOff.base, 'GET', `/v1/agents/${otherId}`, keyA.api_key);
    const offTag = await call(flaggedOff.base, 'POST', '/v1/tag-definitions', keyA.api_key, {
      namespace: 'department', key: 'off', value_type: 'string', governed: false, visibility: 'internal',
    }, { 'idempotency-key': 'tag-def-off-000001' });
    const offLogs = flaggedOff.logs();
    check('Q15', offAgent.status === 200 && offAgent.json.data.id === otherId && !('tags' in offAgent.json.data)
      && offTag.status === 404 && offTag.json.error.code === 'NOT_FOUND' && !offLogs.includes('tag_definitions'));
    await flaggedOff.stop();

    const envFile = join(scratch, 'slice2-image.env');
    const db = new URL(appUrl);
    db.hostname = 'fad-s0-pg';
    db.port = '5432';
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
      `FAD_API_KEY_PEPPER_V1=${pepper}`,
      'FAD_TAGS_ENABLED=false',
    ].join('\n'));
    execFileSync('docker', ['rm', '-f', 'fad-s2-old', 'fad-s2-new'], { stdio: 'ignore' });
    let oldHealth = null;
    let oldAgent = null;
    let oldTag = null;
    let newHealth = null;
    try {
      execFileSync('docker', ['run', '-d', '--name', 'fad-s2-old', '--network', 'fad-s0', '-p', '127.0.0.1:18099:8080', '--env-file', envFile, 'fad-api:slice1'], { stdio: 'ignore' });
      oldHealth = await waitReady('http://127.0.0.1:18099');
      oldAgent = await call('http://127.0.0.1:18099', 'GET', `/v1/agents/${otherId}`, keyA.api_key);
      oldTag = await call('http://127.0.0.1:18099', 'GET', `/v1/agents/${otherId}/tags/billing/count`, keyA.api_key);
      const hasSlice2 = execFileSync('docker', ['image', 'inspect', 'fad-api:slice2', '--format', '{{.Id}}'], { encoding: 'utf8' }).trim();
      if (hasSlice2) {
        const enabled = readFileSync(envFile, 'utf8').replace('FAD_TAGS_ENABLED=false', 'FAD_TAGS_ENABLED=true');
        writeFileSync(envFile, enabled);
        execFileSync('docker', ['run', '-d', '--name', 'fad-s2-new', '--network', 'fad-s0', '-p', '127.0.0.1:18098:8080', '--env-file', envFile, 'fad-api:slice2'], { stdio: 'ignore' });
        newHealth = await waitReady('http://127.0.0.1:18098');
      }
    } finally {
      execFileSync('docker', ['rm', '-f', 'fad-s2-old', 'fad-s2-new'], { stdio: 'ignore' });
    }
    const stillThere = await count(superuser, 'SELECT count(*)::int AS n FROM agent_tag_assignments WHERE agent_id = $1 AND namespace = $2 AND tag_key = $3 AND is_deleted = false', [agentId, 'billing', 'count']);
    const rollbackLog = [
      `old_ready=${oldHealth?.status ?? 'missing'}`,
      `old_agent=${oldAgent?.status ?? 'missing'}`,
      `old_tag=${oldTag?.status ?? 'missing'}`,
      `new_ready=${newHealth?.status ?? 'missing'}`,
      `billing_count_rows=${stillThere}`,
    ].join('\n') + '\n';
    writeEvidence('rollback.log', rollbackLog, secrets);
    writeFileSync(join(scratch, 'slice2-rollback.log'), rollbackLog);
    check('Q16', oldHealth?.status === 'ready' && oldAgent.status === 200 && oldAgent.json.data.id === otherId
      && oldTag.status === 404 && stillThere === 1 && (newHealth === null || newHealth.status === 'ready'));

    await restarted.stop();
  } finally {
    await stopApis();
    await superuser.end().catch(() => undefined);
    await app.end().catch(() => undefined);
  }

  async function putOn(base, id, namespace, key, value, extra = {}) {
    const headers = { 'idempotency-key': keyName(`p-${namespace}-${key}`), 'if-none-match': '*' };
    if (extra.match && extra.match !== '*') {
      delete headers['if-none-match'];
      headers['if-match'] = extra.match;
    }
    const body = { value };
    if (extra.reason) body.reason = extra.reason;
    const response = await call(base, 'PUT', `/v1/agents/${id}/tags/${namespace}/${key}`, keyA.api_key, body, headers);
    if (response.status !== 201 && response.status !== 200) {
      throw new Error(`put ${namespace}.${key} ${response.status} ${response.text.slice(0, 180)}`);
    }
    return response;
  }

  async function defineOn(base, body, idem) {
    const response = await call(base, 'POST', '/v1/tag-definitions', keyA.api_key, body, { 'idempotency-key': idem });
    if (response.status !== 201) throw new Error(`define ${response.status} ${response.text.slice(0, 180)}`);
    return response;
  }
});

async function waitReady(base) {
  for (let i = 0; i < 40; i += 1) {
    try {
      const response = await request(`${base}/health/ready`);
      if (response.status === 200) return response.json;
    } catch {
      /* container still starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}
