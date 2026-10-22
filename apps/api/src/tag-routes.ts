import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasScope, isUuid, type KnownScope } from '@fad/auth-core';
import { API_VERSION, successEnvelope, type ErrorCode } from '@fad/contract';
import {
  AgentServiceError,
  IdempotencyConflictError,
  CommittedDenial,
  EnforcementServiceError,
  TagServiceError,
  createTagDefinition,
  deleteAgentTag,
  getAgentTag,
  getTagDefinition,
  headerText,
  isDependencyError,
  listAgentTags,
  listTagDefinitions,
  parseDefinitionBody,
  parseDefinitionListQuery,
  parseIdempotencyKey,
  parseSearchBody,
  parseTagName,
  parseTagPrecondition,
  parseTagPut,
  putAgentTag,
  searchAgents,
  type TagWriteResult,
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

export function registerTagRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const bodyLimit = deps.config.tagWriteBodyMaxBytes;
  const limits = {
    maxDefinitions: deps.config.tagDefinitionsMaxPerOrg,
    maxPerAgent: deps.config.tagMaxPerAgent,
  };

  app.post('/v1/tag-definitions', { bodyLimit }, async (request, reply) => run(deps, request, reply, ['tags:define'], async (caller, requestId) => {
    requireJson(request);
    const result = await createTagDefinition(
      deps.pool,
      actor(caller, requestId),
      idempotencyKey(request),
      parseDefinitionBody(request.body),
      limits,
    );
    return sendDefinition(deps, reply, requestId, result);
  }));

  app.get('/v1/tag-definitions', async (request, reply) => run(deps, request, reply, ['tags:read'], async (caller, requestId) => {
    const query = parseDefinitionListQuery(request.query);
    const page = await listTagDefinitions(deps.pool, actor(caller, requestId), query, deps.config.pepper);
    return deps.send(reply, requestId, 200, {
      data: page.definitions,
      meta: { request_id: requestId, api_version: API_VERSION, limit: page.limit, next_cursor: page.nextCursor },
    }, 'TagDefinitionListResponse', 'private, no-store');
  }));

  app.get('/v1/tag-definitions/:namespace/:key', async (request, reply) => run(deps, request, reply, ['tags:read'], async (caller, requestId) => {
    rejectQuery(request);
    const name = names(request);
    const definition = await getTagDefinition(deps.pool, actor(caller, requestId), name.namespace, name.key);
    return deps.send(reply, requestId, 200, successEnvelope(definition, requestId), 'TagDefinitionResponse', 'private, no-store');
  }));

  app.get('/v1/agents/:agentId/tags', async (request, reply) => run(deps, request, reply, ['agents:read', 'tags:read'], async (caller, requestId) => {
    rejectQuery(request);
    const assignments = await listAgentTags(deps.pool, actor(caller, requestId), agentIdOf(request));
    return deps.send(reply, requestId, 200, successEnvelope(assignments, requestId), 'TagAssignmentListResponse', 'private, no-store');
  }));

  app.get('/v1/agents/:agentId/tags/:namespace/:key', async (request, reply) => run(deps, request, reply, ['agents:read', 'tags:read'], async (caller, requestId) => {
    rejectQuery(request);
    const name = names(request);
    const loaded = await getAgentTag(deps.pool, actor(caller, requestId), agentIdOf(request), name.namespace, name.key);
    reply.header('etag', loaded.etag);
    return deps.send(reply, requestId, 200, successEnvelope(loaded.assignment, requestId), 'TagAssignmentResponse', 'private, no-store');
  }));

  app.put('/v1/agents/:agentId/tags/:namespace/:key', { bodyLimit }, async (request, reply) => run(deps, request, reply, ['tags:write'], async (caller, requestId) => {
    requireJson(request);
    const name = names(request);
    const precondition = parseTagPrecondition(headerText(request.headers['if-match']), headerText(request.headers['if-none-match']));
    const result = await putAgentTag(
      deps.pool,
      actor(caller, requestId),
      agentIdOf(request),
      name.namespace,
      name.key,
      idempotencyKey(request),
      precondition,
      parseTagPut(request.body),
      limits,
    );
    return sendAssignment(deps, reply, requestId, result);
  }));

  app.delete('/v1/agents/:agentId/tags/:namespace/:key', async (request, reply) => run(deps, request, reply, ['tags:write'], async (caller, requestId) => {
    rejectBody(request);
    const name = names(request);
    const ifNone = headerText(request.headers['if-none-match']);
    if (ifNone !== undefined) throw new TagServiceError(400, 'VALIDATION_ERROR');
    const precondition = parseTagPrecondition(headerText(request.headers['if-match']), undefined);
    if (precondition.kind !== 'match') throw new TagServiceError(400, 'VALIDATION_ERROR');
    const reason = headerText(request.headers['x-change-reason']) ?? null;
    const result = await deleteAgentTag(
      deps.pool,
      actor(caller, requestId),
      agentIdOf(request),
      name.namespace,
      name.key,
      idempotencyKey(request),
      precondition.revision,
      reason,
    );
    if (result.status !== 204) return sendAssignment(deps, reply, requestId, result);
    return reply.code(204).header('cache-control', 'private, no-store').header('x-request-id', requestId).send();
  }));

  app.post('/v1/agents/search', { bodyLimit }, async (request, reply) => run(deps, request, reply, ['agents:read'], async (caller, requestId) => {
    requireJson(request);
    const query = parseSearchBody(request.body, deps.config.tagSearchMaxPredicates, deps.config.tagSearchMaxLimit);
    if (query.tags && !hasScope(caller.scopes, 'tags:read')) throw new TagServiceError(403, 'FORBIDDEN');
    const page = await searchAgents(deps.pool, actor(caller, requestId), query, deps.config.pepper);
    return deps.send(reply, requestId, 200, {
      data: page.agents,
      meta: { request_id: requestId, api_version: API_VERSION, limit: page.limit, next_cursor: page.nextCursor },
    }, 'AgentListResponse', 'private, no-store');
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

function sendDefinition(deps: RouteDeps, reply: FastifyReply, requestId: string, result: TagWriteResult): FastifyReply {
  if (!result.definition) throw new Error('tag definition response is missing');
  if (result.location) reply.header('location', result.location);
  return deps.send(reply, requestId, result.status, successEnvelope(result.definition, requestId), 'TagDefinitionResponse', 'private, no-store');
}

function sendAssignment(deps: RouteDeps, reply: FastifyReply, requestId: string, result: TagWriteResult): FastifyReply {
  if (!result.assignment) throw new Error('tag assignment response is missing');
  if (result.etag) reply.header('etag', result.etag);
  if (result.location) reply.header('location', result.location);
  return deps.send(reply, requestId, result.status, successEnvelope(result.assignment, requestId), 'TagAssignmentResponse', 'private, no-store');
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
  if (error instanceof CommittedDenial || error instanceof EnforcementServiceError) {
    return deps.sendError(reply, requestId, error.statusCode, error.code);
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
    throw new TagServiceError(415, 'UNSUPPORTED_MEDIA_TYPE');
  }
}

function rejectBody(request: FastifyRequest): void {
  const length = Number(request.headers['content-length'] ?? '0');
  if (length > 0 || (request.body !== undefined && request.body !== null)) {
    throw new TagServiceError(400, 'VALIDATION_ERROR');
  }
}

function rejectQuery(request: FastifyRequest): void {
  const query = request.query;
  if (query && typeof query === 'object' && Object.keys(query).length > 0) {
    throw new TagServiceError(400, 'VALIDATION_ERROR');
  }
}

function idempotencyKey(request: FastifyRequest): string {
  return parseIdempotencyKey(headerText(request.headers['idempotency-key']));
}

function names(request: FastifyRequest): { namespace: string; key: string } {
  const params = request.params as { namespace?: string; key?: string };
  return parseTagName(params.namespace ?? '', params.key ?? '');
}

function agentIdOf(request: FastifyRequest): string {
  const id = (request.params as { agentId?: string }).agentId ?? '';
  if (!isUuid(id)) throw new TagServiceError(400, 'VALIDATION_ERROR');
  return id;
}
