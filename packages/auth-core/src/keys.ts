import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const KEY_PATTERN = /^fad_live\.([0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/;
const MAX_HEADER_LENGTH = 256;

export class PepperError extends Error {
  readonly reason: 'missing' | 'weak';

  constructor(reason: 'missing' | 'weak') {
    super(reason === 'missing' ? 'FAD_API_KEY_PEPPER_V1 is missing' : 'FAD_API_KEY_PEPPER_V1 is weak');
    this.name = 'PepperError';
    this.reason = reason;
  }
}

const WEAK_VALUES = new Set([
  'changeme',
  'password',
  'secret',
  'test',
  'development',
  'fad',
  'admin',
  'fad-dev-pepper',
]);

/** Pepper bytes are the UTF-8 encoding of the environment value. */
export function assertPepper(value: string | undefined): Buffer {
  if (value === undefined || value.length === 0) {
    throw new PepperError('missing');
  }
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length < 32 || new Set(bytes).size < 8 || WEAK_VALUES.has(value.toLowerCase())) {
    throw new PepperError('weak');
  }
  return bytes;
}

export interface ParsedApiKey {
  kid: string;
  secret: string;
}

export function parseApiKey(value: string): ParsedApiKey | null {
  if (value.length === 0 || value.length > MAX_HEADER_LENGTH) return null;
  const match = KEY_PATTERN.exec(value);
  if (!match) return null;
  const kid = match[1];
  const secret = match[2];
  if (kid === undefined || secret === undefined) return null;
  const decoded = Buffer.from(secret, 'base64url');
  if (decoded.length !== 32) return null;
  return { kid, secret };
}

export function generateApiKey(): ParsedApiKey & { token: string } {
  const kid = randomBytes(16).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  const parsed = parseApiKey(`fad_live.${kid}.${secret}`);
  if (!parsed) {
    throw new Error('Generated API key failed its own parser');
  }
  return { ...parsed, token: `fad_live.${kid}.${secret}` };
}

export function computeVerifier(pepper: Buffer, kid: string, secret: string): Buffer {
  return createHmac('sha256', pepper).update(`fad-api-key:v1:${kid}:${secret}`, 'utf8').digest();
}

/** Fixed-length compare. A length mismatch still calls the constant-time primitive and returns false. */
export function verifiersMatch(expected: Buffer, actual: Buffer): boolean {
  if (expected.length !== actual.length) {
    const filler = Buffer.alloc(32);
    timingSafeEqual(filler, filler);
    return false;
  }
  return timingSafeEqual(expected, actual);
}

export interface CredentialView {
  status: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
  pepperVersion: number;
}

export function credentialIsActive(credential: CredentialView, now: Date, knownPepperVersion: number): boolean {
  if (credential.pepperVersion !== knownPepperVersion) return false;
  if (credential.status !== 'active') return false;
  if (credential.revokedAt !== null) return false;
  if (credential.expiresAt !== null && credential.expiresAt.getTime() <= now.getTime()) return false;
  return true;
}
