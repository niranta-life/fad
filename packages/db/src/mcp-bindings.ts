import type { Pool } from 'pg';
import { isDependencyError } from './errors.js';
import { withTenant } from './tenant.js';

export const MCP_MIGRATION_VERSION = '20261023_001_mcp_identity_bindings';

export interface McpBindingLookup {
  organizationId: string;
  principalId: string;
  allowedScopes: string[];
  bindingStatus: string;
  bindingRevision: number;
}

export async function lookupMcpPrincipal(
  pool: Pool,
  issuer: string,
  subject: string,
  clientId: string,
): Promise<McpBindingLookup | null> {
  const result = await pool.query<{
    organization_id: string;
    principal_id: string;
    allowed_scopes: string[];
    binding_status: string;
    binding_revision: string | number;
  }>(
    `SELECT organization_id, principal_id, allowed_scopes, binding_status, binding_revision
     FROM fad_lookup_mcp_principal($1, $2, $3)`,
    [issuer, subject, clientId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    organizationId: row.organization_id,
    principalId: row.principal_id,
    allowedScopes: row.allowed_scopes,
    bindingStatus: row.binding_status,
    bindingRevision: typeof row.binding_revision === 'number' ? row.binding_revision : Number(row.binding_revision),
  };
}

export async function mcpTenantActive(
  pool: Pool,
  organizationId: string,
  principalId: string,
): Promise<'active' | 'inactive' | 'unavailable'> {
  try {
    return await withTenant(pool, organizationId, async (client) => {
      const result = await client.query<{ org_status: string; principal_status: string }>(
        `SELECT o.status AS org_status, p.status AS principal_status
         FROM organizations o
         JOIN principals p ON p.organization_id = o.id AND p.id = $2
         WHERE o.id = $1`,
        [organizationId, principalId],
      );
      const row = result.rows[0];
      if (!row || row.org_status !== 'active' || row.principal_status !== 'active') return 'inactive';
      return 'active';
    });
  } catch (error) {
    if (isDependencyError(error)) return 'unavailable';
    throw error;
  }
}
