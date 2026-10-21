import { createHmac, randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  assertPepper,
  computeVerifier,
  credentialIsActive,
  generateApiKey,
  hasScope,
  parseApiKey,
  parseScopes,
  PepperError,
  readCredentialHeader,
  redactText,
  redactValue,
  ScopeError,
  verifiersMatch,
} from '@fad/auth-core';
import { errorEnvelope, successEnvelope } from '@fad/contract';
import { loadConfig } from '@fad/api/config';
import { check, run } from './support.mjs';

const pepper = Buffer.from('fad-unit-pepper-0123456789-ABCDEFGH-not-secret', 'utf8');

test('credential parser, HMAC, scopes, redaction, and config', () => {
  const issued = generateApiKey();
  check('S0-I01-parse', parseApiKey(issued.token)?.kid === issued.kid, 'generated key parses');
  check('unit-malformed-short', parseApiKey('fad_live.abc.def') === null);
  check('unit-malformed-upper', parseApiKey(`fad_live.${'A'.repeat(32)}.${'a'.repeat(43)}`) === null);
  check('unit-malformed-prefix', parseApiKey(`fad_test.${issued.kid}.${issued.secret}`) === null);
  const longSecret = Buffer.from(randomBytes(31)).toString('base64url');
  check('unit-malformed-secret-length', parseApiKey(`fad_live.${issued.kid}.${longSecret}`) === null);
  check('unit-oversize', parseApiKey(`fad_live.${'a'.repeat(300)}`) === null);

  const digest = computeVerifier(pepper, issued.kid, issued.secret);
  const oracle = createHmac('sha256', pepper).update(`fad-api-key:v1:${issued.kid}:${issued.secret}`, 'utf8').digest();
  check('unit-hmac', digest.equals(oracle) && digest.length === 32);
  check('unit-hmac-match', verifiersMatch(digest, oracle));
  const wrong = computeVerifier(pepper, issued.kid, generateApiKey().secret);
  check('S0-I02-unit', verifiersMatch(digest, wrong) === false);
  check('unit-length-mismatch', verifiersMatch(digest, Buffer.alloc(16)) === false);

  check('unit-scope-ok', hasScope(parseScopes(['organizations:read', 'agents:write']), 'organizations:read'));
  check('unit-scope-exact', hasScope(['organizations:read'], 'organizations:reader') === false);
  check('unit-scope-star', hasScope(['*'], 'organizations:read') === false);
  for (const bad of ['*', 'agents:*', 'organizations:read ', '']) {
    let threw = false;
    try {
      parseScopes([bad]);
    } catch (err) {
      threw = err instanceof ScopeError;
    }
    check(`S0-I04-unit-${bad || 'empty'}`, threw);
  }

  const now = new Date('2026-10-20T00:00:00.000Z');
  check('unit-active', credentialIsActive({ status: 'active', expiresAt: null, revokedAt: null, pepperVersion: 1 }, now, 1));
  check('unit-revoked', credentialIsActive({ status: 'revoked', expiresAt: null, revokedAt: now, pepperVersion: 1 }, now, 1) === false);
  check('unit-expired', credentialIsActive({
    status: 'active',
    expiresAt: new Date('2026-10-19T00:00:00.000Z'),
    revokedAt: null,
    pepperVersion: 1,
  }, now, 1) === false);

  const token = issued.token;
  const redacted = redactText(`key ${token} pepper ${pepper.toString('utf8')}`, [pepper.toString('utf8')]);
  check('unit-redact-text', !redacted.includes(token) && !redacted.includes(pepper.toString('utf8')));
  const cleaned = JSON.stringify(redactValue({ api_key: token, kid: issued.kid, nested: { pepper: 'x' } }, [token]));
  check('unit-redact-object', !cleaned.includes(token) && cleaned.includes('[REDACTED]'));

  const header = readCredentialHeader(['Host', 'localhost', 'X-FAD-API-Key', token]);
  check('unit-header', header.ok && header.parsed.kid === issued.kid);
  check('unit-header-repeat', readCredentialHeader(['X-FAD-API-Key', token, 'x-fad-api-key', token]).ok === false);
  check('unit-header-missing', readCredentialHeader(['Host', 'x']).ok === false);

  const envelope = successEnvelope({ id: 'x' }, '3b0fb35b-3c4c-489a-90fa-17232c7b8fda');
  check('unit-envelope', envelope.meta.api_version === 'v1' && envelope.meta.request_id.length === 36);
  check('unit-error-code', errorEnvelope('UNAUTHORIZED', envelope.meta.request_id).error.code === 'UNAUTHORIZED');

  let missing = false;
  try {
    assertPepper(undefined);
  } catch (err) {
    missing = err instanceof PepperError && err.reason === 'missing';
  }
  check('S0-I06-unit-missing', missing);
  let weak = false;
  try {
    assertPepper('a'.repeat(32));
  } catch (err) {
    weak = err instanceof PepperError && err.reason === 'weak';
  }
  check('S0-I06-unit-weak', weak);
  check('unit-pepper-ok', assertPepper(pepper.toString('utf8')).equals(pepper));

  const base = {
    DATABASE_URL: 'postgres://fad_app:password@127.0.0.1:5432/fad',
    FAD_API_KEY_PEPPER_V1: pepper.toString('utf8'),
    FAD_RATE_LIMIT_BACKEND: 'postgres',
  };
  const dev = loadConfig({ ...base, NODE_ENV: 'development', FAD_BIND_HOST: '127.0.0.1' });
  check('unit-config-dev', dev.bindHost === '127.0.0.1' && dev.ingressTls === 'cleartext');
  let rejected = false;
  try {
    loadConfig({ ...base, NODE_ENV: 'production', FAD_INGRESS_TLS: 'cleartext', FAD_TRUST_PROXY: 'true', FAD_TRUSTED_PROXIES: '10.0.0.0/8' });
  } catch {
    rejected = true;
  }
  check('unit-config-cleartext', rejected);
  rejected = false;
  try {
    loadConfig({
      ...base,
      NODE_ENV: 'production',
      FAD_INGRESS_TLS: 'terminated',
      FAD_TRUST_PROXY: 'true',
      DATABASE_URL: `${base.DATABASE_URL}?sslmode=require`,
    });
  } catch {
    rejected = true;
  }
  check('unit-config-trust-all', rejected);
});

test('S0-I06 process rejects a missing or weak pepper', async () => {
  const missing = await run(process.execPath, ['apps/api/dist/server.js'], { FAD_API_KEY_PEPPER_V1: '' });
  check('S0-I06-process-missing', missing.code === 1 && missing.stderr.includes('missing') && !missing.stderr.includes('fad_live'));
  const weak = await run(process.execPath, ['apps/api/dist/server.js'], { FAD_API_KEY_PEPPER_V1: 'a'.repeat(40) });
  check('S0-I06-process-weak', weak.code === 1 && weak.stderr.includes('weak'));
});
