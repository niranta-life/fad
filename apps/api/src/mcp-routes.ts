import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { consumeRateLimit, isDependencyError, rateLimitBucket } from '@fad/db';
import type { Pool } from 'pg';
import type { AppConfig } from './config.js';
import { challengeHeader, createMcpVerifier, metadataDocument, type McpPrincipal, type McpVerifier } from './mcp-auth.js';
import { buildMcpServer, type McpToolDeps } from './mcp-tools.js';

const MCP_PATH = '/mcp';
const METADATA_PATH = '/.well-known/oauth-protected-resource/mcp';

export function mcpPaths(): { mcp: string; metadata: string } {
  return { mcp: MCP_PATH, metadata: METADATA_PATH };
}

function rawHeaders(request: FastifyRequest): readonly string[] {
  return request.raw.rawHeaders;
}

function headerCount(raw: readonly string[], name: string): number {
  let count = 0;
  for (let index = 0; index < raw.length; index += 2) {
    if (raw[index]?.toLowerCase() === name) count += 1;
  }
  return count;
}

function headerValue(raw: readonly string[], name: string): string | undefined {
  for (let index = 0; index < raw.length; index += 2) {
    if (raw[index]?.toLowerCase() === name) return raw[index + 1];
  }
  return undefined;
}

function hasControl(raw: readonly string[]): boolean {
  return raw.some((value) => value.includes('\r') || value.includes('\n'));
}

function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const lower = host.toLowerCase();
  if (allowed.some((item) => item.toLowerCase() === lower)) return true;
  const name = lower.startsWith('[') ? lower.slice(0, lower.indexOf(']') + 1) : (lower.split(':')[0] ?? lower);
  return allowed.some((item) => !item.includes(':') && item.toLowerCase() === name);
}

function jsonRpc(reply: FastifyReply, status: number, code: number, message: string): FastifyReply {
  return reply.code(status).header('cache-control', 'no-store').type('application/json; charset=utf-8').send({
    jsonrpc: '2.0',
    id: null,
    error: { code, message },
  });
}

function unauthorized(reply: FastifyReply, config: AppConfig): FastifyReply {
  return reply.code(401)
    .header('cache-control', 'no-store')
    .header('www-authenticate', challengeHeader(config))
    .type('application/json; charset=utf-8')
    .send({ error: 'unauthorized' });
}

function methodNotAllowed(reply: FastifyReply): FastifyReply {
  return reply.code(405)
    .header('cache-control', 'no-store')
    .header('allow', 'POST')
    .type('application/json; charset=utf-8')
    .send({ error: 'method_not_allowed' });
}

async function copyResponse(reply: FastifyReply, response: Response): Promise<void> {
  const text = await response.text();
  reply.code(response.status);
  reply.header('cache-control', 'no-store');
  const type = response.headers.get('content-type');
  if (type) reply.type(type);
  response.headers.forEach((value, key) => {
    if (key === 'content-length' || key === 'transfer-encoding' || key === 'content-type' || key === 'cache-control') return;
    reply.header(key, value);
  });
  if (type?.includes('application/json')) {
    try {
      await reply.send(JSON.parse(text) as unknown);
      return;
    } catch {
      await reply.send(text);
      return;
    }
  }
  await reply.send(text);
}

function bearer(raw: readonly string[]): string | undefined {
  if (headerCount(raw, 'authorization') !== 1) return undefined;
  const value = headerValue(raw, 'authorization') ?? '';
  const match = /^Bearer (.+)$/.exec(value);
  const token = match?.[1];
  if (!token || /\s/.test(token)) return undefined;
  return token;
}

