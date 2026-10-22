import type { Pool, PoolClient } from 'pg';
import { hasScope } from '@fad/auth-core';
import { insertAudit } from './audit.js';
import { appendDirectoryEvent } from './event-outbox.js';
import { canonicalJson, type AgentStatus } from './agent-rules.js';
import { beginIdempotency, requestFingerprint, writeIdempotency, IdempotencyConflictError } from './idempotency.js';
import {
  decodeDefinitionCursor,
  decodeSearchCursor,
  encodeDefinitionCursor,
  encodeSearchCursor,
  requireChangeReason,
  sameTagValue,
  searchFilterKey,
  tagEtag,
  validateTagValue,
  type TagDefinitionInput,
  type TagPredicate,
  type TagPutInput,
  type TagSearchInput,
  type TagType,
  type TagValue,
  type TagVisibility,
  TagServiceError,
} from './tag-rules.js';
import {
  EnforcementServiceError,
  authorizeCandidate,
  beginExclusive,
  beginShared,
  decodeEnforcementCursor,
  encodeEnforcementCursor,
  enforceAgent,
  enforcementScanLimit,
  guardReferencedTag,
  loadEvalContext,
  type EnforcementCaller,
} from './enforcement.js';
import { withTenant } from './tenant.js';

const RETENTION_MS = 24 * 60 * 60 * 1000;
const AGENT_COLUMNS = `agents.id, agents.organization_id, agents.name, agents.description, agents.owner_principal_id,
  agents.status, agents.revision, agents.created_at, agents.updated_at, agents.created_by, agents.updated_by`;
const CREATED_AT_EXACT = `to_char(agents.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_exact`;

export interface TagActor {
  organizationId: string;
  principalId: string;
  requestId: string;
  scopes: readonly string[];
  channel?: 'rest' | 'mcp';
}

function tagCaller(actor: TagActor): EnforcementCaller {
  return {
    organizationId: actor.organizationId,
    principalId: actor.principalId,
    requestId: actor.requestId,
    scopes: actor.scopes,
    channel: actor.channel,
  };
}

export interface TagLimits {
  maxDefinitions: number;
  maxPerAgent: number;
}

export interface TagDefinitionRecord {
  organization_id: string;
  namespace: string;
  key: string;
  value_type: TagType;
  enum_values: string[] | null;
  governed: boolean;
  visibility: TagVisibility;
  description: string;
  created_by: string;
  created_at: string;
}

