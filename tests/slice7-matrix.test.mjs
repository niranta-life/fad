import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import {
  acknowledgeDelivery,
  assertWebhookUrl,
  claimDelivery,
  claimVerification,
  createPool,
  fanoutOrganization,
  finishVerification,
  postSignedWebhook,
  postWebhook,
} from '@fad/db';
import { admin, check, freePort, parseJson, request, requiredEnv, scratch, startApi } from './support.mjs';

const { Client: PgClient } = pg;
const appUrl = requiredEnv('DATABASE_URL');
const migratorUrl = requiredEnv('FAD_MIGRATOR_DATABASE_URL');
const repo = new URL('..', import.meta.url).pathname;
const evidenceDir = new URL('../docs/releases/slice-7/', import.meta.url).pathname;
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
  'policies:read', 'policies:write', 'policies:activate', 'policies:evaluate:any',
  'capabilities:read', 'capabilities:write', 'endpoints:read', 'endpoints:write',
  'enforcement:read', 'enforcement:manage', 'enforcement:audit',
  'events:read', 'events:subscribe', 'events:manage', 'events:replay', 'events:delivery:read', 'events:restricted:read',
].join(',');
const SUBSCRIBE = 'events:subscribe,events:read,agents:read,tags:read';
const EVENT_ROUTES = [
  'get /v1/events',
  'get /v1/events/{eventId}',
  'post /v1/event-subscriptions',
  'get /v1/event-subscriptions',
  'get /v1/event-subscriptions/{subscriptionId}',
  'patch /v1/event-subscriptions/{subscriptionId}',
  'post /v1/event-subscriptions/{subscriptionId}/rotate-secret',
  'post /v1/event-subscriptions/{subscriptionId}/replays',
  'get /v1/event-subscriptions/{subscriptionId}/replays/{replayId}',
  'get /v1/event-subscriptions/{subscriptionId}/deliveries',
];

