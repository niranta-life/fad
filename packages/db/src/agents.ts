import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { insertAudit } from './audit.js';
import {
  AgentServiceError,
  agentEtag,
  canonicalJson,
  decodeCursor,
  encodeCursor,
  nextStatus,
  parseCreateBody,
  parseLifecycleBody,
  parsePatchBody,
  type AgentPatchInput,
  type AgentStatus,
  type LifecycleAction,
} from './agent-rules.js';
import { beginIdempotency, requestFingerprint, writeIdempotency } from './idempotency.js';
import { withTenant } from './tenant.js';

const RETENTION_MS = 24 * 60 * 60 * 1000;
const AGENT_COLUMNS = `id, organization_id, name, description, owner_principal_id, status, revision,
  created_at, updated_at, created_by, updated_by`;
// Cursor bounds use the full timestamptz. A JavaScript Date drops microseconds.
const CREATED_AT_EXACT = `to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_exact`;

export interface AgentRecord {
  id: string;
  global_id: string;
  organization_id: string;
  name: string;
  description: string;
  owner_principal_id: string;
  status: AgentStatus;
  revision: number;
  created_at: string;
  updated_at: string;
  created_by: string;
  updated_by: string;
}

export interface AgentCommandResult {
  status: 200 | 201;
  agent: AgentRecord;
  etag: string;
  location?: string;
}

interface Actor {
  organizationId: string;
  principalId: string;
  requestId: string;
}

interface IdempotencyInput {
  key: string;
  ifMatch: string | null;
}

interface AgentRow {
  id: string;
  organization_id: string;
  name: string;
  description: string;
  owner_principal_id: string;
  status: AgentStatus;
  revision: string | number;
  created_at: Date | string;
  updated_at: Date | string;
  created_by: string;
  updated_by: string;
  created_at_exact?: string;
}

function asTime(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function asRevision(value: string | number): number {
  const revision = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('invalid revision');
  return revision;
}

function toAgent(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    global_id: `urn:fad:agent:${row.organization_id}:${row.id}`,
    organization_id: row.organization_id,
    name: row.name,
    description: row.description,
    owner_principal_id: row.owner_principal_id,
    status: row.status,
    revision: asRevision(row.revision),
    created_at: asTime(row.created_at),
    updated_at: asTime(row.updated_at),
    created_by: row.created_by,
    updated_by: row.updated_by,
  };
}

function commandResult(agent: AgentRecord, status: 200 | 201): AgentCommandResult {
  const result: AgentCommandResult = { status, agent, etag: agentEtag(agent.revision) };
  if (status === 201) result.location = `/v1/agents/${agent.id}`;
  return result;
}

async function lockPrincipal(client: PoolClient, organizationId: string, principalId: string): Promise<'active' | 'disabled' | 'missing'> {
  // fad_lock_principal takes FOR SHARE as fad_bootstrap. fad_app has no UPDATE on principals.
  const result = await client.query<{ status: string | null }>(
    'SELECT fad_lock_principal($1, $2) AS status',
    [organizationId, principalId],
  );
  const status = result.rows[0]?.status;
  if (!status) return 'missing';
  return status === 'active' ? 'active' : 'disabled';
}

async function requireActor(client: PoolClient, actor: Actor): Promise<void> {
  const status = await lockPrincipal(client, actor.organizationId, actor.principalId);
  if (status !== 'active') throw new AgentServiceError(401, 'UNAUTHORIZED');
}

async function requireOwner(client: PoolClient, organizationId: string, principalId: string): Promise<void> {
  const status = await lockPrincipal(client, organizationId, principalId);
  if (status !== 'active') throw new AgentServiceError(422, 'VALIDATION_ERROR');
}

async function readAgent(client: PoolClient, organizationId: string, agentId: string, lock: boolean): Promise<AgentRecord | null> {
  const result = await client.query<AgentRow>(
    `SELECT ${AGENT_COLUMNS} FROM agents WHERE organization_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`,
    [organizationId, agentId],
  );
  const row = result.rows[0];
  return row ? toAgent(row) : null;
}

