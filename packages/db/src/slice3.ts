import type { Pool, PoolClient } from 'pg';
import { hasScope } from '@fad/auth-core';
import { insertAudit } from './audit.js';
import { appendDirectoryEvent } from './event-outbox.js';
import { canonicalJson } from './agent-rules.js';
import { beginIdempotency, requestFingerprint, writeIdempotency } from './idempotency.js';
import { validateTagValue, type TagType } from './tag-rules.js';
import {
  EnforcementServiceError,
  authorizeCandidate,
  beginShared,
  decodeEnforcementCursor,
  encodeEnforcementCursor,
  enforceAgent,
  enforcementScanLimit,
  loadEvalContext,
  type EnforcementCaller,
} from './enforcement.js';
import { withTenant } from './tenant.js';
import {
  Slice3ServiceError,
  catalogFilterKey,
  contractSha256,
  decodeCatalogCursor,
  decodeDiscoveryCursor,
  discoveryFilterKey,
  encodeCatalogCursor,
  encodeDiscoveryCursor,
  sameBinding,
  sameEndpoint,
  scopeFingerprint,
  type BindingPutInput,
  type CapabilityPublishInput,
  type DiscoveryInput,
  type DiscoveryTag,
  type EndpointPutInput,
  type CatalogQuery,
} from './slice3-rules.js';

const RETENTION_MS = 24 * 60 * 60 * 1000;
const ENDPOINT_ETAG = /^"endpoint-v([1-9][0-9]*)"$/;
const BINDING_ETAG = /^"cap-binding-v([1-9][0-9]*)"$/;

export interface Slice3Actor {
  organizationId: string;
  principalId: string;
  requestId: string;
  scopes: readonly string[];
  channel?: 'rest' | 'mcp';
}

function sliceCaller(actor: Slice3Actor): EnforcementCaller {
  return {
    organizationId: actor.organizationId,
    principalId: actor.principalId,
    requestId: actor.requestId,
    scopes: actor.scopes,
    channel: actor.channel,
  };
}

export interface Slice3Limits {
  maxEndpoints: number;
  maxBindings: number;
  discoveryTimeoutMs: number;
}

export interface CapabilityRecord {
  id: string;
  version: string;
  organization_id: string;
  display_name: string;
  description: string;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  contract_sha256: string;
  verification: 'self_declared';
  published_by: string;
  published_at: string;
}

