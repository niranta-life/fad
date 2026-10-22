import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { hasScope, isUuid } from '@fad/auth-core';
import { canonicalJson } from './agent-rules.js';
import { insertAudit } from './audit.js';
import { appendDirectoryEvent } from './event-outbox.js';
import { IdempotencyConflictError, beginIdempotency, requestFingerprint, writeIdempotency } from './idempotency.js';
import {
  POLICY_ACTIVE_CEILING,
  PolicyServiceError,
  decodePolicyCursor,
  encodePolicyCursor,
  evaluatePolicies,
  parseEvaluationRequest,
  parsePolicyDefinition,
  parsePolicyListQuery,
  parsePolicyPrecondition,
  policyEtag,
  resourceOf,
  type EvaluationOutcome,
  type PolicyAction,
  type PolicyDefinition,
  type PolicyRecord,
  type PolicyStatus,
  type PolicyTagPredicate,
  type StoredPolicyRule,
  type TagFact,
} from './policy-rules.js';
import { beginExclusive, enforcedActionSet, selectorsUngoverned } from './enforcement.js';
import { withTenant } from './tenant.js';
import { withTransaction } from './pool.js';

const RETENTION_MS = 24 * 60 * 60 * 1000;
const COLUMNS = `id, organization_id, name, description, effect, actions, subjects, resource_selector,
  contains_restricted_tags, status, revision, supersedes_policy_id, created_by, updated_by,
  created_at, updated_at, activated_at, disabled_at,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_exact`;

export interface PolicyActor {
  organizationId: string;
  principalId: string;
  requestId: string;
  scopes: readonly string[];
}

export interface PolicyCommandResult {
  status: 200 | 201;
  policy: PolicyRecord;
  etag: string;
  location?: string;
  replay: boolean;
}

export interface PolicyPage {
  policies: PolicyRecord[];
  limit: number;
  nextCursor: string | null;
}

export interface EvaluationResult {
  status: 200;
  body: {
    decision_id: string;
    decision: 'allow' | 'deny';
    reason_code: EvaluationOutcome['reason'];
    enforcement: 'not_enforced';
    evaluated_at: string;
    resource_revision: number;
    policy_set_digest?: string;
    input_digest?: string;
    matched_policy_count?: number;
    explanation?: Array<{ policy_id: string; revision: number; effect: 'allow' | 'deny' }>;
  };
}

interface PolicyRow {
  id: string;
  organization_id: string;
  name: string;
  description: string;
  effect: 'allow' | 'deny';
  actions: string[];
  subjects: { principal_ids: string[] };
  resource_selector: PolicyRecord['resource'];
  contains_restricted_tags: boolean;
  status: PolicyStatus;
  revision: string | number;
  supersedes_policy_id: string | null;
  created_by: string;
  updated_by: string;
  created_at: Date | string;
  updated_at: Date | string;
  activated_at: Date | string | null;
  disabled_at: Date | string | null;
  created_at_exact?: string;
}

export async function createPolicy(
  pool: Pool,
  actor: PolicyActor,
  idempotencyKey: string,
  body: unknown,
): Promise<PolicyCommandResult> {
  const definition = parsePolicyDefinition(body);
  return mutate(pool, actor, 'POST', '/v1/policies', idempotencyKey, null, body, {}, async (client) => {
    await requireActor(client, actor);
    await assertReferences(client, actor, definition);
    const id = randomUUID();
    const inserted = await client.query<PolicyRow>(
      `INSERT INTO fad_policies (
         organization_id, id, name, description, effect, actions, subjects, resource_selector,
         supersedes_policy_id, created_by, updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$10)
       RETURNING ${COLUMNS}`,
      [
        actor.organizationId, id, definition.name, definition.description, definition.effect, definition.actions,
        JSON.stringify({ principal_ids: definition.principalIds }), JSON.stringify(resourceOf(definition)),
        definition.supersedesPolicyId, actor.principalId,
      ],
    );
    const policy = toPolicy(requiredRow(inserted.rows[0]));
    await writeRevision(client, actor, policy, 'created');
    await insertAudit(client, audit(actor, 'policy.created', policy));
    return command(policy, 201);
  });
}