function resultFromReplay(status: number, body: unknown, headers: Record<string, string>): AgentCommandResult {
  if ((status !== 200 && status !== 201) || body === null || typeof body !== 'object') {
    throw new Error('stored idempotency response is invalid');
  }
  const agent = body as AgentRecord;
  const result: AgentCommandResult = {
    status,
    agent,
    etag: headers.etag ?? agentEtag(agent.revision),
  };
  if (headers.location) result.location = headers.location;
  return result;
}

async function storeResult(
  client: PoolClient,
  actor: Actor,
  method: 'POST' | 'PATCH',
  resourcePath: string,
  idem: IdempotencyInput,
  fingerprintBody: unknown,
  result: AgentCommandResult,
): Promise<void> {
  const headers: Record<string, string> = { etag: result.etag };
  if (result.location) headers.location = result.location;
  await writeIdempotency(client, {
    organizationId: actor.organizationId,
    principalId: actor.principalId,
    method,
    resourcePath,
    idemKey: idem.key,
    requestSha256: requestFingerprint(method, resourcePath, canonicalJson({ body: fingerprintBody, if_match: idem.ifMatch })),
    responseStatus: result.status,
    responseHeaders: headers,
    responseBody: result.agent,
    expiresAt: new Date(Date.now() + RETENTION_MS),
  });
}

async function claimOrReplay(
  client: PoolClient,
  actor: Actor,
  method: 'POST' | 'PATCH',
  resourcePath: string,
  idem: IdempotencyInput,
  fingerprintBody: unknown,
): Promise<AgentCommandResult | null> {
  const claim = await beginIdempotency(client, {
    organizationId: actor.organizationId,
    principalId: actor.principalId,
    method,
    resourcePath,
    idemKey: idem.key,
    requestSha256: requestFingerprint(method, resourcePath, canonicalJson({ body: fingerprintBody, if_match: idem.ifMatch })),
  });
  if (claim.kind === 'replay') return resultFromReplay(claim.responseStatus, claim.responseBody, claim.responseHeaders);
  return null;
}

async function writeHistory(
  client: PoolClient,
  actor: Actor,
  agent: AgentRecord,
  operation: 'registered' | 'updated' | 'suspended' | 'activated' | 'retired',
  fromStatus: AgentStatus | null,
  reason: string | null,
  previousRevision: number | null,
): Promise<void> {
  await client.query(
    `INSERT INTO agent_revisions (
       organization_id, agent_id, revision, snapshot, operation, actor_principal_id
     ) VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
    [actor.organizationId, agent.id, agent.revision, JSON.stringify(agent), operation, actor.principalId],
  );
  if (fromStatus !== agent.status || operation === 'registered') {
    await client.query(
      `INSERT INTO agent_lifecycle_events (
         organization_id, id, agent_id, revision, from_status, to_status, reason, actor_principal_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [actor.organizationId, randomUUID(), agent.id, agent.revision, fromStatus, agent.status, reason, actor.principalId],
    );
  }
  await insertAudit(client, {
    organizationId: actor.organizationId,
    actorPrincipalId: actor.principalId,
    action: `agent.${operation}`,
    targetType: 'agent',
    targetId: agent.id,
    outcome: 'success',
    requestId: actor.requestId,
    details: {
      revision: agent.revision,
      previous_revision: previousRevision,
      status: agent.status,
      previous_status: fromStatus,
      request_id: actor.requestId,
    },
  });
}

