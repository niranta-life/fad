import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import https from 'node:https';
import { join } from 'node:path';
import test from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import pg from 'pg';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { admin, check, freePort, parseJson, request, requiredEnv, scratch, startApi, stopApis } from './support.mjs';

const { Client: PgClient } = pg;
const appUrl = requiredEnv('DATABASE_URL');
const migratorUrl = requiredEnv('FAD_MIGRATOR_DATABASE_URL');
const stamp = Date.now().toString(36);
const ADMIN = [
  'organizations:read', 'agents:read', 'agents:write', 'agents:lifecycle',
  'tags:define', 'tags:read', 'tags:write', 'tags:governance', 'tags:restricted:read',
  'policies:read', 'policies:write', 'policies:activate', 'policies:evaluate:any',
  'policies:attributes:write', 'capabilities:read', 'capabilities:write', 'endpoints:read', 'endpoints:write',
  'enforcement:read', 'enforcement:manage', 'enforcement:audit',
].join(',');
const READ = 'agents:read';

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
  if (result.code !== 0) throw new Error(`${args.slice(0, 2).join(' ')} ${result.stderr.slice(0, 240)}`);
  return parseJson(result.stdout);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command} ${(stderr || error.message).slice(0, 400)}`));
      else resolve(stdout);
    });
  });
}

function mcpEnv(port, issuer) {
  const resource = `http://127.0.0.1:${port}/mcp`;
  return {
    FAD_TAGS_ENABLED: 'true',
    FAD_SLICE3_ENABLED: 'true',
    FAD_POLICIES_ENABLED: 'true',
    FAD_ENFORCEMENT_CODE_ENABLED: 'true',
    FAD_MCP_ENABLED: 'true',
    FAD_MCP_RESOURCE_URI: resource,
    FAD_MCP_EXPECTED_AUDIENCE: resource,
    FAD_MCP_AUTH_ISSUERS: issuer,
    FAD_HTTP_ALLOWED_HOSTS: `127.0.0.1:${port}`,
    FAD_MCP_ALLOWED_ORIGINS: `http://127.0.0.1:${port}`,
    FAD_MCP_JWKS_TLS_INSECURE: 'true',
    FAD_MCP_JWKS_COOLDOWN_MS: '0',
    FAD_MCP_JWKS_TIMEOUT_MS: '800',
    FAD_HTTP_REQUEST_TIMEOUT_MS: '8000',
    FAD_MCP_REQUEST_TIMEOUT_MS: '8000',
    FAD_SHUTDOWN_GRACE_MS: '15000',
    FAD_RATE_LIMIT_MAX: '8000',
    FAD_DB_POOL_MAX: '8',
    PORT: String(port),
  };
}

async function signToken(privateKey, kid, claims) {
  return new SignJWT({ client_id: claims.clientId, scope: claims.scope })
    .setProtectedHeader({ alg: 'RS256', kid, typ: 'at+jwt' })
    .setSubject(claims.subject)
    .setIssuer(claims.iss)
    .setAudience(claims.aud)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(privateKey);
}

function payloadOf(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  const text = result?.content?.find((item) => item.type === 'text')?.text;
  return text ? JSON.parse(text) : null;
}

async function openClient(base, token) {
  const client = new Client({ name: 'fad-slice6-official', version: '1.0.0' }, { versionNegotiation: { pin: '2026-07-28' } });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: { token: async () => token } });
  await client.connect(transport, { timeout: 8000 });
  return { client, transport };
}

async function tool(client, name, args) {
  try {
    const result = await client.callTool({ name, arguments: args });
    return { error: result.isError === true, body: payloadOf(result) };
  } catch (error) {
    return { error: true, body: { error: { code: 'THREW', message: String(error).slice(0, 240) } } };
  }
}

