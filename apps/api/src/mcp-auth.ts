import https from 'node:https';
import { createLocalJWKSet, decodeProtectedHeader, errors, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose';
import { KNOWN_SCOPES, type KnownScope } from '@fad/auth-core';
import { isDependencyError, lookupMcpPrincipal, mcpTenantActive, type McpBindingLookup } from '@fad/db';
import type { Pool } from 'pg';
import type { AppConfig } from './config.js';

const SIGNING_ALGS = new Set(['RS256', 'ES256']);
const KNOWN = new Set<string>(KNOWN_SCOPES);

export interface McpPrincipal {
  token: string;
  issuer: string;
  subject: string;
  clientId: string;
  expiresAt: number;
  organizationId: string;
  principalId: string;
  scopes: KnownScope[];
  bindingRevision: number;
}

export interface McpAuthDenial {
  ok: false;
  status: 401 | 503;
  reason: string;
}

export interface McpAuthOk {
  ok: true;
  principal: McpPrincipal;
}

export type McpAuthResult = McpAuthOk | McpAuthDenial;

interface CachedJwks {
  set: ReturnType<typeof createLocalJWKSet>;
  kids: Set<string>;
  fetchedAt: number;
}

export interface McpVerifier {
  authenticate(pool: Pool, token: string, now?: number): Promise<McpAuthResult>;
}

function denial(status: 401 | 503, reason: string): McpAuthDenial {
  return { ok: false, status, reason };
}

function recordOf(payload: JWTPayload): Record<string, unknown> {
  return payload as unknown as Record<string, unknown>;
}

function scopesOf(payload: JWTPayload): string[] {
  const record = recordOf(payload);
  const scope = record.scope;
  const scp = record.scp;
  const fromScope = typeof scope === 'string' ? scope.split(' ').filter((item) => item.length > 0) : [];
  const fromScp = Array.isArray(scp) ? scp.filter((item): item is string => typeof item === 'string') : [];
  return [...fromScope, ...fromScp];
}

function clientIdOf(payload: JWTPayload): string | undefined {
  const record = recordOf(payload);
  const client = typeof record.client_id === 'string' ? record.client_id : undefined;
  const party = typeof record.azp === 'string' ? record.azp : undefined;
  if (client && party && client !== party) return undefined;
  return client ?? party;
}

function intersect(tokenScopes: readonly string[], bound: readonly string[]): KnownScope[] {
  const boundSet = new Set(bound);
  return KNOWN_SCOPES.filter((scope) => tokenScopes.includes(scope) && boundSet.has(scope) && KNOWN.has(scope));
}

function fetchJwksInsecure(url: URL, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      rejectUnauthorized: false,
      method: 'GET',
      timeout: timeoutMs,
      headers: { accept: 'application/json' },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        if ((response.statusCode ?? 500) !== 200) {
          reject(new Error('jwks status'));
          return;
        }
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
    request.on('timeout', () => {
      request.destroy();
      const error = new Error('jwks timeout');
      error.name = 'AbortError';
      reject(error);
    });
    request.on('error', reject);
    request.end();
  });
}

async function fetchJwks(config: AppConfig, issuer: string): Promise<JSONWebKeySet> {
  const url = new URL('/.well-known/jwks.json', issuer.endsWith('/') ? issuer : `${issuer}/`);
  if (url.origin !== new URL(issuer).origin) throw new Error('jwks origin');
  let body: JSONWebKeySet;
  if (config.mcp.jwksTlsInsecure) {
    body = JSON.parse(await fetchJwksInsecure(url, config.mcp.jwksTimeoutMs)) as JSONWebKeySet;
  } else {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.mcp.jwksTimeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: 'error',
        headers: { accept: 'application/json' },
      });
      if (!response.ok) throw new Error('jwks status');
      body = await response.json() as JSONWebKeySet;
    } finally {
      clearTimeout(timer);
    }
  }
  if (!body || !Array.isArray(body.keys)) throw new Error('jwks shape');
  return body;
}

function kidsOf(set: JSONWebKeySet): Set<string> {
  const kids = new Set<string>();
  for (const key of set.keys) {
    if (typeof key.kid === 'string') kids.add(key.kid);
  }
  return kids;
}

