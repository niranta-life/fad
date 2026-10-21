import { createHmac, timingSafeEqual } from 'node:crypto';
import { isUuid } from '@fad/auth-core';

export type AgentStatus = 'active' | 'suspended' | 'retired';
export type LifecycleAction = 'suspend' | 'activate' | 'retire';

export class AgentServiceError extends Error {
  readonly status: number;
  readonly code:
    | 'VALIDATION_ERROR'
    | 'UNAUTHORIZED'
    | 'AGENT_NOT_FOUND'
    | 'INVALID_STATE_TRANSITION'
    | 'IDEMPOTENCY_CONFLICT'
    | 'PRECONDITION_FAILED'
    | 'PRECONDITION_REQUIRED'
    | 'UNSUPPORTED_MEDIA_TYPE';

  constructor(status: number, code: AgentServiceError['code']) {
    super(code);
    this.name = 'AgentServiceError';
    this.status = status;
    this.code = code;
  }
}

const NAME_CONTROL = /[\u0000-\u001F\u007F]/u;
const TEXT_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const ETAG = /^"agent-v([1-9][0-9]*)"$/;

export function codePointLength(value: string): number {
  return Array.from(value).length;
}

export function agentEtag(revision: number): string {
  return `"agent-v${revision}"`;
}

export function parseEtag(value: string | undefined | null):
  | { kind: 'missing' }
  | { kind: 'malformed' }
  | { kind: 'ok'; revision: number } {
  if (value === undefined || value === null || value.length === 0) return { kind: 'missing' };
  const match = ETAG.exec(value);
  if (!match?.[1]) return { kind: 'malformed' };
  const revision = Number(match[1]);
  if (!Number.isSafeInteger(revision)) return { kind: 'malformed' };
  return { kind: 'ok', revision };
}

export function parseIdempotencyKey(value: string | undefined): string {
  if (!value || !IDEMPOTENCY_KEY.test(value)) throw new AgentServiceError(400, 'VALIDATION_ERROR');
  return value;
}

export function normalizeName(input: unknown): string {
  if (typeof input !== 'string') throw new AgentServiceError(422, 'VALIDATION_ERROR');
  const value = input.normalize('NFC').trim();
  if (NAME_CONTROL.test(value) || codePointLength(value) < 1 || codePointLength(value) > 160) {
    throw new AgentServiceError(422, 'VALIDATION_ERROR');
  }
  return value;
}

export function normalizeDescription(input: unknown, mode: 'create' | 'patch'): string | null {
  if (input === undefined) {
    if (mode === 'create') return '';
    throw new AgentServiceError(422, 'VALIDATION_ERROR');
  }
  if (input === null) {
    if (mode === 'create') throw new AgentServiceError(422, 'VALIDATION_ERROR');
    return null;
  }
  if (typeof input !== 'string') throw new AgentServiceError(422, 'VALIDATION_ERROR');
  const value = input.normalize('NFC');
  if (TEXT_CONTROL.test(value) || codePointLength(value) > 2000) {
    throw new AgentServiceError(422, 'VALIDATION_ERROR');
  }
  return value;
}

export function normalizeReason(input: unknown): string {
  if (typeof input !== 'string') throw new AgentServiceError(422, 'VALIDATION_ERROR');
  const value = input.normalize('NFC').trim();
  if (NAME_CONTROL.test(value) || codePointLength(value) < 1 || codePointLength(value) > 500) {
    throw new AgentServiceError(422, 'VALIDATION_ERROR');
  }
  return value;
}

function asObject(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new AgentServiceError(422, 'VALIDATION_ERROR');
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new AgentServiceError(422, 'VALIDATION_ERROR');
  }
  return record;
}

function principalId(value: unknown): string {
  if (typeof value !== 'string' || !isUuid(value)) throw new AgentServiceError(422, 'VALIDATION_ERROR');
  return value;
}

export interface AgentCreateInput {
  name: string;
  description: string;
  ownerPrincipalId: string;
}

export interface AgentPatchInput {
  name?: string;
  description?: string | null;
  ownerPrincipalId?: string;
}

