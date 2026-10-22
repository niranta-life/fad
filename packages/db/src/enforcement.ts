import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { hasScope, isUuid } from '@fad/auth-core';
import type { ErrorCode } from '@fad/contract';
import { insertAudit } from './audit.js';
import { appendDirectoryEvent } from './event-outbox.js';
import { canonicalJson, codePointLength } from './agent-rules.js';
import { beginIdempotency, requestFingerprint, writeIdempotency } from './idempotency.js';
import {
  POLICY_ACTIVE_CEILING,
  evaluatePolicies,
  parsePolicyDefinition,
  type PolicyAction,
  type StoredPolicyRule,
  type TagFact,
} from './policy-rules.js';
import { withTenant } from './tenant.js';

export const ENFORCEMENT_MIGRATION_VERSION = '20261021_006_policy_enforcement';
export const ENFORCEABLE_ACTIONS = ['agent.read', 'agent.discover', 'agent.update', 'agent.suspend'] as const;
export type EnforceableAction = (typeof ENFORCEABLE_ACTIONS)[number];
export type EnforcementMode = 'off' | 'shadow' | 'enforce';
export type EnforcementChannel = 'rest' | 'mcp';

const ACTION_SET = new Set<string>(ENFORCEABLE_ACTIONS);
const CURSOR_TTL_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 24 * 60 * 60 * 1000;

/** Fixed coverage. A unit test fails when a new agent child route is missing. */
export const PROTECTED_OPERATIONS: readonly {
  operationId: string;
  actions: readonly EnforceableAction[];
  effect: 'read' | 'write' | 'collection';
}[] = [
  { operationId: 'getAgent', actions: ['agent.read'], effect: 'read' },
  { operationId: 'listAgents', actions: ['agent.discover', 'agent.read'], effect: 'collection' },
  { operationId: 'searchAgentsByTags', actions: ['agent.discover', 'agent.read'], effect: 'collection' },
  { operationId: 'discoverLocalAgents', actions: ['agent.discover', 'agent.read'], effect: 'collection' },
  { operationId: 'updateAgent', actions: ['agent.update'], effect: 'write' },
  { operationId: 'suspendAgent', actions: ['agent.suspend'], effect: 'write' },
  { operationId: 'activateAgent', actions: ['agent.update'], effect: 'write' },
  { operationId: 'retireAgent', actions: ['agent.update'], effect: 'write' },
  { operationId: 'listAgentTags', actions: ['agent.read'], effect: 'read' },
  { operationId: 'getAgentTag', actions: ['agent.read'], effect: 'read' },
  { operationId: 'putAgentTag', actions: ['agent.update'], effect: 'write' },
  { operationId: 'deleteAgentTag', actions: ['agent.update'], effect: 'write' },
  { operationId: 'listAgentEndpoints', actions: ['agent.read'], effect: 'read' },
  { operationId: 'getAgentEndpoint', actions: ['agent.read'], effect: 'read' },
  { operationId: 'putAgentEndpoint', actions: ['agent.update'], effect: 'write' },
  { operationId: 'deleteAgentEndpoint', actions: ['agent.update'], effect: 'write' },
  { operationId: 'listAgentCapabilityBindings', actions: ['agent.read'], effect: 'read' },
  { operationId: 'getAgentCapabilityBinding', actions: ['agent.read'], effect: 'read' },
  { operationId: 'putAgentCapabilityBinding', actions: ['agent.update'], effect: 'write' },
  { operationId: 'deleteAgentCapabilityBinding', actions: ['agent.update'], effect: 'write' },
];

const OPERATION_INDEX = new Map(PROTECTED_OPERATIONS.map((item) => [item.operationId, item]));

export const EXCLUDED_OPERATIONS = ['registerAgent'] as const;

export function enforcementCodeEnabled(): boolean {
  return process.env.FAD_ENFORCEMENT_CODE_ENABLED === 'true';
}

