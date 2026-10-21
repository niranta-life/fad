import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';

export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor() {
    super('Idempotency key was reused with a different request');
    this.name = 'IdempotencyConflictError';
  }
}

export interface IdempotencyWrite {
  organizationId: string;
  principalId: string;
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  resourcePath: string;
  idemKey: string;
  requestSha256: Buffer;
  responseStatus: number;
  responseHeaders: Record<string, string>;
  responseBody: unknown;
  expiresAt: Date;
}

export interface IdempotencyResult {
  replay: boolean;
  responseStatus: number;
  responseBody: unknown;
}

export function requestFingerprint(method: string, resourcePath: string, body: unknown): Buffer {
  const canonical = JSON.stringify({ method, resourcePath, body });
  return createHash('sha256').update(canonical).digest();
}

export async function writeIdempotency(client: PoolClient, input: IdempotencyWrite): Promise<IdempotencyResult> {
  const inserted = await client.query<{ response_status: number; response_body: unknown }>(
    `INSERT INTO idempotency_records (
       organization_id, principal_id, method, resource_path, idem_key,
       request_sha256, response_status, response_headers, response_body, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10)
     ON CONFLICT (organization_id, principal_id, method, resource_path, idem_key) DO NOTHING
     RETURNING response_status, response_body`,
    [
      input.organizationId,
      input.principalId,
      input.method,
      input.resourcePath,
      input.idemKey,
      input.requestSha256,
      input.responseStatus,
      JSON.stringify(input.responseHeaders),
      JSON.stringify(input.responseBody),
      input.expiresAt,
    ],
  );
  const created = inserted.rows[0];
  if (created) {
    return { replay: false, responseStatus: created.response_status, responseBody: created.response_body };
  }
  const existing = await client.query<{ request_sha256: Buffer; response_status: number; response_body: unknown }>(
    `SELECT request_sha256, response_status, response_body
     FROM idempotency_records
     WHERE organization_id = $1 AND principal_id = $2 AND method = $3 AND resource_path = $4 AND idem_key = $5`,
    [input.organizationId, input.principalId, input.method, input.resourcePath, input.idemKey],
  );
  const row = existing.rows[0];
  if (!row || !Buffer.isBuffer(row.request_sha256) || !row.request_sha256.equals(input.requestSha256)) {
    throw new IdempotencyConflictError();
  }
  return { replay: true, responseStatus: row.response_status, responseBody: row.response_body };
}

export async function deleteExpiredIdempotency(client: PoolClient, now = new Date()): Promise<number> {
  const result = await client.query('DELETE FROM idempotency_records WHERE expires_at < $1', [now]);
  return result.rowCount ?? 0;
}
