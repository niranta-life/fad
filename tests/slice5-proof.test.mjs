import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { join } from 'node:path';
import test from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import pg from 'pg';
import { applyMigrations } from '@fad/migrator';
import { POLICY_MIGRATION_VERSION } from '@fad/db';
import { FadMcpClient, FadMcpToolError } from '@fad/mcp-client';
import { admin, check, freePort, parseJson, request, requiredEnv, scratch, startApi, stopApis } from './support.mjs';

const { Client } = pg;
const appUrl = requiredEnv('DATABASE_URL');
const migratorUrl = requiredEnv('FAD_MIGRATOR_DATABASE_URL');
const migrationsDir = new URL('../db/migrations/', import.meta.url).pathname;
const stamp = Date.now().toString(36);
const FULL = [
  'organizations:read', 'agents:read', 'agents:write', 'agents:lifecycle',
  'policies:read', 'policies:write', 'policies:activate', 'policies:evaluate:any', 'policies:explain',
].join(',');

function call(base, method, path, key, body, headers = {}) {
  const requestHeaders = { ...headers };
  if (key) requestHeaders['x-fad-api-key'] = key;
  if (body !== undefined) requestHeaders['content-type'] = requestHeaders['content-type'] ?? 'application/json';
  return request(`${base}${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function created(args) {
  const result = await admin(args);
  if (result.code !== 0) throw new Error(`${args.slice(0, 2).join(' ')} ${result.stderr.slice(0, 180)}`);
  return parseJson(result.stdout);
}

function definition(name, principalId, agentId) {
  return {
    name,
    description: 'hypothetical allow for one agent',
    effect: 'allow',
    actions: ['agent.invoke'],
    subjects: { principal_ids: [principalId] },
    resource: { type: 'agent', agent_ids: [agentId] },
  };
}

function evaluateBody(principalId, agentId) {
  return { subject: { principal_id: principalId }, action: 'agent.invoke', resource: { type: 'agent', id: agentId } };
}

async function signToken(privateKey, claims) {
  return new SignJWT({ client_id: claims.clientId, scope: claims.scope })
    .setProtectedHeader({ alg: 'RS256', kid: 's5-proof', typ: 'at+jwt' })
    .setSubject(claims.subject)
    .setIssuedAt()
    .setIssuer(claims.iss)
    .setAudience(claims.aud)
    .setExpirationTime('10m')
    .sign(privateKey);
}

test('policy launch, MCP, SDK, migration, and fail-closed proofs', { timeout: 240_000 }, async () => {
  const notes = [];
  const note = (id, detail) => {
    notes.push(`${id} ${detail}`);
    check(id, true, detail);
  };
  const superuser = new Client({ connectionString: migratorUrl, application_name: 'fad-s5-proof' });
  superuser.on('error', () => undefined);
  await superuser.connect();
  const freshName = 'fad_s5_fresh';
  const restoreName = 'fad_s5_restore';
  let issuer;
  try {
    await superuser.query(`DROP DATABASE IF EXISTS ${freshName}`);
    await superuser.query(`CREATE DATABASE ${freshName}`);
    const freshUrl = new URL(migratorUrl);
    freshUrl.pathname = `/${freshName}`;
    const freshApplied = await applyMigrations(freshUrl.toString(), migrationsDir);
    const fresh = new Client({ connectionString: freshUrl.toString(), application_name: 'fad-s5-fresh' });
    await fresh.connect();
    const freshVersions = await fresh.query('SELECT version FROM schema_migrations ORDER BY version');
    const freshForce = await fresh.query(
      `SELECT relname, relforcerowsecurity FROM pg_class
       WHERE relkind = 'r' AND relname IN ('fad_policies', 'fad_policy_revisions', 'fad_policy_decisions')
       ORDER BY 1`,
    );
    const freshBypass = await fresh.query(`SELECT rolbypassrls FROM pg_roles WHERE rolname = 'fad_app'`);
    await fresh.end();
    await superuser.query(`DROP DATABASE IF EXISTS ${freshName}`);
    const liveVersions = await superuser.query('SELECT version FROM schema_migrations ORDER BY version');
    const freshList = freshVersions.rows.map((row) => row.version);
    const liveList = liveVersions.rows.map((row) => row.version);
    check('FRESH', freshApplied.applied.includes(POLICY_MIGRATION_VERSION)
      && freshList.includes('0001_foundation') && freshList.includes(POLICY_MIGRATION_VERSION)
      && freshForce.rows.length === 3 && freshForce.rows.every((row) => row.relforcerowsecurity === true)
      && freshBypass.rows[0].rolbypassrls === false, freshList.join(','));
    check('UPGRADE', liveList.includes('0001_foundation') && liveList.includes('20261023_001_mcp_identity_bindings')
      && liveList.includes(POLICY_MIGRATION_VERSION), liveList.join(','));
    writeFileSync(join(scratch, 'migration.log'), `fresh_applied=${freshApplied.applied.join(',')}\nfresh_versions=${freshList.join(',')}\nlive_versions=${liveList.join(',')}\n`);

    const certDir = mkdtempSync(join(scratch, 's5-issuer-'));
    const tlsKey = join(certDir, 'tls.key');
    const tlsCert = join(certDir, 'tls.crt');
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-keyout', tlsKey, '-out', tlsCert, '-days', '2', '-nodes',
      '-subj', '/CN=fad-s5-issuer', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
    ], { stdio: 'ignore' });
    const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = 's5-proof';
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';
    issuer = https.createServer({ key: readFileSync(tlsKey), cert: readFileSync(tlsCert) }, (req, res) => {
      if ((req.url ?? '').split('?')[0] === '/.well-known/jwks.json') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ keys: [publicJwk] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => issuer.listen(0, '127.0.0.1', resolve));
    const issuerPort = issuer.address().port;
    const hostIssuer = `https://127.0.0.1:${issuerPort}`;

    const orgA = await created(['organization', 'create', '--name', `Proof A ${stamp}`]);
    const orgB = await created(['organization', 'create', '--name', `Proof B ${stamp}`]);
    const adminP = await created(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Proof Admin']);
    const readerP = await created(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Proof Reader']);
    const adminB = await created(['principal', 'create', '--organization-id', orgB.id, '--type', 'service', '--name', 'Proof B']);
    const keyAdmin = await created(['credential', 'issue', '--organization-id', orgA.id, '--principal-id', adminP.id, '--scopes', FULL]);
    const keyB = await created(['credential', 'issue', '--organization-id', orgB.id, '--principal-id', adminB.id, '--scopes', FULL]);
    const launches = [];
    for (const label of ['off-1', 'off-2']) {
      const started = await startApi({ FAD_POLICIES_ENABLED: 'false', FAD_TAGS_ENABLED: 'true', FAD_MCP_ENABLED: 'false' });
      const current = await call(started.base, 'GET', '/v1/organizations/current', keyAdmin.api_key);
      const hidden = await call(started.base, 'POST', '/v1/policies', keyAdmin.api_key, { name: 'hidden' }, { 'idempotency-key': `proof-off-${label}-${stamp}` });
      launches.push({ label, ready: started.ready, current: current.status, hidden: hidden.status, org: current.json?.data?.id });
      await started.stop();
    }
    check('LAUNCH-OFF', launches.every((item) => item.ready && item.current === 200 && item.org === orgA.id && item.hidden === 404)
      && launches[0].current === launches[1].current && launches[0].hidden === launches[1].hidden, JSON.stringify(launches));

    const on = [];
    let agentId = '';
    let allowId = '';
    for (const label of ['on-1', 'on-2']) {
      const started = await startApi({
        FAD_POLICIES_ENABLED: 'true', FAD_TAGS_ENABLED: 'true', FAD_SLICE3_ENABLED: 'true',
        FAD_HTTP_REQUEST_TIMEOUT_MS: '8000', FAD_SHUTDOWN_GRACE_MS: '8000', FAD_DB_POOL_MAX: '8', FAD_RATE_LIMIT_MAX: '8000',
      });
      if (label === 'on-1') {
        const agent = await call(started.base, 'POST', '/v1/agents', keyAdmin.api_key, {
          name: 'Proof Agent', owner_principal_id: adminP.id,
        }, { 'idempotency-key': `proof-agent-${stamp}` });
        agentId = agent.json.data.id;
        const draft = await call(started.base, 'POST', '/v1/policies', keyAdmin.api_key, definition('Proof allow', adminP.id, agentId), {
          'idempotency-key': `proof-allow-${stamp}`,
        });
        const activated = await call(started.base, 'POST', `/v1/policies/${draft.json.data.id}/activate`, keyAdmin.api_key, undefined, {
          'idempotency-key': `proof-allow-on-${stamp}`, 'if-match': draft.headers.etag,
        });
        allowId = activated.json.data.id;
        check('LAUNCH-SETUP', agent.status === 201 && activated.status === 200, `${agent.status} ${activated.status}`);
      }
      const decision = await call(started.base, 'POST', '/v1/authorization/evaluate', keyAdmin.api_key, evaluateBody(adminP.id, agentId));
      on.push({
        label, ready: started.ready, status: decision.status, decision: decision.json?.data?.decision,
        enforcement: decision.json?.data?.enforcement, request: decision.headers['x-request-id'],
      });
      note(`REQ-${label}`, decision.headers['x-request-id'] ?? '');
      await started.stop();
    }
    check('LAUNCH-ON', on.length === 2 && on.every((item) => item.ready && item.status === 200 && item.decision === 'allow' && item.enforcement === 'not_enforced')
      && on[0].decision === on[1].decision && on[0].enforcement === on[1].enforcement, JSON.stringify(on));
    writeFileSync(join(scratch, 'launch.log'), `${JSON.stringify({ off: launches, on }, null, 2)}\n`);

    const port = await freePort();
    const resource = `http://127.0.0.1:${port}/mcp`;
    const api = await startApi({
      PORT: String(port),
      FAD_POLICIES_ENABLED: 'true', FAD_TAGS_ENABLED: 'true', FAD_SLICE3_ENABLED: 'true', FAD_MCP_ENABLED: 'true',
      FAD_MCP_RESOURCE_URI: resource, FAD_MCP_EXPECTED_AUDIENCE: resource, FAD_MCP_AUTH_ISSUERS: hostIssuer,
      FAD_HTTP_ALLOWED_HOSTS: `127.0.0.1:${port}`, FAD_MCP_ALLOWED_ORIGINS: `http://127.0.0.1:${port}`,
      FAD_MCP_JWKS_TLS_INSECURE: 'true', FAD_MCP_JWKS_COOLDOWN_MS: '0', FAD_MCP_JWKS_TIMEOUT_MS: '800',
      FAD_HTTP_REQUEST_TIMEOUT_MS: '8000', FAD_MCP_REQUEST_TIMEOUT_MS: '8000', FAD_SHUTDOWN_GRACE_MS: '8000',
      FAD_RATE_LIMIT_MAX: '8000', FAD_DB_POOL_MAX: '8',
    });
    check('MCP-API', api.ready, api.logs().slice(-180));
    await created(['mcp', 'bind', '--organization-id', orgA.id, '--principal-id', adminP.id, '--issuer', hostIssuer, '--subject', `sub-proof-${stamp}`, '--client-id', `fad-s5-${stamp}`, '--scopes', FULL]);
    await created(['mcp', 'bind', '--organization-id', orgA.id, '--principal-id', readerP.id, '--issuer', hostIssuer, '--subject', `sub-read-${stamp}`, '--client-id', `fad-s5-read-${stamp}`, '--scopes', 'policies:read']);
    const token = await signToken(privateKey, { iss: hostIssuer, aud: resource, subject: `sub-proof-${stamp}`, clientId: `fad-s5-${stamp}`, scope: FULL.replaceAll(',', ' ') });
    const readToken = await signToken(privateKey, { iss: hostIssuer, aud: resource, subject: `sub-read-${stamp}`, clientId: `fad-s5-read-${stamp}`, scope: 'policies:read policies:write policies:activate' });
    const badToken = await signToken(privateKey, { iss: hostIssuer, aud: 'https://evil.example/mcp', subject: `sub-proof-${stamp}`, clientId: `fad-s5-${stamp}`, scope: FULL.replaceAll(',', ' ') });
    const client = new FadMcpClient({ serverUrl: `${api.base}/mcp`, tokenProvider: () => token, timeoutMs: 8000 });
    await client.connect();
    const listed = (await client.listTools()).map((tool) => tool.name);
    const mcpDraft = await client.createPolicy({ definition: definition('MCP allow', adminP.id, agentId), idempotency_key: `mcp-create-${stamp}` });
    const mcpId = mcpDraft.data.id;
    const seen = await call(api.base, 'GET', `/v1/policies/${mcpId}`, keyAdmin.api_key);
    const beforeMissing = await superuser.query('SELECT revision FROM fad_policies WHERE id = $1', [mcpId]);
    let missingMatch = 'none';
    try {
      await client.updateDraftPolicy({ policy_id: mcpId, definition: definition('MCP changed', adminP.id, agentId), idempotency_key: `mcp-missing-${stamp}` });
      missingMatch = 'wrote';
    } catch (error) {
      missingMatch = error instanceof FadMcpToolError ? error.code : error?.name ?? 'error';
    }
    let staleMatch = 'none';
    try {
      await client.updateDraftPolicy({
        policy_id: mcpId, definition: definition('MCP changed', adminP.id, agentId),
        if_match: '"policy-v99"', idempotency_key: `mcp-stale-${stamp}`,
      });
      staleMatch = 'wrote';
    } catch (error) {
      staleMatch = error instanceof FadMcpToolError ? error.code : error?.name ?? 'error';
    }
    const afterMissing = await superuser.query('SELECT revision FROM fad_policies WHERE id = $1', [mcpId]);
    const mcpOn = await client.activatePolicy({ policy_id: mcpId, if_match: mcpDraft.etag, idempotency_key: `mcp-activate-${stamp}` });
    const mcpDecision = await client.evaluateAccess(evaluateBody(adminP.id, agentId));
    let foreign = 'none';
    try {
      await client.evaluateAccess(evaluateBody(adminB.id, agentId));
      foreign = 'wrote';
    } catch (error) {
      foreign = error instanceof FadMcpToolError ? error.code : error?.name ?? 'error';
    }
    const foreignRows = await superuser.query('SELECT count(*)::int AS n FROM fad_policy_decisions WHERE subject_principal_id = $1', [adminB.id]);
    let badAudience = 'none';
    try {
      const bad = new FadMcpClient({ serverUrl: `${api.base}/mcp`, tokenProvider: () => badToken, timeoutMs: 8000 });
      await bad.connect();
      await bad.evaluateAccess(evaluateBody(adminP.id, agentId));
      badAudience = 'allowed';
      await bad.close();
    } catch (error) {
      badAudience = error?.name ?? 'error';
    }
    const ceiling = new FadMcpClient({ serverUrl: `${api.base}/mcp`, tokenProvider: () => readToken, timeoutMs: 8000 });
    await ceiling.connect();
    const ceilingNames = (await ceiling.listTools()).map((tool) => tool.name);
    const beforeCeiling = await superuser.query('SELECT count(*)::int AS n FROM fad_policies WHERE organization_id = $1', [orgA.id]);
    let ceilingWrite = 'none';
    try {
      await ceiling.createPolicy({ definition: definition('Ceiling', adminP.id, agentId), idempotency_key: `mcp-ceiling-${stamp}` });
      ceilingWrite = 'wrote';
    } catch (error) {
      ceilingWrite = error instanceof FadMcpToolError ? error.code : error?.name ?? 'error';
    }
    const afterCeiling = await superuser.query('SELECT count(*)::int AS n FROM fad_policies WHERE organization_id = $1', [orgA.id]);
    await ceiling.close();
    await client.close();
    check('MCP', listed.includes('fad_create_policy') && listed.includes('fad_evaluate_access') && listed.includes('fad_list_agents')
      && seen.status === 200 && seen.json.data.id === mcpId && seen.json.data.status === 'draft'
      && missingMatch !== 'wrote' && staleMatch === 'REVISION_CONFLICT' && Number(afterMissing.rows[0].revision) === Number(beforeMissing.rows[0].revision)
      && mcpOn.data.status === 'active' && mcpDecision.data.decision === 'allow' && mcpDecision.data.enforcement === 'not_enforced'
      && foreign === 'NOT_FOUND' && foreignRows.rows[0].n === 0
      && badAudience !== 'allowed' && !ceilingNames.includes('fad_create_policy') && ceilingNames.includes('fad_list_policies')
      && ceilingWrite !== 'wrote' && afterCeiling.rows[0].n === beforeCeiling.rows[0].n,
      `missing=${missingMatch} stale=${staleMatch} on=${mcpOn.data?.status} decision=${mcpDecision.data?.decision} foreign=${foreign} audience=${badAudience} ceiling=${ceilingWrite} rest=${seen.status}`);
    note('REQ-MCP', seen.headers['x-request-id'] ?? '');
    writeFileSync(join(scratch, 'mcp.log'), `${JSON.stringify({ listed: listed.filter((name) => name.startsWith('fad_')), mcpId, missingMatch, foreign, badAudience, ceilingWrite, enforcement: mcpDecision.data.enforcement }, null, 2)}\n`);

    const offPort = await freePort();
    const offMcp = await startApi({
      PORT: String(offPort), FAD_POLICIES_ENABLED: 'false', FAD_MCP_ENABLED: 'true',
      FAD_MCP_RESOURCE_URI: `http://127.0.0.1:${offPort}/mcp`, FAD_MCP_EXPECTED_AUDIENCE: `http://127.0.0.1:${offPort}/mcp`,
      FAD_MCP_AUTH_ISSUERS: hostIssuer, FAD_HTTP_ALLOWED_HOSTS: `127.0.0.1:${offPort}`,
      FAD_MCP_JWKS_TLS_INSECURE: 'true', FAD_MCP_JWKS_COOLDOWN_MS: '0', FAD_MCP_JWKS_TIMEOUT_MS: '800',
      FAD_HTTP_REQUEST_TIMEOUT_MS: '8000', FAD_MCP_REQUEST_TIMEOUT_MS: '8000', FAD_SHUTDOWN_GRACE_MS: '8000', FAD_RATE_LIMIT_MAX: '8000',
    });
    const offToken = await signToken(privateKey, {
      iss: hostIssuer, aud: `http://127.0.0.1:${offPort}/mcp`, subject: `sub-proof-${stamp}`, clientId: `fad-s5-${stamp}`, scope: FULL.replaceAll(',', ' '),
    });
    check('MCP-OFF-UP', offMcp.ready, offMcp.logs().slice(-240));
    const offClient = new FadMcpClient({ serverUrl: `${offMcp.base}/mcp`, tokenProvider: () => offToken, timeoutMs: 8000 });
    await offClient.connect();
    const offNames = (await offClient.listTools()).map((tool) => tool.name);
    await offClient.close();
    const offRoute = await call(offMcp.base, 'POST', '/v1/policies', keyAdmin.api_key, { name: 'still hidden' }, { 'idempotency-key': `proof-off-mcp-${stamp}` });
    check('MCP-OFF', offMcp.ready && offNames.includes('fad_list_agents') && offNames.every((name) => !name.includes('polic') && name !== 'fad_evaluate_access')
      && offRoute.status === 404, offNames.join(','));
    await offMcp.stop();

    const packDir = mkdtempSync(join(scratch, 's5-sdk-'));
    const packed = execFileSync('npm', ['pack', '--json', '--pack-destination', packDir], { cwd: join(process.cwd(), 'packages/sdk'), encoding: 'utf8' });
    const tarball = join(packDir, JSON.parse(packed)[0].filename);
    const consumer = join(packDir, 'consumer');
    mkdirSync(consumer, { recursive: true });
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({
      name: 'fad-slice5-sdk-user', private: true, type: 'module', dependencies: { '@fad/sdk': `file:${tarball}` },
    }));
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: consumer, stdio: 'pipe' });
    writeFileSync(join(consumer, 'run.mjs'), `
      import { FadClient, FadApiError } from '@fad/sdk';
      const client = new FadClient({ baseUrl: process.env.BASE, apiKey: process.env.KEY, allowInsecureHttp: true, timeoutMs: 8000 });
      const body = JSON.parse(process.env.BODY);
      const created = await client.policies.create(body, { idempotencyKey: process.env.CREATE_KEY });
      const loaded = await client.policies.get(created.data.id);
      const revised = { ...body, description: 'sdk revision' };
      const updated = await client.policies.updateDraft(created.data.id, revised, { idempotencyKey: process.env.UPDATE_KEY, ifMatch: created.etag });
      let stale = 0;
      try {
        await client.policies.updateDraft(created.data.id, { ...revised, description: 'stale' }, { idempotencyKey: process.env.STALE_KEY, ifMatch: created.etag });
      } catch (error) {
        stale = error instanceof FadApiError ? error.status : -1;
      }
      const activated = await client.policies.activate(created.data.id, { idempotencyKey: process.env.ACTIVATE_KEY, ifMatch: updated.etag });
      const decision = await client.authorization.evaluate(JSON.parse(process.env.EVALUATE));
      console.log(JSON.stringify({
        etag: created.etag, loaded: loaded.data.revision, updated: updated.data.revision, updatedEtag: updated.etag,
        stale, status: activated.data.status, decision: decision.data.decision, enforcement: decision.data.enforcement,
        invoke: Object.hasOwn(client, 'invokeAgent'),
      }));
    `);
    const sdkOut = execFileSync(process.execPath, ['run.mjs'], {
      cwd: consumer,
      encoding: 'utf8',
      env: {
        ...process.env,
        BASE: api.base,
        KEY: keyAdmin.api_key,
        BODY: JSON.stringify(definition('SDK allow', adminP.id, agentId)),
        EVALUATE: JSON.stringify(evaluateBody(adminP.id, agentId)),
        CREATE_KEY: `sdk-create-${stamp}`,
        UPDATE_KEY: `sdk-update-${stamp}`,
        STALE_KEY: `sdk-stale-${stamp}`,
        ACTIVATE_KEY: `sdk-activate-${stamp}`,
      },
    });
    const sdk = JSON.parse(sdkOut);
    writeFileSync(join(scratch, 'sdk.log'), `${sdkOut}`);
    check('SDK', sdk.etag === '"policy-v1"' && sdk.loaded === 1 && sdk.updated === 2 && sdk.stale === 412
      && sdk.status === 'active' && sdk.decision === 'allow' && sdk.enforcement === 'not_enforced' && sdk.invoke === false, sdkOut.trim());

    const raceDraft = await call(api.base, 'POST', '/v1/policies', keyAdmin.api_key, definition('Race', adminP.id, agentId), {
      'idempotency-key': `proof-race-${stamp}`,
    });
    const raced = await Promise.all([0, 1].map((index) => call(api.base, 'POST', `/v1/policies/${raceDraft.json.data.id}/activate`, keyAdmin.api_key, undefined, {
      'idempotency-key': `proof-race-on-${stamp}-${index}`, 'if-match': raceDraft.headers.etag,
    })));
    const raceStatus = raced.map((item) => item.status).sort();
    check('RACE', raceStatus[0] === 200 && (raceStatus[1] === 409 || raceStatus[1] === 412), raceStatus.join(','));

    const beforeAudit = await superuser.query('SELECT count(*)::int AS n FROM fad_policies WHERE organization_id = $1', [orgA.id]);
    await superuser.query('REVOKE INSERT ON audit_events FROM fad_app');
    let auditFail;
    try {
      auditFail = await call(api.base, 'POST', '/v1/policies', keyAdmin.api_key, definition('Audit fail', adminP.id, agentId), {
        'idempotency-key': `proof-audit-${stamp}`,
      });
    } finally {
      await superuser.query('GRANT INSERT ON audit_events TO fad_app');
    }
    const afterAudit = await superuser.query('SELECT count(*)::int AS n FROM fad_policies WHERE organization_id = $1', [orgA.id]);
    check('AUDIT-FAIL', auditFail.status === 503 && auditFail.json?.data?.decision !== 'allow' && afterAudit.rows[0].n === beforeAudit.rows[0].n,
      `status=${auditFail.status} rows=${afterAudit.rows[0].n}`);

    const saved = await superuser.query('SELECT resource_selector FROM fad_policies WHERE id = $1', [allowId]);
    const beforeCorrupt = await superuser.query('SELECT count(*)::int AS n FROM fad_policy_decisions WHERE organization_id = $1 AND agent_id = $2', [orgA.id, agentId]);
    await superuser.query('BEGIN');
    await superuser.query(`SET LOCAL session_replication_role = 'replica'`);
    await superuser.query(`UPDATE fad_policies SET resource_selector = '{"type":"agent"}'::jsonb WHERE id = $1`, [allowId]);
    await superuser.query('COMMIT');
    const corrupt = await call(api.base, 'POST', '/v1/authorization/evaluate', keyAdmin.api_key, evaluateBody(adminP.id, agentId));
    await superuser.query('BEGIN');
    await superuser.query(`SET LOCAL session_replication_role = 'replica'`);
    await superuser.query('UPDATE fad_policies SET resource_selector = $2 WHERE id = $1', [allowId, saved.rows[0].resource_selector]);
    await superuser.query('COMMIT');
    const afterCorrupt = await superuser.query('SELECT count(*)::int AS n FROM fad_policy_decisions WHERE organization_id = $1 AND agent_id = $2', [orgA.id, agentId]);
    const healed = await call(api.base, 'POST', '/v1/authorization/evaluate', keyAdmin.api_key, evaluateBody(adminP.id, agentId));
    check('CORRUPT', corrupt.status === 503 && corrupt.json?.data?.decision !== 'allow' && afterCorrupt.rows[0].n === beforeCorrupt.rows[0].n
      && healed.status === 200 && healed.json.data.decision === 'allow', `corrupt=${corrupt.status} healed=${healed.status}`);

    await superuser.query('BEGIN');
    await superuser.query(`SET LOCAL session_replication_role = 'replica'`);
    await superuser.query(
      `INSERT INTO fad_policies (
         organization_id, id, name, description, effect, actions, subjects, resource_selector,
         contains_restricted_tags, status, revision, created_by, updated_by, activated_at
       )
       SELECT $1, gen_random_uuid(), 'ceiling', '', 'allow', ARRAY['agent.invoke'],
         jsonb_build_object('principal_ids', jsonb_build_array($2::text)),
         jsonb_build_object('type', 'agent', 'agent_ids', jsonb_build_array($3::text)),
         false, 'active', 1, $2::uuid, $2::uuid, transaction_timestamp()
       FROM generate_series(1, 256)`,
      [orgA.id, adminP.id, agentId],
    );
    await superuser.query('COMMIT');
    const overflowDraft = await call(api.base, 'POST', '/v1/policies', keyAdmin.api_key, definition('One past ceiling', adminP.id, agentId), {
      'idempotency-key': `proof-ceiling-draft-${stamp}`,
    });
    const overflow = await call(api.base, 'POST', `/v1/policies/${overflowDraft.json?.data?.id}/activate`, keyAdmin.api_key, undefined, {
      'idempotency-key': `proof-ceiling-on-${stamp}`, 'if-match': overflowDraft.headers.etag,
    });
    await superuser.query(`DELETE FROM fad_policies WHERE organization_id = $1 AND name = 'ceiling'`, [orgA.id]);
    const beforeOverflowEval = await superuser.query('SELECT count(*)::int AS n FROM fad_policy_decisions WHERE agent_id = $1', [agentId]);
    await superuser.query('BEGIN');
    await superuser.query(`SET LOCAL session_replication_role = 'replica'`);
    await superuser.query(
      `INSERT INTO fad_policies (
         organization_id, id, name, description, effect, actions, subjects, resource_selector,
         contains_restricted_tags, status, revision, created_by, updated_by, activated_at
       )
       SELECT $1, gen_random_uuid(), 'overflow', '', 'deny', ARRAY['agent.invoke'],
         jsonb_build_object('principal_ids', jsonb_build_array($2::text)),
         jsonb_build_object('type', 'agent', 'agent_ids', jsonb_build_array($3::text)),
         false, 'active', 1, $2::uuid, $2::uuid, transaction_timestamp()
       FROM generate_series(1, 257)`,
      [orgA.id, adminP.id, agentId],
    );
    await superuser.query('COMMIT');
    const overflowEval = await call(api.base, 'POST', '/v1/authorization/evaluate', keyAdmin.api_key, evaluateBody(adminP.id, agentId));
    await superuser.query(`DELETE FROM fad_policies WHERE organization_id = $1 AND name = 'overflow'`, [orgA.id]);
    const afterOverflowEval = await superuser.query('SELECT count(*)::int AS n FROM fad_policy_decisions WHERE agent_id = $1', [agentId]);
    check('OVERFLOW', overflow.status === 409 && overflow.json?.error?.code === 'CONFLICT'
      && overflowEval.status === 503 && overflowEval.json?.data?.decision !== 'allow'
      && afterOverflowEval.rows[0].n === beforeOverflowEval.rows[0].n, `activate=${overflow.status} eval=${overflowEval.status}`);

    const slow = await startApi({
      FAD_POLICIES_ENABLED: 'true', FAD_DB_POOL_MAX: '1', FAD_HTTP_REQUEST_TIMEOUT_MS: '4000',
      FAD_SHUTDOWN_GRACE_MS: '8000', FAD_RATE_LIMIT_MAX: '8000',
    });
    await superuser.query('BEGIN');
    await superuser.query('LOCK TABLE fad_policies IN ACCESS EXCLUSIVE MODE');
    let locked;
    try {
      locked = await call(slow.base, 'POST', '/v1/authorization/evaluate', keyAdmin.api_key, evaluateBody(adminP.id, agentId));
    } finally {
      await superuser.query('ROLLBACK');
    }
    check('LOCK', locked.status === 503 && locked.json?.data?.decision !== 'allow', `status=${locked.status}`);
    await slow.stop();

    const sourceDecisions = await superuser.query('SELECT count(*)::int AS n FROM fad_policy_decisions');
    execFileSync('docker', ['exec', 'fad-s0-pg', 'pg_dump', '-U', 'postgres', '-d', 'fad', '-Fc', '-f', '/tmp/fad-s5.dump'], { stdio: 'pipe' });
    await superuser.query(`DROP DATABASE IF EXISTS ${restoreName}`);
    await superuser.query(`CREATE DATABASE ${restoreName}`);
    execFileSync('docker', ['exec', 'fad-s0-pg', 'pg_restore', '-U', 'postgres', '-d', restoreName, '--no-owner', '/tmp/fad-s5.dump'], { stdio: 'pipe' });
    const restored = execFileSync('docker', ['exec', 'fad-s0-pg', 'psql', '-U', 'postgres', '-d', restoreName, '-tAc', 'SELECT count(*) FROM fad_policy_decisions'], { encoding: 'utf8' }).trim();
    execFileSync('docker', ['exec', 'fad-s0-pg', 'rm', '-f', '/tmp/fad-s5.dump'], { stdio: 'ignore' });
    await superuser.query(`DROP DATABASE IF EXISTS ${restoreName}`);
    check('RESTORE', restored === String(sourceDecisions.rows[0].n) && sourceDecisions.rows[0].n > 0, `source=${sourceDecisions.rows[0].n} restored=${restored}`);

    const broken = new URL(appUrl);
    broken.port = '1';
    const dead = await startApi({ DATABASE_URL: broken.toString(), FAD_POLICIES_ENABLED: 'true' });
    check('DB-OUT', dead.ready === false && dead.logs().includes('Database is unavailable') && !dead.logs().includes('EXPLICIT_ALLOW'));
    await dead.stop();
    writeFileSync(join(scratch, 'proof.log'), `${notes.join('\n')}\n`);
    await api.stop();
  } finally {
    await superuser.query('GRANT INSERT ON audit_events TO fad_app').catch(() => undefined);
    await superuser.query('ROLLBACK').catch(() => undefined);
    await superuser.query(`DELETE FROM fad_policies WHERE name IN ('ceiling', 'overflow')`).catch(() => undefined);
    await superuser.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('${freshName}', '${restoreName}') AND pid <> pg_backend_pid()`).catch(() => undefined);
    await superuser.query(`DROP DATABASE IF EXISTS ${freshName}`).catch(() => undefined);
    await superuser.query(`DROP DATABASE IF EXISTS ${restoreName}`).catch(() => undefined);
    await stopApis();
    if (issuer) issuer.close();
    await superuser.end().catch(() => undefined);
  }
});
