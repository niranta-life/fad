import { randomUUID } from 'node:crypto';
import { computeVerifier, generateApiKey, isUuid, parseScopes, ScopeError } from '@fad/auth-core';
import { auditedMutation, createPool, withBootstrap } from '@fad/db';
import type { Pool, PoolClient } from 'pg';

export class AdminError extends Error {
  readonly exitCode: number;
  readonly code: string;

  constructor(code: string, message: string, exitCode = 1) {
    super(message);
    this.name = 'AdminError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

interface Flags {
  [key: string]: string[];
}

export interface ParsedCommand {
  path: string[];
  flags: Flags;
}

export function parseCommand(argv: string[]): ParsedCommand {
  const path: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;
    if (token === '--') continue;
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = (eq === -1 ? token.slice(2) : token.slice(2, eq)).trim();
      const inline = eq === -1 ? undefined : token.slice(eq + 1);
      const next = argv[i + 1];
      const value = inline !== undefined ? inline : (next !== undefined && !next.startsWith('--') ? argv[++i] : '');
      if (!name || value === undefined || value.length === 0) {
        throw new AdminError('INVALID_ARGUMENT', `Missing value for --${name || 'flag'}`);
      }
      const list = flags[name] ?? [];
      list.push(value);
      flags[name] = list;
    } else {
      path.push(token);
    }
  }
  return { path, flags };
}

function flag(flags: Flags, name: string): string {
  const value = flags[name]?.[0];
  if (!value) throw new AdminError('INVALID_ARGUMENT', `Missing --${name}`);
  return value;
}

function optional(flags: Flags, name: string): string | undefined {
  return flags[name]?.[0];
}

function uuidFlag(flags: Flags, name: string): string {
  const value = flag(flags, name);
  if (!isUuid(value)) throw new AdminError('INVALID_ARGUMENT', `Invalid --${name}`);
  return value;
}

function nameFlag(flags: Flags, name: string): string {
  const value = flag(flags, name).trim();
  if (value.length < 1 || value.length > 160) throw new AdminError('INVALID_ARGUMENT', `Invalid --${name}`);
  return value;
}

function scopesFlag(flags: Flags): string[] {
  const raw = flags.scopes ?? [];
  const parts = raw.flatMap((item) => item.split(',')).map((item) => item.trim()).filter((item) => item.length > 0);
  try {
    return parseScopes(parts);
  } catch (err) {
    if (err instanceof ScopeError) throw new AdminError('INVALID_SCOPE', err.message);
    throw err;
  }
}

async function organizationExists(client: PoolClient, organizationId: string): Promise<boolean> {
  const result = await client.query('SELECT 1 FROM organizations WHERE id = $1', [organizationId]);
  return (result.rowCount ?? 0) > 0;
}

export async function execute(pool: Pool, command: ParsedCommand, pepper: Buffer): Promise<unknown> {
  const [group, action] = command.path;
  if (group === 'organization' && action === 'create') return createOrganization(pool, command.flags);
  if (group === 'organization' && action === 'suspend') return suspendOrganization(pool, command.flags);
  if (group === 'principal' && action === 'create') return createPrincipal(pool, command.flags);
  if (group === 'principal' && action === 'disable') return disablePrincipal(pool, command.flags);
  if (group === 'credential' && action === 'issue') return issueCredential(pool, command.flags, pepper);
  if (group === 'credential' && action === 'revoke') return revokeCredential(pool, command.flags);
  if (group === 'credential' && action === 'list') return listCredentials(pool, command.flags);
  if (group === 'mcp' && action === 'bind') return bindMcpPrincipal(pool, command.flags);
  if (group === 'mcp' && action === 'disable') return disableMcpBinding(pool, command.flags);
  throw new AdminError('INVALID_ARGUMENT', 'Unknown command');
}

