import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { isUuid } from '@fad/auth-core';
import { canonicalJson, codePointLength } from './agent-rules.js';

export const POLICY_MIGRATION_VERSION = '20261021_005_policy_evaluation';
export const POLICY_SCHEMA_VERSION = 'policy-v1';
export const POLICY_ACTIVE_CEILING = 256;
const NAME = /^[a-z][a-z0-9_-]{0,39}$/;
const CONTROL = /[\u0000-\u001F\u007F]/u;
const ETAG = /^"policy-v([1-9][0-9]*)"$/;
const INTEGER_MIN = -1_000_000_000;
const INTEGER_MAX = 1_000_000_000;
const CURSOR_TTL_MS = 24 * 60 * 60 * 1000;
const ACTIONS = ['agent.read', 'agent.discover', 'agent.invoke', 'agent.update', 'agent.suspend'] as const;
const EFFECTS = ['allow', 'deny'] as const;
const STATUSES = ['draft', 'active', 'disabled'] as const;
const DEFINITION_KEYS = new Set(['name', 'description', 'effect', 'actions', 'subjects', 'resource', 'supersedes_policy_id']);
const CLAIM_KEYS = new Set([
  'tags', 'tag_values', 'principal_status', 'agent_status', 'organization_id', 'status',
  'revision', 'contains_restricted_tags', 'decision', 'enforcement',
]);

export type PolicyAction = (typeof ACTIONS)[number];
export type PolicyEffect = (typeof EFFECTS)[number];
export type PolicyStatus = (typeof STATUSES)[number];
export type PolicyReason =
  | 'EXPLICIT_ALLOW'
  | 'EXPLICIT_DENY'
  | 'NO_MATCHING_ALLOW'
  | 'SUBJECT_INACTIVE'
  | 'RESOURCE_INACTIVE';
export type PolicyTagValue = string | number | boolean;

export class PolicyServiceError extends Error {
  readonly status: number;
  readonly code:
    | 'VALIDATION_ERROR'
    | 'FORBIDDEN'
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'PRECONDITION_FAILED'
    | 'PRECONDITION_REQUIRED'
    | 'IDEMPOTENCY_CONFLICT'
    | 'UNSUPPORTED_MEDIA_TYPE'
    | 'DEPENDENCY_UNAVAILABLE'
    | 'INVALID_STATE_TRANSITION';

  constructor(status: number, code: PolicyServiceError['code']) {
    super(code);
    this.name = 'PolicyServiceError';
    this.status = status;
    this.code = code;
  }
}

export interface PolicyTagPredicate {
  namespace: string;
  key: string;
  operator: 'eq';
  value: PolicyTagValue;
}

export interface PolicyDefinition {
  name: string;
  description: string;
  effect: PolicyEffect;
  actions: PolicyAction[];
  principalIds: string[];
  agentIds: string[] | null;
  tagsAll: PolicyTagPredicate[] | null;
  supersedesPolicyId: string | null;
}

export interface PolicyRecord {
  id: string;
  organization_id: string;
  name: string;
  description: string;
  effect: PolicyEffect;
  actions: PolicyAction[];
  subjects: { principal_ids: string[] };
  resource: { type: 'agent'; agent_ids?: string[]; tags_all?: PolicyTagPredicate[] };
  status: PolicyStatus;
  revision: number;
  contains_restricted_tags: boolean;
  supersedes_policy_id: string | null;
  created_at: string;
  updated_at: string;
  activated_at: string | null;
  disabled_at: string | null;
  created_by: string;
  updated_by: string;
}

export interface StoredPolicyRule {
  id: string;
  revision: number;
  effect: PolicyEffect;
  actions: PolicyAction[];
  principalIds: string[];
  agentIds: string[] | null;
  tagsAll: PolicyTagPredicate[] | null;
  containsRestricted: boolean;
}

export interface TagFact {
  namespace: string;
  key: string;
  value: unknown;
  revision: number;
  deleted: boolean;
}

