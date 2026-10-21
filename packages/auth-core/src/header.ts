import { parseApiKey, type ParsedApiKey } from './keys.js';

export type CredentialHeaderResult =
  | { ok: true; parsed: ParsedApiKey; token: string }
  | { ok: false; reason: 'missing' | 'malformed' };

/**
 * Credential header rule: missing, repeated, longer than 256 characters,
 * or syntactically invalid is a failed credential. Callers map every failure
 * to the same 401 body.
 */
export function readCredentialHeader(rawHeaders: readonly string[]): CredentialHeaderResult {
  const values: string[] = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const value = rawHeaders[i + 1];
    if (name !== undefined && value !== undefined && name.toLowerCase() === 'x-fad-api-key') {
      values.push(value);
    }
  }
  if (values.length === 0) return { ok: false, reason: 'missing' };
  if (values.length > 1) return { ok: false, reason: 'malformed' };
  const token = values[0];
  if (token === undefined || token.length > 256 || token.includes(',')) {
    return { ok: false, reason: 'malformed' };
  }
  const parsed = parseApiKey(token);
  if (!parsed) return { ok: false, reason: 'malformed' };
  return { ok: true, parsed, token };
}