async function createOrganization(pool: Pool, flags: Flags): Promise<unknown> {
  const name = nameFlag(flags, 'name');
  const id = randomUUID();
  return withBootstrap(pool, async (client) => {
    let created: { id: string; name: string; status: string; created_at: Date } | undefined;
    await auditedMutation(client, {
      organizationId: id,
      actorPrincipalId: null,
      action: 'organization.create',
      targetType: 'organization',
      targetId: id,
      outcome: 'success',
      details: { name },
      mutate: async (tx) => {
        const result = await tx.query<{ id: string; name: string; status: string; created_at: Date }>(
          `INSERT INTO organizations (id, name) VALUES ($1, $2) RETURNING id, name, status, created_at`,
          [id, name],
        );
        created = result.rows[0];
      },
    });
    if (!created) throw new AdminError('DEPENDENCY', 'Organization was not created', 2);
    return { id: created.id, name: created.name, status: created.status, created_at: created.created_at.toISOString() };
  });
}

async function suspendOrganization(pool: Pool, flags: Flags): Promise<unknown> {
  const organizationId = uuidFlag(flags, 'organization-id');
  const reason = nameFlag(flags, 'reason');
  return withBootstrap(pool, async (client) => {
    if (!(await organizationExists(client, organizationId))) throw new AdminError('NOT_FOUND', 'Organization not found');
    await auditedMutation(client, {
      organizationId,
      actorPrincipalId: null,
      action: 'organization.suspend',
      targetType: 'organization',
      targetId: organizationId,
      outcome: 'success',
      details: { reason },
      mutate: async (tx) => {
        const result = await tx.query(
          `UPDATE organizations SET status = 'suspended', updated_at = transaction_timestamp() WHERE id = $1 AND status = 'active'`,
          [organizationId],
        );
        if ((result.rowCount ?? 0) === 0) throw new AdminError('NOT_FOUND', 'Organization is not active');
      },
    });
    return { id: organizationId, status: 'suspended' };
  });
}

async function createPrincipal(pool: Pool, flags: Flags): Promise<unknown> {
  const organizationId = uuidFlag(flags, 'organization-id');
  const type = flag(flags, 'type');
  if (type !== 'service') throw new AdminError('INVALID_ARGUMENT', 'Only service principals can be created');
  const name = nameFlag(flags, 'name');
  const id = randomUUID();
  return withBootstrap(pool, async (client) => {
    if (!(await organizationExists(client, organizationId))) throw new AdminError('NOT_FOUND', 'Organization not found');
    await auditedMutation(client, {
      organizationId,
      actorPrincipalId: null,
      action: 'principal.create',
      targetType: 'principal',
      targetId: id,
      outcome: 'success',
      details: { display_name: name, principal_type: type },
      mutate: async (tx) => {
        await tx.query(
          `INSERT INTO principals (organization_id, id, display_name, principal_type) VALUES ($1, $2, $3, 'service')`,
          [organizationId, id, name],
        );
      },
    });
    return { id, organization_id: organizationId, display_name: name, principal_type: 'service', status: 'active' };
  });
}

async function disablePrincipal(pool: Pool, flags: Flags): Promise<unknown> {
  const organizationId = uuidFlag(flags, 'organization-id');
  const principalId = uuidFlag(flags, 'principal-id');
  const reason = nameFlag(flags, 'reason');
  return withBootstrap(pool, async (client) => {
    await auditedMutation(client, {
      organizationId,
      actorPrincipalId: null,
      action: 'principal.disable',
      targetType: 'principal',
      targetId: principalId,
      outcome: 'success',
      details: { reason },
      mutate: async (tx) => {
        const result = await tx.query(
          `UPDATE principals SET status = 'disabled', updated_at = transaction_timestamp()
           WHERE organization_id = $1 AND id = $2 AND status = 'active'`,
          [organizationId, principalId],
        );
        if ((result.rowCount ?? 0) === 0) throw new AdminError('NOT_FOUND', 'Principal not found');
      },
    });
    return { id: principalId, organization_id: organizationId, status: 'disabled' };
  });
}

