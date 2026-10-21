import { Transform } from 'node:stream';
import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { redactText } from '@fad/auth-core';
import { contract, errorEnvelope, successEnvelope, type ErrorCode } from '@fad/contract';
import { cleanupRateLimits, consumeRateLimit, isDependencyError, rateLimitBucket, readMigrationFiles } from '@fad/db';
import type { Pool } from 'pg';
import { resolveCurrentOrganization } from './auth.js';
import type { AppConfig } from './config.js';

const PATHS = new Set(['/health/live', '/health/ready', '/v1/organizations/current']);

export interface AppHandle {
  app: FastifyInstance;
  markDraining: () => void;
}

function redactedStream(target: NodeJS.WritableStream, secrets: readonly string[]): Transform {
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      callback(null, redactText(chunk.toString('utf8'), secrets));
    },
  });
  stream.pipe(target);
  return stream;
}

export async function migrationsMatch(pool: Pool, directory: string): Promise<boolean> {
  const files = readMigrationFiles(directory);
  if (files.length === 0) return false;
  const result = await pool.query<{ version: string; checksum_sha256: string }>(
    'SELECT version, checksum_sha256 FROM schema_migrations',
  );
  const found = new Map(result.rows.map((row) => [row.version, row.checksum_sha256]));
  return files.every((file) => found.get(file.version) === file.checksum);
}

export async function assertRuntimeRole(pool: Pool): Promise<void> {
  const role = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
  );
  const row = role.rows[0];
  if (!row || row.rolsuper || row.rolbypassrls) {
    throw new Error('API database role is too privileged');
  }
  const privilege = await pool.query<{ allowed: boolean }>(
    `SELECT has_table_privilege(current_user, 'public.api_credentials', 'SELECT') AS allowed`,
  );
  if (privilege.rows[0]?.allowed) {
    throw new Error('API database role can read api_credentials');
  }
}