export interface EndpointRecord {
  agent_id: string;
  key: string;
  protocol: string;
  url: string;
  auth_scheme: string;
  enabled: boolean;
  revision: number;
  verification: 'self_declared';
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface BindingRecord {
  agent_id: string;
  capability_id: string;
  version: string;
  endpoint_key: string;
  revision: number;
  verification: 'self_declared';
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface DiscoveryMatch {
  agent: {
    id: string;
    global_id: string;
    organization_id: string;
    name: string;
    description: string;
    owner_principal_id: string;
    status: string;
    revision: number;
    created_at: string;
    updated_at: string;
    created_by: string;
    updated_by: string;
  };
  capability: { id: string; version: string; verification: 'self_declared' };
  binding: BindingRecord;
  endpoint: EndpointRecord;
  invocation_authorization: 'not_evaluated';
  availability: 'not_checked';
}

type WriteKind = 'capability' | 'endpoint' | 'binding';

export interface WriteResult {
  status: 200 | 201 | 204;
  capability?: CapabilityRecord;
  endpoint?: EndpointRecord;
  binding?: BindingRecord;
  etag?: string;
  location?: string;
}

interface EndpointRow {
  agent_id: string;
  endpoint_key: string;
  protocol: string;
  url: string;
  auth_scheme: string;
  enabled: boolean;
  is_deleted: boolean;
  revision: string | number;
  created_by: string;
  updated_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface BindingRow {
  agent_id: string;
  capability_id: string;
  version: string;
  endpoint_key: string;
  is_deleted: boolean;
  revision: string | number;
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

function pgCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function endpointEtag(revision: number): string {
  return `"endpoint-v${revision}"`;
}

function bindingEtag(revision: number): string {
  return `"cap-binding-v${revision}"`;
}

function toEndpoint(row: EndpointRow): EndpointRecord {
  return {
    agent_id: row.agent_id,
    key: row.endpoint_key,
    protocol: row.protocol,
    url: row.url,
    auth_scheme: row.auth_scheme,
    enabled: row.enabled,
    revision: asRevision(row.revision),
    verification: 'self_declared',
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: asTime(row.created_at),
    updated_at: asTime(row.updated_at),
  };
}

function toBinding(row: BindingRow): BindingRecord {
  return {
    agent_id: row.agent_id,
    capability_id: row.capability_id,
    version: row.version,
    endpoint_key: row.endpoint_key,
    revision: asRevision(row.revision),
    verification: 'self_declared',
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: asTime(row.created_at),
    updated_at: asTime(row.updated_at),
  };
}

function endpointSnapshot(row: EndpointRow): Record<string, unknown> {
  return {
    protocol: row.protocol,
    url: row.url,
    auth_scheme: row.auth_scheme,
    enabled: row.enabled,
    is_deleted: row.is_deleted,
    revision: asRevision(row.revision),
  };
}

function bindingSnapshot(row: BindingRow): Record<string, unknown> {
  return {
    version: row.version,
    endpoint_key: row.endpoint_key,
    is_deleted: row.is_deleted,
    revision: asRevision(row.revision),
  };
}

async function requireActor(client: PoolClient, actor: Slice3Actor): Promise<void> {
  const result = await client.query<{ status: string | null }>(
    'SELECT fad_lock_principal($1, $2) AS status',
    [actor.organizationId, actor.principalId],
  );
  if (result.rows[0]?.status !== 'active') throw new Slice3ServiceError(401, 'UNAUTHORIZED');
}

function fingerprint(method: string, path: string, body: unknown, headers: Record<string, string | null>): Buffer {
  return requestFingerprint(method, path, canonicalJson({ body, ...headers }));
}

async function claim(
  client: PoolClient,
  actor: Slice3Actor,
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  key: string,
  body: unknown,
  headers: Record<string, string | null>,
  kind: WriteKind,
): Promise<WriteResult | null> {
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
  if (kind === 'capability') {
    return { status: 201, capability: stored as CapabilityRecord, ...(location ? { location } : {}) };
  }
  const status = claimResult.responseStatus === 201 ? 201 : 200;
  if (kind === 'endpoint') {
    return { status, endpoint: stored as EndpointRecord, ...(etag ? { etag } : {}), ...(location ? { location } : {}) };
  }
  return { status, binding: stored as BindingRecord, ...(etag ? { etag } : {}), ...(location ? { location } : {}) };
}

async function store(
  client: PoolClient,
  actor: Slice3Actor,
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  key: string,
  body: unknown,
  headers: Record<string, string | null>,
  result: WriteResult,
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
    responseBody: result.capability ?? result.endpoint ?? result.binding ?? null,
    expiresAt: new Date(Date.now() + RETENTION_MS),
  });
}

async function lockAgent(client: PoolClient, organizationId: string, agentId: string): Promise<{ status: string; revision: number } | null> {
  const result = await client.query<{ status: string; revision: string | number }>(
    'SELECT status, revision FROM agents WHERE organization_id = $1 AND id = $2 FOR UPDATE',
    [organizationId, agentId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { status: row.status, revision: asRevision(row.revision) };
}

async function readAgent(client: PoolClient, organizationId: string, agentId: string): Promise<boolean> {
  const result = await client.query('SELECT 1 FROM agents WHERE organization_id = $1 AND id = $2', [organizationId, agentId]);
  return (result.rowCount ?? 0) === 1;
}

const ENDPOINT_SQL = `agent_id, endpoint_key, protocol, url, auth_scheme, enabled, is_deleted, revision,
  created_by, updated_by, created_at, updated_at`;

async function lockEndpoint(client: PoolClient, organizationId: string, agentId: string, key: string): Promise<EndpointRow | null> {
  const result = await client.query<EndpointRow>(
    `SELECT ${ENDPOINT_SQL} FROM agent_endpoints
     WHERE organization_id = $1 AND agent_id = $2 AND endpoint_key = $3
     FOR UPDATE`,
    [organizationId, agentId, key],
  );
  return result.rows[0] ?? null;
}

async function readEndpoint(client: PoolClient, organizationId: string, agentId: string, key: string): Promise<EndpointRow | null> {
  const result = await client.query<EndpointRow>(
    `SELECT ${ENDPOINT_SQL} FROM agent_endpoints
     WHERE organization_id = $1 AND agent_id = $2 AND endpoint_key = $3`,
    [organizationId, agentId, key],
  );
  return result.rows[0] ?? null;
}

const BINDING_SQL = `agent_id, capability_id, version, endpoint_key, is_deleted, revision,
  created_by, updated_by, created_at, updated_at`;

async function lockBinding(client: PoolClient, organizationId: string, agentId: string, capabilityId: string): Promise<BindingRow | null> {
  const result = await client.query<BindingRow>(
    `SELECT ${BINDING_SQL} FROM agent_capability_bindings
     WHERE organization_id = $1 AND agent_id = $2 AND capability_id = $3
     FOR UPDATE`,
    [organizationId, agentId, capabilityId],
  );
  return result.rows[0] ?? null;
}

async function capabilityExists(client: PoolClient, organizationId: string, id: string, version: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM capability_versions
     WHERE organization_id = $1 AND capability_id = $2 AND version = $3`,
    [organizationId, id, version],
  );
  return (result.rowCount ?? 0) === 1;
}

async function writeEndpointHistory(
  client: PoolClient,
  actor: Slice3Actor,
  agentId: string,
  key: string,
  revision: number,
  operation: 'created' | 'updated' | 'deleted' | 'recreated',
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): Promise<void> {
  await client.query(
    `INSERT INTO agent_endpoint_revisions (
       organization_id, agent_id, endpoint_key, revision, operation, before_value, after_value, actor_principal_id
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
    [actor.organizationId, agentId, key, revision, operation, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, actor.principalId],
  );
}

async function writeBindingHistory(
  client: PoolClient,
  actor: Slice3Actor,
  agentId: string,
  capabilityId: string,
  revision: number,
  operation: 'created' | 'updated' | 'deleted' | 'recreated',
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): Promise<void> {
  await client.query(
    `INSERT INTO agent_capability_binding_revisions (
       organization_id, agent_id, capability_id, revision, operation, before_value, after_value, actor_principal_id
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
    [actor.organizationId, agentId, capabilityId, revision, operation, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, actor.principalId],
  );
}

function assertWritable(agent: { status: string } | null): asserts agent is { status: string; revision: number } {
  if (!agent) throw new Slice3ServiceError(404, 'AGENT_NOT_FOUND');
  if (agent.status === 'retired') throw new Slice3ServiceError(409, 'INVALID_AGENT_STATE');
}

export async function publishCapability(
  pool: Pool,
  actor: Slice3Actor,
  idempotencyKey: string,
  input: CapabilityPublishInput,
): Promise<WriteResult> {
  const path = '/v1/capabilities';
  const headers = { if_match: null, if_none_match: null };
  const digest = contractSha256(input);
  return withTenant(pool, actor.organizationId, async (client) => {
    await requireActor(client, actor);
    const replay = await claim(client, actor, 'POST', path, idempotencyKey, input, headers, 'capability');
    if (replay) return replay;
    let row: {
      capability_id: string;
      version: string;
      organization_id: string;
      display_name: string;
      description: string;
      input_schema: Record<string, unknown>;
      output_schema: Record<string, unknown>;
      contract_sha256: string;
      published_by: string;
      published_at: Date | string;
    };
    try {
      const inserted = await client.query<typeof row>(
        `INSERT INTO capability_versions (
           organization_id, capability_id, version, display_name, description,
           input_schema, output_schema, contract_sha256, published_by
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
         RETURNING capability_id, version, organization_id, display_name, description,
           input_schema, output_schema, contract_sha256, published_by, published_at`,
        [
          actor.organizationId,
          input.id,
          input.version,
          input.display_name,
          input.description,
          JSON.stringify(input.input_schema),
          JSON.stringify(input.output_schema),
          digest,
          actor.principalId,
        ],
      );
      const created = inserted.rows[0];
      if (!created) throw new Error('capability insert returned no row');
      row = created;
    } catch (error) {
      if (pgCode(error) === '23505') throw new Slice3ServiceError(409, 'ALREADY_EXISTS');
      if (pgCode(error) === '23514') throw new Slice3ServiceError(422, 'VALIDATION_ERROR');
      throw error;
    }
    const capability: CapabilityRecord = {
      id: row.capability_id,
      version: row.version,
      organization_id: row.organization_id,
      display_name: row.display_name,
      description: row.description,
      input_schema: row.input_schema,
      output_schema: row.output_schema,
      contract_sha256: row.contract_sha256,
      verification: 'self_declared',
      published_by: row.published_by,
      published_at: asTime(row.published_at),
    };
    await insertAudit(client, {
      organizationId: actor.organizationId,
      actorPrincipalId: actor.principalId,
      action: 'capability.published',
      targetType: 'capability_version',
      targetId: `${capability.id}@${capability.version}`,
      outcome: 'success',
      requestId: actor.requestId,
      details: {
        capability_id: capability.id,
        version: capability.version,
        contract_sha256: capability.contract_sha256,
        verification: 'self_declared',
        request_id: actor.requestId,
      },
    });
    await appendDirectoryEvent(client, {
      organizationId: actor.organizationId,
      eventType: 'com.fad.capability.published.v1',
      subject: `capability/${capability.id}@${capability.version}`,
      aggregateType: 'capability_version',
      aggregateId: null,
      aggregateRevision: null,
      visibility: 'standard',
      payload: { capability_id: capability.id, version: capability.version },
      requestId: actor.requestId,
    });
    const result: WriteResult = {
      status: 201,
      capability,
      location: `/v1/capabilities/${capability.id}/versions/${capability.version}`,
    };
    await store(client, actor, 'POST', path, idempotencyKey, input, headers, result);
    return result;
  });
}

const CAPABILITY_SQL = `capability_id, version, organization_id, display_name, description,
  input_schema, output_schema, contract_sha256, published_by, published_at`;

function toCapability(row: {
  capability_id: string;
  version: string;
  organization_id: string;
  display_name: string;
  description: string;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  contract_sha256: string;
  published_by: string;
  published_at: Date | string;
}): CapabilityRecord {
  return {
    id: row.capability_id,
    version: row.version,
    organization_id: row.organization_id,
    display_name: row.display_name,
    description: row.description,
    input_schema: row.input_schema,
    output_schema: row.output_schema,
    contract_sha256: row.contract_sha256,
    verification: 'self_declared',
    published_by: row.published_by,
    published_at: asTime(row.published_at),
  };
}

export async function getCapability(pool: Pool, actor: Slice3Actor, id: string, version: string): Promise<CapabilityRecord> {
  return withTenant(pool, actor.organizationId, async (client) => {
    await requireActor(client, actor);
    const result = await client.query<Parameters<typeof toCapability>[0]>(
      `SELECT ${CAPABILITY_SQL} FROM capability_versions
       WHERE organization_id = $1 AND capability_id = $2 AND version = $3`,
      [actor.organizationId, id, version],
    );
    const row = result.rows[0];
    if (!row) throw new Slice3ServiceError(404, 'CAPABILITY_NOT_FOUND');
    return toCapability(row);
  });
}

export async function listCapabilities(
  pool: Pool,
  actor: Slice3Actor,
  query: CatalogQuery,
  pepper: Buffer,
  now = Date.now(),
): Promise<{ capabilities: CapabilityRecord[]; limit: number; nextCursor: string | null }> {
  const scopes = scopeFingerprint(actor.scopes);
  const filter = catalogFilterKey(query.id);
  const cursor = query.cursor
    ? decodeCatalogCursor(pepper, query.cursor, { org: actor.organizationId, principal: actor.principalId, scopes, filter }, now)
    : null;
  return withTenant(pool, actor.organizationId, async (client) => {
    await requireActor(client, actor);
    const result = await client.query<Parameters<typeof toCapability>[0]>(
      `SELECT ${CAPABILITY_SQL} FROM capability_versions
       WHERE organization_id = $1
         AND ($2::varchar IS NULL OR capability_id = $2)
         AND ($3::varchar IS NULL OR capability_id > $3 OR (capability_id = $3 AND version > $4))
       ORDER BY capability_id ASC, version ASC
       LIMIT $5`,
      [actor.organizationId, query.id, cursor?.id ?? null, cursor?.version ?? null, query.limit + 1],
    );
    const page = result.rows.slice(0, query.limit).map((row) => toCapability(row));
    const boundary = result.rows.length > query.limit ? page[page.length - 1] : undefined;
    const nextCursor = boundary
      ? encodeCatalogCursor(pepper, {
        org: actor.organizationId,
        principal: actor.principalId,
        scopes,
        filter,
        id: boundary.id,
        version: boundary.version,
      }, now)
      : null;
    return { capabilities: page, limit: query.limit, nextCursor };
  });
}

export async function listEndpoints(pool: Pool, actor: Slice3Actor, agentId: string): Promise<EndpointRecord[]> {
  return withTenant(pool, actor.organizationId, async (client) => {
    await beginShared(client, actor.organizationId);
    await requireActor(client, actor);
    await enforceAgent(client, sliceCaller(actor), 'listAgentEndpoints', agentId, 'read');
    if (!(await readAgent(client, actor.organizationId, agentId))) throw new Slice3ServiceError(404, 'AGENT_NOT_FOUND');
    const result = await client.query<EndpointRow>(
      `SELECT ${ENDPOINT_SQL} FROM agent_endpoints
       WHERE organization_id = $1 AND agent_id = $2 AND is_deleted = false
       ORDER BY endpoint_key ASC`,
      [actor.organizationId, agentId],
    );
    return result.rows.map((row) => toEndpoint(row));
  });
}

export async function getEndpoint(pool: Pool, actor: Slice3Actor, agentId: string, key: string): Promise<{ endpoint: EndpointRecord; etag: string }> {
  return withTenant(pool, actor.organizationId, async (client) => {
    await beginShared(client, actor.organizationId);
    await requireActor(client, actor);
    await enforceAgent(client, sliceCaller(actor), 'getAgentEndpoint', agentId, 'read');
    if (!(await readAgent(client, actor.organizationId, agentId))) throw new Slice3ServiceError(404, 'AGENT_NOT_FOUND');
    const row = await readEndpoint(client, actor.organizationId, agentId, key);
    if (!row || row.is_deleted) throw new Slice3ServiceError(404, 'ENDPOINT_NOT_FOUND');
    const endpoint = toEndpoint(row);
    return { endpoint, etag: endpointEtag(endpoint.revision) };
  });
}

function endpointPath(agentId: string, key: string): string {
  return `/v1/agents/${agentId}/endpoints/${key}`;
}

export async function putEndpoint(
  pool: Pool,
  actor: Slice3Actor,
  agentId: string,
  key: string,
  idempotencyKey: string,
  precondition: { kind: 'match'; revision: number } | { kind: 'none' },
  input: EndpointPutInput,
  limits: Slice3Limits,
): Promise<WriteResult> {
  const path = endpointPath(agentId, key);
  const headers = {
    if_match: precondition.kind === 'match' ? endpointEtag(precondition.revision) : null,
    if_none_match: precondition.kind === 'none' ? '*' : null,
  };
  return withTenant(pool, actor.organizationId, async (client) => {
    await beginShared(client, actor.organizationId);
    await requireActor(client, actor);
    const replay = await claim(client, actor, 'PUT', path, idempotencyKey, input, headers, 'endpoint');
    if (replay) {
      await enforceAgent(client, sliceCaller(actor), 'putAgentEndpoint', agentId, 'write');
      return replay;
    }
    // Lock the agent before the decision insert. The decision foreign key takes KEY SHARE,
    // and a later FOR UPDATE from a second writer deadlocks on the upgrade.
    const agent = await lockAgent(client, actor.organizationId, agentId);
    if (!agent) throw new Slice3ServiceError(404, 'AGENT_NOT_FOUND');
    await enforceAgent(client, sliceCaller(actor), 'putAgentEndpoint', agentId, 'write');
    assertWritable(agent);
    const current = await lockEndpoint(client, actor.organizationId, agentId, key);
    const active = current !== null && !current.is_deleted;
    if (precondition.kind === 'match') {
      if (!active || !current) throw new Slice3ServiceError(412, 'PRECONDITION_FAILED');
      if (asRevision(current.revision) !== precondition.revision) throw new Slice3ServiceError(412, 'PRECONDITION_FAILED');
      const existing = toEndpoint(current);
      if (sameEndpoint(input, {
        protocol: existing.protocol as EndpointPutInput['protocol'],
        url: existing.url,
        auth_scheme: existing.auth_scheme as EndpointPutInput['auth_scheme'],
        enabled: existing.enabled,
      })) {
        const result: WriteResult = { status: 200, endpoint: existing, etag: endpointEtag(existing.revision) };
        await store(client, actor, 'PUT', path, idempotencyKey, input, headers, result);
        return result;
      }
      const revision = existing.revision + 1;
      const updated = await client.query<EndpointRow>(
        `UPDATE agent_endpoints
         SET protocol = $4, url = $5, auth_scheme = $6, enabled = $7, revision = $8,
             updated_by = $9, updated_at = transaction_timestamp()
         WHERE organization_id = $1 AND agent_id = $2 AND endpoint_key = $3
         RETURNING ${ENDPOINT_SQL}`,
        [actor.organizationId, agentId, key, input.protocol, input.url, input.auth_scheme, input.enabled, revision, actor.principalId],
      );
      const row = updated.rows[0];
      if (!row) throw new Error('endpoint update returned no row');
      const endpoint = toEndpoint(row);
      await writeEndpointHistory(client, actor, agentId, key, endpoint.revision, 'updated', endpointSnapshot(current), endpointSnapshot(row));
      await insertAudit(client, {
        organizationId: actor.organizationId,
        actorPrincipalId: actor.principalId,
        action: 'endpoint.updated',
        targetType: 'agent_endpoint',
        targetId: `${agentId}/${key}`,
        outcome: 'success',
        requestId: actor.requestId,
        details: { endpoint_key: key, revision: endpoint.revision, protocol: endpoint.protocol, auth_scheme: endpoint.auth_scheme, enabled: endpoint.enabled, verification: 'self_declared', request_id: actor.requestId },
      });
      await appendDirectoryEvent(client, {
        organizationId: actor.organizationId,
        eventType: 'com.fad.agent.endpoint_changed.v1',
        subject: `agent/${agentId}/endpoint/${key}`,
        aggregateType: 'agent_endpoint',
        aggregateId: agentId,
        aggregateRevision: endpoint.revision,
        visibility: 'standard',
        payload: { agent_id: agentId, endpoint_key: key, revision: endpoint.revision, change: 'upserted' },
        requestId: actor.requestId,
      });
      const result: WriteResult = { status: 200, endpoint, etag: endpointEtag(endpoint.revision) };
      await store(client, actor, 'PUT', path, idempotencyKey, input, headers, result);
      return result;
    }
    if (active) throw new Slice3ServiceError(412, 'PRECONDITION_FAILED');
    const counted = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM agent_endpoints
       WHERE organization_id = $1 AND agent_id = $2 AND is_deleted = false`,
      [actor.organizationId, agentId],
    );
    if ((counted.rows[0]?.n ?? 0) >= limits.maxEndpoints) throw new Slice3ServiceError(409, 'VALIDATION_ERROR');
    let row: EndpointRow;
    let operation: 'created' | 'recreated' = 'created';
    let before: Record<string, unknown> | null = null;
    if (!current) {
      const inserted = await client.query<EndpointRow>(
        `INSERT INTO agent_endpoints (
           organization_id, agent_id, endpoint_key, protocol, url, auth_scheme, enabled, is_deleted, revision, created_by, updated_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, false, 1, $8, $8)
         RETURNING ${ENDPOINT_SQL}`,
        [actor.organizationId, agentId, key, input.protocol, input.url, input.auth_scheme, input.enabled, actor.principalId],
      );
      const created = inserted.rows[0];
      if (!created) throw new Error('endpoint insert returned no row');
      row = created;
    } else {
      operation = 'recreated';
      before = endpointSnapshot(current);
      const revived = await client.query<EndpointRow>(
        `UPDATE agent_endpoints
         SET protocol = $4, url = $5, auth_scheme = $6, enabled = $7, is_deleted = false, revision = revision + 1,
             updated_by = $8, updated_at = transaction_timestamp()
         WHERE organization_id = $1 AND agent_id = $2 AND endpoint_key = $3
         RETURNING ${ENDPOINT_SQL}`,
        [actor.organizationId, agentId, key, input.protocol, input.url, input.auth_scheme, input.enabled, actor.principalId],
      );
      const revivedRow = revived.rows[0];
      if (!revivedRow) throw new Error('endpoint recreate returned no row');
      row = revivedRow;
    }
    const endpoint = toEndpoint(row);
    await writeEndpointHistory(client, actor, agentId, key, endpoint.revision, operation, before, endpointSnapshot(row));
    await insertAudit(client, {
      organizationId: actor.organizationId,
      actorPrincipalId: actor.principalId,
      action: operation === 'created' ? 'endpoint.created' : 'endpoint.recreated',
      targetType: 'agent_endpoint',
      targetId: `${agentId}/${key}`,
      outcome: 'success',
      requestId: actor.requestId,
      details: { endpoint_key: key, revision: endpoint.revision, protocol: endpoint.protocol, auth_scheme: endpoint.auth_scheme, enabled: endpoint.enabled, verification: 'self_declared', request_id: actor.requestId },
    });
    await appendDirectoryEvent(client, {
      organizationId: actor.organizationId,
      eventType: 'com.fad.agent.endpoint_changed.v1',
      subject: `agent/${agentId}/endpoint/${key}`,
      aggregateType: 'agent_endpoint',
      aggregateId: agentId,
      aggregateRevision: endpoint.revision,
      visibility: 'standard',
      payload: { agent_id: agentId, endpoint_key: key, revision: endpoint.revision, change: 'upserted' },
      requestId: actor.requestId,
    });
    const result: WriteResult = { status: 201, endpoint, etag: endpointEtag(endpoint.revision), location: path };
    await store(client, actor, 'PUT', path, idempotencyKey, input, headers, result);
    return result;
  });
}

export async function deleteEndpoint(
  pool: Pool,
  actor: Slice3Actor,
  agentId: string,
  key: string,
  idempotencyKey: string,
  revision: number,
): Promise<WriteResult> {
  const path = endpointPath(agentId, key);
  const headers = { if_match: endpointEtag(revision), if_none_match: null };
  return withTenant(pool, actor.organizationId, async (client) => {
    await beginShared(client, actor.organizationId);
    await requireActor(client, actor);
    const replay = await claim(client, actor, 'DELETE', path, idempotencyKey, null, headers, 'endpoint');
    if (replay) {
      await enforceAgent(client, sliceCaller(actor), 'deleteAgentEndpoint', agentId, 'write');
      return replay;
    }
    const agent = await lockAgent(client, actor.organizationId, agentId);
    if (!agent) throw new Slice3ServiceError(404, 'AGENT_NOT_FOUND');
    await enforceAgent(client, sliceCaller(actor), 'deleteAgentEndpoint', agentId, 'write');
    assertWritable(agent);
    const current = await lockEndpoint(client, actor.organizationId, agentId, key);
    if (!current || current.is_deleted) throw new Slice3ServiceError(404, 'ENDPOINT_NOT_FOUND');
    if (asRevision(current.revision) !== revision) throw new Slice3ServiceError(412, 'PRECONDITION_FAILED');
    const used = await client.query(
      `SELECT capability_id FROM agent_capability_bindings
       WHERE organization_id = $1 AND agent_id = $2 AND endpoint_key = $3 AND is_deleted = false
       ORDER BY capability_id
       FOR UPDATE`,
      [actor.organizationId, agentId, key],
    );
    if ((used.rowCount ?? 0) > 0) throw new Slice3ServiceError(409, 'ENDPOINT_IN_USE');
    const before = endpointSnapshot(current);
    const removed = await client.query<EndpointRow>(
      `UPDATE agent_endpoints
       SET is_deleted = true, revision = revision + 1, updated_by = $4, updated_at = transaction_timestamp()
       WHERE organization_id = $1 AND agent_id = $2 AND endpoint_key = $3
       RETURNING ${ENDPOINT_SQL}`,
      [actor.organizationId, agentId, key, actor.principalId],
    );
    const row = removed.rows[0];
    if (!row) throw new Error('endpoint delete returned no row');
    await writeEndpointHistory(client, actor, agentId, key, asRevision(row.revision), 'deleted', before, endpointSnapshot(row));
    await insertAudit(client, {
      organizationId: actor.organizationId,
      actorPrincipalId: actor.principalId,
      action: 'endpoint.deleted',
      targetType: 'agent_endpoint',
      targetId: `${agentId}/${key}`,
      outcome: 'success',
      requestId: actor.requestId,
      details: { endpoint_key: key, revision: asRevision(row.revision), verification: 'self_declared', request_id: actor.requestId },
    });
    await appendDirectoryEvent(client, {
      organizationId: actor.organizationId,
      eventType: 'com.fad.agent.endpoint_changed.v1',
      subject: `agent/${agentId}/endpoint/${key}`,
      aggregateType: 'agent_endpoint',
      aggregateId: agentId,
      aggregateRevision: asRevision(row.revision),
      visibility: 'standard',
      payload: { agent_id: agentId, endpoint_key: key, revision: asRevision(row.revision), change: 'deleted' },
      requestId: actor.requestId,
    });
    const result: WriteResult = { status: 204 };
    await store(client, actor, 'DELETE', path, idempotencyKey, null, headers, result);
    return result;
  });
}

export async function listBindings(pool: Pool, actor: Slice3Actor, agentId: string): Promise<BindingRecord[]> {
  return withTenant(pool, actor.organizationId, async (client) => {
    await beginShared(client, actor.organizationId);
    await requireActor(client, actor);
    await enforceAgent(client, sliceCaller(actor), 'listAgentCapabilityBindings', agentId, 'read');
    if (!(await readAgent(client, actor.organizationId, agentId))) throw new Slice3ServiceError(404, 'AGENT_NOT_FOUND');
    const result = await client.query<BindingRow>(
      `SELECT ${BINDING_SQL} FROM agent_capability_bindings
       WHERE organization_id = $1 AND agent_id = $2 AND is_deleted = false
       ORDER BY capability_id ASC`,
      [actor.organizationId, agentId],
    );
    return result.rows.map((row) => toBinding(row));
  });
}

export async function getBinding(pool: Pool, actor: Slice3Actor, agentId: string, capabilityId: string): Promise<{ binding: BindingRecord; etag: string }> {
  return withTenant(pool, actor.organizationId, async (client) => {
    await beginShared(client, actor.organizationId);
    await requireActor(client, actor);
    await enforceAgent(client, sliceCaller(actor), 'getAgentCapabilityBinding', agentId, 'read');
    if (!(await readAgent(client, actor.organizationId, agentId))) throw new Slice3ServiceError(404, 'AGENT_NOT_FOUND');
    const result = await client.query<BindingRow>(
      `SELECT ${BINDING_SQL} FROM agent_capability_bindings
       WHERE organization_id = $1 AND agent_id = $2 AND capability_id = $3`,
      [actor.organizationId, agentId, capabilityId],
    );
    const row = result.rows[0];
    if (!row || row.is_deleted) throw new Slice3ServiceError(404, 'BINDING_NOT_FOUND');
    const binding = toBinding(row);
    return { binding, etag: bindingEtag(binding.revision) };
  });
}

function bindingPath(agentId: string, capabilityId: string): string {
  return `/v1/agents/${agentId}/capabilities/${capabilityId}`;
}

async function requireLiveEndpoint(client: PoolClient, organizationId: string, agentId: string, key: string): Promise<EndpointRow> {
  const endpoint = await lockEndpoint(client, organizationId, agentId, key);
  if (!endpoint || endpoint.is_deleted) throw new Slice3ServiceError(404, 'ENDPOINT_NOT_FOUND');
  if (!endpoint.enabled) throw new Slice3ServiceError(422, 'VALIDATION_ERROR');
  return endpoint;
}

export async function putBinding(
  pool: Pool,
  actor: Slice3Actor,
  agentId: string,
  capabilityId: string,
  idempotencyKey: string,
  precondition: { kind: 'match'; revision: number } | { kind: 'none' },
  input: BindingPutInput,
  limits: Slice3Limits,
): Promise<WriteResult> {
  const path = bindingPath(agentId, capabilityId);
  const headers = {
    if_match: precondition.kind === 'match' ? bindingEtag(precondition.revision) : null,
    if_none_match: precondition.kind === 'none' ? '*' : null,
  };
  return withTenant(pool, actor.organizationId, async (client) => {
    await beginShared(client, actor.organizationId);
    await requireActor(client, actor);
    const replay = await claim(client, actor, 'PUT', path, idempotencyKey, input, headers, 'binding');
    if (replay) {
      await enforceAgent(client, sliceCaller(actor), 'putAgentCapabilityBinding', agentId, 'write');
      return replay;
    }
    const agent = await lockAgent(client, actor.organizationId, agentId);
    if (!agent) throw new Slice3ServiceError(404, 'AGENT_NOT_FOUND');
    await enforceAgent(client, sliceCaller(actor), 'putAgentCapabilityBinding', agentId, 'write');
    assertWritable(agent);
    if (!(await capabilityExists(client, actor.organizationId, capabilityId, input.version))) {
      throw new Slice3ServiceError(404, 'CAPABILITY_NOT_FOUND');
    }
    const preview = await client.query<BindingRow>(
      `SELECT ${BINDING_SQL} FROM agent_capability_bindings
       WHERE organization_id = $1 AND agent_id = $2 AND capability_id = $3`,
      [actor.organizationId, agentId, capabilityId],
    );
    const previewRow = preview.rows[0] ?? null;
    const keys = [input.endpoint_key];
    if (previewRow) keys.push(previewRow.endpoint_key);
    const ordered = [...new Set(keys)].sort();
    for (const endpointKey of ordered) {
      if (endpointKey === input.endpoint_key) await requireLiveEndpoint(client, actor.organizationId, agentId, endpointKey);
      else await lockEndpoint(client, actor.organizationId, agentId, endpointKey);
    }
    const current = await lockBinding(client, actor.organizationId, agentId, capabilityId);
    const active = current !== null && !current.is_deleted;
    if (precondition.kind === 'match') {
      if (!active || !current) throw new Slice3ServiceError(412, 'PRECONDITION_FAILED');
      if (asRevision(current.revision) !== precondition.revision) throw new Slice3ServiceError(412, 'PRECONDITION_FAILED');
      const existing = toBinding(current);
      if (sameBinding(input, { version: existing.version, endpoint_key: existing.endpoint_key })) {
        const result: WriteResult = { status: 200, binding: existing, etag: bindingEtag(existing.revision) };
        await store(client, actor, 'PUT', path, idempotencyKey, input, headers, result);
        return result;
      }
      const revision = existing.revision + 1;
      const updated = await client.query<BindingRow>(
        `UPDATE agent_capability_bindings
         SET version = $4, endpoint_key = $5, revision = $6, updated_by = $7, updated_at = transaction_timestamp()
         WHERE organization_id = $1 AND agent_id = $2 AND capability_id = $3
         RETURNING ${BINDING_SQL}`,
        [actor.organizationId, agentId, capabilityId, input.version, input.endpoint_key, revision, actor.principalId],
      );
      const row = updated.rows[0];
      if (!row) throw new Error('binding update returned no row');
      const binding = toBinding(row);
      await writeBindingHistory(client, actor, agentId, capabilityId, binding.revision, 'updated', bindingSnapshot(current), bindingSnapshot(row));
      await insertAudit(client, {
        organizationId: actor.organizationId,
        actorPrincipalId: actor.principalId,
        action: 'binding.updated',
        targetType: 'capability_binding',
        targetId: `${agentId}/${capabilityId}`,
        outcome: 'success',
        requestId: actor.requestId,
        details: { capability_id: capabilityId, version: binding.version, endpoint_key: binding.endpoint_key, revision: binding.revision, verification: 'self_declared', request_id: actor.requestId },
      });
      await appendDirectoryEvent(client, {
        organizationId: actor.organizationId,
        eventType: 'com.fad.agent.capability_binding_changed.v1',
        subject: `agent/${agentId}/capability/${capabilityId}`,
        aggregateType: 'capability_binding',
        aggregateId: agentId,
        aggregateRevision: binding.revision,
        visibility: 'standard',
        payload: { agent_id: agentId, capability_id: capabilityId, version: binding.version, endpoint_key: binding.endpoint_key, revision: binding.revision, change: 'upserted' },
        requestId: actor.requestId,
      });
      const result: WriteResult = { status: 200, binding, etag: bindingEtag(binding.revision) };
      await store(client, actor, 'PUT', path, idempotencyKey, input, headers, result);
      return result;
    }
    if (active) throw new Slice3ServiceError(412, 'PRECONDITION_FAILED');
    const counted = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM agent_capability_bindings
       WHERE organization_id = $1 AND agent_id = $2 AND is_deleted = false`,
      [actor.organizationId, agentId],
    );
    if ((counted.rows[0]?.n ?? 0) >= limits.maxBindings) throw new Slice3ServiceError(409, 'VALIDATION_ERROR');
    let row: BindingRow;
    let operation: 'created' | 'recreated' = 'created';
    let before: Record<string, unknown> | null = null;
    if (!current) {
      const inserted = await client.query<BindingRow>(
        `INSERT INTO agent_capability_bindings (
           organization_id, agent_id, capability_id, version, endpoint_key, is_deleted, revision, created_by, updated_by
         ) VALUES ($1, $2, $3, $4, $5, false, 1, $6, $6)
         RETURNING ${BINDING_SQL}`,
        [actor.organizationId, agentId, capabilityId, input.version, input.endpoint_key, actor.principalId],
      );
      const created = inserted.rows[0];
      if (!created) throw new Error('binding insert returned no row');
      row = created;
    } else {
      operation = 'recreated';
      before = bindingSnapshot(current);
      const revived = await client.query<BindingRow>(
        `UPDATE agent_capability_bindings
         SET version = $4, endpoint_key = $5, is_deleted = false, revision = revision + 1,
             updated_by = $6, updated_at = transaction_timestamp()
         WHERE organization_id = $1 AND agent_id = $2 AND capability_id = $3
         RETURNING ${BINDING_SQL}`,
        [actor.organizationId, agentId, capabilityId, input.version, input.endpoint_key, actor.principalId],
      );
      const revivedRow = revived.rows[0];
      if (!revivedRow) throw new Error('binding recreate returned no row');
      row = revivedRow;
    }
    const binding = toBinding(row);
    await writeBindingHistory(client, actor, agentId, capabilityId, binding.revision, operation, before, bindingSnapshot(row));
    await insertAudit(client, {
      organizationId: actor.organizationId,
      actorPrincipalId: actor.principalId,
      action: operation === 'created' ? 'binding.created' : 'binding.recreated',
      targetType: 'capability_binding',
      targetId: `${agentId}/${capabilityId}`,
      outcome: 'success',
      requestId: actor.requestId,
      details: { capability_id: capabilityId, version: binding.version, endpoint_key: binding.endpoint_key, revision: binding.revision, verification: 'self_declared', request_id: actor.requestId },
    });
    await appendDirectoryEvent(client, {
      organizationId: actor.organizationId,
      eventType: 'com.fad.agent.capability_binding_changed.v1',
      subject: `agent/${agentId}/capability/${capabilityId}`,
      aggregateType: 'capability_binding',
      aggregateId: agentId,
      aggregateRevision: binding.revision,
      visibility: 'standard',
      payload: { agent_id: agentId, capability_id: capabilityId, version: binding.version, endpoint_key: binding.endpoint_key, revision: binding.revision, change: 'upserted' },
      requestId: actor.requestId,
    });
    const result: WriteResult = { status: 201, binding, etag: bindingEtag(binding.revision), location: path };
    await store(client, actor, 'PUT', path, idempotencyKey, input, headers, result);
    return result;
  });
}

export async function deleteBinding(
  pool: Pool,
  actor: Slice3Actor,
  agentId: string,
  capabilityId: string,
  idempotencyKey: string,
  revision: number,
): Promise<WriteResult> {
  const path = bindingPath(agentId, capabilityId);
  const headers = { if_match: bindingEtag(revision), if_none_match: null };
  return withTenant(pool, actor.organizationId, async (client) => {
    await beginShared(client, actor.organizationId);
    await requireActor(client, actor);
    const replay = await claim(client, actor, 'DELETE', path, idempotencyKey, null, headers, 'binding');
    if (replay) {
      await enforceAgent(client, sliceCaller(actor), 'deleteAgentCapabilityBinding', agentId, 'write');
      return replay;
    }
    const agent = await lockAgent(client, actor.organizationId, agentId);
    if (!agent) throw new Slice3ServiceError(404, 'AGENT_NOT_FOUND');
    await enforceAgent(client, sliceCaller(actor), 'deleteAgentCapabilityBinding', agentId, 'write');
    assertWritable(agent);
    const preview = await client.query<{ endpoint_key: string }>(
      `SELECT endpoint_key FROM agent_capability_bindings
       WHERE organization_id = $1 AND agent_id = $2 AND capability_id = $3`,
      [actor.organizationId, agentId, capabilityId],
    );
    if (preview.rows[0]) await lockEndpoint(client, actor.organizationId, agentId, preview.rows[0].endpoint_key);
    const current = await lockBinding(client, actor.organizationId, agentId, capabilityId);
    if (!current || current.is_deleted) throw new Slice3ServiceError(404, 'BINDING_NOT_FOUND');
    if (asRevision(current.revision) !== revision) throw new Slice3ServiceError(412, 'PRECONDITION_FAILED');
    const before = bindingSnapshot(current);
    const removed = await client.query<BindingRow>(
      `UPDATE agent_capability_bindings
       SET is_deleted = true, revision = revision + 1, updated_by = $4, updated_at = transaction_timestamp()
       WHERE organization_id = $1 AND agent_id = $2 AND capability_id = $3
       RETURNING ${BINDING_SQL}`,
      [actor.organizationId, agentId, capabilityId, actor.principalId],
    );
    const row = removed.rows[0];
    if (!row) throw new Error('binding delete returned no row');
    await writeBindingHistory(client, actor, agentId, capabilityId, asRevision(row.revision), 'deleted', before, bindingSnapshot(row));
    await insertAudit(client, {
      organizationId: actor.organizationId,
      actorPrincipalId: actor.principalId,
      action: 'binding.deleted',
      targetType: 'capability_binding',
      targetId: `${agentId}/${capabilityId}`,
      outcome: 'success',
      requestId: actor.requestId,
      details: { capability_id: capabilityId, revision: asRevision(row.revision), verification: 'self_declared', request_id: actor.requestId },
    });
    await appendDirectoryEvent(client, {
      organizationId: actor.organizationId,
      eventType: 'com.fad.agent.capability_binding_changed.v1',
      subject: `agent/${agentId}/capability/${capabilityId}`,
      aggregateType: 'capability_binding',
      aggregateId: agentId,
      aggregateRevision: asRevision(row.revision),
      visibility: 'standard',
      payload: { agent_id: agentId, capability_id: capabilityId, revision: asRevision(row.revision), change: 'deleted' },
      requestId: actor.requestId,
    });
    const result: WriteResult = { status: 204 };
    await store(client, actor, 'DELETE', path, idempotencyKey, null, headers, result);
    return result;
  });
}

async function loadDiscoveryTags(
  client: PoolClient,
  actor: Slice3Actor,
  tags: DiscoveryTag[] | null,
): Promise<DiscoveryTag[] | null> {
  if (!tags) return null;
  const restricted = hasScope(actor.scopes, 'tags:restricted:read');
  const loaded: Array<{ tag: DiscoveryTag; definition: { value_type: TagType; enum_values: string[] | null; visibility: string } | null }> = [];
  for (const tag of tags) {
    const result = await client.query<{ value_type: TagType; enum_values: string[] | null; visibility: string }>(
      `SELECT value_type, enum_values, visibility FROM tag_definitions
       WHERE organization_id = $1 AND namespace = $2 AND tag_key = $3`,
      [actor.organizationId, tag.namespace, tag.key],
    );
    loaded.push({ tag, definition: result.rows[0] ?? null });
  }
  // A missing definition and a restricted definition are the same 403 when this
  // credential cannot read restricted tags. Do not validate values or query agents.
  if (!restricted && loaded.some((item) => !item.definition || item.definition.visibility === 'restricted')) {
    throw new Slice3ServiceError(403, 'FORBIDDEN');
  }
  return loaded.map((item) => {
    if (!item.definition) throw new Slice3ServiceError(422, 'VALIDATION_ERROR');
    return {
      ...item.tag,
      value: validateTagValue(
        { valueType: item.definition.value_type, enumValues: item.definition.enum_values },
        item.tag.value,
      ),
    };
  });
}

export async function discoverAgents(
  pool: Pool,
  actor: Slice3Actor,
  query: DiscoveryInput,
  pepper: Buffer,
  limits: Slice3Limits,
  now = Date.now(),
): Promise<{ matches: DiscoveryMatch[]; limit: number; nextCursor: string | null }> {
  const scopes = scopeFingerprint(actor.scopes);
  const filter = discoveryFilterKey(query);
  return withTenant(pool, actor.organizationId, async (client) => {
    await beginShared(client, actor.organizationId);
    await requireActor(client, actor);
    await client.query(`SELECT set_config('statement_timeout', $1, true)`, [`${limits.discoveryTimeoutMs}ms`]);
    const predicates = await loadDiscoveryTags(client, actor, query.tags);
    const values: unknown[] = [actor.organizationId, query.capabilityId, query.version];
    const tagSql: string[] = [];
    for (const predicate of predicates ?? []) {
      const namespace = values.push(predicate.namespace);
      const key = values.push(predicate.key);
      const value = values.push(JSON.stringify(predicate.value));
      tagSql.push(`EXISTS (
        SELECT 1 FROM agent_tag_assignments tag_match
        WHERE tag_match.organization_id = agents.organization_id
          AND tag_match.agent_id = agents.id
          AND tag_match.namespace = $${namespace}::varchar
          AND tag_match.tag_key = $${key}::varchar
          AND tag_match.tag_value = $${value}::jsonb
          AND tag_match.is_deleted = false
      )`);
    }
    let protocolSql = '';
    if (query.protocols) {
      const index = values.push(query.protocols);
      protocolSql = `AND endpoints.protocol = ANY($${index}::text[])`;
    }
    const cursorIndex = values.push(null);
    const limitIndex = values.push(query.limit + 1);
    const tagsClause = tagSql.length > 0 ? `AND ${tagSql.join('\n AND ')}` : '';
    const caller = sliceCaller(actor);
    const context = await loadEvalContext(client, caller, 'discoverLocalAgents');
    const loadRows = async (afterId: string | null, limit: number) => {
      values[cursorIndex - 1] = afterId;
      values[limitIndex - 1] = limit;
      try {
        return await client.query<{
        agent_id: string;
        organization_id: string;
        name: string;
        description: string;
        owner_principal_id: string;
        status: string;
        agent_revision: string | number;
        agent_created_at: Date | string;
        agent_updated_at: Date | string;
        agent_created_by: string;
        agent_updated_by: string;
        capability_id: string;
        binding_version: string;
        endpoint_key: string;
        binding_deleted: boolean;
        binding_revision: string | number;
        binding_created_by: string;
        binding_updated_by: string;
        binding_created_at: Date | string;
        binding_updated_at: Date | string;
        protocol: string;
        url: string;
        auth_scheme: string;
        enabled: boolean;
        endpoint_deleted: boolean;
        endpoint_revision: string | number;
        endpoint_created_by: string;
        endpoint_updated_by: string;
        endpoint_created_at: Date | string;
        endpoint_updated_at: Date | string;
      }>(
        `SELECT agents.id AS agent_id, agents.organization_id, agents.name, agents.description,
                agents.owner_principal_id, agents.status, agents.revision AS agent_revision,
                agents.created_at AS agent_created_at, agents.updated_at AS agent_updated_at,
                agents.created_by AS agent_created_by, agents.updated_by AS agent_updated_by,
                bindings.capability_id, bindings.version AS binding_version, bindings.endpoint_key,
                bindings.is_deleted AS binding_deleted, bindings.revision AS binding_revision,
                bindings.created_by AS binding_created_by, bindings.updated_by AS binding_updated_by,
                bindings.created_at AS binding_created_at, bindings.updated_at AS binding_updated_at,
                endpoints.protocol, endpoints.url, endpoints.auth_scheme, endpoints.enabled,
                endpoints.is_deleted AS endpoint_deleted, endpoints.revision AS endpoint_revision,
                endpoints.created_by AS endpoint_created_by, endpoints.updated_by AS endpoint_updated_by,
                endpoints.created_at AS endpoint_created_at, endpoints.updated_at AS endpoint_updated_at
         FROM agent_capability_bindings bindings
         JOIN agents
           ON agents.organization_id = bindings.organization_id
          AND agents.id = bindings.agent_id
         JOIN agent_endpoints endpoints
           ON endpoints.organization_id = bindings.organization_id
          AND endpoints.agent_id = bindings.agent_id
          AND endpoints.endpoint_key = bindings.endpoint_key
         WHERE bindings.organization_id = $1
           AND bindings.capability_id = $2
           AND ($3::varchar IS NULL OR bindings.version = $3)
           AND bindings.is_deleted = false
           AND agents.status = 'active'
           AND endpoints.is_deleted = false
           AND endpoints.enabled = true
           ${protocolSql}
           ${tagsClause}
           AND ($${cursorIndex}::uuid IS NULL OR agents.id > $${cursorIndex}::uuid)
         ORDER BY agents.id ASC
         LIMIT $${limitIndex}`,
        values,
      );
      } catch (error) {
        if (pgCode(error) === '57014') throw new Slice3ServiceError(503, 'DEPENDENCY_UNAVAILABLE');
        throw error;
      }
    };
    const mapRow = (row: Awaited<ReturnType<typeof loadRows>>['rows'][number]): DiscoveryMatch => ({
      agent: {
        id: row.agent_id,
        global_id: `urn:fad:agent:${row.organization_id}:${row.agent_id}`,
        organization_id: row.organization_id,
        name: row.name,
        description: row.description,
        owner_principal_id: row.owner_principal_id,
        status: row.status,
        revision: asRevision(row.agent_revision),
        created_at: asTime(row.agent_created_at),
        updated_at: asTime(row.agent_updated_at),
        created_by: row.agent_created_by,
        updated_by: row.agent_updated_by,
      },
      capability: { id: row.capability_id, version: row.binding_version, verification: 'self_declared' as const },
      binding: toBinding({
        agent_id: row.agent_id,
        capability_id: row.capability_id,
        version: row.binding_version,
        endpoint_key: row.endpoint_key,
        is_deleted: row.binding_deleted,
        revision: row.binding_revision,
        created_by: row.binding_created_by,
        updated_by: row.binding_updated_by,
        created_at: row.binding_created_at,
        updated_at: row.binding_updated_at,
      }),
      endpoint: toEndpoint({
        agent_id: row.agent_id,
        endpoint_key: row.endpoint_key,
        protocol: row.protocol,
        url: row.url,
        auth_scheme: row.auth_scheme,
        enabled: row.enabled,
        is_deleted: row.endpoint_deleted,
        revision: row.endpoint_revision,
        created_by: row.endpoint_created_by,
        updated_by: row.endpoint_updated_by,
        created_at: row.endpoint_created_at,
        updated_at: row.endpoint_updated_at,
      }),
      invocation_authorization: 'not_evaluated' as const,
      availability: 'not_checked' as const,
    });
    if (!context || context.mode !== 'enforce') {
      const cursor = query.cursor
        ? decodeDiscoveryCursor(pepper, query.cursor, {
          org: actor.organizationId,
          principal: actor.principalId,
          scopes,
          filter,
        }, now)
        : null;
      const result = await loadRows(cursor?.id ?? null, query.limit + 1);
      const page = result.rows.slice(0, query.limit).map((row) => mapRow(row));
      if (context) {
        for (const match of page) {
          await authorizeCandidate(client, caller, context, 'discoverLocalAgents', {
            id: match.agent.id,
            status: 'active',
            revision: match.agent.revision,
          });
        }
      }
      const boundary = result.rows.length > query.limit ? page[page.length - 1] : undefined;
      const nextCursor = boundary
        ? encodeDiscoveryCursor(pepper, {
          org: actor.organizationId,
          principal: actor.principalId,
          scopes,
          filter,
          id: boundary.agent.id,
        }, now)
        : null;
      return { matches: page, limit: query.limit, nextCursor };
    }
    const enfFilter = `discover:${filter}`;
    const start = query.cursor
      ? decodeEnforcementCursor(pepper, query.cursor, {
        org: actor.organizationId,
        principal: actor.principalId,
        filter: enfFilter,
        mode: 'enforce',
        revision: context.revision,
        operation: 'discoverLocalAgents',
      }, now)
      : null;
    const budget = enforcementScanLimit();
    const page: DiscoveryMatch[] = [];
    let afterId = start?.id ?? null;
    let scanned = 0;
    let more = false;
    while (page.length < query.limit && scanned < budget) {
      const room = Math.min(100, budget - scanned);
      const result = await loadRows(afterId, room + 1);
      if (result.rows.length === 0) {
        more = false;
        break;
      }
      let index = 0;
      while (index < result.rows.length && index < room && page.length < query.limit && scanned < budget) {
        const row = result.rows[index];
        if (!row) throw new EnforcementServiceError(503, 'DEPENDENCY_UNAVAILABLE');
        scanned += 1;
        afterId = row.agent_id;
        const match = mapRow(row);
        const allowed = await authorizeCandidate(client, caller, context, 'discoverLocalAgents', {
          id: match.agent.id,
          status: 'active',
          revision: match.agent.revision,
        });
        if (allowed) page.push(match);
        index += 1;
      }
      more = index < result.rows.length;
      if (!more || page.length >= query.limit) break;
    }
    if (more && page.length < query.limit) throw new EnforcementServiceError(503, 'ENFORCEMENT_SCAN_BUDGET_EXCEEDED');
    const nextCursor = more && afterId
      ? encodeEnforcementCursor(pepper, {
        org: actor.organizationId,
        principal: actor.principalId,
        filter: enfFilter,
        mode: 'enforce',
        revision: context.revision,
        operation: 'discoverLocalAgents',
        at: afterId,
        id: afterId,
      }, now)
      : null;
    return { matches: page, limit: query.limit, nextCursor };
  });
}

export { ENDPOINT_ETAG, BINDING_ETAG };
