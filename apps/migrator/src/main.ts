#!/usr/bin/env node
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrations } from './migrate.js';
import { applyRoles } from './roles.js';

function migrationsDir(): string {
  return process.env.FAD_MIGRATIONS_DIR && process.env.FAD_MIGRATIONS_DIR.length > 0
    ? process.env.FAD_MIGRATIONS_DIR
    : resolve(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
}

function databaseUrl(): string {
  const url = process.env.FAD_MIGRATOR_DATABASE_URL;
  if (!url) {
    console.error(JSON.stringify({ error: { code: 'CONFIG', message: 'FAD_MIGRATOR_DATABASE_URL is required' } }));
    process.exit(2);
  }
  return url;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'roles') {
    await applyRoles(databaseUrl(), process.env.FAD_APP_DB_PASSWORD);
    console.log(JSON.stringify({ ok: true, action: 'roles' }));
    return;
  }
  if (command === 'up') {
    const result = await applyMigrations(databaseUrl(), migrationsDir());
    console.log(JSON.stringify({ ok: true, ...result }));
    return;
  }
  if (command === 'bootstrap') {
    await applyRoles(databaseUrl(), process.env.FAD_APP_DB_PASSWORD);
    const result = await applyMigrations(databaseUrl(), migrationsDir());
    console.log(JSON.stringify({ ok: true, action: 'bootstrap', ...result }));
    return;
  }
  console.error('usage: fad-migrate roles|up|bootstrap');
  process.exit(1);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.name : 'migration failed';
  console.error(JSON.stringify({ error: { code: 'MIGRATION', message } }));
  process.exit(1);
});