export interface EvaluationFacts {
  organizationId: string;
  subjectId: string;
  subjectActive: boolean;
  action: PolicyAction;
  agentId: string;
  agentStatus: 'active' | 'suspended' | 'retired';
  agentRevision: number;
  activeCount: number;
  policies: StoredPolicyRule[];
  tags: TagFact[];
}

export interface EvaluationOutcome {
  decision: 'allow' | 'deny';
  reason: PolicyReason;
  matched: Array<{ policy_id: string; revision: number; effect: PolicyEffect; restricted: boolean }>;
  policySetDigest: string;
  inputDigest: string;
  consideredRestricted: boolean;
}

export function policyEtag(revision: number): string {
  return `"policy-v${revision}"`;
}

export function parsePolicyPrecondition(value: string | undefined): { kind: 'missing' } | { kind: 'ok'; revision: number } {
  if (value === undefined || value.length === 0) return { kind: 'missing' };
  const match = ETAG.exec(value);
  if (!match?.[1]) throw new PolicyServiceError(400, 'VALIDATION_ERROR');
  const revision = Number(match[1]);
  if (!Number.isSafeInteger(revision)) throw new PolicyServiceError(400, 'VALIDATION_ERROR');
  return { kind: 'ok', revision };
}

export function parsePolicyDefinition(input: unknown, policyId?: string): PolicyDefinition {
  const record = objectOf(input);
  for (const key of Object.keys(record)) {
    if (CLAIM_KEYS.has(key) || !DEFINITION_KEYS.has(key)) throw new PolicyServiceError(422, 'VALIDATION_ERROR');
  }
  const description = record.description === undefined ? '' : textOf(record.description, 2000, true);
  const definition: PolicyDefinition = {
    name: textOf(record.name, 160, false),
    description,
    effect: oneOf(record.effect, EFFECTS),
    actions: actionList(record.actions),
    principalIds: uuidList(subjectIds(record.subjects), 1, 64),
    agentIds: null,
    tagsAll: null,
    supersedesPolicyId: optionalUuid(record.supersedes_policy_id),
  };
  const resource = objectOf(record.resource);
  if (resource.type !== 'agent') throw new PolicyServiceError(422, 'VALIDATION_ERROR');
  for (const key of Object.keys(resource)) {
    if (key !== 'type' && key !== 'agent_ids' && key !== 'tags_all') throw new PolicyServiceError(422, 'VALIDATION_ERROR');
  }
  if (resource.agent_ids !== undefined) definition.agentIds = uuidList(resource.agent_ids, 1, 100);
  if (resource.tags_all !== undefined) definition.tagsAll = predicates(resource.tags_all);
  if (definition.agentIds === null && definition.tagsAll === null) throw new PolicyServiceError(422, 'VALIDATION_ERROR');
  if (policyId && definition.supersedesPolicyId === policyId) throw new PolicyServiceError(422, 'VALIDATION_ERROR');
  return definition;
}

export function resourceOf(definition: PolicyDefinition): PolicyRecord['resource'] {
  const resource: PolicyRecord['resource'] = { type: 'agent' };
  if (definition.agentIds) resource.agent_ids = definition.agentIds;
  if (definition.tagsAll) resource.tags_all = definition.tagsAll;
  return resource;
}

export function parseEvaluationRequest(input: unknown): {
  subjectId: string;
  action: PolicyAction;
  agentId: string;
} {
  const record = objectOf(input);
  for (const key of Object.keys(record)) {
    if (key !== 'subject' && key !== 'action' && key !== 'resource' && key !== 'context') {
      throw new PolicyServiceError(422, 'VALIDATION_ERROR');
    }
  }
  const subject = objectOf(record.subject);
  if (Object.keys(subject).join() !== 'principal_id') throw new PolicyServiceError(422, 'VALIDATION_ERROR');
  const action = oneOf(record.action, ACTIONS);
  const resource = objectOf(record.resource);
  for (const key of Object.keys(resource)) {
    if (key !== 'type' && key !== 'id') throw new PolicyServiceError(422, 'VALIDATION_ERROR');
  }
  if (resource.type !== 'agent') throw new PolicyServiceError(422, 'VALIDATION_ERROR');
  if (record.context !== undefined) advisoryContext(record.context);
  return { subjectId: canonicalUuid(subject.principal_id), action, agentId: canonicalUuid(resource.id) };
}