export async function updateDraftPolicy(
  pool: Pool,
  actor: PolicyActor,
  policyId: string,
  idempotencyKey: string,
  ifMatch: string | undefined,
  body: unknown,
): Promise<PolicyCommandResult> {
  if (!isUuid(policyId)) throw new PolicyServiceError(400, 'VALIDATION_ERROR');
  const precondition = parsePolicyPrecondition(ifMatch);
  if (precondition.kind === 'missing') throw new PolicyServiceError(428, 'PRECONDITION_REQUIRED');
  const definition = parsePolicyDefinition(body, policyId);
  return mutate(pool, actor, 'PUT', `/v1/policies/${policyId}`, idempotencyKey, ifMatch ?? null, body, {}, async (client) => {
    await requireActor(client, actor);
    const current = await lockPolicy(client, actor.organizationId, policyId);
    if (!current) throw new PolicyServiceError(404, 'NOT_FOUND');
    if (hidden(actor, current)) throw new PolicyServiceError(404, 'NOT_FOUND');
    if (current.status !== 'draft') throw new PolicyServiceError(409, 'INVALID_STATE_TRANSITION');
    if (current.revision !== precondition.revision) throw new PolicyServiceError(412, 'PRECONDITION_FAILED');
    await assertReferences(client, actor, definition);
    const updated = await client.query<PolicyRow>(
      `UPDATE fad_policies SET
         name = $3, description = $4, effect = $5, actions = $6, subjects = $7::jsonb,
         resource_selector = $8::jsonb, supersedes_policy_id = $9, revision = revision + 1,
         updated_by = $10, updated_at = transaction_timestamp()
       WHERE organization_id = $1 AND id = $2 AND status = 'draft' AND revision = $11
       RETURNING ${COLUMNS}`,
      [
        actor.organizationId, policyId, definition.name, definition.description, definition.effect, definition.actions,
        JSON.stringify({ principal_ids: definition.principalIds }), JSON.stringify(resourceOf(definition)),
        definition.supersedesPolicyId, actor.principalId, precondition.revision,
      ],
    );
    const policy = toPolicy(requiredRow(updated.rows[0]));
    await writeRevision(client, actor, policy, 'draft_updated');
    await insertAudit(client, audit(actor, 'policy.draft_updated', policy));
    return command(policy, 200);
  });
}

export async function activatePolicy(
  pool: Pool,
  actor: PolicyActor,
  policyId: string,
  idempotencyKey: string,
  ifMatch: string | undefined,
): Promise<PolicyCommandResult> {
  return transition(pool, actor, policyId, idempotencyKey, ifMatch, 'active');
}

export async function disablePolicy(
  pool: Pool,
  actor: PolicyActor,
  policyId: string,
  idempotencyKey: string,
  ifMatch: string | undefined,
): Promise<PolicyCommandResult> {
  return transition(pool, actor, policyId, idempotencyKey, ifMatch, 'disabled');
}

export async function getPolicy(pool: Pool, actor: PolicyActor, policyId: string): Promise<{ policy: PolicyRecord; etag: string }> {
  if (!isUuid(policyId)) throw new PolicyServiceError(400, 'VALIDATION_ERROR');
  return withTenant(pool, actor.organizationId, async (client) => {
    await requireActor(client, actor);
    const result = await client.query<PolicyRow>(
      `SELECT ${COLUMNS} FROM fad_policies WHERE organization_id = $1 AND id = $2`,
      [actor.organizationId, policyId],
    );
    const row = result.rows[0];
    if (!row) throw new PolicyServiceError(404, 'NOT_FOUND');
    const policy = toPolicy(row);
    if (hidden(actor, policy)) throw new PolicyServiceError(404, 'NOT_FOUND');
    return { policy, etag: policyEtag(policy.revision) };
  });
}