export function createMcpVerifier(config: AppConfig): McpVerifier {
  const cache = new Map<string, CachedJwks>();

  async function jwksFor(issuer: string, kid: string): Promise<CachedJwks | McpAuthDenial> {
    const cached = cache.get(issuer);
    const fresh = cached !== undefined && (Date.now() - cached.fetchedAt) < config.mcp.jwksCooldownMs && cached.kids.has(kid);
    if (cached && fresh) return cached;
    try {
      const body = await fetchJwks(config, issuer);
      const next = { set: createLocalJWKSet(body), kids: kidsOf(body), fetchedAt: Date.now() };
      cache.set(issuer, next);
      return next;
    } catch (error) {
      if (cached && cached.kids.has(kid)) return cached;
      const aborted = error instanceof Error && error.name === 'AbortError';
      return denial(503, aborted ? 'jwks_timeout' : 'jwks_unavailable');
    }
  }

  return {
    async authenticate(pool, token, now = Date.now()): Promise<McpAuthResult> {
      if (token.length < 20 || token.length > 8192 || token.includes('\n') || token.includes('\r')) {
        return denial(401, 'malformed');
      }
      let header: ReturnType<typeof decodeProtectedHeader>;
      try {
        header = decodeProtectedHeader(token);
      } catch {
        return denial(401, 'malformed');
      }
      if (header.jku !== undefined || header.x5u !== undefined || header.jwk !== undefined || header.crit !== undefined) {
        return denial(401, 'untrusted_header');
      }
      if (typeof header.alg !== 'string' || !SIGNING_ALGS.has(header.alg)) {
        return denial(401, 'algorithm');
      }
      if (typeof header.kid !== 'string' || header.kid.length === 0) {
        return denial(401, 'kid');
      }
      const unverified = token.split('.');
      if (unverified.length !== 3 || !unverified[1]) return denial(401, 'malformed');
      let payloadJson: JWTPayload;
      try {
        payloadJson = JSON.parse(Buffer.from(unverified[1], 'base64url').toString('utf8')) as JWTPayload;
      } catch {
        return denial(401, 'malformed');
      }
      if (typeof payloadJson.iss !== 'string' || !config.mcp.issuers.includes(payloadJson.iss)) {
        return denial(401, 'issuer');
      }
      const keys = await jwksFor(payloadJson.iss, header.kid);
      if ('ok' in keys) return keys;
      if (!keys.kids.has(header.kid)) return denial(401, 'kid');
      let verified: JWTPayload;
      try {
        const result = await jwtVerify(token, keys.set, {
          algorithms: ['RS256', 'ES256'],
          issuer: payloadJson.iss,
          audience: config.mcp.audience,
          clockTolerance: 0,
          currentDate: new Date(now),
        });
        verified = result.payload;
      } catch (error) {
        if (error instanceof errors.JWTExpired) return denial(401, 'expired');
        if (error instanceof errors.JWTClaimValidationFailed) {
          const claim = 'claim' in error && typeof error.claim === 'string' ? error.claim : '';
          if (claim === 'nbf') return denial(401, 'nbf');
          if (claim === 'aud') return denial(401, 'audience');
          if (claim === 'iss') return denial(401, 'issuer');
          return denial(401, 'claim');
        }
        return denial(401, 'signature');
      }
      if (verified.aud !== config.mcp.audience) return denial(401, 'audience');
      if (typeof verified.exp !== 'number' || typeof verified.iat !== 'number') return denial(401, 'claim');
      if (verified.iat > Math.floor(now / 1000) + 60) return denial(401, 'iat');
      if (header.typ === 'id+jwt') return denial(401, 'token_type');
      const clientId = clientIdOf(verified);
      if (!clientId || clientId.length < 1 || clientId.length > 256) return denial(401, 'client');
      const tokenScopes = scopesOf(verified);
      if (tokenScopes.length === 0) return denial(401, 'scope');
      if (typeof verified.sub !== 'string' || verified.sub.length < 1 || verified.sub.length > 512) {
        return denial(401, 'subject');
      }
      let binding: McpBindingLookup | null;
      try {
        binding = await lookupMcpPrincipal(pool, verified.iss ?? payloadJson.iss, verified.sub, clientId);
      } catch (error) {
        if (isDependencyError(error)) return denial(503, 'dependency');
        throw error;
      }
      if (!binding) return denial(401, 'binding');
      if (binding.bindingStatus !== 'active') return denial(401, 'binding_disabled');
      const tenant = await mcpTenantActive(pool, binding.organizationId, binding.principalId);
      if (tenant === 'unavailable') return denial(503, 'dependency');
      if (tenant !== 'active') return denial(401, 'principal');
      return {
        ok: true,
        principal: {
          token,
          issuer: verified.iss ?? payloadJson.iss,
          subject: verified.sub,
          clientId,
          expiresAt: verified.exp,
          organizationId: binding.organizationId,
          principalId: binding.principalId,
          scopes: intersect(tokenScopes, binding.allowedScopes),
          bindingRevision: binding.bindingRevision,
        },
      };
    },
  };
}

export function metadataDocument(config: AppConfig): Record<string, unknown> {
  return {
    resource: config.mcp.resourceUri,
    authorization_servers: config.mcp.issuers,
    scopes_supported: [...KNOWN_SCOPES],
    bearer_methods_supported: ['header'],
  };
}

export function challengeHeader(config: AppConfig): string {
  return `Bearer resource_metadata="${config.mcp.metadataUrl}", error="invalid_token"`;
}
