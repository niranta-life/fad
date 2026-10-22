import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { applyMigrations } from '@fad/migrator';
import { ENFORCEMENT_MIGRATION_VERSION } from '@fad/db';
import { admin, check, parseJson, request, requiredEnv, scratch, startApi, stopApis } from './support.mjs';

const { Client: PgClient } = pg;
const appUrl = requiredEnv('DATABASE_URL');
const migratorUrl = requiredEnv('FAD_MIGRATOR_DATABASE_URL');
const migrationsDir = new URL('../db/migrations/', import.meta.url).pathname;
const stamp = Date.now().toString(36);
const SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  properties: { invoice_id: { type: 'string' } },
  required: ['invoice_id'],
};
const ADMIN = [
  'organizations:read', 'agents:read', 'agents:write', 'agents:lifecycle',
  'tags:define', 'tags:read', 'tags:write', 'tags:governance', 'tags:restricted:read',
  'policies:read', 'policies:write', 'policies:activate', 'policies:evaluate:any', 'policies:explain',
  'policies:attributes:write', 'capabilities:read', 'capabilities:write', 'endpoints:read', 'endpoints:write',
  'enforcement:read', 'enforcement:manage', 'enforcement:audit',
].join(',');
const DIRECTORY = 'agents:read,tags:read,capabilities:read,endpoints:read';
const NOSCOPE = 'organizations:read';
const TAG_WRITE = 'agents:read,agents:write,tags:read,tags:write';
const TAG_GOV = 'agents:read,agents:write,tags:read,tags:write,tags:governance,tags:restricted:read';

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

async function created(args) {
  const result = await admin(args);
  if (result.code !== 0) throw new Error(`${args.slice(0, 2).join(' ')} ${result.stderr.slice(0, 240)}`);
  return parseJson(result.stdout);
}

function policy(name, effect, actions, principalIds, resource) {
  return {
    name,
    description: 'slice 6 policy',
    effect,
    actions,
    subjects: { principal_ids: principalIds },
    resource,
  };
}

function tag(namespace, key, value) {
  return { namespace, key, operator: 'eq', value };
}

function docker(args) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || error.message).slice(0, 240)));
      else resolve(stdout);
    });
  });
}

const apiEnv = {
  FAD_POLICIES_ENABLED: 'true',
  FAD_TAGS_ENABLED: 'true',
  FAD_SLICE3_ENABLED: 'true',
  FAD_ENFORCEMENT_CODE_ENABLED: 'true',
  FAD_HTTP_REQUEST_TIMEOUT_MS: '8000',
  FAD_SHUTDOWN_GRACE_MS: '8000',
  FAD_DB_POOL_MAX: '8',
  FAD_RATE_LIMIT_MAX: '8000',
  FAD_ENFORCEMENT_LOCK_TIMEOUT_MS: '1000',
};