export function parseCreateBody(body: unknown): AgentCreateInput {
  const record = asObject(body, ['name', 'description', 'owner_principal_id']);
  if (!('name' in record) || !('owner_principal_id' in record)) {
    throw new AgentServiceError(422, 'VALIDATION_ERROR');
  }
  const description = 'description' in record ? normalizeDescription(record.description, 'create') : '';
  return {
    name: normalizeName(record.name),
    description: description ?? '',
    ownerPrincipalId: principalId(record.owner_principal_id),
  };
}

export function parsePatchBody(body: unknown): AgentPatchInput {
  const record = asObject(body, ['name', 'description', 'owner_principal_id']);
  if (Object.keys(record).length < 1) throw new AgentServiceError(422, 'VALIDATION_ERROR');
  const patch: AgentPatchInput = {};
  if ('name' in record) patch.name = normalizeName(record.name);
  if ('description' in record) {
    const description = normalizeDescription(record.description, 'patch');
    patch.description = description;
  }
  if ('owner_principal_id' in record) patch.ownerPrincipalId = principalId(record.owner_principal_id);
  return patch;
}

export function parseLifecycleBody(body: unknown): string {
  const record = asObject(body, ['reason']);
  if (!('reason' in record)) throw new AgentServiceError(422, 'VALIDATION_ERROR');
  return normalizeReason(record.reason);
}

export function nextStatus(current: AgentStatus, action: LifecycleAction):
  | { kind: 'conflict' }
  | { kind: 'noop' }
  | { kind: 'change'; status: AgentStatus } {
  if (action === 'retire') {
    if (current === 'retired') return { kind: 'noop' };
    return { kind: 'change', status: 'retired' };
  }
  if (current === 'retired') return { kind: 'conflict' };
  if (action === 'suspend') {
    if (current === 'suspended') return { kind: 'noop' };
    return { kind: 'change', status: 'suspended' };
  }
  if (current === 'active') return { kind: 'noop' };
  return { kind: 'change', status: 'active' };
}

export function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalJson(item));
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalJson(source[key]);
    return out;
  }
  return value;
}

const CURSOR_TTL_MS = 24 * 60 * 60 * 1000;

interface CursorClaims {
  v: 1;
  org: string;
  status: AgentStatus | null;
  at: string;
  id: string;
  exp: number;
}

export function encodeCursor(pepper: Buffer, claims: Omit<CursorClaims, 'v' | 'exp'> & { exp?: number }, now = Date.now()): string {
  const payload: CursorClaims = {
    v: 1,
    org: claims.org,
    status: claims.status,
    at: claims.at,
    id: claims.id,
    exp: claims.exp ?? now + CURSOR_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', pepper).update(body).digest();
  return `${body}.${mac.toString('base64url')}`;
}

export function decodeCursor(
  pepper: Buffer,
  token: string,
  expected: { org: string; status: AgentStatus | null },
  now = Date.now(),
): { at: string; id: string } {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new AgentServiceError(400, 'VALIDATION_ERROR');
  const actual = Buffer.from(parts[1], 'base64url');
  const expectedMac = createHmac('sha256', pepper).update(parts[0]).digest();
  if (actual.length !== expectedMac.length || !timingSafeEqual(actual, expectedMac)) {
    throw new AgentServiceError(400, 'VALIDATION_ERROR');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    throw new AgentServiceError(400, 'VALIDATION_ERROR');
  }
  if (parsed === null || typeof parsed !== 'object') throw new AgentServiceError(400, 'VALIDATION_ERROR');
  const claims = parsed as Partial<CursorClaims>;
  if (claims.v !== 1 || claims.org !== expected.org || claims.status !== expected.status) {
    throw new AgentServiceError(400, 'VALIDATION_ERROR');
  }
  if (typeof claims.exp !== 'number' || claims.exp <= now) throw new AgentServiceError(400, 'VALIDATION_ERROR');
  if (typeof claims.at !== 'string' || Number.isNaN(Date.parse(claims.at))) throw new AgentServiceError(400, 'VALIDATION_ERROR');
  if (typeof claims.id !== 'string' || !isUuid(claims.id)) throw new AgentServiceError(400, 'VALIDATION_ERROR');
  return { at: claims.at, id: claims.id };
}

export const CURSOR_LIFETIME_MS = CURSOR_TTL_MS;
