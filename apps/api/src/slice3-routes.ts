import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasScope, isUuid, type KnownScope } from '@fad/auth-core';
import { API_VERSION, successEnvelope, type ErrorCode } from '@fad/contract';
import {
  AgentServiceError,
  BINDING_ETAG,
  ENDPOINT_ETAG,
  IdempotencyConflictError,
  Slice3ServiceError,
  TagServiceError,
  deleteBinding,
  deleteEndpoint,
  discoverAgents,
  getBinding,
  getCapability,
  getEndpoint,
  headerText,
  isDependencyError,
  listBindings,
  listCapabilities,
  listEndpoints,
  parseBindingPut,
  parseCapabilityId,
  parseCapabilityPublish,
  parseCapabilityVersion,
  parseCatalogQuery,
  parseDiscoveryBody,
  parseEndpointKey,
  parseEndpointPut,
  parseIdempotencyKey,
  parseSlice3Precondition,
  publishCapability,
  putBinding,
  putEndpoint,
  type WriteResult,
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

export function registerSlice3Routes(app: FastifyInstance, deps: RouteDeps): void {
  const limits = {
    maxEndpoints: deps.config.maxEndpointsPerAgent,
    maxBindings: deps.config.maxBindingsPerAgent,
    discoveryTimeoutMs: deps.config.discoveryQueryTimeoutMs,
  };

  app.post('/v1/capabilities', { bodyLimit: deps.config.capabilityPublishBodyMaxBytes }, async (request, reply) => run(deps, request, reply, ['capabilities:write'], async (caller, requestId) => {
    requireJson(request);
    const result = await publishCapability(deps.pool, actor(caller, requestId), idempotencyKey(request), parseCapabilityPublish(request.body));
    return sendCapability(deps, reply, requestId, result);
  }));

  app.get('/v1/capabilities', async (request, reply) => run(deps, request, reply, ['capabilities:read'], async (caller, requestId) => {
    const query = parseCatalogQuery(request.query, deps.config.maxCapabilityListLimit);
    const page = await listCapabilities(deps.pool, actor(caller, requestId), query, deps.config.pepper);
    return deps.send(reply, requestId, 200, {
      data: page.capabilities,
      meta: { request_id: requestId, api_version: API_VERSION, limit: page.limit, next_cursor: page.nextCursor },
    }, 'CapabilityListResponse', 'private, no-store');
  }));

  app.get('/v1/capabilities/:capabilityId/versions/:version', async (request, reply) => run(deps, request, reply, ['capabilities:read'], async (caller, requestId) => {
    rejectQuery(request);
    const params = request.params as { capabilityId?: string; version?: string };
    const capability = await getCapability(
      deps.pool,
      actor(caller, requestId),
      parseCapabilityId(params.capabilityId ?? '', 400),
      parseCapabilityVersion(params.version ?? '', 400),
    );
    return deps.send(reply, requestId, 200, successEnvelope(capability, requestId), 'CapabilityResponse', 'private, no-store');
  }));

  app.get('/v1/agents/:agentId/endpoints', async (request, reply) => run(deps, request, reply, ['agents:read', 'endpoints:read'], async (caller, requestId) => {
    rejectQuery(request);
    const endpoints = await listEndpoints(deps.pool, actor(caller, requestId), agentIdOf(request));
    return deps.send(reply, requestId, 200, successEnvelope(endpoints, requestId), 'EndpointListResponse', 'private, no-store');
  }));

  app.get('/v1/agents/:agentId/endpoints/:endpointKey', async (request, reply) => run(deps, request, reply, ['agents:read', 'endpoints:read'], async (caller, requestId) => {
    rejectQuery(request);
    const loaded = await getEndpoint(deps.pool, actor(caller, requestId), agentIdOf(request), endpointKeyOf(request));
    reply.header('etag', loaded.etag);
    return deps.send(reply, requestId, 200, successEnvelope(loaded.endpoint, requestId), 'EndpointResponse', 'private, no-store');
  }));

  app.put('/v1/agents/:agentId/endpoints/:endpointKey', { bodyLimit: deps.config.endpointWriteBodyMaxBytes }, async (request, reply) => run(deps, request, reply, ['endpoints:write'], async (caller, requestId) => {
    requireJson(request);
    const result = await putEndpoint(
      deps.pool,
      actor(caller, requestId),
      agentIdOf(request),
      endpointKeyOf(request),
      idempotencyKey(request),
      parseSlice3Precondition(headerText(request.headers['if-match']), headerText(request.headers['if-none-match']), ENDPOINT_ETAG),
      parseEndpointPut(request.body),
      limits,
    );
    return sendEndpoint(deps, reply, requestId, result);
  }));

  app.delete('/v1/agents/:agentId/endpoints/:endpointKey', async (request, reply) => run(deps, request, reply, ['endpoints:write'], async (caller, requestId) => {
    rejectBody(request);
    const precondition = deletePrecondition(request, ENDPOINT_ETAG);
    const result = await deleteEndpoint(
      deps.pool,
      actor(caller, requestId),
      agentIdOf(request),
      endpointKeyOf(request),
      idempotencyKey(request),
      precondition.revision,
    );
    if (result.status !== 204) return sendEndpoint(deps, reply, requestId, result);
    return reply.code(204).header('cache-control', 'private, no-store').header('x-request-id', requestId).send();
  }));

  app.get('/v1/agents/:agentId/capabilities', async (request, reply) => run(deps, request, reply, ['agents:read', 'capabilities:read'], async (caller, requestId) => {
    rejectQuery(request);
    const bindings = await listBindings(deps.pool, actor(caller, requestId), agentIdOf(request));
    return deps.send(reply, requestId, 200, successEnvelope(bindings, requestId), 'BindingListResponse', 'private, no-store');
  }));

  app.get('/v1/agents/:agentId/capabilities/:capabilityId', async (request, reply) => run(deps, request, reply, ['agents:read', 'capabilities:read'], async (caller, requestId) => {
    rejectQuery(request);
    const loaded = await getBinding(deps.pool, actor(caller, requestId), agentIdOf(request), capabilityIdOf(request));
    reply.header('etag', loaded.etag);
    return deps.send(reply, requestId, 200, successEnvelope(loaded.binding, requestId), 'BindingResponse', 'private, no-store');
  }));

  app.put('/v1/agents/:agentId/capabilities/:capabilityId', { bodyLimit: deps.config.bindingWriteBodyMaxBytes }, async (request, reply) => run(deps, request, reply, ['capabilities:write'], async (caller, requestId) => {
    requireJson(request);
    const result = await putBinding(
      deps.pool,
      actor(caller, requestId),
      agentIdOf(request),
      capabilityIdOf(request),
      idempotencyKey(request),
      parseSlice3Precondition(headerText(request.headers['if-match']), headerText(request.headers['if-none-match']), BINDING_ETAG),
      parseBindingPut(request.body),
      limits,
    );
    return sendBinding(deps, reply, requestId, result);
  }));

  app.delete('/v1/agents/:agentId/capabilities/:capabilityId', async (request, reply) => run(deps, request, reply, ['capabilities:write'], async (caller, requestId) => {
    rejectBody(request);
    const precondition = deletePrecondition(request, BINDING_ETAG);
    const result = await deleteBinding(
      deps.pool,
      actor(caller, requestId),
      agentIdOf(request),
      capabilityIdOf(request),
      idempotencyKey(request),
      precondition.revision,
    );
    if (result.status !== 204) return sendBinding(deps, reply, requestId, result);
    return reply.code(204).header('cache-control', 'private, no-store').header('x-request-id', requestId).send();
  }));

  app.post('/v1/discovery/agents', { bodyLimit: deps.config.discoveryBodyMaxBytes }, async (request, reply) => run(deps, request, reply, ['agents:read', 'capabilities:read', 'endpoints:read'], async (caller, requestId) => {
    requireJson(request);
    const query = parseDiscoveryBody(request.body, deps.config.maxDiscoveryLimit, deps.config.discoveryMaxPredicates);
    if (query.tags && !hasScope(caller.scopes, 'tags:read')) throw new Slice3ServiceError(403, 'FORBIDDEN');
    const page = await discoverAgents(deps.pool, actor(caller, requestId), query, deps.config.pepper, limits);
    return deps.send(reply, requestId, 200, {
      data: page.matches,
      meta: { request_id: requestId, api_version: API_VERSION, limit: page.limit, next_cursor: page.nextCursor },
    }, 'DiscoveryResponse', 'private, no-store');
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

function sendCapability(deps: RouteDeps, reply: FastifyReply, requestId: string, result: WriteResult): FastifyReply {
  if (!result.capability) throw new Error('capability response is missing');
  if (result.location) reply.header('location', result.location);
  return deps.send(reply, requestId, result.status, successEnvelope(result.capability, requestId), 'CapabilityResponse', 'private, no-store');
}

function sendEndpoint(deps: RouteDeps, reply: FastifyReply, requestId: string, result: WriteResult): FastifyReply {
  if (!result.endpoint) throw new Error('endpoint response is missing');
  if (result.etag) reply.header('etag', result.etag);
  if (result.location) reply.header('location', result.location);
  return deps.send(reply, requestId, result.status, successEnvelope(result.endpoint, requestId), 'EndpointResponse', 'private, no-store');
}

function sendBinding(deps: RouteDeps, reply: FastifyReply, requestId: string, result: WriteResult): FastifyReply {
  if (!result.binding) throw new Error('binding response is missing');
  if (result.etag) reply.header('etag', result.etag);
  if (result.location) reply.header('location', result.location);
  return deps.send(reply, requestId, result.status, successEnvelope(result.binding, requestId), 'BindingResponse', 'private, no-store');
}

function deletePrecondition(request: FastifyRequest, pattern: RegExp): { kind: 'match'; revision: number } {
  const precondition = parseSlice3Precondition(headerText(request.headers['if-match']), headerText(request.headers['if-none-match']), pattern);
  if (precondition.kind !== 'match') throw new Slice3ServiceError(400, 'VALIDATION_ERROR');
  return precondition;
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
  if (error instanceof Slice3ServiceError || error instanceof TagServiceError || error instanceof AgentServiceError) {
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
    throw new Slice3ServiceError(415, 'UNSUPPORTED_MEDIA_TYPE');
  }
}

function rejectBody(request: FastifyRequest): void {
  const length = Number(request.headers['content-length'] ?? '0');
  if (length > 0 || (request.body !== undefined && request.body !== null)) {
    throw new Slice3ServiceError(400, 'VALIDATION_ERROR');
  }
}

function rejectQuery(request: FastifyRequest): void {
  const query = request.query;
  if (query && typeof query === 'object' && Object.keys(query).length > 0) {
    throw new Slice3ServiceError(400, 'VALIDATION_ERROR');
  }
}

function idempotencyKey(request: FastifyRequest): string {
  return parseIdempotencyKey(headerText(request.headers['idempotency-key']));
}

function agentIdOf(request: FastifyRequest): string {
  const id = (request.params as { agentId?: string }).agentId ?? '';
  if (!isUuid(id)) throw new Slice3ServiceError(400, 'VALIDATION_ERROR');
  return id;
}

function endpointKeyOf(request: FastifyRequest): string {
  const key = (request.params as { endpointKey?: string }).endpointKey ?? '';
  return parseEndpointKey(key, 400);
}

function capabilityIdOf(request: FastifyRequest): string {
  const id = (request.params as { capabilityId?: string }).capabilityId ?? '';
  return parseCapabilityId(id, 400);
}
