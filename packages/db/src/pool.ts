import pg from 'pg';
import type { Pool, PoolClient, PoolConfig } from 'pg';

const { Pool: PgPool } = pg;

export interface CreatePoolOptions {
  connectionString: string;
  max: number;
  statementTimeoutMs: number;
  applicationName: string;
  ssl?: false | { rejectUnauthorized: boolean };
}

export function createPool(options: CreatePoolOptions): Pool {
  const config: PoolConfig = {
    connectionString: options.connectionString,
    max: options.max,
    application_name: options.applicationName,
    statement_timeout: options.statementTimeoutMs,
    query_timeout: options.statementTimeoutMs,
    idle_in_transaction_session_timeout: options.statementTimeoutMs,
    connectionTimeoutMillis: Math.min(options.statementTimeoutMs, 5000),
  };
  if (options.ssl) config.ssl = options.ssl;
  return new PgPool(config);
}

export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  setup?: (client: PoolClient) => Promise<void>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (setup) await setup(client);
    const value = await fn(client);
    await client.query('COMMIT');
    return value;
  } catch (err) {
    const commitDenial = typeof err === 'object' && err !== null && (err as { commitBeforeThrow?: boolean }).commitBeforeThrow === true;
    if (commitDenial) {
      try {
        await client.query('COMMIT');
        throw err;
      } catch (commitError) {
        if (commitError === err) throw err;
        try {
          await client.query('ROLLBACK');
        } catch {
          /* The transaction may already be aborted. */
        }
        throw commitError;
      }
    }
    try {
      await client.query('ROLLBACK');
    } catch {
      /* The transaction may already be aborted. */
    }
    throw err;
  } finally {
    client.release();
  }
}
