import { createHmac, timingSafeEqual } from 'node:crypto';
import { isUuid } from '@fad/auth-core';
import { codePointLength, type AgentStatus } from './agent-rules.js';

export const TAG_MIGRATION_VERSION = '20261021_001_typed_tags';
export const TAG_ASSIGNMENT_CEILING = 64;
export const TAG_DEFINITION_CEILING = 256;
export const TAG_SEARCH_PREDICATE_CEILING = 8;
export const TAG_NAME = /^[a-z][a-z0-9_-]{0,39}$/;
const CONTROL = /[\u0000-\u001F\u007F]/u;
const RESERVED = new Set(['security', 'compliance', 'system']);
const INTEGER_MIN = -1_000_000_000;
const INTEGER_MAX = 1_000_000_000;
const CURSOR_TTL_MS = 24 * 60 * 60 * 1000;

export type TagType = 'string' | 'integer' | 'boolean' | 'enum';
export type TagVisibility = 'internal' | 'restricted';
export type TagValue = string | number | boolean;

export class TagServiceError extends Error {
  readonly status: number;
  readonly code:
    | 'VALIDATION_ERROR'
    | 'UNAUTHORIZED'
    | 'FORBIDDEN'
    | 'AGENT_NOT_FOUND'
    | 'TAG_DEFINITION_NOT_FOUND'
    | 'TAG_ASSIGNMENT_NOT_FOUND'
    | 'TAG_DEFINITION_EXISTS'
    | 'INVALID_AGENT_STATE'
    | 'PRECONDITION_FAILED'
    | 'PRECONDITION_REQUIRED'
    | 'UNSUPPORTED_MEDIA_TYPE'
    | 'PAYLOAD_TOO_LARGE';

  constructor(status: number, code: TagServiceError['code']) {
    super(code);
    this.name = 'TagServiceError';
    this.status = status;
    this.code = code;
  }
}

export interface TagDefinitionInput {
  namespace: string;
  key: string;
  valueType: TagType;
  enumValues: string[] | null;
  governed: boolean;
  visibility: TagVisibility;
  description: string;
}

export interface TagPutInput {
  value: unknown;
  reason: string | null;
}

export interface TagPredicate {
  namespace: string;
  key: string;
  value: TagValue;
}

export interface TagSearchInput {
  tags: TagPredicate[] | null;
  status: AgentStatus | null;
  limit: number;
  cursor: string | null;
}

export function tagEtag(revision: number): string {
  return `"tag-v${revision}"`;
}

export function parseTagName(namespace: string, key: string): { namespace: string; key: string } {
  if (!TAG_NAME.test(namespace) || !TAG_NAME.test(key)) {
    throw new TagServiceError(400, 'VALIDATION_ERROR');
  }
  return { namespace, key };
}

function asObject(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new TagServiceError(422, 'VALIDATION_ERROR');
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new TagServiceError(422, 'VALIDATION_ERROR');
  }
  return record;
}

function nfcText(value: string, max: number, emptyOk: boolean): string {
  if (value.normalize('NFC') !== value) throw new TagServiceError(422, 'VALIDATION_ERROR');
  if (CONTROL.test(value)) throw new TagServiceError(422, 'VALIDATION_ERROR');
  const length = codePointLength(value);
  if ((length < 1 && !emptyOk) || length > max) throw new TagServiceError(422, 'VALIDATION_ERROR');
  return value;
}

function optionalReason(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'string') throw new TagServiceError(422, 'VALIDATION_ERROR');
  if (input.normalize('NFC') !== input) throw new TagServiceError(422, 'VALIDATION_ERROR');
  const value = input.trim();
  if (CONTROL.test(value) || codePointLength(value) < 1 || codePointLength(value) > 500) {
    throw new TagServiceError(422, 'VALIDATION_ERROR');
  }
  return value;
}

export function requireChangeReason(input: unknown): string {
  const reason = optionalReason(input);
  if (reason === null) throw new TagServiceError(422, 'VALIDATION_ERROR');
  return reason;
}

