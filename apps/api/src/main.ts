import { createPool, isDependencyError } from '@fad/db';
import { buildApp, assertRuntimeRole, migrationsMatch } from './app.js';
import { ConfigError, loadConfig } from './config.js';

export async function start(): Promise<void> {
  const config = loadConfig();
  const pool = createPool({
    connectionString: config.databaseUrl,
    max: config.poolMax,
    statementTimeoutMs: config.requestTimeoutMs,
    applicationName: 'fad-api',
    ssl: config.ssl,
  });
  pool.on('error', () => {
    /* An idle client dies when Postgres stops. The next query reports the outage. */
  });
  try {
    try {
      await assertRuntimeRole(pool);
    } catch (err) {
      if (err instanceof Error && !isDependencyError(err)) throw new ConfigError(err.message);
      throw err;
    }
    const ready = await migrationsMatch(pool, config.migrationsDir);
    if (!ready) throw new ConfigError('schema migration is missing or incompatible');
  } catch (err) {
    await pool.end().catch(() => undefined);
    if (isDependencyError(err)) throw new ConfigError('Database is unavailable');
    throw err;
  }
  const { app, markDraining } = await buildApp({ config, pool });
  let stopping = false;
  const shutdown = async (exitCode: number): Promise<void> => {
    if (stopping) return;
    stopping = true;
    markDraining();
    const timer = setTimeout(() => process.exit(1), config.shutdownGraceMs);
    timer.unref();
    try {
      await app.close();
      await pool.end();
      clearTimeout(timer);
      process.exit(exitCode);
    } catch {
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown(0));
  process.on('SIGINT', () => void shutdown(0));
  await app.listen({ port: config.port, host: config.bindHost });
  app.log.info({ port: config.port, bind: config.bindHost }, 'listening');
}