export async function buildApp(options: {
  config: AppConfig;
  pool: Pool;
  logStream?: NodeJS.WritableStream;
}): Promise<AppHandle> {
  const { config, pool } = options;
  let draining = false;
  const secrets = [config.pepper.toString('utf8'), config.databaseUrl];
  const stream = redactedStream(options.logStream ?? process.stdout, secrets);
  const app = Fastify({
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 16 * 1024,
    requestTimeout: config.requestTimeoutMs,
    trustProxy: config.trustProxy,
    logger: {
      level: config.logLevel,
      stream,
      serializers: {
        req(request) {
          return { method: request.method, url: request.url.split('?')[0] };
        },
      },
    },
  });
  // Clients that send the request and then FIN (Connection: close) are half-closed.
  // Node otherwise ends the socket before an async handler can write the status line.
  (app.server as unknown as { httpAllowHalfOpen: boolean }).httpAllowHalfOpen = true;

  function send(reply: FastifyReply, requestId: string, status: number, body: unknown, schema: string, cache: string): FastifyReply {
    try {
      contract().validate(schema, body);
    } catch {
      const fallback = errorEnvelope('INTERNAL_ERROR', requestId);
      return reply.code(500).header('cache-control', 'private, no-store').header('x-request-id', requestId)
        .type('application/json; charset=utf-8').send(fallback);
    }
    return reply.code(status).header('cache-control', cache).header('x-request-id', requestId)
      .type('application/json; charset=utf-8').send(body);
  }

  function sendError(reply: FastifyReply, requestId: string, status: number, code: ErrorCode, extra?: Record<string, string>): FastifyReply {
    if (extra) {
      for (const [key, value] of Object.entries(extra)) reply.header(key, value);
    }
    return send(reply, requestId, status, errorEnvelope(code, requestId), 'ErrorResponse', 'private, no-store');
  }

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    reply.header('x-content-type-options', 'nosniff');
  });

  app.addHook('preParsing', async (request, reply, payload) => {
    const length = Number(request.headers['content-length'] ?? '0');
    if ((request.method === 'GET' || request.method === 'HEAD') && length > 0) {
      sendError(reply, String(request.id), 400, 'VALIDATION_ERROR');
      return reply;
    }
    return payload;
  });

  app.addHook('onResponse', async (request, reply) => {
    request.log.info({
      request_id: request.id,
      status: reply.statusCode,
      method: request.method,
      path: request.url.split('?')[0],
    }, 'request');
  });

  app.setErrorHandler((error, request, reply) => {
    if (reply.sent) return;
    const requestId = String(request.id);
    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
      ? Number((error as { statusCode?: number }).statusCode)
      : 500;
    const dependency = isDependencyError(error) || statusCode === 503;
    const code: ErrorCode = statusCode === 413 ? 'PAYLOAD_TOO_LARGE' : dependency ? 'DEPENDENCY_UNAVAILABLE' : 'INTERNAL_ERROR';
    const status = statusCode === 413 ? 413 : dependency ? 503 : 500;
    const errorName = error instanceof Error ? error.name : 'Error';
    const errorMessage = error instanceof Error ? error.message : 'unknown';
    request.log.error({ request_id: requestId, status, error_code: code, error_name: errorName, error_message: errorMessage }, 'request failed');
    sendError(reply, requestId, status, code);
  });

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    const requestId = String(request.id);
    if (PATHS.has(path)) return sendError(reply, requestId, 405, 'METHOD_NOT_ALLOWED');
    return sendError(reply, requestId, 404, 'NOT_FOUND');
  });

  app.get('/health/live', async (request, reply) => {
    return send(reply, String(request.id), 200, { status: 'ok' }, 'Liveness', 'no-store');
  });

  app.get('/health/ready', async (request, reply) => {
    const requestId = String(request.id);
    if (draining) return send(reply, requestId, 503, { status: 'not_ready' }, 'HealthUnavailable', 'no-store');
    try {
      const ready = await migrationsMatch(pool, config.migrationsDir);
      if (!ready) return send(reply, requestId, 503, { status: 'not_ready' }, 'HealthUnavailable', 'no-store');
      await pool.query('SELECT 1');
      return send(reply, requestId, 200, { status: 'ready' }, 'Readiness', 'no-store');
    } catch {
      return send(reply, requestId, 503, { status: 'not_ready' }, 'HealthUnavailable', 'no-store');
    }
  });

  app.get('/v1/organizations/current', async (request, reply) => {
    const requestId = String(request.id);
    try {
      await cleanupRateLimits(pool).catch(() => undefined);
      const raw = request.raw.rawHeaders;
      const limited = await limitRequest(pool, config, request, raw);
      if (!limited.allowed) {
        return sendError(reply, requestId, 429, 'RATE_LIMITED', { 'retry-after': String(limited.retryAfterSeconds) });
      }
      const query = request.query;
      if (query && typeof query === 'object' && Object.keys(query).length > 0) {
        return sendError(reply, requestId, 400, 'VALIDATION_ERROR');
      }
      let schemaReady = false;
      try {
        schemaReady = await migrationsMatch(pool, config.migrationsDir);
      } catch {
        return sendError(reply, requestId, 503, 'DEPENDENCY_UNAVAILABLE');
      }
      if (!schemaReady) return sendError(reply, requestId, 503, 'DEPENDENCY_UNAVAILABLE');
      const resolved = await resolveCurrentOrganization(pool, raw, config.pepper);
      if (resolved.kind === 'unavailable') return sendError(reply, requestId, 503, 'DEPENDENCY_UNAVAILABLE');
      if (resolved.kind === 'unauthorized') return sendError(reply, requestId, 401, 'UNAUTHORIZED');
      if (resolved.kind === 'forbidden') return sendError(reply, requestId, 403, 'FORBIDDEN');
      return send(reply, requestId, 200, successEnvelope(resolved.organization, requestId), 'OrganizationResponse', 'private, no-store');
    } catch (error) {
      if (isDependencyError(error)) return sendError(reply, requestId, 503, 'DEPENDENCY_UNAVAILABLE');
      throw error;
    }
  });

  return {
    app,
    markDraining() {
      draining = true;
    },
  };
}

async function limitRequest(
  pool: Pool,
  config: AppConfig,
  request: FastifyRequest,
  rawHeaders: readonly string[],
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const ip = rateLimitBucket(config.pepper, `ip:${request.ip}`);
  const byIp = await consumeRateLimit(pool, ip, config.rateLimitMax, config.rateLimitWindowSeconds);
  if (!byIp.allowed) return byIp;
  const kidHeader = rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'x-fad-api-key');
  if (kidHeader.length === 1) {
    const index = rawHeaders.findIndex((value, position) => position % 2 === 0 && value.toLowerCase() === 'x-fad-api-key');
    const token = rawHeaders[index + 1] ?? '';
    const kid = /^fad_live\.([0-9a-f]{32})\./.exec(token)?.[1];
    if (kid) {
      return consumeRateLimit(
        pool,
        rateLimitBucket(config.pepper, `kid:${kid}`),
        config.rateLimitMax,
        config.rateLimitWindowSeconds,
      );
    }
  }
  return byIp;
}
