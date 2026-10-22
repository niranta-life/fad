import { createHash, createHmac, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import pg from 'pg';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { applyMigrations } from '@fad/migrator';
import {
  acknowledgeDelivery,
  appendDirectoryEvent,
  assertWebhookDestination,
  claimDelivery,
  createPool,
  migrationChecksum,
  postSignedWebhook,
  postWebhook,
} from '@fad/db';
import { verifyFadWebhookSignature } from '@fad/sdk';
import { admin, check, freePort, parseJson, request, requiredEnv, scratch, startApi, stopApis } from './support.mjs';

const { Client: PgClient } = pg;
const appUrl = requiredEnv('DATABASE_URL');
const migratorUrl = requiredEnv('FAD_MIGRATOR_DATABASE_URL');
const pepper = requiredEnv('FAD_API_KEY_PEPPER_V1');
const repo = new URL('..', import.meta.url).pathname;
const migrationsDir = new URL('../db/migrations/', import.meta.url).pathname;
const migrationFile = new URL('../db/migrations/20261021_007_durable_events.up.sql', import.meta.url);
const evidenceDir = new URL('../docs/releases/slice-7/', import.meta.url).pathname;
const stamp = Date.now().toString(36);
const VERSION = '20261021_007_durable_events';
const ADMIN = [
  'organizations:read', 'agents:read', 'agents:write', 'agents:lifecycle',
  'tags:define', 'tags:read', 'tags:write', 'tags:governance', 'tags:restricted:read',
  'policies:read', 'policies:write', 'policies:activate', 'policies:evaluate:any', 'policies:explain',
  'capabilities:read', 'capabilities:write', 'endpoints:read', 'endpoints:write',
  'enforcement:read', 'enforcement:manage', 'enforcement:audit',
  'events:read', 'events:subscribe', 'events:manage', 'events:replay', 'events:delivery:read', 'events:restricted:read',
].join(',');
const STANDARD = 'events:read,agents:read,tags:read,capabilities:read,endpoints:read';
const EVENTS_ONLY = 'events:read';
const SUBSCRIBE = 'events:subscribe,events:read,agents:read,tags:read';
const NARROW = 'events:subscribe';
const SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  properties: { invoice_id: { type: 'string' } },
  required: ['invoice_id'],
};
const secrets = [pepper];
let adminKey = '';

function safe(value) {
  let text = String(value ?? '');
  for (const secret of secrets) {
    if (secret && secret.length > 4) text = text.split(secret).join('[redacted]');
  }
  return text.replace(/eyJ[A-Za-z0-9_-]{8,}/g, '[redacted-jwt]').replace(/fad_live\.[A-Za-z0-9_-]+/g, '[redacted-key]');
}

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
  if (result.code !== 0) throw new Error(`${args.slice(0, 2).join(' ')} ${safe(result.stderr).slice(0, 240)}`);
  return parseJson(result.stdout);
}

