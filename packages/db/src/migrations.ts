import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface MigrationFile {
  version: string;
  path: string;
  sql: string;
  checksum: string;
}

export function migrationChecksum(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function readMigrationFiles(directory: string): MigrationFile[] {
  const names = readdirSync(directory)
    .filter((name) => name.endsWith('.up.sql'))
    .sort();
  return names.map((name) => {
    const path = resolve(directory, name);
    const bytes = readFileSync(path);
    const version = name.replace(/\.up\.sql$/, '');
    return { version, path, sql: bytes.toString('utf8'), checksum: migrationChecksum(bytes) };
  });
}
