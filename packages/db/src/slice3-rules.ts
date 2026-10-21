import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { isUuid } from '@fad/auth-core';
import { canonicalJson, codePointLength } from './agent-rules.js';

// This module validates declarations. It must not resolve DNS or open a socket.
const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020.js') as new (options?: Record<string, unknown>) => {
  validateSchema(schema: object): boolean;
};

export const SLICE3_MIGRATION_VERSION = '20261022_001_capabilities_discovery';
export const DISCOVERY_CURSOR_TTL_MS = 15 * 60 * 1000;
export const SCHEMA_MAX_BYTES = 32 * 1024;
export const SCHEMA_MAX_DEPTH = 12;
export const SCHEMA_MAX_NODES = 300;
export const SEMVER_MAX = 2147483647;
const DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const SEGMENT = /^[a-z][a-z0-9_-]{0,39}$/;
const CAPABILITY_ID = /^[a-z][a-z0-9_-]{0,39}(?:\.[a-z][a-z0-9_-]{0,39}){1,3}$/;
const ENDPOINT_KEY = /^[a-z][a-z0-9_-]{0,39}$/;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const HOST_NAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))+$/;
const CONTROL = /[\u0000-\u001F\u007F]/u;
const FORBIDDEN_SCHEMA_KEYS = new Set([
  '$ref',
  '$dynamicRef',
  '$id',
  '$anchor',
  '$dynamicAnchor',
  '$recursiveRef',
  '$recursiveAnchor',
]);
const PROTOCOLS = new Set(['a2a', 'mcp', 'http_json']);
const AUTH_SCHEMES = new Set(['oauth2', 'mtls', 'api_key', 'none']);

export type Slice3Code =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'AGENT_NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'ENDPOINT_IN_USE'
  | 'CAPABILITY_NOT_FOUND'
  | 'ENDPOINT_NOT_FOUND'
  | 'BINDING_NOT_FOUND'
  | 'INVALID_CURSOR'
  | 'INVALID_AGENT_STATE'
  | 'PRECONDITION_FAILED'
  | 'PRECONDITION_REQUIRED'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'PAYLOAD_TOO_LARGE'
  | 'DEPENDENCY_UNAVAILABLE';

export class Slice3ServiceError extends Error {
  readonly status: number;
  readonly code: Slice3Code;

  constructor(status: number, code: Slice3Code) {
    super(code);
    this.name = 'Slice3ServiceError';
    this.status = status;
    this.code = code;
  }
}

export interface CapabilityPublishInput {
  id: string;
  version: string;
  display_name: string;
  description: string;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
}

export interface EndpointPutInput {
  protocol: 'a2a' | 'mcp' | 'http_json';
  url: string;
  auth_scheme: 'oauth2' | 'mtls' | 'api_key' | 'none';
  enabled: boolean;
}

export interface BindingPutInput {
  version: string;
  endpoint_key: string;
}

export interface DiscoveryTag {
  namespace: string;
  key: string;
  value: string | number | boolean;
}

export interface DiscoveryInput {
  capabilityId: string;
  version: string | null;
  tags: DiscoveryTag[] | null;
  protocols: Array<'a2a' | 'mcp' | 'http_json'> | null;
  limit: number;
  cursor: string | null;
}

export interface CatalogQuery {
  id: string | null;
  limit: number;
  cursor: string | null;
}

export type Slice3Precondition = { kind: 'match'; revision: number } | { kind: 'none' };

const schemaValidator = new Ajv2020({ strict: false, allErrors: false, validateSchema: false });

function fail(status: 400 | 422, code: Slice3Code = 'VALIDATION_ERROR'): never {
  throw new Slice3ServiceError(status, code);
}

function asRecord(body: unknown, allowed: readonly string[], status: 400 | 422): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) fail(status);
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) fail(status);
  }
  return record;
}

export function parseCapabilityId(value: unknown, status: 400 | 422): string {
  if (typeof value !== 'string' || value.length > 164 || !CAPABILITY_ID.test(value)) fail(status);
  return value;
}

