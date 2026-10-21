import { Transform } from 'node:stream';
import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { redactText } from '@fad/auth-core';
import { contract, errorEnvelope, successEnvelope, type ErrorCode } from '@fad/contract';
import { MCP_MIGRATION_VERSION, POLICY_MIGRATION_VERSION, SLICE3_MIGRATION_VERSION, TAG_MIGRATION_VERSION, cleanupRateLimits, consumeRateLimit, isDependencyError, rateLimitBucket, readMigrationFiles } from '@fad/db';
import type { Pool } from 'pg';
import { registerAgentRoutes } from './agent-routes.js';
import { JsonLimitError, assertJsonLimits } from './json-limits.js';
import { registerMcpRoutes } from './mcp-routes.js';
import { registerPolicyRoutes } from './policy-routes.js';
import { registerSlice3Routes } from './slice3-routes.js';
import { registerTagRoutes } from './tag-routes.js';
import { resolveCurrentOrganization } from './auth.js';
import type { AppConfig } from './config.js';

const PATHS = new Set(['/health/live', '/health/ready', '/v1/organizations/current', '/v1/agents']);
const AGENT_PATH = /^\/v1\/agents\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\/(?:suspend|activate|retire))?$/i;
const TAG_DEFINITION_PATH = /^\/v1\/tag-definitions\/[a-z][a-z0-9_-]{0,39}\/[a-z][a-z0-9_-]{0,39}$/;
const AGENT_TAGS_PATH = /^\/v1\/agents\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/tags(?:\/[a-z][a-z0-9_-]{0,39}\/[a-z][a-z0-9_-]{0,39})?$/i;
const CAPABILITY_VERSION_PATH = /^\/v1\/capabilities\/[^/]+\/versions\/[^/]+$/;
const AGENT_ENDPOINT_PATH = /^\/v1\/agents\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/endpoints(?:\/[^/]+)?$/i;
const AGENT_BINDING_PATH = /^\/v1\/agents\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/capabilities(?:\/[^/]+)?$/i;
const POLICY_PATH = /^\/v1\/policies(?:\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\/(?:activate|disable))?)?$/i;

function knownPath(path: string, tagsEnabled: boolean, slice3Enabled: boolean, mcpEnabled: boolean, policiesEnabled: boolean): boolean {
  if (PATHS.has(path) || AGENT_PATH.test(path)) return true;
  if (mcpEnabled && (path === '/mcp' || path === '/.well-known/oauth-protected-resource/mcp')) return true;
  if (tagsEnabled && (path === '/v1/tag-definitions' || path === '/v1/agents/search' || TAG_DEFINITION_PATH.test(path) || AGENT_TAGS_PATH.test(path))) {
    return true;
  }
  if (policiesEnabled && (path === '/v1/policies' || path === '/v1/authorization/evaluate' || POLICY_PATH.test(path))) return true;
  if (!slice3Enabled) return false;
  if (path === '/v1/capabilities' || path === '/v1/discovery/agents') return true;
  return CAPABILITY_VERSION_PATH.test(path) || AGENT_ENDPOINT_PATH.test(path) || AGENT_BINDING_PATH.test(path);
}

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

