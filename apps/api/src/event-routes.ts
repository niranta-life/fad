import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hasScope, type KnownScope } from '@fad/auth-core';
import { API_VERSION, successEnvelope, type ErrorCode } from '@fad/contract';
import {
  EventServiceError,
  IdempotencyConflictError,
  headerText,
  isDependencyError,
  parseIdempotencyKey,
  createReplay,
  createSubscription,
  getEvent,
  getReplay,
  getSubscription,
  listDeliveries,
  listEvents,
  listSubscriptions,
  patchSubscription,
  rotateSubscriptionSecret,
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

export function registerEventRoutes(app: FastifyInstance, deps: RouteDeps): void {
  app.get('/v1/events', async (request, reply) => run(deps, request, reply, ['events:read'], async (caller, requestId) => {
    const page = await listEvents(deps.pool, actor(caller, requestId), eventQuery(request), deps.config.pepper);
    return deps.send(reply, requestId, 200, pageBody(requestId, page.events, page), 'EventListResponse', 'private, no-store');
  }));

  app.get('/v1/events/:eventId', async (request, reply) => run(deps, request, reply, ['events:read'], async (caller, requestId) => {
    rejectQuery(request);
    const event = await getEvent(deps.pool, actor(caller, requestId), param(request, 'eventId'));
    return deps.send(reply, requestId, 200, successEnvelope(event, requestId), 'EventResponse', 'private, no-store');
  }));

  app.post('/v1/event-subscriptions', { bodyLimit: 8192 }, async (request, reply) => run(deps, request, reply, ['events:subscribe'], async (caller, requestId) => {
    requireJson(request);
    rejectQuery(request);
    const result = await createSubscription(deps.pool, actor(caller, requestId), idempotencyKey(request), request.body);
    reply.header('etag', result.etag);
    return deps.send(reply, requestId, result.status, successEnvelope(result.body, requestId), 'EventSubscriptionCreateResponse', 'private, no-store');
  }));

  app.get('/v1/event-subscriptions', async (request, reply) => run(deps, request, reply, [], async (caller, requestId) => {
    requireAny(caller, ['events:subscribe', 'events:manage']);
    const page = await listSubscriptions(deps.pool, actor(caller, requestId), pageQuery(request), deps.config.pepper);
    return deps.send(reply, requestId, 200, pageBody(requestId, page.subscriptions, page), 'EventSubscriptionListResponse', 'private, no-store');
  }));

  app.get('/v1/event-subscriptions/:subscriptionId', async (request, reply) => run(deps, request, reply, [], async (caller, requestId) => {
    rejectQuery(request);
    requireAny(caller, ['events:subscribe', 'events:manage', 'events:replay', 'events:delivery:read']);
    const loaded = await getSubscription(deps.pool, actor(caller, requestId), param(request, 'subscriptionId'));
    reply.header('etag', loaded.etag);
    return deps.send(reply, requestId, 200, successEnvelope(loaded.subscription, requestId), 'EventSubscriptionResponse', 'private, no-store');
  }));

  app.patch('/v1/event-subscriptions/:subscriptionId', { bodyLimit: 1024 }, async (request, reply) => run(deps, request, reply, [], async (caller, requestId) => {
    requireJson(request);
    rejectQuery(request);
    requireAny(caller, ['events:subscribe', 'events:manage']);
    const result = await patchSubscription(
      deps.pool,
      actor(caller, requestId),
      param(request, 'subscriptionId'),
      idempotencyKey(request),
      headerText(request.headers['if-match']),
      request.body,
    );
    reply.header('etag', result.etag);
    return deps.send(reply, requestId, 200, successEnvelope(result.subscription, requestId), 'EventSubscriptionResponse', 'private, no-store');
  }));

  app.post('/v1/event-subscriptions/:subscriptionId/rotate-secret', async (request, reply) => run(deps, request, reply, [], async (caller, requestId) => {
    rejectQuery(request);
    requireAny(caller, ['events:subscribe', 'events:manage']);
    const result = await rotateSubscriptionSecret(
      deps.pool,
      actor(caller, requestId),
      param(request, 'subscriptionId'),
      idempotencyKey(request),
      headerText(request.headers['if-match']),
    );
    reply.header('etag', result.etag);
    return deps.send(reply, requestId, result.status, successEnvelope(result.body, requestId), 'EventSubscriptionRotateResponse', 'private, no-store');
  }));

  app.post('/v1/event-subscriptions/:subscriptionId/replays', { bodyLimit: 2048 }, async (request, reply) => run(deps, request, reply, ['events:replay', 'events:read', 'events:restricted:read'], async (caller, requestId) => {
    requireJson(request);
    rejectQuery(request);
    const result = await createReplay(
      deps.pool,
      actor(caller, requestId),
      param(request, 'subscriptionId'),
      idempotencyKey(request),
      request.body,
    );
    return deps.send(reply, requestId, 201, successEnvelope(result.replay, requestId), 'EventReplayResponse', 'private, no-store');
  }));

  app.get('/v1/event-subscriptions/:subscriptionId/replays/:replayId', async (request, reply) => run(deps, request, reply, ['events:replay'], async (caller, requestId) => {
    rejectQuery(request);
    const replay = await getReplay(deps.pool, actor(caller, requestId), param(request, 'subscriptionId'), param(request, 'replayId'));
    return deps.send(reply, requestId, 200, successEnvelope(replay, requestId), 'EventReplayResponse', 'private, no-store');
  }));

  app.get('/v1/event-subscriptions/:subscriptionId/deliveries', async (request, reply) => run(deps, request, reply, ['events:delivery:read'], async (caller, requestId) => {
    const page = await listDeliveries(deps.pool, actor(caller, requestId), param(request, 'subscriptionId'), pageQuery(request), deps.config.pepper);
    return deps.send(reply, requestId, 200, pageBody(requestId, page.deliveries, page), 'EventDeliveryListResponse', 'private, no-store');
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

function pageBody(
  requestId: string,
  data: unknown,
  page: { limit: number; nextCursor: string | null; hasMore: boolean },
): unknown {
  return {
    data,
    meta: {
      request_id: requestId,
      api_version: API_VERSION,
      limit: page.limit,
      next_cursor: page.nextCursor,
      has_more: page.hasMore,
    },
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
  if (error instanceof EventServiceError) return deps.sendError(reply, requestId, error.status, error.code);
  if (error instanceof IdempotencyConflictError) return deps.sendError(reply, requestId, 409, 'IDEMPOTENCY_CONFLICT');
  if (isDependencyError(error)) return deps.sendError(reply, requestId, 503, 'DEPENDENCY_UNAVAILABLE');
  return undefined;
}

function requireAny(caller: Caller, scopes: readonly KnownScope[]): void {
  if (!scopes.some((scope) => hasScope(caller.scopes, scope))) throw new EventServiceError(403, 'FORBIDDEN');
}

function requireJson(request: FastifyRequest): void {
  const raw = request.headers['content-type'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !/^application\/json(?:\s*;|$)/i.test(value)) {
    throw new EventServiceError(415, 'UNSUPPORTED_MEDIA_TYPE');
  }
}

function rejectQuery(request: FastifyRequest): void {
  const query = request.query;
  if (query && typeof query === 'object' && Object.keys(query).length > 0) {
    throw new EventServiceError(400, 'VALIDATION_ERROR');
  }
}

function idempotencyKey(request: FastifyRequest): string {
  try {
    return parseIdempotencyKey(headerText(request.headers['idempotency-key']));
  } catch {
    throw new EventServiceError(400, 'VALIDATION_ERROR');
  }
}

function param(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : '';
}

function pageQuery(request: FastifyRequest): { limit?: number; cursor?: string } {
  return readQuery(request, ['limit', 'cursor']);
}

function eventQuery(request: FastifyRequest): { type?: string; limit?: number; cursor?: string } {
  return readQuery(request, ['type', 'limit', 'cursor']);
}

function readQuery(request: FastifyRequest, allowed: readonly string[]): { type?: string; limit?: number; cursor?: string } {
  const query = request.query;
  if (!query || typeof query !== 'object' || Array.isArray(query)) return {};
  const record = query as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) throw new EventServiceError(400, 'VALIDATION_ERROR');
  }
  const out: { type?: string; limit?: number; cursor?: string } = {};
  if (record.type !== undefined) {
    if (typeof record.type !== 'string') throw new EventServiceError(400, 'VALIDATION_ERROR');
    out.type = record.type;
  }
  if (record.cursor !== undefined) {
    if (typeof record.cursor !== 'string' || record.cursor.length < 1 || record.cursor.length > 4096) {
      throw new EventServiceError(400, 'VALIDATION_ERROR');
    }
    out.cursor = record.cursor;
  }
  if (record.limit !== undefined) {
    if (typeof record.limit !== 'string' || !/^[1-9][0-9]{0,2}$/.test(record.limit)) {
      throw new EventServiceError(400, 'VALIDATION_ERROR');
    }
    out.limit = Number(record.limit);
  }
  return out;
}