async function issueCredential(pool: Pool, flags: Flags, pepper: Buffer): Promise<unknown> {
  const organizationId = uuidFlag(flags, 'organization-id');
  const principalId = uuidFlag(flags, 'principal-id');
  const scopes = scopesFlag(flags);
  const expires = optional(flags, 'expires-at');
  let expiresAt: Date | null = null;
  if (expires) {
    expiresAt = new Date(expires);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now() + 1000) {
      throw new AdminError('INVALID_ARGUMENT', 'expires-at must be in the future');
    }
  }
  const key = generateApiKey();
  const verifier = computeVerifier(pepper, key.kid, key.secret);
  const id = randomUUID();
  const record = await withBootstrap(pool, async (client) => {
    const principal = await client.query<{ organization_id: string; status: string }>(
      `SELECT organization_id, status FROM principals WHERE organization_id = $1 AND id = $2`,
      [organizationId, principalId],
    );
    if ((principal.rowCount ?? 0) === 0) {
      const elsewhere = await client.query('SELECT 1 FROM principals WHERE id = $1 AND organization_id <> $2', [principalId, organizationId]);
      if ((elsewhere.rowCount ?? 0) > 0) throw new AdminError('CROSS_TENANT', 'Principal does not belong to the organization');
      throw new AdminError('NOT_FOUND', 'Principal not found');
    }
    await auditedMutation(client, {
      organizationId,
      actorPrincipalId: principalId,
      action: 'credential.issue',
      targetType: 'api_credential',
      targetId: key.kid,
      outcome: 'success',
      details: { kid: key.kid, scopes, pepper_version: 1 },
      mutate: async (tx) => {
        await tx.query(
          `INSERT INTO api_credentials (
             organization_id, id, kid, principal_id, verifier_hmac, pepper_version, scopes, expires_at
           ) VALUES ($1, $2, $3, $4, $5, 1, $6, $7)`,
          [organizationId, id, key.kid, principalId, verifier, scopes, expiresAt],
        );
      },
    });
    return { credential_id: id };
  });
  return {
    organization_id: organizationId,
    principal_id: principalId,
    credential_id: record.credential_id,
    kid: key.kid,
    api_key: key.token,
    scopes,
    status: 'active',
    expires_at: expiresAt ? expiresAt.toISOString() : null,
  };
}

async function revokeCredential(pool: Pool, flags: Flags): Promise<unknown> {
  const organizationId = uuidFlag(flags, 'organization-id');
  const kid = flag(flags, 'kid');
  if (!/^[0-9a-f]{32}$/.test(kid)) throw new AdminError('INVALID_ARGUMENT', 'Invalid --kid');
  const reason = nameFlag(flags, 'reason');
  return withBootstrap(pool, async (client) => {
    const existing = await client.query<{ status: string }>(
      `SELECT status FROM api_credentials WHERE organization_id = $1 AND kid = $2`,
      [organizationId, kid],
    );
    const row = existing.rows[0];
    if (!row) throw new AdminError('NOT_FOUND', 'Credential not found');
    if (row.status === 'revoked') {
      await auditedMutation(client, {
        organizationId,
        actorPrincipalId: null,
        action: 'credential.revoke',
        targetType: 'api_credential',
        targetId: kid,
        outcome: 'success',
        details: { kid, reason, already_revoked: true },
        mutate: async () => undefined,
      });
      return { kid, status: 'revoked', already_revoked: true };
    }
    await auditedMutation(client, {
      organizationId,
      actorPrincipalId: null,
      action: 'credential.revoke',
      targetType: 'api_credential',
      targetId: kid,
      outcome: 'success',
      details: { kid, reason },
      mutate: async (tx) => {
        const result = await tx.query(
          `UPDATE api_credentials
           SET status = 'revoked', revoked_at = transaction_timestamp()
           WHERE organization_id = $1 AND kid = $2 AND status = 'active'`,
          [organizationId, kid],
        );
        if ((result.rowCount ?? 0) === 0) throw new AdminError('NOT_FOUND', 'Credential not found');
      },
    });
    return { kid, status: 'revoked' };
  });
}