export async function listPolicies(
  pool: Pool,
  actor: PolicyActor,
  queryInput: unknown,
  pepper: Buffer,
): Promise<PolicyPage> {
  const query = parsePolicyListQuery(queryInput);
  const restricted = hasScope(actor.scopes, 'tags:restricted:read');
  const cursor = query.cursor
    ? decodePolicyCursor(pepper, query.cursor, { org: actor.organizationId, status: query.status, restricted })
    : null;
  return withTenant(pool, actor.organizationId, async (client) => {
    await requireActor(client, actor);
    const result = await client.query<PolicyRow>(
      `SELECT ${COLUMNS} FROM fad_policies
       WHERE organization_id = $1
         AND ($2::text IS NULL OR status = $2)
         AND ($3::boolean OR NOT contains_restricted_tags)
         AND ($4::text IS NULL OR to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') < $4
              OR (to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') = $4 AND id < $5::uuid))
       ORDER BY created_at DESC, id DESC
       LIMIT $6`,
      [actor.organizationId, query.status, restricted, cursor?.at ?? null, cursor?.id ?? null, query.limit + 1],
    );
    const page = result.rows.slice(0, query.limit).map((row) => toPolicy(row));
    const extra = result.rows[query.limit];
    const last = page[page.length - 1];
    const nextCursor = extra && last
      ? encodePolicyCursor(pepper, {
        org: actor.organizationId,
        status: query.status,
        restricted,
        at: result.rows[query.limit - 1]?.created_at_exact ?? '',
        id: last.id,
      })
      : null;
    return { policies: page, limit: query.limit, nextCursor };
  });
}

