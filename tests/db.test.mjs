import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import {
  IdempotencyConflictError,
  auditedMutation,
  createPool,
  deleteExpiredIdempotency,
  readMigrationFiles,
  requestFingerprint,
  withBootstrap,
  withTenant,
  writeIdempotency,
} from '@fad/db';
import { applyMigrations } from '@fad/migrator';
import { admin, check, parseJson, requiredEnv, scratch } from './support.mjs';

const { Client } = pg;
const migratorUrl = requiredEnv('FAD_MIGRATOR_DATABASE_URL');
const appUrl = requiredEnv('DATABASE_URL');

function appPool() {
  return createPool({ connectionString: appUrl, max: 1, statementTimeoutMs: 5000, applicationName: 'fad-db-test' });
}

function superPool() {
  return createPool({ connectionString: migratorUrl, max: 2, statementTimeoutMs: 5000, applicationName: 'fad-db-super' });
}

test('PostgreSQL roles, RLS, idempotency, and migrations', async () => {
  const superuser = new Client({ connectionString: migratorUrl, application_name: 'fad-db-test' });
  const app = new Client({ connectionString: appUrl, application_name: 'fad-db-test-app' });
  await superuser.connect();
  await app.connect();
  const pool = appPool();
  const bootstrap = superPool();
  try {
    const roles = await superuser.query(`SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname LIKE 'fad_%'`);
    const byName = Object.fromEntries(roles.rows.map((row) => [row.rolname, row]));
    check('S0-D05-role', byName.fad_app.rolbypassrls === false && byName.fad_app.rolsuper === false && byName.fad_app.rolcanlogin === true);
    const owner = await superuser.query(`SELECT pg_get_userbyid(relowner) AS owner, relforcerowsecurity FROM pg_class WHERE relname = 'organizations'`);
    check('S0-D05-owner', owner.rows[0].owner !== 'fad_app' && owner.rows[0].relforcerowsecurity === true);
    const fn = await superuser.query(`SELECT r.rolname AS owner, p.prosecdef FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE p.proname = 'fad_lookup_api_credential'`);
    check('S0-D07-owner', fn.rows[0].owner === 'fad_auth_reader' && fn.rows[0].prosecdef === true);

    let denied = false;
    try {
      await app.query('SELECT verifier_hmac FROM api_credentials');
    } catch (err) {
      denied = err.code === '42501';
    }
    check('S0-D05', denied);

    let auditUpdate = false;
    try {
      await app.query(`UPDATE audit_events SET action = 'tamper'`);
    } catch (err) {
      auditUpdate = err.code === '42501';
    }
    let auditDelete = false;
    try {
      await app.query('DELETE FROM audit_events');
    } catch (err) {
      auditDelete = err.code === '42501';
    }
    check('S0-D06', auditUpdate && auditDelete);

    let ddl = false;
    try {
      await app.query('CREATE TABLE fad_should_not (id int)');
    } catch (err) {
      ddl = err.code === '42501';
    }
    check('S0-D06-ddl', ddl);

    const orgA = await admin(['organization', 'create', '--name', 'DB Org A']);
    const orgB = await admin(['organization', 'create', '--name', 'DB Org B']);
    check('db-orgs', orgA.code === 0 && orgB.code === 0);
    const a = parseJson(orgA.stdout);
    const b = parseJson(orgB.stdout);
    const principalA = parseJson((await admin(['principal', 'create', '--organization-id', a.id, '--type', 'service', '--name', 'DB A'])).stdout);
    const principalB = parseJson((await admin(['principal', 'create', '--organization-id', b.id, '--type', 'service', '--name', 'DB B'])).stdout);

    const visibleA = await withTenant(pool, a.id, async (client) => {
      const rows = await client.query('SELECT id FROM organizations');
      return rows.rows.map((row) => row.id);
    });
    const visibleB = await withTenant(pool, b.id, async (client) => {
      const rows = await client.query('SELECT id FROM organizations');
      return rows.rows.map((row) => row.id);
    });
    check('S0-D03', visibleA.includes(a.id) && !visibleA.includes(b.id) && visibleB.includes(b.id) && !visibleB.includes(a.id));

    await app.query('BEGIN');
    const unset = await app.query('SELECT count(*)::int AS n FROM organizations');
    await app.query('ROLLBACK');
    check('S0-D02-select', unset.rows[0].n === 0);

    let writeRefused = false;
    try {
      await app.query('BEGIN');
      await app.query(
        `INSERT INTO audit_events (organization_id, id, action, target_type, target_id, outcome)
         VALUES ($1, gen_random_uuid(), 'x', 'organization', $1, 'success')`,
        [a.id],
      );
      await app.query('COMMIT');
    } catch (err) {
      writeRefused = true;
      await app.query('ROLLBACK');
    }
    check('S0-D02-write', writeRefused);

    let override = false;
    try {
      await withTenant(pool, a.id, async (client) => {
        await client.query(
          `INSERT INTO audit_events (organization_id, id, action, target_type, target_id, outcome)
           VALUES ($1, gen_random_uuid(), 'override', 'organization', $1, 'success')`,
          [b.id],
        );
      });
    } catch {
      override = true;
    }
    check('S0-D03-override', override);

    const leaked = await pool.query(`SELECT current_setting('fad.org_id', true) AS org`);
    check('S0-D04', leaked.rows[0].org === null || leaked.rows[0].org === '');
    const afterReuse = await pool.query('SELECT count(*)::int AS n FROM organizations');
    check('S0-D04-rows', afterReuse.rows[0].n === 0);

    const lookup = await app.query(`SELECT * FROM fad_lookup_api_credential($1)`, [`'; DROP TABLE organizations; --`]);
    const stillThere = await superuser.query(`SELECT to_regclass('public.organizations') AS name`);
    check('S0-D07', lookup.rowCount === 0 && stillThere.rows[0].name === 'organizations');
    const columns = await superuser.query(`SELECT pg_get_function_result(p.oid) AS result FROM pg_proc p WHERE p.proname = 'fad_lookup_api_credential'`);
    check('S0-D07-shape', !String(columns.rows[0].result).includes('secret') && String(columns.rows[0].result).includes('verifier_hmac'));

    const before = await superuser.query('SELECT count(*)::int AS n FROM organizations WHERE name = $1', ['rolled back']);
    let rolled = false;
    try {
      await withBootstrap(bootstrap, async (client) => {
        const who = await client.query('SELECT current_user AS u');
        if (who.rows[0].u !== 'fad_bootstrap') throw new Error('role');
        await auditedMutation(client, {
          organizationId: a.id,
          actorPrincipalId: null,
          action: '',
          targetType: 'organization',
          targetId: a.id,
          outcome: 'success',
          details: {},
          mutate: async (tx) => {
            await tx.query(`INSERT INTO organizations (id, name) VALUES (gen_random_uuid(), 'rolled back')`);
          },
        });
      });
    } catch {
      rolled = true;
    }
    const after = await superuser.query('SELECT count(*)::int AS n FROM organizations WHERE name = $1', ['rolled back']);
    check('S0-D08', rolled && after.rows[0].n === before.rows[0].n);

    let fk = false;
    try {
      await withBootstrap(bootstrap, async (client) => {
        await client.query(
          `INSERT INTO api_credentials (organization_id, id, kid, principal_id, verifier_hmac, scopes)
           VALUES ($1, gen_random_uuid(), $2, $3, decode($4, 'hex'), ARRAY['organizations:read'])`,
          [a.id, 'ab'.repeat(16), principalB.id, '11'.repeat(32)],
        );
      });
    } catch (err) {
      fk = err.code === '23503';
    }
    check('S0-D01', fk);

    const cross = await admin([
      'credential', 'issue', '--organization-id', b.id, '--principal-id', principalA.id, '--scopes', 'organizations:read',
    ]);
    check('S0-I05', cross.code === 1 && cross.stderr.includes('CROSS_TENANT'));
    const star = await admin([
      'credential', 'issue', '--organization-id', a.id, '--principal-id', principalA.id, '--scopes', '*',
    ]);
    check('S0-I04', star.code === 1 && star.stderr.includes('INVALID_SCOPE'));

    const fingerprint = requestFingerprint('POST', '/v1/agents', { name: 'same' });
    const other = requestFingerprint('POST', '/v1/agents', { name: 'other' });
    const expires = new Date(Date.now() + 60_000);
    const first = await withTenant(pool, a.id, (client) => writeIdempotency(client, {
      organizationId: a.id,
      principalId: principalA.id,
      method: 'POST',
      resourcePath: '/v1/agents',
      idemKey: 'same-key',
      requestSha256: fingerprint,
      responseStatus: 201,
      responseHeaders: {},
      responseBody: { ok: true },
      expiresAt: expires,
    }));
    const replay = await withTenant(pool, a.id, (client) => writeIdempotency(client, {
      organizationId: a.id,
      principalId: principalA.id,
      method: 'POST',
      resourcePath: '/v1/agents',
      idemKey: 'same-key',
      requestSha256: fingerprint,
      responseStatus: 201,
      responseHeaders: {},
      responseBody: { ok: true },
      expiresAt: expires,
    }));
    let conflict = false;
    try {
      await withTenant(pool, a.id, (client) => writeIdempotency(client, {
        organizationId: a.id,
        principalId: principalA.id,
        method: 'POST',
        resourcePath: '/v1/agents',
        idemKey: 'same-key',
        requestSha256: other,
        responseStatus: 201,
        responseHeaders: {},
        responseBody: { ok: false },
        expiresAt: expires,
      }));
    } catch (err) {
      conflict = err instanceof IdempotencyConflictError;
    }
    const stored = await withTenant(pool, a.id, async (client) => client.query(
      `SELECT response_body FROM idempotency_records WHERE idem_key = 'same-key'`,
    ));
    check('S0-D09', first.replay === false && replay.replay === true && conflict && stored.rowCount === 1);

    const otherOrg = await withTenant(pool, b.id, (client) => writeIdempotency(client, {
      organizationId: b.id,
      principalId: principalB.id,
      method: 'POST',
      resourcePath: '/v1/agents',
      idemKey: 'same-key',
      requestSha256: fingerprint,
      responseStatus: 201,
      responseHeaders: {},
      responseBody: { org: 'b' },
      expiresAt: expires,
    }));
    check('S0-D10', otherOrg.replay === false && otherOrg.responseBody.org === 'b');

    await superuser.query(
      `UPDATE idempotency_records SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day'
       WHERE organization_id = $1 AND idem_key = 'same-key'`,
      [b.id],
    );
    const removed = await withTenant(pool, b.id, (client) => deleteExpiredIdempotency(client, new Date()));
    check('S0-D10-purge', removed >= 1);

    const again = await applyMigrations(migratorUrl, new URL('../db/migrations', import.meta.url).pathname);
    check('S0-D11-rerun', again.applied.length === 0 && again.skipped.includes('0001_foundation'));

    const original = await superuser.query(`SELECT checksum_sha256 FROM schema_migrations WHERE version = '0002_rate_limit'`);
    await superuser.query(`UPDATE schema_migrations SET checksum_sha256 = $1 WHERE version = '0002_rate_limit'`, ['ab'.repeat(32)]);
    let checksumRejected = false;
    try {
      await applyMigrations(migratorUrl, new URL('../db/migrations', import.meta.url).pathname);
    } catch (err) {
      checksumRejected = err.name === 'MigrationChecksumError';
    } finally {
      await superuser.query(`UPDATE schema_migrations SET checksum_sha256 = $1 WHERE version = '0002_rate_limit'`, [original.rows[0].checksum_sha256]);
    }
    const files = readMigrationFiles(new URL('../db/migrations', import.meta.url).pathname);
    const restored = await superuser.query(`SELECT checksum_sha256 FROM schema_migrations WHERE version = '0002_rate_limit'`);
    check('S0-D11-checksum', checksumRejected && restored.rows[0].checksum_sha256 === files.find((file) => file.version === '0002_rate_limit').checksum);

    const failDb = `fad_fail_${Date.now()}`;
    await superuser.query(`CREATE DATABASE ${failDb}`);
    const failUrl = new URL(migratorUrl);
    failUrl.pathname = `/${failDb}`;
    const dir = mkdtempSync(join(scratch, 'bad-migration-'));
    writeFileSync(join(dir, '0099_bad.up.sql'), 'CREATE TABLE fad_should_rollback (id int);\nSELECT 1/0;\n');
    let failed = false;
    try {
      await applyMigrations(failUrl.toString(), dir);
    } catch {
      failed = true;
    }
    const failClient = new Client({ connectionString: failUrl.toString() });
    await failClient.connect();
    const relation = await failClient.query(`SELECT to_regclass('public.fad_should_rollback') AS name`);
    const versionTable = await failClient.query(`SELECT to_regclass('public.schema_migrations') AS name`);
    await failClient.end();
    check('S0-D11-rollback', failed && relation.rows[0].name === null && versionTable.rows[0].name === null);

    const holder = new Client({ connectionString: migratorUrl });
    await holder.connect();
    await holder.query('SELECT pg_advisory_lock(764001)');
    let locked = false;
    try {
      await applyMigrations(migratorUrl, new URL('../db/migrations', import.meta.url).pathname, 400);
    } catch {
      locked = true;
    } finally {
      await holder.query('SELECT pg_advisory_unlock(764001)');
      await holder.end();
    }
    check('S0-D11-lock', locked);
  } finally {
    await pool.end();
    await bootstrap.end();
    await app.end();
    await superuser.end();
  }
});
