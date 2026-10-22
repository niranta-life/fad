import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { admin, check as assertCheck, parseJson, request, requiredEnv, scratch } from './support.mjs';

function check(id, condition, detail = '') {
  if (detail) console.log(`${new Date().toISOString()} DETAIL ${id} ${detail}`);
  assertCheck(id, condition, detail);
}

const pepper = requiredEnv('FAD_API_KEY_PEPPER_V1');
const stamp = Date.now().toString(36);
const NAMES = ['fad-s6-api-1', 'fad-s6-api-2', 'fad-s6-flagoff', 'fad-s6-old', 'fad-s6-prod'];
const ADMIN = [
  'organizations:read', 'agents:read', 'agents:write', 'agents:lifecycle',
  'tags:define', 'tags:read', 'tags:write', 'tags:governance', 'tags:restricted:read',
  'policies:read', 'policies:write', 'policies:activate', 'policies:evaluate:any',
  'policies:attributes:write', 'enforcement:read', 'enforcement:manage', 'enforcement:audit',
].join(',');

function docker(args, env = {}) {
  return new Promise((resolve) => {
    execFile('docker', args, { env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

function networkUrl(envName, user) {
  const raw = process.env[envName];
  if (!raw) return `postgres://${user}@fad-s0-pg:5432/fad`;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return `postgres://${user}@fad-s0-pg:5432/fad`;
  }
  const name = parsed.username ? decodeURIComponent(parsed.username) : user;
  const database = parsed.pathname.replace(/^\//, '') || 'fad';
  const auth = parsed.password
    ? `${encodeURIComponent(name)}:${encodeURIComponent(decodeURIComponent(parsed.password))}`
    : encodeURIComponent(name);
  return `postgres://${auth}@fad-s0-pg:5432/${database}`;
}

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

async function waitReady(base) {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    try {
      const response = await fetch(`${base}/health/ready`);
      if (response.ok) return true;
    } catch {
      /* container still binding */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function cells(sql) {
  const result = await docker(['exec', 'fad-s0-pg', 'psql', '-U', 'postgres', '-d', 'fad', '-tAc', sql]);
  return { code: result.code, text: result.stdout.trim() };
}

test('slice 6 image replicas, old image admission, and database outage', { timeout: 300_000 }, async () => {
  const notes = [];
  const note = (id, detail) => {
    notes.push(`${new Date().toISOString()} ${id} ${detail}`);
    check(id, true, detail);
  };
  await docker(['unpause', 'fad-s0-pg']);
  await docker(['rm', '-f', ...NAMES]);
  const dbUrl = networkUrl('DATABASE_URL', 'fad_app');
  const migratorUrl = networkUrl('FAD_MIGRATOR_DATABASE_URL', 'postgres');
  const envFile = join(scratch, 'slice6-image.env');
  writeFileSync(envFile, [
    'NODE_ENV=development',
    'PORT=8080',
    'FAD_BIND_HOST=0.0.0.0',
    'FAD_DEV_LOOPBACK_PUBLISH=true',
    'FAD_INGRESS_TLS=cleartext',
    'FAD_TRUST_PROXY=false',
    'FAD_RATE_LIMIT_BACKEND=postgres',
    'FAD_RATE_LIMIT_MAX=8000',
    'FAD_RATE_LIMIT_WINDOW_SECONDS=60',
    'FAD_DB_POOL_MAX=4',
    'FAD_HTTP_REQUEST_TIMEOUT_MS=4000',
    'FAD_SHUTDOWN_GRACE_MS=5000',
    `DATABASE_URL=${dbUrl}`,
    `FAD_API_KEY_PEPPER_V1=${pepper}`,
    'FAD_TAGS_ENABLED=true',
    'FAD_POLICIES_ENABLED=true',
    'FAD_SLICE3_ENABLED=true',
    'FAD_ENFORCEMENT_CODE_ENABLED=true',
    'FAD_ENFORCEMENT_LOCK_TIMEOUT_MS=2000',
    'FAD_ENFORCEMENT_SCAN_LIMIT=5000',
  ].join('\n'), { mode: 0o600 });
  try {
    const inspected = await docker(['image', 'inspect', 'fad-api:slice6', '--format', '{{.Id}}|{{.Config.User}}|{{range .Config.Env}}{{println .}}{{end}}']);
    const envText = inspected.stdout;
    const imageId = envText.split('|')[0].trim();
    const imageUser = envText.split('|')[1]?.split('\n')[0]?.trim();
    check('DEPLOY-IMAGE', inspected.code === 0 && imageId.startsWith('sha256:') && imageUser === 'node'
      && envText.includes('FAD_ENFORCEMENT_CODE_ENABLED=false'),
    `code=${inspected.code} user=${imageUser ?? ''}`);
    note('DEPLOY-ID', imageId);
    const generation = await docker(['run', '--rm', '--entrypoint', 'grep', 'fad-api:slice6', '-n', 'pep_generation', 'packages/db/dist/policies.js']);
    check('DEPLOY-GEN', generation.code === 0 && generation.stdout.includes("fad.pep_generation"), 'evaluate transaction sets the generation');
    const lockOrder = await docker(['run', '--rm', '--entrypoint', 'grep', 'fad-api:slice6', '-F', 'Lock the row before that insert', 'packages/db/dist/agents.js']);
    check('DEPLOY-LOCK-ORDER', lockOrder.code === 0, 'image locks the agent row before the decision insert');
    const shutdown = await docker(['run', '--rm', '--entrypoint', 'grep', 'fad-api:slice6', '-F', 'pg_terminate_backend', 'apps/api/dist/main.js']);
    check('DEPLOY-SHUTDOWN', shutdown.code === 0, 'image cancels this process open backends on shutdown');
    const fencePhrase = await docker(['run', '--rm', '--entrypoint', 'grep', 'fad-api:slice6', '-F', 'A timeout is 503 in every mode', 'packages/db/dist/enforcement.js']);
    const fenceSkip = await docker(['run', '--rm', '--entrypoint', 'grep', 'fad-api:slice6', '-F', 's6_skip_pep', 'packages/db/dist/enforcement.js']);
    check('DEPLOY-FENCE', fencePhrase.code === 0 && fenceSkip.code !== 0, `phrase=${fencePhrase.code} skip=${fenceSkip.code}`);
    const user = await docker(['run', '--rm', '--entrypoint', 'id', 'fad-api:slice6', '-u']);
    check('DEPLOY-USER', user.stdout.trim() === '1000', `uid=${user.stdout.trim()}`);

    const migrate = await docker(['run', '--rm', '--network', 'fad-s0', '-e', `FAD_MIGRATOR_DATABASE_URL=${migratorUrl}`, 'fad-api:slice6', 'node', 'apps/migrator/dist/main.js', 'up']);
    const migrateJson = parseJson(migrate.stdout);
    check('DEPLOY-MIGRATE', migrate.code === 0 && migrateJson.ok === true
      && migrateJson.skipped.includes('20261021_006_policy_enforcement'),
    `code=${migrate.code} skipped=${migrateJson?.skipped?.join(',') ?? ''}`);

    const compose = await docker([
      'compose', '-f', 'deploy/docker/compose.yaml', '-f', 'deploy/docker/compose.enforcement-overlay.yaml', 'config',
    ], {
      FAD_DEV_POSTGRES_PASSWORD: 'compose-render-only',
      FAD_APP_DB_PASSWORD: 'compose-render-only',
      FAD_API_KEY_PEPPER_V1: '0123456789abcdef0123456789abcdef',
    });
    check('DEPLOY-COMPOSE', compose.code === 0
      && compose.stdout.includes('command:')
      && compose.stdout.includes('bootstrap')
      && compose.stdout.includes('read_only: true')
      && /FAD_ENFORCEMENT_CODE_ENABLED: "?false"?/.test(compose.stdout),
    `code=${compose.code}`);

    for (const [name, port] of [['fad-s6-api-1', '18110'], ['fad-s6-api-2', '18111']]) {
      const started = await docker(['run', '-d', '--name', name, '--network', 'fad-s0', '-p', `127.0.0.1:${port}:8080`, '--env-file', envFile, 'fad-api:slice6']);
      check(`DEPLOY-START-${port}`, started.code === 0, `code=${started.code}`);
    }
    const base1 = 'http://127.0.0.1:18110';
    const base2 = 'http://127.0.0.1:18111';
    check('DEPLOY-READY', (await waitReady(base1)) && (await waitReady(base2)), 'both replicas ready');

    const org = await created(['organization', 'create', '--name', `Slice 6 deploy ${stamp}`]);
    const adminP = await created(['principal', 'create', '--organization-id', org.id, '--type', 'service', '--name', 'Deploy admin']);
    const a1 = await created(['principal', 'create', '--organization-id', org.id, '--type', 'service', '--name', 'Deploy A1']);
    const a2 = await created(['principal', 'create', '--organization-id', org.id, '--type', 'service', '--name', 'Deploy A2']);
    const keyAdmin = await created(['credential', 'issue', '--organization-id', org.id, '--principal-id', adminP.id, '--scopes', ADMIN]);
    const keyA1 = await created(['credential', 'issue', '--organization-id', org.id, '--principal-id', a1.id, '--scopes', 'agents:read']);
    const keyA2 = await created(['credential', 'issue', '--organization-id', org.id, '--principal-id', a2.id, '--scopes', 'agents:read']);
    const agent = await call(base1, 'POST', '/v1/agents', keyAdmin.api_key, {
      name: 'Deploy Agent', owner_principal_id: a1.id,
    }, { 'idempotency-key': `s6d-agent-${stamp}` });
    const agentId = agent.json?.data?.id;
    check('DEPLOY-AGENT', agent.status === 201 && Boolean(agentId), `status=${agent.status}`);
    const risk = await call(base1, 'POST', '/v1/tag-definitions', keyAdmin.api_key, {
      namespace: 'security', key: 'risk', value_type: 'enum', enum_values: ['low', 'high'], governed: true, visibility: 'restricted',
    }, { 'idempotency-key': `s6d-risk-${stamp}` });
    const assigned = await call(base1, 'PUT', `/v1/agents/${agentId}/tags/security/risk`, keyAdmin.api_key, {
      value: 'high', reason: 'Classify deploy agent',
    }, { 'idempotency-key': `s6d-assign-${stamp}`, 'if-none-match': '*' });
    const allow = await call(base1, 'POST', '/v1/policies', keyAdmin.api_key, {
      name: 'Deploy allow', description: 'slice 6 deploy', effect: 'allow', actions: ['agent.read'],
      subjects: { principal_ids: [a1.id] },
      resource: { type: 'agent', tags_all: [{ namespace: 'security', key: 'risk', operator: 'eq', value: 'high' }] },
    }, { 'idempotency-key': `s6d-allow-${stamp}` });
    const allowOn = await call(base1, 'POST', `/v1/policies/${allow.json?.data?.id}/activate`, keyAdmin.api_key, undefined, {
      'idempotency-key': `s6d-allow-on-${stamp}`, 'if-match': allow.headers.etag,
    });
    const deny = await call(base1, 'POST', '/v1/policies', keyAdmin.api_key, {
      name: 'Deploy deny', description: 'slice 6 deploy', effect: 'deny', actions: ['agent.read'],
      subjects: { principal_ids: [a2.id] },
      resource: { type: 'agent', agent_ids: [agentId] },
    }, { 'idempotency-key': `s6d-deny-${stamp}` });
    const denyOn = await call(base1, 'POST', `/v1/policies/${deny.json?.data?.id}/activate`, keyAdmin.api_key, undefined, {
      'idempotency-key': `s6d-deny-on-${stamp}`, 'if-match': deny.headers.etag,
    });
    check('DEPLOY-POLICY', risk.status === 201 && assigned.status === 201 && allowOn.status === 200 && denyOn.status === 200,
      `tag=${risk.status} assign=${assigned.status} allow=${allowOn.status} deny=${denyOn.status}`);

    const off = await call(base1, 'GET', '/v1/enforcement/config', keyAdmin.api_key);
    check('DEPLOY-OFF', off.status === 200 && off.json.data.mode === 'off' && off.json.data.revision === 0, `status=${off.status}`);
    if (!isUuid(org.id) || !isUuid(agentId)) throw new Error('deploy ids are not uuids');
    const hold = await docker(['exec', '-d', 'fad-s0-pg', 'psql', '-U', 'postgres', '-d', 'fad', '-v', 'ON_ERROR_STOP=1', '-c',
      `BEGIN; SELECT pg_advisory_xact_lock(6816, fad_s6_enforcement_key('${org.id}'::uuid)); SELECT pg_sleep(25); COMMIT;`]);
    let fenceHeld = false;
    for (let attempt = 0; attempt < 25 && !fenceHeld; attempt += 1) {
      const locks = await cells(`SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND classid = 6816 AND granted`);
      fenceHeld = locks.code === 0 && locks.text !== '0';
      if (!fenceHeld) await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const lockedRead = await call(base1, 'GET', `/v1/agents/${agentId}`, keyA1.api_key);
    const lockedTag = await call(base2, 'PUT', `/v1/agents/${agentId}/tags/security/risk`, keyAdmin.api_key, {
      value: 'low', reason: 'fence timeout must not write',
    }, { 'idempotency-key': `s6d-fence-${stamp}`, 'if-match': assigned.headers.etag });
    await docker(['exec', 'fad-s0-pg', 'psql', '-U', 'postgres', '-d', 'fad', '-c',
      `SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(25)%' AND pid <> pg_backend_pid()`]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const tagAfterFence = await cells(`SELECT tag_value::text FROM agent_tag_assignments WHERE organization_id = '${org.id}' AND agent_id = '${agentId}' AND namespace = 'security' AND tag_key = 'risk' AND is_deleted = false`);
    const readAfterFence = await call(base2, 'GET', `/v1/agents/${agentId}`, keyA1.api_key);
    check('DEPLOY-FENCE-OFF', hold.code === 0 && fenceHeld && isUuid(org.id)
      && lockedRead.status === 503 && lockedRead.json?.error?.code === 'DEPENDENCY_UNAVAILABLE'
      && lockedTag.status === 503 && lockedTag.json?.error?.code === 'DEPENDENCY_UNAVAILABLE'
      && tagAfterFence.text.includes('high') && !tagAfterFence.text.includes('low')
      && readAfterFence.status === 200 && readAfterFence.json.data.id === agentId,
    `hold=${hold.code} held=${fenceHeld} read=${lockedRead.status} tag=${lockedTag.status} value=${tagAfterFence.text} again=${readAfterFence.status}`);
    const shadowPre = await call(base1, 'POST', '/v1/enforcement/preflight', keyAdmin.api_key, {
      mode: 'shadow', actions: ['agent.read'], reason: 'deploy shadow rollout',
    });
    const shadowPut = await call(base1, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'shadow', actions: ['agent.read'], reason: 'deploy shadow rollout',
      preflight_id: shadowPre.json?.data?.preflight_id, acknowledge_default_deny: false,
    }, { 'idempotency-key': `s6d-shadow-${stamp}`, 'if-match': off.headers.etag });
    const shadowRead = await call(base2, 'GET', `/v1/agents/${agentId}`, keyA2.api_key);
    const seenShadow = await call(base2, 'GET', '/v1/enforcement/config', keyAdmin.api_key);
    check('DEPLOY-SHADOW', shadowPre.status === 200 && shadowPre.json.data.passes === true
      && shadowPut.status === 200 && shadowPut.json.data.mode === 'shadow'
      && shadowRead.status === 200 && seenShadow.json.data.mode === 'shadow',
    `pre=${shadowPre.status} put=${shadowPut.status} read=${shadowRead.status} mode=${seenShadow.json?.data?.mode}`);

    const enforcePre = await call(base2, 'POST', '/v1/enforcement/preflight', keyAdmin.api_key, {
      mode: 'enforce', actions: ['agent.read'], reason: 'deploy enforce rollout',
    });
    const enforcePut = await call(base2, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'enforce', actions: ['agent.read'], reason: 'deploy enforce rollout',
      preflight_id: enforcePre.json?.data?.preflight_id, acknowledge_default_deny: true,
    }, { 'idempotency-key': `s6d-enforce-${stamp}`, 'if-match': shadowPut.headers.etag });
    const allowRead = await call(base1, 'GET', `/v1/agents/${agentId}`, keyA1.api_key);
    const denyRead = await call(base1, 'GET', `/v1/agents/${agentId}`, keyA2.api_key);
    const seenEnforce = await call(base1, 'GET', '/v1/enforcement/config', keyAdmin.api_key);
    check('DEPLOY-ENFORCE', enforcePre.status === 200 && enforcePre.json.data.passes === true
      && enforcePut.status === 200 && seenEnforce.json.data.mode === 'enforce'
      && allowRead.status === 200 && denyRead.status === 404,
    `pre=${enforcePre.status} put=${enforcePut.status} a1=${allowRead.status} a2=${denyRead.status}`);

    const phrase = `s6def${stamp}vault`;
    const futurePhrase = `s6future${stamp}cipher`;
    const leaked = (response) => response.text.includes(phrase) || response.text.includes(futurePhrase);
    const lowP = await created(['principal', 'create', '--organization-id', org.id, '--type', 'service', '--name', 'Deploy low']);
    const explainP = await created(['principal', 'create', '--organization-id', org.id, '--type', 'service', '--name', 'Deploy explain']);
    const fullP = await created(['principal', 'create', '--organization-id', org.id, '--type', 'service', '--name', 'Deploy explain full']);
    const keyLow = await created(['credential', 'issue', '--organization-id', org.id, '--principal-id', lowP.id, '--scopes', 'agents:read,tags:read,policies:read,policies:evaluate:self']);
    const keyExplain = await created(['credential', 'issue', '--organization-id', org.id, '--principal-id', explainP.id, '--scopes', 'agents:read,policies:read,policies:evaluate:any,policies:explain']);
    const keyFull = await created(['credential', 'issue', '--organization-id', org.id, '--principal-id', fullP.id, '--scopes', 'agents:read,tags:read,tags:restricted:read,policies:read,policies:evaluate:any,policies:explain']);
    const clearance = await call(base1, 'POST', '/v1/tag-definitions', keyAdmin.api_key, {
      namespace: 'security', key: 'clearance', value_type: 'enum', enum_values: ['open', 'closed'],
      governed: true, visibility: 'restricted', description: phrase,
    }, { 'idempotency-key': `s6d-clear-${stamp}` });
    const evalBody = (principalId) => ({
      subject: { principal_id: principalId }, action: 'agent.read', resource: { type: 'agent', id: agentId },
    });
    const lowEval = await call(base1, 'POST', '/v1/authorization/evaluate', keyLow.api_key, evalBody(lowP.id));
    const explainEval = await call(base2, 'POST', '/v1/authorization/evaluate', keyExplain.api_key, evalBody(explainP.id));
    const missingExplain = await call(base1, 'GET', '/v1/authorization/explain', keyLow.api_key);
    const missingPolicyExplain = await call(base2, 'GET', `/v1/policies/${allow.json.data.id}/explain`, keyLow.api_key);
    const hiddenDef = await call(base1, 'GET', '/v1/tag-definitions/security/clearance', keyLow.api_key);
    const hiddenPolicy = await call(base2, 'GET', `/v1/policies/${allow.json.data.id}`, keyLow.api_key);
    const compartment = await call(base2, 'POST', '/v1/tag-definitions', keyAdmin.api_key, {
      namespace: 'security', key: 'compartment', value_type: 'enum', enum_values: ['a', 'b'],
      governed: true, visibility: 'restricted', description: futurePhrase,
    }, { 'idempotency-key': `s6d-comp-${stamp}` });
    const fullEval = await call(base1, 'POST', '/v1/authorization/evaluate', keyFull.api_key, evalBody(a1.id));
    const lowAgain = await call(base2, 'POST', '/v1/authorization/evaluate', keyLow.api_key, evalBody(lowP.id));
    const hiddenFuture = await call(base1, 'GET', '/v1/tag-definitions/security/compartment', keyLow.api_key);
    const hiddenList = await call(base2, 'GET', '/v1/tag-definitions?namespace=security&limit=100', keyLow.api_key);
    const explainItems = fullEval.json?.data?.explanation;
    const explainKeysOk = Array.isArray(explainItems) && explainItems.length > 0 && explainItems.every((item) => {
      return Object.keys(item).sort().join(',') === 'effect,policy_id,revision';
    });
    const denyRequest = denyRead.headers['x-request-id'];
    const decisionLookup = isUuid(org.id) && isUuid(denyRequest)
      ? await cells(`SELECT id FROM fad_enforcement_decisions WHERE organization_id = '${org.id}' AND request_id = '${denyRequest}' ORDER BY happened_at DESC LIMIT 1`)
      : { code: 1, text: '' };
    const decisionId = decisionLookup.text;
    const lowDecision = await call(base2, 'GET', `/v1/enforcement/decisions/${isUuid(decisionId) ? decisionId : '00000000-0000-4000-8000-000000000000'}`, keyLow.api_key);
    const auditDecision = isUuid(decisionId)
      ? await call(base1, 'GET', `/v1/enforcement/decisions/${decisionId}`, keyAdmin.api_key)
      : { status: 0, text: '', headers: {} };
    const leakPreflight = await call(base2, 'POST', '/v1/enforcement/preflight', keyAdmin.api_key, {
      mode: 'enforce', actions: ['agent.read'], reason: 'explanation leak check',
    });
    check('P25', clearance.status === 201
      && lowEval.status === 200 && lowEval.json?.data?.enforcement === 'not_enforced' && lowEval.json.data.explanation === undefined
      && explainEval.status === 200 && explainEval.json?.data?.explanation === undefined
      && missingExplain.status === 404 && missingPolicyExplain.status === 404
      && hiddenDef.status === 404 && hiddenPolicy.status === 404
      && lowDecision.status === 403
      && !leaked(lowEval) && !leaked(explainEval) && !leaked(missingExplain) && !leaked(missingPolicyExplain)
      && !leaked(hiddenDef) && !leaked(hiddenPolicy) && !leaked(denyRead) && !leaked(lowDecision),
    `clear=${clearance.status} low=${lowEval.status} bare=${explainEval.status} routes=${missingExplain.status}/${missingPolicyExplain.status} def=${hiddenDef.status} policy=${hiddenPolicy.status} decision=${lowDecision.status} req=${lowEval.headers['x-request-id']}`);
    check('T14', compartment.status === 201
      && fullEval.status === 200 && fullEval.json?.data?.enforcement === 'not_enforced' && explainKeysOk
      && lowAgain.status === 200 && lowAgain.json?.data?.explanation === undefined
      && hiddenFuture.status === 404 && hiddenList.status === 200
      && auditDecision.status === 200 && leakPreflight.status === 200
      && !leaked(fullEval) && !leaked(lowAgain) && !leaked(hiddenFuture) && !leaked(hiddenList)
      && !leaked(auditDecision) && !leaked(leakPreflight),
    `future=${compartment.status} full=${fullEval.status} keys=${explainKeysOk} low=${lowAgain.status} def=${hiddenFuture.status} list=${hiddenList.status} audit=${auditDecision.status} req=${fullEval.headers['x-request-id']}`);

    const life = await call(base1, 'POST', '/v1/agents', keyAdmin.api_key, {
      name: 'Lifecycle Target', owner_principal_id: adminP.id,
    }, { 'idempotency-key': `s6d-life-${stamp}` });
    const parked = await call(base1, 'POST', '/v1/agents', keyAdmin.api_key, {
      name: 'Lifecycle Parked', owner_principal_id: adminP.id,
    }, { 'idempotency-key': `s6d-park-${stamp}` });
    const lifeId = life.json?.data?.id;
    const parkedId = parked.json?.data?.id;
    const lifeTag = await call(base1, 'PUT', `/v1/agents/${lifeId}/tags/security/risk`, keyAdmin.api_key, {
      value: 'high', reason: 'Classify lifecycle agent',
    }, { 'idempotency-key': `s6d-ltag-${stamp}`, 'if-none-match': '*' });
    const parkTag = await call(base1, 'PUT', `/v1/agents/${parkedId}/tags/security/risk`, keyAdmin.api_key, {
      value: 'high', reason: 'Classify parked agent',
    }, { 'idempotency-key': `s6d-ptag-${stamp}`, 'if-none-match': '*' });
    const cover = await call(base1, 'POST', '/v1/policies', keyAdmin.api_key, {
      name: 'Deploy admin cover', description: 'slice 6 deploy cover', effect: 'allow',
      actions: ['agent.read', 'agent.update'],
      subjects: { principal_ids: [adminP.id] },
      resource: { type: 'agent', tags_all: [{ namespace: 'security', key: 'risk', operator: 'eq', value: 'high' }] },
    }, { 'idempotency-key': `s6d-cover-${stamp}` });
    const coverOn = await call(base1, 'POST', `/v1/policies/${cover.json?.data?.id}/activate`, keyAdmin.api_key, undefined, {
      'idempotency-key': `s6d-cover-on-${stamp}`, 'if-match': cover.headers.etag,
    });
    const parkedGet = await call(base1, 'GET', `/v1/agents/${parkedId}`, keyAdmin.api_key);
    const parkedSuspend = await call(base1, 'POST', `/v1/agents/${parkedId}/suspend`, keyAdmin.api_key, {
      reason: 'park before update enforce',
    }, { 'idempotency-key': `s6d-psus-${stamp}`, 'if-match': parkedGet.headers.etag });
    const beforeUpdate = await call(base2, 'GET', '/v1/enforcement/config', keyAdmin.api_key);
    const updatePre = await call(base2, 'POST', '/v1/enforcement/preflight', keyAdmin.api_key, {
      mode: 'enforce', actions: ['agent.read', 'agent.update'], reason: 'cover update activate retire',
    });
    const updatePut = await call(base1, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'enforce', actions: ['agent.read', 'agent.update'], reason: 'cover update activate retire',
      preflight_id: updatePre.json?.data?.preflight_id, acknowledge_default_deny: true,
    }, { 'idempotency-key': `s6d-upd-${stamp}`, 'if-match': beforeUpdate.headers.etag });
    const lifeGet = await call(base2, 'GET', `/v1/agents/${lifeId}`, keyAdmin.api_key);
    const patched = await call(base1, 'PATCH', `/v1/agents/${lifeId}`, keyAdmin.api_key, {
      name: 'Lifecycle Patched',
    }, { 'idempotency-key': `s6d-patch-${stamp}`, 'if-match': lifeGet.headers.etag });
    const activated = await call(base2, 'POST', `/v1/agents/${lifeId}/activate`, keyAdmin.api_key, {
      reason: 'cover activate',
    }, { 'idempotency-key': `s6d-act-${stamp}`, 'if-match': patched.headers.etag });
    const retired = await call(base1, 'POST', `/v1/agents/${lifeId}/retire`, keyAdmin.api_key, {
      reason: 'cover retire',
    }, { 'idempotency-key': `s6d-ret-${stamp}`, 'if-match': activated.headers.etag });
    const parkedNow = await call(base2, 'GET', `/v1/agents/${parkedId}`, keyAdmin.api_key);
    const parkedActivate = await call(base1, 'POST', `/v1/agents/${parkedId}/activate`, keyAdmin.api_key, {
      reason: 'recover parked',
    }, { 'idempotency-key': `s6d-pact-${stamp}`, 'if-match': parkedNow.headers?.etag ?? parkedSuspend.headers.etag });
    const lifeDecisions = isUuid(org.id) && isUuid(lifeId)
      ? await cells(`SELECT operation_id || ' ' || outcome || ' ' || reason_code FROM fad_enforcement_decisions WHERE organization_id = '${org.id}' AND agent_id = '${lifeId}' AND operation_id IN ('updateAgent', 'activateAgent', 'retireAgent') ORDER BY operation_id, happened_at`)
      : { code: 1, text: '' };
    const parkedDecisions = isUuid(org.id) && isUuid(parkedId)
      ? await cells(`SELECT operation_id || ' ' || outcome || ' ' || reason_code FROM fad_enforcement_decisions WHERE organization_id = '${org.id}' AND agent_id = '${parkedId}' AND operation_id = 'activateAgent' ORDER BY happened_at DESC LIMIT 1`)
      : { code: 1, text: '' };
    check('P10', life.status === 201 && parked.status === 201 && lifeTag.status === 201 && parkTag.status === 201
      && coverOn.status === 200 && parkedSuspend.status === 200
      && updatePre.status === 200 && updatePre.json?.data?.passes === true && updatePut.status === 200
      && patched.status === 200 && patched.json?.data?.name === 'Lifecycle Patched'
      && activated.status === 200 && activated.json?.data?.status === 'active'
      && retired.status === 200 && retired.json?.data?.status === 'retired'
      && parkedActivate.status === 403 && parkedActivate.json?.error?.code === 'POLICY_DENIED'
      && lifeDecisions.text.includes('updateAgent allowed EXPLICIT_ALLOW')
      && lifeDecisions.text.includes('activateAgent allowed EXPLICIT_ALLOW')
      && lifeDecisions.text.includes('retireAgent allowed EXPLICIT_ALLOW')
      && parkedDecisions.text === 'activateAgent denied RESOURCE_INACTIVE'
      && !parkedActivate.text.includes('Lifecycle Parked'),
    `patch=${patched.status} activate=${activated.status} retire=${retired.status} parked=${parkedSuspend.status}/${parkedActivate.status} rows=${lifeDecisions.text.replaceAll('\n', ',')} inactive=${parkedDecisions.text} req=${patched.headers['x-request-id']}`);

    const oldStart = await docker(['run', '-d', '--name', 'fad-s6-old', '--network', 'fad-s0', '-p', '127.0.0.1:18113:8080', '--env-file', envFile, 'fad-api:slice5']);
    const flagOff = await docker(['run', '-d', '--name', 'fad-s6-flagoff', '--network', 'fad-s0', '-p', '127.0.0.1:18112:8080', '--env-file', envFile, '-e', 'FAD_ENFORCEMENT_CODE_ENABLED=false', 'fad-api:slice6']);
    check('DEPLOY-OLD-START', oldStart.code === 0 && flagOff.code === 0 && (await waitReady('http://127.0.0.1:18113')) && (await waitReady('http://127.0.0.1:18112')),
      `old=${oldStart.code} flagoff=${flagOff.code}`);
    const oldRead = await call('http://127.0.0.1:18113', 'GET', `/v1/agents/${agentId}`, keyA1.api_key);
    const flagOffRead = await call('http://127.0.0.1:18112', 'GET', `/v1/agents/${agentId}`, keyA1.api_key);
    const stillEnforce = await call(base2, 'GET', '/v1/enforcement/config', keyAdmin.api_key);
    check('DEPLOY-OLD-IMAGE', oldRead.status === 404 && flagOffRead.status === 404 && stillEnforce.json.data.mode === 'enforce',
      `old=${oldRead.status} flagoff=${flagOffRead.status} mode=${stillEnforce.json?.data?.mode}`);

    await docker(['pause', 'fad-s0-pg']);
    let outage;
    try {
      outage = await call(base1, 'GET', `/v1/agents/${agentId}`, keyA1.api_key);
    } finally {
      await docker(['unpause', 'fad-s0-pg']);
    }
    const afterOutage = await call(base2, 'GET', '/v1/enforcement/config', keyAdmin.api_key);
    check('DEPLOY-OUTAGE', outage.status === 503 && outage.json?.error?.code === 'DEPENDENCY_UNAVAILABLE'
      && afterOutage.json?.data?.mode === 'enforce',
    `status=${outage.status} code=${outage.json?.error?.code} mode=${afterOutage.json?.data?.mode}`);

    const offPut = await call(base2, 'PUT', '/v1/enforcement/config', keyAdmin.api_key, {
      mode: 'off', actions: [], reason: 'deploy audited off', acknowledge_default_deny: false,
    }, { 'idempotency-key': `s6d-off-${stamp}`, 'if-match': afterOutage.headers.etag });
    const seenOff = await call(base1, 'GET', '/v1/enforcement/config', keyAdmin.api_key);
    const oldAfter = await call('http://127.0.0.1:18113', 'GET', `/v1/agents/${agentId}`, keyA1.api_key);
    const flagAfter = await call('http://127.0.0.1:18112', 'GET', `/v1/agents/${agentId}`, keyA1.api_key);
    check('DEPLOY-OFF-BACK', offPut.status === 200 && offPut.json.data.mode === 'off'
      && seenOff.json.data.mode === 'off' && oldAfter.status === 200 && flagAfter.status === 200,
    `put=${offPut.status} r1=${seenOff.json?.data?.mode} old=${oldAfter.status} flagoff=${flagAfter.status}`);

    const prod = await docker(['run', '-d', '--name', 'fad-s6-prod', '--network', 'fad-s0',
      '-e', 'NODE_ENV=production', '-e', 'PORT=8080', '-e', 'FAD_BIND_HOST=0.0.0.0',
      '-e', `DATABASE_URL=${dbUrl}`, '-e', `FAD_API_KEY_PEPPER_V1=${pepper}`, '-e', 'FAD_TRUST_PROXY=false',
      'fad-api:slice6']);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const prodState = await docker(['inspect', '--format', '{{.State.Status}} {{.State.ExitCode}}', 'fad-s6-prod']);
    const prodLogs = await docker(['logs', 'fad-s6-prod']);
    const prodText = `${prodLogs.stdout}\n${prodLogs.stderr}`;
    check('DEPLOY-PROD-BOOT', prod.code === 0 && prodState.stdout.trim().startsWith('exited')
      && !prodState.stdout.trim().endsWith(' 0')
      && /sslmode|production requires FAD_INGRESS_TLS/.test(prodText),
    `start=${prod.code} state=${prodState.stdout.trim()}`);
    note('DEPLOY-PROD-NOTE', 'local Postgres has no TLS. A live production TLS boot was not run.');
  } finally {
    await docker(['unpause', 'fad-s0-pg']);
    await docker(['rm', '-f', ...NAMES]);
    writeFileSync(join(scratch, 'deploy.log'), `${notes.join('\n')}\n`);
  }
});
