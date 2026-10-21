import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import {
  computeVerifier,
  credentialIsActive,
  hasScope,
  readCredentialHeader,
  verifiersMatch,
} from '@fad/auth-core';
import { isDependencyError, withTenant } from '@fad/db';

const DUMMY_VERIFIER = randomBytes(32);

export interface CurrentOrganization {
  id: string;
  name: string;
  status: 'active' | 'suspended';
  created_at: string;
}

export type CurrentOrganizationResult =
  | { kind: 'ok'; organization: CurrentOrganization }
  | { kind: 'unauthorized' }
  | { kind: 'forbidden' }
  | { kind: 'unavailable' };

export interface VerifiedCaller {
  organization: CurrentOrganization;
  principalId: string;
  scopes: string[];
}

export type VerifiedCredentialResult =
  | { kind: 'ok'; caller: VerifiedCaller }
  | { kind: 'unauthorized' }
  | { kind: 'unavailable' };

interface CredentialRow {
  organization_id: string;
  principal_id: string;
  verifier_hmac: Buffer;
  pepper_version: number;
  scopes: string[];
  credential_status: string;
  expires_at: Date | null;
  revoked_at: Date | null;
}

function unavailableError(err: unknown): boolean {
  if (isDependencyError(err)) return true;
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return code === '42P01' || code === '42883' || code === '42703';
  }
  return false;
}

function burn(pepper: Buffer, kid: string, secret: string, expected: Buffer): void {
  const actual = computeVerifier(pepper, kid, secret);
  verifiersMatch(expected, actual);
}

function asDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

export async function verifyCredential(
  pool: Pool,
  rawHeaders: readonly string[],
  pepper: Buffer,
  now = new Date(),
): Promise<VerifiedCredentialResult> {
  const header = readCredentialHeader(rawHeaders);
  if (!header.ok) {
    burn(pepper, '0'.repeat(32), 'A'.repeat(43), DUMMY_VERIFIER);
    return { kind: 'unauthorized' };
  }
  let rows: CredentialRow[];
  try {
    const result = await pool.query<CredentialRow>(
      `SELECT organization_id, principal_id, verifier_hmac, pepper_version, scopes,
              credential_status, expires_at, revoked_at
       FROM fad_lookup_api_credential($1)`,
      [header.parsed.kid],
    );
    rows = result.rows;
  } catch (err) {
    if (unavailableError(err)) return { kind: 'unavailable' };
    throw err;
  }
  const row = rows[0];
  const actual = computeVerifier(pepper, header.parsed.kid, header.parsed.secret);
  if (!row || !Buffer.isBuffer(row.verifier_hmac)) {
    verifiersMatch(DUMMY_VERIFIER, actual);
    return { kind: 'unauthorized' };
  }
  if (!verifiersMatch(row.verifier_hmac, actual)) return { kind: 'unauthorized' };
  const active = credentialIsActive(
    {
      status: row.credential_status,
      expiresAt: asDate(row.expires_at),
      revokedAt: asDate(row.revoked_at),
      pepperVersion: Number(row.pepper_version),
    },
    now,
    1,
  );
  if (!active) return { kind: 'unauthorized' };
  try {
    return await withTenant(pool, row.organization_id, async (client) => {
      const organization = await client.query<{ id: string; name: string; status: string; created_at: Date | string }>(
        `SELECT id, name, status, created_at FROM organizations WHERE id = $1`,
        [row.organization_id],
      );
      const principal = await client.query<{ status: string }>(
        `SELECT status FROM principals WHERE organization_id = $1 AND id = $2`,
        [row.organization_id, row.principal_id],
      );
      const org = organization.rows[0];
      const actor = principal.rows[0];
      if (!org || org.status !== 'active' || !actor || actor.status !== 'active') {
        return { kind: 'unauthorized' as const };
      }
      const created = org.created_at instanceof Date ? org.created_at : new Date(org.created_at);
      return {
        kind: 'ok' as const,
        caller: {
          organization: {
            id: org.id,
            name: org.name,
            status: 'active',
            created_at: created.toISOString(),
          },
          principalId: row.principal_id,
          scopes: row.scopes,
        },
      };
    });
  } catch (err) {
    if (unavailableError(err)) return { kind: 'unavailable' };
    throw err;
  }
}

export async function resolveCurrentOrganization(
  pool: Pool,
  rawHeaders: readonly string[],
  pepper: Buffer,
  now = new Date(),
): Promise<CurrentOrganizationResult> {
  const verified = await verifyCredential(pool, rawHeaders, pepper, now);
  if (verified.kind !== 'ok') return verified;
  if (!hasScope(verified.caller.scopes, 'organizations:read')) return { kind: 'forbidden' };
  return { kind: 'ok', organization: verified.caller.organization };
}
