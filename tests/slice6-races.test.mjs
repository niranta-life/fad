import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { join } from 'node:path';
import test from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import pg from 'pg';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { compileContract } from '@fad/contract';
import { FadClient, PolicyDeniedError, ServiceUnavailableError } from '@fad/sdk';
import { admin, freePort, parseJson, request, requiredEnv, scratch, startApi } from './support.mjs';

const { Client: PgClient } = pg;
const appUrl = requiredEnv('DATABASE_URL');
const migratorUrl = requiredEnv('FAD_MIGRATOR_DATABASE_URL');
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
const WRITER = [
  'agents:read', 'agents:write', 'agents:lifecycle', 'tags:read', 'tags:write',
  'capabilities:read', 'capabilities:write', 'endpoints:read', 'endpoints:write',
].join(',');
const ACTIONS = ['agent.read', 'agent.discover', 'agent.update', 'agent.suspend'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function timed(work) {
  const started = Date.now();
  return Promise.resolve(work).then((result) => ({ ...result, ms: Date.now() - started, ended: Date.now() }));
}

async function created(args) {
  const result = await admin(args);
  if (result.code !== 0) throw new Error(`${args.slice(0, 2).join(' ')} ${result.stderr.slice(0, 240)}`);
  return parseJson(result.stdout);
}

function policy(name, effect, actions, principalIds, resource) {
  return {
    name,
    description: 'slice 6 race policy',
    effect,
    actions,
    subjects: { principal_ids: principalIds },
    resource,
  };
}

function dockerLogs(since) {
  return new Promise((resolve) => {
    const args = ['logs'];
    if (since) args.push('--since', since);
    args.push('fad-s0-pg');
    execFile('docker', args, { maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve(`${stdout ?? ''}\n${stderr ?? ''}${error ? `\n${error.message}` : ''}`);
    });
  });
}

function requestWithBody(base, method, path, key, body) {
  const payload = JSON.stringify(body);
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path,
      method,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'x-fad-api-key': key,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        const headers = {};
        for (const [name, value] of Object.entries(res.headers)) {
          headers[name] = Array.isArray(value) ? value.join(', ') : (value ?? '');
        }
        resolve({ status: res.statusCode ?? 0, headers, text, json });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('slice 6 deadlock, fences, and remaining local cases', { timeout: 600_000 }, async () => {
  const notes = [];
  const failures = [];
  let sequence = 0;
  const idem = (label) => `r6${label}${stamp}${(sequence += 1).toString(36)}`.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 120);
  const pass = (id, condition, detail = '') => {
    const line = `${new Date().toISOString()} ${condition ? 'PASS' : 'FAIL'} ${id} ${detail}`.trim();
    notes.push(line);
    if (!condition) {
      failures.push(line);
      console.error(line);
      return;
    }
    console.log(line);
  };
  const note = (id, detail) => {
    const line = `${new Date().toISOString()} NOTE ${id} ${detail}`;
    notes.push(line);
    console.log(line);
  };
  const must = (id, condition, detail = '') => {
    pass(id, condition, detail);
    if (!condition) throw new Error(`setup ${id}`);
  };
  async function stage(id, fn) {
    try {
      await fn();
    } catch (error) {
      const message = error instanceof Error ? error.message.replace(/\s+/g, ' ').slice(0, 240) : 'error';
      pass(id, false, `threw ${message}`);
    }
  }

  const superuser = new PgClient({ connectionString: migratorUrl, application_name: 'fad-s6-race-super' });
  const watcher = new PgClient({ connectionString: migratorUrl, application_name: 'fad-s6-race-watch' });
  const app = new PgClient({ connectionString: appUrl, application_name: 'fad-s6-race-app' });
  for (const client of [superuser, watcher, app]) client.on('error', () => undefined);
  await superuser.connect();
  await watcher.connect();
  await app.connect();
  const apis = [];
  let issuerServer;
  const openapiPath = new URL('../contracts/openapi.yaml', import.meta.url);
  let openapiOriginal;

  async function up(env) {
    const started = await startApi(env);
    apis.push(started);
    return started;
  }
  async function agentRow(orgId, agentId) {
    const result = await watcher.query(
      `SELECT name, revision::int AS revision, status FROM agents WHERE organization_id = $1 AND id = $2`,
      [orgId, agentId],
    );
    return result.rows[0] ?? null;
  }
  async function shareCount(orgId) {
    const result = await watcher.query(
      `SELECT count(*)::int AS n FROM pg_locks
       WHERE locktype = 'advisory' AND classid = 6816 AND objid = fad_s6_enforcement_key($1::uuid)
         AND mode = 'ShareLock' AND granted`,
      [orgId],
    );
    return result.rows[0].n;
  }
  async function waitShare(orgId, baseline) {
    const started = Date.now();
    while (Date.now() - started < 5000) {
      if (await shareCount(orgId) > baseline) return true;
      await sleep(40);
    }
    return false;
  }
  async function modeOf(orgId) {
    const result = await watcher.query(
      `SELECT mode, revision::int AS revision FROM fad_enforcement_configs WHERE organization_id = $1`,
      [orgId],
    );
    return result.rows[0] ?? { mode: 'off', revision: 0 };
  }

  try {
    const orgA = await created(['organization', 'create', '--name', `Race A ${stamp}`]);
    const orgB = await created(['organization', 'create', '--name', `Race B ${stamp}`]);
    const adminP = await created(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Race Admin']);
    const a1 = await created(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Race A1']);
    const both = await created(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Race Both']);
    const outsider = await created(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Race Outsider']);
    const writer = await created(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Race Writer']);
    const t7 = await created(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Race T7']);
    const t8 = await created(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Race T8']);
    const t9 = await created(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Race T9']);
    const adminB = await created(['principal', 'create', '--organization-id', orgB.id, '--type', 'service', '--name', 'Race B']);
    const issue = (org, principal, scopes) => created(['credential', 'issue', '--organization-id', org, '--principal-id', principal, '--scopes', scopes]);
    const keyAdmin = await issue(orgA.id, adminP.id, ADMIN);
    const keyA1 = await issue(orgA.id, a1.id, DIRECTORY);
    const keyBoth = await issue(orgA.id, both.id, DIRECTORY);
    const keyOut = await issue(orgA.id, outsider.id, DIRECTORY);
    const keyWriter = await issue(orgA.id, writer.id, WRITER);
    const keyT7 = await issue(orgA.id, t7.id, DIRECTORY);
    const keyT8 = await issue(orgA.id, t8.id, DIRECTORY);
    const keyT9 = await issue(orgA.id, t9.id, DIRECTORY);
    const keyB = await issue(orgB.id, adminB.id, ADMIN);
    const apiEnv = {
      FAD_POLICIES_ENABLED: 'true',
      FAD_TAGS_ENABLED: 'true',
      FAD_SLICE3_ENABLED: 'true',
      FAD_ENFORCEMENT_CODE_ENABLED: 'true',
      FAD_HTTP_REQUEST_TIMEOUT_MS: '20000',
      FAD_SHUTDOWN_GRACE_MS: '20000',
      FAD_DB_POOL_MAX: '8',
      FAD_RATE_LIMIT_MAX: '8000',
      FAD_ENFORCEMENT_LOCK_TIMEOUT_MS: '10000',
    };
    const api = await up(apiEnv);
    must('API', api.ready, `ready=${api.ready}`);
    const base = api.base;

    const config0 = await call(base, 'GET', '/v1/enforcement/config', keyAdmin.api_key);
    const spoof = await call(base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'off', actions: [], reason: 'spoofed organization header', acknowledge_default_deny: false,
    }, { 'idempotency-key': idem('s02'), 'if-match': config0.headers.etag, 'x-organization-id': orgB.id });
    const configB = await call(base, 'GET', '/v1/enforcement/config', keyB.api_key);
    const rowsB = await watcher.query(`SELECT count(*)::int AS n FROM fad_enforcement_configs WHERE organization_id = $1`, [orgB.id]);
    pass('S02', spoof.status === 200 && spoof.json?.data?.organization_id === orgA.id && spoof.json?.data?.mode === 'off'
      && configB.status === 200 && configB.json?.data?.organization_id === orgB.id && configB.json?.data?.mode === 'off'
      && configB.json?.data?.revision === 0 && rowsB.rows[0].n === 0,
    `put=${spoof.status} org=${spoof.json?.data?.organization_id} b=${configB.json?.data?.mode}/${configB.json?.data?.revision} rows=${rowsB.rows[0].n} req=${spoof.headers['x-request-id']}`);

    const huge = await call(base, 'POST', '/v1/enforcement/preflight', keyAdmin.api_key, {
      mode: 'shadow', actions: ['agent.read'], reason: 'a'.repeat(501),
    });
    pass('S13', huge.status === 422 && huge.json?.error?.code === 'VALIDATION_ERROR' && !huge.text.includes('a'.repeat(80)),
      `status=${huge.status} code=${huge.json?.error?.code} req=${huge.headers['x-request-id']}`);
    const invoke = await call(base, 'POST', '/v1/enforcement/preflight', keyAdmin.api_key, {
      mode: 'shadow', actions: ['agent.invoke'], reason: 'reject invoke',
    });
    const unknownAction = await call(base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'shadow', actions: ['agent.foo'], reason: 'reject unknown', acknowledge_default_deny: false,
    }, { 'idempotency-key': idem('s17'), 'if-match': spoof.headers.etag });
    pass('S17', invoke.status === 422 && unknownAction.status === 422
      && invoke.json?.error?.code === 'VALIDATION_ERROR' && unknownAction.json?.error?.code === 'VALIDATION_ERROR',
    `invoke=${invoke.status} foo=${unknownAction.status}`);

    async function makeAgent(name, ownerId, label) {
      const createdAgent = await call(base, 'POST', '/v1/agents', keyAdmin.api_key, {
        name, owner_principal_id: ownerId,
      }, { 'idempotency-key': idem(label) });
      if (createdAgent.status !== 201) throw new Error(`agent ${label} ${createdAgent.status} ${createdAgent.text.slice(0, 180)}`);
      return createdAgent.json.data.id;
    }
    const allowedId = await makeAgent('Allowed Anchor', a1.id, 'allow');
    const secondId = await makeAgent('Second Anchor', a1.id, 'second');
    const deniedId = await makeAgent('Denied Anchor', outsider.id, 'deny');
    const deadlockId = await makeAgent('Deadlock Target', adminP.id, 'dead');
    const fenceId = await makeAgent('Fence Target', adminP.id, 'fence');
    const tagRaceId = await makeAgent('Tag Race Target', adminP.id, 'tagrace');
    const retireId = await makeAgent('Retire Target', adminP.id, 'retire');
    const suspendId = await makeAgent('Suspend Target', adminP.id, 'suspend');
    const flagFalseId = await makeAgent('Flag False', t8.id, 'ff');
    const flagTrueId = await makeAgent('Flag True', t8.id, 'ft');
    const flagMissingId = await makeAgent('Flag Missing', t8.id, 'fm');
    const levelId = await makeAgent('Level One', t9.id, 'lvl');
    const tempId = await makeAgent('Temp Tag', t7.id, 'temp');
    const agentB = await call(base, 'POST', '/v1/agents', keyB.api_key, {
      name: 'Tenant B Only', owner_principal_id: adminB.id,
    }, { 'idempotency-key': idem('agentb') });
    must('AGENTS', agentB.status === 201, `b=${agentB.status}`);

    const define = (body, label) => call(base, 'POST', '/v1/tag-definitions', keyAdmin.api_key, body, { 'idempotency-key': idem(label) });
    const department = await define({ namespace: 'department', key: 'name', value_type: 'string', governed: false, visibility: 'internal' }, 'dept');
    const risk = await define({ namespace: 'security', key: 'risk', value_type: 'enum', enum_values: ['low', 'high'], governed: true, visibility: 'restricted' }, 'risk');
    const flag = await define({ namespace: 'security', key: 'flag', value_type: 'boolean', governed: true, visibility: 'restricted' }, 'flag');
    const level = await define({ namespace: 'security', key: 'level', value_type: 'integer', governed: true, visibility: 'restricted' }, 'level');
    const temp = await define({ namespace: 'security', key: 'temp', value_type: 'enum', enum_values: ['yes', 'no'], governed: true, visibility: 'restricted' }, 'temp');
    must('TAG-DEFS', [department, risk, flag, level, temp].every((item) => item.status === 201),
      [department, risk, flag, level, temp].map((item) => item.status).join(','));

    async function putTag(agentId, namespace, key, value, label, extra = {}) {
      return call(base, 'PUT', `/v1/agents/${agentId}/tags/${namespace}/${key}`, keyAdmin.api_key, { value, ...extra }, {
        'idempotency-key': idem(label), 'if-none-match': '*',
      });
    }
    const tagged = await Promise.all([
      putTag(allowedId, 'department', 'name', 'finance', 'dept-a'),
      putTag(allowedId, 'security', 'risk', 'high', 'risk-a', { reason: 'Classify allowed anchor' }),
      putTag(secondId, 'security', 'risk', 'high', 'risk-2', { reason: 'Classify second anchor' }),
      putTag(deadlockId, 'security', 'risk', 'high', 'risk-d', { reason: 'Classify deadlock target' }),
      putTag(fenceId, 'security', 'risk', 'high', 'risk-f', { reason: 'Classify fence target' }),
      putTag(tagRaceId, 'security', 'risk', 'high', 'risk-t', { reason: 'Classify tag race target' }),
      putTag(retireId, 'security', 'risk', 'high', 'risk-r', { reason: 'Classify retire target' }),
      putTag(suspendId, 'security', 'risk', 'high', 'risk-s', { reason: 'Classify suspend target' }),
      putTag(flagFalseId, 'security', 'flag', false, 'flag-f', { reason: 'Set flag false' }),
      putTag(flagTrueId, 'security', 'flag', true, 'flag-t', { reason: 'Set flag true' }),
      putTag(levelId, 'security', 'level', 1, 'level-1', { reason: 'Set level one' }),
      putTag(tempId, 'security', 'temp', 'yes', 'temp-y', { reason: 'Set temp yes' }),
    ]);
    must('TAG-ASSIGN', tagged.every((item) => item.status === 201), tagged.map((item) => `${item.status}`).join(','));

    const published = await call(base, 'POST', '/v1/capabilities', keyAdmin.api_key, {
      id: 's6.race.match', version: '1.0.0', display_name: 'Match', description: 'Race match contract',
      input_schema: SCHEMA, output_schema: SCHEMA,
    }, { 'idempotency-key': idem('cap') });
    async function bindAgent(agentId, label) {
      const endpoint = await call(base, 'PUT', `/v1/agents/${agentId}/endpoints/primary`, keyAdmin.api_key, {
        protocol: 'a2a', url: `https://ap.internal.example/${label}`, auth_scheme: 'oauth2',
      }, { 'idempotency-key': idem(`ep${label}`), 'if-none-match': '*' });
      const binding = await call(base, 'PUT', `/v1/agents/${agentId}/capabilities/s6.race.match`, keyAdmin.api_key, {
        version: '1.0.0', endpoint_key: 'primary',
      }, { 'idempotency-key': idem(`bind${label}`), 'if-none-match': '*' });
      return endpoint.status === 201 && binding.status === 201;
    }
    must('SLICE3', published.status === 201 && await bindAgent(allowedId, 'allow') && await bindAgent(retireId, 'retire'),
      `publish=${published.status}`);

    async function activate(body, label) {
      const draft = await call(base, 'POST', '/v1/policies', keyAdmin.api_key, body, { 'idempotency-key': idem(label) });
      const on = draft.status === 201
        ? await call(base, 'POST', `/v1/policies/${draft.json.data.id}/activate`, keyAdmin.api_key, undefined, {
          'idempotency-key': idem(`${label}on`), 'if-match': draft.headers.etag,
        })
        : draft;
      return { draft, on, id: draft.json?.data?.id, etag: on.headers?.etag };
    }
    const allowBody = () => policy('Allow governed race', 'allow', ['agent.read', 'agent.discover', 'agent.update'], [adminP.id, a1.id, both.id], {
      type: 'agent', tags_all: [{ namespace: 'security', key: 'risk', operator: 'eq', value: 'high' }],
    });
    let allow = await activate(allowBody(), 'allow');
    const deny = await activate(policy('Deny both', 'deny', ['agent.read'], [both.id], {
      type: 'agent', agent_ids: [allowedId],
    }), 'deny');
    const suspendAllow = await activate(policy('Allow suspend race', 'allow', ['agent.suspend'], [adminP.id], {
      type: 'agent', agent_ids: [suspendId, fenceId],
    }), 'sus');
    const flagAllow = await activate(policy('Allow flag false', 'allow', ['agent.read'], [t8.id], {
      type: 'agent', tags_all: [{ namespace: 'security', key: 'flag', operator: 'eq', value: false }],
    }), 'flag');
    const levelAllow = await activate(policy('Allow level one', 'allow', ['agent.read'], [t9.id], {
      type: 'agent', tags_all: [{ namespace: 'security', key: 'level', operator: 'eq', value: 1 }],
    }), 'lvl');
    const tempAllow = await activate(policy('Allow temp yes', 'allow', ['agent.read', 'agent.update'], [t7.id, adminP.id], {
      type: 'agent', tags_all: [{ namespace: 'security', key: 'temp', operator: 'eq', value: 'yes' }],
    }), 'temp');
    const tagRaceAllow = await activate(policy('Allow tag race restore', 'allow', ['agent.update'], [adminP.id], {
      type: 'agent', agent_ids: [tagRaceId],
    }), 'tagrace');
    const unknownPolicy = await call(base, 'POST', '/v1/policies', keyAdmin.api_key, policy('Unknown tag', 'allow', ['agent.read'], [t7.id], {
      type: 'agent', tags_all: [{ namespace: 'mystery', key: 'gone', operator: 'eq', value: 'yes' }],
    }), { 'idempotency-key': idem('mystery') });
    const stringLevel = await call(base, 'POST', '/v1/policies', keyAdmin.api_key, policy('String level', 'allow', ['agent.read'], [t9.id], {
      type: 'agent', tags_all: [{ namespace: 'security', key: 'level', operator: 'eq', value: '1' }],
    }), { 'idempotency-key': idem('strlvl') });
    must('POLICIES', [allow, deny, suspendAllow, flagAllow, levelAllow, tempAllow, tagRaceAllow].every((item) => item.on.status === 200),
      [allow, deny, suspendAllow, flagAllow, levelAllow, tempAllow, tagRaceAllow].map((item) => item.on.status).join(','));
    pass('T07-UNKNOWN', unknownPolicy.status === 422 && unknownPolicy.json?.error?.code === 'VALIDATION_ERROR',
      `status=${unknownPolicy.status} code=${unknownPolicy.json?.error?.code}`);
    pass('T09-STRING', stringLevel.status === 422 && stringLevel.json?.error?.code === 'VALIDATION_ERROR',
      `status=${stringLevel.status} code=${stringLevel.json?.error?.code}`);

    const current = async () => call(base, 'GET', '/v1/enforcement/config', keyAdmin.api_key);
    let config = await current();
    const preflight = await call(base, 'POST', '/v1/enforcement/preflight', keyAdmin.api_key, {
      mode: 'enforce', actions: ACTIONS, reason: 'race enforce preflight',
    });
    const preflightAsKey = await call(base, 'GET', `/v1/agents/${allowedId}`, preflight.json?.data?.preflight_id);
    const preflightAsBearer = await request(`${base}/v1/agents/${allowedId}`, {
      headers: { authorization: `Bearer ${preflight.json?.data?.preflight_id ?? 'missing'}` },
    });
    pass('S15', preflight.status === 200 && preflightAsKey.status === 401 && preflightAsBearer.status === 401,
      `preflight=${preflight.status} key=${preflightAsKey.status} bearer=${preflightAsBearer.status}`);
    const enforcePut = await call(base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'enforce', actions: ACTIONS, reason: 'race enforce preflight',
      preflight_id: preflight.json?.data?.preflight_id, acknowledge_default_deny: true,
    }, { 'idempotency-key': idem('enf'), 'if-match': config.headers.etag });
    const decisionProbe = await call(base, 'GET', `/v1/agents/${allowedId}`, keyA1.api_key);
    const decisionRow = await watcher.query(
      `SELECT id FROM fad_enforcement_decisions WHERE organization_id = $1 AND request_id = $2 LIMIT 1`,
      [orgA.id, decisionProbe.headers['x-request-id']],
    );
    const decision = decisionRow.rows[0]
      ? await call(base, 'GET', `/v1/enforcement/decisions/${decisionRow.rows[0].id}`, keyAdmin.api_key)
      : { status: 0, json: null, headers: {} };
    const cacheHits = [config, preflight, enforcePut, decision].map((item) => item.headers?.['cache-control']);
    const requestIds = [config, preflight, enforcePut, decision].map((item) => item.headers?.['x-request-id']);
    pass('A24', enforcePut.status === 200 && cacheHits.every((value) => value === 'private, no-store')
      && requestIds.every((value) => UUID.test(value ?? '')),
    `put=${enforcePut.status} cache=${cacheHits.join('|')} req=${requestIds.join(',')}`);
    let schemasOk = false;
    let schemaDetail = '';
    try {
      const contract = compileContract();
      contract.validate('EnforcementConfigResponse', enforcePut.json);
      contract.validate('EnforcementPreflightResponse', preflight.json);
      contract.validate('EnforcementDecisionResponse', decision.json);
      schemasOk = decision.status === 200;
      schemaDetail = `decision=${decision.status}`;
    } catch (error) {
      schemaDetail = error instanceof Error ? error.message.slice(0, 300) : 'schema error';
    }
    pass('A22', schemasOk, schemaDetail);
    must('ENFORCE', enforcePut.status === 200 && enforcePut.json?.data?.mode === 'enforce', enforcePut.text.slice(0, 240));

    async function installSleep() {
      await superuser.query(`
        CREATE OR REPLACE FUNCTION fad_s6_test_sleep() RETURNS trigger
        LANGUAGE plpgsql AS $fn$
        BEGIN
          PERFORM pg_sleep(2.5);
          RETURN NEW;
        END;
        $fn$`);
      await superuser.query(`DROP TRIGGER IF EXISTS fad_s6_test_sleep ON fad_enforcement_decisions`);
      await superuser.query(`
        CREATE TRIGGER fad_s6_test_sleep
        AFTER INSERT ON fad_enforcement_decisions
        FOR EACH ROW EXECUTE FUNCTION fad_s6_test_sleep()`);
    }
    async function dropSleep() {
      await superuser.query(`DROP TRIGGER IF EXISTS fad_s6_test_sleep ON fad_enforcement_decisions`);
      await superuser.query(`DROP FUNCTION IF EXISTS fad_s6_test_sleep()`);
    }

    const beforeDead = await agentRow(orgA.id, deadlockId);
    const deadEtag = `"agent-v${beforeDead.revision}"`;
    await superuser.query(`ALTER DATABASE fad SET log_min_messages TO 'log'`);
    await superuser.query(`ALTER DATABASE fad SET log_lock_waits TO on`);
    const probe = new PgClient({ connectionString: migratorUrl, application_name: 'fad-s6-race-log' });
    probe.on('error', () => undefined);
    await probe.connect();
    const shown = await probe.query(`SHOW log_min_messages`);
    await probe.end();
    note('LOG-LEVEL', `new_connection=${shown.rows[0].log_min_messages}`);
    const deadlockApi = await up({
      ...apiEnv,
      FAD_ENFORCEMENT_LOCK_TIMEOUT_MS: '10000',
      FAD_HTTP_REQUEST_TIMEOUT_MS: '20000',
      FAD_SHUTDOWN_GRACE_MS: '20000',
      FAD_DB_POOL_MAX: '4',
    });
    pass('DEAD-API', deadlockApi.ready && shown.rows[0].log_min_messages === 'log', `ready=${deadlockApi.ready}`);
    const deadlocksBefore = await watcher.query(`SELECT deadlocks::int AS n FROM pg_stat_database WHERE datname = current_database()`);
    const deadSince = new Date(Date.now() - 1000).toISOString();
    await superuser.query('BEGIN');
    await superuser.query(`SET LOCAL deadlock_timeout = '30s'`);
    await superuser.query(`SELECT id FROM agents WHERE organization_id = $1 AND id = $2 FOR UPDATE`, [orgA.id, deadlockId]);
    const locksBefore = await shareCount(orgA.id);
    const deadPatch = timed(call(deadlockApi.base, 'PATCH', `/v1/agents/${deadlockId}`, keyAdmin.api_key, {
      name: 'Deadlock Target Moved',
    }, { 'idempotency-key': idem('dead'), 'if-match': deadEtag }));
    const deadHeld = await waitShare(orgA.id, locksBefore);
    let deadWaiting = false;
    const waitStarted = Date.now();
    while (Date.now() - waitStarted < 4000) {
      const waiting = await watcher.query(`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`);
      if (waiting.rows[0].n > 0) {
        deadWaiting = true;
        break;
      }
      await sleep(40);
    }
    const deadLock = superuser.query(`SELECT pg_advisory_xact_lock(6816, fad_s6_enforcement_key($1::uuid))`, [orgA.id]);
    const deadResult = await deadPatch;
    let deadLockCode = 'ok';
    try {
      await deadLock;
    } catch (error) {
      deadLockCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'error';
    }
    try { await superuser.query('ROLLBACK'); } catch { /* aborted transaction */ }
    await sleep(1200);
    const deadLog = await dockerLogs(deadSince);
    const deadLines = deadLog.split('\n').filter((line) => /detected deadlock|deadlock detected|lock timeout|canceling statement|still waiting/i.test(line));
    const deadlocksAfter = await watcher.query(`SELECT deadlocks::int AS n FROM pg_stat_database WHERE datname = current_database()`);
    const afterDead = await agentRow(orgA.id, deadlockId);
    const deadMode = await modeOf(orgA.id);
    const deadlockLogged = deadLines.some((line) => /detected deadlock|deadlock detected/i.test(line));
    pass('D-DEADLOCK', deadHeld && deadWaiting && deadResult.status === 503 && deadResult.json?.error?.code === 'DEPENDENCY_UNAVAILABLE'
      && deadResult.ms >= 400 && deadResult.ms < 6000 && deadlockLogged
      && deadlocksAfter.rows[0].n > deadlocksBefore.rows[0].n
      && afterDead.name === 'Deadlock Target' && afterDead.revision === beforeDead.revision
      && deadMode.mode === 'enforce' && !deadResult.text.includes('Deadlock Target Moved'),
    `held=${deadHeld} waiting=${deadWaiting} status=${deadResult.status} ms=${deadResult.ms} log=${deadLines.length} deadlocks=${deadlocksBefore.rows[0].n}->${deadlocksAfter.rows[0].n} lock=${deadLockCode} name=${afterDead?.name} rev=${afterDead?.revision} mode=${deadMode.mode} req=${deadResult.headers?.['x-request-id']}`);
    note('D-DEADLOCK-LOG', deadLines.slice(0, 4).join(' | ').slice(0, 700) || 'no deadlock line');
    note('D-DEADLOCK-API', deadlockApi.logs().replace(/\s+/g, ' ').slice(-500));
    await deadlockApi.stop();
    await superuser.query(`ALTER DATABASE fad RESET log_min_messages`);
    await superuser.query(`ALTER DATABASE fad RESET log_lock_waits`);

    await installSleep();
    try {
      config = await current();
      const d01Pre = await call(base, 'POST', '/v1/enforcement/preflight', keyAdmin.api_key, {
        mode: 'enforce', actions: ACTIONS, reason: 'serialize config read',
      });
      const d01Before = await modeOf(orgA.id);
      const d01Locks = await shareCount(orgA.id);
      const d01Read = timed(call(base, 'GET', `/v1/agents/${allowedId}`, keyA1.api_key));
      const d01Held = await waitShare(orgA.id, d01Locks);
      const d01Write = timed(call(base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
        mode: 'enforce', actions: ACTIONS, reason: 'serialize config read',
        preflight_id: d01Pre.json?.data?.preflight_id, acknowledge_default_deny: true,
      }, { 'idempotency-key': idem('d01'), 'if-match': config.headers.etag }));
      const d01Got = await d01Read;
      const d01Put = await d01Write;
      const d01After = await modeOf(orgA.id);
      pass('D01', d01Pre.status === 200 && d01Held && d01Got.status === 200 && d01Got.json?.data?.id === allowedId
        && d01Put.status === 200 && d01Put.ended >= d01Got.ended && d01After.revision === d01Before.revision + 1
        && d01After.mode === 'enforce' && d01Put.json?.data?.mode === 'enforce',
      `held=${d01Held} get=${d01Got.status}/${d01Got.ms} put=${d01Put.status}/${d01Put.ms} rev=${d01Before.revision}->${d01After.revision} req=${d01Got.headers?.['x-request-id']}`);

      const tagBefore = await watcher.query(
        `SELECT tag_value FROM agent_tag_assignments WHERE organization_id = $1 AND agent_id = $2 AND namespace = 'security' AND tag_key = 'risk'`,
        [orgA.id, tagRaceId],
      );
      const tagGet = await call(base, 'GET', `/v1/agents/${tagRaceId}/tags/security/risk`, keyAdmin.api_key);
      const d03Locks = await shareCount(orgA.id);
      const d03Read = timed(call(base, 'GET', `/v1/agents/${tagRaceId}`, keyAdmin.api_key));
      const d03Held = await waitShare(orgA.id, d03Locks);
      let midTag = null;
      if (d03Held) {
        const mid = await watcher.query(
          `SELECT tag_value FROM agent_tag_assignments WHERE organization_id = $1 AND agent_id = $2 AND namespace = 'security' AND tag_key = 'risk'`,
          [orgA.id, tagRaceId],
        );
        midTag = mid.rows[0]?.tag_value;
      }
      const d03Write = timed(call(base, 'PUT', `/v1/agents/${tagRaceId}/tags/security/risk`, keyAdmin.api_key, {
        value: 'low', reason: 'Race the governed tag',
      }, { 'idempotency-key': idem('d03'), 'if-match': tagGet.headers.etag }));
      const d03Got = await d03Read;
      const d03Put = await d03Write;
      const tagAfter = await watcher.query(
        `SELECT tag_value FROM agent_tag_assignments WHERE organization_id = $1 AND agent_id = $2 AND namespace = 'security' AND tag_key = 'risk'`,
        [orgA.id, tagRaceId],
      );
      const afterLow = await call(base, 'GET', `/v1/agents/${tagRaceId}`, keyA1.api_key);
      const restored = await call(base, 'PUT', `/v1/agents/${tagRaceId}/tags/security/risk`, keyAdmin.api_key, {
        value: 'high', reason: 'Restore the governed tag',
      }, { 'idempotency-key': idem('d03r'), 'if-match': d03Put.headers?.etag });
      const afterHigh = await call(base, 'GET', `/v1/agents/${tagRaceId}`, keyA1.api_key);
      pass('D03', tagGet.status === 200 && d03Held && JSON.stringify(midTag) === '"high"' && d03Got.status === 200
        && d03Put.status === 200 && d03Put.ended >= d03Got.ended && JSON.stringify(tagAfter.rows[0]?.tag_value) === '"low"'
        && afterLow.status === 404 && restored.status === 200 && afterHigh.status === 200,
      `held=${d03Held} mid=${JSON.stringify(midTag)} get=${d03Got.status} put=${d03Put.status} after=${JSON.stringify(tagAfter.rows[0]?.tag_value)} low=${afterLow.status} restore=${restored.status} high=${afterHigh.status} before=${JSON.stringify(tagBefore.rows[0]?.tag_value)}`);

      const d06Before = await agentRow(orgA.id, fenceId);
      const d06AuditBefore = await watcher.query(
        `SELECT count(*)::int AS n FROM audit_events WHERE organization_id = $1 AND target_id = $2 AND action = 'agent.updated'`,
        [orgA.id, fenceId],
      );
      const d06RevBefore = await watcher.query(
        `SELECT count(*)::int AS n FROM agent_revisions WHERE organization_id = $1 AND agent_id = $2`,
        [orgA.id, fenceId],
      );
      const d06DecBefore = await watcher.query(
        `SELECT count(*)::int AS n FROM fad_enforcement_decisions WHERE organization_id = $1 AND agent_id = $2`,
        [orgA.id, fenceId],
      );
      const d06Locks = await shareCount(orgA.id);
      const d06Patch = timed(call(base, 'PATCH', `/v1/agents/${fenceId}`, keyAdmin.api_key, {
        name: 'Fence Committed',
      }, { 'idempotency-key': idem('d06'), 'if-match': `"agent-v${d06Before.revision}"` }));
      const d06Held = await waitShare(orgA.id, d06Locks);
      const d06Mid = d06Held ? await agentRow(orgA.id, fenceId) : null;
      const d06MidAudit = d06Held ? await watcher.query(
        `SELECT count(*)::int AS n FROM audit_events WHERE organization_id = $1 AND target_id = $2 AND action = 'agent.updated'`,
        [orgA.id, fenceId],
      ) : { rows: [{ n: -1 }] };
      const d06Got = await d06Patch;
      const d06After = await agentRow(orgA.id, fenceId);
      const d06Audit = await watcher.query(
        `SELECT count(*)::int AS n FROM audit_events WHERE organization_id = $1 AND target_id = $2 AND action = 'agent.updated'`,
        [orgA.id, fenceId],
      );
      const d06Rev = await watcher.query(
        `SELECT count(*)::int AS n FROM agent_revisions WHERE organization_id = $1 AND agent_id = $2`,
        [orgA.id, fenceId],
      );
      const d06Dec = await watcher.query(
        `SELECT count(*)::int AS n FROM fad_enforcement_decisions WHERE organization_id = $1 AND request_id = $2`,
        [orgA.id, d06Got.headers?.['x-request-id']],
      );
      pass('D06', d06Held && d06Mid?.name === d06Before.name && d06MidAudit.rows[0].n === d06AuditBefore.rows[0].n
        && d06Got.status === 200 && d06After.name === 'Fence Committed' && d06After.revision === d06Before.revision + 1
        && d06Audit.rows[0].n === d06AuditBefore.rows[0].n + 1 && d06Rev.rows[0].n === d06RevBefore.rows[0].n + 1
        && d06Dec.rows[0].n === 1 && d06DecBefore.rows[0].n >= 0,
      `held=${d06Held} mid=${d06Mid?.name} status=${d06Got.status} rev=${d06Before.revision}->${d06After?.revision} audit=${d06AuditBefore.rows[0].n}->${d06Audit.rows[0].n} revisions=${d06RevBefore.rows[0].n}->${d06Rev.rows[0].n} decision=${d06Dec.rows[0].n} req=${d06Got.headers?.['x-request-id']}`);

      const d07Before = await watcher.query(
        `SELECT count(*)::int AS n FROM fad_enforcement_decisions WHERE organization_id = $1 AND actor_principal_id = $2`,
        [orgA.id, both.id],
      );
      const d07Locks = await shareCount(orgA.id);
      const d07Read = timed(call(base, 'GET', `/v1/agents/${allowedId}`, keyBoth.api_key));
      const d07Held = await waitShare(orgA.id, d07Locks);
      const d07Mid = d07Held ? await watcher.query(
        `SELECT count(*)::int AS n FROM fad_enforcement_decisions WHERE organization_id = $1 AND actor_principal_id = $2`,
        [orgA.id, both.id],
      ) : { rows: [{ n: -1 }] };
      const d07Got = await d07Read;
      const d07After = await watcher.query(
        `SELECT count(*)::int AS n, bool_or(request_id::text = $3) AS matched
         FROM fad_enforcement_decisions WHERE organization_id = $1 AND actor_principal_id = $2`,
        [orgA.id, both.id, d07Got.headers?.['x-request-id'] ?? randomUUID()],
      );
      pass('D07', d07Held && d07Mid.rows[0].n === d07Before.rows[0].n && d07Got.status === 404
        && d07Got.json?.error?.code === 'AGENT_NOT_FOUND' && d07After.rows[0].n === d07Before.rows[0].n + 1
        && d07After.rows[0].matched === true && !d07Got.text.includes(allowedId),
      `held=${d07Held} mid=${d07Mid.rows[0].n} after=${d07After.rows[0].n} matched=${d07After.rows[0].matched} status=${d07Got.status} req=${d07Got.headers?.['x-request-id']}`);

      const d02Before = await agentRow(orgA.id, fenceId);
      const d02Locks = await shareCount(orgA.id);
      const d02Patch = timed(call(base, 'PATCH', `/v1/agents/${fenceId}`, keyAdmin.api_key, {
        name: 'Fence After Disable',
      }, { 'idempotency-key': idem('d02'), 'if-match': `"agent-v${d02Before.revision}"` }));
      const d02Held = await waitShare(orgA.id, d02Locks);
      const d02Disable = timed(call(base, 'POST', `/v1/policies/${allow.id}/disable`, keyAdmin.api_key, undefined, {
        'idempotency-key': idem('d02off'), 'if-match': allow.etag,
      }));
      const d02Got = await d02Patch;
      const d02Off = await d02Disable;
      const d02Policy = await call(base, 'GET', `/v1/policies/${allow.id}`, keyAdmin.api_key);
      const d02Next = await call(base, 'PATCH', `/v1/agents/${fenceId}`, keyAdmin.api_key, {
        name: 'Fence Should Deny',
      }, { 'idempotency-key': idem('d02next'), 'if-match': d02Got.headers?.etag ?? `"agent-v${d02Before.revision}"` });
      allow = await activate(allowBody(), 'allow2');
      const d02Restored = await call(base, 'GET', `/v1/agents/${allowedId}`, keyA1.api_key);
      pass('D02', d02Held && d02Got.status === 200 && d02Off.status === 200 && d02Off.ended >= d02Got.ended
        && d02Policy.json?.data?.status === 'disabled' && d02Next.status === 403 && d02Next.json?.error?.code === 'POLICY_DENIED'
        && allow.on.status === 200 && d02Restored.status === 200,
      `held=${d02Held} patch=${d02Got.status}/${d02Got.ms} disable=${d02Off.status}/${d02Off.ms} policy=${d02Policy.json?.data?.status} next=${d02Next.status} restore=${allow.on.status} get=${d02Restored.status}`);
    } finally {
      await dropSleep();
    }

    const d04Before = await agentRow(orgA.id, fenceId);
    const d04Etag = `"agent-v${d04Before.revision}"`;
    const d04Patch = timed(call(base, 'PATCH', `/v1/agents/${fenceId}`, keyAdmin.api_key, { name: 'Fence Raced' }, {
      'idempotency-key': idem('d04p'), 'if-match': d04Etag,
    }));
    const d04Suspend = timed(call(base, 'POST', `/v1/agents/${fenceId}/suspend`, keyAdmin.api_key, { reason: 'Race suspend' }, {
      'idempotency-key': idem('d04s'), 'if-match': d04Etag,
    }));
    const d04Results = await Promise.all([d04Patch, d04Suspend]);
    const d04After = await agentRow(orgA.id, fenceId);
    const d04Statuses = d04Results.map((item) => item.status).sort((left, right) => left - right);
    const d04PatchWon = d04Results[0].status === 200;
    const d04Detail = d04Results.map((item) => `${item.status}/${item.json?.error?.code ?? 'ok'}/${item.ms}ms`).join(',');
    pass('D04', d04Statuses[0] === 200 && d04Statuses[1] === 412 && d04After.revision === d04Before.revision + 1
      && (d04PatchWon ? d04After.name === 'Fence Raced' && d04After.status === 'active' : d04After.name === d04Before.name && d04After.status === 'suspended'),
    `status=${d04Detail} rev=${d04Before.revision}->${d04After.revision} name=${d04After.name} state=${d04After.status}`);

    const d05Before = await agentRow(orgA.id, secondId);
    const d05Key = idem('d05');
    const d05Body = { name: 'Second Replay' };
    const d05First = await call(base, 'PATCH', `/v1/agents/${secondId}`, keyAdmin.api_key, d05Body, {
      'idempotency-key': d05Key, 'if-match': `"agent-v${d05Before.revision}"`,
    });
    const d05Mid = await agentRow(orgA.id, secondId);
    const d05Second = await call(base, 'PATCH', `/v1/agents/${secondId}`, keyAdmin.api_key, d05Body, {
      'idempotency-key': d05Key, 'if-match': `"agent-v${d05Before.revision}"`,
    });
    const d05After = await agentRow(orgA.id, secondId);
    pass('D05', d05First.status === 200 && d05Second.status === 200 && d05Mid.revision === d05After.revision
      && d05After.revision === d05Before.revision + 1 && d05After.name === 'Second Replay',
    `first=${d05First.status} second=${d05Second.status} rev=${d05Before.revision}->${d05Mid.revision}->${d05After.revision}`);

    const d12Draft = await call(base, 'POST', '/v1/policies', keyAdmin.api_key, policy('Race draft', 'allow', ['agent.read'], [adminP.id], {
      type: 'agent', agent_ids: [secondId],
    }), { 'idempotency-key': idem('d12c') });
    const d12Body = { ...policy('Race draft revised', 'allow', ['agent.read'], [adminP.id], { type: 'agent', agent_ids: [secondId] }), description: 'revision two' };
    const d12a = call(base, 'PUT', `/v1/policies/${d12Draft.json.data.id}`, keyAdmin.api_key, d12Body, {
      'idempotency-key': idem('d12a'), 'if-match': d12Draft.headers.etag,
    });
    const d12b = call(base, 'PUT', `/v1/policies/${d12Draft.json.data.id}`, keyAdmin.api_key, d12Body, {
      'idempotency-key': idem('d12b'), 'if-match': d12Draft.headers.etag,
    });
    const d12Results = await Promise.all([d12a, d12b]);
    const d12Rev = await watcher.query(`SELECT count(*)::int AS n, max(revision)::int AS max FROM fad_policy_revisions WHERE policy_id = $1`, [d12Draft.json.data.id]);
    const d12Statuses = d12Results.map((item) => item.status).sort((left, right) => left - right);
    pass('D12', d12Draft.status === 201 && d12Statuses[0] === 200 && (d12Statuses[1] === 412 || d12Statuses[1] === 409)
      && d12Rev.rows[0].max === 2 && d12Rev.rows[0].n === 2,
    `create=${d12Draft.status} status=${d12Statuses.join(',')} revisions=${d12Rev.rows[0].n} max=${d12Rev.rows[0].max}`);

    config = await current();
    const d14Before = config.json.data.revision;
    const d14Pre = await call(base, 'POST', '/v1/enforcement/preflight', keyAdmin.api_key, {
      mode: 'enforce', actions: ACTIONS, reason: 'consume preflight once',
    });
    const d14Body = {
      mode: 'enforce', actions: ACTIONS, reason: 'consume preflight once',
      preflight_id: d14Pre.json?.data?.preflight_id, acknowledge_default_deny: true,
    };
    const d14a = call(base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, d14Body, {
      'idempotency-key': idem('d14a'), 'if-match': config.headers.etag,
    });
    const d14b = call(base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, d14Body, {
      'idempotency-key': idem('d14b'), 'if-match': config.headers.etag,
    });
    const d14Results = await Promise.all([d14a, d14b]);
    const d14After = await modeOf(orgA.id);
    const d14Statuses = d14Results.map((item) => item.status).sort((left, right) => left - right);
    pass('D14', d14Pre.status === 200 && d14Statuses[0] === 200 && (d14Statuses[1] === 409 || d14Statuses[1] === 412)
      && d14After.revision === d14Before + 1 && d14After.mode === 'enforce',
    `preflight=${d14Pre.status} status=${d14Statuses.join(',')} rev=${d14Before}->${d14After.revision}`);

    const page = await call(base, 'GET', '/v1/agents?limit=1', keyA1.api_key);
    const cursor = page.json?.meta?.next_cursor;
    const filtered = await call(base, 'GET', `/v1/agents?limit=1&status=active&cursor=${encodeURIComponent(cursor ?? '')}`, keyA1.api_key);
    pass('C06', page.status === 200 && typeof cursor === 'string' && cursor.length > 20
      && filtered.status === 400 && filtered.json?.error?.code === 'VALIDATION_ERROR'
      && !filtered.text.includes(allowedId) && !filtered.text.includes(secondId),
    `page=${page.status} cursor=${typeof cursor} filter=${filtered.status} code=${filtered.json?.error?.code}`);

    const tagRead = await call(base, 'GET', `/v1/agents/${allowedId}/tags/department/name`, keyA1.api_key);
    const endpointRead = await call(base, 'GET', `/v1/agents/${allowedId}/endpoints/primary`, keyA1.api_key);
    const bindingRead = await call(base, 'GET', `/v1/agents/${allowedId}/capabilities/s6.race.match`, keyA1.api_key);
    const tagHide = await call(base, 'GET', `/v1/agents/${allowedId}/tags/department/name`, keyOut.api_key);
    const endpointHide = await call(base, 'GET', `/v1/agents/${allowedId}/endpoints/primary`, keyOut.api_key);
    const bindingHide = await call(base, 'GET', `/v1/agents/${allowedId}/capabilities/s6.race.match`, keyOut.api_key);
    pass('P11', tagRead.status === 200 && tagRead.json?.data?.value === 'finance'
      && endpointRead.status === 200 && bindingRead.status === 200
      && [tagHide, endpointHide, bindingHide].every((item) => item.status === 404 && item.json?.error?.code === 'AGENT_NOT_FOUND')
      && !tagHide.text.includes('finance') && !endpointHide.text.includes('ap.internal.example'),
    `read=${tagRead.status}/${endpointRead.status}/${bindingRead.status} hide=${tagHide.status}/${endpointHide.status}/${bindingHide.status}`);

    const p06 = await call(base, 'GET', `/v1/agents/${allowedId}`, keyBoth.api_key);
    const p06Row = await watcher.query(
      `SELECT reason_code, outcome FROM fad_enforcement_decisions WHERE organization_id = $1 AND request_id = $2`,
      [orgA.id, p06.headers['x-request-id']],
    );
    const evaluated = await call(base, 'POST', '/v1/authorization/evaluate', keyAdmin.api_key, {
      subject: { principal_id: both.id }, action: 'agent.read', resource: { type: 'agent', id: allowedId },
    });
    pass('P06', p06.status === 404 && p06.json?.error?.code === 'AGENT_NOT_FOUND' && p06Row.rows[0]?.reason_code === 'EXPLICIT_DENY'
      && p06Row.rows[0]?.outcome === 'denied' && !p06.text.includes(allowedId),
    `status=${p06.status} reason=${p06Row.rows[0]?.reason_code} outcome=${p06Row.rows[0]?.outcome} req=${p06.headers['x-request-id']}`);
    const dist = readFileSync(new URL('../packages/db/dist/enforcement.js', import.meta.url), 'utf8');
    pass('P26', evaluated.status === 200 && evaluated.json?.data?.enforcement === 'not_enforced'
      && evaluated.json?.data?.reason_code === 'EXPLICIT_DENY' && p06Row.rows[0]?.reason_code === 'EXPLICIT_DENY'
      && dist.includes('evaluatePolicies(') && !dist.includes('function evaluatePolicies'),
    `eval=${evaluated.json?.data?.decision}/${evaluated.json?.data?.reason_code}/${evaluated.json?.data?.enforcement} pep=${p06Row.rows[0]?.reason_code}`);

    const endpointEtag = endpointRead.headers.etag;
    const writerEndpoint = await call(base, 'PUT', `/v1/agents/${allowedId}/endpoints/primary`, keyWriter.api_key, {
      protocol: 'a2a', url: 'https://ap.internal.example/writer-denied', auth_scheme: 'oauth2',
    }, { 'idempotency-key': idem('p12e'), 'if-match': endpointEtag });
    const writerBinding = await call(base, 'PUT', `/v1/agents/${allowedId}/capabilities/s6.race.match`, keyWriter.api_key, {
      version: '1.0.0', endpoint_key: 'primary',
    }, { 'idempotency-key': idem('p12b'), 'if-match': bindingRead.headers.etag });
    const adminEndpoint = await call(base, 'PUT', `/v1/agents/${allowedId}/endpoints/primary`, keyAdmin.api_key, {
      protocol: 'a2a', url: 'https://ap.internal.example/admin-updated', auth_scheme: 'oauth2',
    }, { 'idempotency-key': idem('p12a'), 'if-match': endpointEtag });
    pass('P12', writerEndpoint.status === 403 && writerEndpoint.json?.error?.code === 'POLICY_DENIED'
      && writerBinding.status === 403 && writerBinding.json?.error?.code === 'POLICY_DENIED'
      && adminEndpoint.status === 200 && adminEndpoint.json?.data?.url === 'https://ap.internal.example/admin-updated',
    `writer=${writerEndpoint.status}/${writerEndpoint.json?.error?.code} binding=${writerBinding.status}/${writerBinding.json?.error?.code} admin=${adminEndpoint.status}`);

    await stage('T10', async () => {
      const suppliedDeny = await requestWithBody(base, 'GET', `/v1/agents/${deniedId}`, keyA1.api_key, {
        tags: [{ namespace: 'security', key: 'risk', operator: 'eq', value: 'high' }],
      });
      const suppliedAllow = await requestWithBody(base, 'GET', `/v1/agents/${allowedId}`, keyA1.api_key, {
        tags: [{ namespace: 'security', key: 'risk', operator: 'eq', value: 'low' }],
      });
      const plainDeny = await call(base, 'GET', `/v1/agents/${deniedId}`, keyA1.api_key);
      const plainAllow = await call(base, 'GET', `/v1/agents/${allowedId}`, keyA1.api_key);
      pass('T10', suppliedDeny.status === 400 && suppliedDeny.json?.error?.code === 'VALIDATION_ERROR'
        && suppliedAllow.status === 400 && suppliedAllow.json?.error?.code === 'VALIDATION_ERROR'
        && !suppliedDeny.text.includes(deniedId) && !suppliedAllow.text.includes('low')
        && plainDeny.status === 404 && plainDeny.json?.error?.code === 'AGENT_NOT_FOUND'
        && plainAllow.status === 200 && plainAllow.json?.data?.id === allowedId && plainAllow.json?.data?.name === 'Allowed Anchor',
      `body=${suppliedDeny.status}/${suppliedAllow.status} plain=${plainDeny.status}/${plainAllow.status}`);
    });

    const falseRead = await call(base, 'GET', `/v1/agents/${flagFalseId}`, keyT8.api_key);
    const trueRead = await call(base, 'GET', `/v1/agents/${flagTrueId}`, keyT8.api_key);
    const missingRead = await call(base, 'GET', `/v1/agents/${flagMissingId}`, keyT8.api_key);
    pass('T08', falseRead.status === 200 && falseRead.json?.data?.id === flagFalseId
      && trueRead.status === 404 && missingRead.status === 404,
    `false=${falseRead.status} true=${trueRead.status} missing=${missingRead.status}`);
    const levelRead = await call(base, 'GET', `/v1/agents/${levelId}`, keyT9.api_key);
    pass('T09', levelRead.status === 200 && levelRead.json?.data?.id === levelId && stringLevel.status === 422,
      `number=${levelRead.status} string=${stringLevel.status}`);
    const tempRead = await call(base, 'GET', `/v1/agents/${tempId}`, keyT7.api_key);
    const tempTag = await call(base, 'GET', `/v1/agents/${tempId}/tags/security/temp`, keyAdmin.api_key);
    const tempDelete = await call(base, 'DELETE', `/v1/agents/${tempId}/tags/security/temp`, keyAdmin.api_key, undefined, {
      'idempotency-key': idem('t07d'), 'if-match': tempTag.headers.etag, 'x-change-reason': 'Remove the temp selector',
    });
    const tempAfter = await call(base, 'GET', `/v1/agents/${tempId}`, keyT7.api_key);
    pass('T07', unknownPolicy.status === 422 && tempRead.status === 200 && tempTag.status === 200
      && /^"tag-v[1-9][0-9]*"$/.test(tempTag.headers.etag ?? '')
      && tempDelete.status === 204 && tempAfter.status === 404,
      `unknown=${unknownPolicy.status} before=${tempRead.status} tag=${tempTag.status} etag=${tempTag.headers.etag ?? ''} delete=${tempDelete.status}/${tempDelete.json?.error?.code ?? ''} after=${tempAfter.status}`);

    await watcher.query(
      `INSERT INTO agents (organization_id, id, name, owner_principal_id, created_by, updated_by)
       VALUES ($1, $2, 'foreign-marker', $3, $3, $3)`,
      [orgB.id, allowedId, adminB.id],
    );
    const sameA = await call(base, 'GET', `/v1/agents/${allowedId}`, keyA1.api_key);
    const sameB = await call(base, 'GET', `/v1/agents/${allowedId}`, keyB.api_key);
    const listA = await call(base, 'GET', '/v1/agents?limit=25', keyA1.api_key);
    const listB = await call(base, 'GET', '/v1/agents?limit=25', keyB.api_key);
    pass('S18', sameA.status === 200 && sameA.json?.data?.name === 'Allowed Anchor' && sameB.status === 200
      && sameB.json?.data?.name === 'foreign-marker' && !listA.text.includes('foreign-marker')
      && !listB.text.includes('Allowed Anchor'),
    `a=${sameA.status}/${sameA.json?.data?.name} b=${sameB.status}/${sameB.json?.data?.name}`);

    const fkId = randomUUID();
    const rlsId = randomUUID();
    async function asOrg(sql, params) {
      await app.query('BEGIN');
      try {
        await app.query(`SELECT set_config('fad.org_id', $1, true)`, [orgA.id]);
        await app.query(sql, params);
        await app.query('ROLLBACK');
        return { ok: true, code: '' };
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        try { await app.query('ROLLBACK'); } catch { /* aborted */ }
        return { ok: false, code, message: error instanceof Error ? error.message.slice(0, 180) : '' };
      }
    }
    const decisionSql = `INSERT INTO fad_enforcement_decisions (
      organization_id, id, request_id, actor_principal_id, agent_id, operation_id, action, channel, mode, outcome, reason_code
    ) VALUES ($1, $2, $3, $4, $5, 'getAgent', 'agent.read', 'rest', 'enforce', 'denied', 'NO_MATCHING_ALLOW')`;
    const fk = await asOrg(decisionSql, [orgA.id, fkId, randomUUID(), adminP.id, agentB.json.data.id]);
    const rls = await asOrg(decisionSql, [orgB.id, rlsId, randomUUID(), adminB.id, agentB.json.data.id]);
    const leftover = await watcher.query(
      `SELECT count(*)::int AS n FROM fad_enforcement_decisions WHERE id = ANY($1::uuid[])`,
      [[fkId, rlsId]],
    );
    pass('S05', fk.ok === false && fk.code === '23503' && rls.ok === false && rls.code === '42501' && leftover.rows[0].n === 0,
      `fk=${fk.code} rls=${rls.code}/${rls.message ?? ''} leftover=${leftover.rows[0].n}`);

    const foundBefore = await call(base, 'POST', '/v1/discovery/agents', keyA1.api_key, {
      capability: { id: 's6.race.match', version: '1.0.0' }, protocols: ['a2a'],
    });
    const retirePatch = await call(base, 'PATCH', `/v1/agents/${retireId}`, keyAdmin.api_key, { name: 'Retire Patched' }, {
      'idempotency-key': idem('p10p'), 'if-match': '"agent-v1"',
    });
    const retired = await call(base, 'POST', `/v1/agents/${retireId}/retire`, keyAdmin.api_key, { reason: 'Retire from discovery' }, {
      'idempotency-key': idem('p10r'), 'if-match': retirePatch.headers?.etag,
    });
    const foundAfter = await call(base, 'POST', '/v1/discovery/agents', keyA1.api_key, {
      capability: { id: 's6.race.match', version: '1.0.0' }, protocols: ['a2a'],
    });
    const beforeIds = (foundBefore.json?.data ?? []).map((item) => item.agent?.id);
    const afterIds = (foundAfter.json?.data ?? []).map((item) => item.agent?.id);
    pass('C12', foundBefore.status === 200 && beforeIds.includes(retireId) && retired.status === 200
      && foundAfter.status === 200 && !afterIds.includes(retireId),
    `before=${foundBefore.status} after=${foundAfter.status} retire=${retired.status}`);
    const suspendPatch = await call(base, 'GET', `/v1/agents/${suspendId}`, keyAdmin.api_key);
    const suspended = await call(base, 'POST', `/v1/agents/${suspendId}/suspend`, keyAdmin.api_key, { reason: 'Hold for activate' }, {
      'idempotency-key': idem('p10s'), 'if-match': suspendPatch.headers.etag,
    });
    const activated = await call(base, 'POST', `/v1/agents/${suspendId}/activate`, keyAdmin.api_key, { reason: 'Try to restore' }, {
      'idempotency-key': idem('p10a'), 'if-match': suspended.headers?.etag,
    });
    pass('P10-PATCH', retirePatch.status === 200, `status=${retirePatch.status}`);
    pass('P10-RETIRE', retired.status === 200, `status=${retired.status}`);
    pass('P10-ACTIVATE', suspended.status === 200 && activated.status === 403 && activated.json?.error?.code === 'POLICY_DENIED',
      `suspend=${suspended.status} activate=${activated.status}/${activated.json?.error?.code}`);
    note('P10', `PARTIAL patch=${retirePatch.status} retire=${retired.status} activate=${activated.status} code=${activated.json?.error?.code}`);

    const api2 = await up(apiEnv);
    const moved = await call(base, 'PUT', `/v1/agents/${allowedId}/tags/department/name`, keyAdmin.api_key, { value: 'treasury' }, {
      'idempotency-key': idem('t13'), 'if-match': tagRead.headers.etag,
    });
    const otherReplica = await call(api2.base, 'GET', `/v1/agents/${allowedId}/tags/department/name`, keyA1.api_key);
    pass('T13', api2.ready && moved.status === 200 && otherReplica.status === 200 && otherReplica.json?.data?.value === 'treasury',
      `ready=${api2.ready} put=${moved.status} get=${otherReplica.status} value=${otherReplica.json?.data?.value}`);

    const explainPaths = ['/v1/authorization/explain', `/v1/policies/${allow.id}/explain`];
    const explainStatuses = [];
    for (const path of explainPaths) {
      const got = await call(base, 'GET', path, keyAdmin.api_key);
      explainStatuses.push(`${path} ${got.status}`);
    }
    note('P25', `NOT RUN no explanation route; attempt ${explainStatuses.join(', ')}`);
    note('T14', `NOT RUN no explanation route; attempt ${explainStatuses.join(', ')}`);
    note('R19', 'NOT RUN no .github workflow and no CI run id');

    let r03Name = '';
    let r03Status = 0;
    let r03Code = '';
    let r03Request = '';
    try {
      const deniedClient = new FadClient({
        baseUrl: base, apiKey: keyWriter.api_key, allowInsecureHttp: true, timeoutMs: 8000,
      });
      await deniedClient.agents.update(allowedId, { name: 'Writer Denied' }, {
        idempotencyKey: idem('r03'), ifMatch: '"agent-v1"',
      });
      r03Name = 'resolved';
    } catch (error) {
      r03Name = error instanceof Error ? error.name : '';
      r03Status = error instanceof PolicyDeniedError ? error.status : 0;
      r03Code = error instanceof PolicyDeniedError ? error.code : '';
      r03Request = error instanceof PolicyDeniedError ? (error.requestId ?? '') : '';
    }
    pass('R03', r03Name === 'PolicyDeniedError' && r03Status === 403 && r03Code === 'POLICY_DENIED' && UUID.test(r03Request),
      `name=${r03Name} status=${r03Status} code=${r03Code} request=${r03Request}`);

    const shortApi = await up({
      ...apiEnv,
      FAD_ENFORCEMENT_LOCK_TIMEOUT_MS: '1000',
      FAD_HTTP_REQUEST_TIMEOUT_MS: '8000',
      FAD_SHUTDOWN_GRACE_MS: '8000',
      FAD_DB_POOL_MAX: '2',
    });
    config = await current();
    const modeBeforeRetry = await modeOf(orgA.id);
    await superuser.query('BEGIN');
    await superuser.query(`SELECT pg_advisory_xact_lock(6816, fad_s6_enforcement_key($1::uuid))`, [orgA.id]);
    let fetches = 0;
    const retryClient = new FadClient({
      baseUrl: shortApi.base,
      apiKey: keyAdmin.api_key,
      allowInsecureHttp: true,
      timeoutMs: 8000,
      maxGetRetries: 2,
      fetch: (url, init) => {
        fetches += 1;
        return fetch(url, init);
      },
    });
    let retryName = '';
    let retryCode = '';
    try {
      await retryClient.enforcement.setConfig({
        mode: 'off', actions: [], reason: 'retry probe', acknowledge_default_deny: false,
      }, { ifMatch: config.headers.etag, idempotencyKey: idem('r04') });
      retryName = 'resolved';
    } catch (error) {
      retryName = error instanceof Error ? error.name : '';
      retryCode = error instanceof ServiceUnavailableError ? error.code : '';
    }
    try { await superuser.query('COMMIT'); } catch { try { await superuser.query('ROLLBACK'); } catch { /* released */ } }
    const modeAfterRetry = await modeOf(orgA.id);
    pass('R04', shortApi.ready && retryName === 'ServiceUnavailableError' && retryCode === 'DEPENDENCY_UNAVAILABLE'
      && fetches === 1 && modeAfterRetry.mode === 'enforce' && modeAfterRetry.revision === modeBeforeRetry.revision,
    `ready=${shortApi.ready} name=${retryName} code=${retryCode} fetches=${fetches} mode=${modeAfterRetry.mode}/${modeAfterRetry.revision}`);

    openapiOriginal = readFileSync(openapiPath);
    let diffCode = 0;
    let diffText = '';
    try {
      const mutated = openapiOriginal.toString('utf8').replace('operationId: getAgent\n', 'operationId: getAgentMutated\n');
      writeFileSync(openapiPath, mutated);
      const diff = await new Promise((resolve) => {
        execFile(process.execPath, ['scripts/openapi-diff.mjs'], { cwd: new URL('..', import.meta.url).pathname }, (error, stdout, stderr) => {
          resolve({ code: error && typeof error === 'object' && 'code' in error && error.code ? 1 : 0, stdout, stderr });
        });
      });
      diffCode = diff.code;
      diffText = `${diff.stdout}\n${diff.stderr}`;
    } finally {
      if (openapiOriginal) writeFileSync(openapiPath, openapiOriginal);
      openapiOriginal = undefined;
    }
    pass('R18', diffCode !== 0 && diffText.includes('changed parent get /v1/agents/{agentId}')
      && readFileSync(openapiPath, 'utf8').includes('operationId: getAgent\n'),
    `exit=${diffCode} changed=${diffText.includes('changed parent get /v1/agents/{agentId}')}`);

    const certDir = mkdtempSync(join(scratch, 's6-race-issuer-'));
    const tlsKey = join(certDir, 'tls.key');
    const tlsCert = join(certDir, 'tls.crt');
    await new Promise((resolve, reject) => {
      execFile('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-keyout', tlsKey, '-out', tlsCert, '-days', '2', '-nodes',
        '-subj', '/CN=fad-s6-race', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
      ], (error) => (error ? reject(error) : resolve()));
    });
    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = 's6-race-kid';
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';
    issuerServer = https.createServer({ key: readFileSync(tlsKey), cert: readFileSync(tlsCert) }, (req, res) => {
      if ((req.url ?? '').split('?')[0] === '/.well-known/jwks.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ keys: [publicJwk] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => issuerServer.listen(0, '127.0.0.1', resolve));
    const issuer = `https://127.0.0.1:${issuerServer.address().port}`;
    const mcpPort = await freePort();
    const mcpApi = await up({
      ...apiEnv,
      FAD_MCP_ENABLED: 'true',
      FAD_MCP_RESOURCE_URI: `http://127.0.0.1:${mcpPort}/mcp`,
      FAD_MCP_EXPECTED_AUDIENCE: `http://127.0.0.1:${mcpPort}/mcp`,
      FAD_MCP_AUTH_ISSUERS: issuer,
      FAD_HTTP_ALLOWED_HOSTS: `127.0.0.1:${mcpPort}`,
      FAD_MCP_ALLOWED_ORIGINS: `http://127.0.0.1:${mcpPort}`,
      FAD_MCP_JWKS_TLS_INSECURE: 'true',
      FAD_MCP_JWKS_COOLDOWN_MS: '0',
      FAD_MCP_JWKS_TIMEOUT_MS: '800',
      FAD_MCP_REQUEST_TIMEOUT_MS: '8000',
      PORT: String(mcpPort),
    });
    const clientId = `fad-race-${stamp}`;
    await created(['mcp', 'bind', '--organization-id', orgA.id, '--principal-id', adminP.id, '--issuer', issuer, '--subject', `race-admin-${stamp}`, '--client-id', clientId, '--scopes', ADMIN]);
    await created(['mcp', 'bind', '--organization-id', orgA.id, '--principal-id', a1.id, '--issuer', issuer, '--subject', `race-a1-${stamp}`, '--client-id', clientId, '--scopes', 'agents:read,enforcement:read']);
    const sign = (subject, scope) => new SignJWT({ client_id: clientId, scope })
      .setProtectedHeader({ alg: 'RS256', kid: 's6-race-kid', typ: 'at+jwt' })
      .setSubject(subject)
      .setIssuer(issuer)
      .setAudience(`http://127.0.0.1:${mcpPort}/mcp`)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(privateKey);
    const adminToken = await sign(`race-admin-${stamp}`, ADMIN.replaceAll(',', ' '));
    const readerToken = await sign(`race-a1-${stamp}`, 'agents:read enforcement:read');
    async function openMcp(token) {
      const client = new Client({ name: 'fad-slice6-race', version: '1.0.0' }, { versionNegotiation: { pin: '2026-07-28' } });
      const transport = new StreamableHTTPClientTransport(new URL(`${mcpApi.base}/mcp`), { authProvider: { token: async () => token } });
      await client.connect(transport, { timeout: 8000 });
      return { client, transport };
    }
    async function tool(client, name, args) {
      try {
        const result = await client.callTool({ name, arguments: args });
        let body = result.structuredContent ?? null;
        const text = Array.isArray(result.content)
          ? result.content.map((item) => (item && typeof item === 'object' && 'text' in item ? String(item.text) : '')).join('\n')
          : '';
        if (!body?.error && text) {
          try { body = JSON.parse(text); } catch { body = { error: { code: 'UNPARSED', message: text.slice(0, 180) } }; }
        }
        return { error: result.isError === true, body, text: text.slice(0, 240) };
      } catch (error) {
        return { error: true, body: { error: { code: 'THREW', message: error instanceof Error ? error.message.slice(0, 180) : 'error' } }, text: '' };
      }
    }
    const modeBeforeTool = await modeOf(orgA.id);
    const rowsBeforeTool = rowsB.rows[0].n;
    const adminClient = await openMcp(adminToken);
    const hostile = await tool(adminClient.client, 'fad_get_enforcement_config', { organization_id: orgB.id });
    const readerClient = await openMcp(readerToken);
    const missingScope = await tool(readerClient.client, 'fad_set_enforcement_config', {
      mode: 'off', actions: [], reason: 'missing scope', acknowledge_default_deny: false,
      if_match: '"enforcement-v1"', idempotency_key: idem('s09'),
    });
    const modeAfterTool = await modeOf(orgA.id);
    const rowsAfterTool = await watcher.query(`SELECT count(*)::int AS n FROM fad_enforcement_configs WHERE organization_id = $1`, [orgB.id]);
    const rejectedTenant = hostile.body?.error?.code === 'VALIDATION_ERROR'
      || /unrecognized key:\s*"organization_id"|input validation error/i.test(`${hostile.text ?? ''} ${hostile.body?.error?.message ?? ''}`);
    pass('S08', mcpApi.ready && hostile.error === true && rejectedTenant
      && rowsAfterTool.rows[0].n === rowsBeforeTool && modeAfterTool.revision === modeBeforeTool.revision,
    `ready=${mcpApi.ready} error=${hostile.error} code=${hostile.body?.error?.code ?? 'client'} rows=${rowsAfterTool.rows[0].n} rev=${modeAfterTool.revision} body=${(hostile.text || hostile.body?.error?.message || '').slice(0, 180)}`);
    pass('S09', missingScope.error === true && modeAfterTool.mode === modeBeforeTool.mode && modeAfterTool.revision === modeBeforeTool.revision,
    `error=${missingScope.error} code=${missingScope.body?.error?.code} mode=${modeAfterTool.mode}/${modeAfterTool.revision}`);
    await adminClient.transport.close();
    await readerClient.transport.close();
    rmSync(tlsKey, { force: true });
    rmSync(tlsCert, { force: true });

    await installSleep();
    const d16Api = await up({ ...apiEnv, FAD_HTTP_REQUEST_TIMEOUT_MS: '15000', FAD_SHUTDOWN_GRACE_MS: '15000' });
    const d16Before = await agentRow(orgA.id, deadlockId);
    const d16DecBefore = await watcher.query(
      `SELECT count(*)::int AS n FROM fad_enforcement_decisions WHERE organization_id = $1 AND agent_id = $2`,
      [orgA.id, deadlockId],
    );
    const d16Locks = await shareCount(orgA.id);
    const d16Patch = call(d16Api.base, 'PATCH', `/v1/agents/${deadlockId}`, keyAdmin.api_key, { name: 'Shutdown Partial' }, {
      'idempotency-key': idem('d16'), 'if-match': `"agent-v${d16Before.revision}"`,
    }).then(
      (result) => ({ status: result.status, thrown: false }),
      () => ({ status: 0, thrown: true }),
    );
    const d16Held = await waitShare(orgA.id, d16Locks);
    const d16Stop = await d16Api.stop();
    const d16Got = await d16Patch;
    const d16Status = d16Got.thrown ? 'thrown' : String(d16Got.status);
    await sleep(300);
    const d16After = await agentRow(orgA.id, deadlockId);
    const d16DecAfter = await watcher.query(
      `SELECT count(*)::int AS n FROM fad_enforcement_decisions WHERE organization_id = $1 AND agent_id = $2`,
      [orgA.id, deadlockId],
    );
    pass('D16', d16Api.ready && d16Held && d16Stop === 0 && d16Status !== '200'
      && d16After.name === d16Before.name && d16After.revision === d16Before.revision
      && d16DecAfter.rows[0].n === d16DecBefore.rows[0].n,
    `ready=${d16Api.ready} held=${d16Held} stop=${d16Stop} response=${d16Status} name=${d16After.name} rev=${d16After.revision} decisions=${d16DecBefore.rows[0].n}->${d16DecAfter.rows[0].n} logs=${d16Api.logs().replace(/\s+/g, ' ').slice(-240)}`);
    await dropSleep();

    await stage('C14', async () => {
      const scanApi = await up({
        ...apiEnv,
        FAD_HTTP_REQUEST_TIMEOUT_MS: '60000',
        FAD_SHUTDOWN_GRACE_MS: '60000',
        FAD_DB_POOL_MAX: '2',
      });
      if (!scanApi.ready) {
        pass('C14', false, `ready=false logs=${scanApi.logs().replace(/\s+/g, ' ').slice(-400)}`);
        return;
      }
      await watcher.query(
        `INSERT INTO agents (organization_id, id, name, owner_principal_id, created_by, updated_by)
         SELECT $1, gen_random_uuid(), 's6race-filler-' || g, $2, $2, $2
         FROM generate_series(1, 5001) AS g`,
        [orgA.id, adminP.id],
      );
      const scanStarted = Date.now();
      const scanned = await call(scanApi.base, 'GET', '/v1/agents?limit=25', keyA1.api_key);
      pass('C14', scanned.status === 503 && scanned.json?.error?.code === 'ENFORCEMENT_SCAN_BUDGET_EXCEEDED'
        && !scanned.text.includes('s6race-filler') && !Array.isArray(scanned.json?.data),
      `ready=${scanApi.ready} status=${scanned.status} code=${scanned.json?.error?.code} ms=${Date.now() - scanStarted} req=${scanned.headers['x-request-id']}`);
    });
  } finally {
    try { await superuser.query('ROLLBACK'); } catch { /* no open transaction */ }
    try { await superuser.query(`DROP TRIGGER IF EXISTS fad_s6_test_sleep ON fad_enforcement_decisions`); } catch { /* trigger absent */ }
    try { await superuser.query(`DROP FUNCTION IF EXISTS fad_s6_test_sleep()`); } catch { /* function absent */ }
    try { await superuser.query(`ALTER DATABASE fad RESET log_min_messages`); } catch { /* reset already applied */ }
    try { await superuser.query(`ALTER DATABASE fad RESET log_lock_waits`); } catch { /* reset already applied */ }
    try { await superuser.query(`DELETE FROM agents WHERE name LIKE 's6race-filler-%'`); } catch { /* filler rows may be referenced */ }
    if (openapiOriginal) writeFileSync(openapiPath, openapiOriginal);
    for (const started of apis) {
      try { await started.stop(); } catch { /* already stopped */ }
    }
    if (issuerServer) issuerServer.close();
    await superuser.end().catch(() => undefined);
    await watcher.end().catch(() => undefined);
    await app.end().catch(() => undefined);
    const summary = `${new Date().toISOString()} NOTE SUMMARY pass=${notes.filter((line) => line.includes(' PASS ')).length} fail=${failures.length}`;
    notes.push(summary);
    writeFileSync(new URL('../docs/releases/slice-6/api-evidence/race-notes.log', import.meta.url), `${notes.join('\n')}\n`);
    console.log(summary);
  }
  if (failures.length > 0) throw new Error(failures.join('\n'));
});