export async function evaluateAgentAccess(pool: Pool, actor: PolicyActor, body: unknown): Promise<EvaluationResult> {
  const request = parseEvaluationRequest(body);
  if (!isUuid(actor.requestId)) throw new PolicyServiceError(503, 'DEPENDENCY_UNAVAILABLE');
  const self = request.subjectId === actor.principalId;
  const any = hasScope(actor.scopes, 'policies:evaluate:any');
  const own = hasScope(actor.scopes, 'policies:evaluate:self');
  if (!hasScope(actor.scopes, 'agents:read') || (!any && !(self && own))) {
    throw new PolicyServiceError(403, 'FORBIDDEN');
  }
  try {
    return await withRepeatableTenant(pool, actor.organizationId, async (client) => {
      await requireActor(client, actor);
      const org = await client.query<{ status: string }>(
        'SELECT status FROM organizations WHERE id = $1',
        [actor.organizationId],
      );
      const principal = await client.query<{ status: string }>(
        'SELECT status FROM principals WHERE organization_id = $1 AND id = $2',
        [actor.organizationId, request.subjectId],
      );
      if (!principal.rows[0]) throw new PolicyServiceError(404, 'NOT_FOUND');
      const agent = await client.query<{ status: 'active' | 'suspended' | 'retired'; revision: string | number }>(
        'SELECT status, revision FROM agents WHERE organization_id = $1 AND id = $2',
        [actor.organizationId, request.agentId],
      );
      const agentRow = agent.rows[0];
      if (!agentRow) throw new PolicyServiceError(404, 'NOT_FOUND');
      const activeCount = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM fad_policies WHERE organization_id = $1 AND status = 'active'`,
        [actor.organizationId],
      );
      const count = Number(activeCount.rows[0]?.n ?? '0');
      const loaded = await client.query<PolicyRow>(
        `SELECT ${COLUMNS} FROM fad_policies WHERE organization_id = $1 AND status = 'active' ORDER BY id`,
        [actor.organizationId],
      );
      const policies = loaded.rows.map((row) => storedRule(row));
      const tags = await client.query<{
        namespace: string;
        tag_key: string;
        tag_value: unknown;
        revision: string | number;
        is_deleted: boolean;
      }>(
        `SELECT namespace, tag_key, tag_value, revision, is_deleted
         FROM agent_tag_assignments WHERE organization_id = $1 AND agent_id = $2`,
        [actor.organizationId, request.agentId],
      );
      const facts: TagFact[] = tags.rows.map((row) => ({
        namespace: row.namespace,
        key: row.tag_key,
        value: row.tag_value,
        revision: numberOf(row.revision),
        deleted: row.is_deleted,
      }));
      const orgActive = org.rows[0]?.status === 'active';
      const outcome = evaluatePolicies({
        organizationId: actor.organizationId,
        subjectId: request.subjectId,
        subjectActive: orgActive && principal.rows[0]?.status === 'active',
        action: request.action,
        agentId: request.agentId,
        agentStatus: agentRow.status,
        agentRevision: numberOf(agentRow.revision),
        activeCount: count,
        policies,
        tags: facts,
      });
      const decisionId = randomUUID();
      let written: { evaluated_at: Date | string } | undefined;
      try {
        const inserted = await client.query<{ evaluated_at: Date | string }>(
          `INSERT INTO fad_policy_decisions (
             organization_id, id, caller_principal_id, subject_principal_id, agent_id, action,
             decision, reason_code, policy_set_digest, input_digest, agent_revision,
             matched_policy_count, request_id
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           RETURNING evaluated_at`,
          [
            actor.organizationId, decisionId, actor.principalId, request.subjectId, request.agentId, request.action,
            outcome.decision === 'allow', outcome.reason, outcome.policySetDigest, outcome.inputDigest,
            numberOf(agentRow.revision), outcome.matched.length, actor.requestId,
          ],
        );
        written = inserted.rows[0];
      } catch {
        throw new PolicyServiceError(503, 'DEPENDENCY_UNAVAILABLE');
      }
      if (!written) throw new PolicyServiceError(503, 'DEPENDENCY_UNAVAILABLE');
      const explain = canExplain(actor, outcome);
      const response: EvaluationResult['body'] = {
        decision_id: decisionId,
        decision: outcome.decision,
        reason_code: outcome.reason,
        enforcement: 'not_enforced',
        evaluated_at: asTime(written.evaluated_at),
        resource_revision: numberOf(agentRow.revision),
      };
      if (explain) {
        response.policy_set_digest = outcome.policySetDigest;
        response.input_digest = outcome.inputDigest;
        response.matched_policy_count = outcome.matched.length;
        response.explanation = outcome.matched.map((item) => ({
          policy_id: item.policy_id,
          revision: item.revision,
          effect: item.effect,
        }));
      }
      return { status: 200, body: response };
    });
  } catch (error) {
    if (error instanceof PolicyServiceError) throw error;
    throw new PolicyServiceError(503, 'DEPENDENCY_UNAVAILABLE');
  }
}

async function transition(
  pool: Pool,
  actor: PolicyActor,
  policyId: string,
  idempotencyKey: string,
  ifMatch: string | undefined,
  next: 'active' | 'disabled',
): Promise<PolicyCommandResult> {
  if (!isUuid(policyId)) throw new PolicyServiceError(400, 'VALIDATION_ERROR');
  const precondition = parsePolicyPrecondition(ifMatch);
  if (precondition.kind === 'missing') throw new PolicyServiceError(428, 'PRECONDITION_REQUIRED');
  const path = `/v1/policies/${policyId}/${next === 'active' ? 'activate' : 'disable'}`;
  return mutate(pool, actor, 'POST', path, idempotencyKey, ifMatch ?? null, null, { exclusive: true }, async (client) => {
    await requireActor(client, actor);
    if (next === 'active') {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`fad-policy-active:${actor.organizationId}`]);
    }
    const current = await lockPolicy(client, actor.organizationId, policyId);
    if (!current) throw new PolicyServiceError(404, 'NOT_FOUND');
    if (hidden(actor, current)) throw new PolicyServiceError(404, 'NOT_FOUND');
    if (current.revision !== precondition.revision) throw new PolicyServiceError(412, 'PRECONDITION_FAILED');
    if (next === 'active' && current.status !== 'draft') throw new PolicyServiceError(409, 'INVALID_STATE_TRANSITION');
    if (next === 'disabled' && current.status !== 'active') throw new PolicyServiceError(409, 'INVALID_STATE_TRANSITION');
    if (next === 'active') {
      const enforced = await enforcedActionSet(client, actor.organizationId);
      if (enforced && enforced.length > 0) {
        const definition = definitionFrom(current);
        const ungoverned = await selectorsUngoverned(client, actor.organizationId, [{
          id: current.id,
          revision: current.revision,
          effect: definition.effect,
          actions: definition.actions,
          principalIds: definition.principalIds,
          agentIds: definition.agentIds,
          tagsAll: definition.tagsAll,
          containsRestricted: current.contains_restricted_tags,
        }], enforced);
        if (ungoverned) throw new PolicyServiceError(409, 'CONFLICT');
      }
      await assertReferences(client, actor, definitionFrom(current));
      const count = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM fad_policies WHERE organization_id = $1 AND status = 'active'`,
        [actor.organizationId],
      );
      if (Number(count.rows[0]?.n ?? '0') >= POLICY_ACTIVE_CEILING) throw new PolicyServiceError(409, 'CONFLICT');
    }
    const updated = await client.query<PolicyRow>(
      next === 'active'
        ? `UPDATE fad_policies SET status = 'active', revision = revision + 1,
             activated_at = transaction_timestamp(), updated_by = $3, updated_at = transaction_timestamp()
           WHERE organization_id = $1 AND id = $2 AND status = 'draft' AND revision = $4
           RETURNING ${COLUMNS}`
        : `UPDATE fad_policies SET status = 'disabled', revision = revision + 1,
             disabled_at = transaction_timestamp(), updated_by = $3, updated_at = transaction_timestamp()
           WHERE organization_id = $1 AND id = $2 AND status = 'active' AND revision = $4
           RETURNING ${COLUMNS}`,
      [actor.organizationId, policyId, actor.principalId, precondition.revision],
    );
    const policy = toPolicy(requiredRow(updated.rows[0]));
    await writeRevision(client, actor, policy, next === 'active' ? 'activated' : 'disabled');
    await insertAudit(client, audit(actor, next === 'active' ? 'policy.activated' : 'policy.disabled', policy));
    await appendDirectoryEvent(client, {
      organizationId: actor.organizationId,
      eventType: 'com.fad.policy.lifecycle_changed.v1',
      subject: `policy/${policy.id}`,
      aggregateType: 'policy',
      aggregateId: policy.id,
      aggregateRevision: policy.revision,
      visibility: 'restricted',
      payload: { policy_id: policy.id, revision: policy.revision, status: policy.status },
      requestId: actor.requestId,
    });
    return command(policy, 200);
  });
}