async function listCredentials(pool: Pool, flags: Flags): Promise<unknown> {
  const organizationId = uuidFlag(flags, 'organization-id');
  return withBootstrap(pool, async (client) => {
    if (!(await organizationExists(client, organizationId))) throw new AdminError('NOT_FOUND', 'Organization not found');
    const result = await client.query<{
      kid: string;
      principal_id: string;
      scopes: string[];
      status: string;
      created_at: Date;
      expires_at: Date | null;
      revoked_at: Date | null;
    }>(
      `SELECT kid, principal_id, scopes, status, created_at, expires_at, revoked_at
       FROM api_credentials WHERE organization_id = $1 ORDER BY created_at DESC, kid ASC`,
      [organizationId],
    );
    return {
      organization_id: organizationId,
      credentials: result.rows.map((row) => ({
        kid: row.kid,
        principal_id: row.principal_id,
        scopes: row.scopes,
        status: row.status,
        created_at: row.created_at.toISOString(),
        expires_at: row.expires_at ? row.expires_at.toISOString() : null,
        revoked_at: row.revoked_at ? row.revoked_at.toISOString() : null,
      })),
    };
  });
}

function issuerFlag(flags: Flags): string {
  const value = flag(flags, 'issuer');
  if (value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new AdminError('INVALID_ARGUMENT', 'Invalid --issuer');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AdminError('INVALID_ARGUMENT', 'Invalid --issuer');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new AdminError('INVALID_ARGUMENT', 'Invalid --issuer');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new AdminError('INVALID_ARGUMENT', 'Invalid --issuer');
  }
  return value;
}

function boundedFlag(flags: Flags, name: string, max: number): string {
  const value = flag(flags, name);
  if (value.trim().length < 1 || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new AdminError('INVALID_ARGUMENT', `Invalid --${name}`);
  }
  return value;
}

async function bindMcpPrincipal(pool: Pool, flags: Flags): Promise<unknown> {
  const organizationId = uuidFlag(flags, 'organization-id');
  const principalId = uuidFlag(flags, 'principal-id');
  const issuer = issuerFlag(flags);
  const subject = boundedFlag(flags, 'subject', 512);
  const clientId = boundedFlag(flags, 'client-id', 256);
  const scopes = scopesFlag(flags);
  if (scopes.length > 64) throw new AdminError('INVALID_ARGUMENT', 'Too many scopes');
  const id = randomUUID();
  return withBootstrap(pool, async (client) => {
    const principal = await client.query(
      `SELECT 1 FROM principals WHERE organization_id = $1 AND id = $2`,
      [organizationId, principalId],
    );
    if ((principal.rowCount ?? 0) === 0) {
      const elsewhere = await client.query('SELECT 1 FROM principals WHERE id = $1 AND organization_id <> $2', [principalId, organizationId]);
      if ((elsewhere.rowCount ?? 0) > 0) throw new AdminError('CROSS_TENANT', 'Principal does not belong to the organization');
      throw new AdminError('NOT_FOUND', 'Principal not found');
    }
    let created: { id: string; organization_id: string; principal_id: string; status: string; revision: string | number } | undefined;
    await auditedMutation(client, {
      organizationId,
      actorPrincipalId: principalId,
      action: 'mcp.binding.create',
      targetType: 'mcp_principal_binding',
      targetId: id,
      outcome: 'success',
      details: { scopes },
      mutate: async (tx) => {
        try {
          const result = await tx.query<{ id: string; organization_id: string; principal_id: string; status: string; revision: string | number }>(
            `INSERT INTO mcp_principal_bindings (
               id, organization_id, principal_id, oauth_issuer, oauth_subject, oauth_client_id,
               allowed_scopes, status, created_by, updated_by
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $3, $3)
             RETURNING id, organization_id, principal_id, status, revision`,
            [id, organizationId, principalId, issuer, subject, clientId, scopes],
          );
          created = result.rows[0];
        } catch (err) {
          const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code?: unknown }).code) : '';
          if (code === '23505') throw new AdminError('CONFLICT', 'The identity is already bound');
          throw err;
        }
      },
    });
    if (!created) throw new AdminError('DEPENDENCY', 'Binding was not created', 2);
    return {
      id: created.id,
      organization_id: created.organization_id,
      principal_id: created.principal_id,
      status: created.status,
      revision: Number(created.revision),
    };
  });
}

