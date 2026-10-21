import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPepper, PepperError } from '@fad/auth-core';

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
  };
}