async function mutate(
  pool: Pool,
  actor: PolicyActor,
  method: 'POST' | 'PUT',
  path: string,
  idempotencyKey: string,
  ifMatch: string | null,
  body: unknown,
  options: { exclusive?: boolean },
  fn: (client: PoolClient) => Promise<PolicyCommandResult>,
): Promise<PolicyCommandResult> {
  const fingerprint = requestFingerprint(method, path, canonicalJson({ body, if_match: ifMatch }));
  return withTenant(pool, actor.organizationId, async (client) => {
    try {
      if (options.exclusive) await beginExclusive(client, actor.organizationId);
      const claim = await beginIdempotency(client, {
        organizationId: actor.organizationId,
        principalId: actor.principalId,
        method,
        resourcePath: path,
        idemKey: idempotencyKey,
        requestSha256: fingerprint,
      });
      if (claim.kind === 'replay') {
        const replayed = replay(claim.responseStatus, claim.responseBody, claim.responseHeaders);
        if (hidden(actor, replayed.policy)) throw new PolicyServiceError(404, 'NOT_FOUND');
        return replayed;
      }
      const result = await fn(client);
      await writeIdempotency(client, {
        organizationId: actor.organizationId,
        principalId: actor.principalId,
        method,
        resourcePath: path,
        idemKey: idempotencyKey,
        requestSha256: fingerprint,
        responseStatus: result.status,
        responseHeaders: result.location ? { etag: result.etag, location: result.location } : { etag: result.etag },
        responseBody: result.policy,
        expiresAt: new Date(Date.now() + RETENTION_MS),
      });
      return result;
    } catch (error) {
      if (error instanceof PolicyServiceError || error instanceof IdempotencyConflictError) throw error;
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code === '23503' || code === '23514') throw new PolicyServiceError(422, 'VALIDATION_ERROR');
      throw new PolicyServiceError(503, 'DEPENDENCY_UNAVAILABLE');
    }
  });
}