export function parsePolicyListQuery(input: unknown): { status: PolicyStatus | null; limit: number; cursor: string | null } {
  if (input === undefined || input === null) return { status: null, limit: 25, cursor: null };
  const record = objectOf(input);
  let status: PolicyStatus | null = null;
  let limit = 25;
  let cursor: string | null = null;
  for (const [key, value] of Object.entries(record)) {
    if (key === 'status') status = oneOf(value, STATUSES);
    else if (key === 'limit') {
      if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) throw new PolicyServiceError(400, 'VALIDATION_ERROR');
      limit = Number(value);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new PolicyServiceError(400, 'VALIDATION_ERROR');
    } else if (key === 'cursor') {
      if (typeof value !== 'string' || value.length < 1 || value.length > 4096) throw new PolicyServiceError(400, 'VALIDATION_ERROR');
      cursor = value;
    } else throw new PolicyServiceError(400, 'VALIDATION_ERROR');
  }
  return { status, limit, cursor };
}

export function encodePolicyCursor(
  pepper: Buffer,
  claims: { org: string; status: PolicyStatus | null; restricted: boolean; at: string; id: string },
  now = Date.now(),
): string {
  return sign(pepper, { v: 1, kind: 'policy', ...claims, exp: now + CURSOR_TTL_MS });
}

export function decodePolicyCursor(
  pepper: Buffer,
  token: string,
  expected: { org: string; status: PolicyStatus | null; restricted: boolean },
  now = Date.now(),
): { at: string; id: string } {
  const parsed = openSigned(pepper, token);
  if (parsed === null || typeof parsed !== 'object') throw new PolicyServiceError(400, 'VALIDATION_ERROR');
  const claims = parsed as Record<string, unknown>;
  if (claims.v !== 1 || claims.kind !== 'policy') throw new PolicyServiceError(400, 'VALIDATION_ERROR');
  if (claims.org !== expected.org || claims.status !== expected.status || claims.restricted !== expected.restricted) {
    throw new PolicyServiceError(400, 'VALIDATION_ERROR');
  }
  if (typeof claims.exp !== 'number' || claims.exp <= now) throw new PolicyServiceError(400, 'VALIDATION_ERROR');
  if (typeof claims.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(claims.at)) {
    throw new PolicyServiceError(400, 'VALIDATION_ERROR');
  }
  return { at: claims.at, id: canonicalUuid(claims.id, 400) };
}

export function evaluatePolicies(facts: EvaluationFacts): EvaluationOutcome {
  if (facts.activeCount > POLICY_ACTIVE_CEILING || facts.policies.length > POLICY_ACTIVE_CEILING) {
    throw new PolicyServiceError(503, 'DEPENDENCY_UNAVAILABLE');
  }
  const considered = facts.policies.filter((policy) => policy.actions.includes(facts.action));
  assertReferencedScalars(considered, facts.tags);
  const subjectId = facts.subjectId.toLowerCase();
  const agentId = facts.agentId.toLowerCase();
  const policySetDigest = sha256(canonicalJson(considered
    .map((policy) => ({ id: policy.id, revision: policy.revision }))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : left.revision - right.revision)));
  const referenced = referencedTags(considered, facts.tags);
  const inputDigest = sha256(canonicalJson({
    schema_version: POLICY_SCHEMA_VERSION,
    organization_id: facts.organizationId,
    subject_id: subjectId,
    action: facts.action,
    resource_id: agentId,
    agent_revision: facts.agentRevision,
    principal_status: facts.subjectActive ? 'active' : 'inactive',
    agent_status: facts.agentStatus,
    policy_set_digest: policySetDigest,
    referenced_tags: referenced,
  }));
  const matched = considered
    .filter((policy) => ruleMatches(policy, subjectId, agentId, facts.tags))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  let reason: PolicyReason;
  if (!facts.subjectActive) reason = 'SUBJECT_INACTIVE';
  else if (facts.agentStatus !== 'active') reason = 'RESOURCE_INACTIVE';
  else if (matched.some((policy) => policy.effect === 'deny')) reason = 'EXPLICIT_DENY';
  else if (matched.some((policy) => policy.effect === 'allow')) reason = 'EXPLICIT_ALLOW';
  else reason = 'NO_MATCHING_ALLOW';
  return {
    decision: reason === 'EXPLICIT_ALLOW' ? 'allow' : 'deny',
    reason,
    matched: matched.map((policy) => ({
      policy_id: policy.id,
      revision: policy.revision,
      effect: policy.effect,
      restricted: policy.containsRestricted,
    })),
    policySetDigest,
    inputDigest,
    consideredRestricted: considered.some((policy) => policy.containsRestricted),
  };
}

