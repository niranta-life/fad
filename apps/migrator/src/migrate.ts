import pg from 'pg';
import { readMigrationFiles, type MigrationFile } from '@fad/db';

const { Client } = pg;
const LOCK_KEY = 764001;

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export class MigrationChecksumError extends Error {
  constructor(version: string) {
    super(`Checksum mismatch for migration ${version}`);
    this.name = 'MigrationChecksumError';
  }
}

export async function applyMigrations(connectionString: string, directory: string, lockTimeoutMs = 60_000): Promise<MigrateResult> {
  const files = readMigrationFiles(directory);
  if (files.length === 0) throw new Error('No migration files found');
  const client = new Client({ connectionString, application_name: 'fad-migrator' });
  await client.connect();
  try {
    return await applyOnClient(client, files, lockTimeoutMs);
  } finally {
    await client.end();
  }
}

async function applyOnClient(client: InstanceType<typeof pg.Client>, files: MigrationFile[], lockTimeoutMs: number): Promise<MigrateResult> {
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '${Math.floor(lockTimeoutMs)}ms'`);
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    for (const file of files) {
      const exists = await client.query<{ t: string | null }>(`SELECT to_regclass('public.schema_migrations') AS t`);
      const table = exists.rows[0]?.t;
      if (table) {
        const row = await client.query<{ checksum_sha256: string }>(
          'SELECT checksum_sha256 FROM schema_migrations WHERE version = $1',
          [file.version],
        );
        const stored = row.rows[0]?.checksum_sha256;
        if (stored && stored === file.checksum) {
          skipped.push(file.version);
          continue;
        }
        if (stored && stored !== file.checksum) throw new MigrationChecksumError(file.version);
      }
      await client.query(file.sql);
      await client.query(
        `INSERT INTO schema_migrations (version, checksum_sha256) VALUES ($1, $2)`,
        [file.version, file.checksum],
      );
      applied.push(file.version);
    }
    await client.query('COMMIT');
    return { applied, skipped };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* already aborted */
    }
    throw err;
  }
}
