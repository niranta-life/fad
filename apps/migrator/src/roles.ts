import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;

export function rolesSqlPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../db/roles/00_roles.sql');
}

export async function applyRoles(connectionString: string, appPassword: string | undefined, sqlPath = rolesSqlPath()): Promise<void> {
  const sql = readFileSync(sqlPath, 'utf8');
  const client = new Client({ connectionString, application_name: 'fad-migrator' });
  await client.connect();
  try {
    await client.query(sql);
    if (appPassword && appPassword.length > 0) {
      await client.query(`ALTER ROLE fad_app WITH LOGIN PASSWORD ${client.escapeLiteral(appPassword)} NOBYPASSRLS`);
    }
    const check = await client.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('fad_app', 'fad_migrator', 'fad_auth_reader', 'fad_bootstrap')`,
    );
    const app = check.rows.find((row) => row.rolname === 'fad_app');
    if (!app || app.rolsuper || app.rolbypassrls) {
      throw new Error('fad_app role is missing or too privileged');
    }
  } finally {
    await client.end();
  }
}
