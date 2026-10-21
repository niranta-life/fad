import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasScope, type KnownScope } from '@fad/auth-core';
import { API_VERSION, successEnvelope, type ErrorCode } from '@fad/contract';
import {
  AgentServiceError,
  IdempotencyConflictError,
  PolicyServiceError,
  TagServiceError,
  activatePolicy,
  createPolicy,
  disablePolicy,
  evaluateAgentAccess,
  getPolicy,
  headerText,
  isDependencyError,
  listPolicies,
  parseIdempotencyKey,
  updateDraftPolicy,
  type PolicyCommandResult,
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

export function registerPolicyRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const bodyLimit = deps.config.policyWriteBodyMaxBytes;

  app.post('/v1/policies', { bodyLimit }, async (request, reply) => run(deps, request, reply, ['policies:write'], async (caller, requestId) => {
    requireJson(request);
    const result = await createPolicy(deps.pool, actor(caller, requestId), idempotencyKey(request), request.body);
    return sendPolicy(deps, reply, requestId, result);
  }));

  app.get('/v1/policies', async (request, reply) => run(deps, request, reply, ['policies:read'], async (caller, requestId) => {
    const page = await listPolicies(deps.pool, actor(caller, requestId), request.query, deps.config.pepper);
    return deps.send(reply, requestId, 200, {
      data: page.policies,
      page: { next_cursor: page.nextCursor },
      meta: { request_id: requestId, api_version: API_VERSION },
    }, 'PolicyListResponse', 'private, no-store');
  }));

  app.get('/v1/policies/:policyId', async (request, reply) => run(deps, request, reply, ['policies:read'], async (caller, requestId) => {
    rejectQuery(request);
    const loaded = await getPolicy(deps.pool, actor(caller, requestId), policyIdOf(request));
    reply.header('etag', loaded.etag);
    return deps.send(reply, requestId, 200, successEnvelope(loaded.policy, requestId), 'PolicyResponse', 'private, no-store');
  }));

  app.put('/v1/policies/:policyId', { bodyLimit }, async (request, reply) => run(deps, request, reply, ['policies:write'], async (caller, requestId) => {
    requireJson(request);
    const result = await updateDraftPolicy(
      deps.pool,
      actor(caller, requestId),
      policyIdOf(request),
      idempotencyKey(request),
      headerText(request.headers['if-match']),
      request.body,
    );
    return sendPolicy(deps, reply, requestId, result);
  }));

  app.post('/v1/policies/:policyId/activate', { bodyLimit }, async (request, reply) => run(deps, request, reply, ['policies:write', 'policies:activate'], async (caller, requestId) => {
    rejectBody(request);
    const result = await activatePolicy(
      deps.pool,
      actor(caller, requestId),
      policyIdOf(request),
      idempotencyKey(request),
      headerText(request.headers['if-match']),
    );
    return sendPolicy(deps, reply, requestId, result);
  }));

  app.post('/v1/policies/:policyId/disable', { bodyLimit }, async (request, reply) => run(deps, request, reply, ['policies:write', 'policies:activate'], async (caller, requestId) => {
    rejectBody(request);
    const result = await disablePolicy(
      deps.pool,
      actor(caller, requestId),
      policyIdOf(request),
      idempotencyKey(request),
      headerText(request.headers['if-match']),
    );
    return sendPolicy(deps, reply, requestId, result);
  }));

  app.post('/v1/authorization/evaluate', { bodyLimit }, async (request, reply) => run(deps, request, reply, ['agents:read'], async (caller, requestId) => {
    requireJson(request);
    rejectQuery(request);
    const result = await evaluateAgentAccess(deps.pool, actor(caller, requestId), request.body);
    return deps.send(reply, requestId, result.status, successEnvelope(result.body, requestId), 'EvaluationResponse', 'private, no-store');
  }));
}

function actor(caller: Caller, requestId: string) {
  return {
    organizationId: caller.organizationId,
    principalId: caller.principalId,
    requestId,
    scopes: caller.scopes,
  };
}

function sendPolicy(deps: RouteDeps, reply: FastifyReply, requestId: string, result: PolicyCommandResult): FastifyReply {
  reply.header('etag', result.etag);
  if (result.location) reply.header('location', result.location);
  return deps.send(reply, requestId, result.status, successEnvelope(result.policy, requestId), 'PolicyResponse', 'private, no-store');
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
  if (error instanceof PolicyServiceError) {
    const code: ErrorCode = error.status === 401 ? 'UNAUTHORIZED' : error.code;
    return deps.sendError(reply, requestId, error.status, code);
  }
  if (error instanceof TagServiceError || error instanceof AgentServiceError) {
    return deps.sendError(reply, requestId, error.status, error.code);
  }
  if (error instanceof IdempotencyConflictError) return deps.sendError(reply, requestId, 409, 'IDEMPOTENCY_CONFLICT');
  if (isDependencyError(error)) return deps.sendError(reply, requestId, 503, 'DEPENDENCY_UNAVAILABLE');
  return undefined;
}

function requireJson(request: FastifyRequest): void {
  const raw = request.headers['content-type'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !/^application\/json(?:\s*;|$)/i.test(value)) {
    throw new PolicyServiceError(415, 'UNSUPPORTED_MEDIA_TYPE');
  }
}

function rejectBody(request: FastifyRequest): void {
  const length = Number(request.headers['content-length'] ?? '0');
  if (length > 0 || (request.body !== undefined && request.body !== null)) {
    throw new PolicyServiceError(400, 'VALIDATION_ERROR');
  }
}

function rejectQuery(request: FastifyRequest): void {
  const query = request.query;
  if (query && typeof query === 'object' && Object.keys(query).length > 0) {
    throw new PolicyServiceError(400, 'VALIDATION_ERROR');
  }
}

function idempotencyKey(request: FastifyRequest): string {
  return parseIdempotencyKey(headerText(request.headers['idempotency-key']));
}

function policyIdOf(request: FastifyRequest): string {
  return (request.params as { policyId?: string }).policyId ?? '';
}