export function registerMcpRoutes(app: FastifyInstance, options: { config: AppConfig; pool: Pool }): McpHttpHandler | undefined {
  const { config, pool } = options;
  if (!config.mcp.enabled) return undefined;
  if (!config.mcp.configured) {
    const unavailable = async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.code(503).header('cache-control', 'no-store').type('application/json; charset=utf-8').send({ error: 'unavailable' });
    };
    app.route({ method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], url: MCP_PATH, handler: unavailable });
    app.route({ method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'], url: METADATA_PATH, handler: unavailable });
    return undefined;
  }
  const verifier = createMcpVerifier(config);
  const inflight = new Map<string, number>();
  const deps: McpToolDeps = { pool, config, verifier, log: app.log };
  const handler = createMcpHandler((ctx) => {
    const extra = ctx.authInfo?.extra ?? {};
    const requestId = typeof extra.requestId === 'string' ? extra.requestId : 'mcp';
    const principal = extra.principal as McpPrincipal | undefined;
    const token = ctx.authInfo?.token ?? '';
    if (!principal || token.length === 0) {
      return buildMcpServer(deps, {
        token: '',
        issuer: '',
        subject: '',
        clientId: '',
        expiresAt: 0,
        organizationId: '',
        principalId: '',
        scopes: [],
        bindingRevision: 0,
      }, requestId, '');
    }
    return buildMcpServer(deps, principal, requestId, token);
  }, { legacy: 'stateless', responseMode: 'json' });

  app.get(METADATA_PATH, async (request, reply) => {
    if (!gate(config, request, reply, true)) return reply;
    return reply.code(200).header('cache-control', 'no-store').type('application/json; charset=utf-8').send(metadataDocument(config));
  });

  app.route({
    method: 'POST',
    url: MCP_PATH,
    bodyLimit: config.mcp.bodyLimitBytes,
    handler: async (request, reply) => postMcp(config, pool, verifier, handler, inflight, request, reply),
  });
  // Fastify adds HEAD when GET is registered. A second HEAD route fails startup.
  for (const method of ['GET', 'PUT', 'PATCH', 'DELETE'] as const) {
    app.route({
      method,
      url: MCP_PATH,
      exposeHeadRoute: method === 'GET',
      handler: async (request, reply) => {
        if (!gate(config, request, reply, false)) return reply;
        return methodNotAllowed(reply);
      },
    });
  }
  app.addHook('onClose', async () => {
    await handler.close();
  });
  return handler;
}

function gate(config: AppConfig, request: FastifyRequest, reply: FastifyReply, metadata: boolean): boolean {
  const url = request.url;
  if (url.includes('?')) {
    jsonRpc(reply, 400, -32600, 'Invalid request');
    return false;
  }
  const raw = rawHeaders(request);
  if (hasControl(raw)) {
    jsonRpc(reply, 400, -32600, 'Invalid request');
    return false;
  }
  if (headerValue(raw, 'x-forwarded-host') !== undefined && config.trustProxy === false) {
    reply.code(403).header('cache-control', 'no-store').type('application/json; charset=utf-8').send({ error: 'forbidden' });
    return false;
  }
  const host = headerValue(raw, 'host');
  if (!host || !hostAllowed(host, config.mcp.allowedHosts)) {
    reply.code(403).header('cache-control', 'no-store').type('application/json; charset=utf-8').send({ error: 'forbidden' });
    return false;
  }
  const origin = headerValue(raw, 'origin');
  if (origin !== undefined && !config.mcp.allowedOrigins.includes(origin)) {
    reply.code(403).header('cache-control', 'no-store').type('application/json; charset=utf-8').send({ error: 'forbidden' });
    return false;
  }
  if (!metadata && (headerValue(raw, 'x-fad-organization') !== undefined || headerValue(raw, 'x-organization-id') !== undefined)) {
    jsonRpc(reply, 400, -32600, 'Invalid request');
    return false;
  }
  return true;
}

