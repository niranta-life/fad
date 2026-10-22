import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPepper, PepperError } from '@fad/auth-core';
import { APPROVED_MCP_TOOLS } from './mcp-catalog.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface AppConfig {
  nodeEnv: 'production' | 'development' | 'test';
  port: number;
  bindHost: string;
  databaseUrl: string;
  pepper: Buffer;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  poolMax: number;
  requestTimeoutMs: number;
  shutdownGraceMs: number;
  trustProxy: false | string;
  ingressTls: 'terminated' | 'cleartext';
  devLoopbackPublish: boolean;
  rateLimitMax: number;
  rateLimitWindowSeconds: number;
  migrationsDir: string;
  ssl: false | { rejectUnauthorized: boolean };
  tagsEnabled: boolean;
  tagMaxPerAgent: number;
  tagDefinitionsMaxPerOrg: number;
  tagSearchMaxPredicates: number;
  tagSearchMaxLimit: number;
  tagWriteBodyMaxBytes: number;
  slice3Enabled: boolean;
  maxEndpointsPerAgent: number;
  maxBindingsPerAgent: number;
  maxDiscoveryLimit: number;
  discoveryMaxPredicates: number;
  maxCapabilityListLimit: number;
  discoveryQueryTimeoutMs: number;
  capabilityPublishBodyMaxBytes: number;
  endpointWriteBodyMaxBytes: number;
  bindingWriteBodyMaxBytes: number;
  discoveryBodyMaxBytes: number;
  policiesEnabled: boolean;
  policyWriteBodyMaxBytes: number;
  enforcementEnabled: boolean;
  eventsEnabled: boolean;
  mcp: McpConfig;
}

export interface McpConfig {
  enabled: boolean;
  configured: boolean;
  resourceUri: string;
  audience: string;
  issuers: string[];
  allowedOrigins: string[];
  allowedHosts: string[];
  bodyLimitBytes: number;
  requestTimeoutMs: number;
  concurrencyPerOrg: number;
  toolset: ReadonlySet<string> | null;
  jwksTimeoutMs: number;
  jwksCooldownMs: number;
  jwksTlsInsecure: boolean;
  metadataUrl: string;
}