async function assertReferences(client: PoolClient, actor: PolicyActor, definition: PolicyDefinition): Promise<void> {
  const principals = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM principals WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
    [actor.organizationId, definition.principalIds],
  );
  if (Number(principals.rows[0]?.n ?? '0') !== definition.principalIds.length) {
    throw new PolicyServiceError(422, 'VALIDATION_ERROR');
  }
  if (definition.agentIds) {
    const agents = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM agents WHERE organization_id = $1 AND id = ANY($2::uuid[])`,
      [actor.organizationId, definition.agentIds],
    );
    if (Number(agents.rows[0]?.n ?? '0') !== definition.agentIds.length) throw new PolicyServiceError(422, 'VALIDATION_ERROR');
  }
  if (definition.supersedesPolicyId) {
    const prior = await client.query(
      'SELECT 1 FROM fad_policies WHERE organization_id = $1 AND id = $2',
      [actor.organizationId, definition.supersedesPolicyId],
    );
    if ((prior.rowCount ?? 0) !== 1) throw new PolicyServiceError(422, 'VALIDATION_ERROR');
  }
  let restricted = false;
  for (const predicate of definition.tagsAll ?? []) {
    const found = await client.query<{ value_type: string; enum_values: string[] | null; governed: boolean; visibility: string }>(
      `SELECT value_type, enum_values, governed, visibility FROM tag_definitions
       WHERE organization_id = $1 AND namespace = $2 AND tag_key = $3`,
      [actor.organizationId, predicate.namespace, predicate.key],
    );
    const definitionRow = found.rows[0];
    if (!definitionRow || !valueMatches(definitionRow, predicate)) throw new PolicyServiceError(422, 'VALIDATION_ERROR');
    restricted = restricted || definitionRow.governed || definitionRow.visibility === 'restricted';
  }
  if (restricted && !hasScope(actor.scopes, 'tags:restricted:read')) throw new PolicyServiceError(403, 'FORBIDDEN');
}

function valueMatches(
  definition: { value_type: string; enum_values: string[] | null },
  predicate: PolicyTagPredicate,
): boolean {
  if (definition.value_type === 'string') return typeof predicate.value === 'string';
  if (definition.value_type === 'enum') return typeof predicate.value === 'string' && (definition.enum_values ?? []).includes(predicate.value);
  if (definition.value_type === 'integer') return typeof predicate.value === 'number';
  if (definition.value_type === 'boolean') return typeof predicate.value === 'boolean';
  return false;
}

async function requireActor(client: PoolClient, actor: PolicyActor): Promise<void> {
  const result = await client.query<{ status: string | null }>(
    'SELECT fad_lock_principal($1, $2) AS status',
    [actor.organizationId, actor.principalId],
  );
  if (result.rows[0]?.status !== 'active') throw new PolicyServiceError(401, 'VALIDATION_ERROR');
}

async function lockPolicy(client: PoolClient, organizationId: string, policyId: string): Promise<PolicyRecord | null> {
  const result = await client.query<PolicyRow>(
    `SELECT ${COLUMNS} FROM fad_policies WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
    [organizationId, policyId],
  );
  const row = result.rows[0];
  return row ? toPolicy(row) : null;
}

function withRepeatableTenant<T>(pool: Pool, organizationId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  if (!isUuid(organizationId)) throw new PolicyServiceError(503, 'DEPENDENCY_UNAVAILABLE');
  return withTransaction(pool, fn, async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await client.query(`SELECT set_config('fad.org_id', $1, true)`, [organizationId]);
    if (process.env.FAD_ENFORCEMENT_CODE_ENABLED === 'true') {
      await client.query(`SELECT set_config('fad.pep_generation', '6', true)`);
    }
  });
}