export interface TagAssignmentRecord {
  agent_id: string;
  namespace: string;
  key: string;
  value: TagValue;
  revision: number;
  governed: boolean;
  visibility: TagVisibility;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface TagWriteResult {
  status: 200 | 201 | 204;
  definition?: TagDefinitionRecord;
  assignment?: TagAssignmentRecord;
  etag?: string;
  location?: string;
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

interface DefinitionRow {
  organization_id: string;
  namespace: string;
  tag_key: string;
  value_type: TagType;
  enum_values: string[] | null;
  governed: boolean;
  visibility: TagVisibility;
  description: string;
  created_by: string;
  created_at: Date | string;
}

interface AssignmentRow {
  agent_id: string;
  namespace: string;
  tag_key: string;
  tag_value: TagValue | null;
  is_deleted: boolean;
  revision: string | number;
  governed: boolean;
  visibility: TagVisibility;
  created_by: string;
  updated_by: string;
  created_at: Date | string;
  updated_at: Date | string;
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

function toDefinition(row: DefinitionRow): TagDefinitionRecord {
  return {
    organization_id: row.organization_id,
    namespace: row.namespace,
    key: row.tag_key,
    value_type: row.value_type,
    enum_values: row.enum_values,
    governed: row.governed,
    visibility: row.visibility,
    description: row.description,
    created_by: row.created_by,
    created_at: asTime(row.created_at),
  };
}

function toAssignment(row: AssignmentRow): TagAssignmentRecord {
  if (row.tag_value === null || row.is_deleted) throw new Error('inactive assignment');
  return {
    agent_id: row.agent_id,
    namespace: row.namespace,
    key: row.tag_key,
    value: row.tag_value,
    revision: asRevision(row.revision),
    governed: row.governed,
    visibility: row.visibility,
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: asTime(row.created_at),
    updated_at: asTime(row.updated_at),
  };
}

function toAgent(row: AgentRow) {
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

function pgCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function mapWriteError(err: unknown): never {
  const code = pgCode(err);
  if (code === '23505') throw new TagServiceError(409, 'TAG_DEFINITION_EXISTS');
  if (code === '23514') throw new TagServiceError(422, 'VALIDATION_ERROR');
  if (code === '23503') throw new TagServiceError(404, 'TAG_DEFINITION_NOT_FOUND');
  throw err;
}

async function requireActor(client: PoolClient, actor: TagActor): Promise<void> {
  const result = await client.query<{ status: string | null }>(
    'SELECT fad_lock_principal($1, $2) AS status',
    [actor.organizationId, actor.principalId],
  );
  if (result.rows[0]?.status !== 'active') throw new TagServiceError(401, 'UNAUTHORIZED');
}

function fingerprint(method: string, path: string, body: unknown, headers: Record<string, string | null>): Buffer {
  return requestFingerprint(method, path, canonicalJson({ body, ...headers }));
}

async function claim(
  client: PoolClient,
  actor: TagActor,
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  key: string,
  body: unknown,
  headers: Record<string, string | null>,
): Promise<TagWriteResult | null> {
  const claimResult = await beginIdempotency(client, {
    organizationId: actor.organizationId,
    principalId: actor.principalId,
    method,
    resourcePath: path,
    idemKey: key,
    requestSha256: fingerprint(method, path, body, headers),
  });
  if (claimResult.kind !== 'replay') return null;
  if (claimResult.responseStatus === 204) return { status: 204 };
  const stored = claimResult.responseBody;
  if (stored === null || typeof stored !== 'object') throw new Error('stored idempotency response is invalid');
  const etag = claimResult.responseHeaders.etag;
  const location = claimResult.responseHeaders.location;
  if (method === 'POST') {
    return {
      status: 201,
      definition: stored as TagDefinitionRecord,
      ...(location ? { location } : {}),
    };
  }
  return {
    status: claimResult.responseStatus === 201 ? 201 : 200,
    assignment: stored as TagAssignmentRecord,
    ...(etag ? { etag } : {}),
    ...(location ? { location } : {}),
  };
}

async function store(
  client: PoolClient,
  actor: TagActor,
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  key: string,
  body: unknown,
  headers: Record<string, string | null>,
  result: TagWriteResult,
): Promise<void> {
  const responseHeaders: Record<string, string> = {};
  if (result.etag) responseHeaders.etag = result.etag;
  if (result.location) responseHeaders.location = result.location;
  await writeIdempotency(client, {
    organizationId: actor.organizationId,
    principalId: actor.principalId,
    method,
    resourcePath: path,
    idemKey: key,
    requestSha256: fingerprint(method, path, body, headers),
    responseStatus: result.status,
    responseHeaders,
    responseBody: result.definition ?? result.assignment ?? null,
    expiresAt: new Date(Date.now() + RETENTION_MS),
  });
}

async function lockOrganization(client: PoolClient, organizationId: string): Promise<void> {
  const result = await client.query<{ locked: boolean | null }>(
    'SELECT fad_lock_organization($1) AS locked',
    [organizationId],
  );
  if (result.rows[0]?.locked !== true) throw new TagServiceError(401, 'UNAUTHORIZED');
}

const DEFINITION_SQL = `organization_id, namespace, tag_key, value_type, enum_values, governed, visibility,
  description, created_by, created_at`;

async function readDefinition(client: PoolClient, organizationId: string, namespace: string, key: string): Promise<TagDefinitionRecord | null> {
  const result = await client.query<DefinitionRow>(
    `SELECT ${DEFINITION_SQL} FROM tag_definitions
     WHERE organization_id = $1 AND namespace = $2 AND tag_key = $3`,
    [organizationId, namespace, key],
  );
  const row = result.rows[0];
  return row ? toDefinition(row) : null;
}

function visible(definition: { visibility: TagVisibility }, scopes: readonly string[]): boolean {
  return definition.visibility !== 'restricted' || hasScope(scopes, 'tags:restricted:read');
}

function canGovern(scopes: readonly string[]): boolean {
  return hasScope(scopes, 'tags:governance');
}

export async function createTagDefinition(
  pool: Pool,
  actor: TagActor,
  idempotencyKey: string,
  input: TagDefinitionInput,
  limits: TagLimits,
): Promise<TagWriteResult> {
  const path = '/v1/tag-definitions';
  const headers = { if_match: null, if_none_match: null, change_reason: null };
  return withTenant(pool, actor.organizationId, async (client) => {
    await requireActor(client, actor);
    if ((input.governed || input.visibility === 'restricted') && !canGovern(actor.scopes)) {
      throw new TagServiceError(403, 'FORBIDDEN');
    }
    const replay = await claim(client, actor, 'POST', path, idempotencyKey, input, headers);
    if (replay) return replay;
    await lockOrganization(client, actor.organizationId);
    const count = await client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM tag_definitions WHERE organization_id = $1',
      [actor.organizationId],
    );
    if ((count.rows[0]?.n ?? 0) >= limits.maxDefinitions) throw new TagServiceError(422, 'VALIDATION_ERROR');
    try {
      const inserted = await client.query<DefinitionRow>(
        `INSERT INTO tag_definitions (
           organization_id, namespace, tag_key, value_type, enum_values, governed, visibility, description, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING ${DEFINITION_SQL}`,
        [
          actor.organizationId,
          input.namespace,
          input.key,
          input.valueType,
          input.enumValues,
          input.governed,
          input.visibility,
          input.description,
          actor.principalId,
        ],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('tag definition insert returned no row');
      const definition = toDefinition(row);
      await insertAudit(client, {
        organizationId: actor.organizationId,
        actorPrincipalId: actor.principalId,
        action: 'tag_definition.created',
        targetType: 'tag_definition',
        targetId: `${definition.namespace}/${definition.key}`,
        outcome: 'success',
        requestId: actor.requestId,
        details: {
          namespace: definition.namespace,
          key: definition.key,
          value_type: definition.value_type,
          governed: definition.governed,
          visibility: definition.visibility,
          request_id: actor.requestId,
        },
      });
      await appendDirectoryEvent(client, {
        organizationId: actor.organizationId,
        eventType: 'com.fad.tag.definition_created.v1',
        subject: `tag/${definition.namespace}/${definition.key}`,
        aggregateType: 'tag_definition',
        aggregateId: null,
        aggregateRevision: null,
        visibility: definition.governed || definition.visibility === 'restricted' ? 'restricted' : 'standard',
        payload: { namespace: definition.namespace, key: definition.key, change: 'upserted' },
        requestId: actor.requestId,
      });
      const result: TagWriteResult = {
        status: 201,
        definition,
        location: `/v1/tag-definitions/${definition.namespace}/${definition.key}`,
      };
      await store(client, actor, 'POST', path, idempotencyKey, input, headers, result);
      return result;
    } catch (err) {
      if (err instanceof TagServiceError || err instanceof IdempotencyConflictError) throw err;
      mapWriteError(err);
    }
  });
}

export async function getTagDefinition(
  pool: Pool,
  actor: TagActor,
  namespace: string,
  key: string,
): Promise<TagDefinitionRecord> {
  return withTenant(pool, actor.organizationId, async (client) => {
    const definition = await readDefinition(client, actor.organizationId, namespace, key);
    if (!definition || !visible(definition, actor.scopes)) throw new TagServiceError(404, 'TAG_DEFINITION_NOT_FOUND');
    return definition;
  });
}

export async function listTagDefinitions(
  pool: Pool,
  actor: TagActor,
  query: { namespace: string | null; limit: number; cursor: string | null },
  pepper: Buffer,
  now = Date.now(),
): Promise<{ definitions: TagDefinitionRecord[]; limit: number; nextCursor: string | null }> {
  const restricted = hasScope(actor.scopes, 'tags:restricted:read');
  const position = query.cursor
    ? decodeDefinitionCursor(pepper, query.cursor, {
      org: actor.organizationId,
      namespace: query.namespace,
      restricted,
    }, now)
    : null;
  return withTenant(pool, actor.organizationId, async (client) => {
    const result = await client.query<DefinitionRow>(
      `SELECT ${DEFINITION_SQL} FROM tag_definitions
       WHERE organization_id = $1
         AND ($2::text IS NULL OR namespace = $2)
         AND (visibility = 'internal' OR $3::boolean)
         AND (
           $4::text IS NULL
           OR namespace > $4
           OR (namespace = $4 AND tag_key > $5)
         )
       ORDER BY namespace ASC, tag_key ASC
       LIMIT $6`,
      [actor.organizationId, query.namespace, restricted, position?.ns ?? null, position?.key ?? null, query.limit + 1],
    );
    const page = result.rows.slice(0, query.limit).map((row) => toDefinition(row));
    const boundary = result.rows.length > query.limit ? page[page.length - 1] : undefined;
    const nextCursor = boundary
      ? encodeDefinitionCursor(pepper, {
        org: actor.organizationId,
        namespace: query.namespace,
        restricted,
        ns: boundary.namespace,
        key: boundary.key,
      }, now)
      : null;
    return { definitions: page, limit: query.limit, nextCursor };
  });
}

const ASSIGNMENT_SQL = `a.agent_id, a.namespace, a.tag_key, a.tag_value, a.is_deleted, a.revision,
  d.governed, d.visibility, a.created_by, a.updated_by, a.created_at, a.updated_at`;

async function readAssignment(
  client: PoolClient,
  organizationId: string,
  agentId: string,
  namespace: string,
  key: string,
  lock: boolean,
): Promise<AssignmentRow | null> {
  const result = await client.query<AssignmentRow>(
    `SELECT ${ASSIGNMENT_SQL}
     FROM agent_tag_assignments a
     JOIN tag_definitions d
       ON d.organization_id = a.organization_id
      AND d.namespace = a.namespace
      AND d.tag_key = a.tag_key
     WHERE a.organization_id = $1 AND a.agent_id = $2 AND a.namespace = $3 AND a.tag_key = $4
     ${lock ? 'FOR UPDATE OF a' : ''}`,
    [organizationId, agentId, namespace, key],
  );
  return result.rows[0] ?? null;
}

async function lockAgent(client: PoolClient, organizationId: string, agentId: string): Promise<{ id: string; status: AgentStatus; revision: number } | null> {
  const result = await client.query<{ id: string; status: AgentStatus; revision: string | number }>(
    'SELECT id, status, revision FROM agents WHERE organization_id = $1 AND id = $2 FOR UPDATE',
    [organizationId, agentId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, status: row.status, revision: asRevision(row.revision) };
}

async function writeAssignmentHistory(
  client: PoolClient,
  actor: TagActor,
  row: TagAssignmentRecord,
  operation: 'assigned' | 'updated' | 'deleted',
  previous: TagValue | null,
  next: TagValue | null,
  previousRevision: number | null,
  reason: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO agent_tag_assignment_revisions (
       organization_id, agent_id, namespace, tag_key, revision, operation,
       previous_value, new_value, actor_principal_id, reason
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)`,
    [
      actor.organizationId,
      row.agent_id,
      row.namespace,
      row.key,
      row.revision,
      operation,
      previous === null ? null : JSON.stringify(previous),
      next === null ? null : JSON.stringify(next),
      actor.principalId,
      reason,
    ],
  );
  await insertAudit(client, {
    organizationId: actor.organizationId,
    actorPrincipalId: actor.principalId,
    action: `agent_tag.${operation}`,
    targetType: 'agent_tag',
    targetId: `${row.agent_id}/${row.namespace}/${row.key}`,
    outcome: 'success',
    requestId: actor.requestId,
    details: {
      namespace: row.namespace,
      key: row.key,
      revision: row.revision,
      previous_revision: previousRevision,
      governed: row.governed,
      visibility: row.visibility,
      reason,
      request_id: actor.requestId,
    },
  });
}

function assignmentPath(agentId: string, namespace: string, key: string): string {
  return `/v1/agents/${agentId}/tags/${namespace}/${key}`;
}

export async function putAgentTag(
  pool: Pool,
  actor: TagActor,
  agentId: string,
  namespace: string,
  key: string,
  idempotencyKey: string,
  precondition: { kind: 'match'; revision: number } | { kind: 'none' },
  input: TagPutInput,
  limits: TagLimits,
): Promise<TagWriteResult> {
  const path = assignmentPath(agentId, namespace, key);
  const headers = {
    if_match: precondition.kind === 'match' ? tagEtag(precondition.revision) : null,
    if_none_match: precondition.kind === 'none' ? '*' : null,
    change_reason: input.reason,
  };
  return withTenant(pool, actor.organizationId, async (client) => {
    await beginExclusive(client, actor.organizationId);
    await requireActor(client, actor);
    const definition = await readDefinition(client, actor.organizationId, namespace, key);
    if (!definition) throw new TagServiceError(404, 'TAG_DEFINITION_NOT_FOUND');
    if ((definition.governed || definition.visibility === 'restricted') && !canGovern(actor.scopes)) {
      throw new TagServiceError(403, 'FORBIDDEN');
    }
    await guardReferencedTag(client, tagCaller(actor), namespace, key);
    const replay = await claim(client, actor, 'PUT', path, idempotencyKey, input, headers);
    if (replay) {
      await enforceAgent(client, tagCaller(actor), 'putAgentTag', agentId, 'write');
      return replay;
    }
    await enforceAgent(client, tagCaller(actor), 'putAgentTag', agentId, 'write');
    const agent = await lockAgent(client, actor.organizationId, agentId);
    if (!agent) throw new TagServiceError(404, 'AGENT_NOT_FOUND');
    if (agent.status === 'retired') throw new TagServiceError(409, 'INVALID_AGENT_STATE');
    const value = validateTagValue(
      { valueType: definition.value_type, enumValues: definition.enum_values },
      input.value,
    );
    const reason = definition.governed ? requireChangeReason(input.reason) : input.reason;
    const current = await readAssignment(client, actor.organizationId, agentId, namespace, key, true);
    const active = current !== null && !current.is_deleted && current.tag_value !== null;
    if (precondition.kind === 'match') {
      if (!active || !current) throw new TagServiceError(412, 'PRECONDITION_FAILED');
      if (asRevision(current.revision) !== precondition.revision) throw new TagServiceError(412, 'PRECONDITION_FAILED');
      const existing = toAssignment(current);
      if (sameTagValue(existing.value, value)) {
        const result: TagWriteResult = { status: 200, assignment: existing, etag: tagEtag(existing.revision) };
        await store(client, actor, 'PUT', path, idempotencyKey, input, headers, result);
        return result;
      }
      const revision = existing.revision + 1;
      const updated = await client.query<AssignmentRow>(
        `UPDATE agent_tag_assignments a
         SET tag_value = $5::jsonb, revision = $6, updated_by = $7, updated_at = transaction_timestamp()
         FROM tag_definitions d
         WHERE a.organization_id = d.organization_id AND a.namespace = d.namespace AND a.tag_key = d.tag_key
           AND a.organization_id = $1 AND a.agent_id = $2 AND a.namespace = $3 AND a.tag_key = $4
         RETURNING ${ASSIGNMENT_SQL}`,
        [actor.organizationId, agentId, namespace, key, JSON.stringify(value), revision, actor.principalId],
      );
      const row = updated.rows[0];
      if (!row) throw new Error('tag update returned no row');
      const assignment = toAssignment(row);
      await writeAssignmentHistory(client, actor, assignment, 'updated', existing.value, value, existing.revision, reason);
      await appendDirectoryEvent(client, {
        organizationId: actor.organizationId,
        eventType: 'com.fad.tag.assignment_changed.v1',
        subject: `agent/${agentId}/tag/${namespace}/${key}`,
        aggregateType: 'tag_assignment',
        aggregateId: agentId,
        aggregateRevision: assignment.revision,
        visibility: definition.governed || definition.visibility === 'restricted' ? 'restricted' : 'standard',
        payload: { agent_id: agentId, namespace, key, revision: assignment.revision, change: 'assigned' },
        requestId: actor.requestId,
      });
      const result: TagWriteResult = { status: 200, assignment, etag: tagEtag(assignment.revision) };
      await store(client, actor, 'PUT', path, idempotencyKey, input, headers, result);
      return result;
    }
    if (active) throw new TagServiceError(412, 'PRECONDITION_FAILED');
    const counted = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM agent_tag_assignments
       WHERE organization_id = $1 AND agent_id = $2 AND is_deleted = false`,
      [actor.organizationId, agentId],
    );
    if ((counted.rows[0]?.n ?? 0) >= limits.maxPerAgent) throw new TagServiceError(422, 'VALIDATION_ERROR');
    let assignment: TagAssignmentRecord;
    let previousRevision: number | null = null;
    if (!current) {
      const inserted = await client.query<AssignmentRow>(
        `INSERT INTO agent_tag_assignments (
           organization_id, agent_id, namespace, tag_key, tag_value, is_deleted, revision, created_by, updated_by
         ) VALUES ($1, $2, $3, $4, $5::jsonb, false, 1, $6, $6)
         RETURNING agent_id, namespace, tag_key, tag_value, is_deleted, revision, created_by, updated_by, created_at, updated_at`,
        [actor.organizationId, agentId, namespace, key, JSON.stringify(value), actor.principalId],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('tag insert returned no row');
      assignment = toAssignment({ ...row, governed: definition.governed, visibility: definition.visibility });
    } else {
      previousRevision = asRevision(current.revision);
      const revived = await client.query<AssignmentRow>(
        `UPDATE agent_tag_assignments
         SET tag_value = $5::jsonb, is_deleted = false, revision = revision + 1,
             updated_by = $6, updated_at = transaction_timestamp()
         WHERE organization_id = $1 AND agent_id = $2 AND namespace = $3 AND tag_key = $4
         RETURNING agent_id, namespace, tag_key, tag_value, is_deleted, revision, created_by, updated_by, created_at, updated_at`,
        [actor.organizationId, agentId, namespace, key, JSON.stringify(value), actor.principalId],
      );
      const row = revived.rows[0];
      if (!row) throw new Error('tag revive returned no row');
      assignment = toAssignment({ ...row, governed: definition.governed, visibility: definition.visibility });
    }
    await writeAssignmentHistory(client, actor, assignment, 'assigned', null, value, previousRevision, reason);
    await appendDirectoryEvent(client, {
      organizationId: actor.organizationId,
      eventType: 'com.fad.tag.assignment_changed.v1',
      subject: `agent/${agentId}/tag/${namespace}/${key}`,
      aggregateType: 'tag_assignment',
      aggregateId: agentId,
      aggregateRevision: assignment.revision,
      visibility: definition.governed || definition.visibility === 'restricted' ? 'restricted' : 'standard',
      payload: { agent_id: agentId, namespace, key, revision: assignment.revision, change: 'assigned' },
      requestId: actor.requestId,
    });
    const result: TagWriteResult = {
      status: 201,
      assignment,
      etag: tagEtag(assignment.revision),
      location: path,
    };
    await store(client, actor, 'PUT', path, idempotencyKey, input, headers, result);
    return result;
  });
}

export async function deleteAgentTag(
  pool: Pool,
  actor: TagActor,
  agentId: string,
  namespace: string,
  key: string,
  idempotencyKey: string,
  revision: number,
  changeReason: string | null,
): Promise<TagWriteResult> {
  const path = assignmentPath(agentId, namespace, key);
  const headers = { if_match: tagEtag(revision), if_none_match: null, change_reason: changeReason };
  return withTenant(pool, actor.organizationId, async (client) => {
    await beginExclusive(client, actor.organizationId);
    await requireActor(client, actor);
    const definition = await readDefinition(client, actor.organizationId, namespace, key);
    if (!definition) throw new TagServiceError(404, 'TAG_ASSIGNMENT_NOT_FOUND');
    if ((definition.governed || definition.visibility === 'restricted') && !canGovern(actor.scopes)) {
      throw new TagServiceError(403, 'FORBIDDEN');
    }
    await guardReferencedTag(client, tagCaller(actor), namespace, key);
    const replay = await claim(client, actor, 'DELETE', path, idempotencyKey, null, headers);
    if (replay) {
      await enforceAgent(client, tagCaller(actor), 'deleteAgentTag', agentId, 'write');
      return replay;
    }
    await enforceAgent(client, tagCaller(actor), 'deleteAgentTag', agentId, 'write');
    const reason = definition.governed ? requireChangeReason(changeReason) : changeReason;
    const agent = await lockAgent(client, actor.organizationId, agentId);
    if (!agent) throw new TagServiceError(404, 'AGENT_NOT_FOUND');
    if (agent.status === 'retired') throw new TagServiceError(409, 'INVALID_AGENT_STATE');
    const current = await readAssignment(client, actor.organizationId, agentId, namespace, key, true);
    if (!current || current.is_deleted || current.tag_value === null) {
      throw new TagServiceError(404, 'TAG_ASSIGNMENT_NOT_FOUND');
    }
    if (asRevision(current.revision) !== revision) throw new TagServiceError(412, 'PRECONDITION_FAILED');
    const existing = toAssignment(current);
    const removed = await client.query<AssignmentRow>(
      `UPDATE agent_tag_assignments
       SET tag_value = NULL, is_deleted = true, revision = revision + 1,
           updated_by = $5, updated_at = transaction_timestamp()
       WHERE organization_id = $1 AND agent_id = $2 AND namespace = $3 AND tag_key = $4
       RETURNING agent_id, namespace, tag_key, tag_value, is_deleted, revision, created_by, updated_by, created_at, updated_at`,
      [actor.organizationId, agentId, namespace, key, actor.principalId],
    );
    const row = removed.rows[0];
    if (!row) throw new Error('tag delete returned no row');
    const tombstone: TagAssignmentRecord = {
      ...existing,
      revision: asRevision(row.revision),
      updated_by: row.updated_by,
      updated_at: asTime(row.updated_at),
    };
    await writeAssignmentHistory(client, actor, tombstone, 'deleted', existing.value, null, existing.revision, reason);
    await appendDirectoryEvent(client, {
      organizationId: actor.organizationId,
      eventType: 'com.fad.tag.assignment_changed.v1',
      subject: `agent/${agentId}/tag/${namespace}/${key}`,
      aggregateType: 'tag_assignment',
      aggregateId: agentId,
      aggregateRevision: tombstone.revision,
      visibility: definition.governed || definition.visibility === 'restricted' ? 'restricted' : 'standard',
      payload: { agent_id: agentId, namespace, key, revision: tombstone.revision, change: 'removed' },
      requestId: actor.requestId,
    });
    const result: TagWriteResult = { status: 204 };
    await store(client, actor, 'DELETE', path, idempotencyKey, null, headers, result);
    return result;
  });
}

export async function getAgentTag(
  pool: Pool,
  actor: TagActor,
  agentId: string,
  namespace: string,
  key: string,
): Promise<{ assignment: TagAssignmentRecord; etag: string }> {
  return withTenant(pool, actor.organizationId, async (client) => {
    await beginShared(client, actor.organizationId);
    await enforceAgent(client, tagCaller(actor), 'getAgentTag', agentId, 'read');
    const agent = await client.query<{ id: string }>(
      'SELECT id FROM agents WHERE organization_id = $1 AND id = $2',
      [actor.organizationId, agentId],
    );
    if (!agent.rows[0]) throw new TagServiceError(404, 'AGENT_NOT_FOUND');
    const current = await readAssignment(client, actor.organizationId, agentId, namespace, key, false);
    if (!current || current.is_deleted || current.tag_value === null || !visible(current, actor.scopes)) {
      throw new TagServiceError(404, 'TAG_ASSIGNMENT_NOT_FOUND');
    }
    const assignment = toAssignment(current);
    return { assignment, etag: tagEtag(assignment.revision) };
  });
}

export async function listAgentTags(
  pool: Pool,
  actor: TagActor,
  agentId: string,
): Promise<TagAssignmentRecord[]> {
  return withTenant(pool, actor.organizationId, async (client) => {
    await beginShared(client, actor.organizationId);
    await enforceAgent(client, tagCaller(actor), 'listAgentTags', agentId, 'read');
    const agent = await client.query<{ id: string }>(
      'SELECT id FROM agents WHERE organization_id = $1 AND id = $2',
      [actor.organizationId, agentId],
    );
    if (!agent.rows[0]) throw new TagServiceError(404, 'AGENT_NOT_FOUND');
    const restricted = hasScope(actor.scopes, 'tags:restricted:read');
    const result = await client.query<AssignmentRow>(
      `SELECT ${ASSIGNMENT_SQL}
       FROM agent_tag_assignments a
       JOIN tag_definitions d
         ON d.organization_id = a.organization_id
        AND d.namespace = a.namespace
        AND d.tag_key = a.tag_key
       WHERE a.organization_id = $1 AND a.agent_id = $2 AND a.is_deleted = false
         AND (d.visibility = 'internal' OR $3::boolean)
       ORDER BY a.namespace ASC, a.tag_key ASC`,
      [actor.organizationId, agentId, restricted],
    );
    return result.rows.map((row) => toAssignment(row));
  });
}

export function buildAgentSearchQuery(input: {
  organizationId: string;
  status: AgentStatus | null;
  predicates: TagPredicate[];
  cursor: { at: string; id: string } | null;
  limit: number;
}): { text: string; values: unknown[] } {
  const values: unknown[] = [input.organizationId, input.status];
  const cursorAt = input.cursor?.at ?? null;
  const cursorId = input.cursor?.id ?? null;
  const cursorSql = (at: number, id: number) =>
    `AND ($${at}::timestamptz IS NULL OR (agents.created_at, agents.id) < ($${at}::timestamptz, $${id}::uuid))`;
  if (input.predicates.length === 0) {
    const at = values.push(cursorAt);
    const id = values.push(cursorId);
    const limit = values.push(input.limit + 1);
    return {
      text: `SELECT ${AGENT_COLUMNS}, ${CREATED_AT_EXACT}
       FROM agents
       WHERE agents.organization_id = $1
         AND ($2::text IS NULL OR agents.status = $2)
         ${cursorSql(at, id)}
       ORDER BY agents.created_at DESC, agents.id DESC
       LIMIT $${limit}`,
      values,
    };
  }
  const [first, ...rest] = input.predicates;
  if (!first) throw new Error('tag search predicate is missing');
  const ns = values.push(first.namespace);
  const key = values.push(first.key);
  const value = values.push(JSON.stringify(first.value));
  const exists = rest.map((predicate) => {
    const extraNs = values.push(predicate.namespace);
    const extraKey = values.push(predicate.key);
    const extraValue = values.push(JSON.stringify(predicate.value));
    return `EXISTS (
      SELECT 1 FROM agent_tag_assignments extra_tag
      WHERE extra_tag.organization_id = agents.organization_id
        AND extra_tag.agent_id = agents.id
        AND extra_tag.namespace = $${extraNs}::varchar
        AND extra_tag.tag_key = $${extraKey}::varchar
        AND extra_tag.tag_value = $${extraValue}::jsonb
        AND extra_tag.is_deleted = false
    )`;
  });
  const at = values.push(cursorAt);
  const id = values.push(cursorId);
  const limit = values.push(input.limit + 1);
  const extra = exists.length > 0 ? `AND ${exists.join('\n         AND ')}` : '';
  // MATERIALIZED stops the planner from turning tag equality into a per-agent probe.
  return {
    text: `WITH matched AS MATERIALIZED (
         SELECT match_tag.agent_id
         FROM agent_tag_assignments match_tag
         WHERE match_tag.organization_id = $1
           AND match_tag.namespace = $${ns}::varchar
           AND match_tag.tag_key = $${key}::varchar
           AND match_tag.tag_value = $${value}::jsonb
           AND match_tag.is_deleted = false
       )
       SELECT ${AGENT_COLUMNS}, ${CREATED_AT_EXACT}
       FROM matched
       JOIN agents
         ON agents.organization_id = $1
        AND agents.id = matched.agent_id
       WHERE ($2::text IS NULL OR agents.status = $2)
         ${extra}
         ${cursorSql(at, id)}
       ORDER BY agents.created_at DESC, agents.id DESC
       LIMIT $${limit}`,
    values,
  };
}

export async function searchAgents(
  pool: Pool,
  actor: TagActor,
  query: TagSearchInput,
  pepper: Buffer,
  now = Date.now(),
): Promise<{ agents: ReturnType<typeof toAgent>[]; limit: number; nextCursor: string | null }> {
  const restricted = hasScope(actor.scopes, 'tags:restricted:read');
  const filter = searchFilterKey(query);
  return withTenant(pool, actor.organizationId, async (client) => {
    await beginShared(client, actor.organizationId);
    const loaded = [];
    for (const predicate of query.tags ?? []) {
      const definition = await readDefinition(client, actor.organizationId, predicate.namespace, predicate.key);
      loaded.push({ predicate, definition });
    }
    if (loaded.some((item) => item.definition?.visibility === 'restricted' && !restricted)) {
      throw new TagServiceError(403, 'FORBIDDEN');
    }
    const predicates: TagPredicate[] = [];
    for (const item of loaded) {
      if (!item.definition) throw new TagServiceError(422, 'VALIDATION_ERROR');
      predicates.push({
        ...item.predicate,
        value: validateTagValue(
          { valueType: item.definition.value_type, enumValues: item.definition.enum_values },
          item.predicate.value,
        ),
      });
    }
    const caller = tagCaller(actor);
    const context = await loadEvalContext(client, caller, 'searchAgentsByTags');
    const runQuery = async (position: { at: string; id: string } | null, limit: number) => {
      const built = buildAgentSearchQuery({
        organizationId: actor.organizationId,
        status: query.status,
        predicates,
        cursor: position,
        limit,
      });
      const result = await client.query<AgentRow>(built.text, built.values);
      return result.rows;
    };
    if (!context || context.mode !== 'enforce') {
      const cursor = query.cursor
        ? decodeSearchCursor(pepper, query.cursor, { org: actor.organizationId, filter, restricted }, now)
        : null;
      const rows = await runQuery(cursor, query.limit);
      const page = rows.slice(0, query.limit).map((row) => toAgent(row));
      if (context) {
        for (const agent of page) {
          await authorizeCandidate(client, caller, context, 'searchAgentsByTags', {
            id: agent.id,
            status: agent.status,
            revision: agent.revision,
          });
        }
      }
      const boundary = rows.length > query.limit ? rows[query.limit - 1] : undefined;
      const nextCursor = boundary?.created_at_exact
        ? encodeSearchCursor(pepper, {
          org: actor.organizationId,
          filter,
          restricted,
          at: boundary.created_at_exact,
          id: boundary.id,
        }, now)
        : null;
      return { agents: page, limit: query.limit, nextCursor };
    }
    const enfFilter = `search:${filter}:restricted:${restricted ? '1' : '0'}`;
    const start = query.cursor
      ? decodeEnforcementCursor(pepper, query.cursor, {
        org: actor.organizationId,
        principal: actor.principalId,
        filter: enfFilter,
        mode: 'enforce',
        revision: context.revision,
        operation: 'searchAgentsByTags',
      }, now)
      : null;
    const budget = enforcementScanLimit();
    const page: ReturnType<typeof toAgent>[] = [];
    let at = start?.at ?? null;
    let id = start?.id ?? null;
    let scanned = 0;
    let more = false;
    while (page.length < query.limit && scanned < budget) {
      const room = Math.min(100, budget - scanned);
      const rows = await runQuery(at && id ? { at, id } : null, room);
      if (rows.length === 0) {
        more = false;
        break;
      }
      let index = 0;
      while (index < rows.length && index < room && page.length < query.limit && scanned < budget) {
        const row = rows[index];
        if (!row?.created_at_exact) throw new EnforcementServiceError(503, 'DEPENDENCY_UNAVAILABLE');
        scanned += 1;
        at = row.created_at_exact;
        id = row.id;
        const agent = toAgent(row);
        const allowed = await authorizeCandidate(client, caller, context, 'searchAgentsByTags', {
          id: agent.id,
          status: agent.status,
          revision: agent.revision,
        });
        if (allowed) page.push(agent);
        index += 1;
      }
      more = index < rows.length;
      if (!more || page.length >= query.limit) break;
    }
    if (more && page.length < query.limit) throw new EnforcementServiceError(503, 'ENFORCEMENT_SCAN_BUDGET_EXCEEDED');
    const nextCursor = more && at && id
      ? encodeEnforcementCursor(pepper, {
        org: actor.organizationId,
        principal: actor.principalId,
        filter: enfFilter,
        mode: 'enforce',
        revision: context.revision,
        operation: 'searchAgentsByTags',
        at,
        id,
      }, now)
      : null;
    return { agents: page, limit: query.limit, nextCursor };
  });
}
