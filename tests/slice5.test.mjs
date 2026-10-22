import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { applyMigrations } from '@fad/migrator';
import { POLICY_MIGRATION_VERSION } from '@fad/db';
import { admin, check, parseJson, request, requiredEnv, scratch, startApi, stopApis } from './support.mjs';

const { Client } = pg;
const appUrl = requiredEnv('DATABASE_URL');
const migratorUrl = requiredEnv('FAD_MIGRATOR_DATABASE_URL');
const migrationsDir = new URL('../db/migrations/', import.meta.url).pathname;
const stamp = Date.now().toString(36);
const ADMIN = [
  'organizations:read', 'agents:read', 'agents:write', 'agents:lifecycle',
  'tags:define', 'tags:read', 'tags:write', 'tags:governance', 'tags:restricted:read',
  'policies:read', 'policies:write', 'policies:activate', 'policies:evaluate:any', 'policies:explain',
].join(',');
const WRITER = 'policies:read,policies:write,agents:read';
const SELF = 'agents:read,policies:evaluate:self,policies:explain';
const ANY = 'agents:read,policies:evaluate:any,policies:explain,policies:read,tags:restricted:read';
const TAGS = 'agents:read,tags:define,tags:read,tags:write,tags:governance,tags:restricted:read';
const ORDINARY = 'agents:read,tags:read,tags:write';

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

async function issued(orgId, principalId, scopes) {
  const result = await admin(['credential', 'issue', '--organization-id', orgId, '--principal-id', principalId, '--scopes', scopes]);
  if (result.code !== 0) throw new Error(result.stderr.slice(0, 240));
  return parseJson(result.stdout);
}

async function created(args) {
  const result = await admin(args);
  if (result.code !== 0) throw new Error(`${args.slice(0, 2).join(' ')} ${result.stderr.slice(0, 240)}`);
  return parseJson(result.stdout);
}

function allow(name, principalId, tags) {
  return {
    name,
    description: 'invoke when the agent carries the required tags',
    effect: 'allow',
    actions: ['agent.invoke'],
    subjects: { principal_ids: [principalId] },
    resource: { type: 'agent', tags_all: tags },
  };
}

function predicate(namespace, key, value) {
  return { namespace, key, operator: 'eq', value };
}

async function signToken(privateKey, claims) {
  return new SignJWT({ client_id: claims.clientId, scope: claims.scope })
    .setProtectedHeader({ alg: 'RS256', kid: 's5-kid', typ: 'at+jwt' })
    .setSubject(claims.subject)
    .setIssuedAt()
    .setIssuer(claims.iss)
    .setAudience(claims.aud)
    .setExpirationTime('10m')
    .sign(privateKey);
}