function remember(value) {
  if (value) secrets.push(value);
  return value;
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function payloadOf(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  const text = result?.content?.find((item) => item.type === 'text')?.text;
  return text ? JSON.parse(text) : null;
}

async function tool(client, name, args) {
  try {
    const result = await client.callTool({ name, arguments: args });
    return { error: result.isError === true, body: payloadOf(result) };
  } catch (error) {
    const message = safe(error).slice(0, 400);
    const rejected = /invalid params|unrecognized key|input vali/i.test(message);
    return { error: true, body: { error: { code: rejected ? 'VALIDATION_ERROR' : 'THREW', message } } };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function postgresContainer() {
  if (process.env.FAD_S7_PG_CONTAINER) return process.env.FAD_S7_PG_CONTAINER;
  const listed = execFileSync('docker', ['ps', '--format', '{{.Names}}\t{{.Image}}'], { encoding: 'utf8' });
  const rows = listed.split('\n').map((line) => line.trim()).filter(Boolean);
  const exact = rows.find((row) => row.startsWith('fad-s0-pg\t'));
  if (exact) return 'fad-s0-pg';
  const image = rows.find((row) => (row.split('\t')[1] ?? '').startsWith('postgres'));
  if (!image) throw new Error('postgres container missing');
  return image.split('\t')[0];
}

const DEPLOYED_MCP_TOOLS = [
  'fad_list_agents', 'fad_get_agent', 'fad_register_agent', 'fad_update_agent', 'fad_suspend_agent', 'fad_activate_agent',
  'fad_list_agent_tags', 'fad_put_agent_tag', 'fad_search_agents_by_tags', 'fad_list_capabilities', 'fad_publish_capability',
  'fad_put_endpoint', 'fad_put_binding', 'fad_discover_agents', 'fad_list_policies', 'fad_get_policy', 'fad_create_policy',
  'fad_update_draft_policy', 'fad_activate_policy', 'fad_disable_policy', 'fad_evaluate_access', 'fad_get_enforcement_config',
  'fad_preflight_enforcement', 'fad_set_enforcement_config', 'fad_get_enforcement_decision',
  'fad_list_events', 'fad_get_event', 'fad_create_event_subscription', 'fad_list_event_subscriptions', 'fad_get_event_subscription',
  'fad_update_event_subscription', 'fad_rotate_event_subscription_secret', 'fad_replay_events', 'fad_get_event_replay', 'fad_list_event_deliveries',
];
const UNPUBLISHED_MCP_TOOLS = [
  'fad_retire_agent', 'fad_list_tag_definitions', 'fad_create_tag_definition', 'fad_get_agent_tag', 'fad_delete_agent_tag',
  'fad_get_capability', 'fad_list_endpoints', 'fad_get_endpoint', 'fad_delete_endpoint', 'fad_list_bindings', 'fad_get_binding', 'fad_delete_binding',
];
const MCP_INPUT_KEYS = {
  fad_list_agents: ['cursor', 'limit', 'status'],
  fad_get_agent: ['agent_id'],
  fad_register_agent: ['agent', 'idempotency_key'],
  fad_update_agent: ['agent_id', 'idempotency_key', 'if_match', 'patch'],
  fad_suspend_agent: ['agent_id', 'idempotency_key', 'if_match', 'reason'],
  fad_activate_agent: ['agent_id', 'idempotency_key', 'if_match', 'reason'],
  fad_list_agent_tags: ['agent_id'],
  fad_put_agent_tag: ['agent_id', 'assignment', 'idempotency_key', 'if_match', 'if_none_match', 'key', 'namespace'],
  fad_search_agents_by_tags: ['query'],
  fad_list_capabilities: ['cursor', 'id', 'limit'],
  fad_publish_capability: ['capability', 'idempotency_key'],
  fad_put_endpoint: ['agent_id', 'endpoint', 'endpoint_key', 'idempotency_key', 'if_match', 'if_none_match'],
  fad_put_binding: ['agent_id', 'binding', 'capability_id', 'idempotency_key', 'if_match', 'if_none_match'],
  fad_discover_agents: ['query'],
  fad_list_policies: ['cursor', 'limit', 'status'],
  fad_get_policy: ['policy_id'],
  fad_create_policy: ['definition', 'idempotency_key'],
  fad_update_draft_policy: ['definition', 'idempotency_key', 'if_match', 'policy_id'],
  fad_activate_policy: ['idempotency_key', 'if_match', 'policy_id'],
  fad_disable_policy: ['idempotency_key', 'if_match', 'policy_id'],
  fad_evaluate_access: ['action', 'context', 'resource', 'subject'],
  fad_get_enforcement_config: [],
  fad_preflight_enforcement: ['actions', 'mode', 'reason'],
  fad_set_enforcement_config: ['acknowledge_default_deny', 'actions', 'idempotency_key', 'if_match', 'mode', 'preflight_id', 'reason'],
  fad_get_enforcement_decision: ['decision_id'],
  fad_list_events: ['cursor', 'limit', 'type'],
  fad_get_event: ['event_id'],
  fad_create_event_subscription: ['callback_url', 'description', 'event_types', 'idempotency_key'],
  fad_list_event_subscriptions: ['cursor', 'limit'],
  fad_get_event_subscription: ['subscription_id'],
  fad_update_event_subscription: ['idempotency_key', 'if_match', 'status', 'subscription_id'],
  fad_rotate_event_subscription_secret: ['idempotency_key', 'if_match', 'subscription_id'],
  fad_replay_events: ['after_sequence', 'idempotency_key', 'reason', 'subscription_id', 'through_sequence'],
  fad_get_event_replay: ['replay_id', 'subscription_id'],
  fad_list_event_deliveries: ['cursor', 'limit', 'subscription_id'],
};

test('durable directory events, verified webhooks, and tenant isolation', { timeout: 900_000 }, async () => {
  const atomicity = [];
  const privacy = [];
  const webhook = [];
  const sdkNotes = [];
  const deploy = [];
  const note = (bucket, id, detail) => {
    bucket.push(`${new Date().toISOString()} PASS ${id} ${safe(detail)}`);
    check(id, true, safe(detail));
  };
  const secretKey = randomUUID() + randomUUID();
  process.env.FAD_EVENTS_ENABLED = 'true';
  process.env.FAD_EVENTS_SECRET_KEY = secretKey;
  process.env.FAD_EVENTS_LEASE_MS = '800';
  process.env.FAD_ENFORCEMENT_CODE_ENABLED = 'true';
  const posts = [];
  let mode = 'ok';
  let releaseHold = () => undefined;
  const certDir = mkdtempSync(join(scratch, 's7-cert-'));
  const hookKey = join(certDir, 'hook.key');
  const hookCert = join(certDir, 'hook.crt');
  const issuerKey = join(certDir, 'issuer.key');
  const issuerCert = join(certDir, 'issuer.crt');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-keyout', hookKey, '-out', hookCert, '-days', '2', '-nodes',
    '-subj', '/CN=hooks.test', '-addext', 'subjectAltName=DNS:hooks.test',
  ], { stdio: 'ignore' });
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-keyout', issuerKey, '-out', issuerCert, '-days', '2', '-nodes',
    '-subj', '/CN=fad-s7-issuer', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
  ], { stdio: 'ignore' });
  const hookPort = await freePort();
  const receiver = https.createServer({ key: readFileSync(hookKey), cert: readFileSync(hookCert) }, async (req, res) => {
    const raw = await readRaw(req);
    let parsed = null;
    try { parsed = JSON.parse(raw.toString('utf8')); } catch { parsed = null; }
    const challenge = parsed && parsed.type === 'fad.webhook.challenge.v1' && typeof parsed.challenge === 'string';
    posts.push({ path: req.url ?? '/', raw, headers: req.headers, challenge });
    const path = req.url ?? '/';
    if (challenge && !path.startsWith('/silent')) {
      const body = Buffer.from(JSON.stringify({ challenge: parsed.challenge }));
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length, connection: 'close' });
      res.end(body);
      return;
    }
    if (path.startsWith('/silent')) {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': 2, connection: 'close' });
      res.end('{}');
      return;
    }
    if (mode === 'hold' && path.startsWith('/hold')) {
      await new Promise((resolve) => { releaseHold = resolve; });
    }
    if (mode === '503') {
      res.writeHead(503, { 'content-length': 0, connection: 'close' });
      res.end();
      return;
    }
    if (mode === '429' && path.startsWith('/retry')) {
      res.writeHead(429, { 'retry-after': '30', 'content-length': 0, connection: 'close' });
      res.end();
      return;
    }
    if (mode === '400' && path.startsWith('/retry')) {
      res.writeHead(400, { 'content-length': 0, connection: 'close' });
      res.end();
      return;
    }
    if (mode === '302') {
      res.writeHead(302, { location: 'https://hooks.test/elsewhere', 'content-length': 0, connection: 'close' });
      res.end();
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
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = 's7-kid';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  const issuerServer = https.createServer({ key: readFileSync(issuerKey), cert: readFileSync(issuerCert) }, (req, res) => {
    if ((req.url ?? '').split('?')[0] === '/.well-known/jwks.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => issuerServer.listen(0, '127.0.0.1', resolve));
  const issuer = `https://127.0.0.1:${issuerServer.address().port}`;
  const superuser = new PgClient({ connectionString: migratorUrl, application_name: 'fad-s7-super' });
  const app = new PgClient({ connectionString: appUrl, application_name: 'fad-s7-app' });
  superuser.on('error', () => undefined);
  app.on('error', () => undefined);
  await superuser.connect();
  await app.connect();
  const pool = createPool({
    connectionString: appUrl,
    max: 4,
    statementTimeoutMs: 20_000,
    applicationName: 'fad-s7-worker',
  });
  pool.on('error', () => undefined);
  let api;
  let mcpClient;
  const freshName = 'fad_s7_fresh';
  const restoreName = 'fad_s7_restore';
  try {
    const checksum = migrationChecksum(readFileSync(migrationFile));
    const first = await applyMigrations(migratorUrl, migrationsDir);
    const second = await applyMigrations(migratorUrl, migrationsDir);
    const stored = await superuser.query(`SELECT checksum_sha256 FROM schema_migrations WHERE version = $1`, [VERSION]);
    check('MIG-UP', (first.applied.includes(VERSION) || first.skipped.includes(VERSION))
      && second.skipped.includes(VERSION) && second.applied.includes(VERSION) === false
      && stored.rows[0]?.checksum_sha256 === checksum,
    `checksum=${checksum.slice(0, 12)} skipped=${second.skipped.includes(VERSION)}`);
    note(deploy, 'MIG-CHECKSUM', checksum);

    await superuser.query(`DROP DATABASE IF EXISTS ${freshName}`);
    await superuser.query(`CREATE DATABASE ${freshName}`);
    const freshUrl = new URL(migratorUrl);
    freshUrl.pathname = `/${freshName}`;
    const freshApplied = await applyMigrations(freshUrl.toString(), migrationsDir);
    const fresh = new PgClient({ connectionString: freshUrl.toString(), application_name: 'fad-s7-fresh' });
    await fresh.connect();
    const tables = [
      'fad_event_streams', 'fad_outbox_events', 'fad_event_subscriptions', 'fad_webhook_secrets',
      'fad_event_secret_receipts', 'fad_event_fanout_offsets', 'fad_event_replay_requests',
      'fad_event_delivery_jobs', 'fad_event_delivery_attempts',
    ];
    const forced = await fresh.query(
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
        ORDER BY 1`,
      [tables],
    );
    const grants = await fresh.query(
      `SELECT has_table_privilege('fad_app','fad_outbox_events','INSERT') AS outbox_insert,
              has_table_privilege('fad_app','fad_outbox_events','UPDATE') AS outbox_update,
              has_table_privilege('fad_app','fad_outbox_events','DELETE') AS outbox_delete,
              has_table_privilege('fad_app','fad_webhook_secrets','SELECT') AS secret_select,
              has_function_privilege('fad_app','fad_s7_prune_retained(uuid,bigint)','EXECUTE') AS prune_app,
              has_function_privilege('fad_bootstrap','fad_s7_prune_retained(uuid,bigint)','EXECUTE') AS prune_boot,
              has_table_privilege('fad_event_dispatcher','fad_webhook_secrets','SELECT') AS dispatcher_secret,
              has_table_privilege('fad_event_dispatcher','fad_event_streams','SELECT') AS dispatcher_stream`,
    );
    const roles = await fresh.query(
      `SELECT rolname, rolcanlogin, rolbypassrls FROM pg_roles
        WHERE rolname IN ('fad_app','fad_event_dispatcher','fad_bootstrap','fad_migrator') ORDER BY 1`,
    );
    const receiptWindow = await fresh.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'fad_s7_receipt_window'`,
    );
    const jobKey = await fresh.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'fad_s7_job_unique'`,
    );
    const guards = await fresh.query(
      `SELECT c.relname
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND t.tgname LIKE 'fad_s7_guard_%' AND NOT t.tgisinternal`,
    );
    const guardNames = new Set(guards.rows.map((row) => row.relname));
    const guardTables = [
      'agents', 'tag_definitions', 'agent_tag_assignments', 'capability_versions',
      'agent_endpoints', 'agent_capability_bindings', 'fad_policies', 'fad_enforcement_configs',
    ];
    await fresh.end();
    await superuser.query(`DROP DATABASE IF EXISTS ${freshName}`);
    const grant = grants.rows[0];
    const dispatcher = roles.rows.find((row) => row.rolname === 'fad_event_dispatcher');
    const appRole = roles.rows.find((row) => row.rolname === 'fad_app');
    check('MIG-FRESH', freshApplied.applied.includes(VERSION)
      && freshApplied.applied.includes('20261024_001_event_capture_guards')
      && forced.rows.length === tables.length
      && forced.rows.every((row) => row.relrowsecurity === true && row.relforcerowsecurity === true)
      && grant.outbox_insert === true && grant.outbox_update === false && grant.outbox_delete === false
      && grant.prune_app === false && grant.prune_boot === true
      && grant.dispatcher_secret === false && grant.dispatcher_stream === true
      && dispatcher?.rolcanlogin === false && dispatcher?.rolbypassrls === true
      && appRole?.rolcanlogin === true && appRole?.rolbypassrls === false
      && /24 hours|'24:00:00'::interval/.test(String(receiptWindow.rows[0]?.def ?? ''))
      && String(jobKey.rows[0]?.def ?? '').includes('subscription_id')
      && guardTables.every((name) => guardNames.has(name)),
    `tables=${forced.rows.length} guards=${guardNames.size} dispatcher_login=${dispatcher?.rolcanlogin}`);
    note(deploy, 'MIG-RLS', forced.rows.map((row) => row.relname).join(','));

    const orgA = await created(['organization', 'create', '--name', `Events A ${stamp}`]);
    const orgB = await created(['organization', 'create', '--name', `Events B ${stamp}`]);
    const orgLock = await created(['organization', 'create', '--name', `Events Lock ${stamp}`]);
    const adminA = await created(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Events Admin']);
    const reader = await created(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Events Reader']);
    const eventsOnly = await created(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Events Only']);
    const subscriber = await created(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Events Sub']);
    const narrow = await created(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Events Narrow']);
    const owner = await created(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Events Owner']);
    const adminB = await created(['principal', 'create', '--organization-id', orgB.id, '--type', 'service', '--name', 'Events B']);
    const issue = async (org, principal, scopes) => {
      const row = await created(['credential', 'issue', '--organization-id', org, '--principal-id', principal, '--scopes', scopes]);
      remember(row.api_key);
      return row;
    };
    const keyAdmin = await issue(orgA.id, adminA.id, ADMIN);
    adminKey = keyAdmin.api_key;
    const keyReader = await issue(orgA.id, reader.id, STANDARD);
    const keyReaderOther = await issue(orgA.id, reader.id, `${STANDARD},organizations:read`);
    const keyEvents = await issue(orgA.id, eventsOnly.id, EVENTS_ONLY);
    const keySub = await issue(orgA.id, subscriber.id, SUBSCRIBE);
    const keyNarrow = await issue(orgA.id, narrow.id, NARROW);
    const keyB = await issue(orgB.id, adminB.id, ADMIN);
    remember(secretKey);

    const locked = await lockProof(orgLock.id);
    check('LOCK-ORDER', locked.blocked && locked.rolledBack && locked.sequence === locked.before, `before=${locked.before} sequence=${locked.sequence}`);
    note(atomicity, 'LOCK-ORDER', `uncommitted lower sequence blocked=${locked.blocked} sequence=${locked.sequence}`);
    check('LOCK-FANOUT', locked.fanout === 'done' && locked.visible === 0 && locked.offset === locked.before && locked.before > 0,
      `fanout=${locked.fanout} visible=${locked.visible} offset=${locked.offset} before=${locked.before}`);
    note(atomicity, 'LOCK-FANOUT', `fanout cursor stayed at ${locked.offset} while an uncommitted event was open`);

    const apiPort = await freePort();
    const resource = `http://127.0.0.1:${apiPort}/mcp`;
    const offApi = await startApi({ PORT: String(await freePort()), FAD_EVENTS_ENABLED: 'false' });
    const hidden = await call(offApi.base, 'GET', '/v1/events', keyAdmin.api_key);
    check('FLAG-OFF', offApi.ready && hidden.status === 404, `status=${hidden.status}`);
    await offApi.stop();
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
      FAD_MCP_ENABLED: 'true',
      FAD_MCP_RESOURCE_URI: resource,
      FAD_MCP_EXPECTED_AUDIENCE: resource,
      FAD_MCP_AUTH_ISSUERS: issuer,
      FAD_HTTP_ALLOWED_HOSTS: `127.0.0.1:${apiPort}`,
      FAD_MCP_ALLOWED_ORIGINS: `http://127.0.0.1:${apiPort}`,
      FAD_MCP_JWKS_TLS_INSECURE: 'true',
      FAD_MCP_JWKS_COOLDOWN_MS: '0',
      FAD_HTTP_REQUEST_TIMEOUT_MS: '8000',
      FAD_MCP_REQUEST_TIMEOUT_MS: '8000',
      FAD_SHUTDOWN_GRACE_MS: '15000',
      FAD_RATE_LIMIT_MAX: '8000',
      FAD_DB_POOL_MAX: '8',
    });
    check('API-ON', api.ready, safe(api.logs()).slice(-180));

    const beforeRegister = await countEvents(orgA.id);
    const registered = await call(api.base, 'POST', '/v1/agents', keyAdmin.api_key, {
      name: `Agent ${stamp}`, description: 'first text', owner_principal_id: owner.id,
    }, { 'idempotency-key': `s7-reg-${stamp}` });
    const agentId = registered.json?.data?.id;
    const agentEtag = registered.headers.etag;
    const afterRegister = await countEvents(orgA.id);
    const replayRegister = await call(api.base, 'POST', '/v1/agents', keyAdmin.api_key, {
      name: `Agent ${stamp}`, description: 'first text', owner_principal_id: owner.id,
    }, { 'idempotency-key': `s7-reg-${stamp}` });
    const afterReplay = await countEvents(orgA.id);
    const firstEvent = await superuser.query(
      `SELECT sequence::int AS sequence FROM fad_outbox_events
        WHERE organization_id = $1 AND event_type = 'com.fad.agent.registered.v1'`,
      [orgA.id],
    );
    check('REST-ONE', registered.status === 201 && afterRegister === beforeRegister + 1 && replayRegister.json?.data?.id === agentId
      && afterReplay === afterRegister && firstEvent.rows[0]?.sequence === 1,
    `status=${registered.status} sequence=${firstEvent.rows[0]?.sequence}`);

    const bind = await created([
      'mcp', 'bind', '--organization-id', orgA.id, '--principal-id', adminA.id, '--issuer', issuer,
      '--subject', `sub-s7-${stamp}`, '--client-id', `fad-s7-${stamp}`, '--scopes', ADMIN,
    ]);
    const token = await new SignJWT({ client_id: `fad-s7-${stamp}`, scope: ADMIN.replaceAll(',', ' ') })
      .setProtectedHeader({ alg: 'RS256', kid: 's7-kid', typ: 'at+jwt' })
      .setSubject(`sub-s7-${stamp}`)
      .setIssuer(issuer)
      .setAudience(resource)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(privateKey);
    remember(token);
    mcpClient = new Client({ name: 'fad-slice7', version: '1.0.0' }, { versionNegotiation: { pin: '2026-07-28' } });
    const transport = new StreamableHTTPClientTransport(new URL(`${api.base}/mcp`), { authProvider: { token: async () => token } });
    await mcpClient.connect(transport, { timeout: 8000 });
    const listedTools = await mcpClient.listTools();
    const toolNames = (listedTools.tools ?? []).map((item) => item.name);
    let shapeMismatch = '';
    for (const item of listedTools.tools ?? []) {
      const props = item.inputSchema?.properties ?? {};
      const keys = Object.keys(props).sort().join(',');
      const want = (MCP_INPUT_KEYS[item.name] ?? []).join(',');
      const identity = Object.keys(props).some((key) => key === 'organization_id' || key === 'tenant_id');
      if (item.inputSchema?.type !== 'object' || item.inputSchema?.additionalProperties !== false || keys !== want || identity) {
        shapeMismatch = `${item.name} keys=${keys} want=${want} additional=${String(item.inputSchema?.additionalProperties)}`;
        break;
      }
    }
    const catalogOk = toolNames.join(',') === DEPLOYED_MCP_TOOLS.join(',')
      && UNPUBLISHED_MCP_TOOLS.every((name) => toolNames.includes(name) === false)
      && shapeMismatch === '';
    check('MCP-CATALOG', catalogOk, shapeMismatch || `count=${toolNames.length}`);
    note(sdkNotes, 'MCP-CATALOG', `count=${toolNames.length} unpublished=12 shape=${shapeMismatch || 'match'}`);
    const updated = await tool(mcpClient, 'fad_update_agent', {
      agent_id: agentId,
      patch: { description: 'mcp description' },
      if_match: agentEtag,
      idempotency_key: `s7-mcp-${stamp}`,
    });
    const override = await tool(mcpClient, 'fad_update_agent', {
      agent_id: agentId,
      patch: { description: 'override' },
      if_match: updated.body?.etag,
      idempotency_key: `s7-override-${stamp}`,
      organization_id: orgB.id,
    });
    const afterMcp = await countEvents(orgA.id);
    const listed = await call(api.base, 'GET', '/v1/events?limit=100', keyAdmin.api_key);
    const types = (listed.json?.data ?? []).map((item) => item.type);
    const sequences = (listed.json?.data ?? []).map((item) => item.fadsequence);
    check('MCP-ONE', updated.error === false && afterMcp === afterRegister + 1
      && types.filter((item) => item === 'com.fad.agent.registered.v1').length === 1
      && types.filter((item) => item === 'com.fad.agent.updated.v1').length === 1
      && sequences[0] + 1 === sequences[1],
    `mcp=${updated.error} types=${types.join(',')}`);
    check('MCP-OVERRIDE', override.error === true && override.body?.error?.code === 'VALIDATION_ERROR',
      `${override.body?.error?.code ?? ''} ${override.body?.error?.message ?? ''}`.slice(0, 180));
    note(atomicity, 'REST-MCP', `request=${registered.json?.meta?.request_id} events=${afterMcp} bind=${bind.id ? 'yes' : 'no'}`);

    const noop = await call(api.base, 'PATCH', `/v1/agents/${agentId}`, keyAdmin.api_key, { description: 'mcp description' }, {
      'idempotency-key': `s7-noop-${stamp}`, 'if-match': updated.body?.etag,
    });
    const bad = await call(api.base, 'PATCH', `/v1/agents/${agentId}`, keyAdmin.api_key, { description: 'x', extra: true }, {
      'idempotency-key': `s7-bad-${stamp}`, 'if-match': updated.body?.etag,
    });
    const afterNoop = await countEvents(orgA.id);
    check('NOOP-NONE', noop.status === 200 && bad.status === 422 && bad.json?.error?.code === 'VALIDATION_ERROR' && afterNoop === afterMcp,
      `noop=${noop.status} bad=${bad.status} code=${bad.json?.error?.code} events=${afterNoop}`);
    note(atomicity, 'NOOP-NONE', `noop=${noop.status} bad=${bad.status} events=${afterNoop}`);

    const ordinary = await call(api.base, 'POST', '/v1/tag-definitions', keyAdmin.api_key, {
      namespace: 'department', key: 'name', value_type: 'string', governed: false, visibility: 'internal',
    }, { 'idempotency-key': `s7-tag-ord-${stamp}` });
    const governed = await call(api.base, 'POST', '/v1/tag-definitions', keyAdmin.api_key, {
      namespace: 'policy', key: 'tier', value_type: 'string', governed: true, visibility: 'restricted',
    }, { 'idempotency-key': `s7-tag-gov-${stamp}` });
    const published = await call(api.base, 'POST', '/v1/capabilities', keyAdmin.api_key, {
      id: `lab.s7.${stamp}`, version: '1.0.0', display_name: 'Slice 7', description: 'Declared contract',
      input_schema: SCHEMA, output_schema: SCHEMA,
    }, { 'idempotency-key': `s7-cap-${stamp}` });
    check('CATALOG', ordinary.status === 201 && governed.status === 201 && published.status === 201,
      `tag=${ordinary.status} gov=${governed.status} cap=${published.status}`);

    const adminPage = await call(api.base, 'GET', '/v1/events?limit=100', keyAdmin.api_key);
    const readerPage = await call(api.base, 'GET', '/v1/events?limit=100', keyReader.api_key);
    const foreignPage = await call(api.base, 'GET', '/v1/events?limit=100', keyB.api_key, undefined, { 'x-organization-id': orgA.id });
    const restrictedIds = (adminPage.json?.data ?? []).filter((item) => item.type === 'com.fad.tag.definition_created.v1' && item.data?.key === 'tier').map((item) => item.id);
    const readerText = JSON.stringify(readerPage.json);
    const hiddenId = restrictedIds[0];
    const adminEvent = (adminPage.json?.data ?? []).find((item) => item.type === 'com.fad.agent.registered.v1');
    const missingScope = await call(api.base, 'GET', `/v1/events/${adminEvent.id}`, keyEvents.api_key);
    const typedForbidden = await call(api.base, 'GET', '/v1/events?type=com.fad.agent.registered.v1&limit=10', keyEvents.api_key);
    const foreignGet = await call(api.base, 'GET', `/v1/events/${adminEvent.id}`, keyB.api_key);
    const cursorPage = await call(api.base, 'GET', '/v1/events?limit=1', keyReader.api_key);
    const badCursor = await call(api.base, 'GET', '/v1/events?cursor=not-a-cursor', keyReader.api_key);
    const changed = await call(api.base, 'GET', `/v1/events?limit=1&cursor=${encodeURIComponent(cursorPage.json?.meta?.next_cursor ?? '')}`, keyReaderOther.api_key);
    check('PRIVACY', readerPage.status === 200 && foreignPage.json?.data?.length === 0
      && hiddenId && readerText.includes(hiddenId) === false && readerText.includes('fadsequence') === false
      && adminPage.json.data.some((item) => item.fadsequence > 0)
      && missingScope.status === 403 && missingScope.json?.error?.code === 'FORBIDDEN'
      && typedForbidden.status === 403
      && foreignGet.status === 404
      && badCursor.status === 400 && badCursor.json?.error?.code === 'INVALID_CURSOR'
      && changed.status === 409 && changed.json?.error?.code === 'CURSOR_CONTEXT_CHANGED',
    `reader=${readerPage.status} foreign=${foreignGet.status} cursor=${badCursor.status}/${changed.status}`);
    note(privacy, 'TENANT', `foreign_list=${foreignPage.json?.data?.length} foreign_get=${foreignGet.status}`);
    note(privacy, 'RESTRICTED', `hidden=${hiddenId ? 'concealed' : 'missing'} fadsequence_in_reader=false`);
    note(privacy, 'CURSOR', `400=${badCursor.json?.error?.code} 409=${changed.json?.error?.code}`);
    const savedCursor = cursorPage.json?.meta?.next_cursor;
    const minPage = await call(api.base, 'GET', '/v1/events?limit=1', keyAdmin.api_key);
    const maxPage = await call(api.base, 'GET', '/v1/events?limit=100', keyAdmin.api_key);
    const defaultPage = await call(api.base, 'GET', '/v1/events', keyAdmin.api_key);
    const zeroLimit = await call(api.base, 'GET', '/v1/events?limit=0', keyAdmin.api_key);
    const highLimit = await call(api.base, 'GET', '/v1/events?limit=101', keyAdmin.api_key);
    check('LIMIT', minPage.status === 200 && minPage.json?.meta?.limit === 1 && minPage.json?.data?.length === 1
      && maxPage.status === 200 && maxPage.json?.meta?.limit === 100 && (maxPage.json?.data?.length ?? 99) <= 100
      && defaultPage.status === 200 && defaultPage.json?.meta?.limit === 25
      && zeroLimit.status === 400 && zeroLimit.json?.error?.code === 'VALIDATION_ERROR'
      && highLimit.status === 400 && highLimit.json?.error?.code === 'VALIDATION_ERROR',
    `min=${minPage.status}/${minPage.json?.meta?.limit}/${minPage.json?.data?.length} max=${maxPage.json?.meta?.limit} default=${defaultPage.json?.meta?.limit} zero=${zeroLimit.json?.error?.code} high=${highLimit.json?.error?.code}`);
    note(privacy, 'LIMIT', `min=${minPage.json?.meta?.limit} max=${maxPage.json?.meta?.limit} default=${defaultPage.json?.meta?.limit} zero=${zeroLimit.json?.error?.code} high=${highLimit.json?.error?.code}`);
    const unknownType = await call(api.base, 'GET', '/v1/events?type=com.fad.not.a.type', keyAdmin.api_key);
    check('TYPE-FILTER', unknownType.status === 400 && unknownType.json?.error?.code === 'VALIDATION_ERROR', unknownType.json?.error?.code ?? String(unknownType.status));
    note(privacy, 'TYPE-FILTER', `code=${unknownType.json?.error?.code}`);
    const orgCursor = await call(api.base, 'GET', `/v1/events?cursor=${encodeURIComponent(savedCursor)}`, keyB.api_key);
    const filterCursor = await call(api.base, 'GET', `/v1/events?type=com.fad.agent.registered.v1&cursor=${encodeURIComponent(savedCursor)}`, keyReader.api_key);
    check('CURSOR-ORG', orgCursor.status === 409 && orgCursor.json?.error?.code === 'CURSOR_CONTEXT_CHANGED' && orgCursor.json?.data === undefined,
      orgCursor.json?.error?.code ?? String(orgCursor.status));
    check('CURSOR-FILTER', filterCursor.status === 409 && filterCursor.json?.error?.code === 'CURSOR_CONTEXT_CHANGED',
      filterCursor.json?.error?.code ?? String(filterCursor.status));
    note(privacy, 'CURSOR-ORG', `code=${orgCursor.json?.error?.code}`);
    note(privacy, 'CURSOR-FILTER', `code=${filterCursor.json?.error?.code}`);

    const liveUrl = `https://hooks.test:${hookPort}/live`;
    const createdSub = await call(api.base, 'POST', '/v1/event-subscriptions', keyAdmin.api_key, {
      callback_url: liveUrl, event_types: ['com.fad.agent.updated.v1', 'com.fad.agent.registered.v1'], description: 'live',
    }, { 'idempotency-key': `s7-sub-${stamp}` });
    const secret = createdSub.json?.data?.signing_secret;
    remember(secret);
    const subId = createdSub.json?.data?.subscription?.id;
    const again = await call(api.base, 'POST', '/v1/event-subscriptions', keyAdmin.api_key, {
      callback_url: liveUrl, event_types: ['com.fad.agent.updated.v1', 'com.fad.agent.registered.v1'], description: 'live',
    }, { 'idempotency-key': `s7-sub-${stamp}` });
    remember(again.json?.data?.signing_secret);
    const listedSub = await call(api.base, 'GET', `/v1/event-subscriptions/${subId}`, keyAdmin.api_key);
    const receipt = await superuser.query(
      `SELECT response_body::text AS body FROM idempotency_records
        WHERE organization_id = $1 AND idem_key = $2`,
      [orgA.id, `s7-sub-${stamp}`],
    );
    check('SECRET-ONCE', createdSub.status === 201 && createdSub.json?.data?.subscription?.status === 'pending_verification'
      && again.status === 201 && again.json?.data?.signing_secret === secret
      && listedSub.status === 200 && JSON.stringify(listedSub.json).includes(secret) === false
      && String(receipt.rows[0]?.body ?? '').includes('[redacted]')
      && String(receipt.rows[0]?.body ?? '').includes(secret) === false,
    `create=${createdSub.status} etag=${createdSub.headers.etag}`);
    await superuser.query(
      `UPDATE fad_event_secret_receipts
          SET created_at = transaction_timestamp() - interval '2 hours',
              expires_at = transaction_timestamp() - interval '1 minute'
        WHERE organization_id = $1 AND receipt_key = $2`,
      [orgA.id, `s7-sub-${stamp}`],
    );
    const expired = await call(api.base, 'POST', '/v1/event-subscriptions', keyAdmin.api_key, {
      callback_url: liveUrl, event_types: ['com.fad.agent.updated.v1', 'com.fad.agent.registered.v1'], description: 'live',
    }, { 'idempotency-key': `s7-sub-${stamp}` });
    const subCount = await superuser.query(`SELECT count(*)::int AS n FROM fad_event_subscriptions WHERE organization_id = $1`, [orgA.id]);
    check('SECRET-EXPIRED', expired.status === 409 && expired.json?.error?.code === 'SECRET_RECEIPT_EXPIRED' && subCount.rows[0].n === 1,
      `status=${expired.status} code=${expired.json?.error?.code}`);

    const literal = await call(api.base, 'POST', '/v1/event-subscriptions', keyAdmin.api_key, {
      callback_url: 'https://127.0.0.1/hook', event_types: ['com.fad.agent.updated.v1'],
    }, { 'idempotency-key': `s7-ssrf-ip-${stamp}` });
    let rebound = false;
    try {
      let calls = 0;
      await postWebhook({
        url: `https://hooks.test:${hookPort}/rebind`,
        body: Buffer.from('{}'),
        headers: {},
        resolver: async () => {
          calls += 1;
          return calls === 1 ? ['1.1.1.1'] : ['10.9.9.9'];
        },
      });
    } catch (error) {
      rebound = error?.code === 'WEBHOOK_URL_REJECTED';
    }
    process.env.HTTP_PROXY = 'http://127.0.0.1:9';
    process.env.HTTPS_PROXY = 'http://127.0.0.1:9';
    process.env.ALL_PROXY = 'http://127.0.0.1:9';
    let proxied = false;
    let pinnedAddress = '';
    try {
      const sent = await postWebhook({
        url: `https://hooks.test:${hookPort}/proxy`,
        body: Buffer.from('{"proxy":true}'),
        headers: {},
      });
      proxied = sent.status === 200;
      pinnedAddress = sent.address;
    } catch {
      proxied = false;
    }
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.ALL_PROXY;
    mode = '302';
    let redirected = false;
    try {
      await postWebhook({ url: `https://hooks.test:${hookPort}/redirect`, body: Buffer.from('{}'), headers: {} });
    } catch (error) {
      redirected = error?.code === 'WEBHOOK_URL_REJECTED';
    }
    mode = 'ok';
    const metadata = await assertRejected('https://metadata.google.internal/computeMetadata/v1/');
    check('SSRF', literal.status === 400 && literal.json?.error?.code === 'WEBHOOK_URL_REJECTED' && rebound && proxied && redirected && metadata,
      `literal=${literal.status} rebound=${rebound} proxy=${proxied} redirect=${redirected}`);
    note(webhook, 'SSRF', `ip=${literal.json?.error?.code} rebind=${rebound} proxy=${proxied} redirect=${redirected}`);
    const ipv6Literal = await call(api.base, 'POST', '/v1/event-subscriptions', keyAdmin.api_key, {
      callback_url: 'https://[::1]/hook', event_types: ['com.fad.agent.updated.v1'],
    }, { 'idempotency-key': `s7-ssrf-v6-${stamp}` });
    const ipv6Ula = await call(api.base, 'POST', '/v1/event-subscriptions', keyAdmin.api_key, {
      callback_url: 'https://[fc00::1]/hook', event_types: ['com.fad.agent.updated.v1'],
    }, { 'idempotency-key': `s7-ssrf-ula-${stamp}` });
    let ipv6Rebind = false;
    try {
      let lookups = 0;
      await postWebhook({
        url: `https://hooks.test:${hookPort}/v6`,
        body: Buffer.from('{}'),
        headers: {},
        resolver: async () => {
          lookups += 1;
          return lookups === 1 ? ['2001:4860:4860::8888'] : ['fc00::1'];
        },
      });
    } catch (error) {
      ipv6Rebind = error?.code === 'WEBHOOK_URL_REJECTED';
    }
    let retryLookups = 0;
    const retryResolver = async () => {
      retryLookups += 1;
      return retryLookups <= 3 ? ['127.0.0.1'] : ['::1'];
    };
    const retryFirst = await postWebhook({
      url: `https://hooks.test:${hookPort}/retry-dns`,
      body: Buffer.from('{}'),
      headers: {},
      resolver: retryResolver,
    });
    let retryRebind = false;
    try {
      await postWebhook({
        url: `https://hooks.test:${hookPort}/retry-dns`,
        body: Buffer.from('{}'),
        headers: {},
        resolver: retryResolver,
      });
    } catch (error) {
      retryRebind = error?.code === 'WEBHOOK_URL_REJECTED';
    }
    const savedHosts = process.env.FAD_EVENTS_TEST_HOSTS;
    process.env.FAD_EVENTS_TEST_HOSTS = `hooks.test=127.0.0.1,wrong.test=127.0.0.1`;
    let tlsMismatch = false;
    try {
      await postWebhook({
        url: `https://wrong.test:${hookPort}/tls`,
        body: Buffer.from('{}'),
        headers: {},
      });
    } catch (error) {
      tlsMismatch = error?.code === 'WEBHOOK_URL_REJECTED';
    }
    process.env.FAD_EVENTS_TEST_HOSTS = savedHosts;
    check('SSRF-V6', ipv6Literal.status === 400 && ipv6Literal.json?.error?.code === 'WEBHOOK_URL_REJECTED'
      && ipv6Ula.status === 400 && ipv6Ula.json?.error?.code === 'WEBHOOK_URL_REJECTED'
      && ipv6Rebind && retryFirst.status === 200 && retryRebind && tlsMismatch && pinnedAddress === '127.0.0.1',
    `v6=${ipv6Literal.status} ula=${ipv6Ula.status} rebind=${ipv6Rebind} retry=${retryRebind} tls=${tlsMismatch} pin=${pinnedAddress}`);
    note(webhook, 'SSRF-V6', `literal=${ipv6Literal.json?.error?.code} ula=${ipv6Ula.json?.error?.code} ipv6_rebind=${ipv6Rebind} retry_rebind=${retryRebind} tls_mismatch=${tlsMismatch} pinned=${pinnedAddress}`);

    const silent = await call(api.base, 'POST', '/v1/event-subscriptions', keyNarrow.api_key, {
      callback_url: `https://hooks.test:${hookPort}/silent`, event_types: ['com.fad.agent.updated.v1'],
    }, { 'idempotency-key': `s7-silent-${stamp}` });
    const narrowId = silent.json?.data?.subscription?.id;
    await runEventWorkerTick();
    const verified = await call(api.base, 'GET', `/v1/event-subscriptions/${subId}`, keyAdmin.api_key);
    const stillPending = await superuser.query(`SELECT status FROM fad_event_subscriptions WHERE id = $1`, [narrowId]);
    const watermark = verified.json?.data?.start_after_sequence;
    const stream = await superuser.query(`SELECT last_sequence::int AS n FROM fad_event_streams WHERE organization_id = $1`, [orgA.id]);
    check('VERIFY', verified.json?.data?.status === 'active' && watermark === stream.rows[0].n
      && stillPending.rows[0]?.status === 'pending_verification',
    `status=${verified.json?.data?.status} watermark=${watermark}`);
    note(webhook, 'VERIFY', `active watermark=${watermark} pending_unchanged=${stillPending.rows[0]?.status}`);

    const beforeSend = posts.filter((item) => item.path.startsWith('/live') && item.challenge === false).length;
    const mutated = await call(api.base, 'PATCH', `/v1/agents/${agentId}`, keyAdmin.api_key, { description: 'webhook one' }, {
      'idempotency-key': `s7-wh-${stamp}`, 'if-match': noop.headers.etag,
    });
    await runEventWorkerTick();
    const delivered = posts.filter((item) => item.path.startsWith('/live') && item.challenge === false);
    const hook = delivered[delivered.length - 1];
    const event = hook ? JSON.parse(hook.raw.toString('utf8')) : null;
    const signed = hook ? verifyFadWebhookSignature({
      rawBody: hook.raw,
      timestamp: String(hook.headers['x-fad-timestamp'] ?? ''),
      signature: String(hook.headers['x-fad-signature'] ?? ''),
      secret,
    }) : false;
    const wireSignature = String(hook?.headers?.['x-fad-signature'] ?? '');
    const forgedSignature = wireSignature.endsWith('0') ? `${wireSignature.slice(0, -1)}1` : `${wireSignature.slice(0, -1)}0`;
    const forged = hook ? verifyFadWebhookSignature({
      rawBody: hook.raw,
      timestamp: String(hook.headers['x-fad-timestamp'] ?? ''),
      signature: forgedSignature,
      secret,
    }) : true;
    const silentBusiness = posts.filter((item) => item.path.startsWith('/silent') && item.challenge === false).length;
    check('WEBHOOK', mutated.status === 200 && delivered.length === beforeSend + 1 && event?.specversion === '1.0'
      && event?.type === 'com.fad.agent.updated.v1' && signed === true && forged === false && silentBusiness === 0
      && hook.headers['x-fad-event-id'] === event.id && hook.headers['x-fad-delivery-id'],
    `signed=${signed} forged=${forged} silent=${silentBusiness}`);
    note(webhook, 'HMAC', `event=${event?.id} delivery=${hook?.headers?.['x-fad-delivery-id']} signed=${signed}`);
    const wireStamp = String(hook.headers['x-fad-timestamp'] ?? '');
    const wireSig = String(hook.headers['x-fad-signature'] ?? '');
    const shiftedStamp = String(Number(wireStamp) + 3);
    const shifted = verifyFadWebhookSignature({ rawBody: hook.raw, timestamp: shiftedStamp, signature: wireSig, secret });
    const agedStamp = String(Math.floor(Date.now() / 1000) - 301);
    const agedSig = `v1=${createHmac('sha256', secret).update(agedStamp).update('.').update(hook.raw).digest('hex')}`;
    const aged = verifyFadWebhookSignature({ rawBody: hook.raw, timestamp: agedStamp, signature: agedSig, secret });
    const malformed = verifyFadWebhookSignature({ rawBody: hook.raw, timestamp: wireStamp, signature: 'v1=zzzz', secret });
    const bodyForged = verifyFadWebhookSignature({
      rawBody: Buffer.concat([hook.raw, Buffer.from('x')]),
      timestamp: wireStamp,
      signature: wireSig,
      secret,
    });
    check('HMAC-FORGED', forged === false && shifted === false && aged === false && malformed === false && bodyForged === false,
      `forged=${forged} shifted=${shifted} aged=${aged} malformed=${malformed} body=${bodyForged}`);
    note(webhook, 'HMAC-FORGED', `timestamp_shift=${shifted} older_than_5m=${aged} malformed=${malformed} body=${bodyForged}`);

    const paused = await call(api.base, 'PATCH', `/v1/event-subscriptions/${subId}`, keyAdmin.api_key, { status: 'paused' }, {
      'idempotency-key': `s7-pause-${stamp}`, 'if-match': verified.headers.etag,
    });
    const stale = await call(api.base, 'PATCH', `/v1/event-subscriptions/${subId}`, keyAdmin.api_key, { status: 'active' }, {
      'idempotency-key': `s7-stale-${stamp}`, 'if-match': '"subscription-v1"',
    });
    const whilePaused = posts.filter((item) => item.path.startsWith('/live') && item.challenge === false).length;
    await call(api.base, 'PATCH', `/v1/agents/${agentId}`, keyAdmin.api_key, { description: 'while paused' }, {
      'idempotency-key': `s7-paused-mut-${stamp}`, 'if-match': mutated.headers.etag,
    });
    await runEventWorkerTick();
    const afterPaused = posts.filter((item) => item.path.startsWith('/live') && item.challenge === false).length;
    const resumed = await call(api.base, 'PATCH', `/v1/event-subscriptions/${subId}`, keyAdmin.api_key, { status: 'active' }, {
      'idempotency-key': `s7-resume-${stamp}`, 'if-match': paused.headers.etag,
    });
    check('PAUSE', paused.status === 200 && paused.json?.data?.status === 'paused' && stale.status === 412
      && afterPaused === whilePaused && resumed.json?.data?.status === 'active',
    `pause=${paused.status} stale=${stale.status} posts=${afterPaused}`);
    note(webhook, 'PAUSE', `stale=${stale.json?.error?.code} paused_posts=${afterPaused - whilePaused}`);

    const subsBeforeRotate = await superuser.query(`SELECT count(*)::int AS n FROM fad_event_subscriptions WHERE organization_id = $1`, [orgA.id]);
    const rot = await subscribeAndVerify(keyAdmin.api_key, '/rot', ['com.fad.agent.updated.v1'], `s7-rot-${stamp}`);
    const missingMatch = await call(api.base, 'POST', `/v1/event-subscriptions/${rot.id}/rotate-secret`, keyAdmin.api_key, undefined, {
      'idempotency-key': `s7-rot-missing-${stamp}`,
    });
    const firstRotate = await call(api.base, 'POST', `/v1/event-subscriptions/${rot.id}/rotate-secret`, keyAdmin.api_key, undefined, {
      'idempotency-key': `s7-rot-a-${stamp}`, 'if-match': rot.etag,
    });
    remember(firstRotate.json?.data?.signing_secret);
    const secondRotate = await call(api.base, 'POST', `/v1/event-subscriptions/${rot.id}/rotate-secret`, keyAdmin.api_key, undefined, {
      'idempotency-key': `s7-rot-b-${stamp}`, 'if-match': firstRotate.headers.etag,
    });
    remember(secondRotate.json?.data?.signing_secret);
    const afterRotation = await call(api.base, 'POST', `/v1/event-subscriptions/${rot.id}/rotate-secret`, keyAdmin.api_key, undefined, {
      'idempotency-key': `s7-rot-a-${stamp}`, 'if-match': rot.etag,
    });
    await superuser.query(
      `UPDATE fad_event_secret_receipts
          SET created_at = transaction_timestamp() - interval '2 hours',
              expires_at = transaction_timestamp() - interval '1 minute'
        WHERE organization_id = $1 AND receipt_key = $2 AND operation_kind = 'rotate_secret'`,
      [orgA.id, `s7-rot-b-${stamp}`],
    );
    const secretsBeforeExpiry = await superuser.query(`SELECT count(*)::int AS n FROM fad_webhook_secrets WHERE subscription_id = $1`, [rot.id]);
    const expiredRotate = await call(api.base, 'POST', `/v1/event-subscriptions/${rot.id}/rotate-secret`, keyAdmin.api_key, undefined, {
      'idempotency-key': `s7-rot-b-${stamp}`, 'if-match': firstRotate.headers.etag,
    });
    const secretsAfterExpiry = await superuser.query(`SELECT count(*)::int AS n FROM fad_webhook_secrets WHERE subscription_id = $1`, [rot.id]);
    const subsAfterRotate = await superuser.query(`SELECT count(*)::int AS n FROM fad_event_subscriptions WHERE organization_id = $1`, [orgA.id]);
    await call(api.base, 'PATCH', `/v1/event-subscriptions/${rot.id}`, keyAdmin.api_key, { status: 'paused' }, {
      'idempotency-key': `s7-rot-pause-${stamp}`, 'if-match': secondRotate.headers.etag,
    });
    check('ROTATE', missingMatch.status === 428 && missingMatch.json?.error?.code === 'PRECONDITION_REQUIRED'
      && firstRotate.status === 200 && typeof firstRotate.json?.data?.signing_secret === 'string'
      && secondRotate.status === 200
      && afterRotation.status === 409 && afterRotation.json?.error?.code === 'SECRET_RECEIPT_EXPIRED'
      && expiredRotate.status === 409 && expiredRotate.json?.error?.code === 'SECRET_RECEIPT_EXPIRED'
      && subsAfterRotate.rows[0].n === subsBeforeRotate.rows[0].n + 1
      && secretsAfterExpiry.rows[0].n === secretsBeforeExpiry.rows[0].n,
    `missing=${missingMatch.status} first=${firstRotate.status} replay=${afterRotation.status} expired=${expiredRotate.status} subs=${subsAfterRotate.rows[0].n}`);
    note(webhook, 'ROTATE', `missing_if_match=${missingMatch.json?.error?.code} after_rotation=${afterRotation.json?.error?.code} expired=${expiredRotate.json?.error?.code} subscriptions=${subsAfterRotate.rows[0].n}`);

    const term = await subscribeAndVerify(keyAdmin.api_key, '/term', ['com.fad.agent.updated.v1'], `s7-term-${stamp}`);
    const disabled = await call(api.base, 'PATCH', `/v1/event-subscriptions/${term.id}`, keyAdmin.api_key, { status: 'disabled' }, {
      'idempotency-key': `s7-term-off-${stamp}`, 'if-match': term.etag,
    });
    const revived = await call(api.base, 'PATCH', `/v1/event-subscriptions/${term.id}`, keyAdmin.api_key, { status: 'active' }, {
      'idempotency-key': `s7-term-on-${stamp}`, 'if-match': disabled.headers.etag,
    });
    const termBefore = posts.filter((item) => item.path.startsWith('/term') && item.challenge === false).length;
    await call(api.base, 'PATCH', `/v1/agents/${agentId}`, keyAdmin.api_key, { description: 'after disable' }, {
      'idempotency-key': `s7-term-mut-${stamp}`, 'if-match': await agentTag(agentId),
    });
    await fanoutOnly(orgA.id);
    await runEventWorkerTick();
    const termAfter = posts.filter((item) => item.path.startsWith('/term') && item.challenge === false).length;
    const termRow = await superuser.query(`SELECT status FROM fad_event_subscriptions WHERE id = $1`, [term.id]);
    check('DISABLED', disabled.status === 200 && disabled.json?.data?.status === 'disabled'
      && revived.status === 409 && revived.json?.error?.code === 'CONFLICT'
      && termRow.rows[0]?.status === 'disabled' && termAfter === termBefore,
    `off=${disabled.status} revive=${revived.status} posts=${termAfter - termBefore}`);
    note(webhook, 'DISABLED', `status=${termRow.rows[0]?.status} revive=${revived.json?.error?.code} posts=${termAfter - termBefore}`);

    const retrySub = await subscribeAndVerify(keyAdmin.api_key, '/retry', ['com.fad.agent.lifecycle_changed.v1'], `s7-retry-${stamp}`);
    mode = '503';
    const suspended = await call(api.base, 'POST', `/v1/agents/${agentId}/suspend`, keyAdmin.api_key, { reason: 'retry window' }, {
      'idempotency-key': `s7-sus-${stamp}`, 'if-match': resumed.headers.etag ? await agentTag(agentId) : await agentTag(agentId),
    });
    await runEventWorkerTick();
    const retryJob = await superuser.query(
      `SELECT status, attempt_count, last_http_status, next_attempt_at > transaction_timestamp() AS waiting
         FROM fad_event_delivery_jobs WHERE subscription_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [retrySub.id],
    );
    await due(orgA.id);
    mode = '429';
    await runEventWorkerTick();
    const retry429 = await superuser.query(
      `SELECT status, last_http_status FROM fad_event_delivery_jobs WHERE subscription_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [retrySub.id],
    );
    await due(orgA.id);
    mode = '400';
    await runEventWorkerTick();
    const dead = await superuser.query(
      `SELECT status, last_http_status, attempt_count FROM fad_event_delivery_jobs WHERE subscription_id = $1`,
      [retrySub.id],
    );
    check('RETRY', suspended.status === 200 && retryJob.rows[0]?.last_http_status === 503 && retryJob.rows[0]?.waiting === true
      && retry429.rows[0]?.last_http_status === 429 && dead.rows[0]?.status === 'dead' && dead.rows[0]?.last_http_status === 400,
    `503=${retryJob.rows[0]?.last_http_status} 429=${retry429.rows[0]?.last_http_status} dead=${dead.rows[0]?.status}`);
    note(webhook, 'RETRY', '503 and 429 waits were shortened in SQL before the next attempt. 400 dead-lettered.');

    const twelve = await subscribeAndVerify(keyAdmin.api_key, '/twelve', ['com.fad.agent.lifecycle_changed.v1'], `s7-twelve-${stamp}`);
    await superuser.query(
      `UPDATE fad_event_subscriptions SET status = 'paused' WHERE organization_id = $1 AND status = 'active' AND id <> $2`,
      [orgA.id, twelve.id],
    );
    const reactivated = await call(api.base, 'POST', `/v1/agents/${agentId}/activate`, keyAdmin.api_key, { reason: 'twelfth attempt' }, {
      'idempotency-key': `s7-act12-${stamp}`, 'if-match': await agentTag(agentId),
    });
    await fanoutOnly(orgA.id);
    await superuser.query(
      `UPDATE fad_event_delivery_jobs SET attempt_count = 11, status = 'pending', next_attempt_at = transaction_timestamp()
        WHERE id = (SELECT id FROM fad_event_delivery_jobs WHERE subscription_id = $1 AND status = 'pending' LIMIT 1)`,
      [twelve.id],
    );
    if (reactivated.status !== 200) throw new Error(`activate ${reactivated.status}`);
    mode = '503';
    await runEventWorkerTick();
    const attempt12 = await superuser.query(
      `SELECT status, attempt_count FROM fad_event_delivery_jobs WHERE subscription_id = $1`, [twelve.id]);
    mode = 'ok';
    check('ATTEMPT-12', attempt12.rows[0]?.status === 'dead' && attempt12.rows[0]?.attempt_count === 12, JSON.stringify(attempt12.rows[0]));
    note(webhook, 'ATTEMPT-12', 'attempt_count was set to 11, then one 503 made the job dead');

    const agedSub = await subscribeAndVerify(keyAdmin.api_key, '/age', ['com.fad.agent.updated.v1'], `s7-age-${stamp}`);
    await superuser.query(
      `UPDATE fad_event_subscriptions SET status = 'paused' WHERE organization_id = $1 AND status = 'active' AND id <> $2`,
      [orgA.id, agedSub.id],
    );
    const agedMut = await call(api.base, 'PATCH', `/v1/agents/${agentId}`, keyAdmin.api_key, { description: 'aged delivery' }, {
      'idempotency-key': `s7-age-mut-${stamp}`, 'if-match': await agentTag(agentId),
    });
    await fanoutOnly(orgA.id);
    await superuser.query(
      `UPDATE fad_event_delivery_jobs
          SET created_at = transaction_timestamp() - interval '49 hours',
              attempt_count = 0, status = 'pending', next_attempt_at = transaction_timestamp()
        WHERE subscription_id = $1 AND status = 'pending'`,
      [agedSub.id],
    );
    mode = '503';
    await runEventWorkerTick();
    const agedJob = await superuser.query(
      `SELECT status, attempt_count FROM fad_event_delivery_jobs WHERE subscription_id = $1`,
      [agedSub.id],
    );
    mode = 'ok';
    check('AGE-48H', agedMut.status === 200 && agedJob.rows[0]?.status === 'dead' && agedJob.rows[0]?.attempt_count === 1,
      JSON.stringify(agedJob.rows[0]));
    note(webhook, 'AGE-48H', `status=${agedJob.rows[0]?.status} attempts=${agedJob.rows[0]?.attempt_count}`);

    await superuser.query(
      `UPDATE fad_event_delivery_jobs
          SET status = 'cancelled', lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
        WHERE organization_id = $1 AND status IN ('pending','leased')`,
      [orgA.id],
    );
    await superuser.query(`UPDATE fad_event_subscriptions SET status = 'active' WHERE id = $1`, [subId]);
    await superuser.query(
      `UPDATE fad_event_subscriptions SET status = 'paused' WHERE organization_id = $1 AND status = 'active' AND id <> $2`,
      [orgA.id, subId],
    );
    const lostBefore = await countEvents(orgA.id);
    const activated = await call(api.base, 'PATCH', `/v1/agents/${agentId}`, keyAdmin.api_key, { description: 'lost ack' }, {
      'idempotency-key': `s7-lost-${stamp}`, 'if-match': await agentTag(agentId),
    });
    await fanoutOnly(orgA.id);
    const firstClaim = await claimDelivery(pool, orgA.id);
    const firstPost = firstClaim ? await postSignedWebhook(firstClaim) : { status: 0 };
    const seen = new Set();
    let actions = 0;
    const accept = (raw) => {
      const body = JSON.parse(raw.toString('utf8'));
      if (seen.has(body.id)) return;
      seen.add(body.id);
      actions += 1;
    };
    const lostRaw = posts.filter((item) => item.headers['x-fad-delivery-id'] === firstClaim?.deliveryId).at(-1);
    if (lostRaw) accept(lostRaw.raw);
    await sleep(1000);
    const secondClaim = await claimDelivery(pool, orgA.id);
    const secondPost = secondClaim ? await postSignedWebhook(secondClaim) : { status: 0 };
    const lostRaw2 = posts.filter((item) => item.headers['x-fad-delivery-id'] === secondClaim?.deliveryId).at(-1);
    if (lostRaw2) accept(lostRaw2.raw);
    if (secondClaim) await acknowledgeDelivery(pool, secondClaim, { kind: 'success', httpStatus: secondPost.status, retryAfterSeconds: null, startedAt: new Date() });
    const lostAfter = await countEvents(orgA.id);
    check('LOST-2XX', activated.status === 200 && firstPost.status === 200 && secondPost.status === 200
      && firstClaim?.eventId === secondClaim?.eventId && firstClaim?.deliveryId !== secondClaim?.deliveryId
      && lostAfter === lostBefore + 1 && actions === 1 && seen.size === 1,
    `event=${firstClaim?.eventId} deliveries=${firstClaim?.deliveryId}/${secondClaim?.deliveryId}`);
    note(webhook, 'LOST-2XX', `same_event=${firstClaim?.eventId === secondClaim?.eventId} consumer_actions=${actions}`);

    mode = 'ok';
    const holdSub = await subscribeAndVerify(keyAdmin.api_key, '/hold', ['com.fad.agent.updated.v1'], `s7-hold-${stamp}`);
    await superuser.query(
      `UPDATE fad_event_subscriptions SET status = 'paused' WHERE organization_id = $1 AND status = 'active' AND id <> $2`,
      [orgA.id, holdSub.id],
    );
    mode = 'hold';
    const holdCount = await countEvents(orgA.id);
    await call(api.base, 'PATCH', `/v1/agents/${agentId}`, keyAdmin.api_key, { description: 'hold for kill' }, {
      'idempotency-key': `s7-hold-${stamp}`, 'if-match': await agentTag(agentId),
    });
    const worker = spawn(process.execPath, ['apps/api/dist/event-worker.js'], {
      cwd: repo,
      env: { ...process.env, FAD_EVENTS_ENABLED: 'true', NODE_ENV: 'development' },
    });
    const started = Date.now();
    while (Date.now() - started < 4000 && posts.some((item) => item.path.startsWith('/hold') && item.challenge === false) === false) {
      await sleep(50);
    }
    const closed = new Promise((resolve) => {
      worker.once('close', (code, signal) => resolve(signal || String(code)));
    });
    worker.kill('SIGKILL');
    releaseHold();
    const killed = await closed;
    await sleep(1000);
    mode = 'ok';
    await runEventWorkerTick();
    const holdJob = await superuser.query(
      `SELECT status FROM fad_event_delivery_jobs WHERE subscription_id = $1 AND replay_token = '00000000-0000-0000-0000-000000000000'`,
      [holdSub.id],
    );
    const holdEvents = await countEvents(orgA.id);
    check('WORKER-KILL', killed === 'SIGKILL' && holdJob.rows[0]?.status === 'succeeded' && holdEvents === holdCount + 1,
      `killed=${killed} status=${holdJob.rows[0]?.status} events=${holdEvents} delta=${holdEvents - holdCount}`);
    note(webhook, 'WORKER-KILL', `sigkill_before_response status=${holdJob.rows[0]?.status} outbox_delta=${holdEvents - holdCount}`);

    await superuser.query(
      `UPDATE fad_event_subscriptions SET status = 'paused' WHERE organization_id = $1 AND status = 'active' AND id <> $2`,
      [orgA.id, holdSub.id],
    );
    const drainBefore = posts.filter((item) => item.path.startsWith('/hold') && item.challenge === false).length;
    const drainMut = await call(api.base, 'PATCH', `/v1/agents/${agentId}`, keyAdmin.api_key, { description: 'drain worker' }, {
      'idempotency-key': `s7-drain-${stamp}`, 'if-match': await agentTag(agentId),
    });
    await fanoutOnly(orgA.id);
    const drainWorker = spawn(process.execPath, ['apps/api/dist/event-worker.js'], {
      cwd: repo,
      env: { ...process.env, FAD_EVENTS_ENABLED: 'true', NODE_ENV: 'development' },
    });
    const drainClosed = new Promise((resolve) => {
      drainWorker.once('close', (code, signal) => resolve(signal || String(code)));
    });
    const drainWait = Date.now();
    while (Date.now() - drainWait < 4000 && posts.filter((item) => item.path.startsWith('/hold') && item.challenge === false).length === drainBefore) {
      await sleep(40);
    }
    drainWorker.kill('SIGTERM');
    const drainExit = await Promise.race([drainClosed, sleep(8000).then(() => 'timeout')]);
    if (drainExit === 'timeout') drainWorker.kill('SIGKILL');
    const drainJob = await superuser.query(
      `SELECT status, lease_token IS NULL AS clear
         FROM fad_event_delivery_jobs
        WHERE subscription_id = $1 AND replay_token = '00000000-0000-0000-0000-000000000000'
        ORDER BY created_at DESC LIMIT 1`,
      [holdSub.id],
    );
    const drainSeen = posts.filter((item) => item.path.startsWith('/hold') && item.challenge === false).length > drainBefore;
    check('DRAIN', drainMut.status === 200 && drainExit === '0' && drainJob.rows[0]?.clear === true
      && (drainSeen ? drainJob.rows[0]?.status === 'succeeded' : drainJob.rows[0]?.status === 'pending'),
    `exit=${drainExit} status=${drainJob.rows[0]?.status} seen=${drainSeen}`);
    note(deploy, 'DRAIN', `sigterm_exit=${drainExit} status=${drainJob.rows[0]?.status} lease_clear=${drainJob.rows[0]?.clear}`);

    await superuser.query(`UPDATE fad_event_subscriptions SET status = 'active' WHERE id = $1`, [subId]);
    const target = await superuser.query(
      `SELECT sequence::int AS sequence, event_id FROM fad_outbox_events
        WHERE organization_id = $1 AND event_type = 'com.fad.agent.updated.v1'
        ORDER BY sequence DESC LIMIT 1`,
      [orgA.id],
    );
    const replayOutbox = await countEvents(orgA.id);
    const replay = await call(api.base, 'POST', `/v1/event-subscriptions/${subId}/replays`, keyAdmin.api_key, {
      after_sequence: target.rows[0].sequence - 1, through_sequence: target.rows[0].sequence, reason: 'bounded replay',
    }, { 'idempotency-key': `s7-replay-${stamp}` });
    const replayAgain = await call(api.base, 'POST', `/v1/event-subscriptions/${subId}/replays`, keyAdmin.api_key, {
      after_sequence: target.rows[0].sequence - 1, through_sequence: target.rows[0].sequence, reason: 'bounded replay',
    }, { 'idempotency-key': `s7-replay-${stamp}` });
    const replayId = replay.json?.data?.id;
    await runEventWorkerTick();
    const replayStatus = await call(api.base, 'GET', `/v1/event-subscriptions/${subId}/replays/${replayId}`, keyAdmin.api_key);
    const replayJob = await superuser.query(
      `SELECT j.event_id, a.id AS delivery_id FROM fad_event_delivery_jobs j
         LEFT JOIN fad_event_delivery_attempts a ON a.job_id = j.id AND a.organization_id = j.organization_id
        WHERE j.replay_token = $1`,
      [replayId],
    );
    const outboxAfterReplay = await countEvents(orgA.id);
    check('REPLAY', replay.status === 201 && replayAgain.json?.data?.id === replayId && outboxAfterReplay === replayOutbox
      && replayJob.rows[0]?.event_id === target.rows[0].event_id
      && replayJob.rows[0]?.delivery_id && replayJob.rows[0].delivery_id !== target.rows[0].event_id
      && replayStatus.json?.data?.status !== 'queued',
    `status=${replay.status} replay=${replayStatus.json?.data?.status}`);
    note(webhook, 'REPLAY', `id=${replayId} event=${target.rows[0].event_id} delivery=${replayJob.rows[0]?.delivery_id}`);

    const streamNow = await superuser.query(
      `SELECT last_sequence::int AS n FROM fad_event_streams WHERE organization_id = $1`,
      [orgA.id],
    );
    const beyond = streamNow.rows[0].n;
    const range = await call(api.base, 'POST', `/v1/event-subscriptions/${subId}/replays`, keyAdmin.api_key, {
      after_sequence: beyond, through_sequence: beyond + 1, reason: 'outside retention',
    }, { 'idempotency-key': `s7-range-${stamp}` });
    check('REPLAY-RANGE', range.status === 410 && range.json?.error?.code === 'REPLAY_RANGE_EXPIRED', range.json?.error?.code ?? String(range.status));

    const allowPolicy = await call(api.base, 'POST', '/v1/policies', keyAdmin.api_key, {
      name: `Owner update ${stamp}`,
      description: 'Allow the owner to update this agent',
      effect: 'allow',
      actions: ['agent.update'],
      subjects: { principal_ids: [owner.id] },
      resource: { type: 'agent', agent_ids: [agentId] },
    }, { 'idempotency-key': `s7-allow-${stamp}` });
    const allowOn = await call(api.base, 'POST', `/v1/policies/${allowPolicy.json?.data?.id}/activate`, keyAdmin.api_key, undefined, {
      'idempotency-key': `s7-allow-on-${stamp}`,
      'if-match': allowPolicy.headers.etag,
    });
    const config0 = await call(api.base, 'GET', '/v1/enforcement/config', keyAdmin.api_key);
    const preflight = await call(api.base, 'POST', '/v1/enforcement/preflight', keyAdmin.api_key, {
      mode: 'enforce', actions: ['agent.update'], reason: 'deny agent updates',
    });
    const enforced = await call(api.base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'enforce', actions: ['agent.update'], reason: 'deny agent updates',
      preflight_id: preflight.json?.data?.preflight_id, acknowledge_default_deny: true,
    }, { 'if-match': config0.headers.etag, 'idempotency-key': `s7-enf-${stamp}` });
    const beforeDeny = await countEvents(orgA.id);
    const denied = await call(api.base, 'PATCH', `/v1/agents/${agentId}`, keyAdmin.api_key, { description: 'denied update' }, {
      'idempotency-key': `s7-deny-${stamp}`, 'if-match': await agentTag(agentId),
    });
    const afterDeny = await countEvents(orgA.id);
    const off = await call(api.base, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'off', actions: [], reason: 'return enforcement off', acknowledge_default_deny: false,
    }, { 'if-match': enforced.headers.etag, 'idempotency-key': `s7-enf-off-${stamp}` });
    check('POLICY-DENY', allowOn.status === 200 && enforced.status === 200 && denied.status === 403 && denied.json?.error?.code === 'POLICY_DENIED' && afterDeny === beforeDeny && off.status === 200,
      `allow=${allowOn.status} enforced=${enforced.status} preflight=${preflight.status} denied=${denied.status} code=${denied.json?.error?.code} delta=${afterDeny - beforeDeny} off=${off.status}`);
    note(atomicity, 'POLICY-DENY', `code=${denied.json?.error?.code} events_unchanged=${afterDeny === beforeDeny}`);

    const acl = await subscribeAndVerify(keySub.api_key, '/acl', ['com.fad.agent.updated.v1'], `s7-acl-${stamp}`);
    const aclPosts = () => posts.filter((item) => item.path.startsWith('/acl') && item.challenge === false).length;
    const beforeAcl = aclPosts();
    await call(api.base, 'PATCH', `/v1/agents/${agentId}`, keyAdmin.api_key, { description: 'acl change' }, {
      'idempotency-key': `s7-acl-mut-${stamp}`, 'if-match': await agentTag(agentId),
    });
    await fanoutOnly(orgA.id);
    await created(['credential', 'revoke', '--organization-id', orgA.id, '--kid', keySub.kid, '--reason', 'delivery acl']);
    await runEventWorkerTick();
    const aclJob = await superuser.query(
      `SELECT status, last_error_code FROM fad_event_delivery_jobs
        WHERE subscription_id = $1 AND replay_token = '00000000-0000-0000-0000-000000000000'
        ORDER BY created_at DESC LIMIT 1`,
      [acl.id],
    );
    check('ACL', aclJob.rows[0]?.status === 'cancelled' && aclJob.rows[0]?.last_error_code === 'scope_missing' && aclPosts() === beforeAcl,
      `status=${aclJob.rows[0]?.status} code=${aclJob.rows[0]?.last_error_code}`);
    note(webhook, 'ACL', `cancelled=${aclJob.rows[0]?.last_error_code} posts=${aclPosts() - beforeAcl}`);

    const evalDecision = await call(api.base, 'POST', '/v1/authorization/evaluate', keyAdmin.api_key, {
      subject: { principal_id: adminA.id }, action: 'agent.read', resource: { type: 'agent', id: agentId },
    });
    check('NOT-ENFORCED', evalDecision.json?.data?.enforcement === 'not_enforced', evalDecision.json?.data?.enforcement ?? '');

    const startedLoad = Date.now();
    for (let index = 0; index < 20; index += 1) {
      const etag = await agentTag(agentId);
      const result = await call(api.base, 'PATCH', `/v1/agents/${agentId}`, keyAdmin.api_key, { description: `load ${index}` }, {
        'idempotency-key': `s7-load-${stamp}-${index}`, 'if-match': etag,
      });
      if (result.status !== 200) throw new Error(`load ${index} ${result.status}`);
    }
    const loadMs = Date.now() - startedLoad;
    const cpu = cpus()[0];
    note(deploy, 'LOAD', `samples=20 elapsed_ms=${loadMs} cpu=${cpu?.model ?? 'unknown'} mem_bytes=${totalmem()}`);

    const pendingJobs = await superuser.query(
      `SELECT count(*)::int AS n FROM fad_event_delivery_jobs
        WHERE organization_id = $1 AND status IN ('pending','leased')`, [orgA.id]);
    let pruneBlocked = '';
    try {
      await superuser.query(`SET ROLE fad_bootstrap`);
      await superuser.query(`SELECT fad_s7_prune_retained($1, 2)`, [orgA.id]);
      pruneBlocked = 'allowed';
    } catch (error) {
      pruneBlocked = error.code ?? 'error';
    } finally {
      await superuser.query(`RESET ROLE`).catch(() => undefined);
    }
    if (pendingJobs.rows[0].n === 0) pruneBlocked = 'no-pending-to-block';
    await superuser.query(
      `UPDATE fad_event_delivery_jobs
          SET status = 'cancelled', lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL
        WHERE organization_id = $1 AND status IN ('pending','leased')`, [orgA.id]);
    await superuser.query(
      `UPDATE fad_event_replay_requests SET status = 'completed', completed_at = transaction_timestamp()
        WHERE organization_id = $1 AND status IN ('queued','running')`, [orgA.id]);
    await superuser.query(`SET ROLE fad_bootstrap`);
    const removed = await superuser.query(`SELECT fad_s7_prune_retained($1, 2) AS n`, [orgA.id]);
    await superuser.query(`RESET ROLE`);
    const expiredCursor = await call(api.base, 'GET', `/v1/events?limit=1&cursor=${encodeURIComponent(savedCursor)}`, keyReader.api_key);
    check('CURSOR-410', expiredCursor.status === 410 && expiredCursor.json?.error?.code === 'EVENT_CURSOR_EXPIRED',
      `prune=${removed.rows[0]?.n} blocked=${pruneBlocked} status=${expiredCursor.status}`);
    note(privacy, 'CURSOR-410', `code=${expiredCursor.json?.error?.code} prune_removed=${removed.rows[0]?.n}`);

    let appGuard = '';
    await superuser.query(`UPDATE fad_event_capture_control SET required = true`);
    try {
      await app.query('BEGIN');
      await app.query(`SELECT set_config('fad.org_id', $1, true)`, [orgA.id]);
      await app.query(`UPDATE agents SET description = description WHERE organization_id = $1 AND id = $2`, [orgA.id, agentId]);
      appGuard = 'allowed';
      await app.query('ROLLBACK');
    } catch (error) {
      appGuard = error.code ?? 'error';
      await app.query('ROLLBACK').catch(() => undefined);
    }
    await superuser.query(`UPDATE fad_event_capture_control SET required = false`);
    check('OLD-WRITER', appGuard === '55000', appGuard);
    note(deploy, 'OLD-WRITER', `fad_app without fad.events_generation received ${appGuard}`);

    const packedJson = execFileSync('npm', ['pack', '-w', '@fad/sdk', '--pack-destination', scratch, '--json'], { cwd: repo, encoding: 'utf8' });
    const packed = JSON.parse(packedJson)[0].filename;
    const appDir = join(scratch, 's7-sdk-app');
    rmSync(appDir, { recursive: true, force: true });
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'package.json'), `${JSON.stringify({ name: 'fad-s7-sdk-client', private: true, type: 'module' })}\n`);
    execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--offline', join(scratch, packed)], { cwd: appDir, stdio: 'ignore' });
    writeFileSync(join(appDir, 'main.mjs'), `import { FadClient, verifyFadWebhookSignature } from '@fad/sdk';
const client = new FadClient({ baseUrl: process.env.FAD_BASE, apiKey: process.env.FAD_KEY, allowInsecureHttp: true, timeoutMs: 8000 });
const page = await client.events.list({ limit: 2 });
const event = await client.events.get(page.data[0].id);
const current = await client.organizations.current();
const decision = await client.authorization.evaluate({
  subject: { principal_id: process.env.FAD_PRINCIPAL },
  action: 'agent.read',
  resource: { type: 'agent', id: process.env.FAD_AGENT },
});
const created = await client.events.subscribe({
  callbackUrl: process.env.FAD_HOOK,
  eventTypes: ['com.fad.agent.updated.v1'],
  description: 'sdk',
}, { idempotencyKey: process.env.FAD_IDEM });
const raw = Buffer.from(process.env.FAD_RAW, 'base64');
const ok = verifyFadWebhookSignature({ rawBody: raw, timestamp: process.env.FAD_TS, signature: process.env.FAD_SIG, secret: process.env.FAD_SECRET });
const forged = verifyFadWebhookSignature({ rawBody: raw, timestamp: '1', signature: process.env.FAD_SIG, secret: process.env.FAD_SECRET });
console.log(JSON.stringify({ listed: page.data.length, got: event.data.id, org: current.data.id, enforcement: decision.data.enforcement, status: created.data.subscription.status, hmac: ok, forged, hasAgents: typeof client.agents.get === 'function' }));
`);
    const sdkOut = execFileSync(process.execPath, [join(appDir, 'main.mjs')], {
      cwd: appDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        FAD_BASE: api.base,
        FAD_KEY: keyAdmin.api_key,
        FAD_PRINCIPAL: adminA.id,
        FAD_AGENT: agentId,
        FAD_HOOK: `https://hooks.test:${hookPort}/sdk`,
        FAD_IDEM: `s7-sdk-${stamp}`,
        FAD_RAW: hook.raw.toString('base64'),
        FAD_TS: String(hook.headers['x-fad-timestamp']),
        FAD_SIG: String(hook.headers['x-fad-signature']),
        FAD_SECRET: secret,
      },
    });
    const sdkJson = JSON.parse(sdkOut);
    check('SDK', sdkJson.listed >= 1 && /^[0-9a-f-]{36}$/.test(sdkJson.got) && sdkJson.enforcement === 'not_enforced'
      && sdkJson.status === 'pending_verification' && sdkJson.hmac === true && sdkJson.forged === false && sdkJson.hasAgents === true,
    `listed=${sdkJson.listed} enforcement=${sdkJson.enforcement} hmac=${sdkJson.hmac}`);
    note(sdkNotes, 'SDK', `listed=${sdkJson.listed} got=${sdkJson.got} enforcement=${sdkJson.enforcement} hmac=${sdkJson.hmac}`);

    const outboxRows = await superuser.query(`SELECT count(*)::int AS n FROM fad_outbox_events WHERE organization_id = $1`, [orgA.id]);
    await pool.end();
    await app.end();
    await superuser.end();
    const pgContainer = postgresContainer();
    execFileSync('docker', ['restart', pgContainer], { stdio: 'ignore' });
    const readyAt = Date.now();
    let ready = false;
    while (Date.now() - readyAt < 40_000) {
      try {
        execFileSync('docker', ['exec', pgContainer, 'pg_isready', '-U', 'postgres', '-d', 'fad'], { stdio: 'ignore' });
        ready = true;
        break;
      } catch {
        await sleep(500);
      }
    }
    const afterRestart = new PgClient({ connectionString: migratorUrl, application_name: 'fad-s7-restart' });
    await afterRestart.connect();
    const survived = await afterRestart.query(`SELECT count(*)::int AS n FROM fad_outbox_events WHERE organization_id = $1`, [orgA.id]);
    const jobsSurvived = await afterRestart.query(`SELECT count(*)::int AS n FROM fad_event_delivery_jobs WHERE organization_id = $1`, [orgA.id]);
    await afterRestart.query(`DROP DATABASE IF EXISTS ${restoreName}`);
    await afterRestart.query(`CREATE DATABASE ${restoreName}`);
    execFileSync('docker', ['exec', pgContainer, 'pg_dump', '-U', 'postgres', '-d', 'fad', '-Fc', '-f', '/tmp/fad-s7.dump'], { stdio: 'ignore' });
    execFileSync('docker', ['exec', pgContainer, 'pg_restore', '-U', 'postgres', '-d', restoreName, '--no-owner', '/tmp/fad-s7.dump'], { stdio: 'ignore' });
    const restored = await afterRestart.query(`SELECT count(*)::int AS n FROM fad_outbox_events`);
    const restoredDb = new PgClient({ connectionString: new URL(`/${restoreName}`, migratorUrl).toString(), application_name: 'fad-s7-restore' });
    await restoredDb.connect();
    const restoredOrg = await restoredDb.query(`SELECT count(*)::int AS n FROM fad_outbox_events WHERE organization_id = $1`, [orgA.id]);
    await restoredDb.end();
    await afterRestart.query(`DROP DATABASE IF EXISTS ${restoreName}`);
    execFileSync('docker', ['exec', pgContainer, 'rm', '-f', '/tmp/fad-s7.dump'], { stdio: 'ignore' });
    await afterRestart.query(`UPDATE fad_event_capture_control SET required = false`);
    await afterRestart.end();
    check('RESTART', ready && survived.rows[0].n === outboxRows.rows[0].n && jobsSurvived.rows[0].n > 0 && restoredOrg.rows[0].n === outboxRows.rows[0].n,
      `ready=${ready} events=${survived.rows[0].n} restored=${restored.rows[0].n}`);
    note(deploy, 'RESTART', `events=${survived.rows[0].n} jobs=${jobsSurvived.rows[0].n} restore_org=${restoredOrg.rows[0].n}`);


  } finally {
    mkdirSync(evidenceDir, { recursive: true });
    const files = [
      ['atomicity.log', atomicity.join('\n')],
      ['privacy.log', privacy.join('\n')],
      ['webhook.log', webhook.join('\n')],
      ['sdk.log', sdkNotes.join('\n')],
      ['deploy.log', deploy.join('\n')],
    ];
    for (const [name, text] of files) {
      writeFileSync(join(scratch, name), `${safe(text)}\n`);
      writeFileSync(join(evidenceDir, name), `${safe(text)}\n`);
    }
    releaseHold();
    await stopApis();
    receiver.close();
    issuerServer.close();
    if (mcpClient) await mcpClient.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    await app.end().catch(() => undefined);
    await superuser.end().catch(() => undefined);
    await resetRequired();
    delete process.env.FAD_EVENTS_ENABLED;
    delete process.env.FAD_EVENTS_SECRET_KEY;
    delete process.env.FAD_EVENTS_TEST_EGRESS;
    delete process.env.FAD_EVENTS_TEST_HOSTS;
    delete process.env.FAD_EVENTS_TEST_PORT;
    delete process.env.FAD_EVENTS_TEST_CA;
    delete process.env.FAD_EVENTS_LEASE_MS;
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.ALL_PROXY;
    rmSync(certDir, { recursive: true, force: true });
  }

  async function countEvents(org) {
    const result = await superuser.query(`SELECT count(*)::int AS n FROM fad_outbox_events WHERE organization_id = $1`, [org]);
    return result.rows[0].n;
  }

  async function due(org) {
    await superuser.query(
      `UPDATE fad_event_delivery_jobs SET next_attempt_at = transaction_timestamp()
        WHERE organization_id = $1 AND status = 'pending'`,
      [org],
    );
  }

  async function agentTag(agent) {
    const result = await call(api.base, 'GET', `/v1/agents/${agent}`, adminKey);
    return result.headers.etag;
  }

  async function runEventWorkerTick() {
    const { runEventWorkerTick: tick } = await import('../apps/api/dist/event-worker.js');
    await tick(pool);
  }

  async function fanoutOnly(org) {
    const { fanoutOrganization } = await import('@fad/db');
    await fanoutOrganization(pool, org);
  }

  async function assertRejected(url) {
    try {
      await assertWebhookDestination(url);
      return false;
    } catch (error) {
      return error?.code === 'WEBHOOK_URL_REJECTED';
    }
  }

  async function subscribeAndVerify(key, path, types, idem) {
    const createdRow = await call(api.base, 'POST', '/v1/event-subscriptions', key, {
      callback_url: `https://hooks.test:${hookPort}${path}`, event_types: types, description: path,
    }, { 'idempotency-key': idem });
    remember(createdRow.json?.data?.signing_secret);
    if (createdRow.status !== 201) throw new Error(`subscribe ${path} ${createdRow.status} ${createdRow.json?.error?.code ?? ''}`);
    await runEventWorkerTick();
    const loaded = await call(api.base, 'GET', `/v1/event-subscriptions/${createdRow.json.data.subscription.id}`, key);
    if (loaded.json?.data?.status !== 'active') throw new Error(`verify ${path} ${loaded.json?.data?.status}`);
    return { id: createdRow.json.data.subscription.id, etag: loaded.headers.etag };
  }

  async function lockProof(org) {
    const seed = new PgClient({ connectionString: appUrl, application_name: 'fad-s7-lock-seed' });
    await seed.connect();
    await seed.query('BEGIN');
    await seed.query(`SELECT set_config('fad.org_id', $1, true)`, [org]);
    await seed.query(`SELECT set_config('fad.events_generation', '7', true)`);
    await appendDirectoryEvent(seed, {
      organizationId: org,
      eventType: 'com.fad.agent.updated.v1',
      subject: 'agent/lock-seed',
      aggregateType: 'agent',
      aggregateId: null,
      aggregateRevision: 1,
      visibility: 'standard',
      payload: { revision: 1, status: 'active' },
      requestId: null,
    });
    await seed.query('COMMIT');
    await seed.end();
    const beforeRow = await superuser.query(`SELECT COALESCE(last_sequence, 0)::int AS n FROM fad_event_streams WHERE organization_id = $1`, [org]);
    const before = beforeRow.rows[0]?.n ?? 0;
    const first = new PgClient({ connectionString: appUrl, application_name: 'fad-s7-lock-a' });
    const second = new PgClient({ connectionString: appUrl, application_name: 'fad-s7-lock-b' });
    await first.connect();
    await second.connect();
    let blocked = false;
    let fanout = 'skipped';
    let visible = -1;
    let offset = -1;
    try {
      await first.query('BEGIN');
      await first.query(`SELECT set_config('fad.org_id', $1, true)`, [org]);
      await first.query(`SELECT set_config('fad.events_generation', '7', true)`);
      await appendDirectoryEvent(first, {
        organizationId: org,
        eventType: 'com.fad.agent.updated.v1',
        subject: 'agent/lock',
        aggregateType: 'agent',
        aggregateId: null,
        aggregateRevision: 1,
        visibility: 'standard',
        payload: { revision: 1, status: 'active' },
        requestId: null,
      });
      fanout = await Promise.race([
        fanoutOnly(org).then(() => 'done'),
        sleep(3000).then(() => 'timeout'),
      ]);
      const seen = await superuser.query(
        `SELECT count(*)::int AS n FROM fad_outbox_events WHERE organization_id = $1 AND subject = 'agent/lock'`,
        [org],
      );
      const offsetRow = await superuser.query(
        `SELECT COALESCE(MAX(last_fanned_sequence), 0)::int AS n FROM fad_event_fanout_offsets WHERE organization_id = $1`,
        [org],
      );
      visible = seen.rows[0].n;
      offset = offsetRow.rows[0].n;
      await second.query('BEGIN');
      await second.query(`SELECT set_config('fad.org_id', $1, true)`, [org]);
      await second.query(`SELECT set_config('fad.events_generation', '7', true)`);
      await second.query(`SET LOCAL statement_timeout = '1500ms'`);
      try {
        await appendDirectoryEvent(second, {
          organizationId: org,
          eventType: 'com.fad.agent.updated.v1',
          subject: 'agent/lock-2',
          aggregateType: 'agent',
          aggregateId: null,
          aggregateRevision: 1,
          visibility: 'standard',
          payload: { revision: 1, status: 'active' },
          requestId: null,
        });
      } catch (error) {
        blocked = error.code === '57014';
      }
    } finally {
      await first.query('ROLLBACK').catch(() => undefined);
      await second.query('ROLLBACK').catch(() => undefined);
      await first.end().catch(() => undefined);
      await second.end().catch(() => undefined);
    }
    const after = await superuser.query(`SELECT count(*)::int AS n FROM fad_outbox_events WHERE organization_id = $1 AND subject = 'agent/lock'`, [org]);
    const live = await superuser.query(`SELECT COALESCE(MAX(last_sequence), 0)::int AS n FROM fad_event_streams WHERE organization_id = $1`, [org]);
    return { blocked, rolledBack: after.rows[0].n === 0, before, sequence: live.rows[0]?.n ?? 0, fanout, visible, offset };
  }

  async function resetRequired() {
    const client = new PgClient({ connectionString: migratorUrl, application_name: 'fad-s7-reset' });
    try {
      await client.connect();
      await client.query(`UPDATE fad_event_capture_control SET required = false WHERE required = true`);
    } catch {
      /* database may still be restarting; the test path resets before restart */
    } finally {
      await client.end().catch(() => undefined);
    }
  }
});