export class EnforcementServiceError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;

  constructor(statusCode: number, code: ErrorCode) {
    super(code);
    this.name = 'EnforcementServiceError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** The surrounding transaction commits, then the denial is returned. */
export class CommittedDenial extends Error {
  readonly commitBeforeThrow = true;
  readonly statusCode: number;
  readonly code: ErrorCode;

  constructor(statusCode: number, code: ErrorCode) {
    super(code);
    this.name = 'CommittedDenial';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface EnforcementCaller {
  organizationId: string;
  principalId: string;
  requestId: string;
  scopes: readonly string[];
  channel?: EnforcementChannel;
}

export interface EnforcementConfig {
  organization_id: string;
  mode: EnforcementMode;
  actions: EnforceableAction[];
  revision: number;
  updated_by: string | null;
  updated_at: string | null;
}

export interface EnforcementPreflight {
  preflight_id: string;
  mode: 'shadow' | 'enforce';
  actions: EnforceableAction[];
  passes: boolean;
  blockers: string[];
  warnings: string[];
  policy_snapshot_digest: string;
  expires_at: string;
}

export interface EnforcementDecisionView {
  id: string;
  request_id: string;
  agent_id: string;
  actor_principal_id: string;
  operation_id: string;
  action: EnforceableAction;
  channel: EnforcementChannel;
  mode: 'shadow' | 'enforce';
  outcome: 'allowed' | 'denied' | 'would_allow' | 'would_deny';
  reason_code: string;
  policy_decision_id: string | null;
  happened_at: string;
}

interface ConfigRow {
  mode: EnforcementMode;
  actions: string[] | null;
  revision: string | number;
  updated_by: string;
  updated_at: Date | string;
}

interface PolicyRow {
  id: string;
  revision: string | number;
  name: string;
  description: string;
  effect: 'allow' | 'deny';
  actions: string[];
  subjects: { principal_ids?: string[] };
  resource_selector: { type?: string; agent_ids?: string[]; tags_all?: Array<{ namespace: string; key: string; operator: 'eq'; value: unknown }> };
  contains_restricted_tags: boolean;
  supersedes_policy_id: string | null;
}

interface EvalContext {
  mode: 'shadow' | 'enforce';
  actions: EnforceableAction[];
  revision: number;
  rules: StoredPolicyRule[];
  activeCount: number;
  subjectActive: boolean;
}

export function enforcementEtag(revision: number): string {
  return `"enforcement-v${revision}"`;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function asTime(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function asRevision(value: string | number): number {
  const revision = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new EnforcementServiceError(503, 'DEPENDENCY_UNAVAILABLE');
  return revision;
}

function channelOf(caller: EnforcementCaller): EnforcementChannel {
  return caller.channel === 'mcp' ? 'mcp' : 'rest';
}

function pgCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : '';
  }
  return '';
}

function lockTimeoutMs(): number {
  const raw = process.env.FAD_ENFORCEMENT_LOCK_TIMEOUT_MS;
  const value = raw === undefined || raw === '' ? 2000 : Number(raw);
  if (!Number.isInteger(value) || value < 100 || value > 10000) return 2000;
  return value;
}

export function enforcementScanLimit(): number {
  const raw = process.env.FAD_ENFORCEMENT_SCAN_LIMIT;
  const value = raw === undefined || raw === '' ? 5000 : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 5000) return 5000;
  return value;
}

function alert(code: string): void {
  console.error(code);
}

export async function acquireFence(
  client: PoolClient,
  organizationId: string,
  mode: 'share' | 'exclusive',
): Promise<'held' | 'timeout'> {
  const current = await client.query<{ v: string | null }>(`SELECT current_setting('fad.s6_fence', true) AS v`);
  const held = current.rows[0]?.v ?? '';
  if (held === 'exclusive' || (held === 'share' && mode === 'share')) return 'held';
  await client.query('SAVEPOINT fad_s6_fence');
  try {
    await client.query(`SELECT set_config('lock_timeout', $1, true)`, [`${lockTimeoutMs()}ms`]);
    const sql = mode === 'exclusive'
      ? `SELECT pg_advisory_xact_lock(6816, fad_s6_enforcement_key($1::uuid))`
      : `SELECT pg_advisory_xact_lock_shared(6816, fad_s6_enforcement_key($1::uuid))`;
    await client.query(sql, [organizationId]);
    await client.query(`SELECT set_config('fad.s6_fence', $1, true)`, [mode === 'exclusive' ? 'exclusive' : 'share']);
    await client.query('RELEASE SAVEPOINT fad_s6_fence');
    return 'held';
  } catch (error) {
    try {
      await client.query('ROLLBACK TO SAVEPOINT fad_s6_fence');
    } catch {
      alert('ENFORCEMENT_LOCK_FAILED');
      throw new EnforcementServiceError(503, 'DEPENDENCY_UNAVAILABLE');
    }
    const code = pgCode(error);
    if (code === '55P03' || code === '40P01' || code === '57014') {
      alert('ENFORCEMENT_LOCK_FAILED');
      return 'timeout';
    }
    alert('ENFORCEMENT_DEPENDENCY_FAILED');
    throw new EnforcementServiceError(503, 'DEPENDENCY_UNAVAILABLE');
  }
}

/**
 * Shared fence for a protected read or mutation.
 * A timeout is 503 in every mode. Reading the mode without the fence can
 * observe OFF or SHADOW and then commit after another transaction enables ENFORCE.
 */
export async function beginShared(client: PoolClient, organizationId: string): Promise<void> {
  if (!enforcementCodeEnabled()) return;
  const fence = await acquireFence(client, organizationId, 'share');
  if (fence !== 'held') throw new EnforcementServiceError(503, 'DEPENDENCY_UNAVAILABLE');
}

/**
 * Exclusive fence for config, policy status, and tag writes.
 * A timeout is 503 in every mode and does not skip the policy or tag guard.
 */
export async function beginExclusive(client: PoolClient, organizationId: string): Promise<void> {
  if (!enforcementCodeEnabled()) return;
  const fence = await acquireFence(client, organizationId, 'exclusive');
  if (fence !== 'held') throw new EnforcementServiceError(503, 'DEPENDENCY_UNAVAILABLE');
}

/** Actions currently selected while the tenant is in ENFORCE. Null otherwise. */
export async function enforcedActionSet(client: PoolClient, organizationId: string): Promise<readonly string[] | null> {
  if (!enforcementCodeEnabled()) return null;
  const config = await readConfig(client, organizationId);
  if (config.mode !== 'enforce') return null;
  return config.actions;
}

async function readConfig(client: PoolClient, organizationId: string): Promise<EnforcementConfig> {
  const result = await client.query<ConfigRow>(
    `SELECT mode, actions, revision, updated_by, updated_at
     FROM fad_enforcement_configs WHERE organization_id = $1`,
    [organizationId],
  );
  const row = result.rows[0];
  if (!row) {
    return {
      organization_id: organizationId,
      mode: 'off',
      actions: [],
      revision: 0,
      updated_by: null,
      updated_at: null,
    };
  }
  return {
    organization_id: organizationId,
    mode: row.mode,
    actions: (row.actions ?? []).filter((item): item is EnforceableAction => ACTION_SET.has(item)),
    revision: asRevision(row.revision),
    updated_by: row.updated_by,
    updated_at: asTime(row.updated_at),
  };
}

function ruleFrom(row: PolicyRow): StoredPolicyRule | 'invalid' {
  try {
    const definition = parsePolicyDefinition({
      name: row.name,
      description: row.description,
      effect: row.effect,
      actions: row.actions,
      subjects: row.subjects,
      resource: row.resource_selector,
      supersedes_policy_id: row.supersedes_policy_id,
    }, row.id);
    return {
      id: row.id,
      revision: asRevision(row.revision),
      effect: definition.effect,
      actions: definition.actions,
      principalIds: definition.principalIds,
      agentIds: definition.agentIds,
      tagsAll: definition.tagsAll,
      containsRestricted: row.contains_restricted_tags,
    };
  } catch {
    return 'invalid';
  }
}

async function loadRules(client: PoolClient, organizationId: string): Promise<{ rules: StoredPolicyRule[]; invalid: boolean; count: number }> {
  const counted = await client.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM fad_policies WHERE organization_id = $1 AND status = 'active'`,
    [organizationId],
  );
  const count = Number(counted.rows[0]?.n ?? '0');
  const loaded = await client.query<PolicyRow>(
    `SELECT id, revision, name, description, effect, actions, subjects, resource_selector,
            contains_restricted_tags, supersedes_policy_id
     FROM fad_policies WHERE organization_id = $1 AND status = 'active' ORDER BY id`,
    [organizationId],
  );
  const rules: StoredPolicyRule[] = [];
  let invalid = count > POLICY_ACTIVE_CEILING;
  for (const row of loaded.rows) {
    const rule = ruleFrom(row);
    if (rule === 'invalid') invalid = true;
    else rules.push(rule);
  }
  return { rules, invalid, count };
}

export function snapshotDigest(rules: readonly StoredPolicyRule[]): string {
  const body = rules.map((rule) => ({
    id: rule.id,
    revision: rule.revision,
    definition: sha256(canonicalJson({
      effect: rule.effect,
      actions: [...rule.actions].sort(),
      principals: [...rule.principalIds].sort(),
      agents: rule.agentIds ? [...rule.agentIds].sort() : null,
      tags: rule.tagsAll,
    })),
  })).sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return sha256(canonicalJson(body));
}

async function subjectActive(client: PoolClient, organizationId: string, principalId: string): Promise<boolean> {
  const org = await client.query<{ status: string }>(`SELECT status FROM organizations WHERE id = $1`, [organizationId]);
  const principal = await client.query<{ status: string }>(
    `SELECT status FROM principals WHERE organization_id = $1 AND id = $2`,
    [organizationId, principalId],
  );
  return org.rows[0]?.status === 'active' && principal.rows[0]?.status === 'active';
}

export async function loadEvalContext(
  client: PoolClient,
  caller: EnforcementCaller,
  operationId: string,
): Promise<EvalContext | null> {
  if (!enforcementCodeEnabled()) return null;
  const operation = OPERATION_INDEX.get(operationId);
  if (!operation) return null;
  const config = await readConfig(client, caller.organizationId);
  if (config.mode === 'off') return null;
  const actions = operation.actions.filter((action) => config.actions.includes(action));
  if (actions.length === 0) return null;
  const loaded = await loadRules(client, caller.organizationId);
  if (loaded.invalid || loaded.count > POLICY_ACTIVE_CEILING) {
    if (config.mode === 'enforce') throw new EnforcementServiceError(503, 'DEPENDENCY_UNAVAILABLE');
    alert('ENFORCEMENT_SHADOW_EVALUATION_FAILED');
    return null;
  }
  return {
    mode: config.mode,
    actions,
    revision: config.revision,
    rules: loaded.rules,
    activeCount: loaded.count,
    subjectActive: await subjectActive(client, caller.organizationId, caller.principalId),
  };
}

async function tagFacts(client: PoolClient, organizationId: string, agentId: string): Promise<TagFact[]> {
  const tags = await client.query<{
    namespace: string;
    tag_key: string;
    tag_value: unknown;
    revision: string | number;
    is_deleted: boolean;
  }>(
    `SELECT namespace, tag_key, tag_value, revision, is_deleted
     FROM agent_tag_assignments WHERE organization_id = $1 AND agent_id = $2`,
    [organizationId, agentId],
  );
  return tags.rows.map((row) => ({
    namespace: row.namespace,
    key: row.tag_key,
    value: row.tag_value,
    revision: asRevision(row.revision),
    deleted: row.is_deleted,
  }));
}

function failEvaluation(mode: 'shadow' | 'enforce'): 'shadow' {
  if (mode === 'enforce') throw new EnforcementServiceError(503, 'DEPENDENCY_UNAVAILABLE');
  alert('ENFORCEMENT_SHADOW_EVALUATION_FAILED');
  return 'shadow';
}

async function recordAction(
  client: PoolClient,
  caller: EnforcementCaller,
  context: EvalContext,
  operationId: string,
  agent: { id: string; status: 'active' | 'suspended' | 'retired'; revision: number },
  action: EnforceableAction,
  tags: TagFact[],
): Promise<'allow' | 'deny' | 'shadow'> {
  if (process.env.FAD_ENFORCEMENT_FAIL_EVALUATION === 'true') return failEvaluation(context.mode);
  if (!isUuid(caller.requestId)) return failEvaluation(context.mode);
  const save = context.mode === 'shadow';
  if (save) await client.query('SAVEPOINT fad_s6_decision');
  try {
    const outcome = evaluatePolicies({
      organizationId: caller.organizationId,
      subjectId: caller.principalId,
      subjectActive: context.subjectActive,
      action: action as PolicyAction,
      agentId: agent.id,
      agentStatus: agent.status,
      agentRevision: agent.revision,
      activeCount: context.activeCount,
      policies: context.rules,
      tags,
    });
    const policyDecisionId = randomUUID();
    const enforcementId = randomUUID();
    if (process.env.FAD_ENFORCEMENT_FAIL_AUDIT === 'true') {
      throw new Error('audit disabled for test');
    }
    await client.query(
      `INSERT INTO fad_policy_decisions (
         organization_id, id, caller_principal_id, subject_principal_id, agent_id, action,
         decision, reason_code, policy_set_digest, input_digest, agent_revision,
         matched_policy_count, request_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        caller.organizationId,
        policyDecisionId,
        caller.principalId,
        caller.principalId,
        agent.id,
        action,
        outcome.decision === 'allow',
        outcome.reason,
        outcome.policySetDigest,
        outcome.inputDigest,
        agent.revision,
        outcome.matched.length,
        caller.requestId,
      ],
    );
    const outcomeName = context.mode === 'enforce'
      ? (outcome.decision === 'allow' ? 'allowed' : 'denied')
      : (outcome.decision === 'allow' ? 'would_allow' : 'would_deny');
    await client.query(
      `INSERT INTO fad_enforcement_decisions (
         organization_id, id, request_id, actor_principal_id, agent_id, policy_decision_id,
         operation_id, action, channel, mode, outcome, reason_code
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        caller.organizationId,
        enforcementId,
        caller.requestId,
        caller.principalId,
        agent.id,
        policyDecisionId,
        operationId,
        action,
        channelOf(caller),
        context.mode,
        outcomeName,
        outcome.reason,
      ],
    );
    if (save) await client.query('RELEASE SAVEPOINT fad_s6_decision');
    return outcome.decision === 'allow' ? 'allow' : 'deny';
  } catch (error) {
    if (error instanceof CommittedDenial || error instanceof EnforcementServiceError) throw error;
    if (save) {
      try {
        await client.query('ROLLBACK TO SAVEPOINT fad_s6_decision');
      } catch {
        throw new EnforcementServiceError(503, 'DEPENDENCY_UNAVAILABLE');
      }
      alert('ENFORCEMENT_SHADOW_EVALUATION_FAILED');
      return 'shadow';
    }
    alert('ENFORCEMENT_DEPENDENCY_FAILED');
    throw new EnforcementServiceError(503, 'DEPENDENCY_UNAVAILABLE');
  }
}

async function decide(
  client: PoolClient,
  caller: EnforcementCaller,
  context: EvalContext,
  operationId: string,
  agent: { id: string; status: 'active' | 'suspended' | 'retired'; revision: number },
): Promise<'allow' | 'deny' | 'shadow'> {
  const tags = await tagFacts(client, caller.organizationId, agent.id);
  let denied = false;
  for (const action of context.actions) {
    const result = await recordAction(client, caller, context, operationId, agent, action, tags);
    if (result === 'shadow') return 'shadow';
    if (result === 'deny') denied = true;
  }
  return denied ? 'deny' : 'allow';
}

export async function enforceAgent(
  client: PoolClient,
  caller: EnforcementCaller | undefined,
  operationId: string,
  agentId: string,
  effect: 'read' | 'write',
): Promise<void> {
  if (!enforcementCodeEnabled()) return;
  if (!caller || caller.organizationId.length === 0) throw new EnforcementServiceError(503, 'DEPENDENCY_UNAVAILABLE');
  const context = await loadEvalContext(client, caller, operationId);
  if (!context) return;
  const agent = await client.query<{ status: 'active' | 'suspended' | 'retired'; revision: string | number }>(
    `SELECT status, revision FROM agents WHERE organization_id = $1 AND id = $2`,
    [caller.organizationId, agentId],
  );
  const row = agent.rows[0];
  if (!row) return;
  const decision = await decide(client, caller, context, operationId, {
    id: agentId,
    status: row.status,
    revision: asRevision(row.revision),
  });
  if (decision === 'deny' && context.mode === 'enforce') {
    throw new CommittedDenial(effect === 'read' ? 404 : 403, effect === 'read' ? 'AGENT_NOT_FOUND' : 'POLICY_DENIED');
  }
}

export async function authorizeCandidate(
  client: PoolClient,
  caller: EnforcementCaller,
  context: EvalContext,
  operationId: string,
  agent: { id: string; status: 'active' | 'suspended' | 'retired'; revision: number },
): Promise<boolean> {
  const decision = await decide(client, caller, context, operationId, agent);
  if (decision === 'shadow') return true;
  if (context.mode === 'shadow') return true;
  return decision === 'allow';
}

interface CursorClaims {
  v: 1;
  kind: 'enforcement-page';
  org: string;
  principal: string;
  filter: string;
  mode: EnforcementMode;
  revision: number;
  operation: string;
  at: string;
  id: string;
  exp: number;
}

export function encodeEnforcementCursor(
  pepper: Buffer,
  claims: Omit<CursorClaims, 'v' | 'kind' | 'exp'> & { exp?: number },
  now = Date.now(),
): string {
  const payload: CursorClaims = {
    v: 1,
    kind: 'enforcement-page',
    ...claims,
    exp: claims.exp ?? now + CURSOR_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', pepper).update(body).digest();
  return `${body}.${mac.toString('base64url')}`;
}

export function decodeEnforcementCursor(
  pepper: Buffer,
  token: string,
  expected: { org: string; principal: string; filter: string; mode: EnforcementMode; revision: number; operation: string },
  now = Date.now(),
): { at: string; id: string } {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new EnforcementServiceError(400, 'VALIDATION_ERROR');
  const actual = Buffer.from(parts[1], 'base64url');
  const mac = createHmac('sha256', pepper).update(parts[0]).digest();
  if (actual.length !== mac.length || !timingSafeEqual(actual, mac)) throw new EnforcementServiceError(400, 'VALIDATION_ERROR');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    throw new EnforcementServiceError(400, 'VALIDATION_ERROR');
  }
  if (parsed === null || typeof parsed !== 'object') throw new EnforcementServiceError(400, 'VALIDATION_ERROR');
  const claims = parsed as Partial<CursorClaims>;
  if (claims.v !== 1 || claims.kind !== 'enforcement-page') throw new EnforcementServiceError(400, 'VALIDATION_ERROR');
  if (claims.org !== expected.org || claims.principal !== expected.principal || claims.filter !== expected.filter || claims.operation !== expected.operation) {
    throw new EnforcementServiceError(400, 'VALIDATION_ERROR');
  }
  if (typeof claims.exp !== 'number' || claims.exp <= now) throw new EnforcementServiceError(400, 'VALIDATION_ERROR');
  if (typeof claims.at !== 'string' || typeof claims.id !== 'string' || !isUuid(claims.id)) {
    throw new EnforcementServiceError(400, 'VALIDATION_ERROR');
  }
  if (claims.mode !== expected.mode || claims.revision !== expected.revision) {
    throw new EnforcementServiceError(409, 'CONFLICT');
  }
  return { at: claims.at, id: claims.id };
}

function objectOf(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new EnforcementServiceError(422, 'VALIDATION_ERROR');
  }
  const source = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new EnforcementServiceError(422, 'VALIDATION_ERROR');
    }
    out[key] = source[key];
  }
  return out;
}

function parseActions(value: unknown, allowEmpty: boolean): EnforceableAction[] {
  if (!Array.isArray(value)) throw new EnforcementServiceError(422, 'VALIDATION_ERROR');
  if (!allowEmpty && value.length === 0) throw new EnforcementServiceError(422, 'VALIDATION_ERROR');
  if (value.length > 4) throw new EnforcementServiceError(422, 'VALIDATION_ERROR');
  const actions: EnforceableAction[] = [];
  for (const item of value) {
    if (item === 'agent.invoke' || typeof item !== 'string' || !ACTION_SET.has(item)) {
      throw new EnforcementServiceError(422, 'VALIDATION_ERROR');
    }
    const action = item as EnforceableAction;
    if (actions.includes(action)) throw new EnforcementServiceError(422, 'VALIDATION_ERROR');
    actions.push(action);
  }
  return actions;
}

function parseReason(value: unknown): string {
  if (typeof value !== 'string') throw new EnforcementServiceError(422, 'VALIDATION_ERROR');
  const reason = value.normalize('NFC').trim();
  if (codePointLength(reason) < 3 || codePointLength(reason) > 500) throw new EnforcementServiceError(422, 'VALIDATION_ERROR');
  if (/[\u0000-\u001F\u007F]/u.test(reason)) throw new EnforcementServiceError(422, 'VALIDATION_ERROR');
  return reason;
}

export function parseEnforcementEtag(value: string | undefined): number {
  if (value === undefined || value.length === 0) throw new EnforcementServiceError(428, 'PRECONDITION_REQUIRED');
  if (value === '*' || value.startsWith('W/')) throw new EnforcementServiceError(400, 'VALIDATION_ERROR');
  const match = /^"enforcement-v(0|[1-9][0-9]*)"$/.exec(value);
  if (!match?.[1]) throw new EnforcementServiceError(400, 'VALIDATION_ERROR');
  return Number(match[1]);
}

async function tagCatalog(client: PoolClient, organizationId: string): Promise<Map<string, { governed: boolean; visibility: string }>> {
  const result = await client.query<{ namespace: string; tag_key: string; governed: boolean; visibility: string }>(
    `SELECT namespace, tag_key, governed, visibility FROM tag_definitions WHERE organization_id = $1`,
    [organizationId],
  );
  return new Map(result.rows.map((row) => [`${row.namespace}/${row.tag_key}`, row]));
}

export async function selectorsUngoverned(
  client: PoolClient,
  organizationId: string,
  rules: readonly StoredPolicyRule[],
  actions: readonly string[],
): Promise<boolean> {
  const selected = new Set(actions);
  const catalog = await tagCatalog(client, organizationId);
  for (const rule of rules) {
    if (!rule.actions.some((action) => selected.has(action))) continue;
    if (!rule.tagsAll) continue;
    for (const predicate of rule.tagsAll) {
      const definition = catalog.get(`${predicate.namespace}/${predicate.key}`);
      if (!definition || !definition.governed || definition.visibility !== 'restricted') return true;
    }
  }
  return false;
}

export async function policyReferencesTag(
  client: PoolClient,
  organizationId: string,
  namespace: string,
  key: string,
  actions: readonly string[],
): Promise<boolean> {
  const loaded = await loadRules(client, organizationId);
  const selected = new Set(actions);
  return loaded.rules.some((rule) => rule.actions.some((action) => selected.has(action))
    && rule.tagsAll?.some((predicate) => predicate.namespace === namespace && predicate.key === key) === true);
}

function sameActions(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((item, index) => item === sortedRight[index]);
}

async function readiness(client: PoolClient): Promise<string[]> {
  const blockers: string[] = [];
  if (process.env.FAD_ENFORCEMENT_OLD_PODS === 'true') blockers.push('old_pods');
  const migration = await client.query(`SELECT 1 FROM schema_migrations WHERE version = $1`, [ENFORCEMENT_MIGRATION_VERSION]);
  if ((migration.rowCount ?? 0) !== 1) blockers.push('migration_missing');
  const forced = await client.query<{ ok: boolean }>(
    `SELECT c.relrowsecurity AND c.relforcerowsecurity AS ok
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'fad_enforcement_decisions'`,
  );
  if (forced.rows[0]?.ok !== true) blockers.push('rls_not_forced');
  const audit = await client.query<{ ok: boolean }>(
    `SELECT has_table_privilege(current_user, 'fad_enforcement_decisions', 'INSERT')
      AND has_table_privilege(current_user, 'audit_events', 'INSERT') AS ok`,
  );
  if (audit.rows[0]?.ok !== true) blockers.push('audit_unavailable');
  return blockers;
}

export async function getEnforcementConfig(pool: Pool, caller: EnforcementCaller): Promise<{ config: EnforcementConfig; etag: string }> {
  return withTenant(pool, caller.organizationId, async (client) => {
    await beginShared(client, caller.organizationId);
    const config = await readConfig(client, caller.organizationId);
    return { config, etag: enforcementEtag(config.revision) };
  });
}

export async function preflightEnforcement(pool: Pool, caller: EnforcementCaller, body: unknown): Promise<EnforcementPreflight> {
  const record = objectOf(body);
  const allowed = new Set(['mode', 'actions', 'reason']);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new EnforcementServiceError(422, 'VALIDATION_ERROR');
  }
  if (record.mode !== 'shadow' && record.mode !== 'enforce') throw new EnforcementServiceError(422, 'VALIDATION_ERROR');
  const mode = record.mode;
  const actions = parseActions(record.actions, false);
  parseReason(record.reason);
  return withTenant(pool, caller.organizationId, async (client) => {
    await beginShared(client, caller.organizationId);
    const loaded = await loadRules(client, caller.organizationId);
    const blockers = await readiness(client);
    const warnings: string[] = [];
    const note = (code: string, hard: boolean) => {
      if (mode === 'enforce' || hard) blockers.push(code);
      else warnings.push(code);
    };
    if (loaded.invalid) note('invalid_policy', false);
    if (loaded.count > POLICY_ACTIVE_CEILING) note('policy_ceiling', false);
    if (loaded.count === 0 || !loaded.rules.some((rule) => rule.effect === 'allow' && rule.actions.some((action) => actions.includes(action as EnforceableAction)))) {
      note('no_active_allow', false);
    }
    if (await selectorsUngoverned(client, caller.organizationId, loaded.rules, actions)) note('ungoverned_selector', false);
    try {
      evaluatePolicies({
        organizationId: caller.organizationId,
        subjectId: caller.principalId,
        subjectActive: true,
        action: 'agent.read',
        agentId: caller.principalId,
        agentStatus: 'active',
        agentRevision: 1,
        activeCount: Math.min(loaded.count, POLICY_ACTIVE_CEILING),
        policies: [],
        tags: [],
      });
    } catch {
      blockers.push('verifier_unhealthy');
    }
    const digest = snapshotDigest(loaded.rules);
    const id = randomUUID();
    const uniqueBlockers = [...new Set(blockers)].slice(0, 100);
    const uniqueWarnings = [...new Set(warnings)].slice(0, 100);
    const passes = uniqueBlockers.length === 0;
    const inserted = await client.query<{ expires_at: Date }>(
      `INSERT INTO fad_enforcement_preflights (
         organization_id, id, actor_principal_id, target_mode, target_actions, passes,
         blockers, warnings, policy_snapshot_digest, expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9, transaction_timestamp() + interval '10 minutes')
       RETURNING expires_at`,
      [
        caller.organizationId,
        id,
        caller.principalId,
        mode,
        actions,
        passes,
        JSON.stringify(uniqueBlockers),
        JSON.stringify(uniqueWarnings),
        digest,
      ],
    );
    const expires = inserted.rows[0]?.expires_at;
    if (!expires) throw new EnforcementServiceError(503, 'DEPENDENCY_UNAVAILABLE');
    return {
      preflight_id: id,
      mode,
      actions,
      passes,
      blockers: uniqueBlockers,
      warnings: uniqueWarnings,
      policy_snapshot_digest: digest,
      expires_at: asTime(expires),
    };
  });
}

interface SetInput {
  mode: EnforcementMode;
  actions: EnforceableAction[];
  reason: string;
  preflightId: string | null;
  acknowledge: boolean;
}

function parseSet(body: unknown): SetInput {
  const record = objectOf(body);
  const allowed = new Set(['mode', 'actions', 'reason', 'preflight_id', 'acknowledge_default_deny']);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new EnforcementServiceError(422, 'VALIDATION_ERROR');
  }
  if (record.mode !== 'off' && record.mode !== 'shadow' && record.mode !== 'enforce') {
    throw new EnforcementServiceError(422, 'VALIDATION_ERROR');
  }
  const mode = record.mode;
  if (typeof record.acknowledge_default_deny !== 'boolean') throw new EnforcementServiceError(422, 'VALIDATION_ERROR');
  const reason = parseReason(record.reason);
  if (mode === 'off') {
    if (record.preflight_id !== undefined) throw new EnforcementServiceError(422, 'VALIDATION_ERROR');
    const actions = parseActions(record.actions, true);
    if (actions.length !== 0) throw new EnforcementServiceError(422, 'VALIDATION_ERROR');
    return { mode, actions, reason, preflightId: null, acknowledge: record.acknowledge_default_deny };
  }
  if (typeof record.preflight_id !== 'string' || !isUuid(record.preflight_id)) {
    throw new EnforcementServiceError(422, 'VALIDATION_ERROR');
  }
  if (mode === 'enforce' && record.acknowledge_default_deny !== true) {
    throw new EnforcementServiceError(422, 'VALIDATION_ERROR');
  }
  return {
    mode,
    actions: parseActions(record.actions, false),
    reason,
    preflightId: record.preflight_id,
    acknowledge: record.acknowledge_default_deny,
  };
}

export async function setEnforcementConfig(
  pool: Pool,
  caller: EnforcementCaller,
  idempotencyKey: string,
  ifMatch: string | undefined,
  body: unknown,
): Promise<{ config: EnforcementConfig; etag: string }> {
  const input = parseSet(body);
  const expected = parseEnforcementEtag(ifMatch);
  const path = '/v1/enforcement/config';
  const fingerprint = requestFingerprint('PUT', path, canonicalJson({ body: input, if_match: ifMatch ?? null }));
  return withTenant(pool, caller.organizationId, async (client) => {
    await beginExclusive(client, caller.organizationId);
    const claim = await beginIdempotency(client, {
      organizationId: caller.organizationId,
      principalId: caller.principalId,
      method: 'PUT',
      resourcePath: path,
      idemKey: idempotencyKey,
      requestSha256: fingerprint,
    });
    if (claim.kind === 'replay') {
      const config = claim.responseBody as EnforcementConfig;
      return { config, etag: claim.responseHeaders.etag ?? enforcementEtag(config.revision) };
    }
    const current = await readConfig(client, caller.organizationId);
    if (current.revision !== expected) throw new EnforcementServiceError(412, 'PRECONDITION_FAILED');
    let preflightId: string | null = null;
    if (input.mode !== 'off') {
      const loaded = await loadRules(client, caller.organizationId);
      const digest = snapshotDigest(loaded.rules);
      const preflight = await client.query<{
        target_mode: string;
        target_actions: string[];
        passes: boolean;
        policy_snapshot_digest: string;
        actor_principal_id: string;
      }>(
        `SELECT target_mode, target_actions, passes, policy_snapshot_digest, actor_principal_id
         FROM fad_enforcement_preflights
         WHERE organization_id = $1 AND id = $2 AND used_at IS NULL AND expires_at > transaction_timestamp()`,
        [caller.organizationId, input.preflightId],
      );
      const row = preflight.rows[0];
      if (!row || row.actor_principal_id !== caller.principalId || row.passes !== true || row.target_mode !== input.mode || !sameActions(row.target_actions, input.actions)) {
        throw new EnforcementServiceError(409, 'CONFLICT');
      }
      if (row.policy_snapshot_digest !== digest) throw new EnforcementServiceError(412, 'PRECONDITION_FAILED');
      preflightId = input.preflightId;
    }
    const reasonDigest = sha256(input.reason);
    const nextRevision = current.revision + 1;
    let stored: ConfigRow | undefined;
    if (current.revision === 0) {
      const inserted = await client.query<ConfigRow>(
        `INSERT INTO fad_enforcement_configs (organization_id, mode, actions, revision, updated_by)
         VALUES ($1, $2, $3, 1, $4)
         RETURNING mode, actions, revision, updated_by, updated_at`,
        [caller.organizationId, input.mode, input.actions, caller.principalId],
      );
      stored = inserted.rows[0];
    } else {
      const updated = await client.query<ConfigRow>(
        `UPDATE fad_enforcement_configs
         SET mode = $2, actions = $3, revision = revision + 1, updated_by = $4, updated_at = transaction_timestamp()
         WHERE organization_id = $1 AND revision = $5
         RETURNING mode, actions, revision, updated_by, updated_at`,
        [caller.organizationId, input.mode, input.actions, caller.principalId, current.revision],
      );
      stored = updated.rows[0];
    }
    if (!stored || asRevision(stored.revision) !== nextRevision) throw new EnforcementServiceError(412, 'PRECONDITION_FAILED');
    await client.query(
      `INSERT INTO fad_enforcement_config_revisions (
         organization_id, revision, mode, actions, actor_principal_id, reason_digest, preflight_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [caller.organizationId, nextRevision, input.mode, input.actions, caller.principalId, reasonDigest, preflightId],
    );
    if (preflightId) {
      const used = await client.query(
        `UPDATE fad_enforcement_preflights SET used_at = transaction_timestamp()
         WHERE organization_id = $1 AND id = $2 AND used_at IS NULL`,
        [caller.organizationId, preflightId],
      );
      if ((used.rowCount ?? 0) !== 1) throw new EnforcementServiceError(409, 'CONFLICT');
    }
    const config = await readConfig(client, caller.organizationId);
    await insertAudit(client, {
      organizationId: caller.organizationId,
      actorPrincipalId: caller.principalId,
      action: 'enforcement.config_updated',
      targetType: 'enforcement_config',
      targetId: caller.organizationId,
      outcome: 'success',
      requestId: caller.requestId,
      details: {
        mode: config.mode,
        actions: config.actions,
        revision: config.revision,
        reason_digest: reasonDigest,
        preflight_id: preflightId,
        request_id: caller.requestId,
      },
    });
    await appendDirectoryEvent(client, {
      organizationId: caller.organizationId,
      eventType: 'com.fad.enforcement.config_changed.v1',
      subject: `enforcement/${caller.organizationId}`,
      aggregateType: 'enforcement_config',
      aggregateId: null,
      aggregateRevision: config.revision,
      visibility: 'restricted',
      payload: { mode: config.mode, revision: config.revision },
      requestId: caller.requestId,
    });
    const etag = enforcementEtag(config.revision);
    await writeIdempotency(client, {
      organizationId: caller.organizationId,
      principalId: caller.principalId,
      method: 'PUT',
      resourcePath: path,
      idemKey: idempotencyKey,
      requestSha256: fingerprint,
      responseStatus: 200,
      responseHeaders: { etag },
      responseBody: config,
      expiresAt: new Date(Date.now() + RETENTION_MS),
    });
    return { config, etag };
  });
}