async function writeRevision(
  client: PoolClient,
  actor: PolicyActor,
  policy: PolicyRecord,
  operation: 'created' | 'draft_updated' | 'activated' | 'disabled',
): Promise<void> {
  await client.query(
    `INSERT INTO fad_policy_revisions (organization_id, policy_id, revision, operation, snapshot, actor_principal_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [actor.organizationId, policy.id, policy.revision, operation, JSON.stringify(policy), actor.principalId],
  );
}

function audit(actor: PolicyActor, action: string, policy: PolicyRecord) {
  return {
    organizationId: actor.organizationId,
    actorPrincipalId: actor.principalId,
    action,
    targetType: 'policy',
    targetId: policy.id,
    outcome: 'success' as const,
    requestId: actor.requestId,
    details: { policy_id: policy.id, revision: policy.revision, status: policy.status },
  };
}

function command(policy: PolicyRecord, status: 200 | 201): PolicyCommandResult {
  const result: PolicyCommandResult = { status, policy, etag: policyEtag(policy.revision), replay: false };
  if (status === 201) result.location = `/v1/policies/${policy.id}`;
  return result;
}

function replay(status: number, body: unknown, headers: Record<string, string>): PolicyCommandResult {
  if ((status !== 200 && status !== 201) || body === null || typeof body !== 'object') {
    throw new PolicyServiceError(503, 'DEPENDENCY_UNAVAILABLE');
  }
  const policy = body as PolicyRecord;
  const result: PolicyCommandResult = {
    status,
    policy,
    etag: headers.etag ?? policyEtag(policy.revision),
    replay: true,
  };
  if (headers.location) result.location = headers.location;
  return result;
}

function hidden(actor: PolicyActor, policy: PolicyRecord): boolean {
  return policy.contains_restricted_tags && !hasScope(actor.scopes, 'tags:restricted:read');
}

function canExplain(actor: PolicyActor, outcome: EvaluationOutcome): boolean {
  if (!hasScope(actor.scopes, 'policies:explain')) return false;
  if (outcome.consideredRestricted && !hasScope(actor.scopes, 'tags:restricted:read')) return false;
  return true;
}

function definitionFrom(policy: PolicyRecord): PolicyDefinition {
  return parsePolicyDefinition({
    name: policy.name,
    description: policy.description,
    effect: policy.effect,
    actions: policy.actions,
    subjects: policy.subjects,
    resource: policy.resource,
    supersedes_policy_id: policy.supersedes_policy_id,
  }, policy.id);
}

function storedRule(row: PolicyRow): StoredPolicyRule {
  try {
    const definition = definitionFrom(toPolicy(row));
    return {
      id: row.id,
      revision: numberOf(row.revision),
      effect: definition.effect,
      actions: definition.actions,
      principalIds: definition.principalIds,
      agentIds: definition.agentIds,
      tagsAll: definition.tagsAll,
      containsRestricted: row.contains_restricted_tags,
    };
  } catch (error) {
    if (error instanceof PolicyServiceError && error.status === 503) throw error;
    throw new PolicyServiceError(503, 'DEPENDENCY_UNAVAILABLE');
  }
}

function toPolicy(row: PolicyRow): PolicyRecord {
  return {
    id: row.id,
    organization_id: row.organization_id,
    name: row.name,
    description: row.description,
    effect: row.effect,
    actions: row.actions as PolicyAction[],
    subjects: row.subjects,
    resource: row.resource_selector,
    status: row.status,
    revision: numberOf(row.revision),
    contains_restricted_tags: row.contains_restricted_tags,
    supersedes_policy_id: row.supersedes_policy_id,
    created_at: asTime(row.created_at),
    updated_at: asTime(row.updated_at),
    activated_at: row.activated_at ? asTime(row.activated_at) : null,
    disabled_at: row.disabled_at ? asTime(row.disabled_at) : null,
    created_by: row.created_by,
    updated_by: row.updated_by,
  };
}

function numberOf(value: string | number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new PolicyServiceError(503, 'DEPENDENCY_UNAVAILABLE');
  return parsed;
}

function asTime(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new PolicyServiceError(503, 'DEPENDENCY_UNAVAILABLE');
  return date.toISOString();
}

function requiredRow(row: PolicyRow | undefined): PolicyRow {
  if (!row) throw new PolicyServiceError(503, 'DEPENDENCY_UNAVAILABLE');
  return row;
}