test('slice 6 MCP replica and separate SDK client', { timeout: 240_000 }, async () => {
  const notes = [];
  const note = (id, detail) => notes.push(`${new Date().toISOString()} ${id} ${detail}`);
  const certDir = mkdtempSync(join(scratch, 's6-issuer-'));
  const tlsKey = join(certDir, 'tls.key');
  const tlsCert = join(certDir, 'tls.crt');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-keyout', tlsKey, '-out', tlsCert, '-days', '2', '-nodes',
    '-subj', '/CN=fad-s6-issuer', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
  ], { stdio: 'ignore' });
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = 's6-kid';
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';
  const issuerServer = https.createServer({ key: readFileSync(tlsKey), cert: readFileSync(tlsCert) }, (req, res) => {
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
  const superuser = new PgClient({ connectionString: migratorUrl, application_name: 'fad-s6-clients' });
  superuser.on('error', () => undefined);
  await superuser.connect();
  const port1 = await freePort();
  const port2 = await freePort();
  const api1 = await startApi(mcpEnv(port1, issuer));
  const api2 = await startApi(mcpEnv(port2, issuer));
  try {
    check('CLIENT-API', api1.ready && api2.ready, `one=${api1.ready} two=${api2.ready}`);
    const sdk = await setupOrg(api1.base, 'sdk');
    await runSdk(api1.base, sdk);
    const mcp = await setupOrg(api1.base, 'mcp');
    await runMcp(api1.base, api2, mcp);
  } finally {
    writeFileSync(join(scratch, 'clients.log'), `${notes.join('\n')}\n`);
    await stopApis();
    issuerServer.close();
    await superuser.end().catch(() => undefined);
    rmSync(tlsKey, { force: true });
    rmSync(tlsCert, { force: true });
  }

  async function setupOrg(base, label) {
    const org = await created(['organization', 'create', '--name', `Slice6 ${label} ${stamp}`]);
    const foreign = await created(['organization', 'create', '--name', `Slice6 ${label} foreign ${stamp}`]);
    const adminP = await created(['principal', 'create', '--organization-id', org.id, '--type', 'service', '--name', `${label} admin`]);
    const a1 = await created(['principal', 'create', '--organization-id', org.id, '--type', 'service', '--name', `${label} a1`]);
    const a2 = await created(['principal', 'create', '--organization-id', org.id, '--type', 'service', '--name', `${label} a2`]);
    const foreignAdmin = await created(['principal', 'create', '--organization-id', foreign.id, '--type', 'service', '--name', `${label} foreign`]);
    const issue = (orgId, principalId, scopes) => created([
      'credential', 'issue', '--organization-id', orgId, '--principal-id', principalId, '--scopes', scopes,
    ]);
    const keyAdmin = await issue(org.id, adminP.id, ADMIN);
    const keyA1 = await issue(org.id, a1.id, READ);
    const keyA2 = await issue(org.id, a2.id, READ);
    const keyForeign = await issue(foreign.id, foreignAdmin.id, ADMIN);
    const agent = await call(base, 'POST', '/v1/agents', keyAdmin.api_key, {
      name: `${label} allowed`, owner_principal_id: a1.id,
    }, { 'idempotency-key': `s6c-agent-${label}-${stamp}` });
    const risk = await call(base, 'POST', '/v1/tag-definitions', keyAdmin.api_key, {
      namespace: 'security', key: 'risk', value_type: 'enum', enum_values: ['low', 'high'], governed: true, visibility: 'restricted',
    }, { 'idempotency-key': `s6c-risk-${label}-${stamp}` });
    const tagged = await call(base, 'PUT', `/v1/agents/${agent.json.data.id}/tags/security/risk`, keyAdmin.api_key, {
      value: 'high', reason: 'Classify the allowed agent',
    }, { 'idempotency-key': `s6c-tag-${label}-${stamp}`, 'if-none-match': '*' });
    const allowBody = {
      name: `${label} allow`, description: 'slice 6 client allow', effect: 'allow', actions: ['agent.read'],
      subjects: { principal_ids: [a1.id] },
      resource: { type: 'agent', tags_all: [{ namespace: 'security', key: 'risk', operator: 'eq', value: 'high' }] },
    };
    const allow = await call(base, 'POST', '/v1/policies', keyAdmin.api_key, allowBody, { 'idempotency-key': `s6c-allow-${label}-${stamp}` });
    const allowOn = await call(base, 'POST', `/v1/policies/${allow.json.data.id}/activate`, keyAdmin.api_key, undefined, {
      'idempotency-key': `s6c-allow-on-${label}-${stamp}`, 'if-match': allow.headers.etag,
    });
    const deny = await call(base, 'POST', '/v1/policies', keyAdmin.api_key, {
      name: `${label} deny`, description: 'slice 6 client deny', effect: 'deny', actions: ['agent.read'],
      subjects: { principal_ids: [a2.id] }, resource: { type: 'agent', agent_ids: [agent.json.data.id] },
    }, { 'idempotency-key': `s6c-deny-${label}-${stamp}` });
    const denyOn = await call(base, 'POST', `/v1/policies/${deny.json.data.id}/activate`, keyAdmin.api_key, undefined, {
      'idempotency-key': `s6c-deny-on-${label}-${stamp}`, 'if-match': deny.headers.etag,
    });
    check(`SETUP-${label}`, agent.status === 201 && risk.status === 201 && tagged.status === 201 && allowOn.status === 200 && denyOn.status === 200,
      `agent=${agent.status} risk=${risk.status} tag=${tagged.status} allow=${allowOn.status} deny=${denyOn.status}`);
    return { org, foreign, adminP, a1, a2, keyAdmin, keyA1, keyA2, keyForeign, agentId: agent.json.data.id };
  }

  async function runSdk(base, org) {
    const packedJson = await run('npm', ['pack', '-w', '@fad/sdk', '--pack-destination', scratch, '--json'], { cwd: new URL('..', import.meta.url).pathname });
    const packed = JSON.parse(packedJson)[0].filename;
    const appDir = join(scratch, 'sdk-app');
    rmSync(appDir, { recursive: true, force: true });
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'package.json'), `${JSON.stringify({ name: 'fad-s6-sdk-client', private: true, type: 'module' })}\n`);
    await run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--offline', join(scratch, packed)], { cwd: appDir });
    const script = `import { FadClient } from '@fad/sdk';
const baseUrl = process.env.FAD_BASE;
const options = { baseUrl, allowInsecureHttp: true };
const admin = new FadClient({ ...options, apiKey: process.env.FAD_KEY_ADMIN });
const a1 = new FadClient({ ...options, apiKey: process.env.FAD_KEY_A1 });
const a2 = new FadClient({ ...options, apiKey: process.env.FAD_KEY_A2 });
const stamp = process.env.FAD_STAMP;
const agentId = process.env.FAD_AGENT;
const surfaces = ['organizations', 'agents', 'policies', 'authorization', 'enforcement'].every((name) => admin[name] && typeof admin.agents.get === 'function');
const current = await admin.organizations.current();
const policies = await admin.policies.list({ limit: 10 });
const config = await admin.enforcement.getConfig();
const shadowPre = await admin.enforcement.preflight({ mode: 'shadow', actions: ['agent.read'], reason: 'sdk shadow preflight' });
const shadow = await admin.enforcement.setConfig({
  mode: 'shadow', actions: ['agent.read'], reason: 'sdk shadow preflight',
  preflight_id: shadowPre.data.preflight_id, acknowledge_default_deny: true,
}, { ifMatch: config.etag, idempotencyKey: 'sdkshadow' + stamp });
const duringShadow = await a2.agents.get(agentId);
const evaluated = await admin.authorization.evaluate({
  subject: { principal_id: process.env.FAD_A1 }, action: 'agent.read', resource: { type: 'agent', id: agentId },
});
const enforcePre = await admin.enforcement.preflight({ mode: 'enforce', actions: ['agent.read'], reason: 'sdk enforce preflight' });
const enforced = await admin.enforcement.setConfig({
  mode: 'enforce', actions: ['agent.read'], reason: 'sdk enforce preflight',
  preflight_id: enforcePre.data.preflight_id, acknowledge_default_deny: true,
}, { ifMatch: shadow.etag, idempotencyKey: 'sdkenforce' + stamp });
const allowed = await a1.agents.get(agentId);
let deniedStatus = 0;
let deniedCode = '';
try { await a2.agents.get(agentId); } catch (error) { deniedStatus = error.status; deniedCode = error.code; }
console.log(JSON.stringify({
  surfaces, org: current.data.id, policies: policies.data.length, mode0: config.data.mode, revision0: config.data.revision,
  configEtag: config.etag, shadowPass: shadowPre.data.passes, shadowMode: shadow.data.mode, shadowEtag: shadow.etag,
  shadowRead: duringShadow.data.id, enforcement: evaluated.data.enforcement, enforcePass: enforcePre.data.passes,
  blockers: enforcePre.data.blockers, enforceMode: enforced.data.mode, enforceEtag: enforced.etag,
  allowed: allowed.data.id, allowedRequestId: allowed.meta.request_id, deniedStatus, deniedCode,
}));
`;
    writeFileSync(join(appDir, 'journey.mjs'), script);
    const sdkEnv = {
      ...process.env,
      FAD_BASE: base,
      FAD_KEY_ADMIN: org.keyAdmin.api_key,
      FAD_KEY_A1: org.keyA1.api_key,
      FAD_KEY_A2: org.keyA2.api_key,
      FAD_AGENT: org.agentId,
      FAD_A1: org.a1.id,
      FAD_STAMP: stamp,
    };
    const stdout = await run(process.execPath, ['journey.mjs'], { cwd: appDir, env: sdkEnv });
    const report = JSON.parse(stdout);
    const found = await superuser.query(
      `SELECT id::text AS id, mode, outcome, agent_id::text AS agent_id, actor_principal_id::text AS actor
       FROM fad_enforcement_decisions WHERE organization_id = $1 AND request_id = $2`,
      [org.org.id, report.allowedRequestId],
    );
    const decisionScript = `import { FadClient } from '@fad/sdk';
const options = { baseUrl: process.env.FAD_BASE, allowInsecureHttp: true };
const admin = new FadClient({ ...options, apiKey: process.env.FAD_KEY_ADMIN });
const a2 = new FadClient({ ...options, apiKey: process.env.FAD_KEY_A2 });
const loaded = await admin.enforcement.getDecision(process.env.FAD_DECISION);
const off = await admin.enforcement.setConfig({
  mode: 'off', actions: [], reason: 'sdk audited off', acknowledge_default_deny: false,
}, { ifMatch: process.env.FAD_ETAG, idempotencyKey: 'sdkoff' + process.env.FAD_STAMP });
const legacy = await a2.agents.get(process.env.FAD_AGENT);
console.log(JSON.stringify({
  id: loaded.data.id, mode: loaded.data.mode, outcome: loaded.data.outcome,
  agentId: loaded.data.agent_id, actor: loaded.data.actor_principal_id, action: loaded.data.action,
  etag: process.env.FAD_ETAG, off: off.data.mode, offEtag: off.etag, legacy: legacy.data.id,
}));
`;
    writeFileSync(join(appDir, 'decision.mjs'), decisionScript);
    const decisionOut = await run(process.execPath, ['decision.mjs'], {
      cwd: appDir,
      env: { ...sdkEnv, FAD_DECISION: found.rows[0]?.id ?? '', FAD_ETAG: report.enforceEtag },
    });
    const decision = JSON.parse(decisionOut);
    note('SDK', JSON.stringify({
      org: report.org === org.org.id, mode0: report.mode0, enforceMode: report.enforceMode,
      etag: decision.etag, decisionId: decision.id, decisionMode: decision.mode, outcome: decision.outcome, off: decision.off,
    }));
    check('SDK', report.surfaces === true && report.org === org.org.id && report.policies >= 2
      && report.mode0 === 'off' && report.revision0 === 0 && report.configEtag === '"enforcement-v0"'
      && report.shadowPass === true && report.shadowMode === 'shadow' && report.shadowRead === org.agentId
      && report.enforcement === 'not_enforced' && report.enforcePass === true && report.enforceMode === 'enforce'
      && /^"enforcement-v[1-9][0-9]*"$/.test(report.enforceEtag)
      && report.allowed === org.agentId && report.deniedStatus === 404 && report.deniedCode === 'AGENT_NOT_FOUND'
      && found.rowCount === 1 && decision.id === found.rows[0].id && decision.mode === 'enforce'
      && decision.outcome === 'allowed' && decision.agentId === org.agentId && decision.actor === org.a1.id
      && decision.action === 'agent.read' && decision.etag === report.enforceEtag
      && decision.off === 'off' && /^"enforcement-v[1-9][0-9]*"$/.test(decision.offEtag)
      && decision.offEtag !== report.enforceEtag && decision.legacy === org.agentId,
    `mode0=${report.mode0} shadow=${report.shadowMode} denied=${report.deniedStatus}/${report.deniedCode} decision=${decision.mode}/${decision.outcome} etag=${decision.etag} off=${decision.off} blockers=${report.blockers}`);
  }

  async function runMcp(restBase, replica, org) {
    const audience = `http://127.0.0.1:${replica.port}/mcp`;
    const clientId = `fad-mcp-${stamp}`;
    const bind = (principalId, subject, scopes) => created([
      'mcp', 'bind', '--organization-id', org.org.id, '--principal-id', principalId, '--issuer', issuer,
      '--subject', subject, '--client-id', clientId, '--scopes', scopes,
    ]);
    await bind(org.adminP.id, `s6-admin-${stamp}`, ADMIN);
    await bind(org.a1.id, `s6-a1-${stamp}`, READ);
    await bind(org.a2.id, `s6-a2-${stamp}`, READ);
    const token = (subject, scope, aud = audience) => signToken(privateKey, 's6-kid', {
      iss: issuer, aud, subject, clientId, scope: scope.replaceAll(',', ' '),
    });
    const adminToken = await token(`s6-admin-${stamp}`, ADMIN);
    const a1Token = await token(`s6-a1-${stamp}`, READ);
    const a2Token = await token(`s6-a2-${stamp}`, READ);
    const wrongAudience = await token(`s6-admin-${stamp}`, ADMIN, `http://127.0.0.1:${port1}/mcp`);
    const adminClient = await openClient(replica.base, adminToken);
    const listed = await adminClient.client.listTools();
    const names = listed.tools.map((item) => item.name);
    const added = ['fad_get_enforcement_config', 'fad_preflight_enforcement', 'fad_set_enforcement_config', 'fad_get_enforcement_decision'];
    check('MCP-LIST', names.length === 25 && added.every((name) => names.includes(name)) && names.at(-4) === added[0],
      `count=${names.length} tail=${names.slice(-4).join(',')}`);
    const reader = await openClient(replica.base, a1Token);
    const readerNames = (await reader.client.listTools()).tools.map((item) => item.name);
    check('MCP-SCOPE', readerNames.includes('fad_get_agent') && added.every((name) => !readerNames.includes(name)),
      `reader=${readerNames.join(',')}`);
    const config = await tool(adminClient.client, 'fad_get_enforcement_config', {});
    check('MCP-OFF', config.error === false && config.body.data.mode === 'off' && config.body.data.organization_id === org.org.id
      && config.body.etag === '"enforcement-v0"', `mode=${config.body?.data?.mode}`);
    const shadowPre = await tool(adminClient.client, 'fad_preflight_enforcement', {
      mode: 'shadow', actions: ['agent.read'], reason: 'mcp shadow preflight',
    });
    const shadow = await tool(adminClient.client, 'fad_set_enforcement_config', {
      mode: 'shadow', actions: ['agent.read'], reason: 'mcp shadow preflight',
      preflight_id: shadowPre.body.data.preflight_id, acknowledge_default_deny: true,
      if_match: config.body.etag, idempotency_key: `mcps${stamp}aa`,
    });
    const a2Shadow = await openClient(replica.base, a2Token);
    const shadowRead = await tool(a2Shadow.client, 'fad_get_agent', { agent_id: org.agentId });
    const restShadow = await call(restBase, 'GET', `/v1/agents/${org.agentId}`, org.keyA2.api_key);
    const decision = await superuser.query(
      `SELECT id, outcome FROM fad_enforcement_decisions WHERE organization_id = $1 AND actor_principal_id = $2 AND mode = 'shadow' ORDER BY happened_at DESC LIMIT 1`,
      [org.org.id, org.a2.id],
    );
    const decisionRead = await tool(adminClient.client, 'fad_get_enforcement_decision', { decision_id: decision.rows[0].id });
    const foreignDecision = await call(restBase, 'GET', `/v1/enforcement/decisions/${decision.rows[0].id}`, org.keyForeign.api_key);
    check('MCP-SHADOW', shadowPre.error === false && shadowPre.body.data.passes === true && shadow.error === false
      && shadow.body.data.mode === 'shadow' && shadowRead.error === false && shadowRead.body.data.id === org.agentId
      && restShadow.status === 200 && decision.rows[0].outcome === 'would_deny' && decisionRead.error === false
      && decisionRead.body.data.id === decision.rows[0].id && foreignDecision.status === 404,
    `shadow=${shadow.body?.data?.mode} read=${shadowRead.error} outcome=${decision.rows[0]?.outcome} foreign=${foreignDecision.status}`);
    const enforcePre = await tool(adminClient.client, 'fad_preflight_enforcement', {
      mode: 'enforce', actions: ['agent.read'], reason: 'mcp enforce preflight',
    });
    const enforced = await tool(adminClient.client, 'fad_set_enforcement_config', {
      mode: 'enforce', actions: ['agent.read'], reason: 'mcp enforce preflight',
      preflight_id: enforcePre.body.data.preflight_id, acknowledge_default_deny: true,
      if_match: shadow.body.etag, idempotency_key: `mcpe${stamp}aa`,
    });
    const a1Read = await tool(reader.client, 'fad_get_agent', { agent_id: org.agentId });
    const a2Read = await tool(a2Shadow.client, 'fad_get_agent', { agent_id: org.agentId });
    const restConfig = await call(restBase, 'GET', '/v1/enforcement/config', org.keyAdmin.api_key, undefined, { 'x-organization-id': org.foreign.id });
    const restA1 = await call(restBase, 'GET', `/v1/agents/${org.agentId}`, org.keyA1.api_key);
    const restA2 = await call(restBase, 'GET', `/v1/agents/${org.agentId}`, org.keyA2.api_key);
    const foreignAgent = await call(restBase, 'GET', `/v1/agents/${org.agentId}`, org.keyForeign.api_key);
    const evaluated = await tool(adminClient.client, 'fad_evaluate_access', {
      subject: { principal_id: org.a1.id }, action: 'agent.read', resource: { type: 'agent', id: org.agentId },
    });
    check('MCP-ENFORCE', enforcePre.body.data.passes === true && enforced.body.data.mode === 'enforce' && enforced.body.data.revision > 0
      && a1Read.error === false && a1Read.body.data.id === org.agentId
      && a2Read.error === true && a2Read.body.error.code === 'NOT_FOUND' && !JSON.stringify(a2Read.body).includes(org.agentId)
      && restConfig.status === 200 && restConfig.json.data.mode === 'enforce' && restConfig.json.data.organization_id === org.org.id
      && restA1.status === 200 && restA2.status === 404 && foreignAgent.status === 404
      && evaluated.error === false && evaluated.body.data.enforcement === 'not_enforced',
    `mode=${enforced.body?.data?.mode} a1=${a1Read.error} a2=${a2Read.body?.error?.code} rest=${restConfig.json?.data?.mode} eval=${evaluated.body?.data?.enforcement ?? evaluated.body?.error?.code}`);
    const badAudience = await fetch(`${replica.base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${wrongAudience}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    check('MCP-AUD', badAudience.status === 401, `status=${badAudience.status}`);
    const off = await tool(adminClient.client, 'fad_set_enforcement_config', {
      mode: 'off', actions: [], reason: 'mcp audited off', acknowledge_default_deny: false,
      if_match: enforced.body.etag, idempotency_key: `mcpoff${stamp}`,
    });
    const legacy = await tool(a2Shadow.client, 'fad_get_agent', { agent_id: org.agentId });
    const modeRow = await superuser.query(`SELECT mode FROM fad_enforcement_configs WHERE organization_id = $1`, [org.org.id]);
    check('MCP-OFF-BACK', off.error === false && off.body.data.mode === 'off' && legacy.error === false && legacy.body.data.id === org.agentId
      && modeRow.rows[0].mode === 'off', `off=${off.body?.data?.mode} legacy=${legacy.error}`);
    note('MCP', `tools=${names.length} decision=${decision.rows[0].id} replica=${replica.port}`);
    await adminClient.transport.close();
    await reader.transport.close();
    await a2Shadow.transport.close();
  }
});
