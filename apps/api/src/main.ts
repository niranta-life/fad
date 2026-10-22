import { createPool, isDependencyError } from '@fad/db';
import { assertMcpBindingPrivileges, assertRuntimeRole, buildApp, migrationsMatch } from './app.js';
import { ConfigError, loadConfig } from './config.js';

export async function start(): Promise<void> {
  const config = loadConfig();
  const pool = createPool({
    connectionString: config.databaseUrl,
    max: config.poolMax,
    statementTimeoutMs: config.requestTimeoutMs,
    applicationName: `fad-api-${process.pid}`,
    ssl: config.ssl,
  });
  pool.on('error', () => {
    /* An idle client dies when Postgres stops. The next query reports the outage. */
  });
  pool.on('connect', (client) => {
    client.on('error', () => {
      /* A checked-out client has no pool listener. The query promise reports the failure. */
    });
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
    try {
      await assertMcpBindingPrivileges(pool);
    } catch (err) {
      if (err instanceof Error && !isDependencyError(err)) throw new ConfigError(err.message);
      throw err;
    }
  } catch (err) {
    await pool.end().catch(() => undefined);
    if (isDependencyError(err)) throw new ConfigError('Database is unavailable');
    throw err;
  }
  const { app, markDraining } = await buildApp({ config, pool });
  let stopping = false;
  const applicationName = `fad-api-${process.pid}`;
  const shutdown = async (exitCode: number): Promise<void> => {
    if (stopping) return;
    stopping = true;
    markDraining();
    const timer = setTimeout(() => process.exit(1), config.shutdownGraceMs);
    timer.unref();
    try {
      // Drop this process's open transactions before the listener drains.
      // Waiting for an in-flight write would commit it during shutdown.
      // The terminated backends roll back. Close and pool shutdown can throw
      // after those sockets die, and that must not change the exit result.
      await pool.query(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE application_name = $1
            AND pid <> pg_backend_pid()
            AND state <> 'idle'`,
        [applicationName],
      ).catch(() => undefined);
      await finishWithin(2000, app.close());
      await finishWithin(2000, pool.end());
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

function finishWithin(ms: number, work: Promise<unknown>): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    work.then(() => {
      clearTimeout(timer);
      resolve();
    }, () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