export function parseDefinitionBody(body: unknown): TagDefinitionInput {
  const record = asObject(body, ['namespace', 'key', 'value_type', 'enum_values', 'governed', 'visibility', 'description']);
  if (typeof record.namespace !== 'string' || typeof record.key !== 'string' || !TAG_NAME.test(record.namespace) || !TAG_NAME.test(record.key)) {
    throw new TagServiceError(422, 'VALIDATION_ERROR');
  }
  if (record.value_type !== 'string' && record.value_type !== 'integer' && record.value_type !== 'boolean' && record.value_type !== 'enum') {
    throw new TagServiceError(422, 'VALIDATION_ERROR');
  }
  if (typeof record.governed !== 'boolean') throw new TagServiceError(422, 'VALIDATION_ERROR');
  if (record.visibility !== 'internal' && record.visibility !== 'restricted') {
    throw new TagServiceError(422, 'VALIDATION_ERROR');
  }
  const description = record.description === undefined ? '' : record.description;
  if (typeof description !== 'string') throw new TagServiceError(422, 'VALIDATION_ERROR');
  const enumValues = parseEnumValues(record.value_type, record.enum_values);
  if (record.governed && record.visibility !== 'restricted') throw new TagServiceError(422, 'VALIDATION_ERROR');
  if (RESERVED.has(record.namespace) && !(record.governed && record.visibility === 'restricted')) {
    throw new TagServiceError(422, 'VALIDATION_ERROR');
  }
  return {
    namespace: record.namespace,
    key: record.key,
    valueType: record.value_type,
    enumValues,
    governed: record.governed,
    visibility: record.visibility,
    description: nfcText(description, 500, true),
  };
}

function parseEnumValues(valueType: TagType, input: unknown): string[] | null {
  if (valueType !== 'enum') {
    if (input !== undefined) throw new TagServiceError(422, 'VALIDATION_ERROR');
    return null;
  }
  if (!Array.isArray(input) || input.length < 2 || input.length > 32) throw new TagServiceError(422, 'VALIDATION_ERROR');
  const values: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string') throw new TagServiceError(422, 'VALIDATION_ERROR');
    values.push(nfcText(item, 64, false));
  }
  if (new Set(values).size !== values.length) throw new TagServiceError(422, 'VALIDATION_ERROR');
  return values;
}

export function parseTagPut(body: unknown): TagPutInput {
  const record = asObject(body, ['value', 'reason']);
  if (!('value' in record)) throw new TagServiceError(422, 'VALIDATION_ERROR');
  return { value: record.value, reason: optionalReason(record.reason) };
}

export function validateTagValue(definition: { valueType: TagType; enumValues: string[] | null }, value: unknown): TagValue {
  if (definition.valueType === 'string' || definition.valueType === 'enum') {
    if (typeof value !== 'string') throw new TagServiceError(422, 'VALIDATION_ERROR');
    const text = nfcText(value, 128, false);
    if (definition.valueType === 'enum' && !definition.enumValues?.includes(text)) {
      throw new TagServiceError(422, 'VALIDATION_ERROR');
    }
    return text;
  }
  if (definition.valueType === 'boolean') {
    if (typeof value !== 'boolean') throw new TagServiceError(422, 'VALIDATION_ERROR');
    return value;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < INTEGER_MIN || value > INTEGER_MAX) {
    throw new TagServiceError(422, 'VALIDATION_ERROR');
  }
  return value;
}

export function sameTagValue(left: TagValue, right: TagValue): boolean {
  return Object.is(left, right);
}

export function parseTagPrecondition(ifMatch: string | undefined, ifNoneMatch: string | undefined):
  | { kind: 'match'; revision: number }
  | { kind: 'none' } {
  const matchPresent = ifMatch !== undefined;
  const nonePresent = ifNoneMatch !== undefined;
  if (matchPresent && nonePresent) throw new TagServiceError(400, 'VALIDATION_ERROR');
  if (!matchPresent && !nonePresent) throw new TagServiceError(428, 'PRECONDITION_REQUIRED');
  if (nonePresent) {
    if (ifNoneMatch !== '*') throw new TagServiceError(400, 'VALIDATION_ERROR');
    return { kind: 'none' };
  }
  const match = /^"tag-v([1-9][0-9]*)"$/.exec(ifMatch ?? '');
  if (!match?.[1]) throw new TagServiceError(400, 'VALIDATION_ERROR');
  const revision = Number(match[1]);
  if (!Number.isSafeInteger(revision)) throw new TagServiceError(400, 'VALIDATION_ERROR');
  return { kind: 'match', revision };
}