function integer(name: string, fallback: number, min: number, max: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function loopback(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnvRaw = env.NODE_ENV ?? 'development';
  if (nodeEnvRaw !== 'production' && nodeEnvRaw !== 'development' && nodeEnvRaw !== 'test') {
    throw new ConfigError('NODE_ENV must be production, development, or test');
  }
  const nodeEnv = nodeEnvRaw;
  let pepper: Buffer;
  try {
    pepper = assertPepper(env.FAD_API_KEY_PEPPER_V1);
  } catch (err) {
    if (err instanceof PepperError) throw new ConfigError(err.message);
    throw err;
  }
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new ConfigError('DATABASE_URL is required');
  let database: URL;
  try {
    database = new URL(databaseUrl);
  } catch {
    throw new ConfigError('DATABASE_URL is not a URL');
  }
  const sslmode = database.searchParams.get('sslmode');
  let ssl: AppConfig['ssl'] = false;
  if (nodeEnv === 'production') {
    if (sslmode !== 'require' && sslmode !== 'verify-ca' && sslmode !== 'verify-full') {
      throw new ConfigError('production DATABASE_URL must set sslmode=require or stronger');
    }
    ssl = { rejectUnauthorized: sslmode !== 'require' };
  } else if (sslmode === 'require' || sslmode === 'verify-ca' || sslmode === 'verify-full') {
    ssl = { rejectUnauthorized: sslmode !== 'require' };
  }
  const port = integer('PORT', 8080, 1, 65535, env);
  const bindHost = env.FAD_BIND_HOST && env.FAD_BIND_HOST.length > 0 ? env.FAD_BIND_HOST : '127.0.0.1';
  const ingressRaw = env.FAD_INGRESS_TLS ?? (nodeEnv === 'production' ? '' : 'cleartext');
  if (ingressRaw !== 'terminated' && ingressRaw !== 'cleartext') {
    throw new ConfigError('FAD_INGRESS_TLS must be terminated or cleartext');
  }
  const devLoopbackPublish = env.FAD_DEV_LOOPBACK_PUBLISH === 'true';
  if (nodeEnv === 'production' && ingressRaw !== 'terminated') {
    throw new ConfigError('production requires FAD_INGRESS_TLS=terminated');
  }
  if (nodeEnv === 'production' && (env.FAD_EVENTS_TEST_EGRESS || env.FAD_EVENTS_TEST_HOSTS || env.FAD_EVENTS_TEST_PORT || env.FAD_EVENTS_TEST_CA)) {
    throw new ConfigError('event test egress is not allowed in production');
  }
  if (nodeEnv !== 'production' && ingressRaw === 'cleartext' && !loopback(bindHost) && !devLoopbackPublish) {
    throw new ConfigError('development cleartext requires a loopback bind or FAD_DEV_LOOPBACK_PUBLISH=true');
  }
  const trustRaw = env.FAD_TRUST_PROXY ?? 'false';
  let trustProxy: AppConfig['trustProxy'];
  if (trustRaw === 'false') {
    trustProxy = false;
  } else if (trustRaw === 'true') {
    const proxies = env.FAD_TRUSTED_PROXIES;
    if (!proxies || !/^[\d./:,a-fA-F]+$/.test(proxies)) {
      throw new ConfigError('FAD_TRUSTED_PROXIES must list CIDRs when FAD_TRUST_PROXY=true');
    }
    trustProxy = proxies;
  } else {
    throw new ConfigError('FAD_TRUST_PROXY must be true or false');
  }
  if (nodeEnv === 'production' && trustProxy === false) {
    throw new ConfigError('production requires FAD_TRUST_PROXY=true with FAD_TRUSTED_PROXIES');
  }
  const backend = env.FAD_RATE_LIMIT_BACKEND ?? 'postgres';
  if (backend !== 'postgres') throw new ConfigError('FAD_RATE_LIMIT_BACKEND must be postgres');
  const logLevelRaw = env.FAD_LOG_LEVEL ?? 'info';
  if (logLevelRaw !== 'debug' && logLevelRaw !== 'info' && logLevelRaw !== 'warn' && logLevelRaw !== 'error') {
    throw new ConfigError('FAD_LOG_LEVEL is invalid');
  }
  const requestTimeoutMs = integer('FAD_HTTP_REQUEST_TIMEOUT_MS', 5000, 100, 60_000, env);
  const shutdownGraceMs = integer('FAD_SHUTDOWN_GRACE_MS', 10_000, 100, 120_000, env);
  if (shutdownGraceMs < requestTimeoutMs) {
    throw new ConfigError('FAD_SHUTDOWN_GRACE_MS must be at least FAD_HTTP_REQUEST_TIMEOUT_MS');
  }
  const migrationsDir = env.FAD_MIGRATIONS_DIR && env.FAD_MIGRATIONS_DIR.length > 0
    ? env.FAD_MIGRATIONS_DIR
    : resolve(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');
  const mcp = loadMcp(env, nodeEnv);
  if (mcp.enabled && mcp.requestTimeoutMs > shutdownGraceMs) {
    throw new ConfigError('FAD_SHUTDOWN_GRACE_MS must be at least FAD_MCP_REQUEST_TIMEOUT_MS');
  }
  return {
    nodeEnv,
    port,
    bindHost,
    databaseUrl,
    pepper,
    logLevel: logLevelRaw,
    poolMax: integer('FAD_DB_POOL_MAX', 5, 1, 20, env),
    requestTimeoutMs,
    shutdownGraceMs,
    trustProxy,
    ingressTls: ingressRaw,
    devLoopbackPublish,
    rateLimitMax: integer('FAD_RATE_LIMIT_MAX', 60, 1, 100_000, env),
    rateLimitWindowSeconds: integer('FAD_RATE_LIMIT_WINDOW_SECONDS', 60, 1, 3600, env),
    migrationsDir,
    ssl,
    tagsEnabled: env.FAD_TAGS_ENABLED === 'true',
    tagMaxPerAgent: integer('FAD_TAG_MAX_PER_AGENT', 64, 1, 64, env),
    tagDefinitionsMaxPerOrg: integer('FAD_TAG_DEFINITIONS_MAX_PER_ORG', 256, 1, 256, env),
    tagSearchMaxPredicates: integer('FAD_TAG_SEARCH_MAX_PREDICATES', 8, 1, 8, env),
    tagSearchMaxLimit: integer('FAD_TAG_SEARCH_MAX_LIMIT', 100, 1, 100, env),
    tagWriteBodyMaxBytes: integer('FAD_TAG_WRITE_BODY_MAX_BYTES', 16_384, 1, 16_384, env),
    slice3Enabled: env.FAD_SLICE3_ENABLED === 'true',
    maxEndpointsPerAgent: integer('FAD_MAX_ENDPOINTS_PER_AGENT', 8, 1, 8, env),
    maxBindingsPerAgent: integer('FAD_MAX_BINDINGS_PER_AGENT', 32, 1, 32, env),
    maxDiscoveryLimit: integer('FAD_MAX_DISCOVERY_LIMIT', 50, 1, 50, env),
    discoveryMaxPredicates: integer('FAD_DISCOVERY_MAX_PREDICATES', 8, 1, 8, env),
    maxCapabilityListLimit: integer('FAD_MAX_CAPABILITY_LIST_LIMIT', 100, 1, 100, env),
    discoveryQueryTimeoutMs: integer('FAD_DISCOVERY_QUERY_TIMEOUT_MS', 1500, 100, 5000, env),
    capabilityPublishBodyMaxBytes: integer('FAD_CAPABILITY_PUBLISH_BODY_MAX_BYTES', 73_728, 1, 73_728, env),
    endpointWriteBodyMaxBytes: integer('FAD_ENDPOINT_WRITE_BODY_MAX_BYTES', 4096, 1, 4096, env),
    bindingWriteBodyMaxBytes: integer('FAD_BINDING_WRITE_BODY_MAX_BYTES', 4096, 1, 4096, env),
    discoveryBodyMaxBytes: integer('FAD_DISCOVERY_BODY_MAX_BYTES', 16_384, 1, 16_384, env),
    policiesEnabled: env.FAD_POLICIES_ENABLED === 'true',
    policyWriteBodyMaxBytes: integer('FAD_POLICY_WRITE_BODY_MAX_BYTES', 65_536, 1, 65_536, env),
    enforcementEnabled: env.FAD_ENFORCEMENT_CODE_ENABLED === 'true',
    eventsEnabled: env.FAD_EVENTS_ENABLED === 'true',
    mcp,
  };
}

function splitList(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') return [];
  return value.split(',').map((item) => item.trim()).filter((item) => item.length > 0);
}

function httpsIssuer(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError('FAD_MCP_AUTH_ISSUERS contains an invalid URL');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new ConfigError('FAD_MCP_AUTH_ISSUERS must be https URLs without userinfo, query, or hash');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new ConfigError('FAD_MCP_AUTH_ISSUERS must not include a path');
  }
  return url;
}

function loadMcp(env: NodeJS.ProcessEnv, nodeEnv: AppConfig['nodeEnv']): McpConfig {
  const jwksTlsInsecure = env.FAD_MCP_JWKS_TLS_INSECURE === 'true';
  if (nodeEnv === 'production' && jwksTlsInsecure) {
    throw new ConfigError('production rejects FAD_MCP_JWKS_TLS_INSECURE');
  }
  const enabled = env.FAD_MCP_ENABLED === 'true';
  const toolset = loadToolset(env.FAD_MCP_TOOLSET);
  const bodyLimitBytes = integer('FAD_MCP_BODY_LIMIT_BYTES', 65_536, 1, 65_536, env);
  const requestTimeoutMs = integer('FAD_MCP_REQUEST_TIMEOUT_MS', 10_000, 100, 60_000, env);
  const concurrencyPerOrg = integer('FAD_MCP_CONCURRENCY_PER_ORG', 16, 1, 64, env);
  const jwksTimeoutMs = integer('FAD_MCP_JWKS_TIMEOUT_MS', 2000, 100, 10_000, env);
  const jwksCooldownMs = integer('FAD_MCP_JWKS_COOLDOWN_MS', 30_000, 0, 300_000, env);
  const resourceRaw = env.FAD_MCP_RESOURCE_URI ?? '';
  const audienceRaw = env.FAD_MCP_EXPECTED_AUDIENCE ?? '';
  const issuersRaw = env.FAD_MCP_AUTH_ISSUERS ?? '';
  const hostsRaw = env.FAD_HTTP_ALLOWED_HOSTS ?? '';
  const anySet = [resourceRaw, audienceRaw, issuersRaw, hostsRaw].some((item) => item.trim() !== '');
  if (!enabled || !anySet) {
    return {
      enabled,
      configured: false,
      resourceUri: '',
      audience: '',
      issuers: [],
      allowedOrigins: [],
      allowedHosts: [],
      bodyLimitBytes,
      requestTimeoutMs,
      concurrencyPerOrg,
      toolset,
      jwksTimeoutMs,
      jwksCooldownMs,
      jwksTlsInsecure,
      metadataUrl: '',
    };
  }
  if (resourceRaw.trim() === '' || audienceRaw.trim() === '' || issuersRaw.trim() === '' || hostsRaw.trim() === '') {
    throw new ConfigError('MCP issuer configuration is incomplete');
  }
  let resource: URL;
  try {
    resource = new URL(resourceRaw);
  } catch {
    throw new ConfigError('FAD_MCP_RESOURCE_URI is not a URL');
  }
  if (resource.username !== '' || resource.password !== '' || resource.search !== '' || resource.hash !== '') {
    throw new ConfigError('FAD_MCP_RESOURCE_URI must not include userinfo, query, or hash');
  }
  if (nodeEnv === 'production') {
    if (resource.protocol !== 'https:') throw new ConfigError('production FAD_MCP_RESOURCE_URI must be https');
  } else if (resource.protocol === 'http:') {
    if (!loopback(resource.hostname)) throw new ConfigError('cleartext MCP resource URI requires a loopback host');
  } else if (resource.protocol !== 'https:') {
    throw new ConfigError('FAD_MCP_RESOURCE_URI must be http or https');
  }
  if (audienceRaw !== resourceRaw) {
    throw new ConfigError('FAD_MCP_EXPECTED_AUDIENCE must equal FAD_MCP_RESOURCE_URI');
  }
  const issuers = splitList(issuersRaw);
  if (issuers.length === 0) throw new ConfigError('FAD_MCP_AUTH_ISSUERS is required');
  const seen = new Set<string>();
  for (const issuer of issuers) {
    httpsIssuer(issuer);
    if (seen.has(issuer)) throw new ConfigError('FAD_MCP_AUTH_ISSUERS contains a duplicate');
    seen.add(issuer);
  }
  const allowedHosts = splitList(hostsRaw);
  if (allowedHosts.length === 0) throw new ConfigError('FAD_HTTP_ALLOWED_HOSTS is required when MCP is configured');
  const metadata = new URL('/.well-known/oauth-protected-resource/mcp', resource.origin);
  return {
    enabled: true,
    configured: true,
    resourceUri: resourceRaw,
    audience: audienceRaw,
    issuers,
    allowedOrigins: splitList(env.FAD_MCP_ALLOWED_ORIGINS),
    allowedHosts,
    bodyLimitBytes,
    requestTimeoutMs,
    concurrencyPerOrg,
    toolset,
    jwksTimeoutMs,
    jwksCooldownMs,
    jwksTlsInsecure,
    metadataUrl: metadata.toString(),
  };
}

function loadToolset(value: string | undefined): ReadonlySet<string> | null {
  if (value === undefined) return null;
  const names = splitList(value);
  if (names.length === 0) throw new ConfigError('FAD_MCP_TOOLSET must name approved tools');
  const approved = new Set<string>(APPROVED_MCP_TOOLS);
  for (const name of names) {
    if (!approved.has(name)) throw new ConfigError(`FAD_MCP_TOOLSET rejects ${name}`);
  }
  return new Set(names);
}
