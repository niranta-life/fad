import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasScope, isUuid, type KnownScope } from '@fad/auth-core';
import { API_VERSION, successEnvelope, type ErrorCode } from '@fad/contract';
import {
  AgentServiceError,
  IdempotencyConflictError,
  agentEtag,
  getAgent,
  isDependencyError,
  listAgents,
  parseEtag,
  parseIdempotencyKey,
  registerAgent,
  transitionAgent,
  updateAgent,
  type AgentCommandResult,
  type AgentStatus,
} from '@fad/db';
import type { Pool } from 'pg';
import { verifyCredential } from './auth.js';
import type { AppConfig } from './config.js';

const STATUSES = new Set<AgentStatus>(['active', 'suspended', 'retired']);

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
}

export function registerAgentRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.post('/v1/agents', async (request, reply) => mutate(deps, request, reply, 'agents:write', async (caller, requestId) => {
    requireJson(request);
    const result = await registerAgent(deps.pool, { ...caller, requestId }, idempotencyKey(request), request.body);
    return sendAgent(deps, reply, requestId, result);
  }));

  app.get('/v1/agents', async (request, reply) => read(deps, request, reply, async (caller, requestId) => {
    const query = listQuery(request.query);
    const page = await listAgents(deps.pool, caller.organizationId, query, deps.config.pepper);
    return deps.send(reply, requestId, 200, {
      data: page.agents,
      meta: { request_id: requestId, api_version: API_VERSION, limit: page.limit, next_cursor: page.nextCursor },
    }, 'AgentListResponse', 'private, no-store');
  }));

  app.get('/v1/agents/:agentId', async (request, reply) => read(deps, request, reply, async (caller, requestId) => {
    const agent = await getAgent(deps.pool, caller.organizationId, agentIdOf(request));
    return sendAgent(deps, reply, requestId, { status: 200, agent, etag: agentEtag(agent.revision) });
  }));

  app.patch('/v1/agents/:agentId', async (request, reply) => mutate(deps, request, reply, 'agents:write', async (caller, requestId) => {
    requireJson(request);
    const result = await updateAgent(
      deps.pool,
      { ...caller, requestId },
      agentIdOf(request),
      idempotencyKey(request),
      ifMatch(request),
      request.body,
    );
    return sendAgent(deps, reply, requestId, result);
  }));

  for (const action of ['suspend', 'activate', 'retire'] as const) {
    app.post(`/v1/agents/:agentId/${action}`, async (request, reply) => mutate(deps, request, reply, 'agents:lifecycle', async (caller, requestId) => {
      requireJson(request);
      const result = await transitionAgent(
        deps.pool,
        { ...caller, requestId },
        agentIdOf(request),
        action,
        idempotencyKey(request),
        ifMatch(request),
        request.body,
      );
      return sendAgent(deps, reply, requestId, result);
    }));
  }
}

async function read(
  deps: RouteDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  fn: (caller: Caller, requestId: string) => Promise<FastifyReply>,
): Promise<FastifyReply> {
  return run(deps, request, reply, 'agents:read', fn);
}

async function mutate(
  deps: RouteDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  scope: KnownScope,
  fn: (caller: Caller, requestId: string) => Promise<FastifyReply>,
): Promise<FastifyReply> {
  return run(deps, request, reply, scope, fn);
}

async function run(
  deps: RouteDeps,
  request: FastifyRequest,
  reply: FastifyReply,
  scope: KnownScope,
  fn: (caller: Caller, requestId: string) => Promise<FastifyReply>,
): Promise<FastifyReply> {
  const requestId = String(request.id);
  try {
    const caller = await authorize(deps, request, reply, requestId, scope);
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
  scope: KnownScope,
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
  if (!hasScope(verified.caller.scopes, scope)) {
    deps.sendError(reply, requestId, 403, 'FORBIDDEN');
    return undefined;
  }
  return { organizationId: verified.caller.organization.id, principalId: verified.caller.principalId };
}

function sendAgent(deps: RouteDeps, reply: FastifyReply, requestId: string, result: AgentCommandResult): FastifyReply {
  reply.header('etag', result.etag);
  if (result.location) reply.header('location', result.location);
  return deps.send(reply, requestId, result.status, successEnvelope(result.agent, requestId), 'AgentResponse', 'private, no-store');
}

function fail(deps: RouteDeps, reply: FastifyReply, requestId: string, error: unknown): FastifyReply | undefined {
  if (error instanceof AgentServiceError) return deps.sendError(reply, requestId, error.status, error.code);
  if (error instanceof IdempotencyConflictError) return deps.sendError(reply, requestId, 409, 'IDEMPOTENCY_CONFLICT');
  if (isDependencyError(error)) return deps.sendError(reply, requestId, 503, 'DEPENDENCY_UNAVAILABLE');
  return undefined;
}

function requireJson(request: FastifyRequest): void {
  const raw = request.headers['content-type'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !/^application\/json(?:\s*;|$)/i.test(value)) {
    throw new AgentServiceError(415, 'UNSUPPORTED_MEDIA_TYPE');
  }
}

function idempotencyKey(request: FastifyRequest): string {
  const raw = request.headers['idempotency-key'];
  if (Array.isArray(raw)) throw new AgentServiceError(400, 'VALIDATION_ERROR');
  return parseIdempotencyKey(raw);
}

function ifMatch(request: FastifyRequest): string {
  const raw = request.headers['if-match'];
  if (Array.isArray(raw)) throw new AgentServiceError(400, 'VALIDATION_ERROR');
  const parsed = parseEtag(typeof raw === 'string' ? raw : undefined);
  if (parsed.kind === 'missing') throw new AgentServiceError(428, 'PRECONDITION_REQUIRED');
  if (parsed.kind === 'malformed') throw new AgentServiceError(400, 'VALIDATION_ERROR');
  return agentEtag(parsed.revision);
}

function agentIdOf(request: FastifyRequest): string {
  const id = (request.params as { agentId?: string }).agentId ?? '';
  if (!isUuid(id)) throw new AgentServiceError(400, 'VALIDATION_ERROR');
  return id;
}

function listQuery(query: unknown): { status: AgentStatus | null; limit: number; cursor: string | null } {
  if (query === null || typeof query !== 'object' || Array.isArray(query)) {
    throw new AgentServiceError(400, 'VALIDATION_ERROR');
  }
  const record = query as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'status' && key !== 'limit' && key !== 'cursor') throw new AgentServiceError(400, 'VALIDATION_ERROR');
  }
  let status: AgentStatus | null = null;
  if ('status' in record) {
    if (typeof record.status !== 'string' || !STATUSES.has(record.status as AgentStatus)) {
      throw new AgentServiceError(400, 'VALIDATION_ERROR');
    }
    status = record.status as AgentStatus;
  }
  let limit = 25;
  if ('limit' in record) {
    if (typeof record.limit !== 'string' || !/^[1-9][0-9]*$/.test(record.limit)) {
      throw new AgentServiceError(400, 'VALIDATION_ERROR');
    }
    limit = Number(record.limit);
    if (limit > 100) throw new AgentServiceError(400, 'VALIDATION_ERROR');
  }
  let cursor: string | null = null;
  if ('cursor' in record) {
    if (typeof record.cursor !== 'string' || record.cursor.length < 1 || record.cursor.length > 4096) {
      throw new AgentServiceError(400, 'VALIDATION_ERROR');
    }
    cursor = record.cursor;
  }
  return { status, limit, cursor };
}
