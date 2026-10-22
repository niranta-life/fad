import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasScope, type KnownScope } from '@fad/auth-core';
import { successEnvelope, type ErrorCode } from '@fad/contract';
import {
  AgentServiceError,
  CommittedDenial,
  EnforcementServiceError,
  IdempotencyConflictError,
  getEnforcementConfig,
  getEnforcementDecision,
  headerText,
  isDependencyError,
  parseIdempotencyKey,
  preflightEnforcement,
  setEnforcementConfig,
} from '@fad/db';
import type { Pool } from 'pg';
import { verifyCredential } from './auth.js';
import type { AppConfig } from './config.js';

interface RouteDeps {
  pool: Pool;
  config: AppConfig;
  send: (reply: FastifyReply, requestId: string, status: number, body: unknown, schema: string, cache: string) => FastifyReply;
  sendError: (reply: FastifyReply, requestId: string, status: number, code: ErrorCode, extra?: Record<string, string>) => FastifyReply;
  limitRequest: (
    pool: Pool,
    config: AppConfig,
    request: FastifyRequest,
    rawHeaders: readonly string[],
  ) => Promise<{ allowed: boolean; retryAfterSeconds: number }>;
  migrationsMatch: (pool: Pool, directory: string) => Promise<boolean>;
}

interface Caller {
  organizationId: string;
  principalId: string;
  scopes: readonly string[];
}

export function registerEnforcementRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const bodyLimit = 8192;

  app.get('/v1/enforcement/config', async (request, reply) => run(deps, request, reply, ['enforcement:read'], async (caller, requestId) => {
    rejectQuery(request);
    const loaded = await getEnforcementConfig(deps.pool, actor(caller, requestId));
    reply.header('etag', loaded.etag);
    return deps.send(reply, requestId, 200, successEnvelope(loaded.config, requestId), 'EnforcementConfigResponse', 'private, no-store');
  }));

  app.put('/v1/enforcement/config', { bodyLimit }, async (request, reply) => run(deps, request, reply, ['enforcement:manage'], async (caller, requestId) => {
    requireJson(request);
    const result = await setEnforcementConfig(
      deps.pool,
      actor(caller, requestId),
      idempotencyKey(request),
      headerText(request.headers['if-match']),
      request.body,
    );
    reply.header('etag', result.etag);
    return deps.send(reply, requestId, 200, successEnvelope(result.config, requestId), 'EnforcementConfigResponse', 'private, no-store');
  }));

  app.post('/v1/enforcement/preflight', { bodyLimit }, async (request, reply) => run(deps, request, reply, ['enforcement:manage'], async (caller, requestId) => {
    requireJson(request);
    rejectQuery(request);
    const result = await preflightEnforcement(deps.pool, actor(caller, requestId), request.body);
    return deps.send(reply, requestId, 200, successEnvelope(result, requestId), 'EnforcementPreflightResponse', 'private, no-store');
  }));

  app.get('/v1/enforcement/decisions/:decisionId', async (request, reply) => run(deps, request, reply, ['enforcement:audit'], async (caller, requestId) => {
    rejectQuery(request);
    const decision = await getEnforcementDecision(deps.pool, actor(caller, requestId), decisionIdOf(request));
    return deps.send(reply, requestId, 200, successEnvelope(decision, requestId), 'EnforcementDecisionResponse', 'private, no-store');
  }));
}

function actor(caller: Caller, requestId: string) {
  return {
    organizationId: caller.organizationId,
    principalId: caller.principalId,
    requestId,
    scopes: caller.scopes,
    channel: 'rest' as const,
  };
}

async function run(
  deps: RouteDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  scopes: readonly KnownScope[],
  fn: (caller: Caller, requestId: string) => Promise<FastifyReply>,
): Promise<FastifyReply> {
  const requestId = String(request.id);
  try {
    const caller = await authorize(deps, request, reply, requestId, scopes);
    if (!caller) return reply;
    return await fn(caller, requestId);
  } catch (error) {
    const sent = fail(deps, reply, requestId, error);
    if (sent) return sent;
    throw error;
  }
}

async function authorize(
  deps: RouteDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  requestId: string,
  scopes: readonly KnownScope[],
): Promise<Caller | undefined> {
  const raw = request.raw.rawHeaders;
  const limited = await deps.limitRequest(deps.pool, deps.config, request, raw);
  if (!limited.allowed) {
    deps.sendError(reply, requestId, 429, 'RATE_LIMITED', { 'retry-after': String(limited.retryAfterSeconds) });
    return undefined;
  }
  let schemaReady = false;
  try {
    schemaReady = await deps.migrationsMatch(deps.pool, deps.config.migrationsDir);
  } catch (error) {
    if (isDependencyError(error)) {
      deps.sendError(reply, requestId, 503, 'DEPENDENCY_UNAVAILABLE');
      return undefined;
    }
    throw error;
  }
  if (!schemaReady) {
    deps.sendError(reply, requestId, 503, 'DEPENDENCY_UNAVAILABLE');
    return undefined;
  }
  const verified = await verifyCredential(deps.pool, raw, deps.config.pepper);
  if (verified.kind === 'unavailable') {
    deps.sendError(reply, requestId, 503, 'DEPENDENCY_UNAVAILABLE');
    return undefined;
  }
  if (verified.kind === 'unauthorized') {
    deps.sendError(reply, requestId, 401, 'UNAUTHORIZED');
    return undefined;
  }
  if (scopes.some((scope) => !hasScope(verified.caller.scopes, scope))) {
    deps.sendError(reply, requestId, 403, 'FORBIDDEN');
    return undefined;
  }
  return {
    organizationId: verified.caller.organization.id,
    principalId: verified.caller.principalId,
    scopes: verified.caller.scopes,
  };
}

function fail(deps: RouteDeps, reply: FastifyReply, requestId: string, error: unknown): FastifyReply | undefined {
  if (error instanceof EnforcementServiceError || error instanceof CommittedDenial) {
    return deps.sendError(reply, requestId, error.statusCode, error.code);
  }
  if (error instanceof AgentServiceError) return deps.sendError(reply, requestId, error.status, error.code);
  if (error instanceof IdempotencyConflictError) return deps.sendError(reply, requestId, 409, 'IDEMPOTENCY_CONFLICT');
  if (isDependencyError(error)) return deps.sendError(reply, requestId, 503, 'DEPENDENCY_UNAVAILABLE');
  return undefined;
}

function requireJson(request: FastifyRequest): void {
  const raw = request.headers['content-type'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !/^application\/json(?:\s*;|$)/i.test(value)) {
    throw new EnforcementServiceError(415, 'UNSUPPORTED_MEDIA_TYPE');
  }
}

function rejectQuery(request: FastifyRequest): void {
  const query = request.query;
  if (query && typeof query === 'object' && Object.keys(query).length > 0) {
    throw new EnforcementServiceError(400, 'VALIDATION_ERROR');
  }
}

function idempotencyKey(request: FastifyRequest): string {
  return parseIdempotencyKey(headerText(request.headers['idempotency-key']));
}

function decisionIdOf(request: FastifyRequest): string {
  return (request.params as { decisionId?: string }).decisionId ?? '';
}