export async function assertMcpBindingPrivileges(pool: Pool): Promise<void> {
  const exists = await pool.query<{ present: string | null }>(
    `SELECT to_regclass('public.mcp_principal_bindings')::text AS present`,
  );
  if (!exists.rows[0]?.present) return;
  const privilege = await pool.query<{ can_insert: boolean; can_update: boolean; can_delete: boolean }>(
    `SELECT
       has_table_privilege(current_user, 'public.mcp_principal_bindings', 'INSERT') AS can_insert,
       has_table_privilege(current_user, 'public.mcp_principal_bindings', 'UPDATE') AS can_update,
       has_table_privilege(current_user, 'public.mcp_principal_bindings', 'DELETE') AS can_delete`,
  );
  const row = privilege.rows[0];
  if (!row || row.can_insert || row.can_update || row.can_delete) {
    throw new Error('API database role can write MCP bindings');
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
    requestTimeout: Math.max(config.requestTimeoutMs, config.mcp.enabled ? config.mcp.requestTimeoutMs : 0),
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

  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(/^application\/json(?:\s*;|$)/i, { parseAs: 'string' }, (request, body, done) => {
    const text = typeof body === 'string' ? body : '';
    const path = request.url.split('?')[0] ?? '';
    try {
      if (path === '/mcp') assertJsonLimits(text, 32);
      if (config.policiesEnabled && (path === '/v1/policies' || path.startsWith('/v1/policies/') || path === '/v1/authorization/evaluate')) {
        assertJsonLimits(text, 8);
      }
      done(null, JSON.parse(text) as unknown);
    } catch (error) {
      if (error instanceof JsonLimitError) {
        done(error);
        return;
      }
      const syntax = error instanceof SyntaxError ? error : new SyntaxError('Invalid JSON');
      Object.assign(syntax, { statusCode: 400 });
      done(syntax);
    }
  });

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
    const path = request.url.split('?')[0] ?? '';
    if (config.tagsEnabled && path === '/v1/agents/search' && request.method !== 'POST') {
      sendError(reply, String(request.id), 405, 'METHOD_NOT_ALLOWED');
      return reply;
    }
    if (config.slice3Enabled && path === '/v1/discovery/agents' && request.method !== 'POST') {
      sendError(reply, String(request.id), 405, 'METHOD_NOT_ALLOWED');
      return reply;
    }
    if (config.policiesEnabled && path === '/v1/authorization/evaluate' && request.method !== 'POST') {
      sendError(reply, String(request.id), 405, 'METHOD_NOT_ALLOWED');
      return reply;
    }
    return undefined;
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
    const path = request.url.split('?')[0] ?? '';
    if (path === '/mcp') {
      const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number((error as { statusCode?: number }).statusCode)
        : 500;
      const limit = error instanceof JsonLimitError ? error : undefined;
      let status = 503;
      let rpc = -32603;
      let message = 'Internal error';
      if (limit) {
        status = 400;
        rpc = limit.mcpCode;
        message = limit.message;
      } else if (statusCode === 413) {
        status = 413;
        rpc = -32600;
        message = 'Payload too large';
      } else if (error instanceof SyntaxError || statusCode === 400) {
        status = 400;
        rpc = -32700;
        message = 'Parse error';
      } else if (statusCode === 415) {
        status = 415;
        rpc = -32600;
        message = 'Unsupported media type';
      }
      request.log.error({
        request_id: String(request.id),
        status,
        error_name: error instanceof Error ? error.name : 'Error',
      }, 'request failed');
      reply.code(status).header('cache-control', 'no-store').type('application/json; charset=utf-8').send({
        jsonrpc: '2.0',
        id: null,
        error: { code: rpc, message },
      });
      return;
    }
    const requestId = String(request.id);
    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
      ? Number((error as { statusCode?: number }).statusCode)
      : 500;
    const dependency = isDependencyError(error) || statusCode === 503;
    let status = 500;
    let code: ErrorCode = 'INTERNAL_ERROR';
    if (statusCode === 413) {
      status = 413;
      code = 'PAYLOAD_TOO_LARGE';
    } else if (statusCode === 415) {
      status = 415;
      code = 'UNSUPPORTED_MEDIA_TYPE';
    } else if (statusCode === 400) {
      status = 400;
      code = 'VALIDATION_ERROR';
    } else if (dependency) {
      status = 503;
      code = 'DEPENDENCY_UNAVAILABLE';
    }
    const errorName = error instanceof Error ? error.name : 'Error';
    const errorMessage = error instanceof Error ? error.message : 'unknown';
    request.log.error({ request_id: requestId, status, error_code: code, error_name: errorName, error_message: errorMessage }, 'request failed');
    sendError(reply, requestId, status, code);
  });

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    const requestId = String(request.id);
    if (knownPath(path, config.tagsEnabled, config.slice3Enabled, config.mcp.enabled, config.policiesEnabled)) {
      return sendError(reply, requestId, 405, 'METHOD_NOT_ALLOWED');
    }
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
      if (config.tagsEnabled) {
        const tagSchema = await pool.query(
          'SELECT 1 FROM schema_migrations WHERE version = $1',
          [TAG_MIGRATION_VERSION],
        );
        if ((tagSchema.rowCount ?? 0) !== 1) {
          return send(reply, requestId, 503, { status: 'not_ready' }, 'HealthUnavailable', 'no-store');
        }
      }
      if (config.slice3Enabled) {
        const slice3Schema = await pool.query(
          'SELECT 1 FROM schema_migrations WHERE version = $1',
          [SLICE3_MIGRATION_VERSION],
        );
        if ((slice3Schema.rowCount ?? 0) !== 1) {
          return send(reply, requestId, 503, { status: 'not_ready' }, 'HealthUnavailable', 'no-store');
        }
      }
      if (config.mcp.enabled && !config.mcp.configured) {
        return send(reply, requestId, 503, { status: 'not_ready' }, 'HealthUnavailable', 'no-store');
      }
      if (config.mcp.enabled && config.mcp.configured) {
        const mcpSchema = await pool.query(
          'SELECT 1 FROM schema_migrations WHERE version = $1',
          [MCP_MIGRATION_VERSION],
        );
        if ((mcpSchema.rowCount ?? 0) !== 1) {
          return send(reply, requestId, 503, { status: 'not_ready' }, 'HealthUnavailable', 'no-store');
        }
      }
      if (config.policiesEnabled) {
        const policySchema = await pool.query(
          'SELECT 1 FROM schema_migrations WHERE version = $1',
          [POLICY_MIGRATION_VERSION],
        );
        if ((policySchema.rowCount ?? 0) !== 1) {
          return send(reply, requestId, 503, { status: 'not_ready' }, 'HealthUnavailable', 'no-store');
        }
      }
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

  registerAgentRoutes(app, {
    pool,
    config,
    send,
    sendError,
    limitRequest,
    migrationsMatch,
  });

  if (config.tagsEnabled) {
    registerTagRoutes(app, {
      pool,
      config,
      send,
      sendError,
      limitRequest,
      migrationsMatch,
    });
  }

  if (config.slice3Enabled) {
    registerSlice3Routes(app, {
      pool,
      config,
      send,
      sendError,
      limitRequest,
      migrationsMatch,
    });
  }

  if (config.policiesEnabled) {
    registerPolicyRoutes(app, {
      pool,
      config,
      send,
      sendError,
      limitRequest,
      migrationsMatch,
    });
  }

  registerMcpRoutes(app, { config, pool });

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