export function parseCapabilityVersion(value: unknown, status: 400 | 422): string {
  if (typeof value !== 'string' || value.length > 32 || !SEMVER.test(value)) fail(status);
  const parts = value.split('.');
  if (parts.length !== 3) fail(status);
  for (const part of parts) {
    const number = Number(part);
    if (!Number.isSafeInteger(number) || number > SEMVER_MAX) fail(status);
  }
  return value;
}

export function parseEndpointKey(value: unknown, status: 400 | 422): string {
  if (typeof value !== 'string' || !ENDPOINT_KEY.test(value)) fail(status);
  return value;
}

function parseText(value: unknown, min: number, max: number, emptyOk: boolean): string {
  if (typeof value !== 'string') fail(422);
  if (value.normalize('NFC') !== value || CONTROL.test(value)) fail(422);
  const length = codePointLength(value);
  if (length > max || (length < min && !emptyOk)) fail(422);
  if (!emptyOk && value.trim().length < 1) fail(422);
  return value;
}

function assertSchema(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(422);
  const encoded = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (encoded > SCHEMA_MAX_BYTES) fail(422);
  const counter = { nodes: 0 };
  walkSchema(value, 1, counter);
  if (counter.nodes > SCHEMA_MAX_NODES) fail(422);
  try {
    if (schemaValidator.validateSchema(value) !== true) fail(422);
  } catch (error) {
    if (error instanceof Slice3ServiceError) throw error;
    fail(422);
  }
  return value as Record<string, unknown>;
}

function walkSchema(value: unknown, depth: number, counter: { nodes: number }): void {
  if (depth > SCHEMA_MAX_DEPTH) fail(422);
  counter.nodes += 1;
  if (counter.nodes > SCHEMA_MAX_NODES) fail(422);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(422);
    return;
  }
  if (typeof value !== 'object') fail(422);
  if (Array.isArray(value)) {
    for (const item of value) walkSchema(item, depth + 1, counter);
    return;
  }
  for (const [key, inner] of Object.entries(value)) {
    if (FORBIDDEN_SCHEMA_KEYS.has(key)) fail(422);
    if (key === '$schema' && (depth !== 1 || inner !== DRAFT)) fail(422);
    walkSchema(inner, depth + 1, counter);
  }
}

export function parseCapabilityPublish(body: unknown): CapabilityPublishInput {
  const record = asRecord(body, ['id', 'version', 'display_name', 'description', 'input_schema', 'output_schema'], 422);
  const description = record.description === undefined ? '' : parseText(record.description, 0, 2000, true);
  return {
    id: parseCapabilityId(record.id, 422),
    version: parseCapabilityVersion(record.version, 422),
    display_name: parseText(record.display_name, 1, 160, false),
    description,
    input_schema: assertSchema(record.input_schema),
    output_schema: assertSchema(record.output_schema),
  };
}

function jcsNumber(value: number): string {
  if (!Number.isFinite(value)) fail(422);
  if (Object.is(value, -0)) return '0';
  if (Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) return String(Math.trunc(value));
  const text = JSON.stringify(value);
  if (typeof text !== 'string') fail(422);
  return text;
}

export function jsonCanonical(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return jcsNumber(value);
  if (Array.isArray(value)) return `[${value.map((item) => jsonCanonical(item)).join(',')}]`;
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const keys = Object.keys(source).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${jsonCanonical(source[key])}`).join(',')}}`;
  }
  fail(422);
}

export function contractSha256(input: CapabilityPublishInput): string {
  const text = jsonCanonical({
    description: input.description,
    display_name: input.display_name,
    id: input.id,
    input_schema: input.input_schema,
    output_schema: input.output_schema,
    version: input.version,
  });
  return createHash('sha256').update(text).digest('hex');
}