async function postMcp(
  config: AppConfig,
  pool: Pool,
  verifier: McpVerifier,
  handler: McpHttpHandler,
  inflight: Map<string, number>,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!gate(config, request, reply, false)) return;
  const raw = rawHeaders(request);
  if (headerCount(raw, 'authorization') > 1) {
    request.log.info({ metric: 'mcp_auth_denied', reason: 'malformed' }, 'mcp');
    unauthorized(reply, config);
    return;
  }
  const type = headerValue(raw, 'content-type') ?? '';
  if (!/^application\/json(?:\s*;|$)/i.test(type)) {
    jsonRpc(reply, 415, -32600, 'Unsupported media type');
    return;
  }
  const accept = headerValue(raw, 'accept') ?? '';
  if (!/application\/json/i.test(accept) && !/text\/event-stream/i.test(accept) && !/\*\/\*/.test(accept)) {
    jsonRpc(reply, 400, -32600, 'Invalid request');
    return;
  }
  const token = bearer(raw);
  if (!token) {
    request.log.info({ metric: 'mcp_auth_denied', reason: 'malformed' }, 'mcp');
    unauthorized(reply, config);
    return;
  }
  const auth = await verifier.authenticate(pool, token);
  if (!auth.ok) {
    const metric = auth.reason === 'binding' || auth.reason === 'binding_disabled' ? 'mcp_binding_miss' : 'mcp_auth_denied';
    request.log.info({ metric, reason: auth.reason }, 'mcp');
    if (auth.status === 503) {
      reply.code(503).header('cache-control', 'no-store').type('application/json; charset=utf-8').send({ error: 'unavailable' });
      return;
    }
    unauthorized(reply, config);
    return;
  }
  // One POST is one call. An array would run every tools/call under a single rate-limit slot.
  if (Array.isArray(request.body)) {
    request.log.info({ metric: 'mcp_requests_total', mcp_method: 'batch', status: 400 }, 'mcp');
    jsonRpc(reply, 400, -32600, 'Invalid request');
    return;
  }
  const methodName = request.body && typeof request.body === 'object' && 'method' in request.body
    ? String((request.body as { method?: unknown }).method ?? '')
    : '';
  try {
    const orgBucket = rateLimitBucket(config.pepper, `mcp:org:${auth.principal.organizationId}`);
    const principalBucket = rateLimitBucket(config.pepper, `mcp:principal:${auth.principal.organizationId}:${auth.principal.principalId}`);
    const orgLimit = await consumeRateLimit(pool, orgBucket, config.rateLimitMax, config.rateLimitWindowSeconds);
    if (!orgLimit.allowed) {
      request.log.info({ metric: 'mcp_rate_limited' }, 'mcp');
      reply.code(429).header('cache-control', 'no-store').header('retry-after', String(orgLimit.retryAfterSeconds))
        .type('application/json; charset=utf-8').send({ error: 'rate_limited' });
      return;
    }
    const principalLimit = await consumeRateLimit(pool, principalBucket, config.rateLimitMax, config.rateLimitWindowSeconds);
    if (!principalLimit.allowed) {
      request.log.info({ metric: 'mcp_rate_limited' }, 'mcp');
      reply.code(429).header('cache-control', 'no-store').header('retry-after', String(principalLimit.retryAfterSeconds))
        .type('application/json; charset=utf-8').send({ error: 'rate_limited' });
      return;
    }
  } catch (error) {
    if (isDependencyError(error)) {
      reply.code(503).header('cache-control', 'no-store').type('application/json; charset=utf-8').send({ error: 'unavailable' });
      return;
    }
    throw error;
  }
  const current = inflight.get(auth.principal.organizationId) ?? 0;
  if (current >= config.mcp.concurrencyPerOrg) {
    request.log.info({ metric: 'mcp_rate_limited' }, 'mcp');
    reply.code(429).header('cache-control', 'no-store').header('retry-after', '1')
      .type('application/json; charset=utf-8').send({ error: 'rate_limited' });
    return;
  }
  inflight.set(auth.principal.organizationId, current + 1);
  let settled = false;
  const timer = setTimeout(() => {
    if (settled || reply.sent) return;
    settled = true;
    jsonRpc(reply, 503, -32603, 'Request timed out');
  }, config.mcp.requestTimeoutMs);
  try {
    const url = new URL(MCP_PATH, config.mcp.resourceUri);
    const headers = new Headers();
    for (let index = 0; index < raw.length; index += 2) {
      const name = raw[index];
      const value = raw[index + 1];
      if (!name || value === undefined) continue;
      headers.append(name, value);
    }
    const web = new Request(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(request.body ?? null),
    });
    const response = await handler.fetch(web, {
      parsedBody: request.body,
      authInfo: {
        token,
        clientId: auth.principal.clientId,
        scopes: auth.principal.scopes,
        expiresAt: auth.principal.expiresAt,
        resource: new URL(config.mcp.resourceUri),
        resourceMetadataUrl: config.mcp.metadataUrl,
        extra: {
          requestId: String(request.id),
          principal: auth.principal,
        },
      },
    });
    if (!settled && !reply.sent) {
      settled = true;
      await copyResponse(reply, response);
    }
    request.log.info({ metric: 'mcp_requests_total', mcp_method: methodName, status: reply.statusCode }, 'mcp');
  } finally {
    clearTimeout(timer);
    const next = (inflight.get(auth.principal.organizationId) ?? 1) - 1;
    if (next <= 0) inflight.delete(auth.principal.organizationId);
    else inflight.set(auth.principal.organizationId, next);
  }
}
