import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  hits: number;
}

export function rateLimitBucket(pepper: Buffer, dimension: string): string {
  return createHash('sha256').update(pepper).update('|').update(dimension).digest('hex');
}

export async function consumeRateLimit(
  pool: Pool,
  bucketKey: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitDecision> {
  const result = await pool.query<{ hit_count: number; window_start: Date }>(
    `WITH bucket_window AS (
       SELECT to_timestamp(floor(extract(epoch FROM now()) / $2::numeric) * $2::numeric) AS window_start
     )
     INSERT INTO rate_limit_buckets (bucket_key, window_start, hit_count)
     SELECT $1, bucket_window.window_start, 1 FROM bucket_window
     ON CONFLICT (bucket_key) DO UPDATE SET
       hit_count = CASE
         WHEN rate_limit_buckets.window_start = EXCLUDED.window_start THEN rate_limit_buckets.hit_count + 1
         ELSE 1
       END,
       window_start = EXCLUDED.window_start
     RETURNING hit_count, window_start`,
    [bucketKey, windowSeconds],
  );
  const row = result.rows[0];
  if (!row) throw new Error('rate limit write did not return a row');
  const windowStart = row.window_start instanceof Date ? row.window_start : new Date(row.window_start);
  const retryAfterSeconds = Math.max(1, Math.ceil((windowStart.getTime() + windowSeconds * 1000 - Date.now()) / 1000));
  return { allowed: row.hit_count <= limit, retryAfterSeconds, hits: row.hit_count };
}

let lastCleanup = 0;

export async function cleanupRateLimits(pool: Pool): Promise<void> {
  const now = Date.now();
  if (now - lastCleanup < 60_000) return;
  lastCleanup = now;
  await pool.query(`DELETE FROM rate_limit_buckets WHERE window_start < now() - interval '2 hours'`);
}
