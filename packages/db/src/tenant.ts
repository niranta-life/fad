import type { Pool, PoolClient } from 'pg';
import { isUuid } from '@fad/auth-core';
import { withTransaction } from './pool.js';

export function withTenant<T>(pool: Pool, organizationId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!isUuid(organizationId)) {
    throw new Error('invalid organization id');
  }
  return withTransaction(pool, fn, async (client) => {
    await client.query(`SELECT set_config('fad.org_id', $1, true)`, [organizationId]);
  });
}

export function withBootstrap<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withTransaction(
    pool,
    async (client) => {
      const who = await client.query<{ u: string }>('SELECT current_user AS u');
      const row = who.rows[0];
      if (!row || row.u !== 'fad_bootstrap') {
        throw new Error('bootstrap role is not active');
      }
      return fn(client);
    },
    async (client) => {
      await client.query('SET LOCAL ROLE fad_bootstrap');
    },
  );
}