test('policy evaluation journey, isolation, and fail-closed decisions', { timeout: 300_000 }, async () => {
  await applyMigrations(migratorUrl, migrationsDir);
  const superuser = new Client({ connectionString: migratorUrl, application_name: 'fad-s5-super' });
  const app = new Client({ connectionString: appUrl, application_name: 'fad-s5-app' });
  superuser.on('error', () => undefined);
  app.on('error', () => undefined);
  await superuser.connect();
  await app.connect();
  const secrets = [];
  const evidence = [];
  let api;
  const note = (id, detail) => {
    evidence.push(`${id} ${detail}`);
    check(id, true, detail);
  };
  try {
    const version = await superuser.query('SELECT version, checksum_sha256 FROM schema_migrations WHERE version = $1', [POLICY_MIGRATION_VERSION]);
    check('MIG-01', version.rows.length === 1 && version.rows[0].checksum_sha256.length === 64, POLICY_MIGRATION_VERSION);
    const orgA = await created(['organization', 'create', '--name', `Policy A ${stamp}`]);
    const orgB = await created(['organization', 'create', '--name', `Policy B ${stamp}`]);
    const adminP = await created(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Policy Admin']);
    const selfP = await created(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Policy Self']);
    const otherP = await created(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Policy Other']);
    const writerP = await created(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Policy Writer']);
    const tagP = await created(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Policy Tags']);
    const ordinaryP = await created(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Policy Ordinary']);
    const anyP = await created(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Policy Any']);
    const adminB = await created(['principal', 'create', '--organization-id', orgB.id, '--type', 'service', '--name', 'Policy B']);
    const keyAdmin = await issued(orgA.id, adminP.id, ADMIN);
    const keySelf = await issued(orgA.id, selfP.id, SELF);
    const keyOther = await issued(orgA.id, otherP.id, SELF);
    const keyWriter = await issued(orgA.id, writerP.id, WRITER);
    const keyTags = await issued(orgA.id, tagP.id, TAGS);
    const keyOrdinary = await issued(orgA.id, ordinaryP.id, ORDINARY);
    const keyAny = await issued(orgA.id, anyP.id, ANY);
    const keyB = await issued(orgB.id, adminB.id, ADMIN);
    for (const item of [keyAdmin, keySelf, keyOther, keyWriter, keyTags, keyOrdinary, keyAny, keyB]) secrets.push(item.api_key);

    const off = [];
    for (const label of ['off-1', 'off-2']) {
      const started = await startApi({ FAD_POLICIES_ENABLED: 'false', FAD_TAGS_ENABLED: 'true' });
      const current = await call(started.base, 'GET', '/v1/organizations/current', keyAdmin.api_key);
      const hidden = await call(started.base, 'POST', '/v1/policies', keyAdmin.api_key, { name: 'x' }, { 'idempotency-key': `policy-off-${label}` });
      off.push({ ready: started.ready, current: current.status, hidden: hidden.status, org: current.json?.data?.id });
      await started.stop();
    }
    check('FLAG-OFF', off.every((item) => item.ready && item.current === 200 && item.org === orgA.id && item.hidden === 404)
      && off[0].current === off[1].current && off[0].hidden === off[1].hidden, JSON.stringify(off));

    api = await startApi({
      FAD_POLICIES_ENABLED: 'true',
      FAD_TAGS_ENABLED: 'true',
      FAD_SLICE3_ENABLED: 'true',
      FAD_HTTP_REQUEST_TIMEOUT_MS: '8000',
      FAD_SHUTDOWN_GRACE_MS: '8000',
      FAD_DB_POOL_MAX: '8',
      FAD_RATE_LIMIT_MAX: '8000',
    });
    check('API-ON', api.ready, api.logs().slice(-200));
    const agentA = await call(api.base, 'POST', '/v1/agents', keyAdmin.api_key, {
      name: 'Payable Agent', owner_principal_id: selfP.id,
    }, { 'idempotency-key': `pol-agent-a-${stamp}` });
    const agentB = await call(api.base, 'POST', '/v1/agents', keyB.api_key, {
      name: 'Payable Agent B', owner_principal_id: adminB.id,
    }, { 'idempotency-key': `pol-agent-b-${stamp}` });
    const agentId = agentA.json?.data?.id;
    const agentBId = agentB.json?.data?.id;
    check('AGENT', agentA.status === 201 && agentB.status === 201, `${agentA.status} ${agentB.status}`);
    const define = (body, idem, key = keyTags.api_key) => call(api.base, 'POST', '/v1/tag-definitions', key, body, { 'idempotency-key': idem });
    const department = await define({ namespace: 'department', key: 'name', value_type: 'string', governed: false, visibility: 'internal' }, `pol-tag-dept-${stamp}`);
    const billing = await define({ namespace: 'billing', key: 'count', value_type: 'integer', governed: false, visibility: 'internal' }, `pol-tag-count-${stamp}`);
    const risk = await define({
      namespace: 'security', key: 'risk', value_type: 'enum', enum_values: ['low', 'high'], governed: true, visibility: 'restricted',
    }, `pol-tag-risk-${stamp}`);
    check('TAGS', department.status === 201 && billing.status === 201 && risk.status === 201, `${department.status} ${billing.status} ${risk.status}`);
    const putTag = (id, namespace, key, value, idem, token = keyTags.api_key) => call(
      api.base, 'PUT', `/v1/agents/${id}/tags/${namespace}/${key}`, token, { value },
      { 'idempotency-key': idem, 'if-none-match': '*' },
    );
    const taggedName = await putTag(agentId, 'department', 'name', 'finance', `pol-put-name-${stamp}`);
    const taggedCount = await putTag(agentId, 'billing', 'count', 7, `pol-put-count-${stamp}`);
    const taggedRisk = await call(api.base, 'PUT', `/v1/agents/${agentId}/tags/security/risk`, keyTags.api_key, {
      value: 'high', reason: 'Initial classification',
    }, { 'idempotency-key': `pol-put-risk-${stamp}`, 'if-none-match': '*' });
    const ordinaryRisk = await call(api.base, 'PUT', `/v1/agents/${agentId}/tags/security/risk`, keyOrdinary.api_key, {
      value: 'low', reason: 'Editor attempt',
    }, { 'idempotency-key': `pol-risk-ordinary-${stamp}`, 'if-match': taggedRisk.headers.etag });
    check('TAG-ASSIGN', taggedName.status === 201 && taggedCount.status === 201 && taggedRisk.status === 201 && ordinaryRisk.status === 403,
      `${taggedName.status} ${taggedCount.status} ${taggedRisk.status} ${ordinaryRisk.status} ${taggedRisk.text.slice(0, 160)}`);

    const tagsAll = [predicate('department', 'name', 'finance'), predicate('billing', 'count', 7)];
    const draft = await call(api.base, 'POST', '/v1/policies', keyAdmin.api_key, allow('Allow finance', selfP.id, tagsAll), {
      'idempotency-key': `pol-create-allow-${stamp}`,
    });
    const policyId = draft.json?.data?.id;
    const loaded = await call(api.base, 'GET', `/v1/policies/${policyId}`, keyAdmin.api_key);
    const audit = await superuser.query(
      `SELECT count(*)::int AS n FROM audit_events WHERE organization_id = $1 AND target_id = $2 AND action = 'policy.created'`,
      [orgA.id, policyId],
    );
    check('DRAFT', draft.status === 201 && draft.headers.etag === '"policy-v1"' && draft.json.data.revision === 1
      && draft.json.data.status === 'draft' && loaded.status === 200 && loaded.headers.etag === '"policy-v1"'
      && audit.rows[0].n === 1, `status=${draft.status} etag=${draft.headers.etag}`);
    note('REQ-DRAFT', loaded.headers['x-request-id'] ?? '');
    const whileDraft = await call(api.base, 'POST', '/v1/authorization/evaluate', keySelf.api_key, {
      subject: { principal_id: selfP.id }, action: 'agent.invoke', resource: { type: 'agent', id: agentId },
    });
    check('DRAFT-DENY', whileDraft.status === 200 && whileDraft.json.data.decision === 'deny'
      && whileDraft.json.data.reason_code === 'NO_MATCHING_ALLOW' && whileDraft.json.data.enforcement === 'not_enforced');
    const updated = await call(api.base, 'PUT', `/v1/policies/${policyId}`, keyAdmin.api_key, {
      ...allow('Allow finance revised', selfP.id, tagsAll), description: 'revision two',
    }, { 'idempotency-key': `pol-update-allow-${stamp}`, 'if-match': '"policy-v1"' });
    const stale = await call(api.base, 'PUT', `/v1/policies/${policyId}`, keyAdmin.api_key, allow('stale', selfP.id, tagsAll), {
      'idempotency-key': `pol-update-stale-${stamp}`, 'if-match': '"policy-v1"',
    });
    const replay = await call(api.base, 'PUT', `/v1/policies/${policyId}`, keyAdmin.api_key, {
      ...allow('Allow finance revised', selfP.id, tagsAll), description: 'revision two',
    }, { 'idempotency-key': `pol-update-allow-${stamp}`, 'if-match': '"policy-v1"' });
    const revisions = await superuser.query('SELECT count(*)::int AS n FROM fad_policy_revisions WHERE policy_id = $1', [policyId]);
    const prior = await superuser.query(
      `SELECT snapshot->>'name' AS name FROM fad_policy_revisions WHERE policy_id = $1 AND revision = 1`,
      [policyId],
    );
    check('REVISE', updated.status === 200 && updated.json.data.revision === 2 && updated.headers.etag === '"policy-v2"'
      && stale.status === 412 && replay.status === 200 && replay.json.data.revision === 2
      && revisions.rows[0].n === 2 && prior.rows[0].name === 'Allow finance');
    const activated = await call(api.base, 'POST', `/v1/policies/${policyId}/activate`, keyAdmin.api_key, undefined, {
      'idempotency-key': `pol-activate-allow-${stamp}`, 'if-match': updated.headers.etag,
    });
    const allowed = await call(api.base, 'POST', '/v1/authorization/evaluate', keySelf.api_key, {
      subject: { principal_id: selfP.id }, action: 'agent.invoke', resource: { type: 'agent', id: agentId },
      context: { purpose: 'audit', correlation_id: 'slice5-allow' },
    });
    const unmatched = await call(api.base, 'POST', '/v1/authorization/evaluate', keyAny.api_key, {
      subject: { principal_id: otherP.id }, action: 'agent.invoke', resource: { type: 'agent', id: agentId },
    });
    const decisionsAfterAllow = await superuser.query(
      'SELECT count(*)::int AS n FROM fad_policy_decisions WHERE organization_id = $1 AND agent_id = $2',
      [orgA.id, agentId],
    );
    check('ALLOW', activated.status === 200 && activated.json.data.status === 'active'
      && allowed.status === 200 && allowed.json.data.decision === 'allow' && allowed.json.data.reason_code === 'EXPLICIT_ALLOW'
      && allowed.json.data.enforcement === 'not_enforced' && allowed.json.data.input_digest?.length === 64
      && unmatched.status === 200 && unmatched.json.data.decision === 'deny' && unmatched.json.data.reason_code === 'NO_MATCHING_ALLOW'
      && decisionsAfterAllow.rows[0].n === 3, `allow=${allowed.json?.data?.reason_code} rows=${decisionsAfterAllow.rows[0].n}`);
    note('REQ-ALLOW', allowed.headers['x-request-id'] ?? '');
    const firstDigest = allowed.json.data.input_digest;
    const denyDraft = await call(api.base, 'POST', '/v1/policies', keyAdmin.api_key, {
      ...allow('Deny finance', selfP.id, tagsAll), effect: 'deny', name: 'Deny finance',
    }, { 'idempotency-key': `pol-create-deny-${stamp}` });
    const denyId = denyDraft.json.data.id;
    const denyOn = await call(api.base, 'POST', `/v1/policies/${denyId}/activate`, keyAdmin.api_key, undefined, {
      'idempotency-key': `pol-activate-deny-${stamp}`, 'if-match': denyDraft.headers.etag,
    });
    const beaten = await call(api.base, 'POST', '/v1/authorization/evaluate', keySelf.api_key, {
      subject: { principal_id: selfP.id }, action: 'agent.invoke', resource: { type: 'agent', id: agentId },
    });
    const writerActivate = await call(api.base, 'POST', `/v1/policies/${denyId}/disable`, keyWriter.api_key, undefined, {
      'idempotency-key': `pol-writer-disable-${stamp}`, 'if-match': denyOn.headers.etag,
    });
    const disabled = await call(api.base, 'POST', `/v1/policies/${denyId}/disable`, keyAdmin.api_key, undefined, {
      'idempotency-key': `pol-disable-deny-${stamp}`, 'if-match': denyOn.headers.etag,
    });
    const restored = await call(api.base, 'POST', '/v1/authorization/evaluate', keySelf.api_key, {
      subject: { principal_id: selfP.id }, action: 'agent.invoke', resource: { type: 'agent', id: agentId },
    });
    check('DENY-WINS', denyOn.status === 200 && beaten.json.data.decision === 'deny' && beaten.json.data.reason_code === 'EXPLICIT_DENY'
      && writerActivate.status === 403 && disabled.status === 200 && disabled.json.data.status === 'disabled'
      && restored.json.data.decision === 'allow' && restored.json.data.reason_code === 'EXPLICIT_ALLOW');
    const agentNow = await call(api.base, 'GET', `/v1/agents/${agentId}`, keyAdmin.api_key);
    const suspended = await call(api.base, 'POST', `/v1/agents/${agentId}/suspend`, keyAdmin.api_key, { reason: 'Hold the agent' }, {
      'idempotency-key': `pol-suspend-${stamp}`, 'if-match': agentNow.headers.etag,
    });
    const inactive = await call(api.base, 'POST', '/v1/authorization/evaluate', keySelf.api_key, {
      subject: { principal_id: selfP.id }, action: 'agent.invoke', resource: { type: 'agent', id: agentId },
    });
    const reactivated = await call(api.base, 'POST', `/v1/agents/${agentId}/activate`, keyAdmin.api_key, { reason: 'Return the agent' }, {
      'idempotency-key': `pol-reactivate-${stamp}`, 'if-match': suspended.headers.etag,
    });
    const activeAgain = await call(api.base, 'POST', '/v1/authorization/evaluate', keySelf.api_key, {
      subject: { principal_id: selfP.id }, action: 'agent.invoke', resource: { type: 'agent', id: agentId },
    });
    const removed = await call(api.base, 'DELETE', `/v1/agents/${agentId}/tags/billing/count`, keyTags.api_key, undefined, {
      'idempotency-key': `pol-untag-${stamp}`, 'if-match': taggedCount.headers.etag,
    });
    const missingTag = await call(api.base, 'POST', '/v1/authorization/evaluate', keySelf.api_key, {
      subject: { principal_id: selfP.id }, action: 'agent.invoke', resource: { type: 'agent', id: agentId },
    });
    const reassigned = await putTag(agentId, 'billing', 'count', 7, `pol-retag-${stamp}`);
    const taggedAgain = await call(api.base, 'POST', '/v1/authorization/evaluate', keySelf.api_key, {
      subject: { principal_id: selfP.id }, action: 'agent.invoke', resource: { type: 'agent', id: agentId },
    });
    check('STATE', suspended.status === 200 && inactive.json?.data?.reason_code === 'RESOURCE_INACTIVE'
      && reactivated.status === 200 && activeAgain.json?.data?.decision === 'allow'
      && removed.status === 204 && missingTag.json?.data?.decision === 'deny'
      && reassigned.status === 201 && taggedAgain.json?.data?.decision === 'allow'
      && taggedAgain.json?.data?.input_digest !== firstDigest && taggedAgain.json?.data?.input_digest !== missingTag.json?.data?.input_digest,
      `${suspended.status}/${inactive.status}:${inactive.json?.data?.reason_code} ${reactivated.status}/${activeAgain.json?.data?.decision} del=${removed.status} miss=${missingTag.json?.data?.decision} put=${reassigned.status} again=${taggedAgain.json?.data?.reason_code}`);

    const restrictedBody = {
      name: 'Suspend high risk',
      effect: 'deny',
      actions: ['agent.suspend'],
      subjects: { principal_ids: [selfP.id] },
      resource: { type: 'agent', tags_all: [predicate('security', 'risk', 'high')] },
    };
    const restrictedDenied = await call(api.base, 'POST', '/v1/policies', keyWriter.api_key, restrictedBody, {
      'idempotency-key': `pol-restricted-writer-${stamp}`,
    });
    const restricted = await call(api.base, 'POST', '/v1/policies', keyAdmin.api_key, restrictedBody, {
      'idempotency-key': `pol-restricted-admin-${stamp}`,
    });
    const hiddenList = await call(api.base, 'GET', '/v1/policies', keyWriter.api_key);
    const hiddenGet = await call(api.base, 'GET', `/v1/policies/${restricted.json?.data?.id}`, keyWriter.api_key);
    const visibleGet = await call(api.base, 'GET', `/v1/policies/${restricted.json?.data?.id}`, keyAdmin.api_key);
    const restrictedOn = await call(api.base, 'POST', `/v1/policies/${restricted.json.data.id}/activate`, keyAdmin.api_key, undefined, {
      'idempotency-key': `pol-restricted-on-${stamp}`, 'if-match': restricted.headers.etag,
    });
    const explained = await call(api.base, 'POST', '/v1/authorization/evaluate', keySelf.api_key, {
      subject: { principal_id: selfP.id }, action: 'agent.suspend', resource: { type: 'agent', id: agentId },
    });
    const explainedFull = await call(api.base, 'POST', '/v1/authorization/evaluate', keyAny.api_key, {
      subject: { principal_id: selfP.id }, action: 'agent.suspend', resource: { type: 'agent', id: agentId },
    });
    const hiddenText = `${JSON.stringify(hiddenList.json)} ${JSON.stringify(hiddenGet.json)} ${JSON.stringify(explained.json)}`;
    check('RESTRICTED', restrictedDenied.status === 403 && restricted.status === 201 && restricted.json.data.contains_restricted_tags === true
      && hiddenGet.status === 404 && visibleGet.status === 200 && restrictedOn.status === 200
      && !hiddenList.json.data.some((item) => item.id === restricted.json.data.id)
      && explained.status === 200 && explained.json.data.decision === 'deny' && explained.json.data.explanation === undefined
      && explained.json.data.policy_set_digest === undefined
      && explainedFull.json.data.explanation?.some((item) => item.policy_id === restricted.json.data.id)
      && !hiddenText.includes('security') && !hiddenText.includes(restricted.json.data.id));

    const crossPrincipal = await call(api.base, 'POST', '/v1/authorization/evaluate', keyOther.api_key, {
      subject: { principal_id: selfP.id }, action: 'agent.invoke', resource: { type: 'agent', id: agentId },
    });
    const crossTenant = await call(api.base, 'POST', '/v1/authorization/evaluate', keyAdmin.api_key, {
      subject: { principal_id: selfP.id }, action: 'agent.invoke', resource: { type: 'agent', id: agentBId },
    });
    const malformed = await call(api.base, 'POST', '/v1/authorization/evaluate', keySelf.api_key, {
      subject: { principal_id: 'not-a-uuid' }, action: 'agent.invoke', resource: { type: 'agent', id: agentId },
    });
    const polluted = await call(api.base, 'POST', '/v1/policies', keyAdmin.api_key, {
      ...allow('polluted', selfP.id, tagsAll), organization_id: orgB.id, tags: { risk: 'high' },
    }, { 'idempotency-key': `pol-pollute-${stamp}` });
    const duplicate = await call(api.base, 'POST', '/v1/policies', keyAdmin.api_key,
      `{"name":"dup","name":"other","effect":"allow","actions":["agent.invoke"],"subjects":{"principal_ids":["${selfP.id}"]},"resource":{"type":"agent","agent_ids":["${agentId}"]}}`,
      { 'idempotency-key': `pol-duplicate-${stamp}` });
    const nested = `{"name":"deep","effect":"allow","actions":["agent.invoke"],"subjects":{"principal_ids":["${selfP.id}"]},"resource":{"type":"agent","agent_ids":["${agentId}"]},"extra":${'{"a":'.repeat(8)}1${'}'.repeat(8)}}`;
    const deep = await call(api.base, 'POST', '/v1/policies', keyAdmin.api_key, nested, { 'idempotency-key': `pol-deep-${stamp}` });
    const injected = await call(api.base, 'POST', '/v1/policies', keyAdmin.api_key, {
      ...allow(`safe'; DROP TABLE fad_policies;--`, selfP.id, [predicate('department', 'name', 'finance')]),
    }, { 'idempotency-key': `pol-inject-${stamp}` });
    const stillThere = await superuser.query(`SELECT to_regclass('public.fad_policies') AS t`);
    check('REJECT', crossPrincipal.status === 403 && crossTenant.status === 404 && !JSON.stringify(crossTenant.json).includes(agentBId)
      && malformed.status === 422 && polluted.status === 422 && duplicate.status === 400 && deep.status === 400
      && injected.status === 201 && stillThere.rows[0].t === 'fad_policies');

    const caseDeny = await call(api.base, 'POST', '/v1/policies', keyAdmin.api_key, {
      name: 'Deny this agent',
      effect: 'deny',
      actions: ['agent.invoke'],
      subjects: { principal_ids: [selfP.id] },
      resource: { type: 'agent', agent_ids: [agentId] },
    }, { 'idempotency-key': `pol-case-deny-${stamp}` });
    const caseOn = await call(api.base, 'POST', `/v1/policies/${caseDeny.json?.data?.id}/activate`, keyAdmin.api_key, undefined, {
      'idempotency-key': `pol-case-on-${stamp}`, 'if-match': caseDeny.headers.etag,
    });
    await superuser.query('BEGIN');
    try {
      await superuser.query(`SELECT set_config('session_replication_role', 'replica', true)`);
      await superuser.query(
        `UPDATE fad_policies
         SET resource_selector = jsonb_set(resource_selector, '{agent_ids,0}', to_jsonb(upper($2::text)), false)
         WHERE organization_id = $1 AND id = $3`,
        [orgA.id, agentId, caseDeny.json.data.id],
      );
      await superuser.query('COMMIT');
    } catch (error) {
      await superuser.query('ROLLBACK');
      throw error;
    }
    const upperEval = await call(api.base, 'POST', '/v1/authorization/evaluate', keySelf.api_key, {
      subject: { principal_id: selfP.id.toUpperCase() }, action: 'agent.invoke', resource: { type: 'agent', id: agentId.toUpperCase() },
    });
    const lowerEval = await call(api.base, 'POST', '/v1/authorization/evaluate', keySelf.api_key, {
      subject: { principal_id: selfP.id }, action: 'agent.invoke', resource: { type: 'agent', id: agentId },
    });
    check('UUID-CASE', caseOn.status === 200 && upperEval.status === 200 && lowerEval.status === 200
      && upperEval.json?.data?.decision === 'deny' && upperEval.json?.data?.reason_code === 'EXPLICIT_DENY'
      && lowerEval.json?.data?.reason_code === 'EXPLICIT_DENY' && upperEval.json?.data?.enforcement === 'not_enforced',
      `on=${caseOn.status} upper=${upperEval.status}:${upperEval.json?.data?.reason_code} lower=${lowerEval.json?.data?.reason_code}`);
    const caseOff = await call(api.base, 'POST', `/v1/policies/${caseDeny.json.data.id}/disable`, keyAdmin.api_key, undefined, {
      'idempotency-key': `pol-case-off-${stamp}`, 'if-match': caseOn.headers.etag,
    });
    const idAllow = await call(api.base, 'POST', '/v1/policies', keyAdmin.api_key, {
      name: 'Allow this agent',
      effect: 'allow',
      actions: ['agent.invoke'],
      subjects: { principal_ids: [selfP.id] },
      resource: { type: 'agent', agent_ids: [agentId] },
    }, { 'idempotency-key': `pol-id-allow-${stamp}` });
    const idAllowOn = await call(api.base, 'POST', `/v1/policies/${idAllow.json?.data?.id}/activate`, keyAdmin.api_key, undefined, {
      'idempotency-key': `pol-id-allow-on-${stamp}`, 'if-match': idAllow.headers.etag,
    });
    const countDeny = await call(api.base, 'POST', '/v1/policies', keyAdmin.api_key, {
      name: 'Deny this count',
      effect: 'deny',
      actions: ['agent.invoke'],
      subjects: { principal_ids: [selfP.id] },
      resource: { type: 'agent', tags_all: [predicate('billing', 'count', 7)] },
    }, { 'idempotency-key': `pol-count-deny-${stamp}` });
    const countDenyOn = await call(api.base, 'POST', `/v1/policies/${countDeny.json?.data?.id}/activate`, keyAdmin.api_key, undefined, {
      'idempotency-key': `pol-count-deny-on-${stamp}`, 'if-match': countDeny.headers.etag,
    });

    const beforeBad = await superuser.query('SELECT count(*)::int AS n FROM fad_policy_decisions WHERE organization_id = $1', [orgA.id]);
    let badFloat;
    try {
      await superuser.query('BEGIN');
      await superuser.query(`SELECT set_config('session_replication_role', 'replica', true)`);
      await superuser.query(
        `UPDATE agent_tag_assignments SET tag_value = '1.5'::jsonb
         WHERE organization_id = $1 AND agent_id = $2 AND namespace = 'billing' AND tag_key = 'count'`,
        [orgA.id, agentId],
      );
      await superuser.query('COMMIT');
      badFloat = await call(api.base, 'POST', '/v1/authorization/evaluate', keySelf.api_key, {
        subject: { principal_id: selfP.id }, action: 'agent.invoke', resource: { type: 'agent', id: agentId },
      });
    } finally {
      await superuser.query('ROLLBACK').catch(() => undefined);
      await superuser.query(
        `UPDATE agent_tag_assignments SET tag_value = '7'::jsonb
         WHERE organization_id = $1 AND agent_id = $2 AND namespace = 'billing' AND tag_key = 'count'`,
        [orgA.id, agentId],
      );
    }
    const afterBad = await superuser.query('SELECT count(*)::int AS n FROM fad_policy_decisions WHERE organization_id = $1', [orgA.id]);
    check('BAD-TAG', caseOff.status === 200 && idAllowOn.status === 200 && countDenyOn.status === 200
      && badFloat.status === 503 && badFloat.json?.data?.decision !== 'allow'
      && afterBad.rows[0].n === beforeBad.rows[0].n,
      `off=${caseOff.status} allow=${idAllowOn.status} deny=${countDenyOn.status} float=${badFloat?.status}:${badFloat?.json?.error?.code ?? badFloat?.json?.data?.decision} rows=${beforeBad.rows[0].n}->${afterBad.rows[0].n}`);

    const beforeFail = await superuser.query('SELECT count(*)::int AS n FROM fad_policy_decisions WHERE organization_id = $1', [orgA.id]);
    await superuser.query('REVOKE INSERT ON fad_policy_decisions FROM fad_app');
    let failedDecision;
    try {
      failedDecision = await call(api.base, 'POST', '/v1/authorization/evaluate', keySelf.api_key, {
        subject: { principal_id: selfP.id }, action: 'agent.invoke', resource: { type: 'agent', id: agentId },
      });
    } finally {
      await superuser.query('GRANT INSERT ON fad_policy_decisions TO fad_app');
    }
    const afterFail = await superuser.query('SELECT count(*)::int AS n FROM fad_policy_decisions WHERE organization_id = $1', [orgA.id]);
    check('FAIL-CLOSED', failedDecision.status === 503 && failedDecision.json?.data?.decision !== 'allow'
      && afterFail.rows[0].n === beforeFail.rows[0].n, `status=${failedDecision.status} rows=${afterFail.rows[0].n}`);

    const noTenant = await app.query('SELECT count(*)::int AS n FROM fad_policies');
    await app.query('BEGIN');
    await app.query(`SELECT set_config('fad.org_id', $1, true)`, [orgB.id]);
    const otherTenant = await app.query('SELECT count(*)::int AS n FROM fad_policies WHERE id = $1', [policyId]);
    await app.query('ROLLBACK');
    await app.query('BEGIN');
    await app.query(`SELECT set_config('fad.org_id', $1, true)`, [orgA.id]);
    let revisionUpdate = '';
    try {
      await app.query('UPDATE fad_policy_revisions SET operation = operation');
    } catch (error) {
      revisionUpdate = error.code ?? '';
    }
    await app.query('ROLLBACK');
    await app.query('BEGIN');
    await app.query(`SELECT set_config('fad.org_id', $1, true)`, [orgA.id]);
    let decisionDelete = '';
    try {
      await app.query('DELETE FROM fad_policy_decisions');
    } catch (error) {
      decisionDelete = error.code ?? '';
    }
    await app.query('ROLLBACK');
    const bypass = await superuser.query(`SELECT rolbypassrls FROM pg_roles WHERE rolname = 'fad_app'`);
    const forced = await superuser.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
       WHERE relkind = 'r' AND relname IN ('fad_policies', 'fad_policy_revisions', 'fad_policy_decisions')
       ORDER BY 1`,
    );
    check('RLS', noTenant.rows[0].n === 0 && otherTenant.rows[0].n === 0 && revisionUpdate === '42501'
      && decisionDelete === '42501' && bypass.rows[0].rolbypassrls === false
      && forced.rows.length === 3 && forced.rows.every((row) => row.relrowsecurity === true && row.relforcerowsecurity === true),
      `none=${noTenant.rows[0].n} other=${otherTenant.rows[0].n} upd=${revisionUpdate} del=${decisionDelete} bypass=${bypass.rows[0].rolbypassrls} tables=${forced.rows.map((row) => row.relname).join(',')}`);
    writeFileSync(join(scratch, 'schema-and-rls.txt'), `${forced.rows.map((row) => `${row.relname} rls=${row.relrowsecurity} force=${row.relforcerowsecurity}`).join('\n')}\n`);

    const draftOnly = await call(api.base, 'POST', '/v1/policies', keyWriter.api_key, allow('Writer draft', selfP.id, tagsAll), {
      'idempotency-key': `pol-writer-draft-${stamp}`,
    });
    const directDisable = await call(api.base, 'POST', `/v1/policies/${draftOnly.json.data.id}/disable`, keyAdmin.api_key, undefined, {
      'idempotency-key': `pol-disable-draft-${stamp}`, 'if-match': draftOnly.headers.etag,
    });
    check('LIFECYCLE', draftOnly.status === 201 && directDisable.status === 409);

    const rowsBefore = decisionsAfterAllow.rows[0].n;
    writeFileSync(join(scratch, 'journey.log'), `${evidence.join('\n')}\nallow_request=${allowed.headers['x-request-id']}\ndecisions_at_allow=${rowsBefore}\n`);
    const logText = api.logs();
    check('LOGS', !secrets.some((secret) => logText.includes(secret)) && !logText.includes('high'));
  } finally {
    await superuser.query('GRANT INSERT ON fad_policy_decisions TO fad_app').catch(() => undefined);
    await stopApis();
    await app.end().catch(() => undefined);
    await superuser.end().catch(() => undefined);
  }
});