function isIpLiteral(hostname: string): boolean {
  if (hostname.includes(':')) return true;
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

export function normalizeEndpointUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048) fail(422);
  if (value.normalize('NFC') !== value || CONTROL.test(value) || /[^\u0021-\u007E]/.test(value)) fail(422);
  if (value.includes('@') || value.includes('\\') || value.includes('?') || value.includes('#') || /\s/u.test(value)) fail(422);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(422);
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') fail(422);
  if (url.search !== '' || url.hash !== '' || url.href.includes('?') || url.href.includes('#')) fail(422);
  const host = url.hostname;
  if (host.length === 0 || host.endsWith('.') || isIpLiteral(host)) fail(422);
  if (host === 'localhost' || host.endsWith('.localhost')) fail(422);
  if (host.split('.').some((label) => label.startsWith('xn--'))) fail(422);
  if (!HOST_NAME.test(host)) fail(422);
  if (!url.href.startsWith('https://') || url.href.length > 2048) fail(422);
  return url.href;
}

export function parseEndpointPut(body: unknown): EndpointPutInput {
  const record = asRecord(body, ['protocol', 'url', 'auth_scheme', 'enabled'], 422);
  if (typeof record.protocol !== 'string' || !PROTOCOLS.has(record.protocol)) fail(422);
  if (typeof record.auth_scheme !== 'string' || !AUTH_SCHEMES.has(record.auth_scheme)) fail(422);
  const enabled = record.enabled === undefined ? true : record.enabled;
  if (typeof enabled !== 'boolean') fail(422);
  return {
    protocol: record.protocol as EndpointPutInput['protocol'],
    url: normalizeEndpointUrl(record.url),
    auth_scheme: record.auth_scheme as EndpointPutInput['auth_scheme'],
    enabled,
  };
}

export function parseBindingPut(body: unknown): BindingPutInput {
  const record = asRecord(body, ['version', 'endpoint_key'], 422);
  return {
    version: parseCapabilityVersion(record.version, 422),
    endpoint_key: parseEndpointKey(record.endpoint_key, 422),
  };
}

export function parseRevisionHeader(value: string, pattern: RegExp): number {
  const match = pattern.exec(value);
  if (!match?.[1]) fail(400);
  const revision = Number(match[1]);
  if (!Number.isSafeInteger(revision)) fail(400);
  return revision;
}

export function parseSlice3Precondition(
  ifMatch: string | undefined,
  ifNoneMatch: string | undefined,
  etagPattern: RegExp,
): Slice3Precondition {
  const matchPresent = ifMatch !== undefined;
  const nonePresent = ifNoneMatch !== undefined;
  if (matchPresent && nonePresent) fail(400);
  if (!matchPresent && !nonePresent) throw new Slice3ServiceError(428, 'PRECONDITION_REQUIRED');
  if (nonePresent) {
    if (ifNoneMatch !== '*') fail(400);
    return { kind: 'none' };
  }
  return { kind: 'match', revision: parseRevisionHeader(ifMatch ?? '', etagPattern) };
}

function parseLimit(value: unknown, max: number, statusForRange: 400 | 422): number {
  if (typeof value === 'number' && Number.isInteger(value)) {
    if (value < 1 || value > max) throw new Slice3ServiceError(statusForRange, 'VALIDATION_ERROR');
    return value;
  }
  fail(422);
}

export function parseCatalogQuery(query: unknown, maxLimit: number): CatalogQuery {
  const record = query && typeof query === 'object' ? query as Record<string, unknown> : {};
  for (const key of Object.keys(record)) {
    if (key !== 'id' && key !== 'limit' && key !== 'cursor') fail(400);
  }
  let id: string | null = null;
  if ('id' in record) id = parseCapabilityId(record.id, 400);
  let limit = Math.min(25, maxLimit);
  if ('limit' in record) {
    if (typeof record.limit !== 'string' || !/^[1-9][0-9]*$/.test(record.limit)) fail(400);
    const parsed = Number(record.limit);
    if (parsed > maxLimit) throw new Slice3ServiceError(422, 'VALIDATION_ERROR');
    limit = parsed;
  }
  let cursor: string | null = null;
  if ('cursor' in record) {
    if (typeof record.cursor !== 'string' || record.cursor.length < 1 || record.cursor.length > 4096) {
      throw new Slice3ServiceError(400, 'INVALID_CURSOR');
    }
    cursor = record.cursor;
  }
  return { id, limit, cursor };
}