function call(base, method, path, key, body, headers = {}) {
  const requestHeaders = { ...headers };
  if (key) requestHeaders['x-fad-api-key'] = key;
  if (body !== undefined) requestHeaders['content-type'] = 'application/json';
  return request(`${base}${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function created(args) {
  const result = await admin(args);
  if (result.code !== 0) throw new Error(`${args.slice(0, 2).join(' ')} failed`);
  return parseJson(result.stdout);
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

test('slice 7 remaining matrix rows on PostgreSQL', { timeout: 900_000 }, async () => {
  const lines = [];
  const pass = (id, condition, detail) => {
    lines.push(`${new Date().toISOString()} ${condition ? 'PASS' : 'FAIL'} ${id} ${detail}`);
    check(id, condition, detail);
  };
  const secretKey = randomUUID() + randomUUID();
  process.env.FAD_EVENTS_ENABLED = 'true';
  process.env.FAD_EVENTS_SECRET_KEY = secretKey;
  process.env.FAD_EVENTS_LEASE_MS = '800';
  process.env.FAD_ENFORCEMENT_CODE_ENABLED = 'true';
  process.env.FAD_POLICIES_ENABLED = 'true';
  const posts = [];
  let releaseHold = () => undefined;
  const certDir = mkdtempSync(join(scratch, 's7-gap-'));
  const hookKey = join(certDir, 'hook.key');
  const hookCert = join(certDir, 'hook.crt');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-keyout', hookKey, '-out', hookCert, '-days', '2', '-nodes',
    '-subj', '/CN=hooks.test', '-addext', 'subjectAltName=DNS:hooks.test',
  ], { stdio: 'ignore' });
  const hookPort = await freePort();
  const receiver = https.createServer({ key: readFileSync(hookKey), cert: readFileSync(hookCert) }, async (req, res) => {
    const raw = await readRaw(req);
    const path = req.url ?? '/';
    let parsed = null;
    try { parsed = JSON.parse(raw.toString('utf8')); } catch { parsed = null; }
    const challenge = parsed && parsed.type === 'fad.webhook.challenge.v1' && typeof parsed.challenge === 'string';
    posts.push({ path, challenge });
    if (path.startsWith('/stall')) {
      await new Promise((resolve) => req.on('close', resolve));
      return;
    }
    if (path.startsWith('/hold') && !challenge) {
      await new Promise((resolve) => { releaseHold = resolve; });
    }
    if (challenge && path.startsWith('/wrong')) {
      const body = Buffer.from(JSON.stringify({ challenge: 'nope' }));
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length, connection: 'close' });
      res.end(body);
      return;
    }
    if (challenge) {
      const body = Buffer.from(JSON.stringify({ challenge: parsed.challenge }));
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length, connection: 'close' });
      res.end(body);
      return;
    }
    const body = Buffer.from('{"ok":true}');
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length, connection: 'close' });
    res.end(body);
  });
  await new Promise((resolve) => receiver.listen(hookPort, '127.0.0.1', resolve));
  process.env.FAD_EVENTS_TEST_EGRESS = 'loopback';
  process.env.FAD_EVENTS_TEST_HOSTS = 'hooks.test=127.0.0.1';
  process.env.FAD_EVENTS_TEST_PORT = String(hookPort);
  process.env.FAD_EVENTS_TEST_CA = hookCert;
  const superuser = new PgClient({ connectionString: migratorUrl, application_name: 'fad-s7-gap-super' });
  const app = new PgClient({ connectionString: appUrl, application_name: 'fad-s7-gap-app' });
  superuser.on('error', () => undefined);
  app.on('error', () => undefined);
  await superuser.connect();
  await app.connect();
  const pool = createPool({
    connectionString: appUrl,
    max: 4,
    statementTimeoutMs: 20_000,
    applicationName: 'fad-s7-matrix',
  });
  pool.on('error', () => undefined);
  let api;
  const hook = (path) => `https://hooks.test:${hookPort}${path}`;
  async function tickOrg(organizationId) {
    for (let count = 0; count < 20; count += 1) {
      const claim = await claimVerification(pool, organizationId);
      if (!claim) break;
      const body = Buffer.from(JSON.stringify({
        type: 'fad.webhook.challenge.v1',
        challenge: claim.challenge,
        subscription_id: claim.subscriptionId,
      }));
      try {
        const sent = await postSignedWebhook({
          url: claim.url, secret: claim.secret, keyId: claim.keyId,
          eventId: claim.subscriptionId, deliveryId: randomUUID(), body,
        });
        await finishVerification(pool, organizationId, claim.subscriptionId, sent.status, sent.body);
      } catch {
        await finishVerification(pool, organizationId, claim.subscriptionId, 0, Buffer.alloc(0));
      }
    }
    await fanoutOrganization(pool, organizationId);
    for (let sent = 0; sent < 20; sent += 1) {
      const claim = await claimDelivery(pool, organizationId);
      if (!claim) break;
      const startedAt = new Date();
      try {
        const sentResult = await postSignedWebhook(claim);
        const retry = sentResult.status === 408 || sentResult.status === 429 || sentResult.status >= 500;
        const success = sentResult.status >= 200 && sentResult.status < 300;
        await acknowledgeDelivery(pool, claim, {
          kind: success ? 'success' : retry ? 'retry' : 'dead',
          httpStatus: sentResult.status,
          retryAfterSeconds: sentResult.retryAfterSeconds,
          startedAt,
        });
      } catch {
        await acknowledgeDelivery(pool, claim, {
          kind: 'retry', httpStatus: null, retryAfterSeconds: null, startedAt,
        });
      }
    }
  }
  async function latest(org, type) {
    const result = await superuser.query(
      `SELECT event_id, sequence::int AS sequence, visibility, payload, request_id::text
         FROM fad_outbox_events
        WHERE organization_id = $1 AND event_type = $2
        ORDER BY sequence DESC LIMIT 1`,
      [org, type],
    );
    return result.rows[0];
  }
  try {
    const diffRaw = execFileSync(process.execPath, ['scripts/openapi-diff.mjs'], {
      cwd: repo, encoding: 'utf8', maxBuffer: 20_000_000,
    });
    const report = JSON.parse(diffRaw);
    const added = report.added_operations ?? [];
    const parentNew = report.parent_new_operations ?? [];
    const missing = EVENT_ROUTES.filter((item) => parentNew.includes(item) === false);
    const insideAdded = EVENT_ROUTES.filter((item) => added.includes(item));
    const contractOk = report.ok === true
      && Array.isArray(report.breaking) && report.breaking.length === 0
      && report.parent_preexisting_deep_equal === true
      && report.parent_new_operations_are_slice7_routes === true
      && added.length === 8
      && missing.length === 0
      && insideAdded.length === 0
      && parentNew.filter((item) => EVENT_ROUTES.includes(item)).length === 10;
    pass('CONTRACT-ROUTES', contractOk,
      `ok=${report.ok} breaking=${(report.breaking ?? []).length} added=${added.length} parent_new=${parentNew.length} event_routes=${EVENT_ROUTES.length} missing=${missing.length} inside_added=${insideAdded.length}`);
    writeFileSync(`${evidenceDir}contract-routes.log`, [
      `${new Date().toISOString()} CONTRACT-ROUTES ok=${report.ok} breaking=${(report.breaking ?? []).length}`,
      `added_operations=${added.join(',')}`,
      `event_routes=${EVENT_ROUTES.join(',')}`,
      `event_routes_in_parent_new=${EVENT_ROUTES.every((item) => parentNew.includes(item))}`,
      `event_routes_inside_added_operations=${insideAdded.length}`,
      `parent_new_operations_are_slice7_routes=${report.parent_new_operations_are_slice7_routes}`,
      `parent_preexisting_deep_equal=${report.parent_preexisting_deep_equal}`,
      '',
    ].join('\n'));

    const orgA = await created(['organization', 'create', '--name', `Gap A ${stamp}`]);
    const orgB = await created(['organization', 'create', '--name', `Gap B ${stamp}`]);
    const adminA = await created(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Gap Admin']);
    const reader = await created(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Gap Reader']);
    const subscriber = await created(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Gap Sub']);
    const blocked = await created(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Gap Blocked']);
    const owner = await created(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Gap Owner']);
    const adminB = await created(['principal', 'create', '--organization-id', orgB.id, '--type', 'service', '--name', 'Gap B']);
    const issue = async (org, principal, scopes) => created(['credential', 'issue', '--organization-id', org, '--principal-id', principal, '--scopes', scopes]);
    const keyAdmin = await issue(orgA.id, adminA.id, ADMIN);
    const keyRead = await issue(orgA.id, reader.id, 'events:read,agents:read');
    const keyReplay = await issue(orgA.id, reader.id, 'events:replay,events:read');
    const keySub = await issue(orgA.id, subscriber.id, SUBSCRIBE);
    const keyBlocked = await issue(orgA.id, blocked.id, 'events:subscribe,events:read,agents:read');
    const keyB = await issue(orgB.id, adminB.id, ADMIN);
    const apiPort = await freePort();
    api = await startApi({
      PORT: String(apiPort),
      FAD_EVENTS_ENABLED: 'true',
      FAD_EVENTS_SECRET_KEY: secretKey,
      FAD_EVENTS_TEST_EGRESS: 'loopback',
      FAD_EVENTS_TEST_HOSTS: 'hooks.test=127.0.0.1',
      FAD_EVENTS_TEST_PORT: String(hookPort),
      FAD_EVENTS_TEST_CA: hookCert,
      FAD_EVENTS_LEASE_MS: '800',
      FAD_TAGS_ENABLED: 'true',
      FAD_SLICE3_ENABLED: 'true',
      FAD_POLICIES_ENABLED: 'true',
      FAD_ENFORCEMENT_CODE_ENABLED: 'true',
      FAD_HTTP_ALLOWED_HOSTS: `127.0.0.1:${apiPort}`,
      FAD_RATE_LIMIT_MAX: '8000',
      FAD_DB_POOL_MAX: '8',
    });
    pass('API-ON', api.ready, 'api ready');

    const rejectUrl = async (id, url) => {
      const response = await call(api.base, 'POST', '/v1/event-subscriptions', keyAdmin.api_key, {
        callback_url: url, event_types: ['com.fad.agent.registered.v1'], description: 'reject',
      }, { 'idempotency-key': `${id}-${stamp}` });
      pass(id, response.status === 400 && response.json?.error?.code === 'WEBHOOK_URL_REJECTED', `${response.status} ${response.json?.error?.code}`);
    };
    await rejectUrl('S7-SUB-001', 'http://hooks.test/hook');
    await rejectUrl('S7-SUB-002', 'https://user:pass@hooks.test/hook');
    await rejectUrl('S7-SUB-003', 'https://hooks.test/hook#fragment');
    await rejectUrl('S7-SUB-010', 'https://hooks.test:8443/hook');

    const savedEgress = process.env.FAD_EVENTS_TEST_EGRESS;
    delete process.env.FAD_EVENTS_TEST_EGRESS;
    let privateRejected = false;
    try { assertWebhookUrl('https://10.1.2.3/hook'); } catch { privateRejected = true; }
    let literalRejected = false;
    try { assertWebhookUrl('https://127.0.0.1/hook'); } catch { literalRejected = true; }
    process.env.FAD_EVENTS_TEST_EGRESS = savedEgress;
    process.env.HTTP_PROXY = 'http://127.0.0.1:9';
    process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
    process.env.ALL_PROXY = 'http://127.0.0.1:9';
    let directStatus = 0;
    try {
      const sent = await postWebhook({
        url: hook('/proxy'),
        body: Buffer.from('{"proxy":true}'),
        headers: {},
      });
      directStatus = sent.status;
    } catch { directStatus = 0; }
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.ALL_PROXY;
    pass('S7-OPS-006', privateRejected && literalRejected && directStatus === 200,
      `private=${privateRejected} literal=${literalRejected} direct=${directStatus}`);

    const forged = await call(api.base, 'POST', '/v1/event-subscriptions', keyAdmin.api_key, {
      callback_url: hook('/forged'), event_types: ['com.fad.agent.registered.v1'], organization_id: orgB.id,
    }, { 'idempotency-key': `gap-forged-${stamp}` });
    pass('S7-ORG-004', forged.status === 400 && forged.json?.error?.code === 'VALIDATION_ERROR', forged.json?.error?.code ?? String(forged.status));
    const noSubscribe = await call(api.base, 'POST', '/v1/event-subscriptions', keyRead.api_key, {
      callback_url: hook('/nosub'), event_types: ['com.fad.agent.registered.v1'],
    }, { 'idempotency-key': `gap-nosub-${stamp}` });
    pass('S7-ORG-007', noSubscribe.status === 403 && noSubscribe.json?.error?.code === 'FORBIDDEN', noSubscribe.json?.error?.code ?? String(noSubscribe.status));

    const registered = await call(api.base, 'POST', '/v1/agents', keyAdmin.api_key, {
      name: `Gap ${stamp}`, description: 'gap one', owner_principal_id: owner.id,
    }, { 'idempotency-key': `gap-reg-${stamp}` });
    const agentA = registered.json?.data?.id;
    const second = await call(api.base, 'POST', '/v1/agents', keyAdmin.api_key, {
      name: `Gap B ${stamp}`, description: 'gap two', owner_principal_id: owner.id,
    }, { 'idempotency-key': `gap-reg-b-${stamp}` });
    const agentB = second.json?.data?.id;
    pass('AGENTS', registered.status === 201 && second.status === 201, `${registered.status} ${second.status}`);
    const suspended = await call(api.base, 'POST', `/v1/agents/${agentB}/suspend`, keyAdmin.api_key, { reason: 'gap suspend' }, {
      'idempotency-key': `gap-sus-${stamp}`, 'if-match': second.headers.etag,
    });
    const suspendEvent = await latest(orgA.id, 'com.fad.agent.lifecycle_changed.v1');
    const suspendAudit = await superuser.query(
      `SELECT count(*)::int AS n FROM audit_events
        WHERE organization_id = $1 AND request_id = $2 AND action = 'agent.suspended'`,
      [orgA.id, suspended.json?.meta?.request_id],
    );
    const suspendOutbox = await superuser.query(
      `SELECT count(*)::int AS n FROM fad_outbox_events WHERE organization_id = $1 AND request_id = $2`,
      [orgA.id, suspended.json?.meta?.request_id],
    );
    pass('S7-OUT-003', suspended.status === 200 && suspendEvent?.payload?.status === 'suspended' && suspendEvent?.payload?.agent_id === agentB,
      `status=${suspended.status} event=${suspendEvent?.payload?.status}`);
    pass('S7-OUT-026', suspendAudit.rows[0].n === 1 && suspendOutbox.rows[0].n === 1,
      `audit=${suspendAudit.rows[0].n} outbox=${suspendOutbox.rows[0].n}`);
    const retired = await call(api.base, 'POST', `/v1/agents/${agentB}/retire`, keyAdmin.api_key, { reason: 'gap retire' }, {
      'idempotency-key': `gap-ret-${stamp}`, 'if-match': suspended.headers.etag,
    });
    const retiredEvent = await latest(orgA.id, 'com.fad.agent.lifecycle_changed.v1');
    pass('S7-OUT-004', retired.status === 200 && retiredEvent?.payload?.status === 'retired', `status=${retired.status} event=${retiredEvent?.payload?.status}`);

    const defined = await call(api.base, 'POST', '/v1/tag-definitions', keyAdmin.api_key, {
      namespace: 'gap', key: 'tier', value_type: 'string', governed: true, visibility: 'restricted',
    }, { 'idempotency-key': `gap-tag-${stamp}` });
    const definedEvent = await latest(orgA.id, 'com.fad.tag.definition_created.v1');
    pass('S7-OUT-005', defined.status === 201 && definedEvent?.payload?.namespace === 'gap' && definedEvent?.payload?.change === 'upserted',
      `status=${defined.status} change=${definedEvent?.payload?.change}`);
    const assigned = await call(api.base, 'PUT', `/v1/agents/${agentA}/tags/gap/tier`, keyAdmin.api_key, {
      value: 'gap-secret-value', reason: 'gap assign reason',
    }, { 'idempotency-key': `gap-assign-${stamp}`, 'if-none-match': '*' });
    const assignedEvent = await latest(orgA.id, 'com.fad.tag.assignment_changed.v1');
    const assignedText = JSON.stringify(assignedEvent?.payload ?? {});
    pass('S7-OUT-006', assigned.status === 201 && assignedEvent?.visibility === 'restricted' && assignedEvent?.payload?.change === 'assigned',
      `status=${assigned.status} visibility=${assignedEvent?.visibility}`);
    pass('S7-ORG-012', assignedText.includes('gap-secret-value') === false && assignedText.includes('gap assign reason') === false,
      'tag value absent');

    const allow = await call(api.base, 'POST', '/v1/policies', keyAdmin.api_key, {
      name: `GapPolicy${stamp}`, description: 'gap allow body', effect: 'allow', actions: ['agent.read'],
      subjects: { principal_ids: [adminA.id] }, resource: { type: 'agent', agent_ids: [agentA] },
    }, { 'idempotency-key': `gap-pol-${stamp}` });
    const activated = await call(api.base, 'POST', `/v1/policies/${allow.json?.data?.id}/activate`, keyAdmin.api_key, undefined, {
      'idempotency-key': `gap-pol-on-${stamp}`, 'if-match': allow.headers.etag,
    });
    const policyEvent = await latest(orgA.id, 'com.fad.policy.lifecycle_changed.v1');
    const policyText = JSON.stringify(policyEvent?.payload ?? {});
    pass('S7-OUT-010', activated.status === 200 && policyEvent?.visibility === 'restricted' && policyEvent?.payload?.status === 'active',
      `status=${activated.status} visibility=${policyEvent?.visibility}`);
    pass('S7-ORG-013', policyText.includes(`GapPolicy${stamp}`) === false && policyText.includes('gap allow body') === false && policyText.includes('effect') === false,
      'policy body absent');
    const beforeEval = await superuser.query('SELECT count(*)::int AS n FROM fad_outbox_events WHERE organization_id = $1', [orgA.id]);
    const evaluated = await call(api.base, 'POST', '/v1/authorization/evaluate', keyAdmin.api_key, {
      subject: { principal_id: adminA.id }, action: 'agent.invoke', resource: { type: 'agent', id: agentA },
    });
    const afterEval = await superuser.query('SELECT count(*)::int AS n FROM fad_outbox_events WHERE organization_id = $1', [orgA.id]);
    pass('S7-OUT-025', evaluated.status === 200 && evaluated.json?.data?.enforcement === 'not_enforced' && afterEval.rows[0].n === beforeEval.rows[0].n,
      `status=${evaluated.status} enforcement=${evaluated.json?.data?.enforcement} delta=${afterEval.rows[0].n - beforeEval.rows[0].n}`);
    const disabled = await call(api.base, 'POST', `/v1/policies/${allow.json?.data?.id}/disable`, keyAdmin.api_key, undefined, {
      'idempotency-key': `gap-pol-off-${stamp}`, 'if-match': activated.headers.etag,
    });
    const disabledEvent = await latest(orgA.id, 'com.fad.policy.lifecycle_changed.v1');
    pass('S7-OUT-011', disabled.status === 200 && disabledEvent?.payload?.status === 'disabled' && disabledEvent?.visibility === 'restricted',
      `status=${disabled.status} event=${disabledEvent?.payload?.status}`);

    const config0 = await call(api.base, 'GET', '/v1/enforcement/config', keyAdmin.api_key);
    const preflight = await call(api.base, 'POST', '/v1/enforcement/preflight', keyAdmin.api_key, {
      mode: 'shadow', actions: ['agent.read'], reason: 'gap shadow reason',
    });
    const shadow = await call(api.base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'shadow', actions: ['agent.read'], reason: 'gap shadow reason',
      preflight_id: preflight.json?.data?.preflight_id, acknowledge_default_deny: false,
    }, { 'idempotency-key': `gap-enf-${stamp}`, 'if-match': config0.headers.etag });
    const enfEvent = await latest(orgA.id, 'com.fad.enforcement.config_changed.v1');
    const enfText = JSON.stringify(enfEvent?.payload ?? {});
    pass('S7-OUT-012', shadow.status === 200 && enfEvent?.visibility === 'restricted' && enfEvent?.payload?.mode === 'shadow' && enfText.includes('gap shadow reason') === false,
      `status=${shadow.status} mode=${enfEvent?.payload?.mode}`);

    const off = await call(api.base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'off', actions: [], reason: 'return events off', acknowledge_default_deny: false,
    }, { 'idempotency-key': `gap-enf-off-${stamp}`, 'if-match': shadow.headers.etag });
    pass('ENF-OFF', off.status === 200 && off.json?.data?.mode === 'off', `status=${off.status}`);

    const subscribe = async (key, path, types, idem) => call(api.base, 'POST', '/v1/event-subscriptions', key, {
      callback_url: hook(path), event_types: types, description: path,
    }, { 'idempotency-key': idem });
    const wrong = await subscribe(keyAdmin.api_key, '/wrong', ['com.fad.agent.registered.v1'], `gap-wrong-${stamp}`);
    const wrongId = wrong.json?.data?.subscription?.id;
    const expired = await subscribe(keyAdmin.api_key, '/ok', ['com.fad.agent.registered.v1'], `gap-exp-${stamp}`);
    const expiredId = expired.json?.data?.subscription?.id;
    await superuser.query(
      `UPDATE fad_event_subscriptions SET challenge_expires_at = transaction_timestamp() - interval '1 minute'
        WHERE organization_id = $1 AND id = $2`,
      [orgA.id, expiredId],
    );
    const capSub = await subscribe(keySub.api_key, '/ok', ['com.fad.capability.published.v1'], `gap-capsub-${stamp}`);
    const live = await subscribe(keyAdmin.api_key, '/ok', ['com.fad.agent.updated.v1'], `gap-live-${stamp}`);
    const liveId = live.json?.data?.subscription?.id;
    const liveSecret = live.json?.data?.signing_secret;
    const blockedSub = await subscribe(keyBlocked.api_key, '/ok', ['com.fad.agent.lifecycle_changed.v1'], `gap-block-${stamp}`);
    pass('SUBS', wrong.status === 201 && expired.status === 201 && capSub.status === 201 && live.status === 201 && blockedSub.status === 201,
      `${wrong.status} ${expired.status} ${capSub.status} ${live.status} ${blockedSub.status}`);
    const pendingPatch = await call(api.base, 'PATCH', `/v1/event-subscriptions/${wrongId}`, keyAdmin.api_key, { status: 'active' }, {
      'idempotency-key': `gap-pending-${stamp}`, 'if-match': wrong.headers.etag,
    });
    pass('S7-API-019', pendingPatch.status === 409 && pendingPatch.json?.error?.code === 'CONFLICT', pendingPatch.json?.error?.code ?? String(pendingPatch.status));
    const missingMatch = await call(api.base, 'PATCH', `/v1/event-subscriptions/${liveId}`, keyAdmin.api_key, { status: 'paused' }, {
      'idempotency-key': `gap-nomatch-${stamp}`,
    });
    pass('S7-SEC-017', missingMatch.status === 428 && missingMatch.json?.error?.code === 'PRECONDITION_REQUIRED', missingMatch.json?.error?.code ?? String(missingMatch.status));
    const readerPatch = await call(api.base, 'PATCH', `/v1/event-subscriptions/${liveId}`, keyRead.api_key, { status: 'paused' }, {
      'idempotency-key': `gap-reader-patch-${stamp}`, 'if-match': live.headers.etag,
    });
    pass('S7-ORG-008', readerPatch.status === 403 && readerPatch.json?.error?.code === 'FORBIDDEN', readerPatch.json?.error?.code ?? String(readerPatch.status));
    const conflict = await call(api.base, 'POST', '/v1/event-subscriptions', keyAdmin.api_key, {
      callback_url: hook('/ok'), event_types: ['com.fad.agent.registered.v1'], description: 'other',
    }, { 'idempotency-key': `gap-live-${stamp}` });
    pass('S7-SEC-013', conflict.status === 409 && conflict.json?.error?.code === 'IDEMPOTENCY_CONFLICT', conflict.json?.error?.code ?? String(conflict.status));
    await tickOrg(orgA.id);
    const wrongRow = await superuser.query(
      `SELECT status, verification_attempts FROM fad_event_subscriptions WHERE organization_id = $1 AND id = $2`,
      [orgA.id, wrongId],
    );
    pass('S7-SUB-016', wrongRow.rows[0]?.status === 'pending_verification' && wrongRow.rows[0]?.verification_attempts >= 1,
      `status=${wrongRow.rows[0]?.status} attempts=${wrongRow.rows[0]?.verification_attempts}`);
    const expiredBefore = await superuser.query(
      `SELECT status, verification_attempts FROM fad_event_subscriptions WHERE organization_id = $1 AND id = $2`,
      [orgA.id, expiredId],
    );
    const finished = await finishVerification(pool, orgA.id, expiredId, 200, Buffer.from(JSON.stringify({ challenge: 'ignored' })));
    const expiredAfter = await superuser.query(
      `SELECT status, verification_attempts FROM fad_event_subscriptions WHERE organization_id = $1 AND id = $2`,
      [orgA.id, expiredId],
    );
    pass('S7-SUB-017', expiredBefore.rows[0]?.status === 'pending_verification' && finished === 'pending' && expiredAfter.rows[0]?.status === 'pending_verification',
      `before=${expiredBefore.rows[0]?.status} finish=${finished} after=${expiredAfter.rows[0]?.status}`);
    await superuser.query(
      `UPDATE fad_event_subscriptions SET verification_attempts = 20 WHERE organization_id = $1 AND id = $2`,
      [orgA.id, wrongId],
    );
    await tickOrg(orgA.id);
    const capped = await superuser.query(
      `SELECT status, verification_attempts FROM fad_event_subscriptions WHERE organization_id = $1 AND id = $2`,
      [orgA.id, wrongId],
    );
    pass('S7-SUB-021', capped.rows[0]?.status === 'pending_verification' && capped.rows[0]?.verification_attempts === 20,
      `status=${capped.rows[0]?.status} attempts=${capped.rows[0]?.verification_attempts}`);
    const liveRow = await superuser.query(
      `SELECT status, start_after_sequence::int AS watermark FROM fad_event_subscriptions WHERE organization_id = $1 AND id = $2`,
      [orgA.id, liveId],
    );
    const capRow = await superuser.query(
      `SELECT status FROM fad_event_subscriptions WHERE organization_id = $1 AND id = $2`,
      [orgA.id, capSub.json?.data?.subscription?.id],
    );
    const liveSeen = await call(api.base, 'GET', `/v1/event-subscriptions/${liveId}`, keyAdmin.api_key);
    pass('LIVE', liveRow.rows[0]?.status === 'active' && capRow.rows[0]?.status === 'active' && liveRow.rows[0]?.watermark >= 0 && liveSeen.status === 200,
      `live=${liveRow.rows[0]?.status} cap=${capRow.rows[0]?.status} etag=${liveSeen.headers.etag}`);

    const foreignList = await call(api.base, 'GET', '/v1/event-subscriptions?limit=100', keyB.api_key);
    const foreignIds = (foreignList.json?.data ?? []).map((item) => item.id);
    pass('S7-API-017', foreignList.status === 200 && foreignIds.includes(liveId) === false, `status=${foreignList.status} count=${foreignIds.length}`);
    const foreignPatch = await call(api.base, 'PATCH', `/v1/event-subscriptions/${liveId}`, keyB.api_key, { status: 'paused' }, {
      'idempotency-key': `gap-foreign-${stamp}`, 'if-match': '"subscription-v1"',
    });
    pass('S7-ORG-003', foreignPatch.status === 404, String(foreignPatch.status));

    const capId = `gap.m${stamp}`;
    const published = await call(api.base, 'POST', '/v1/capabilities', keyAdmin.api_key, {
      id: capId, version: '1.0.0', display_name: 'Gap', description: 'gap contract',
      input_schema: SCHEMA, output_schema: SCHEMA,
    }, { 'idempotency-key': `gap-cap-${stamp}` });
    const capEvent = await latest(orgA.id, 'com.fad.capability.published.v1');
    pass('S7-OUT-007', published.status === 201 && capEvent?.payload?.capability_id === capId,
      `status=${published.status} id=${capEvent?.payload?.capability_id ?? 'missing'}`);
    await fanoutOrganization(pool, orgA.id);
    await claimDelivery(pool, orgA.id);
    const capJob = await superuser.query(
      `SELECT j.status, j.last_error_code
         FROM fad_event_delivery_jobs j
         JOIN fad_event_subscriptions s ON s.organization_id = j.organization_id AND s.id = j.subscription_id
        WHERE j.organization_id = $1 AND s.owner_principal_id = $2
        ORDER BY j.created_at DESC LIMIT 1`,
      [orgA.id, subscriber.id],
    );
    pass('S7-ORG-019', capJob.rows[0]?.status === 'cancelled' && capJob.rows[0]?.last_error_code === 'scope_missing',
      `status=${capJob.rows[0]?.status} reason=${capJob.rows[0]?.last_error_code}`);

    const endpoint = await call(api.base, 'PUT', `/v1/agents/${agentA}/endpoints/primary`, keyAdmin.api_key, {
      protocol: 'a2a', url: 'https://ap.internal.example/a2a', auth_scheme: 'oauth2',
    }, { 'idempotency-key': `gap-ep-${stamp}`, 'if-none-match': '*' });
    const endpointEvent = await latest(orgA.id, 'com.fad.agent.endpoint_changed.v1');
    pass('S7-OUT-008', endpoint.status === 201 && endpointEvent?.payload?.agent_id === agentA, `status=${endpoint.status}`);
    const binding = await call(api.base, 'PUT', `/v1/agents/${agentA}/capabilities/${capId}`, keyAdmin.api_key, {
      version: '1.0.0', endpoint_key: 'primary',
    }, { 'idempotency-key': `gap-bind-${stamp}`, 'if-none-match': '*' });
    const bindingEvent = await latest(orgA.id, 'com.fad.agent.capability_binding_changed.v1');
    pass('S7-OUT-009', binding.status === 201 && bindingEvent?.payload?.agent_id === agentA, `status=${binding.status}`);

    const onlyUpdated = await superuser.query(
      `SELECT event_types FROM fad_event_subscriptions WHERE organization_id = $1 AND id = $2`,
      [orgA.id, liveId],
    );
    const updated = await call(api.base, 'PATCH', `/v1/agents/${agentA}`, keyAdmin.api_key, { description: 'gap updated' }, {
      'idempotency-key': `gap-upd-${stamp}`, 'if-match': registered.headers.etag,
    });
    const updateEvent = await latest(orgA.id, 'com.fad.agent.updated.v1');
    const otherJobs = await superuser.query(
      `SELECT count(*)::int AS n FROM fad_event_delivery_jobs j
         JOIN fad_outbox_events e ON e.organization_id = j.organization_id AND e.event_id = j.event_id
        WHERE j.organization_id = $1 AND j.subscription_id = $2 AND e.event_type <> 'com.fad.agent.updated.v1'`,
      [orgA.id, liveId],
    );
    pass('S7-SUB-025', updated.status === 200 && onlyUpdated.rows[0]?.event_types?.join(',') === 'com.fad.agent.updated.v1' && otherJobs.rows[0].n === 0,
      `status=${updated.status} other_jobs=${otherJobs.rows[0].n}`);

    const beforeFan = await superuser.query(
      `SELECT last_fanned_sequence::int AS offset FROM fad_event_fanout_offsets WHERE organization_id = $1`,
      [orgA.id],
    );
    await superuser.query('BEGIN');
    await superuser.query('SELECT last_fanned_sequence FROM fad_event_fanout_offsets WHERE organization_id = $1 FOR UPDATE', [orgA.id]);
    const lockedInsert = await fanoutOrganization(pool, orgA.id);
    await superuser.query('ROLLBACK');
    const during = await superuser.query(
      `SELECT last_fanned_sequence::int AS offset FROM fad_event_fanout_offsets WHERE organization_id = $1`,
      [orgA.id],
    );
    pass('S7-DLV-002', lockedInsert === 0 && during.rows[0]?.offset === beforeFan.rows[0]?.offset,
      `inserted=${lockedInsert} offset=${during.rows[0]?.offset}`);
    const inserted = await fanoutOrganization(pool, orgA.id);
    const again = await fanoutOrganization(pool, orgA.id);
    const jobsForUpdate = await superuser.query(
      `SELECT count(*)::int AS n FROM fad_event_delivery_jobs WHERE organization_id = $1 AND event_id = $2 AND status = 'pending'`,
      [orgA.id, updateEvent.event_id],
    );
    const afterFan = await superuser.query(
      `SELECT s.last_sequence::int AS last, o.last_fanned_sequence::int AS offset
         FROM fad_event_streams s JOIN fad_event_fanout_offsets o USING (organization_id)
        WHERE s.organization_id = $1`,
      [orgA.id],
    );
    pass('S7-DLV-001', inserted >= 1 && jobsForUpdate.rows[0].n === 1 && afterFan.rows[0].offset === afterFan.rows[0].last,
      `inserted=${inserted} jobs=${jobsForUpdate.rows[0].n} offset=${afterFan.rows[0].offset} last=${afterFan.rows[0].last}`);
    pass('S7-DLV-003', again === 0 && jobsForUpdate.rows[0].n === 1, `again=${again}`);

    const secondUpdate = await call(api.base, 'PATCH', `/v1/agents/${agentA}`, keyAdmin.api_key, { description: 'gap updated two' }, {
      'idempotency-key': `gap-upd2-${stamp}`, 'if-match': updated.headers.etag,
    });
    const secondEvent = await latest(orgA.id, 'com.fad.agent.updated.v1');
    await fanoutOrganization(pool, orgA.id);
    const firstClaim = await claimDelivery(pool, orgA.id);
    const secondClaim = await claimDelivery(pool, orgA.id);
    const leasedCount = await superuser.query(
      `SELECT count(*)::int AS n FROM fad_event_delivery_jobs
        WHERE organization_id = $1 AND subscription_id = $2 AND status = 'leased'`,
      [orgA.id, firstClaim?.subscriptionId ?? liveId],
    );
    pass('S7-DLV-004', firstClaim !== null && leasedCount.rows[0].n === 1
      && (secondClaim === null || secondClaim.subscriptionId !== firstClaim.subscriptionId),
    `leased=${leasedCount.rows[0].n} second=${secondClaim ? secondClaim.subscriptionId : 'none'}`);
    const lost = await acknowledgeDelivery(pool, { ...firstClaim, jobToken: randomUUID() }, {
      kind: 'success', httpStatus: 200, retryAfterSeconds: null, startedAt: new Date(),
    });
    const stillLeased = await superuser.query(
      `SELECT status FROM fad_event_delivery_jobs WHERE organization_id = $1 AND id = $2`,
      [orgA.id, firstClaim.jobId],
    );
    pass('S7-DLV-017', lost === 'lost' && stillLeased.rows[0]?.status === 'leased', `ack=${lost} status=${stillLeased.rows[0]?.status}`);
    await superuser.query(
      `UPDATE fad_event_delivery_jobs
          SET lease_expires_at = transaction_timestamp() - interval '1 minute'
        WHERE organization_id = $1 AND id = $2`,
      [orgA.id, firstClaim.jobId],
    );
    await superuser.query(
      `UPDATE fad_event_subscriptions
          SET delivery_lease_until = transaction_timestamp() - interval '1 minute'
        WHERE organization_id = $1 AND id = $2`,
      [orgA.id, firstClaim.subscriptionId],
    );
    const reclaimed = await claimDelivery(pool, orgA.id);
    pass('S7-DLV-018', reclaimed !== null && reclaimed.jobId === firstClaim.jobId, `reclaimed=${reclaimed?.jobId === firstClaim.jobId}`);
    await acknowledgeDelivery(pool, reclaimed, {
      kind: 'success', httpStatus: 200, retryAfterSeconds: null, startedAt: new Date(),
    });
    const next = await claimDelivery(pool, orgA.id);
    pass('S7-DLV-005', secondUpdate.status === 200 && next !== null && firstClaim.eventSequence < next.eventSequence && next.eventId === secondEvent.event_id,
      `first=${firstClaim?.eventSequence} next=${next?.eventSequence}`);
    await acknowledgeDelivery(pool, next, {
      kind: 'success', httpStatus: 200, retryAfterSeconds: null, startedAt: new Date(),
    });

    const heldUpdate = await call(api.base, 'PATCH', `/v1/agents/${agentA}`, keyAdmin.api_key, { description: 'gap hold' }, {
      'idempotency-key': `gap-hold-${stamp}`, 'if-match': secondUpdate.headers.etag,
    });
    await superuser.query(
      `UPDATE fad_event_subscriptions SET callback_url = $3 WHERE organization_id = $1 AND id = $2`,
      [orgA.id, liveId, hook('/hold')],
    );
    await fanoutOrganization(pool, orgA.id);
    const heldClaim = await claimDelivery(pool, orgA.id);
    const heldSend = postSignedWebhook(heldClaim);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const idle = await superuser.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE application_name = 'fad-s7-matrix' AND state = 'idle in transaction'`,
    );
    releaseHold();
    const heldResult = await heldSend;
    pass('S7-DLV-006', heldUpdate.status === 200 && heldResult.status === 200 && idle.rows[0].n === 0,
      `http=${heldResult.status} idle_in_transaction=${idle.rows[0].n}`);
    await acknowledgeDelivery(pool, heldClaim, {
      kind: 'success', httpStatus: heldResult.status, retryAfterSeconds: null, startedAt: new Date(),
    });
    await superuser.query(
      `UPDATE fad_event_subscriptions SET callback_url = $3 WHERE organization_id = $1 AND id = $2`,
      [orgA.id, liveId, hook('/ok')],
    );

    const closed = await freePort();
    process.env.FAD_EVENTS_TEST_PORT = String(closed);
    await superuser.query(
      `UPDATE fad_event_subscriptions SET callback_url = $3 WHERE organization_id = $1 AND id = $2`,
      [orgA.id, liveId, `https://hooks.test:${closed}/gone`],
    );
    const refusedUpdate = await call(api.base, 'PATCH', `/v1/agents/${agentA}`, keyAdmin.api_key, { description: 'gap refused' }, {
      'idempotency-key': `gap-refused-${stamp}`, 'if-match': heldUpdate.headers.etag,
    });
    await tickOrg(orgA.id);
    process.env.FAD_EVENTS_TEST_PORT = String(hookPort);
    await superuser.query(
      `UPDATE fad_event_subscriptions SET callback_url = $3 WHERE organization_id = $1 AND id = $2`,
      [orgA.id, liveId, hook('/ok')],
    );
    const refusedJob = await superuser.query(
      `SELECT j.status, j.attempt_count, j.last_http_status
         FROM fad_event_delivery_jobs j
         JOIN fad_outbox_events e ON e.organization_id = j.organization_id AND e.event_id = j.event_id
        WHERE j.organization_id = $1 AND j.subscription_id = $2 AND e.event_type = 'com.fad.agent.updated.v1'
        ORDER BY e.sequence DESC LIMIT 1`,
      [orgA.id, liveId],
    );
    pass('S7-DLV-012', refusedUpdate.status === 200 && refusedJob.rows[0]?.status === 'pending' && refusedJob.rows[0]?.attempt_count >= 1 && refusedJob.rows[0]?.last_http_status === null,
      `status=${refusedJob.rows[0]?.status} attempts=${refusedJob.rows[0]?.attempt_count} http=${refusedJob.rows[0]?.last_http_status}`);
    await superuser.query(
      `UPDATE fad_event_delivery_jobs
          SET next_attempt_at = transaction_timestamp()
        WHERE organization_id = $1 AND subscription_id = $2 AND status = 'pending'`,
      [orgA.id, liveId],
    );
    const cleared = await claimDelivery(pool, orgA.id);
    if (cleared) {
      await acknowledgeDelivery(pool, cleared, {
        kind: 'success', httpStatus: 200, retryAfterSeconds: null, startedAt: new Date(),
      });
    }

    await superuser.query(
      `UPDATE fad_event_subscriptions SET callback_url = $3 WHERE organization_id = $1 AND id = $2`,
      [orgA.id, liveId, hook('/stall')],
    );
    const stallUpdate = await call(api.base, 'PATCH', `/v1/agents/${agentA}`, keyAdmin.api_key, { description: 'gap stall' }, {
      'idempotency-key': `gap-stall-${stamp}`, 'if-match': refusedUpdate.headers.etag,
    });
    await tickOrg(orgA.id);
    await superuser.query(
      `UPDATE fad_event_subscriptions SET callback_url = $3 WHERE organization_id = $1 AND id = $2`,
      [orgA.id, liveId, hook('/ok')],
    );
    const stallJob = await superuser.query(
      `SELECT j.status, j.attempt_count, j.last_http_status
         FROM fad_event_delivery_jobs j
         JOIN fad_outbox_events e ON e.organization_id = j.organization_id AND e.event_id = j.event_id
        WHERE j.organization_id = $1 AND j.subscription_id = $2
        ORDER BY e.sequence DESC LIMIT 1`,
      [orgA.id, liveId],
    );
    pass('S7-DLV-011', stallUpdate.status === 200 && stallJob.rows[0]?.attempt_count >= 1 && stallJob.rows[0]?.last_http_status === null && stallJob.rows[0]?.status === 'pending',
      `status=${stallJob.rows[0]?.status} attempts=${stallJob.rows[0]?.attempt_count}`);

    const rotate = await call(api.base, 'POST', `/v1/event-subscriptions/${liveId}/rotate-secret`, keyAdmin.api_key, undefined, {
      'idempotency-key': `gap-rot-${stamp}`, 'if-match': liveSeen.headers.etag,
    });
    const overlap = await superuser.query(
      `SELECT status, EXTRACT(EPOCH FROM (retire_after - transaction_timestamp())) AS secs
         FROM fad_webhook_secrets
        WHERE organization_id = $1 AND subscription_id = $2 AND status = 'overlap'`,
      [orgA.id, liveId],
    );
    const got = await call(api.base, 'GET', `/v1/event-subscriptions/${liveId}`, keyAdmin.api_key);
    pass('S7-API-021', rotate.status === 200 && typeof rotate.json?.data?.signing_secret === 'string'
      && rotate.headers.etag !== live.headers.etag && got.text.includes(rotate.json.data.signing_secret) === false,
    `status=${rotate.status} etag_changed=${rotate.headers.etag !== live.headers.etag}`);
    pass('S7-SEC-014', overlap.rows.length === 1 && overlap.rows[0].secs > 14 * 60 && overlap.rows[0].secs <= 15 * 60 + 5,
      `secs=${overlap.rows[0]?.secs}`);

    const tooWide = await call(api.base, 'POST', `/v1/event-subscriptions/${liveId}/replays`, keyAdmin.api_key, {
      after_sequence: 0, through_sequence: 10001, reason: 'too wide',
    }, { 'idempotency-key': `gap-wide-${stamp}` });
    pass('S7-DLV-019', tooWide.status === 400 && tooWide.json?.error?.code === 'VALIDATION_ERROR', tooWide.json?.error?.code ?? String(tooWide.status));
    const noReplay = await call(api.base, 'POST', `/v1/event-subscriptions/${liveId}/replays`, keyRead.api_key, {
      after_sequence: 0, through_sequence: 1, reason: 'missing scope',
    }, { 'idempotency-key': `gap-noreplay-${stamp}` });
    pass('S7-ORG-009', noReplay.status === 403 && noReplay.json?.error?.code === 'FORBIDDEN', noReplay.json?.error?.code ?? String(noReplay.status));
    const partialReplay = await call(api.base, 'POST', `/v1/event-subscriptions/${liveId}/replays`, keyReplay.api_key, {
      after_sequence: 0, through_sequence: 1, reason: 'missing restricted',
    }, { 'idempotency-key': `gap-partial-${stamp}` });
    pass('S7-DLV-023', partialReplay.status === 403 && partialReplay.json?.error?.code === 'FORBIDDEN', partialReplay.json?.error?.code ?? String(partialReplay.status));
    const stream = await superuser.query('SELECT last_sequence::int AS last FROM fad_event_streams WHERE organization_id = $1', [orgA.id]);
    const replay = await call(api.base, 'POST', `/v1/event-subscriptions/${liveId}/replays`, keyAdmin.api_key, {
      after_sequence: Math.max(0, stream.rows[0].last - 1), through_sequence: stream.rows[0].last, reason: 'gap replay',
    }, { 'idempotency-key': `gap-replay-${stamp}` });
    const replayId = replay.json?.data?.id;
    const replayGet = await call(api.base, 'GET', `/v1/event-subscriptions/${liveId}/replays/${replayId}`, keyAdmin.api_key);
    const noDelivery = await call(api.base, 'GET', `/v1/event-subscriptions/${liveId}/deliveries?limit=10`, keyRead.api_key);
    pass('S7-ORG-010', noDelivery.status === 403 && noDelivery.json?.error?.code === 'FORBIDDEN', noDelivery.json?.error?.code ?? String(noDelivery.status));
    const deliveries = await call(api.base, 'GET', `/v1/event-subscriptions/${liveId}/deliveries?limit=100`, keyAdmin.api_key);
    const deliveryText = JSON.stringify(deliveries.json ?? {});
    pass('S7-API-022', replay.status === 201 && replayGet.status === 200 && replayGet.json?.data?.id === replayId && deliveries.status === 200 && Array.isArray(deliveries.json?.data),
      `replay=${replay.status} get=${replayGet.status} deliveries=${deliveries.status}`);
    const attemptColumns = await superuser.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'fad_event_delivery_attempts'`,
    );
    const columnNames = attemptColumns.rows.map((row) => row.column_name);
    const leakedColumn = columnNames.some((name) => /url|body|secret|payload|callback/i.test(name));
    pass('S7-DLV-027', leakedColumn === false && deliveryText.includes(liveSecret) === false && deliveryText.includes('callback_url') === false && deliveryText.includes(hook('/ok')) === false,
      `columns=${columnNames.join(',')} callback=${deliveryText.includes('callback_url')}`);
    const foreignDelivery = await call(api.base, 'GET', `/v1/event-subscriptions/${liveId}/deliveries`, keyB.api_key);
    pass('S7-ORG-024', foreignDelivery.status === 404, String(foreignDelivery.status));

    const paused = await call(api.base, 'PATCH', `/v1/event-subscriptions/${liveId}`, keyAdmin.api_key, { status: 'paused' }, {
      'idempotency-key': `gap-pause-${stamp}`, 'if-match': rotate.headers.etag,
    });
    const pausedReplay = await call(api.base, 'POST', `/v1/event-subscriptions/${liveId}/replays`, keyAdmin.api_key, {
      after_sequence: 0, through_sequence: 1, reason: 'paused',
    }, { 'idempotency-key': `gap-paused-replay-${stamp}` });
    pass('S7-DLV-025', paused.status === 200 && paused.json?.data?.status === 'paused' && pausedReplay.status === 409,
      `pause=${paused.status} replay=${pausedReplay.status}`);
    const postsBefore = posts.length;
    const eventsBefore = await superuser.query('SELECT count(*)::int AS n FROM fad_outbox_events WHERE organization_id = $1', [orgA.id]);
    const whilePaused = await call(api.base, 'PATCH', `/v1/agents/${agentA}`, keyAdmin.api_key, { description: 'gap paused capture' }, {
      'idempotency-key': `gap-paused-upd-${stamp}`, 'if-match': stallUpdate.headers.etag,
    });
    await tickOrg(orgA.id);
    const eventsAfter = await superuser.query('SELECT count(*)::int AS n FROM fad_outbox_events WHERE organization_id = $1', [orgA.id]);
    pass('S7-OPS-013', whilePaused.status === 200 && eventsAfter.rows[0].n === eventsBefore.rows[0].n + 1 && posts.length === postsBefore,
      `events=${eventsAfter.rows[0].n - eventsBefore.rows[0].n} posts_delta=${posts.length - postsBefore}`);
    const resumed = await call(api.base, 'PATCH', `/v1/event-subscriptions/${liveId}`, keyAdmin.api_key, { status: 'active' }, {
      'idempotency-key': `gap-resume-${stamp}`, 'if-match': paused.headers.etag,
    });
    const terminal = await subscribe(keyAdmin.api_key, '/ok', ['com.fad.agent.registered.v1'], `gap-terminal-${stamp}`);
    await tickOrg(orgA.id);
    const terminalSeen = await call(api.base, 'GET', `/v1/event-subscriptions/${terminal.json?.data?.subscription?.id}`, keyAdmin.api_key);
    const terminalOff = await call(api.base, 'PATCH', `/v1/event-subscriptions/${terminal.json?.data?.subscription?.id}`, keyAdmin.api_key, { status: 'disabled' }, {
      'idempotency-key': `gap-disable-${stamp}`, 'if-match': terminalSeen.headers.etag,
    });
    const terminalOn = await call(api.base, 'PATCH', `/v1/event-subscriptions/${terminal.json?.data?.subscription?.id}`, keyAdmin.api_key, { status: 'active' }, {
      'idempotency-key': `gap-reenable-${stamp}`, 'if-match': terminalOff.headers.etag,
    });
    pass('S7-API-020', resumed.status === 200 && terminalOff.status === 200 && terminalOn.status === 409 && terminalOn.json?.error?.code === 'CONFLICT',
      `resume=${resumed.status} disable=${terminalOff.status} again=${terminalOn.status}`);

    const denySub = await subscribe(keySub.api_key, '/ok', ['com.fad.agent.updated.v1'], `gap-denysub-${stamp}`);
    const denyClaim = await claimVerification(pool, orgA.id);
    if (denyClaim) {
      const denyBody = Buffer.from(JSON.stringify({
        type: 'fad.webhook.challenge.v1', challenge: denyClaim.challenge, subscription_id: denyClaim.subscriptionId,
      }));
      const denySent = await postSignedWebhook({
        url: denyClaim.url, secret: denyClaim.secret, keyId: denyClaim.keyId,
        eventId: denyClaim.subscriptionId, deliveryId: randomUUID(), body: denyBody,
      });
      await finishVerification(pool, orgA.id, denyClaim.subscriptionId, denySent.status, denySent.body);
    }
    const allowAgain = await call(api.base, 'POST', '/v1/policies', keyAdmin.api_key, {
      name: `GapRead${stamp}`, description: 'allow admin read', effect: 'allow', actions: ['agent.read'],
      subjects: { principal_ids: [adminA.id] }, resource: { type: 'agent', agent_ids: [agentA] },
    }, { 'idempotency-key': `gap-allow2-${stamp}` });
    const allowOn = await call(api.base, 'POST', `/v1/policies/${allowAgain.json?.data?.id}/activate`, keyAdmin.api_key, undefined, {
      'idempotency-key': `gap-allow2-on-${stamp}`, 'if-match': allowAgain.headers.etag,
    });
    const enfNow = await call(api.base, 'GET', '/v1/enforcement/config', keyAdmin.api_key);
    const enfPre = await call(api.base, 'POST', '/v1/enforcement/preflight', keyAdmin.api_key, {
      mode: 'enforce', actions: ['agent.read'], reason: 'gap enforce',
    });
    const enforced = await call(api.base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'enforce', actions: ['agent.read'], reason: 'gap enforce',
      preflight_id: enfPre.json?.data?.preflight_id, acknowledge_default_deny: true,
    }, { 'idempotency-key': `gap-enforce-${stamp}`, 'if-match': enfNow.headers.etag });
    const hidden = await call(api.base, 'GET', '/v1/events?limit=100', keySub.api_key);
    const visible = await call(api.base, 'GET', '/v1/events?limit=100', keyAdmin.api_key);
    const hiddenAgent = (hidden.json?.data ?? []).some((item) => item.data?.agent_id === agentA);
    const shownAgent = (visible.json?.data ?? []).some((item) => item.data?.agent_id === agentA);
    pass('S7-ORG-016', allowOn.status === 200 && enforced.status === 200 && hidden.status === 200 && hiddenAgent === false && shownAgent === true,
      `enforce=${enforced.status} hidden=${hiddenAgent} shown=${shownAgent}`);
    await superuser.query(
      `UPDATE fad_event_delivery_jobs
          SET status = 'succeeded', lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
        WHERE organization_id = $1 AND subscription_id = $2 AND status IN ('pending', 'leased')`,
      [orgA.id, liveId],
    );
    await superuser.query(
      `UPDATE fad_event_subscriptions
          SET delivery_lease_owner = NULL, delivery_lease_token = NULL, delivery_lease_until = NULL
        WHERE organization_id = $1 AND id = $2`,
      [orgA.id, liveId],
    );
    const deniedUpdate = await call(api.base, 'PATCH', `/v1/agents/${agentA}`, keyAdmin.api_key, { description: 'gap denied delivery' }, {
      'idempotency-key': `gap-deny-upd-${stamp}`, 'if-match': whilePaused.headers.etag,
    });
    await fanoutOrganization(pool, orgA.id);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const claim = await claimDelivery(pool, orgA.id);
      if (!claim) break;
      await acknowledgeDelivery(pool, claim, {
        kind: 'success', httpStatus: 200, retryAfterSeconds: null, startedAt: new Date(),
      });
    }
    const deniedJob = await superuser.query(
      `SELECT j.status, j.last_error_code
         FROM fad_event_delivery_jobs j
         JOIN fad_outbox_events e ON e.organization_id = j.organization_id AND e.event_id = j.event_id
        WHERE j.organization_id = $1 AND j.subscription_id = $2
        ORDER BY e.sequence DESC LIMIT 1`,
      [orgA.id, denySub.json?.data?.subscription?.id],
    );
    pass('S7-ORG-017', deniedUpdate.status === 200 && deniedJob.rows[0]?.status === 'cancelled' && deniedJob.rows[0]?.last_error_code === 'policy_denied',
      `status=${deniedJob.rows[0]?.status} reason=${deniedJob.rows[0]?.last_error_code}`);
    const backOff = await call(api.base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'off', actions: [], reason: 'return enforce off', acknowledge_default_deny: false,
    }, { 'idempotency-key': `gap-enforce-off-${stamp}`, 'if-match': enforced.headers.etag });
    pass('ENF-BACK', backOff.status === 200, String(backOff.status));

    const blockedRow = await superuser.query(
      `SELECT status FROM fad_event_subscriptions WHERE organization_id = $1 AND id = $2`,
      [orgA.id, blockedSub.json?.data?.subscription?.id],
    );
    const reactivated = await call(api.base, 'POST', '/v1/agents', keyAdmin.api_key, {
      name: `Gap C ${stamp}`, description: 'gap three', owner_principal_id: owner.id,
    }, { 'idempotency-key': `gap-reg-c-${stamp}` });
    const agentC = reactivated.json?.data?.id;
    const life = await call(api.base, 'POST', `/v1/agents/${agentC}/suspend`, keyAdmin.api_key, { reason: 'gap block delivery' }, {
      'idempotency-key': `gap-block-sus-${stamp}`, 'if-match': reactivated.headers.etag,
    });
    await fanoutOrganization(pool, orgA.id);
    await created(['principal', 'disable', '--organization-id', orgA.id, '--principal-id', blocked.id, '--reason', 'gap disable']);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const claim = await claimDelivery(pool, orgA.id);
      if (!claim) break;
      await acknowledgeDelivery(pool, claim, {
        kind: 'success', httpStatus: 200, retryAfterSeconds: null, startedAt: new Date(),
      });
    }
    const blockedJob = await superuser.query(
      `SELECT j.status, j.last_error_code
         FROM fad_event_delivery_jobs j
        WHERE j.organization_id = $1 AND j.subscription_id = $2
        ORDER BY j.created_at DESC LIMIT 1`,
      [orgA.id, blockedSub.json?.data?.subscription?.id],
    );
    pass('S7-ORG-014', blockedRow.rows[0]?.status === 'active' && life.status === 200 && blockedJob.rows[0]?.status === 'cancelled' && blockedJob.rows[0]?.last_error_code === 'owner_inactive',
      `sub=${blockedRow.rows[0]?.status} job=${blockedJob.rows[0]?.status} reason=${blockedJob.rows[0]?.last_error_code}`);

    const logs = api.logs();
    const secretInLogs = logs.includes(liveSecret) || logs.includes(rotate.json.data.signing_secret);
    const secretInAudit = await superuser.query(
      `SELECT count(*)::int AS n FROM audit_events
        WHERE organization_id = $1 AND details::text LIKE $2`,
      [orgA.id, `%${liveSecret.slice(0, 12)}%`],
    );
    pass('S7-OPS-021', secretInLogs === false && secretInAudit.rows[0].n === 0, `logs=${secretInLogs} audit=${secretInAudit.rows[0].n}`);
    const guardUpdate = await call(api.base, 'PATCH', `/v1/agents/${agentA}`, keyAdmin.api_key, { description: 'gap prune guard' }, {
      'idempotency-key': `gap-prune-${stamp}`, 'if-match': deniedUpdate.headers.etag,
    });
    await fanoutOrganization(pool, orgA.id);
    pass('PRUNE-GUARD', guardUpdate.status === 200, String(guardUpdate.status));
    await api.stop();
    api = undefined;
    const replayLeft = await superuser.query(
      `SELECT status FROM fad_event_replay_requests WHERE organization_id = $1 AND id = $2`,
      [orgA.id, replayId],
    );
    pass('S7-DLV-026', replayLeft.rows[0]?.status !== undefined && replayLeft.rows[0]?.status !== null, `status=${replayLeft.rows[0]?.status}`);

    const appSeen = await app.query('SELECT count(*)::int AS n FROM fad_outbox_events');
    const rootSeen = await superuser.query('SELECT count(*)::int AS n FROM fad_outbox_events WHERE organization_id = $1', [orgA.id]);
    pass('S7-ORG-022', appSeen.rows[0].n === 0 && rootSeen.rows[0].n > 0, `app=${appSeen.rows[0].n} root=${rootSeen.rows[0].n}`);
    let fkCode = '';
    await superuser.query('BEGIN');
    await superuser.query('SAVEPOINT gap_fk');
    try {
      await superuser.query(
        `INSERT INTO fad_event_subscriptions (organization_id, id, owner_principal_id, callback_url, event_types)
         VALUES ($1, $2, $3, 'https://hooks.test/fk', ARRAY['com.fad.agent.registered.v1'])`,
        [orgA.id, randomUUID(), adminB.id],
      );
    } catch (error) {
      fkCode = error.code ?? '';
    }
    await superuser.query('ROLLBACK TO SAVEPOINT gap_fk');
    await superuser.query('COMMIT');
    pass('S7-ORG-023', fkCode === '23503', fkCode);

    let objectCode = '';
    let boundCode = '';
    await superuser.query('BEGIN');
    await superuser.query('SAVEPOINT gap_payload');
    try {
      await superuser.query(
        `INSERT INTO fad_outbox_events (
           organization_id, event_id, sequence, event_type, subject, aggregate_type, visibility, payload
         ) VALUES ($1, $2, 900000000001, 'com.fad.agent.updated.v1', 'agent/x', 'agent', 'standard', '[]'::jsonb)`,
        [orgA.id, randomUUID()],
      );
    } catch (error) {
      objectCode = error.code ?? '';
    }
    await superuser.query('ROLLBACK TO SAVEPOINT gap_payload');
    await superuser.query('SAVEPOINT gap_bound');
    try {
      await superuser.query(
        `INSERT INTO fad_outbox_events (
           organization_id, event_id, sequence, event_type, subject, aggregate_type, visibility, payload
         ) VALUES ($1, $2, 900000000002, 'com.fad.agent.updated.v1', 'agent/x', 'agent', 'standard', $3::jsonb)`,
        [orgA.id, randomUUID(), JSON.stringify({ blob: 'x'.repeat(9000) })],
      );
    } catch (error) {
      boundCode = error.code ?? '';
    }
    await superuser.query('ROLLBACK');
    pass('S7-OUT-023', objectCode === '23514' && boundCode === '23514', `object=${objectCode} bound=${boundCode}`);

    const pending = await superuser.query(
      `SELECT e.sequence::int AS sequence
         FROM fad_event_delivery_jobs j
         JOIN fad_outbox_events e ON e.organization_id = j.organization_id AND e.event_id = j.event_id
        WHERE j.organization_id = $1 AND j.status IN ('pending', 'leased')
        ORDER BY e.sequence ASC LIMIT 1`,
      [orgA.id],
    );
    let protectedCode = '';
    if (pending.rows[0]) {
      try {
        await superuser.query('SELECT fad_s7_prune_retained($1, $2)', [orgA.id, pending.rows[0].sequence + 1]);
      } catch (error) {
        protectedCode = error.code ?? '';
      }
    }
    pass('S7-OPS-015', pending.rows[0] !== undefined && protectedCode === '55000', `pending=${pending.rows[0]?.sequence} code=${protectedCode}`);
    await superuser.query(
      `UPDATE fad_event_replay_requests SET status = 'completed'
        WHERE organization_id = $1 AND status IN ('queued', 'running')`,
      [orgA.id],
    );
    await superuser.query(
      `UPDATE fad_event_delivery_jobs
          SET status = 'succeeded', lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
        WHERE organization_id = $1 AND status IN ('pending', 'leased')`,
      [orgA.id],
    );
    const bound = pending.rows[0] ? pending.rows[0].sequence + 1 : 1;
    const removed = await superuser.query('SELECT fad_s7_prune_retained($1, $2)::int AS n', [orgA.id, bound]);
    const watermark = await superuser.query(
      'SELECT min_retained_sequence::int AS min FROM fad_event_streams WHERE organization_id = $1',
      [orgA.id],
    );
    pass('S7-OPS-016', removed.rows[0].n >= 0 && watermark.rows[0].min >= bound, `removed=${removed.rows[0].n} min=${watermark.rows[0].min} bound=${bound}`);

    const composeEnv = {
      ...process.env,
      FAD_DEV_POSTGRES_PASSWORD: 'local-only',
      FAD_APP_DB_PASSWORD: 'local-only',
      FAD_API_KEY_PEPPER_V1: 'local-only-pepper-32-bytes-minimum',
      FAD_EVENTS_ENABLED: 'true',
      FAD_EVENTS_SECRET_KEY: 'local-only-secret',
    };
    const rendered = execFileSync('docker', [
      'compose', '-f', 'deploy/docker/compose.yaml', '-f', 'deploy/docker/compose.events-overlay.yaml', 'config', '--format', 'json',
    ], { cwd: repo, encoding: 'utf8', env: composeEnv });
    const compose = JSON.parse(rendered);
    const apiImage = compose.services?.api?.image;
    const workerImage = compose.services?.worker?.image;
    const workerCommand = (compose.services?.worker?.command ?? []).join(' ');
    pass('S7-OPS-001', apiImage && apiImage === workerImage && workerCommand.includes('event-worker.js'),
      `api=${apiImage} worker=${workerImage} command=${workerCommand}`);
  } finally {
    if (api) await api.stop().catch(() => undefined);
    receiver.close();
    await pool.end().catch(() => undefined);
    await superuser.query('UPDATE fad_event_capture_control SET required = false WHERE id = true').catch(() => undefined);
    await superuser.end().catch(() => undefined);
    await app.end().catch(() => undefined);
    delete process.env.FAD_EVENTS_ENABLED;
    delete process.env.FAD_EVENTS_SECRET_KEY;
    delete process.env.FAD_EVENTS_LEASE_MS;
    delete process.env.FAD_ENFORCEMENT_CODE_ENABLED;
    delete process.env.FAD_POLICIES_ENABLED;
    delete process.env.FAD_EVENTS_TEST_EGRESS;
    delete process.env.FAD_EVENTS_TEST_HOSTS;
    delete process.env.FAD_EVENTS_TEST_PORT;
    delete process.env.FAD_EVENTS_TEST_CA;
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.ALL_PROXY;
    writeFileSync(`${evidenceDir}matrix-gap.log`, `${lines.join('\n')}\n`);
  }
});