test('policy enforcement migration, rollout, and tenant isolation', { timeout: 420_000 }, async () => {
  const notes = [];
  const secrets = [];
  const note = (id, detail) => {
    notes.push(`${new Date().toISOString()} ${id} ${detail}`);
    check(id, true, detail);
  };
  const superuser = new PgClient({ connectionString: migratorUrl, application_name: 'fad-s6-super' });
  const app = new PgClient({ connectionString: appUrl, application_name: 'fad-s6-app' });
  superuser.on('error', () => undefined);
  app.on('error', () => undefined);
  await superuser.connect();
  await app.connect();
  let api;
  const freshName = 'fad_s6_fresh';
  try {
    const liveBefore = await superuser.query(`SELECT version FROM schema_migrations ORDER BY version`);
    check('MIG-BASE', liveBefore.rows.some((row) => row.version === '20261021_005_policy_evaluation')
      && liveBefore.rows.some((row) => row.version === '20261023_001_mcp_identity_bindings'),
    liveBefore.rows.map((row) => row.version).join(','));
    const upgraded = await applyMigrations(migratorUrl, migrationsDir);
    const liveAfter = await superuser.query(`SELECT version, checksum_sha256 FROM schema_migrations WHERE version = $1`, [ENFORCEMENT_MIGRATION_VERSION]);
    check('MIG-UP', upgraded.applied.includes(ENFORCEMENT_MIGRATION_VERSION) || upgraded.skipped.includes(ENFORCEMENT_MIGRATION_VERSION),
      `applied=${upgraded.applied.join(',')}`);
    check('MIG-SUM', liveAfter.rows.length === 1 && liveAfter.rows[0].checksum_sha256.length === 64, liveAfter.rows[0]?.checksum_sha256 ?? '');

    await superuser.query(`DROP DATABASE IF EXISTS ${freshName}`);
    await superuser.query(`CREATE DATABASE ${freshName}`);
    const freshUrl = new URL(migratorUrl);
    freshUrl.pathname = `/${freshName}`;
    const freshApplied = await applyMigrations(freshUrl.toString(), migrationsDir);
    const fresh = new PgClient({ connectionString: freshUrl.toString(), application_name: 'fad-s6-fresh' });
    await fresh.connect();
    const forced = await fresh.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname IN (
         'fad_enforcement_configs','fad_enforcement_config_revisions','fad_enforcement_preflights','fad_enforcement_decisions','agents')
       ORDER BY 1`,
    );
    const bypass = await fresh.query(`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'fad_app'`);
    const grants = await fresh.query(
      `SELECT has_table_privilege('fad_app','fad_enforcement_decisions','UPDATE') AS decision_update,
              has_table_privilege('fad_app','fad_enforcement_decisions','DELETE') AS decision_delete,
              has_table_privilege('fad_app','fad_enforcement_config_revisions','UPDATE') AS revision_update,
              has_table_privilege('fad_app','fad_enforcement_config_revisions','DELETE') AS revision_delete,
              has_table_privilege('fad_app','fad_enforcement_configs','DELETE') AS config_delete,
              has_column_privilege('fad_app','fad_enforcement_preflights','used_at','UPDATE') AS used_at,
              has_column_privilege('fad_app','fad_enforcement_preflights','passes','UPDATE') AS passes_update`,
    );
    const appFreshUrl = new URL(appUrl);
    appFreshUrl.pathname = `/${freshName}`;
    const freshApp = new PgClient({ connectionString: appFreshUrl.toString(), application_name: 'fad-s6-fresh-app' });
    await freshApp.connect();
    const bare = await freshApp.query(`SELECT count(*)::int AS n FROM fad_enforcement_configs`);
    let decisionUpdate = '';
    try {
      await freshApp.query(`UPDATE fad_enforcement_decisions SET reason_code = 'x'`);
      decisionUpdate = 'allowed';
    } catch (error) {
      decisionUpdate = error.code ?? 'error';
    }
    await freshApp.end();
    await fresh.end();
    await superuser.query(`DROP DATABASE IF EXISTS ${freshName}`);
    const grant = grants.rows[0];
    check('MIG-FRESH', freshApplied.applied.includes(ENFORCEMENT_MIGRATION_VERSION)
      && forced.rows.filter((row) => row.relname.startsWith('fad_enforcement_')).length === 4
      && forced.rows.filter((row) => row.relname.startsWith('fad_enforcement_')).every((row) => row.relforcerowsecurity === true && row.relrowsecurity === true)
      && bypass.rows[0].rolbypassrls === false && bypass.rows[0].rolsuper === false
      && grant.decision_update === false && grant.decision_delete === false
      && grant.revision_update === false && grant.revision_delete === false && grant.config_delete === false
      && grant.used_at === true && grant.passes_update === false
      && bare.rows[0].n === 0 && decisionUpdate === '42501',
    `update=${decisionUpdate} forced=${forced.rows.map((row) => row.relname).join(',')}`);
    note('R13', `fresh=${freshApplied.applied.at(-1)} upgrade=${liveAfter.rows[0].checksum_sha256}`);

    const orgA = await created(['organization', 'create', '--name', `Enforce A ${stamp}`]);
    const orgB = await created(['organization', 'create', '--name', `Enforce B ${stamp}`]);
    const adminP = await created(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Enforce Admin']);
    const a1 = await created(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Reader A1']);
    const a2 = await created(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Reader A2']);
    const sleeper = await created(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Sleeper']);
    const readOnly = await created(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Read Only']);
    const noScope = await created(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'No Scope']);
    const tagWriter = await created(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Tag Writer']);
    const tagGov = await created(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Tag Gov']);
    const adminB = await created(['principal', 'create', '--organization-id', orgB.id, '--type', 'service', '--name', 'Enforce B']);
    const issue = (org, principal, scopes) => created(['credential', 'issue', '--organization-id', org, '--principal-id', principal, '--scopes', scopes]);
    const keyAdmin = await issue(orgA.id, adminP.id, ADMIN);
    const keyA1 = await issue(orgA.id, a1.id, DIRECTORY);
    const keyA2 = await issue(orgA.id, a2.id, DIRECTORY);
    const keySleep = await issue(orgA.id, sleeper.id, DIRECTORY);
    const keyRead = await issue(orgA.id, readOnly.id, DIRECTORY);
    const keyNone = await issue(orgA.id, noScope.id, NOSCOPE);
    const keyTag = await issue(orgA.id, tagWriter.id, TAG_WRITE);
    const keyGov = await issue(orgA.id, tagGov.id, TAG_GOV);
    const keyB = await issue(orgB.id, adminB.id, ADMIN);
    for (const item of [keyAdmin, keyA1, keyA2, keySleep, keyRead, keyNone, keyTag, keyGov, keyB]) secrets.push(item.api_key);

    const offApi = await startApi({ FAD_TAGS_ENABLED: 'true', FAD_POLICIES_ENABLED: 'true', FAD_SLICE3_ENABLED: 'true' });
    const hiddenConfig = await call(offApi.base, 'GET', '/v1/enforcement/config', keyAdmin.api_key);
    check('FLAG-OFF', offApi.ready && hiddenConfig.status === 404, `ready=${offApi.ready} status=${hiddenConfig.status}`);
    await offApi.stop();

    api = await startApi(apiEnv);
    check('API-ON', api.ready, api.logs().slice(-180));
    const config0 = await call(api.base, 'GET', '/v1/enforcement/config', keyAdmin.api_key, undefined, { 'x-organization-id': orgB.id });
    check('A01', config0.status === 200 && config0.json.data.mode === 'off' && config0.json.data.revision === 0
      && config0.headers.etag === '"enforcement-v0"' && config0.json.data.updated_by === null
      && config0.json.data.organization_id === orgA.id && config0.headers['cache-control'] === 'private, no-store',
    `status=${config0.status} etag=${config0.headers.etag} org=${config0.json?.data?.organization_id}`);
    note('A02', config0.headers['x-request-id'] ?? '');
    const unauth = await call(api.base, 'GET', '/v1/enforcement/config');
    check('S06', unauth.status === 401, `status=${unauth.status}`);

    const agentAllowed = await call(api.base, 'POST', '/v1/agents', keyAdmin.api_key, {
      name: 'Allowed Agent', owner_principal_id: a1.id,
    }, { 'idempotency-key': `s6-agent-allow-${stamp}` });
    const agentDenied = await call(api.base, 'POST', '/v1/agents', keyAdmin.api_key, {
      name: 'Denied Agent', owner_principal_id: a2.id,
    }, { 'idempotency-key': `s6-agent-deny-${stamp}` });
    const agentB = await call(api.base, 'POST', '/v1/agents', keyB.api_key, {
      name: 'Tenant B Agent', owner_principal_id: adminB.id,
    }, { 'idempotency-key': `s6-agent-b-${stamp}` });
    const allowedId = agentAllowed.json?.data?.id;
    const deniedId = agentDenied.json?.data?.id;
    check('P20', agentAllowed.status === 201 && agentDenied.status === 201 && agentB.status === 201, `${agentAllowed.status}`);
    const define = (body, idem) => call(api.base, 'POST', '/v1/tag-definitions', keyAdmin.api_key, body, { 'idempotency-key': idem });
    const department = await define({ namespace: 'department', key: 'name', value_type: 'string', governed: false, visibility: 'internal' }, `s6-tag-dept-${stamp}`);
    const risk = await define({ namespace: 'security', key: 'risk', value_type: 'enum', enum_values: ['low', 'high'], governed: true, visibility: 'restricted' }, `s6-tag-risk-${stamp}`);
    const team = await define({ namespace: 'team', key: 'code', value_type: 'string', governed: false, visibility: 'internal' }, `s6-tag-team-${stamp}`);
    check('TAGS', department.status === 201 && risk.status === 201 && team.status === 201, `${department.status} ${risk.status} ${team.status}`);
    const putTag = (id, namespace, key, value, idem, extra = {}) => call(
      api.base, 'PUT', `/v1/agents/${id}/tags/${namespace}/${key}`, keyAdmin.api_key,
      { value, ...extra },
      { 'idempotency-key': idem, 'if-none-match': '*' },
    );
    const tagged = await Promise.all([
      putTag(allowedId, 'department', 'name', 'finance', `s6-dept-a-${stamp}`),
      putTag(deniedId, 'department', 'name', 'finance', `s6-dept-d-${stamp}`),
      putTag(deniedId, 'team', 'code', 'hidden', `s6-team-d-${stamp}`),
      call(api.base, 'PUT', `/v1/agents/${allowedId}/tags/security/risk`, keyAdmin.api_key, { value: 'high', reason: 'Classify allowed agent' }, { 'idempotency-key': `s6-risk-a-${stamp}`, 'if-none-match': '*' }),
    ]);
    check('TAG-ASSIGN', tagged.every((item) => item.status === 201), tagged.map((item) => item.status).join(','));

    const published = await call(api.base, 'POST', '/v1/capabilities', keyAdmin.api_key, {
      id: 's6.invoice.match', version: '1.0.0', display_name: 'Match', description: 'Declared match contract',
      input_schema: SCHEMA, output_schema: SCHEMA,
    }, { 'idempotency-key': `s6-cap-${stamp}` });
    const endpointFor = async (id, label) => {
      const endpoint = await call(api.base, 'PUT', `/v1/agents/${id}/endpoints/primary`, keyAdmin.api_key, {
        protocol: 'a2a', url: `https://ap.internal.example/${label}`, auth_scheme: 'oauth2',
      }, { 'idempotency-key': `s6-ep-${label}-${stamp}`, 'if-none-match': '*' });
      const binding = await call(api.base, 'PUT', `/v1/agents/${id}/capabilities/s6.invoice.match`, keyAdmin.api_key, {
        version: '1.0.0', endpoint_key: 'primary',
      }, { 'idempotency-key': `s6-bind-${label}-${stamp}`, 'if-none-match': '*' });
      return { endpoint: endpoint.status, binding: binding.status };
    };
    const ends = [await endpointFor(allowedId, 'allow'), await endpointFor(deniedId, 'deny')];
    check('SLICE3', published.status === 201 && ends.every((item) => item.endpoint === 201 && item.binding === 201), `publish=${published.status} ${JSON.stringify(ends)} ${published.text.slice(0, 180)}`);

    const legacyRead = await call(api.base, 'GET', `/v1/agents/${allowedId}`, keyA2.api_key);
    const legacyPatch = await call(api.base, 'PATCH', `/v1/agents/${allowedId}`, keyAdmin.api_key, { name: 'Allowed Agent Off' }, {
      'idempotency-key': `s6-patch-off-${stamp}`, 'if-match': agentAllowed.headers.etag,
    });
    check('P01', legacyRead.status === 200 && legacyRead.json.data.id === allowedId && legacyPatch.status === 200, `${legacyRead.status} ${legacyPatch.status}`);

    await superuser.query('BEGIN');
    await superuser.query(`SELECT pg_advisory_xact_lock(6816, fad_s6_enforcement_key($1::uuid))`, [orgA.id]);
    const offLocked = await call(api.base, 'GET', `/v1/agents/${allowedId}`, keyA1.api_key);
    const offTag = await call(api.base, 'PUT', `/v1/agents/${allowedId}/tags/department/name`, keyAdmin.api_key, { value: 'treasury' }, {
      'idempotency-key': `s6-off-lock-tag-${stamp}`, 'if-match': tagged[0].headers.etag,
    });
    await superuser.query('ROLLBACK');
    const deptDuringOff = await superuser.query(
      `SELECT tag_value::text AS v FROM agent_tag_assignments
       WHERE organization_id = $1 AND agent_id = $2 AND namespace = 'department' AND tag_key = 'name' AND is_deleted = false`,
      [orgA.id, allowedId],
    );
    const offAfterLock = await call(api.base, 'GET', `/v1/agents/${allowedId}`, keyA1.api_key);
    const modeStillOff = await superuser.query(`SELECT count(*)::int AS n FROM fad_enforcement_configs WHERE organization_id = $1`, [orgA.id]);
    check('D10-OFF', offLocked.status === 503 && offLocked.json.error.code === 'DEPENDENCY_UNAVAILABLE'
      && offTag.status === 503 && offTag.json.error.code === 'DEPENDENCY_UNAVAILABLE'
      && !offLocked.text.includes('Allowed Agent') && !offTag.text.includes('treasury')
      && deptDuringOff.rows[0].v.includes('finance') && !deptDuringOff.rows[0].v.includes('treasury')
      && offAfterLock.status === 200 && offAfterLock.json.data.id === allowedId
      && modeStillOff.rows[0].n === 0,
    `read=${offLocked.status}/${offLocked.json?.error?.code} tag=${offTag.status}/${offTag.json?.error?.code} value=${deptDuringOff.rows[0]?.v} again=${offAfterLock.status} configs=${modeStillOff.rows[0]?.n}`);

    const allowBody = policy('Allow governed', 'allow', ['agent.read', 'agent.discover', 'agent.update'], [adminP.id, a1.id, sleeper.id, noScope.id], {
      type: 'agent', tags_all: [tag('security', 'risk', 'high')],
    });
    const allow = await call(api.base, 'POST', '/v1/policies', keyAdmin.api_key, allowBody, { 'idempotency-key': `s6-allow-${stamp}` });
    const allowOn = await call(api.base, 'POST', `/v1/policies/${allow.json.data.id}/activate`, keyAdmin.api_key, undefined, {
      'idempotency-key': `s6-allow-on-${stamp}`, 'if-match': allow.headers.etag,
    });
    const readOnlyBody = policy('Allow read only', 'allow', ['agent.read'], [readOnly.id], {
      type: 'agent', tags_all: [tag('security', 'risk', 'high')],
    });
    const readOnlyPolicy = await call(api.base, 'POST', '/v1/policies', keyAdmin.api_key, readOnlyBody, { 'idempotency-key': `s6-ro-${stamp}` });
    const readOnlyOn = await call(api.base, 'POST', `/v1/policies/${readOnlyPolicy.json.data.id}/activate`, keyAdmin.api_key, undefined, {
      'idempotency-key': `s6-ro-on-${stamp}`, 'if-match': readOnlyPolicy.headers.etag,
    });
    const denyBody = policy('Deny A2', 'deny', ['agent.read', 'agent.discover', 'agent.update', 'agent.suspend'], [a2.id], {
      type: 'agent', agent_ids: [allowedId],
    });
    const deny = await call(api.base, 'POST', '/v1/policies', keyAdmin.api_key, denyBody, { 'idempotency-key': `s6-deny-${stamp}` });
    const denyOn = await call(api.base, 'POST', `/v1/policies/${deny.json.data.id}/activate`, keyAdmin.api_key, undefined, {
      'idempotency-key': `s6-deny-on-${stamp}`, 'if-match': deny.headers.etag,
    });
    const weakBody = policy('Ungoverned department', 'allow', ['agent.read'], [a1.id], {
      type: 'agent', tags_all: [tag('department', 'name', 'finance')],
    });
    const weak = await call(api.base, 'POST', '/v1/policies', keyAdmin.api_key, weakBody, { 'idempotency-key': `s6-weak-${stamp}` });
    const weakOn = await call(api.base, 'POST', `/v1/policies/${weak.json.data.id}/activate`, keyAdmin.api_key, undefined, {
      'idempotency-key': `s6-weak-on-${stamp}`, 'if-match': weak.headers.etag,
    });
    const suspendBody = policy('Allow suspend', 'allow', ['agent.suspend'], [adminP.id], { type: 'agent', agent_ids: [allowedId] });
    const suspendPolicy = await call(api.base, 'POST', '/v1/policies', keyAdmin.api_key, suspendBody, { 'idempotency-key': `s6-sus-${stamp}` });
    const suspendOn = await call(api.base, 'POST', `/v1/policies/${suspendPolicy.json.data.id}/activate`, keyAdmin.api_key, undefined, {
      'idempotency-key': `s6-sus-on-${stamp}`, 'if-match': suspendPolicy.headers.etag,
    });
    check('POLICIES', [allowOn, readOnlyOn, denyOn, weakOn, suspendOn].every((item) => item.status === 200), [allowOn, readOnlyOn, denyOn, weakOn, suspendOn].map((item) => item.status).join(','));
    const simulated = await call(api.base, 'POST', '/v1/authorization/evaluate', keyAdmin.api_key, {
      subject: { principal_id: a1.id }, action: 'agent.read', resource: { type: 'agent', id: allowedId },
    });
    check('P18', simulated.status === 200 && simulated.json.data.enforcement === 'not_enforced' && simulated.json.data.decision === 'allow', simulated.json?.data?.enforcement ?? '');

    const shadowPre = await call(api.base, 'POST', '/v1/enforcement/preflight', keyAdmin.api_key, {
      mode: 'shadow', actions: ['agent.read'], reason: 'shadow-rollout-reason-s6',
    });
    check('A15', shadowPre.status === 200 && shadowPre.json.data.passes === true && shadowPre.json.data.warnings.includes('ungoverned_selector')
      && /^[0-9a-f]{64}$/.test(shadowPre.json.data.policy_snapshot_digest),
    `status=${shadowPre.status} warnings=${JSON.stringify(shadowPre.json?.data?.warnings)}`);
    const missingMatch = await call(api.base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'shadow', actions: ['agent.read'], reason: 'shadow-rollout-reason-s6', preflight_id: shadowPre.json.data.preflight_id, acknowledge_default_deny: false,
    }, { 'idempotency-key': `s6-shadow-missing-${stamp}` });
    const weakMatch = await call(api.base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'shadow', actions: ['agent.read'], reason: 'shadow-rollout-reason-s6', preflight_id: shadowPre.json.data.preflight_id, acknowledge_default_deny: false,
    }, { 'idempotency-key': `s6-shadow-weak-${stamp}`, 'if-match': '*' });
    const noPreflight = await call(api.base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'shadow', actions: ['agent.read'], reason: 'shadow-rollout-reason-s6', acknowledge_default_deny: false,
    }, { 'idempotency-key': `s6-shadow-nopre-${stamp}`, 'if-match': '"enforcement-v0"' });
    const shadowPut = await call(api.base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'shadow', actions: ['agent.read'], reason: 'shadow-rollout-reason-s6', preflight_id: shadowPre.json.data.preflight_id, acknowledge_default_deny: false,
    }, { 'idempotency-key': `s6-shadow-put-${stamp}`, 'if-match': '"enforcement-v0"' });
    const shadowReplay = await call(api.base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'shadow', actions: ['agent.read'], reason: 'shadow-rollout-reason-s6', preflight_id: shadowPre.json.data.preflight_id, acknowledge_default_deny: false,
    }, { 'idempotency-key': `s6-shadow-put-${stamp}`, 'if-match': '"enforcement-v0"' });
    const shadowClash = await call(api.base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'off', actions: [], reason: 'different body same key', acknowledge_default_deny: false,
    }, { 'idempotency-key': `s6-shadow-put-${stamp}`, 'if-match': shadowPut.headers.etag });
    const revisions = await superuser.query(`SELECT count(*)::int AS n FROM fad_enforcement_config_revisions WHERE organization_id = $1`, [orgA.id]);
    check('A03', missingMatch.status === 428 && weakMatch.status === 400 && noPreflight.status === 422
      && shadowPut.status === 200 && shadowPut.json.data.mode === 'shadow' && shadowPut.json.data.revision === 1
      && shadowPut.headers.etag === '"enforcement-v1"' && shadowReplay.status === 200 && shadowReplay.json.data.revision === 1
      && shadowClash.status === 409 && revisions.rows[0].n === 1,
    `missing=${missingMatch.status} weak=${weakMatch.status} nopre=${noPreflight.status} put=${shadowPut.status} replay=${shadowReplay.status} clash=${shadowClash.status} rows=${revisions.rows[0].n}`);
    const reused = await call(api.base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'shadow', actions: ['agent.read'], reason: 'shadow-rollout-reason-s6', preflight_id: shadowPre.json.data.preflight_id, acknowledge_default_deny: false,
    }, { 'idempotency-key': `s6-shadow-reuse-${stamp}`, 'if-match': '"enforcement-v1"' });
    check('A16', reused.status === 409, `status=${reused.status}`);
    const would = await call(api.base, 'GET', `/v1/agents/${allowedId}`, keyA2.api_key);
    const shadowRows = await superuser.query(
      `SELECT outcome, reason_code FROM fad_enforcement_decisions WHERE organization_id = $1 AND actor_principal_id = $2 AND mode = 'shadow'`,
      [orgA.id, a2.id],
    );
    check('P02', would.status === 200 && would.json.data.id === allowedId && shadowRows.rows.some((row) => row.outcome === 'would_deny' && row.reason_code === 'EXPLICIT_DENY'),
      `status=${would.status} rows=${JSON.stringify(shadowRows.rows)}`);
    const wouldAllow = await call(api.base, 'GET', `/v1/agents/${allowedId}`, keyA1.api_key);
    const allowRows = await superuser.query(
      `SELECT outcome FROM fad_enforcement_decisions WHERE organization_id = $1 AND actor_principal_id = $2 AND mode = 'shadow'`,
      [orgA.id, a1.id],
    );
    check('P03', wouldAllow.status === 200 && allowRows.rows.some((row) => row.outcome === 'would_allow'), `status=${wouldAllow.status}`);
    const shadowList = await call(api.base, 'GET', '/v1/agents?limit=25', keyA1.api_key);
    const shadowIds = (shadowList.json?.data ?? []).map((item) => item.id);
    check('C13', shadowList.status === 200 && shadowIds.includes(allowedId) && shadowIds.includes(deniedId), shadowIds.join(','));
    const shadowFail = await startApi({ ...apiEnv, FAD_ENFORCEMENT_FAIL_EVALUATION: 'true' });
    const shadowStill = await call(shadowFail.base, 'GET', `/v1/agents/${allowedId}`, keyA2.api_key);
    check('D11', shadowFail.ready && shadowStill.status === 200 && shadowStill.json.data.id === allowedId && shadowFail.logs().includes('ENFORCEMENT_SHADOW_EVALUATION_FAILED'),
      `status=${shadowStill.status}`);
    await shadowFail.stop();

    const blocked = await call(api.base, 'POST', '/v1/enforcement/preflight', keyAdmin.api_key, {
      mode: 'enforce', actions: ['agent.read'], reason: 'block ordinary tag selector',
    });
    check('T01', blocked.status === 200 && blocked.json.data.passes === false && blocked.json.data.blockers.includes('ungoverned_selector'),
      JSON.stringify(blocked.json?.data?.blockers));
    const weakOff = await call(api.base, 'POST', `/v1/policies/${weak.json.data.id}/disable`, keyAdmin.api_key, undefined, {
      'idempotency-key': `s6-weak-off-${stamp}`, 'if-match': weakOn.headers.etag,
    });
    check('WEAK-OFF', weakOff.status === 200, `status=${weakOff.status}`);
    const enforcePre = await call(api.base, 'POST', '/v1/enforcement/preflight', keyAdmin.api_key, {
      mode: 'enforce', actions: ['agent.read'], reason: 'enable read enforcement',
    });
    check('T02', enforcePre.status === 200 && enforcePre.json.data.passes === true && enforcePre.json.data.blockers.length === 0, JSON.stringify(enforcePre.json?.data?.blockers));
    const stalePre = await call(api.base, 'POST', '/v1/enforcement/preflight', keyAdmin.api_key, {
      mode: 'enforce', actions: ['agent.read'], reason: 'stale after another policy',
    });
    const extra = await call(api.base, 'POST', '/v1/policies', keyAdmin.api_key, policy('Extra allow', 'allow', ['agent.read'], [a1.id], {
      type: 'agent', agent_ids: [allowedId],
    }), { 'idempotency-key': `s6-extra-${stamp}` });
    const extraOn = await call(api.base, 'POST', `/v1/policies/${extra.json.data.id}/activate`, keyAdmin.api_key, undefined, {
      'idempotency-key': `s6-extra-on-${stamp}`, 'if-match': extra.headers.etag,
    });
    const stalePut = await call(api.base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'enforce', actions: ['agent.read'], reason: 'stale after another policy', preflight_id: stalePre.json.data.preflight_id, acknowledge_default_deny: true,
    }, { 'idempotency-key': `s6-stale-pre-${stamp}`, 'if-match': '"enforcement-v1"' });
    check('A17', extraOn.status === 200 && stalePut.status === 412, `extra=${extraOn.status} stale=${stalePut.status}`);
    const extraOff = await call(api.base, 'POST', `/v1/policies/${extra.json.data.id}/disable`, keyAdmin.api_key, undefined, {
      'idempotency-key': `s6-extra-off-${stamp}`, 'if-match': extraOn.headers.etag,
    });
    check('EXTRA-OFF', extraOff.status === 200, `status=${extraOff.status}`);
    const otherAdmin = await created(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Other Manage']);
    const keyOther = await issue(orgA.id, otherAdmin.id, ADMIN);
    secrets.push(keyOther.api_key);
    const otherPre = await call(api.base, 'POST', '/v1/enforcement/preflight', keyOther.api_key, {
      mode: 'enforce', actions: ['agent.read'], reason: 'other actor preflight',
    });
    const otherPut = await call(api.base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'enforce', actions: ['agent.read'], reason: 'other actor preflight', preflight_id: otherPre.json.data.preflight_id, acknowledge_default_deny: true,
    }, { 'idempotency-key': `s6-other-actor-${stamp}`, 'if-match': '"enforcement-v1"' });
    const wrongActions = await call(api.base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'enforce', actions: ['agent.read', 'agent.discover'], reason: 'enable read enforcement', preflight_id: enforcePre.json.data.preflight_id, acknowledge_default_deny: true,
    }, { 'idempotency-key': `s6-wrong-actions-${stamp}`, 'if-match': '"enforcement-v1"' });
    check('A19', otherPut.status === 409 && wrongActions.status === 409, `other=${otherPut.status} actions=${wrongActions.status}`);
    await superuser.query(
      `UPDATE fad_enforcement_preflights SET issued_at = transaction_timestamp() - interval '5 minutes', expires_at = transaction_timestamp() - interval '1 minute'
       WHERE organization_id = $1 AND id = $2`,
      [orgA.id, enforcePre.json.data.preflight_id],
    );
    const expiredPut = await call(api.base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'enforce', actions: ['agent.read'], reason: 'enable read enforcement', preflight_id: enforcePre.json.data.preflight_id, acknowledge_default_deny: true,
    }, { 'idempotency-key': `s6-expired-${stamp}`, 'if-match': '"enforcement-v1"' });
    check('A18', expiredPut.status === 409, `status=${expiredPut.status}`);
    const freshPre = await call(api.base, 'POST', '/v1/enforcement/preflight', keyAdmin.api_key, {
      mode: 'enforce', actions: ['agent.read'], reason: 'enable read enforcement',
    });
    const noAck = await call(api.base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'enforce', actions: ['agent.read'], reason: 'enable read enforcement', preflight_id: freshPre.json.data.preflight_id, acknowledge_default_deny: false,
    }, { 'idempotency-key': `s6-noack-${stamp}`, 'if-match': '"enforcement-v1"' });
    const invoke = await call(api.base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'enforce', actions: ['agent.invoke'], reason: 'invoke is not covered', acknowledge_default_deny: true,
    }, { 'idempotency-key': `s6-invoke-${stamp}`, 'if-match': '"enforcement-v1"' });
    const duplicate = await call(api.base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'enforce', actions: ['agent.read', 'agent.read'], reason: 'duplicate action', acknowledge_default_deny: true,
    }, { 'idempotency-key': `s6-dup-${stamp}`, 'if-match': '"enforcement-v1"' });
    const badOff = await call(api.base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'off', actions: ['agent.read'], reason: 'off keeps no actions', acknowledge_default_deny: false,
    }, { 'idempotency-key': `s6-badoff-${stamp}`, 'if-match': '"enforcement-v1"' });
    const pollution = await call(api.base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key,
      '{"mode":"off","actions":[],"reason":"proto rejected","acknowledge_default_deny":false,"__proto__":{"admin":true}}',
      { 'idempotency-key': `s6-proto-${stamp}`, 'if-match': '"enforcement-v1"' });
    const unknownProp = await call(api.base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'off', actions: [], reason: 'unknown property', acknowledge_default_deny: false, extra: true,
    }, { 'idempotency-key': `s6-extra-prop-${stamp}`, 'if-match': '"enforcement-v1"' });
    const readerPut = await call(api.base, 'PUT', '/v1/enforcement/config', keyA1.api_key, {
      mode: 'off', actions: [], reason: 'reader cannot manage', acknowledge_default_deny: false,
    }, { 'idempotency-key': `s6-reader-put-${stamp}`, 'if-match': '"enforcement-v1"' });
    check('A09', noAck.status === 422 && invoke.status === 422 && duplicate.status === 422 && badOff.status === 422
      && pollution.status === 422 && unknownProp.status === 422 && readerPut.status === 403,
    `ack=${noAck.status} invoke=${invoke.status} dup=${duplicate.status} off=${badOff.status} proto=${pollution.status} extra=${unknownProp.status} reader=${readerPut.status}`);
    const enforcePut = await call(api.base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'enforce', actions: ['agent.read'], reason: 'enable read enforcement', preflight_id: freshPre.json.data.preflight_id, acknowledge_default_deny: true,
    }, { 'idempotency-key': `s6-enforce-put-${stamp}`, 'if-match': '"enforcement-v1"' });
    const staleEtag = await call(api.base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'off', actions: [], reason: 'stale etag must not write', acknowledge_default_deny: false,
    }, { 'idempotency-key': `s6-stale-etag-${stamp}`, 'if-match': '"enforcement-v1"' });
    check('A06', enforcePut.status === 200 && enforcePut.json.data.mode === 'enforce' && enforcePut.json.data.revision === 2
      && enforcePut.headers.etag === '"enforcement-v2"' && staleEtag.status === 412,
    `put=${enforcePut.status} rev=${enforcePut.json?.data?.revision} stale=${staleEtag.status}`);
    note('REQ-ENFORCE', enforcePut.headers['x-request-id'] ?? '');

    const allowedGet = await call(api.base, 'GET', `/v1/agents/${allowedId}`, keyA1.api_key);
    const deniedGet = await call(api.base, 'GET', `/v1/agents/${allowedId}`, keyA2.api_key);
    const noScopeGet = await call(api.base, 'GET', `/v1/agents/${allowedId}`, keyNone.api_key);
    const foreignGet = await call(api.base, 'GET', `/v1/agents/${allowedId}`, keyB.api_key);
    const foreignConfig = await call(api.base, 'GET', '/v1/enforcement/config', keyB.api_key);
    const savedSubjects = await superuser.query(`SELECT subjects FROM fad_policies WHERE organization_id = $1 AND id = $2`, [orgA.id, allow.json.data.id]);
    let policyGuardDisabled = false;
    try {
      await superuser.query('ALTER TABLE fad_policies DISABLE TRIGGER fad_policy_guard');
      policyGuardDisabled = true;
      await superuser.query(
        `UPDATE fad_policies SET subjects = '{"broken":true}'::jsonb WHERE organization_id = $1 AND id = $2`,
        [orgA.id, allow.json.data.id],
      );
      const malformedGet = await call(api.base, 'GET', `/v1/agents/${allowedId}`, keyA1.api_key);
      const modeDuringMalformed = await superuser.query(`SELECT mode FROM fad_enforcement_configs WHERE organization_id = $1`, [orgA.id]);
      const malformedDetail = `status=${malformedGet.status} code=${malformedGet.json?.error?.code} mode=${modeDuringMalformed.rows[0]?.mode}`;
      notes.push(`${new Date().toISOString()} MALFORMED ${malformedDetail}`);
      check('MALFORMED', malformedGet.status === 503 && malformedGet.json?.error?.code === 'DEPENDENCY_UNAVAILABLE'
        && !malformedGet.text.includes(allowedId) && !malformedGet.text.includes('"name"') && modeDuringMalformed.rows[0]?.mode === 'enforce',
      malformedDetail);
      await superuser.query(
        `UPDATE fad_policies SET subjects = $3::jsonb WHERE organization_id = $1 AND id = $2`,
        [orgA.id, allow.json.data.id, JSON.stringify(savedSubjects.rows[0].subjects)],
      );
    } finally {
      if (policyGuardDisabled) await superuser.query('ALTER TABLE fad_policies ENABLE TRIGGER fad_policy_guard');
    }
    const healedGet = await call(api.base, 'GET', `/v1/agents/${allowedId}`, keyA1.api_key);
    check('MALFORMED-RESTORE', healedGet.status === 200 && healedGet.json.data.id === allowedId, `status=${healedGet.status}`);
    check('P04', healedGet.status === 200 && healedGet.json.data.id === allowedId, `status=${healedGet.status}`);
    check('P05', deniedGet.status === 404 && deniedGet.json.error.code === 'AGENT_NOT_FOUND' && !deniedGet.text.includes(allowedId), `status=${deniedGet.status} code=${deniedGet.json?.error?.code}`);
    check('P06', deniedGet.status === 404, 'explicit deny concealed');
    check('P07', noScopeGet.status === 403 && noScopeGet.json.error.code === 'FORBIDDEN', `status=${noScopeGet.status} code=${noScopeGet.json?.error?.code}`);
    check('P17', foreignGet.status === 404 && foreignConfig.status === 200 && foreignConfig.json.data.organization_id === orgB.id
      && foreignConfig.json.data.mode === 'off' && foreignConfig.json.data.revision === 0, `agent=${foreignGet.status} config=${foreignConfig.json?.data?.organization_id}`);
    const decisionId = (await superuser.query(
      `SELECT id FROM fad_enforcement_decisions WHERE organization_id = $1 AND actor_principal_id = $2 AND mode = 'enforce' AND outcome = 'denied' ORDER BY happened_at DESC LIMIT 1`,
      [orgA.id, a2.id],
    )).rows[0]?.id;
    const decision = await call(api.base, 'GET', `/v1/enforcement/decisions/${decisionId}`, keyAdmin.api_key);
    const decisionDenied = await call(api.base, 'GET', `/v1/enforcement/decisions/${decisionId}`, keyA1.api_key);
    const decisionForeign = await call(api.base, 'GET', `/v1/enforcement/decisions/${decisionId}`, keyB.api_key);
    const decisionMissing = await call(api.base, 'GET', '/v1/enforcement/decisions/00000000-0000-4000-8000-000000000099', keyAdmin.api_key);
    check('A20', decision.status === 200 && decision.json.data.id === decisionId && decision.json.data.outcome === 'denied'
      && decisionDenied.status === 403 && decisionForeign.status === 404 && decisionMissing.status === 404
      && decision.headers['cache-control'] === 'private, no-store',
    `get=${decision.status} scope=${decisionDenied.status} foreign=${decisionForeign.status} missing=${decisionMissing.status}`);
    const reasonLeak = await superuser.query(
      `SELECT count(*)::int AS n FROM audit_events WHERE organization_id = $1 AND action = 'enforcement.config_updated' AND details::text LIKE '%shadow-rollout-reason-s6%'`,
      [orgA.id],
    );
    const preflightLeak = await superuser.query(
      `SELECT count(*)::int AS n FROM fad_enforcement_preflights WHERE organization_id = $1 AND (blockers::text LIKE '%finance%' OR warnings::text LIKE '%finance%' OR blockers::text LIKE '%shadow-rollout%')`,
      [orgA.id],
    );
    check('S14', reasonLeak.rows[0].n === 0 && preflightLeak.rows[0].n === 0, `audit=${reasonLeak.rows[0].n} preflight=${preflightLeak.rows[0].n}`);
    const listed = await call(api.base, 'GET', '/v1/agents?limit=25', keyA1.api_key);
    const listedIds = (listed.json?.data ?? []).map((item) => item.id);
    check('C01', listed.status === 200 && listedIds.includes(allowedId) && !listedIds.includes(deniedId) && !listed.text.includes(deniedId), listedIds.join(','));
    const searched = await call(api.base, 'POST', '/v1/agents/search', keyA1.api_key, {
      tags: [{ namespace: 'department', key: 'name', operator: 'eq', value: 'finance' }],
    });
    const searchedIds = (searched.json?.data ?? []).map((item) => item.id);
    check('C02', searched.status === 200 && searchedIds.includes(allowedId) && !searchedIds.includes(deniedId), searchedIds.join(','));
    const discovered = await call(api.base, 'POST', '/v1/discovery/agents', keyA1.api_key, {
      capability: { id: 's6.invoice.match', version: '1.0.0' }, protocols: ['a2a'],
    });
    const discoveredIds = (discovered.json?.data ?? []).map((item) => item.agent?.id);
    check('C03', discovered.status === 200 && discoveredIds.includes(allowedId) && !discoveredIds.includes(deniedId)
      && !discovered.text.includes('deny') && discovered.json.data.every((item) => item.invocation_authorization === 'not_evaluated'),
    discoveredIds.join(','));
    const secondAllowed = await call(api.base, 'POST', '/v1/agents', keyAdmin.api_key, {
      name: 'Second Allowed Agent', owner_principal_id: a1.id,
    }, { 'idempotency-key': `s6-agent-allow-2-${stamp}` });
    const secondTagged = await call(api.base, 'PUT', `/v1/agents/${secondAllowed.json.data.id}/tags/security/risk`, keyAdmin.api_key, {
      value: 'high', reason: 'Classify second agent',
    }, { 'idempotency-key': `s6-risk-a2nd-${stamp}`, 'if-none-match': '*' });
    check('SECOND', secondAllowed.status === 201 && secondTagged.status === 201, `${secondAllowed.status} ${secondTagged.status}`);
    const bothPre = await call(api.base, 'POST', '/v1/enforcement/preflight', keyAdmin.api_key, {
      mode: 'enforce', actions: ['agent.read', 'agent.discover'], reason: 'add discovery enforcement',
    });
    const bothPut = await call(api.base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'enforce', actions: ['agent.read', 'agent.discover'], reason: 'add discovery enforcement',
      preflight_id: bothPre.json.data.preflight_id, acknowledge_default_deny: true,
    }, { 'idempotency-key': `s6-both-${stamp}`, 'if-match': enforcePut.headers.etag });
    const readOnlyList = await call(api.base, 'GET', '/v1/agents?limit=25', keyRead.api_key);
    const readOnlyGet = await call(api.base, 'GET', `/v1/agents/${allowedId}`, keyRead.api_key);
    const a1Page = await call(api.base, 'GET', '/v1/agents?limit=1', keyA1.api_key);
    check('P13', bothPut.status === 200 && readOnlyGet.status === 200 && !(readOnlyList.json?.data ?? []).some((item) => item.id === allowedId)
      && (a1Page.json?.data ?? []).length === 1 && a1Page.json.meta.next_cursor,
    `put=${bothPut.status} get=${readOnlyGet.status} page=${a1Page.json?.data?.length} cursor=${Boolean(a1Page.json?.meta?.next_cursor)}`);
    const boundCursor = a1Page.json.meta.next_cursor;
    const firstPageId = a1Page.json.data[0].id;
    const page2 = await call(api.base, 'GET', `/v1/agents?limit=1&cursor=${encodeURIComponent(boundCursor)}`, keyA1.api_key);
    const page2Ids = (page2.json?.data ?? []).map((item) => item.id);
    const tamperedPage = await call(api.base, 'GET', `/v1/agents?limit=1&cursor=${encodeURIComponent(`${boundCursor}x`)}`, keyA1.api_key);
    const crossTenant = await call(api.base, 'GET', `/v1/agents?limit=1&cursor=${encodeURIComponent(boundCursor)}`, keyB.api_key);
    const crossCaller = await call(api.base, 'GET', `/v1/agents?limit=1&cursor=${encodeURIComponent(boundCursor)}`, keyA2.api_key);
    const cursorDetail = `page2=${page2.status}:${page2Ids.join(',')} tamper=${tamperedPage.status}:${tamperedPage.json?.error?.code} tenant=${crossTenant.status} caller=${crossCaller.status}`;
    notes.push(`${new Date().toISOString()} CURSOR ${cursorDetail}`);
    check('C04', page2.status === 200 && page2Ids.length === 1 && page2Ids[0] !== firstPageId && !page2Ids.includes(deniedId) && !page2.text.includes(deniedId), cursorDetail);
    check('C07', tamperedPage.status === 400 && tamperedPage.json?.error?.code === 'VALIDATION_ERROR'
      && !tamperedPage.text.includes(allowedId) && !tamperedPage.text.includes(deniedId) && !tamperedPage.text.includes(firstPageId),
    cursorDetail);
    check('C05', crossTenant.status === 400 && crossCaller.status === 400
      && !crossTenant.text.includes(allowedId) && !crossCaller.text.includes(allowedId)
      && !crossTenant.text.includes(deniedId) && !crossCaller.text.includes(deniedId)
      && !crossTenant.text.includes(firstPageId) && !crossCaller.text.includes(firstPageId),
    cursorDetail);
    const readPut = await call(api.base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'enforce', actions: ['agent.read'], reason: 'return to read only', preflight_id: (await call(api.base, 'POST', '/v1/enforcement/preflight', keyAdmin.api_key, {
        mode: 'enforce', actions: ['agent.read'], reason: 'return to read only',
      })).json.data.preflight_id, acknowledge_default_deny: true,
    }, { 'idempotency-key': `s6-read-again-${stamp}`, 'if-match': bothPut.headers.etag });
    const staleCursor = await call(api.base, 'GET', `/v1/agents?limit=1&cursor=${encodeURIComponent(boundCursor)}`, keyA1.api_key);
    check('C08', readPut.status === 200 && staleCursor.status === 409 && !staleCursor.text.includes(allowedId), `put=${readPut.status} cursor=${staleCursor.status}`);

    const scanApi = await startApi({ ...apiEnv, FAD_ENFORCEMENT_SCAN_LIMIT: '1' });
    const scanList = await call(scanApi.base, 'GET', '/v1/agents?limit=25', keyA1.api_key);
    const scanEmpty = await call(scanApi.base, 'POST', '/v1/agents/search', keyA1.api_key, {
      tags: [{ namespace: 'team', key: 'code', operator: 'eq', value: 'hidden' }],
    });
    check('C09', scanList.status === 503 && scanList.json.error.code === 'ENFORCEMENT_SCAN_BUDGET_EXCEEDED' && !scanList.text.includes(deniedId) && !scanList.text.includes(allowedId),
      `status=${scanList.status} code=${scanList.json?.error?.code}`);
    check('C11', scanEmpty.status === 200 && Array.isArray(scanEmpty.json.data) && scanEmpty.json.data.length === 0 && !scanEmpty.text.includes(deniedId),
      `status=${scanEmpty.status} n=${scanEmpty.json?.data?.length}`);
    await scanApi.stop();

    const patchNoWrite = await call(api.base, 'PATCH', `/v1/agents/${allowedId}`, keyA1.api_key, { name: 'Should Stay' }, {
      'idempotency-key': `s6-a1-patch-${stamp}`, 'if-match': legacyPatch.headers.etag,
    });
    check('P08', patchNoWrite.status === 403 && patchNoWrite.json.error.code === 'FORBIDDEN', `status=${patchNoWrite.status}`);
    const aclPatch = await call(api.base, 'PATCH', `/v1/agents/${allowedId}`, keyAdmin.api_key, { name: 'Allowed Agent Read Mode' }, {
      'idempotency-key': `s6-admin-patch-${stamp}`, 'if-match': legacyPatch.headers.etag,
    });
    check('P14', aclPatch.status === 200, `status=${aclPatch.status} etag=${aclPatch.headers.etag}`);
    const adminUpdate = await call(api.base, 'POST', '/v1/policies', keyAdmin.api_key, policy('Admin update by id', 'allow', ['agent.update'], [adminP.id], {
      type: 'agent', agent_ids: [allowedId],
    }), { 'idempotency-key': `s6-admin-upd-${stamp}` });
    const adminUpdateOn = await call(api.base, 'POST', `/v1/policies/${adminUpdate.json.data.id}/activate`, keyAdmin.api_key, undefined, {
      'idempotency-key': `s6-admin-upd-on-${stamp}`, 'if-match': adminUpdate.headers.etag,
    });
    check('ADMIN-UPDATE', adminUpdateOn.status === 200, `status=${adminUpdateOn.status}`);

    const updatePre = await call(api.base, 'POST', '/v1/enforcement/preflight', keyAdmin.api_key, {
      mode: 'enforce', actions: ['agent.read', 'agent.update'], reason: 'enforce updates',
    });
    const updatePut = await call(api.base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'enforce', actions: ['agent.read', 'agent.update'], reason: 'enforce updates', preflight_id: updatePre.json.data.preflight_id, acknowledge_default_deny: true,
    }, { 'idempotency-key': `s6-update-mode-${stamp}`, 'if-match': readPut.headers.etag });
    const tagOrdinary = await call(api.base, 'PUT', `/v1/agents/${allowedId}/tags/security/risk`, keyTag.api_key, { value: 'low', reason: 'ordinary writer' }, {
      'idempotency-key': `s6-tag-ordinary-${stamp}`, 'if-match': tagged[3].headers.etag,
    });
    const tagGovOnly = await call(api.base, 'PUT', `/v1/agents/${allowedId}/tags/security/risk`, keyGov.api_key, { value: 'low', reason: 'governance only' }, {
      'idempotency-key': `s6-tag-gov-${stamp}`, 'if-match': tagged[3].headers.etag,
    });
    const tagAdmin = await call(api.base, 'PUT', `/v1/agents/${allowedId}/tags/security/risk`, keyAdmin.api_key, { value: 'low', reason: 'authorized attribute change' }, {
      'idempotency-key': `s6-tag-admin-${stamp}`, 'if-match': tagged[3].headers.etag,
    });
    const afterTag = await call(api.base, 'GET', `/v1/agents/${allowedId}`, keyA1.api_key);
    const tagBack = await call(api.base, 'PUT', `/v1/agents/${allowedId}/tags/security/risk`, keyAdmin.api_key, { value: 'high', reason: 'restore classification' }, {
      'idempotency-key': `s6-tag-back-${stamp}`, 'if-match': tagAdmin.headers.etag,
    });
    const restored = await call(api.base, 'GET', `/v1/agents/${allowedId}`, keyA1.api_key);
    check('T03', updatePut.status === 200 && tagOrdinary.status === 403 && tagOrdinary.json.error.code === 'FORBIDDEN', `mode=${updatePut.status} tag=${tagOrdinary.status}`);
    check('T04', tagGovOnly.status === 403 && tagGovOnly.json.error.code === 'FORBIDDEN', `status=${tagGovOnly.status}`);
    check('T05', tagAdmin.status === 200, `status=${tagAdmin.status}`);
    check('T06', afterTag.status === 404 && tagBack.status === 200 && restored.status === 200, `after=${afterTag.status} back=${tagBack.status} restored=${restored.status}`);
    const createdDuring = await call(api.base, 'POST', '/v1/agents', keyAdmin.api_key, {
      name: 'Created During Update Enforce', owner_principal_id: adminP.id,
    }, { 'idempotency-key': `s6-create-during-${stamp}` });
    check('P20B', createdDuring.status === 201, `status=${createdDuring.status}`);
    const badActivate = await call(api.base, 'POST', '/v1/policies', keyAdmin.api_key, policy('Bad selector', 'allow', ['agent.update'], [adminP.id], {
      type: 'agent', tags_all: [tag('department', 'name', 'finance')],
    }), { 'idempotency-key': `s6-bad-pol-${stamp}` });
    const badOn = await call(api.base, 'POST', `/v1/policies/${badActivate.json.data.id}/activate`, keyAdmin.api_key, undefined, {
      'idempotency-key': `s6-bad-on-${stamp}`, 'if-match': badActivate.headers.etag,
    });
    check('T11', badOn.status === 409 && badOn.json.error.code === 'CONFLICT', `status=${badOn.status}`);

    const suspendPre = await call(api.base, 'POST', '/v1/enforcement/preflight', keyAdmin.api_key, {
      mode: 'enforce', actions: ['agent.suspend'], reason: 'enforce suspend only',
    });
    const suspendMode = await call(api.base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'enforce', actions: ['agent.suspend'], reason: 'enforce suspend only', preflight_id: suspendPre.json.data.preflight_id, acknowledge_default_deny: true,
    }, { 'idempotency-key': `s6-suspend-mode-${stamp}`, 'if-match': updatePut.headers.etag });
    const agentNow = await call(api.base, 'GET', `/v1/agents/${allowedId}`, keyAdmin.api_key);
    const suspended = await call(api.base, 'POST', `/v1/agents/${allowedId}/suspend`, keyAdmin.api_key, { reason: 'Hold the agent' }, {
      'idempotency-key': `s6-suspend-${stamp}`, 'if-match': agentNow.headers.etag,
    });
    const renamed = await call(api.base, 'PATCH', `/v1/agents/${allowedId}`, keyAdmin.api_key, { name: 'Renamed While Suspend Enforced' }, {
      'idempotency-key': `s6-rename-sus-${stamp}`, 'if-match': suspended.headers.etag,
    });
    check('P09', suspendMode.status === 200 && suspended.status === 200 && renamed.status === 200, `mode=${suspendMode.status} suspend=${suspended.status} patch=${renamed.status}`);
    const reactivated = await call(api.base, 'POST', `/v1/agents/${allowedId}/activate`, keyAdmin.api_key, { reason: 'Return the agent' }, {
      'idempotency-key': `s6-activate-${stamp}`, 'if-match': renamed.headers.etag,
    });
    check('SUSPEND-ACL', reactivated.status === 200, `activate=${reactivated.status}`);

    const readBackPre = await call(api.base, 'POST', '/v1/enforcement/preflight', keyAdmin.api_key, {
      mode: 'enforce', actions: ['agent.read', 'agent.update'], reason: 'read and update again',
    });
    const readBack = await call(api.base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'enforce', actions: ['agent.read', 'agent.update'], reason: 'read and update again',
      preflight_id: readBackPre.json.data.preflight_id, acknowledge_default_deny: true,
    }, { 'idempotency-key': `s6-read-update-${stamp}`, 'if-match': suspendMode.headers.etag });
    check('MODE', readBack.status === 200, `status=${readBack.status}`);
    const beforeDisable = await call(api.base, 'GET', `/v1/agents/${allowedId}`, keyA1.api_key);
    const allowNow = await call(api.base, 'GET', `/v1/policies/${allow.json.data.id}`, keyAdmin.api_key);
    const allowOff = await call(api.base, 'POST', `/v1/policies/${allow.json.data.id}/disable`, keyAdmin.api_key, undefined, {
      'idempotency-key': `s6-allow-off-${stamp}`, 'if-match': allowNow.headers.etag,
    });
    const afterDisable = await call(api.base, 'GET', `/v1/agents/${allowedId}`, keyA1.api_key);
    const allowAgain = await call(api.base, 'POST', '/v1/policies', keyAdmin.api_key, policy('Allow governed restored', 'allow', ['agent.read', 'agent.discover', 'agent.update'], [adminP.id, a1.id, sleeper.id, noScope.id], {
      type: 'agent', tags_all: [tag('security', 'risk', 'high')],
    }), { 'idempotency-key': `s6-allow-back-${stamp}` });
    const allowAgainOn = await call(api.base, 'POST', `/v1/policies/${allowAgain.json?.data?.id}/activate`, keyAdmin.api_key, undefined, {
      'idempotency-key': `s6-allow-back-on-${stamp}`, 'if-match': allowAgain.headers.etag,
    });
    const afterEnable = await call(api.base, 'GET', `/v1/agents/${allowedId}`, keyA1.api_key);
    check('T12', beforeDisable.status === 200 && allowOff.status === 200 && afterDisable.status === 404
      && allowAgain.status === 201 && allowAgainOn.status === 200 && afterEnable.status === 200,
      `before=${beforeDisable.status} off=${allowOff.status} after=${afterDisable.status} draft=${allowAgain.status} draftcode=${allowAgain.json?.error?.code ?? ''} on=${allowAgainOn.status} oncode=${allowAgainOn.json?.error?.code ?? ''} back=${afterEnable.status}`);
    const held = await call(api.base, 'POST', `/v1/agents/${allowedId}/suspend`, keyAdmin.api_key, { reason: 'Hide inactive agent' }, {
      'idempotency-key': `s6-hold-${stamp}`, 'if-match': afterEnable.headers.etag,
    });
    const hiddenInactive = await call(api.base, 'GET', `/v1/agents/${allowedId}`, keyA1.api_key);
    const blockedResume = await call(api.base, 'POST', `/v1/agents/${allowedId}/activate`, keyAdmin.api_key, { reason: 'Show the agent again' }, {
      'idempotency-key': `s6-resume-blocked-${stamp}`, 'if-match': held.headers.etag,
    });
    check('P15', held.status === 200 && hiddenInactive.status === 404 && blockedResume.status === 403
      && blockedResume.json.error.code === 'POLICY_DENIED' && !hiddenInactive.text.includes(allowedId),
    `hold=${held.status} hidden=${hiddenInactive.status} resume=${blockedResume.status} code=${blockedResume.json?.error?.code}`);
    const readOnlyRecoveryPre = await call(api.base, 'POST', '/v1/enforcement/preflight', keyAdmin.api_key, {
      mode: 'enforce', actions: ['agent.read'], reason: 'recover inactive agent outside update enforcement',
    });
    const readOnlyRecovery = await call(api.base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'enforce', actions: ['agent.read'], reason: 'recover inactive agent outside update enforcement',
      preflight_id: readOnlyRecoveryPre.json.data.preflight_id, acknowledge_default_deny: true,
    }, { 'idempotency-key': `s6-read-recover-${stamp}`, 'if-match': readBack.headers.etag });
    const resumed = await call(api.base, 'POST', `/v1/agents/${allowedId}/activate`, keyAdmin.api_key, { reason: 'Show the agent again' }, {
      'idempotency-key': `s6-resume-${stamp}`, 'if-match': held.headers.etag,
    });
    const updateAgainPre = await call(api.base, 'POST', '/v1/enforcement/preflight', keyAdmin.api_key, {
      mode: 'enforce', actions: ['agent.read', 'agent.update'], reason: 'restore read and update enforcement',
    });
    const updateAgain = await call(api.base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'enforce', actions: ['agent.read', 'agent.update'], reason: 'restore read and update enforcement',
      preflight_id: updateAgainPre.json.data.preflight_id, acknowledge_default_deny: true,
    }, { 'idempotency-key': `s6-update-again-${stamp}`, 'if-match': readOnlyRecovery.headers.etag });
    check('P15-RESUME', readOnlyRecovery.status === 200 && resumed.status === 200 && updateAgain.status === 200,
      `narrow=${readOnlyRecovery.status} resume=${resumed.status} restore=${updateAgain.status} narrowcode=${readOnlyRecovery.json?.error?.code ?? ''} resumecode=${resumed.json?.error?.code ?? ''}`);

    await created(['principal', 'disable', '--organization-id', orgA.id, '--principal-id', sleeper.id, '--reason', 'Hold principal']);
    const sleeping = await call(api.base, 'GET', `/v1/agents/${allowedId}`, keySleep.api_key);
    check('P16', sleeping.status === 401 && sleeping.json?.error?.code === 'UNAUTHORIZED' && !sleeping.text.includes('"name"'),
      `status=${sleeping.status} code=${sleeping.json?.error?.code}`);

    const replayName = 'Idempotent Rename';
    const firstRename = await call(api.base, 'PATCH', `/v1/agents/${allowedId}`, keyAdmin.api_key, { name: replayName }, {
      'idempotency-key': `s6-replay-patch-${stamp}`, 'if-match': resumed.headers.etag,
    });
    const denyAdmin = await call(api.base, 'POST', '/v1/policies', keyAdmin.api_key, policy('Deny admin update', 'deny', ['agent.update'], [adminP.id], {
      type: 'agent', agent_ids: [allowedId],
    }), { 'idempotency-key': `s6-deny-admin-${stamp}` });
    const denyAdminOn = await call(api.base, 'POST', `/v1/policies/${denyAdmin.json.data.id}/activate`, keyAdmin.api_key, undefined, {
      'idempotency-key': `s6-deny-admin-on-${stamp}`, 'if-match': denyAdmin.headers.etag,
    });
    const replayDenied = await call(api.base, 'PATCH', `/v1/agents/${allowedId}`, keyAdmin.api_key, { name: replayName }, {
      'idempotency-key': `s6-replay-patch-${stamp}`, 'if-match': resumed.headers.etag,
    });
    const nameNow = await superuser.query(`SELECT name FROM agents WHERE id = $1`, [allowedId]);
    check('D17', firstRename.status === 200 && denyAdminOn.status === 200 && replayDenied.status === 403 && replayDenied.json.error.code === 'POLICY_DENIED'
      && nameNow.rows[0].name === replayName, `first=${firstRename.status} replay=${replayDenied.status} name=${nameNow.rows[0].name}`);
    const denyAdminOff = await call(api.base, 'POST', `/v1/policies/${denyAdmin.json.data.id}/disable`, keyAdmin.api_key, undefined, {
      'idempotency-key': `s6-deny-admin-off-${stamp}`, 'if-match': denyAdminOn.headers.etag,
    });
    check('DENY-ADMIN-OFF', denyAdminOff.status === 200, `status=${denyAdminOff.status}`);

    const auditApi = await startApi({ ...apiEnv, FAD_ENFORCEMENT_FAIL_AUDIT: 'true' });
    const auditFail = await call(auditApi.base, 'GET', `/v1/agents/${allowedId}`, keyA1.api_key);
    check('D08', auditFail.status === 503 && auditFail.json.error.code === 'DEPENDENCY_UNAVAILABLE' && !auditFail.text.includes(allowedId),
      `status=${auditFail.status}`);
    await auditApi.stop();

    await superuser.query('BEGIN');
    await superuser.query(`SELECT pg_advisory_xact_lock(6816, fad_s6_enforcement_key($1::uuid))`, [orgA.id]);
    const locked = await call(api.base, 'GET', `/v1/agents/${allowedId}`, keyA1.api_key);
    await superuser.query('COMMIT');
    const modeDuringLock = await superuser.query(`SELECT mode FROM fad_enforcement_configs WHERE organization_id = $1`, [orgA.id]);
    check('D10', locked.status === 503 && !locked.text.includes('"name"') && modeDuringLock.rows[0].mode === 'enforce', `status=${locked.status} mode=${modeDuringLock.rows[0].mode}`);

    const poolApi = await startApi({
      ...apiEnv,
      FAD_DB_POOL_MAX: '1',
      // 10000 is the largest lock wait the server accepts. A larger value falls back to 2000.
      FAD_ENFORCEMENT_LOCK_TIMEOUT_MS: '10000',
      FAD_HTTP_REQUEST_TIMEOUT_MS: '20000',
      FAD_SHUTDOWN_GRACE_MS: '20000',
    });
    await superuser.query('BEGIN');
    await superuser.query(`SELECT pg_advisory_xact_lock(6816, fad_s6_enforcement_key($1::uuid))`, [orgA.id]);
    const poolStarted = Date.now();
    const poolCall = () => call(poolApi.base, 'GET', `/v1/agents/${allowedId}`, keyA1.api_key).then((res) => ({ ...res, ms: Date.now() - poolStarted }));
    const poolFirst = poolCall();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const poolSecond = poolCall();
    await Promise.race([poolFirst, poolSecond]);
    await superuser.query('COMMIT');
    const poolBoth = await Promise.all([poolFirst, poolSecond]);
    const poolMode = await superuser.query(`SELECT mode FROM fad_enforcement_configs WHERE organization_id = $1`, [orgA.id]);
    const poolDenied = poolBoth.filter((item) => item.status === 503);
    const poolAllowed = poolBoth.filter((item) => item.status === 200);
    const poolDetail = `both=${poolBoth.map((item) => `${item.status}/${item.ms}`).join(',')} mode=${poolMode.rows[0]?.mode}`;
    notes.push(`${new Date().toISOString()} POOL ${poolDetail}`);
    check('POOL', poolDenied.length === 1 && poolAllowed.length === 1
      && poolDenied[0].json?.error?.code === 'DEPENDENCY_UNAVAILABLE'
      && poolDenied[0].ms >= 3500 && poolDenied[0].ms < 8000
      && poolAllowed[0].ms >= poolDenied[0].ms
      && !poolDenied[0].text.includes(allowedId) && !poolDenied[0].text.includes('"name"')
      && !poolAllowed[0].text.includes('"error"')
      && poolMode.rows[0]?.mode === 'enforce',
    poolDetail);
    await poolApi.stop();

    const liveConfig = await superuser.query(`SELECT mode, revision FROM fad_enforcement_configs WHERE organization_id = $1`, [orgA.id]);
    const liveDecisions = await superuser.query(`SELECT count(*)::int AS n FROM fad_enforcement_decisions WHERE organization_id = $1`, [orgA.id]);
    const liveRevisions = await superuser.query(`SELECT count(*)::int AS n FROM fad_enforcement_config_revisions WHERE organization_id = $1`, [orgA.id]);
    await docker(['exec', 'fad-s0-pg', 'pg_dump', '-U', 'postgres', '-d', 'fad', '-Fc', '-f', '/tmp/fad_s6_restore.dump']);
    await superuser.query('DROP DATABASE IF EXISTS fad_s6_restore');
    await superuser.query('CREATE DATABASE fad_s6_restore');
    await docker(['exec', 'fad-s0-pg', 'pg_restore', '-U', 'postgres', '-d', 'fad_s6_restore', '--no-owner', '--exit-on-error', '/tmp/fad_s6_restore.dump']);
    const restoreUrl = new URL(migratorUrl);
    restoreUrl.pathname = '/fad_s6_restore';
    const restoreClient = new PgClient({ connectionString: restoreUrl.toString(), application_name: 'fad-s6-restore' });
    await restoreClient.connect();
    const restoredConfig = await restoreClient.query(`SELECT mode, revision FROM fad_enforcement_configs WHERE organization_id = $1`, [orgA.id]);
    const restoredDecisions = await restoreClient.query(`SELECT count(*)::int AS n FROM fad_enforcement_decisions WHERE organization_id = $1`, [orgA.id]);
    const restoredRevisions = await restoreClient.query(`SELECT count(*)::int AS n FROM fad_enforcement_config_revisions WHERE organization_id = $1`, [orgA.id]);
    await restoreClient.end();
    const appRestoreUrl = new URL(appUrl);
    appRestoreUrl.pathname = '/fad_s6_restore';
    const restoredApp = new PgClient({ connectionString: appRestoreUrl.toString(), application_name: 'fad-s6-restore-app' });
    await restoredApp.connect();
    const hiddenRestore = await restoredApp.query('SELECT count(*)::int AS n FROM fad_enforcement_configs');
    await restoredApp.end();
    const liveAfterRestore = await superuser.query(`SELECT mode, revision FROM fad_enforcement_configs WHERE organization_id = $1`, [orgA.id]);
    const restoreDetail = `live=${liveConfig.rows[0]?.mode}/${liveConfig.rows[0]?.revision} restored=${restoredConfig.rows[0]?.mode}/${restoredConfig.rows[0]?.revision} decisions=${liveDecisions.rows[0]?.n}/${restoredDecisions.rows[0]?.n} revisions=${liveRevisions.rows[0]?.n}/${restoredRevisions.rows[0]?.n} hidden=${hiddenRestore.rows[0]?.n}`;
    notes.push(`${new Date().toISOString()} R16 ${restoreDetail}`);
    check('R16', restoredConfig.rows[0]?.mode === 'enforce' && liveConfig.rows[0]?.mode === 'enforce'
      && Number(restoredConfig.rows[0]?.revision) === Number(liveConfig.rows[0]?.revision)
      && restoredDecisions.rows[0]?.n === liveDecisions.rows[0]?.n
      && restoredRevisions.rows[0]?.n === liveRevisions.rows[0]?.n
      && hiddenRestore.rows[0]?.n === 0
      && liveAfterRestore.rows[0]?.mode === 'enforce'
      && Number(liveAfterRestore.rows[0]?.revision) === Number(liveConfig.rows[0]?.revision),
    restoreDetail);
    await superuser.query('DROP DATABASE IF EXISTS fad_s6_restore');
    await docker(['exec', 'fad-s0-pg', 'rm', '-f', '/tmp/fad_s6_restore.dump']);

    await app.query('BEGIN');
    await app.query(`SELECT set_config('fad.org_id', $1, true)`, [orgA.id]);
    const hiddenAgents = await app.query(`SELECT count(*)::int AS n FROM agents WHERE organization_id = $1`, [orgA.id]);
    await app.query('ROLLBACK');
    await app.query('BEGIN');
    await app.query(`SELECT set_config('fad.org_id', $1, true)`, [orgA.id]);
    await app.query(`SELECT set_config('fad.pep_generation', '6', true)`);
    const visibleAgents = await app.query(`SELECT count(*)::int AS n FROM agents WHERE organization_id = $1`, [orgA.id]);
    await app.query('ROLLBACK');
    check('S20', hiddenAgents.rows[0].n === 0 && visibleAgents.rows[0].n > 0, `hidden=${hiddenAgents.rows[0].n} visible=${visibleAgents.rows[0].n}`);

    await docker(['pause', 'fad-s0-pg']);
    let outage;
    try {
      outage = await call(api.base, 'GET', `/v1/agents/${allowedId}`, keyA1.api_key);
    } finally {
      await docker(['unpause', 'fad-s0-pg']);
    }
    const modeAfterOutage = await superuser.query(`SELECT mode FROM fad_enforcement_configs WHERE organization_id = $1`, [orgA.id]);
    check('D09', outage.status === 503 && outage.json?.error?.code === 'DEPENDENCY_UNAVAILABLE' && !outage.text.includes('"name"')
      && modeAfterOutage.rows[0].mode === 'enforce',
    `status=${outage.status} code=${outage.json?.error?.code} mode=${modeAfterOutage.rows[0]?.mode}`);

    const countRows = async () => superuser.query(
      `SELECT
         (SELECT count(*)::int FROM fad_enforcement_decisions WHERE organization_id = $1) AS decisions,
         (SELECT count(*)::int FROM fad_policy_decisions WHERE organization_id = $1) AS policy_decisions,
         (SELECT count(*)::int FROM audit_events WHERE organization_id = $1) AS audit_events`,
      [orgA.id],
    );
    const beforeSamples = await countRows();
    const samples = [];
    for (let index = 0; index < 100; index += 1) {
      const started = performance.now();
      const sample = await call(api.base, 'GET', `/v1/agents/${allowedId}`, keyA1.api_key);
      samples.push({ ms: performance.now() - started, status: sample.status });
    }
    const afterSamples = await countRows();
    const sorted = samples.map((item) => item.ms).sort((left, right) => left - right);
    const percentile = (ratio) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
    const growth = {
      decisions: afterSamples.rows[0].decisions - beforeSamples.rows[0].decisions,
      policy_decisions: afterSamples.rows[0].policy_decisions - beforeSamples.rows[0].policy_decisions,
      audit_events: afterSamples.rows[0].audit_events - beforeSamples.rows[0].audit_events,
    };
    note('R17', `n=100 p50=${percentile(0.5).toFixed(1)} p95=${percentile(0.95).toFixed(1)} p99=${percentile(0.99).toFixed(1)} max=${sorted.at(-1).toFixed(1)} ok=${samples.every((item) => item.status === 200)} decisions=${growth.decisions} policy_decisions=${growth.policy_decisions} audit_events=${growth.audit_events}`);
    check('R17-GROWTH', samples.every((item) => item.status === 200) && growth.decisions === 100 && growth.policy_decisions === 100,
      `decisions=${growth.decisions} policy_decisions=${growth.policy_decisions} audit_events=${growth.audit_events}`);

    const offPreflightRejected = await call(api.base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'off', actions: [], reason: `safe-off'); drop table agents;--`, acknowledge_default_deny: false, preflight_id: freshPre.json.data.preflight_id,
    }, { 'idempotency-key': `s6-off-pre-${stamp}`, 'if-match': updateAgain.headers.etag });
    const offPut = await call(api.base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'off', actions: [], reason: `safe-off'); drop table agents;--`, acknowledge_default_deny: false,
    }, { 'idempotency-key': `s6-off-${stamp}`, 'if-match': updateAgain.headers.etag });
    const agentsRemain = await superuser.query(`SELECT count(*)::int AS n FROM agents WHERE id = $1`, [allowedId]);
    const offAudit = await superuser.query(
      `SELECT count(*)::int AS n FROM audit_events WHERE organization_id = $1 AND action = 'enforcement.config_updated' AND details::text LIKE '%drop table%'`,
      [orgA.id],
    );
    check('OFF', offPreflightRejected.status === 422 && offPut.status === 200 && offPut.json.data.mode === 'off' && agentsRemain.rows[0].n === 1 && offAudit.rows[0].n === 0,
      `pre=${offPreflightRejected.status} put=${offPut.status} mode=${offPut.json?.data?.mode}`);
    const legacyAgain = await call(api.base, 'GET', `/v1/agents/${allowedId}`, keyA2.api_key);
    check('OFF-LEGACY', legacyAgain.status === 200 && legacyAgain.json.data.id === allowedId, `status=${legacyAgain.status}`);
    note('REQ-OFF', offPut.headers['x-request-id'] ?? '');
  } finally {
    writeFileSync(join(scratch, 'pep-journey.log'), `${notes.join('\n')}\n`);
    writeFileSync(join(scratch, 'rollout.log'), `${notes.filter((line) => /A0|A1|T0|OFF|P0/.test(line)).join('\n')}\n`);
    writeFileSync(join(scratch, 'isolation.log'), `${notes.filter((line) => /P1|C0|S0|D0|S2/.test(line)).join('\n')}\n`);
    writeFileSync(join(scratch, 'migration.log'), `${notes.filter((line) => line.includes('MIG') || line.includes('R13')).join('\n')}\n`);
    try { await superuser.query('ROLLBACK'); } catch { /* no open transaction */ }
    try { await superuser.query('ALTER TABLE fad_policies ENABLE TRIGGER fad_policy_guard'); } catch { /* trigger may already be enabled */ }
    try { await superuser.query('DROP DATABASE IF EXISTS fad_s6_restore'); } catch { /* restore database is absent after a committed drop */ }
    try { await docker(['exec', 'fad-s0-pg', 'rm', '-f', '/tmp/fad_s6_restore.dump']); } catch { /* dump file is removed with the container tmp */ }
    await api?.stop();
    await stopApis();
    await app.end();
    await superuser.end();
  }
});
