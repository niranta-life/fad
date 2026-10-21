#!/usr/bin/env node
import { assertPepper, PepperError } from '@fad/auth-core';
import { isDependencyError } from '@fad/db';
import { AdminError, execute, openAdminPool, parseCommand } from './cli.js';

function fail(code: string, message: string, exitCode: number): never {
  console.error(JSON.stringify({ error: { code, message } }));
  process.exit(exitCode);
}

async function main(): Promise<void> {
  let pepper;
  try {
    pepper = assertPepper(process.env.FAD_API_KEY_PEPPER_V1);
  } catch (err) {
    if (err instanceof PepperError) fail('CONFIG', err.message, 2);
    throw err;
  }
  const databaseUrl = process.env.FAD_BOOTSTRAP_DATABASE_URL;
  if (!databaseUrl) fail('CONFIG', 'FAD_BOOTSTRAP_DATABASE_URL is required', 2);
  let command;
  try {
    command = parseCommand(process.argv.slice(2));
  } catch (err) {
    if (err instanceof AdminError) fail(err.code, err.message, err.exitCode);
    throw err;
  }
  const pool = openAdminPool(databaseUrl);
  try {
    const result = await execute(pool, command, pepper);
    if (command.path[0] === 'credential' && command.path[1] === 'issue') {
      console.error('Store this API key now. It will not be shown again.');
    }
    console.log(JSON.stringify(result));
  } catch (err) {
    if (err instanceof AdminError) fail(err.code, err.message, err.exitCode);
    if (isDependencyError(err)) fail('DEPENDENCY', 'Database is unavailable', 2);
    const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code?: unknown }).code) : '';
    if (code === '23503') fail('CROSS_TENANT', 'Cross-tenant reference was rejected', 1);
    if (code === '23514') fail('INVALID_ARGUMENT', 'Database constraint rejected the change', 1);
    fail('DEPENDENCY', 'Command failed', 2);
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  console.error(JSON.stringify({ error: { code: 'DEPENDENCY', message: 'Command failed' } }));
  process.exit(2);
});