export function valuesEqual(expected: PolicyTagValue, actual: unknown): boolean {
  if (typeof expected === 'string') return typeof actual === 'string' && expected.normalize('NFC') === actual.normalize('NFC');
  if (typeof expected === 'boolean') return typeof actual === 'boolean' && expected === actual;
  return typeof actual === 'number' && Number.isInteger(actual) && expected === actual;
}

function ruleMatches(policy: StoredPolicyRule, subjectId: string, agentId: string, tags: readonly TagFact[]): boolean {
  if (!hasUuid(policy.principalIds, subjectId)) return false;
  if (policy.agentIds && !hasUuid(policy.agentIds, agentId)) return false;
  if (!policy.tagsAll) return policy.agentIds !== null;
  return policy.tagsAll.every((predicate) => {
    const fact = tags.find((tag) => tag.namespace === predicate.namespace && tag.key === predicate.key);
    return fact !== undefined && !fact.deleted && isStrictScalar(fact.value) && valuesEqual(predicate.value, fact.value);
  });
}

function assertReferencedScalars(policies: readonly StoredPolicyRule[], tags: readonly TagFact[]): void {
  const wanted = new Set<string>();
  for (const policy of policies) {
    for (const predicate of policy.tagsAll ?? []) wanted.add(`${predicate.namespace}\n${predicate.key}`);
  }
  for (const fact of tags) {
    if (fact.deleted || !wanted.has(`${fact.namespace}\n${fact.key}`)) continue;
    if (!isStrictScalar(fact.value)) throw new PolicyServiceError(503, 'DEPENDENCY_UNAVAILABLE');
  }
}

function isStrictScalar(value: unknown): value is PolicyTagValue {
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  return typeof value === 'number' && Number.isInteger(value);
}

function hasUuid(ids: readonly string[], id: string): boolean {
  const needle = id.toLowerCase();
  return ids.some((item) => item.toLowerCase() === needle);
}

function referencedTags(policies: readonly StoredPolicyRule[], tags: readonly TagFact[]): Array<Record<string, unknown>> {
  const wanted = new Map<string, { namespace: string; key: string }>();
  for (const policy of policies) {
    for (const predicate of policy.tagsAll ?? []) {
      wanted.set(`${predicate.namespace}\n${predicate.key}`, { namespace: predicate.namespace, key: predicate.key });
    }
  }
  return [...wanted.values()]
    .sort((left, right) => left.namespace === right.namespace
      ? (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
      : (left.namespace < right.namespace ? -1 : 1))
    .map((item) => {
      const fact = tags.find((tag) => tag.namespace === item.namespace && tag.key === item.key);
      if (!fact || fact.deleted || fact.value === null) {
        return { namespace: item.namespace, key: item.key, present: false, revision: fact?.revision ?? 0 };
      }
      return { namespace: item.namespace, key: item.key, present: true, value: fact.value, revision: fact.revision };
    });
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function objectOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new PolicyServiceError(422, 'VALIDATION_ERROR');
  return value as Record<string, unknown>;
}

function textOf(value: unknown, max: number, emptyOk: boolean): string {
  if (typeof value !== 'string') throw new PolicyServiceError(422, 'VALIDATION_ERROR');
  if (value.normalize('NFC') !== value || CONTROL.test(value)) throw new PolicyServiceError(422, 'VALIDATION_ERROR');
  const length = codePointLength(value);
  if ((length < 1 && !emptyOk) || length > max) throw new PolicyServiceError(422, 'VALIDATION_ERROR');
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new PolicyServiceError(422, 'VALIDATION_ERROR');
  return value as T;
}

function actionList(value: unknown): PolicyAction[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) throw new PolicyServiceError(422, 'VALIDATION_ERROR');
  const actions = value.map((item) => oneOf(item, ACTIONS));
  if (new Set(actions).size !== actions.length) throw new PolicyServiceError(422, 'VALIDATION_ERROR');
  return actions;
}