const STATUSES = new Set<AgentStatus>(['active', 'suspended', 'retired']);

export function parseSearchBody(body: unknown, maxPredicates: number, maxLimit: number): TagSearchInput {
  const record = asObject(body, ['tags', 'status', 'limit', 'cursor']);
  if (Object.keys(record).length === 0) throw new TagServiceError(422, 'VALIDATION_ERROR');
  let tags: TagPredicate[] | null = null;
  if ('tags' in record) {
    if (!Array.isArray(record.tags) || record.tags.length < 1 || record.tags.length > maxPredicates) {
      throw new TagServiceError(422, 'VALIDATION_ERROR');
    }
    const seen = new Set<string>();
    tags = record.tags.map((item) => {
      const predicate = asObject(item, ['namespace', 'key', 'operator', 'value']);
      if (typeof predicate.namespace !== 'string' || typeof predicate.key !== 'string'
        || !TAG_NAME.test(predicate.namespace) || !TAG_NAME.test(predicate.key)) {
        throw new TagServiceError(422, 'VALIDATION_ERROR');
      }
      const name = { namespace: predicate.namespace, key: predicate.key };
      if (predicate.operator !== 'eq') throw new TagServiceError(422, 'VALIDATION_ERROR');
      if (predicate.value === null || Array.isArray(predicate.value) || typeof predicate.value === 'object') {
        throw new TagServiceError(422, 'VALIDATION_ERROR');
      }
      const id = `${name.namespace}\u0000${name.key}`;
      if (seen.has(id)) throw new TagServiceError(422, 'VALIDATION_ERROR');
      seen.add(id);
      return { namespace: name.namespace, key: name.key, value: predicate.value as TagValue };
    });
  }
  let status: AgentStatus | null = null;
  if ('status' in record) {
    if (typeof record.status !== 'string' || !STATUSES.has(record.status as AgentStatus)) {
      throw new TagServiceError(422, 'VALIDATION_ERROR');
    }
    status = record.status as AgentStatus;
  }
  let limit = Math.min(25, maxLimit);
  if ('limit' in record) {
    if (typeof record.limit !== 'number' || !Number.isInteger(record.limit) || record.limit < 1 || record.limit > maxLimit) {
      throw new TagServiceError(422, 'VALIDATION_ERROR');
    }
    limit = record.limit;
  }
  let cursor: string | null = null;
  if ('cursor' in record) {
    if (typeof record.cursor !== 'string' || record.cursor.length < 1 || record.cursor.length > 4096) {
      throw new TagServiceError(422, 'VALIDATION_ERROR');
    }
    cursor = record.cursor;
  }
  return { tags, status, limit, cursor };
}

export function parseDefinitionListQuery(query: unknown): { namespace: string | null; limit: number; cursor: string | null } {
  if (query === null || typeof query !== 'object' || Array.isArray(query)) {
    throw new TagServiceError(400, 'VALIDATION_ERROR');
  }
  const record = query as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'namespace' && key !== 'limit' && key !== 'cursor') throw new TagServiceError(400, 'VALIDATION_ERROR');
  }
  let namespace: string | null = null;
  if ('namespace' in record) {
    if (typeof record.namespace !== 'string' || !TAG_NAME.test(record.namespace)) {
      throw new TagServiceError(400, 'VALIDATION_ERROR');
    }
    namespace = record.namespace;
  }
  let limit = 25;
  if ('limit' in record) {
    if (typeof record.limit !== 'string' || !/^[1-9][0-9]*$/.test(record.limit)) {
      throw new TagServiceError(400, 'VALIDATION_ERROR');
    }
    limit = Number(record.limit);
    if (limit > 100) throw new TagServiceError(400, 'VALIDATION_ERROR');
  }
  let cursor: string | null = null;
  if ('cursor' in record) {
    if (typeof record.cursor !== 'string' || record.cursor.length < 1 || record.cursor.length > 4096) {
      throw new TagServiceError(400, 'VALIDATION_ERROR');
    }
    cursor = record.cursor;
  }
  return { namespace, limit, cursor };
}