export async function registerAgent(pool: Pool, actor: Actor, idempotencyKey: string, body: unknown): Promise<AgentCommandResult> {
  const input = parseCreateBody(body);
  const idem = { key: idempotencyKey, ifMatch: null };
  return withTenant(pool, actor.organizationId, async (client) => {
    await requireActor(client, actor);
    const replay = await claimOrReplay(client, actor, 'POST', '/v1/agents', idem, input);
    if (replay) return replay;
    await requireOwner(client, actor.organizationId, input.ownerPrincipalId);
    const inserted = await client.query<AgentRow>(
      `INSERT INTO agents (
         organization_id, id, name, description, owner_principal_id, status, revision, created_by, updated_by
       ) VALUES ($1, $2, $3, $4, $5, 'active', 1, $6, $6)
       RETURNING ${AGENT_COLUMNS}`,
      [actor.organizationId, randomUUID(), input.name, input.description, input.ownerPrincipalId, actor.principalId],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error('agent insert returned no row');
    const agent = toAgent(row);
    await writeHistory(client, actor, agent, 'registered', null, null, null);
    const result = commandResult(agent, 201);
    await storeResult(client, actor, 'POST', '/v1/agents', idem, input, result);
    return result;
  });
}

export async function getAgent(pool: Pool, organizationId: string, agentId: string): Promise<AgentRecord> {
  return withTenant(pool, organizationId, async (client) => {
    const agent = await readAgent(client, organizationId, agentId, false);
    if (!agent) throw new AgentServiceError(404, 'AGENT_NOT_FOUND');
    return agent;
  });
}

export async function listAgents(
  pool: Pool,
  organizationId: string,
  query: { status: AgentStatus | null; limit: number; cursor: string | null },
  pepper: Buffer,
  now = Date.now(),
): Promise<{ agents: AgentRecord[]; limit: number; nextCursor: string | null }> {
  const position = query.cursor ? decodeCursor(pepper, query.cursor, { org: organizationId, status: query.status }, now) : null;
  return withTenant(pool, organizationId, async (client) => {
    const result = await client.query<AgentRow>(
      `SELECT ${AGENT_COLUMNS}, ${CREATED_AT_EXACT}
       FROM agents
       WHERE organization_id = $1
         AND ($2::text IS NULL OR status = $2)
         AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
       ORDER BY created_at DESC, id DESC
       LIMIT $5`,
      [organizationId, query.status, position?.at ?? null, position?.id ?? null, query.limit + 1],
    );
    const page = result.rows.slice(0, query.limit).map((row) => toAgent(row));
    const more = result.rows.length > query.limit;
    const boundary = more ? result.rows[query.limit - 1] : undefined;
    const nextCursor = boundary?.created_at_exact
      ? encodeCursor(pepper, {
        org: organizationId,
        status: query.status,
        at: boundary.created_at_exact,
        id: boundary.id,
      }, now)
      : null;
    return { agents: page, limit: query.limit, nextCursor };
  });
}

async function lockAgent(client: PoolClient, actor: Actor, agentId: string, expectedRevision: number): Promise<AgentRecord> {
  await requireActor(client, actor);
  const agent = await readAgent(client, actor.organizationId, agentId, true);
  if (!agent) throw new AgentServiceError(404, 'AGENT_NOT_FOUND');
  if (agent.revision !== expectedRevision) throw new AgentServiceError(412, 'PRECONDITION_FAILED');
  return agent;
}

export async function updateAgent(
  pool: Pool,
  actor: Actor,
  agentId: string,
  idempotencyKey: string,
  ifMatch: string,
  body: unknown,
): Promise<AgentCommandResult> {
  const patch = parsePatchBody(body);
  const idem = { key: idempotencyKey, ifMatch };
  const resourcePath = `/v1/agents/${agentId}`;
  return withTenant(pool, actor.organizationId, async (client) => {
    await requireActor(client, actor);
    const replay = await claimOrReplay(client, actor, 'PATCH', resourcePath, idem, patch);
    if (replay) return replay;
    const expected = etagRevision(ifMatch);
    const current = await lockAgent(client, actor, agentId, expected);
    if (current.status === 'retired') throw new AgentServiceError(409, 'INVALID_STATE_TRANSITION');
    const next = applyPatch(current, patch);
    if (next.ownerPrincipalId !== current.owner_principal_id) {
      await requireOwner(client, actor.organizationId, next.ownerPrincipalId);
    }
    if (!next.changed) {
      const result = commandResult(current, 200);
      await storeResult(client, actor, 'PATCH', resourcePath, idem, patch, result);
      return result;
    }
    const updated = await client.query<AgentRow>(
      `UPDATE agents
       SET name = $3, description = $4, owner_principal_id = $5, revision = revision + 1,
           updated_at = transaction_timestamp(), updated_by = $6
       WHERE organization_id = $1 AND id = $2 AND revision = $7
       RETURNING ${AGENT_COLUMNS}`,
      [actor.organizationId, agentId, next.name, next.description, next.ownerPrincipalId, actor.principalId, current.revision],
    );
    const row = updated.rows[0];
    if (!row) throw new AgentServiceError(412, 'PRECONDITION_FAILED');
    const agent = toAgent(row);
    await writeHistory(client, actor, agent, 'updated', current.status, null, current.revision);
    const result = commandResult(agent, 200);
    await storeResult(client, actor, 'PATCH', resourcePath, idem, patch, result);
    return result;
  });
}

function etagRevision(ifMatch: string): number {
  const match = /^"agent-v([1-9][0-9]*)"$/.exec(ifMatch);
  if (!match?.[1]) throw new AgentServiceError(400, 'VALIDATION_ERROR');
  return Number(match[1]);
}

function applyPatch(current: AgentRecord, patch: AgentPatchInput): {
  changed: boolean;
  name: string;
  description: string;
  ownerPrincipalId: string;
} {
  const name = patch.name ?? current.name;
  const description = patch.description === undefined ? current.description : (patch.description ?? '');
  const ownerPrincipalId = patch.ownerPrincipalId ?? current.owner_principal_id;
  return {
    changed: name !== current.name || description !== current.description || ownerPrincipalId !== current.owner_principal_id,
    name,
    description,
    ownerPrincipalId,
  };
}

export async function transitionAgent(
  pool: Pool,
  actor: Actor,
  agentId: string,
  action: LifecycleAction,
  idempotencyKey: string,
  ifMatch: string,
  body: unknown,
): Promise<AgentCommandResult> {
  const reason = parseLifecycleBody(body);
  const idem = { key: idempotencyKey, ifMatch };
  const resourcePath = `/v1/agents/${agentId}/${action}`;
  const operation = action === 'suspend' ? 'suspended' : action === 'activate' ? 'activated' : 'retired';
  return withTenant(pool, actor.organizationId, async (client) => {
    await requireActor(client, actor);
    const replay = await claimOrReplay(client, actor, 'POST', resourcePath, idem, { reason, action });
    if (replay) return replay;
    const expected = etagRevision(ifMatch);
    const current = await lockAgent(client, actor, agentId, expected);
    const step = nextStatus(current.status, action);
    if (step.kind === 'conflict') throw new AgentServiceError(409, 'INVALID_STATE_TRANSITION');
    if (step.kind === 'noop') {
      const result = commandResult(current, 200);
      await storeResult(client, actor, 'POST', resourcePath, idem, { reason, action }, result);
      return result;
    }
    const updated = await client.query<AgentRow>(
      `UPDATE agents
       SET status = $3, revision = revision + 1, updated_at = transaction_timestamp(), updated_by = $4
       WHERE organization_id = $1 AND id = $2 AND revision = $5
       RETURNING ${AGENT_COLUMNS}`,
      [actor.organizationId, agentId, step.status, actor.principalId, current.revision],
    );
    const row = updated.rows[0];
    if (!row) throw new AgentServiceError(412, 'PRECONDITION_FAILED');
    const agent = toAgent(row);
    await writeHistory(client, actor, agent, operation, current.status, reason, current.revision);
    const result = commandResult(agent, 200);
    await storeResult(client, actor, 'POST', resourcePath, idem, { reason, action }, result);
    return result;
  });
}