export function parseDiscoveryBody(body: unknown, maxLimit: number, maxPredicates: number): DiscoveryInput {
  const record = asRecord(body, ['capability', 'tags', 'protocols', 'limit', 'cursor'], 422);
  const capability = asRecord(record.capability, ['id', 'version'], 422);
  const capabilityId = parseCapabilityId(capability.id, 422);
  const version = capability.version === undefined ? null : parseCapabilityVersion(capability.version, 422);
  let tags: DiscoveryTag[] | null = null;
  if (record.tags !== undefined) {
    if (!Array.isArray(record.tags) || record.tags.length < 1 || record.tags.length > maxPredicates) fail(422);
    const seen = new Set<string>();
    tags = record.tags.map((item) => {
      const predicate = asRecord(item, ['namespace', 'key', 'operator', 'value'], 422);
      if (typeof predicate.namespace !== 'string' || !SEGMENT.test(predicate.namespace)) fail(422);
      if (typeof predicate.key !== 'string' || !SEGMENT.test(predicate.key)) fail(422);
      if (predicate.operator !== 'eq') fail(422);
      const identity = `${predicate.namespace}\u0000${predicate.key}`;
      if (seen.has(identity)) fail(422);
      seen.add(identity);
      return { namespace: predicate.namespace, key: predicate.key, value: predicate.value as DiscoveryTag['value'] };
    });
  }
  let protocols: DiscoveryInput['protocols'] = null;
  if (record.protocols !== undefined) {
    if (!Array.isArray(record.protocols) || record.protocols.length < 1 || record.protocols.length > 3) fail(422);
    const unique = new Set<string>();
    protocols = record.protocols.map((item) => {
      if (typeof item !== 'string' || !PROTOCOLS.has(item) || unique.has(item)) fail(422);
      unique.add(item);
      return item as 'a2a' | 'mcp' | 'http_json';
    });
  }
  const limit = record.limit === undefined ? Math.min(25, maxLimit) : parseLimit(record.limit, maxLimit, 422);
  let cursor: string | null = null;
  if (record.cursor !== undefined) {
    if (typeof record.cursor !== 'string' || record.cursor.length < 1 || record.cursor.length > 4096) {
      throw new Slice3ServiceError(400, 'INVALID_CURSOR');
    }
    cursor = record.cursor;
  }
  return { capabilityId, version, tags, protocols, limit, cursor };
}

function sign(pepper: Buffer, payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', pepper).update(body).digest();
  return `${body}.${mac.toString('base64url')}`;
}

function openSigned(pepper: Buffer, token: string): unknown {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Slice3ServiceError(400, 'INVALID_CURSOR');
  let actual: Buffer;
  try {
    actual = Buffer.from(parts[1], 'base64url');
  } catch {
    throw new Slice3ServiceError(400, 'INVALID_CURSOR');
  }
  const expected = createHmac('sha256', pepper).update(parts[0]).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Slice3ServiceError(400, 'INVALID_CURSOR');
  }
  try {
    return JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new Slice3ServiceError(400, 'INVALID_CURSOR');
  }
}

export function scopeFingerprint(scopes: readonly string[]): string {
  return [...scopes].sort().join(',');
}

export function catalogFilterKey(id: string | null): string {
  return JSON.stringify(canonicalJson({ id }));
}