function subjectIds(value: unknown): unknown {
  const record = objectOf(value);
  if (Object.keys(record).join() !== 'principal_ids') throw new PolicyServiceError(422, 'VALIDATION_ERROR');
  return record.principal_ids;
}

function uuidList(value: unknown, min: number, max: number): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new PolicyServiceError(422, 'VALIDATION_ERROR');
  const ids = value.map((item) => canonicalUuid(item));
  if (new Set(ids).size !== ids.length) throw new PolicyServiceError(422, 'VALIDATION_ERROR');
  return ids;
}

function optionalUuid(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return canonicalUuid(value);
}

function canonicalUuid(value: unknown, status: 400 | 422 = 422): string {
  if (typeof value !== 'string' || !isUuid(value)) throw new PolicyServiceError(status, 'VALIDATION_ERROR');
  return value.toLowerCase();
}

function predicates(value: unknown): PolicyTagPredicate[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) throw new PolicyServiceError(422, 'VALIDATION_ERROR');
  const seen = new Set<string>();
  return value.map((item) => {
    const record = objectOf(item);
    for (const key of Object.keys(record)) {
      if (key !== 'namespace' && key !== 'key' && key !== 'operator' && key !== 'value') {
        throw new PolicyServiceError(422, 'VALIDATION_ERROR');
      }
    }
    if (typeof record.namespace !== 'string' || typeof record.key !== 'string' || !NAME.test(record.namespace) || !NAME.test(record.key)) {
      throw new PolicyServiceError(422, 'VALIDATION_ERROR');
    }
    if (record.operator !== 'eq') throw new PolicyServiceError(422, 'VALIDATION_ERROR');
    const id = `${record.namespace}\n${record.key}`;
    if (seen.has(id)) throw new PolicyServiceError(422, 'VALIDATION_ERROR');
    seen.add(id);
    return { namespace: record.namespace, key: record.key, operator: 'eq' as const, value: scalar(record.value) };
  });
}

function scalar(value: unknown): PolicyTagValue {
  if (typeof value === 'string') return textOf(value, 128, false);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isInteger(value) && value >= INTEGER_MIN && value <= INTEGER_MAX) return value;
  throw new PolicyServiceError(422, 'VALIDATION_ERROR');
}

function advisoryContext(value: unknown): void {
  const record = objectOf(value);
  for (const [key, item] of Object.entries(record)) {
    if (key !== 'purpose' && key !== 'correlation_id') throw new PolicyServiceError(422, 'VALIDATION_ERROR');
    if (typeof item !== 'string' || item.normalize('NFC') !== item || CONTROL.test(item)) throw new PolicyServiceError(422, 'VALIDATION_ERROR');
    const max = key === 'purpose' ? 100 : 128;
    const length = codePointLength(item);
    if (length < 1 || length > max) throw new PolicyServiceError(422, 'VALIDATION_ERROR');
  }
}

function sign(pepper: Buffer, payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', pepper).update(body).digest();
  return `${body}.${mac.toString('base64url')}`;
}

function openSigned(pepper: Buffer, token: string): unknown {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new PolicyServiceError(400, 'VALIDATION_ERROR');
  const actual = Buffer.from(parts[1], 'base64url');
  const expected = createHmac('sha256', pepper).update(parts[0]).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new PolicyServiceError(400, 'VALIDATION_ERROR');
  }
  try {
    return JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new PolicyServiceError(400, 'VALIDATION_ERROR');
  }
}