function sign(pepper: Buffer, payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', pepper).update(body).digest();
  return `${body}.${mac.toString('base64url')}`;
}

function openSigned(pepper: Buffer, token: string): unknown {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new TagServiceError(400, 'VALIDATION_ERROR');
  const actual = Buffer.from(parts[1], 'base64url');
  const expected = createHmac('sha256', pepper).update(parts[0]).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new TagServiceError(400, 'VALIDATION_ERROR');
  }
  try {
    return JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new TagServiceError(400, 'VALIDATION_ERROR');
  }
}

export function searchFilterKey(input: { tags: TagPredicate[] | null; status: AgentStatus | null }): string {
  return JSON.stringify({
    status: input.status,
    tags: (input.tags ?? []).map((item) => ({
      namespace: item.namespace,
      key: item.key,
      operator: 'eq',
      value: item.value,
    })),
  });
}

export function encodeSearchCursor(
  pepper: Buffer,
  claims: { org: string; filter: string; restricted: boolean; at: string; id: string },
  now = Date.now(),
): string {
  return sign(pepper, { v: 1, kind: 'tagsearch', ...claims, exp: now + CURSOR_TTL_MS });
}

export function decodeSearchCursor(
  pepper: Buffer,
  token: string,
  expected: { org: string; filter: string; restricted: boolean },
  now = Date.now(),
): { at: string; id: string } {
  const parsed = openSigned(pepper, token);
  if (parsed === null || typeof parsed !== 'object') throw new TagServiceError(400, 'VALIDATION_ERROR');
  const claims = parsed as Record<string, unknown>;
  if (claims.v !== 1 || claims.kind !== 'tagsearch') throw new TagServiceError(400, 'VALIDATION_ERROR');
  if (claims.org !== expected.org || claims.filter !== expected.filter || claims.restricted !== expected.restricted) {
    throw new TagServiceError(400, 'VALIDATION_ERROR');
  }
  if (typeof claims.exp !== 'number' || claims.exp <= now) throw new TagServiceError(400, 'VALIDATION_ERROR');
  if (typeof claims.at !== 'string' || Number.isNaN(Date.parse(claims.at))) throw new TagServiceError(400, 'VALIDATION_ERROR');
  if (typeof claims.id !== 'string' || !isUuid(claims.id)) throw new TagServiceError(400, 'VALIDATION_ERROR');
  return { at: claims.at, id: claims.id };
}

export function encodeDefinitionCursor(
  pepper: Buffer,
  claims: { org: string; namespace: string | null; restricted: boolean; ns: string; key: string },
  now = Date.now(),
): string {
  return sign(pepper, { v: 1, kind: 'tagdef', ...claims, exp: now + CURSOR_TTL_MS });
}

export function decodeDefinitionCursor(
  pepper: Buffer,
  token: string,
  expected: { org: string; namespace: string | null; restricted: boolean },
  now = Date.now(),
): { ns: string; key: string } {
  const parsed = openSigned(pepper, token);
  if (parsed === null || typeof parsed !== 'object') throw new TagServiceError(400, 'VALIDATION_ERROR');
  const claims = parsed as Record<string, unknown>;
  if (claims.v !== 1 || claims.kind !== 'tagdef') throw new TagServiceError(400, 'VALIDATION_ERROR');
  if (claims.org !== expected.org || claims.namespace !== expected.namespace || claims.restricted !== expected.restricted) {
    throw new TagServiceError(400, 'VALIDATION_ERROR');
  }
  if (typeof claims.exp !== 'number' || claims.exp <= now) throw new TagServiceError(400, 'VALIDATION_ERROR');
  if (typeof claims.ns !== 'string' || typeof claims.key !== 'string') throw new TagServiceError(400, 'VALIDATION_ERROR');
  return { ns: claims.ns, key: claims.key };
}

export function headerText(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) throw new TagServiceError(400, 'VALIDATION_ERROR');
  return value;
}