async function disableMcpBinding(pool: Pool, flags: Flags): Promise<unknown> {
  const bindingId = optional(flags, 'binding-id');
  const issuer = flags.issuer ? issuerFlag(flags) : undefined;
  const subject = flags.subject ? boundedFlag(flags, 'subject', 512) : undefined;
  const clientId = flags['client-id'] ? boundedFlag(flags, 'client-id', 256) : undefined;
  if (bindingId && !isUuid(bindingId)) throw new AdminError('INVALID_ARGUMENT', 'Invalid --binding-id');
  if (!bindingId && !(issuer && subject && clientId)) {
    throw new AdminError('INVALID_ARGUMENT', 'Provide --binding-id or --issuer, --subject, and --client-id');
  }
  return withBootstrap(pool, async (client) => {
    const existing = await client.query<{
      id: string;
      organization_id: string;
      principal_id: string;
      status: string;
      revision: string | number;
    }>(
      bindingId
        ? `SELECT id, organization_id, principal_id, status, revision FROM mcp_principal_bindings WHERE id = $1`
        : `SELECT id, organization_id, principal_id, status, revision
           FROM mcp_principal_bindings
           WHERE oauth_issuer = $1 AND oauth_subject = $2 AND oauth_client_id = $3`,
      bindingId ? [bindingId] : [issuer, subject, clientId],
    );
    const row = existing.rows[0];
    if (!row) throw new AdminError('NOT_FOUND', 'Binding not found');
    if (row.status === 'disabled') {
      return {
        id: row.id,
        organization_id: row.organization_id,
        principal_id: row.principal_id,
        status: 'disabled',
        revision: Number(row.revision),
      };
    }
    let updated: { id: string; organization_id: string; principal_id: string; status: string; revision: string | number } | undefined;
    await auditedMutation(client, {
      organizationId: row.organization_id,
      actorPrincipalId: row.principal_id,
      action: 'mcp.binding.disable',
      targetType: 'mcp_principal_binding',
      targetId: row.id,
      outcome: 'success',
      details: {},
      mutate: async (tx) => {
        const result = await tx.query<{ id: string; organization_id: string; principal_id: string; status: string; revision: string | number }>(
          `UPDATE mcp_principal_bindings
           SET status = 'disabled', disabled_at = transaction_timestamp(), updated_at = transaction_timestamp(),
               updated_by = $2, revision = revision + 1
           WHERE id = $1 AND status = 'active'
           RETURNING id, organization_id, principal_id, status, revision`,
          [row.id, row.principal_id],
        );
        updated = result.rows[0];
        if (!updated) throw new AdminError('NOT_FOUND', 'Binding not found');
      },
    });
    if (!updated) throw new AdminError('NOT_FOUND', 'Binding not found');
    return {
      id: updated.id,
      organization_id: updated.organization_id,
      principal_id: updated.principal_id,
      status: updated.status,
      revision: Number(updated.revision),
    };
  });
}

export function openAdminPool(connectionString: string): Pool {
  return createPool({
    connectionString,
    max: 2,
    statementTimeoutMs: 10_000,
    applicationName: 'fad-admin',
  });
}