export async function getEnforcementDecision(pool: Pool, caller: EnforcementCaller, decisionId: string): Promise<EnforcementDecisionView> {
  if (!isUuid(decisionId)) throw new EnforcementServiceError(400, 'VALIDATION_ERROR');
  return withTenant(pool, caller.organizationId, async (client) => {
    await beginShared(client, caller.organizationId);
    const result = await client.query<{
      id: string;
      request_id: string;
      agent_id: string;
      actor_principal_id: string;
      operation_id: string;
      action: EnforceableAction;
      channel: EnforcementChannel;
      mode: 'shadow' | 'enforce';
      outcome: EnforcementDecisionView['outcome'];
      reason_code: string;
      policy_decision_id: string | null;
      happened_at: Date;
    }>(
      `SELECT id, request_id, agent_id, actor_principal_id, operation_id, action, channel, mode,
              outcome, reason_code, policy_decision_id, happened_at
       FROM fad_enforcement_decisions WHERE organization_id = $1 AND id = $2`,
      [caller.organizationId, decisionId],
    );
    const row = result.rows[0];
    if (!row) throw new EnforcementServiceError(404, 'NOT_FOUND');
    return {
      id: row.id,
      request_id: row.request_id,
      agent_id: row.agent_id,
      actor_principal_id: row.actor_principal_id,
      operation_id: row.operation_id,
      action: row.action,
      channel: row.channel,
      mode: row.mode,
      outcome: row.outcome,
      reason_code: row.reason_code,
      policy_decision_id: row.policy_decision_id,
      happened_at: asTime(row.happened_at),
    };
  });
}

export async function guardReferencedTag(
  client: PoolClient,
  caller: EnforcementCaller,
  namespace: string,
  key: string,
): Promise<void> {
  if (!enforcementCodeEnabled()) return;
  const config = await readConfig(client, caller.organizationId);
  if (config.mode !== 'enforce') return;
  const referenced = await policyReferencesTag(client, caller.organizationId, namespace, key, config.actions);
  if (!referenced) return;
  if (!hasScope(caller.scopes, 'tags:governance') || !hasScope(caller.scopes, 'policies:attributes:write')) {
    throw new EnforcementServiceError(403, 'FORBIDDEN');
  }
}