export function discoveryFilterKey(input: Pick<DiscoveryInput, 'capabilityId' | 'version' | 'tags' | 'protocols'>): string {
  return JSON.stringify(canonicalJson({
    capability_id: input.capabilityId,
    version: input.version,
    protocols: input.protocols,
    tags: (input.tags ?? []).map((item) => ({
      namespace: item.namespace,
      key: item.key,
      operator: 'eq',
      value: item.value,
    })),
  }));
}

export function encodeCatalogCursor(
  pepper: Buffer,
  claims: { org: string; principal: string; scopes: string; filter: string; id: string; version: string },
  now = Date.now(),
  ttl = DISCOVERY_CURSOR_TTL_MS,
): string {
  return sign(pepper, { v: 1, kind: 'capability', ...claims, exp: now + ttl });
}

export function decodeCatalogCursor(
  pepper: Buffer,
  token: string,
  expected: { org: string; principal: string; scopes: string; filter: string },
  now = Date.now(),
): { id: string; version: string } {
  const parsed = openSigned(pepper, token);
  if (parsed === null || typeof parsed !== 'object') throw new Slice3ServiceError(400, 'INVALID_CURSOR');
  const claims = parsed as Record<string, unknown>;
  if (claims.v !== 1 || claims.kind !== 'capability') throw new Slice3ServiceError(400, 'INVALID_CURSOR');
  if (claims.org !== expected.org || claims.principal !== expected.principal) {
    throw new Slice3ServiceError(400, 'INVALID_CURSOR');
  }
  if (claims.scopes !== expected.scopes || claims.filter !== expected.filter) {
    throw new Slice3ServiceError(400, 'INVALID_CURSOR');
  }
  if (typeof claims.exp !== 'number' || claims.exp <= now) throw new Slice3ServiceError(400, 'INVALID_CURSOR');
  if (typeof claims.id !== 'string' || typeof claims.version !== 'string') {
    throw new Slice3ServiceError(400, 'INVALID_CURSOR');
  }
  return { id: claims.id, version: claims.version };
}

export function encodeDiscoveryCursor(
  pepper: Buffer,
  claims: { org: string; principal: string; scopes: string; filter: string; id: string },
  now = Date.now(),
  ttl = DISCOVERY_CURSOR_TTL_MS,
): string {
  if (!isUuid(claims.id)) throw new Slice3ServiceError(400, 'INVALID_CURSOR');
  return sign(pepper, { v: 1, kind: 'discovery', ...claims, exp: now + ttl });
}

export function decodeDiscoveryCursor(
  pepper: Buffer,
  token: string,
  expected: { org: string; principal: string; scopes: string; filter: string },
  now = Date.now(),
): { id: string } {
  const parsed = openSigned(pepper, token);
  if (parsed === null || typeof parsed !== 'object') throw new Slice3ServiceError(400, 'INVALID_CURSOR');
  const claims = parsed as Record<string, unknown>;
  if (claims.v !== 1 || claims.kind !== 'discovery') throw new Slice3ServiceError(400, 'INVALID_CURSOR');
  if (claims.org !== expected.org || claims.principal !== expected.principal) {
    throw new Slice3ServiceError(400, 'INVALID_CURSOR');
  }
  if (claims.scopes !== expected.scopes || claims.filter !== expected.filter) {
    throw new Slice3ServiceError(400, 'INVALID_CURSOR');
  }
  if (typeof claims.exp !== 'number' || claims.exp <= now) throw new Slice3ServiceError(400, 'INVALID_CURSOR');
  if (typeof claims.id !== 'string' || !isUuid(claims.id)) throw new Slice3ServiceError(400, 'INVALID_CURSOR');
  return { id: claims.id };
}

export function sameEndpoint(left: EndpointPutInput, right: EndpointPutInput): boolean {
  return left.protocol === right.protocol
    && left.url === right.url
    && left.auth_scheme === right.auth_scheme
    && left.enabled === right.enabled;
}

export function sameBinding(left: BindingPutInput, right: BindingPutInput): boolean {
  return left.version === right.version && left.endpoint_key === right.endpoint_key;
}
