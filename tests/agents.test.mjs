import test from 'node:test';
import pg from 'pg';
import { applyMigrations } from '@fad/migrator';
import { admin, check, parseJson, request, requiredEnv, startApi, stopApis } from './support.mjs';

const { Client } = pg;
const appUrl = requiredEnv('DATABASE_URL');
const migratorUrl = requiredEnv('FAD_MIGRATOR_DATABASE_URL');
const scopes = 'organizations:read,agents:read,agents:write,agents:lifecycle';

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

test('agent registration, isolation, idempotency, and lifecycle', async () => {
  await applyMigrations(migratorUrl, new URL('../db/migrations', import.meta.url).pathname);
  const superuser = new Client({ connectionString: migratorUrl, application_name: 'fad-agent-super' });
  const app = new Client({ connectionString: appUrl, application_name: 'fad-agent-app' });
  superuser.on('error', () => undefined);
  app.on('error', () => undefined);
  await superuser.connect();
  await app.connect();
  const api = await startApi({
    FAD_HTTP_REQUEST_TIMEOUT_MS: '30000',
    FAD_SHUTDOWN_GRACE_MS: '30000',
    FAD_DB_POOL_MAX: '10',
    FAD_RATE_LIMIT_MAX: '5000',
  });
  try {
    check('agent-api-up', api.ready);
    await superuser.query('DELETE FROM rate_limit_buckets');
    const orgA = parseJson((await admin(['organization', 'create', '--name', 'Agent Org A'])).stdout);
    const orgB = parseJson((await admin(['organization', 'create', '--name', 'Agent Org B'])).stdout);
    const actor = parseJson((await admin(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Agent Actor'])).stdout);
    const owner = parseJson((await admin(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Agent Owner'])).stdout);
    const ownerB = parseJson((await admin(['principal', 'create', '--organization-id', orgB.id, '--type', 'service', '--name', 'Agent Owner B'])).stdout);
    const actorB = parseJson((await admin(['principal', 'create', '--organization-id', orgB.id, '--type', 'service', '--name', 'Agent Actor B'])).stdout);
    const replayActor = parseJson((await admin(['principal', 'create', '--organization-id', orgA.id, '--type', 'service', '--name', 'Agent Replay'])).stdout);
    const keyA = parseJson((await admin(['credential', 'issue', '--organization-id', orgA.id, '--principal-id', actor.id, '--scopes', scopes])).stdout);
    const keyRead = parseJson((await admin(['credential', 'issue', '--organization-id', orgA.id, '--principal-id', actor.id, '--scopes', 'agents:read'])).stdout);
    const keyB = parseJson((await admin(['credential', 'issue', '--organization-id', orgB.id, '--principal-id', actorB.id, '--scopes', scopes])).stdout);
    const keyReplay = parseJson((await admin(['credential', 'issue', '--organization-id', orgA.id, '--principal-id', replayActor.id, '--scopes', scopes])).stdout);
    const secrets = [keyA.api_key, keyRead.api_key, keyB.api_key, keyReplay.api_key];

    const created = await call(api.base, 'POST', '/v1/agents', keyA.api_key, {
      name: '  Accounts Payable Agent  ',
      description: 'Manages supplier invoice workflow',
      owner_principal_id: owner.id,
    }, { 'idempotency-key': 'agent-register-0001' });
    check('agent-create', created.status === 201
      && created.headers.etag === '"agent-v1"'
      && created.headers.location === `/v1/agents/${created.json.data.id}`
      && created.headers['cache-control'] === 'private, no-store'
      && created.json.data.revision === 1
      && created.json.data.status === 'active'
      && created.json.data.name === 'Accounts Payable Agent'
      && created.json.data.organization_id === orgA.id
      && created.json.data.global_id === `urn:fad:agent:${orgA.id}:${created.json.data.id}`
      && created.json.meta.api_version === 'v1'
      && created.json.meta.request_id === created.headers['x-request-id'],
    `status=${created.status} code=${created.json?.error?.code ?? ''}`);
    const agentId = created.json.data.id;
    const replay = await call(api.base, 'POST', '/v1/agents', keyA.api_key, {
      name: '  Accounts Payable Agent  ',
      description: 'Manages supplier invoice workflow',
      owner_principal_id: owner.id,
    }, { 'idempotency-key': 'agent-register-0001' });
    check('agent-replay', replay.status === 201 && replay.json.data.id === agentId && replay.json.meta.request_id !== created.json.meta.request_id);
    check('agent-one-row', await count(superuser, 'SELECT count(*)::int AS n FROM agents WHERE organization_id = $1 AND id = $2', [orgA.id, agentId]) === 1);
    check('agent-one-revision', await count(superuser, 'SELECT count(*)::int AS n FROM agent_revisions WHERE organization_id = $1 AND agent_id = $2', [orgA.id, agentId]) === 1);
    check('agent-one-audit', await count(superuser, `SELECT count(*)::int AS n FROM audit_events WHERE organization_id = $1 AND target_id = $2 AND action = 'agent.registered'`, [orgA.id, agentId]) === 1);

    const loaded = await call(api.base, 'GET', `/v1/agents/${agentId}`, keyA.api_key);
    const listed = await call(api.base, 'GET', '/v1/agents?limit=25', keyA.api_key);
    check('agent-get', loaded.status === 200 && loaded.json.data.id === agentId && loaded.headers.etag === '"agent-v1"');
    check('agent-list', listed.status === 200 && listed.json.data.some((item) => item.id === agentId) && listed.json.meta.limit === 25);
    const missingId = '11111111-1111-4111-8111-111111111111';
    const missing = await call(api.base, 'GET', `/v1/agents/${missingId}`, keyB.api_key);
    const hidden = await call(api.base, 'GET', `/v1/agents/${agentId}`, keyB.api_key);
    check('agent-cross-tenant-404', hidden.status === 404 && missing.status === 404
      && hidden.json.error.code === 'AGENT_NOT_FOUND'
      && hidden.json.error.code === missing.json.error.code
      && hidden.json.error.message === missing.json.error.message
      && !hidden.text.includes(created.json.data.name));
    const hiddenList = await call(api.base, 'GET', '/v1/agents', keyB.api_key);
    check('agent-list-isolated', hiddenList.status === 200 && !hiddenList.json.data.some((item) => item.id === agentId));

    const patched = await call(api.base, 'PATCH', `/v1/agents/${agentId}`, keyA.api_key, {
      description: 'Matches supplier invoices against POs',
    }, { 'idempotency-key': 'agent-patch-0001', 'if-match': '"agent-v1"' });
    check('agent-patch', patched.status === 200 && patched.headers.etag === '"agent-v2"' && patched.json.data.revision === 2);
    const stale = await call(api.base, 'PATCH', `/v1/agents/${agentId}`, keyA.api_key, {
      description: 'stale write',
    }, { 'idempotency-key': 'agent-patch-stale', 'if-match': '"agent-v1"' });
    check('agent-stale-if-match', stale.status === 412 && stale.json.error.code === 'PRECONDITION_FAILED');
    const patchReplay = await call(api.base, 'PATCH', `/v1/agents/${agentId}`, keyA.api_key, {
      description: 'Matches supplier invoices against POs',
    }, { 'idempotency-key': 'agent-patch-0001', 'if-match': '"agent-v1"' });
    check('agent-patch-replay', patchReplay.status === 200 && patchReplay.json.data.revision === 2
      && patchReplay.json.meta.request_id !== patched.json.meta.request_id);
    const missingMatch = await call(api.base, 'PATCH', `/v1/agents/${agentId}`, keyA.api_key, {
      description: 'no match',
    }, { 'idempotency-key': 'agent-patch-no-match' });
    check('agent-missing-if-match', missingMatch.status === 428 && missingMatch.json.error.code === 'PRECONDITION_REQUIRED');
    const noop = await call(api.base, 'PATCH', `/v1/agents/${agentId}`, keyA.api_key, {
      description: 'Matches supplier invoices against POs',
    }, { 'idempotency-key': 'agent-patch-noop', 'if-match': '"agent-v2"' });
    check('agent-noop', noop.status === 200 && noop.headers.etag === '"agent-v2"' && noop.json.data.revision === 2);

    const suspended = await call(api.base, 'POST', `/v1/agents/${agentId}/suspend`, keyA.api_key, {
      reason: 'Security review required',
    }, { 'idempotency-key': 'agent-suspend-0001', 'if-match': '"agent-v2"' });
    check('agent-suspend', suspended.status === 200 && suspended.json.data.status === 'suspended' && suspended.headers.etag === '"agent-v3"');
    const suspendAgain = await call(api.base, 'POST', `/v1/agents/${agentId}/suspend`, keyA.api_key, {
      reason: 'Security review required again',
    }, { 'idempotency-key': 'agent-suspend-0002', 'if-match': '"agent-v3"' });
    check('agent-suspend-noop', suspendAgain.status === 200 && suspendAgain.json.data.revision === 3);
    const whileSuspended = await call(api.base, 'PATCH', `/v1/agents/${agentId}`, keyA.api_key, {
      description: 'Still editable while suspended',
    }, { 'idempotency-key': 'agent-patch-suspended', 'if-match': '"agent-v3"' });
    check('agent-suspended-patch', whileSuspended.status === 200 && whileSuspended.json.data.revision === 4 && whileSuspended.json.data.status === 'suspended');
    const activated = await call(api.base, 'POST', `/v1/agents/${agentId}/activate`, keyA.api_key, {
      reason: 'Review complete',
    }, { 'idempotency-key': 'agent-activate-0001', 'if-match': '"agent-v4"' });
    check('agent-activate', activated.status === 200 && activated.json.data.status === 'active' && activated.headers.etag === '"agent-v5"');
    const retired = await call(api.base, 'POST', `/v1/agents/${agentId}/retire`, keyA.api_key, {
      reason: 'Replaced by a successor',
    }, { 'idempotency-key': 'agent-retire-0001', 'if-match': '"agent-v5"' });
    check('agent-retire', retired.status === 200 && retired.json.data.status === 'retired' && retired.headers.etag === '"agent-v6"');
    const retireAgain = await call(api.base, 'POST', `/v1/agents/${agentId}/retire`, keyA.api_key, {
      reason: 'Already retired',
    }, { 'idempotency-key': 'agent-retire-0002', 'if-match': '"agent-v6"' });
    check('agent-retire-noop', retireAgain.status === 200 && retireAgain.json.data.revision === 6);
    const reactivate = await call(api.base, 'POST', `/v1/agents/${agentId}/activate`, keyA.api_key, {
      reason: 'Try to return',
    }, { 'idempotency-key': 'agent-activate-retired', 'if-match': '"agent-v6"' });
    const editRetired = await call(api.base, 'PATCH', `/v1/agents/${agentId}`, keyA.api_key, {
      description: 'should fail',
    }, { 'idempotency-key': 'agent-patch-retired', 'if-match': '"agent-v6"' });
    const stillThere = await call(api.base, 'GET', `/v1/agents/${agentId}`, keyA.api_key);
    check('agent-retired-terminal', reactivate.status === 409 && reactivate.json.error.code === 'INVALID_STATE_TRANSITION'
      && editRetired.status === 409 && stillThere.status === 200 && stillThere.json.data.status === 'retired');

    const conflict = await call(api.base, 'POST', '/v1/agents', keyA.api_key, {
      name: 'Different Agent',
      owner_principal_id: owner.id,
    }, { 'idempotency-key': 'agent-register-0001' });
    check('agent-key-conflict', conflict.status === 409 && conflict.json.error.code === 'IDEMPOTENCY_CONFLICT');
    const foreignOwner = await call(api.base, 'POST', '/v1/agents', keyA.api_key, {
      name: 'Foreign Owner',
      owner_principal_id: ownerB.id,
    }, { 'idempotency-key': 'agent-foreign-owner' });
    check('agent-foreign-owner', foreignOwner.status === 422 && foreignOwner.json.error.code === 'VALIDATION_ERROR' && !foreignOwner.text.includes(orgB.id));
    const spoof = await call(api.base, 'POST', '/v1/agents', keyA.api_key, {
      name: 'Spoofed',
      owner_principal_id: owner.id,
      organization_id: orgB.id,
      status: 'retired',
    }, { 'idempotency-key': 'agent-spoof-fields' });
    check('agent-spoof', spoof.status === 422 && spoof.json.error.code === 'VALIDATION_ERROR');
    const readOnly = await call(api.base, 'POST', '/v1/agents', keyRead.api_key, {
      name: 'Read only',
      owner_principal_id: owner.id,
    }, { 'idempotency-key': 'agent-read-only' });
    const absent = await call(api.base, 'GET', '/v1/agents', '');
    check('agent-authz', readOnly.status === 403 && readOnly.json.error.code === 'FORBIDDEN' && absent.status === 401);
    const badType = await call(api.base, 'POST', '/v1/agents', keyA.api_key, '{"name":"X"}', {
      'content-type': 'text/plain',
      'idempotency-key': 'agent-bad-type',
    });
    check('agent-media-type', badType.status === 415 && badType.json.error.code === 'UNSUPPORTED_MEDIA_TYPE');
    const badQuery = await call(api.base, 'GET', '/v1/agents?sort=name', keyA.api_key);
    const badLimit = await call(api.base, 'GET', '/v1/agents?limit=0', keyA.api_key);
    const badId = await call(api.base, 'GET', '/v1/agents/not-a-uuid', keyA.api_key);
    check('agent-validation', badQuery.status === 400 && badLimit.status === 400 && badId.status === 400
      && badQuery.json.error.code === 'VALIDATION_ERROR');

    const injected = await call(api.base, 'POST', '/v1/agents', keyA.api_key, {
      name: "Robert'); DROP TABLE agents;--",
      owner_principal_id: owner.id,
    }, { 'idempotency-key': 'agent-sql-name' });
    check('agent-sql-name', injected.status === 201 && injected.json.data.name === "Robert'); DROP TABLE agents;--");
    check('agent-table-remains', await count(superuser, 'SELECT count(*)::int AS n FROM agents WHERE id = $1', [injected.json.data.id]) === 1);

    const pageOwner = owner.id;
    const pageIds = [];
    for (let index = 0; index < 3; index += 1) {
      const pageItem = await call(api.base, 'POST', '/v1/agents', keyA.api_key, {
        name: `Page Agent ${index}`,
        owner_principal_id: pageOwner,
      }, { 'idempotency-key': `agent-page-${index}` });
      check(`agent-page-create-${index}`, pageItem.status === 201);
      pageIds.push(pageItem.json.data.id);
    }
    const firstPage = await call(api.base, 'GET', '/v1/agents?limit=2', keyA.api_key);
    const cursor = firstPage.json.meta.next_cursor;
    const secondPage = await call(api.base, 'GET', `/v1/agents?limit=2&cursor=${encodeURIComponent(cursor)}`, keyA.api_key);
    const seen = new Set([...firstPage.json.data, ...secondPage.json.data].map((item) => item.id));
    check('agent-pages', firstPage.status === 200 && secondPage.status === 200 && cursor
      && firstPage.json.data.length === 2 && pageIds.every((id) => seen.has(id))
      && new Set(firstPage.json.data.map((item) => item.id)).size + new Set(secondPage.json.data.map((item) => item.id)).size
        === new Set([...firstPage.json.data, ...secondPage.json.data].map((item) => item.id)).size);

    const olderMs = await call(api.base, 'POST', '/v1/agents', keyA.api_key, {
      name: 'Same Millisecond Older',
      owner_principal_id: pageOwner,
    }, { 'idempotency-key': 'agent-same-ms-older' });
    const newerMs = await call(api.base, 'POST', '/v1/agents', keyA.api_key, {
      name: 'Same Millisecond Newer',
      owner_principal_id: pageOwner,
    }, { 'idempotency-key': 'agent-same-ms-newer' });
    await superuser.query(
      `UPDATE agents
       SET created_at = timestamptz '2099-01-01 00:00:00.100200+00',
           updated_at = timestamptz '2099-01-01 00:00:00.100200+00'
       WHERE organization_id = $1 AND id = $2`,
      [orgA.id, olderMs.json.data.id],
    );
    await superuser.query(
      `UPDATE agents
       SET created_at = timestamptz '2099-01-01 00:00:00.100800+00',
           updated_at = timestamptz '2099-01-01 00:00:00.100800+00'
       WHERE organization_id = $1 AND id = $2`,
      [orgA.id, newerMs.json.data.id],
    );
    const sameFirst = await call(api.base, 'GET', '/v1/agents?limit=1', keyA.api_key);
    const sameCursor = sameFirst.json.meta.next_cursor;
    const sameSecond = await call(api.base, 'GET', `/v1/agents?limit=1&cursor=${encodeURIComponent(sameCursor)}`, keyA.api_key);
    const cursorAt = JSON.parse(Buffer.from(String(sameCursor).split('.')[0], 'base64url').toString('utf8')).at;
    check('agent-same-ms-page', olderMs.status === 201 && newerMs.status === 201
      && sameFirst.status === 200 && sameSecond.status === 200
      && sameFirst.json.data.length === 1 && sameSecond.json.data.length === 1
      && sameFirst.json.data[0].id === newerMs.json.data.id
      && sameSecond.json.data[0].id === olderMs.json.data.id
      && cursorAt === '2099-01-01T00:00:00.100800Z',
      `at=${cursorAt} first=${sameFirst.json.data?.[0]?.id} second=${sameSecond.json.data?.[0]?.id}`);
    const tampered = await call(api.base, 'GET', `/v1/agents?cursor=${encodeURIComponent(`${cursor}x`)}`, keyA.api_key);
    const wrongFilter = await call(api.base, 'GET', `/v1/agents?status=suspended&cursor=${encodeURIComponent(cursor)}`, keyA.api_key);
    const wrongTenant = await call(api.base, 'GET', `/v1/agents?cursor=${encodeURIComponent(cursor)}`, keyB.api_key);
    check('agent-cursor-reject', tampered.status === 400 && wrongFilter.status === 400 && wrongTenant.status === 400);

    const raceBody = { name: 'Race Agent', owner_principal_id: owner.id };
    const raced = await Promise.all(Array.from({ length: 100 }, () => call(api.base, 'POST', '/v1/agents', keyA.api_key, raceBody, { 'idempotency-key': 'agent-race-register' })));
    const raceIds = new Set(raced.filter((item) => item.status === 201).map((item) => item.json.data.id));
    check('agent-race-status', raced.every((item) => item.status === 201) && raceIds.size === 1);
    const raceId = [...raceIds][0];
    check('agent-race-row', await count(superuser, 'SELECT count(*)::int AS n FROM agents WHERE id = $1', [raceId]) === 1);
    check('agent-race-history', await count(superuser, 'SELECT count(*)::int AS n FROM agent_revisions WHERE agent_id = $1', [raceId]) === 1
      && await count(superuser, `SELECT count(*)::int AS n FROM audit_events WHERE target_id = $1 AND action = 'agent.registered'`, [raceId]) === 1);

    const live = await call(api.base, 'POST', '/v1/agents', keyA.api_key, {
      name: 'Concurrent Patch',
      owner_principal_id: owner.id,
    }, { 'idempotency-key': 'agent-concurrent-create' });
    const concurrent = await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map((index) => call(
      api.base, 'PATCH', `/v1/agents/${live.json.data.id}`, keyA.api_key,
      { description: `writer ${index}` },
      { 'idempotency-key': `agent-concurrent-${index}`, 'if-match': '"agent-v1"' },
    )));
    check('agent-concurrent-patch', concurrent.filter((item) => item.status === 200).length === 1
      && concurrent.filter((item) => item.status === 412).length === 7);

    const bare = await app.query('SELECT count(*)::int AS n FROM agents');
    check('agent-no-context', bare.rows[0].n === 0);
    await app.query('BEGIN');
    await app.query(`SELECT set_config('fad.org_id', $1, true)`, [orgB.id]);
    const crossed = await app.query('SELECT count(*)::int AS n FROM agents WHERE id = $1', [agentId]);
    await app.query('ROLLBACK');
    check('agent-rls-cross', crossed.rows[0].n === 0);
    const grants = await superuser.query(`
      SELECT
        has_table_privilege('fad_app', 'agents', 'DELETE') AS agent_delete,
        has_table_privilege('fad_app', 'agent_revisions', 'UPDATE') AS revision_update,
        has_table_privilege('fad_app', 'agent_revisions', 'DELETE') AS revision_delete,
        has_table_privilege('fad_app', 'agent_lifecycle_events', 'UPDATE') AS life_update,
        has_table_privilege('fad_app', 'api_credentials', 'SELECT') AS credential_select,
        has_table_privilege('fad_app', 'principals', 'UPDATE') AS principal_update,
        (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'fad_app') AS bypass
    `);
    const grant = grants.rows[0];
    check('agent-grants', grant.agent_delete === false && grant.revision_update === false && grant.revision_delete === false
      && grant.life_update === false && grant.credential_select === false && grant.principal_update === false && grant.bypass === false);

    const expiring = await call(api.base, 'POST', '/v1/agents', keyA.api_key, {
      name: 'Expiring Key Agent',
      owner_principal_id: owner.id,
    }, { 'idempotency-key': 'agent-expire-key-01' });
    await superuser.query(
      `UPDATE idempotency_records
       SET created_at = timestamptz '2000-01-01T00:00:00Z',
           expires_at = timestamptz '2000-01-01T00:00:01Z'
       WHERE organization_id = $1 AND principal_id = $2 AND idem_key = 'agent-expire-key-01'`,
      [orgA.id, actor.id],
    );
    const expired = await call(api.base, 'POST', '/v1/agents', keyA.api_key, {
      name: 'Expiring Key Agent',
      owner_principal_id: owner.id,
    }, { 'idempotency-key': 'agent-expire-key-01' });
    check('agent-expired-key', expiring.status === 201 && expired.status === 201 && expired.json.data.id !== expiring.json.data.id,
      `first=${expiring.status} second=${expired.status}`);

    const beforeDisable = await call(api.base, 'POST', '/v1/agents', keyReplay.api_key, {
      name: 'Replay After Disable',
      owner_principal_id: owner.id,
    }, { 'idempotency-key': 'agent-disable-replay' });
    await admin(['principal', 'disable', '--organization-id', orgA.id, '--principal-id', replayActor.id, '--reason', 'Replay must fail']);
    const afterDisable = await call(api.base, 'POST', '/v1/agents', keyReplay.api_key, {
      name: 'Replay After Disable',
      owner_principal_id: owner.id,
    }, { 'idempotency-key': 'agent-disable-replay' });
    check('agent-disabled-replay', beforeDisable.status === 201 && afterDisable.status === 401 && afterDisable.json.error.code === 'UNAUTHORIZED');

    const auditTarget = await call(api.base, 'POST', '/v1/agents', keyA.api_key, {
      name: 'Audit Rollback',
      owner_principal_id: owner.id,
    }, { 'idempotency-key': 'agent-audit-rollback' });
    await superuser.query(`
      CREATE OR REPLACE FUNCTION fad_test_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action LIKE 'agent.%' THEN
          RAISE EXCEPTION 'forced audit failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      DROP TRIGGER IF EXISTS fad_test_fail_audit ON audit_events;
      CREATE TRIGGER fad_test_fail_audit BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION fad_test_fail_audit();
    `);
    const rolled = await call(api.base, 'PATCH', `/v1/agents/${auditTarget.json.data.id}`, keyA.api_key, {
      description: 'must roll back',
    }, { 'idempotency-key': 'agent-audit-patch', 'if-match': '"agent-v1"' });
    const unchanged = await superuser.query('SELECT revision, description FROM agents WHERE id = $1', [auditTarget.json.data.id]);
    check('agent-audit-rollback', rolled.status === 500 && unchanged.rows[0].revision === '1' && unchanged.rows[0].description === '');

    const second = await startApi({});
    check('agent-replica-up', second.ready);
    const fromSecond = await call(second.base, 'GET', `/v1/agents/${agentId}`, keyA.api_key);
    check('agent-replica-get', fromSecond.status === 200 && fromSecond.json.data.id === agentId);
    await second.stop();
    check('agent-logs', secrets.every((secret) => !api.logs().includes(secret)));
  } finally {
    await superuser.query('DROP TRIGGER IF EXISTS fad_test_fail_audit ON audit_events').catch(() => undefined);
    await superuser.query('DROP FUNCTION IF EXISTS fad_test_fail_audit()').catch(() => undefined);
    await app.end().catch(() => undefined);
    await superuser.end().catch(() => undefined);
    await api.stop();
    await stopApis();
  }
});
